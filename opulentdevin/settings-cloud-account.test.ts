import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { Effect, Schema } from 'effect'
import { accountCommands, accountLink, capMicros, imageCanBuild, machineActions, type CloudAccountBackend } from './settings-cloud-account'
import { CloudAccountImage, CloudAccountImageBuildRequest } from './zuse-runtime/packages/contracts/src/cloud-workspaces'
import { CloudBillingCapRequest } from './zuse-runtime/packages/contracts/src/cloud-billing'
import { MachineCreateRequest, MachineDestroyRequest, MachineOffer, MachineRecord } from './zuse-runtime/packages/contracts/src/machines'

const offer = MachineOffer.make({ offerId: 'test-offer', kind: 'persistent', displayName: 'Test offer', architecture: 'x86_64', vcpuCount: 2, memoryMib: 4096, diskGib: 32, location: 'test', monthlyPriceCents: 2500, currency: 'USD', automaticBackups: true, available: true })
const machine = MachineRecord.make({ machineId: 'test-machine', offer, state: 'ready', desiredState: 'ready', statusCode: 'ready', createdAt: 1 })
const image = CloudAccountImage.make({ state: 'ready', repositories: [], providers: [], builds: [], updatedAt: 1 })
function mockedAccount(ok = true) {
  const called = vi.fn<(name: string, payload: unknown) => void>()
  const client = new Proxy({}, { get: (_target, name) => (payload: unknown) => { called(String(name), payload); return Effect.succeed({ ok }) } }) as CloudAccountBackend['client']
  const backend: CloudAccountBackend = { client, run: effect => Effect.runPromise(effect) }
  return { commands: accountCommands(backend), called }
}

describe('cloud account contract boundaries', () => {
  it.each([['0', 0], ['12.345678', 12345678], [' 1.2 ', 1200000], ['0.000001', 1], ['9007199254.740991', Number.MAX_SAFE_INTEGER]])('converts exact decimal USD %s to micros', (value, expected) => {
    expect(capMicros(String(value))).toBe(expected)
  })
  it.each(['', ' ', '-1', '1e3', 'Infinity', 'NaN', '0x10', '1.0000001', '9007199254.740992', '1,000', '1.'])('rejects invalid or unsafe cap %s', value => {
    expect(() => capMicros(value)).toThrow()
  })
  it('accepts secure checkout query parameters but rejects unsafe navigation', () => {
    expect(accountLink('https://billing.example/checkout?session=test')).toBe('https://billing.example/checkout?session=test')
    for (const value of ['javascript:alert(1)', 'http://example.com', 'file:///etc/passwd', 'https://user:pass@example.com', 'https://example.com/#token']) expect(() => accountLink(value)).toThrow()
  })
  it('sends exact image and billing requests without adding permission or credential fields', async () => {
    const { commands, called } = mockedAccount()
    await commands.build('rebuild', 'provider-a', 'image-retry-key')
    const build = called.mock.calls[0]!
    expect(build[0]).toBe('cloud.image.build')
    expect(Schema.decodeUnknownSync(CloudAccountImageBuildRequest)(build[1])).toEqual({ mode: 'rebuild', providerId: 'provider-a', idempotencyKey: 'image-retry-key' })
    await commands.cap('12.34', 'cap-retry-key')
    const cap = called.mock.calls[1]!
    expect(cap[0]).toBe('cloud.billing.setCap')
    expect(Schema.decodeUnknownSync(CloudBillingCapRequest)(cap[1])).toEqual({ overageCapMicros: 12340000, idempotencyKey: 'cap-retry-key' })
    expect(() => commands.cap('-1', 'invalid')).toThrow()
    expect(called).toHaveBeenCalledTimes(2)
  })
  it('keeps provisioning separate from checkout and preserves the supplied retry key', async () => {
    const { commands, called } = mockedAccount()
    await commands.create(offer, '  Test  ', 'stable-key')
    await commands.create(offer, 'Test', 'stable-key')
    expect(called.mock.calls.map(([name]) => name)).toEqual(['machines.create', 'machines.create'])
    expect(Schema.decodeUnknownSync(MachineCreateRequest)(called.mock.calls[0]![1])).toEqual({ offerId: offer.offerId, label: 'Test', idempotencyKey: 'stable-key' })
    await commands.checkout(offer)
    expect(called.mock.calls[2]).toEqual(['machines.checkout', { offerId: offer.offerId }])
  })
  it('blocks unavailable offers and sandbox provisioning before any RPC', () => {
    const { commands, called } = mockedAccount()
    expect(() => commands.create({ ...offer, available: false }, '', 'key')).toThrow()
    expect(() => commands.create({ ...offer, kind: 'sandbox' }, '', 'key')).toThrow()
    expect(() => commands.checkout({ ...offer, available: false })).toThrow()
    expect(called).not.toHaveBeenCalled()
  })
  it('uses state-gated lifecycle actions and explicit destroy confirmation', async () => {
    const { commands, called } = mockedAccount()
    expect(machineActions(machine)).toEqual({ cancel: true, recover: false, destroy: true })
    expect(() => commands.recover(machine)).toThrow()
    await commands.cancel(machine)
    const suspended = { ...machine, state: 'suspended' as const }
    expect(machineActions(suspended)).toEqual({ cancel: false, recover: true, destroy: true })
    await commands.recover(suspended)
    await commands.destroy(machine)
    expect(called.mock.calls[0]).toEqual(['machines.cancel', { machineId: machine.machineId }])
    expect(called.mock.calls[1]).toEqual(['machines.recover', { machineId: machine.machineId }])
    expect(Schema.decodeUnknownSync(MachineDestroyRequest)(called.mock.calls[2]![1])).toEqual({ machineId: machine.machineId, confirmation: 'destroy' })
    for (const state of ['destroying', 'destroyed'] as const) {
      const removed = { ...machine, state }
      expect(machineActions(removed)).toEqual({ cancel: false, recover: false, destroy: false })
      expect(() => commands.destroy(removed)).toThrow()
    }
  })
  it('does not treat a negative disconnect acknowledgement as success', async () => {
    const { commands, called } = mockedAccount(false)
    await expect(commands.disconnect(42)).rejects.toThrow('not confirmed')
    expect(called.mock.calls[0]).toEqual(['cloud.github.disconnect', { installationId: 42 }])
  })
  it('prevents overlapping queued, building and sanitising image builds', () => {
    expect(imageCanBuild(image)).toBe(true)
    expect(imageCanBuild({ ...image, state: 'building' })).toBe(false)
    for (const state of ['queued', 'building', 'sanitizing'] as const) {
      expect(imageCanBuild({ ...image, builds: [{ buildId: 'b', state, mode: 'update', active: false, runtimeVersion: 'v', configurationDigest: 'd', repositories: [], providers: [], createdAt: 1, updatedAt: 1 }] })).toBe(false)
    }
  })
})

const source = readFileSync(new URL('./settings-cloud-account.tsx', import.meta.url), 'utf8')
const tree = ts.createSourceFile('settings-cloud-account.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function descendants(node: ts.Node): ts.Node[] { const result = [node]; node.forEachChild(child => { result.push(...descendants(child)) }); return result }
const nodes = descendants(tree)

describe('native account UI safety wiring', () => {
  it('requires confirmation for every side-effect handler rather than putting it on an ordinary action', () => {
    const actionNodes = nodes.filter(ts.isJsxSelfClosingElement).filter(node => node.tagName.getText(tree) === 'Action')
    expect(actionNodes.length).toBeGreaterThan(3)
    for (const node of actionNodes) expect(node.getText(tree)).not.toMatch(/commands\.|accountCommands|cloud\.image\.build|setCap|openAccountLink/)
    const confirmations = nodes.filter(ts.isJsxSelfClosingElement).filter(node => node.tagName.getText(tree) === 'ConfirmAction')
    expect(confirmations).toHaveLength(11)
    for (const node of confirmations) {
      expect(node.attributes.properties.some(property => ts.isJsxAttribute(property) && property.name.getText(tree) === 'detail')).toBe(true)
      expect(node.attributes.properties.some(property => ts.isJsxAttribute(property) && property.name.getText(tree) === 'disabled')).toBe(true)
    }
  })
  it('uses native flex layout on every div and avoids raw credential or log surfaces', () => {
    const divs = nodes.filter(node => ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)).filter(node => (node as ts.JsxOpeningElement).tagName.getText(tree) === 'div')
    expect(divs.length).toBeGreaterThan(0)
    for (const div of divs) expect(div.getText(tree)).toContain("display: 'flex'")
    expect(source).not.toMatch(/\.logText|\.failureDiagnostic|console\.|process\.env|settings\.patch|permissions:/)
    expect(source).toContain('shell: false')
  })
  it('resets section state on backend replacement and discards stale provider reads', () => {
    expect(source).toContain('key={accountKey}')
    expect(source).toContain('current.current.epoch === epoch')
    expect(source).toContain('result.load === load')
    expect(source).toContain('current.current.mounted = false')
  })
})
