import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { Effect } from 'effect'
import ts from 'typescript'
import type { Backend } from './backend'
import { AuthTokenId } from './zuse-runtime/packages/contracts/src/ids'
import { NearbyPairingRequest } from './zuse-runtime/packages/contracts/src/pairing'
import { createNetworkActions, inspectLocalNetwork, inspectLocalTailnet, networkRestrictions, pairingDisplay } from './settings-network-host'

function mockedBackend() {
  const calls: { method: string; input: unknown }[] = []
  const client = new Proxy({}, { get: (_target, property) => (input: unknown) => {
    calls.push({ method: String(property), input })
    return Effect.succeed(property === 'deviceBridge.control' ? { version: 1, commands: [], grants: [], enabled: true, connected: true, deviceId: 'device', deviceName: 'Device', homeDirectory: '/home/test' } : [])
  } }) as Backend['client']
  return { calls, actions: createNetworkActions({ client, run: effect => Effect.runPromise(effect) }) }
}
function request(expiresAt = new Date(Date.now() + 60000)) {
  return NearbyPairingRequest.make({ requestId: 'request', deviceId: 'device', deviceLabel: 'Phone', deviceIdentifier: 'identifier', devicePublicKey: 'public-key', ephemeralPublicKey: 'ephemeral-key', clientNonce: 'client', serverNonce: 'server', safetyPhrase: 'safe phrase', createdAt: new Date(), expiresAt })
}

afterEach(() => vi.unstubAllEnvs())

describe('native network settings policy boundaries', () => {
  it('does not call anything until explicitly requested and reads only inventory', async () => {
    const { calls, actions } = mockedBackend()
    expect(calls).toEqual([])
    await Promise.all([actions.tokens(), actions.nearby(), actions.bridge(), actions.privateNetwork()])
    expect(calls.map(call => call.method)).toEqual(['pairing.listTokens', 'pairing.listNearbyRequests', 'deviceBridge.control', 'machine.privateNetwork.status'])
    expect(calls[2]?.input).toEqual({ _tag: 'status' })
    expect(calls[3]?.input).toBeUndefined()
  })
  it('rejects every policy mutation before an RPC when confirmation is absent', () => {
    const { calls, actions } = mockedBackend()
    const mutations = [
      () => actions.startPairing(false),
      () => actions.revokeToken(AuthTokenId.make('token'), false),
      () => actions.resolveNearby(request(), 'allow', false),
      () => actions.decideCommand('command', 'AlwaysAllow', false),
      () => actions.revokeGrant('grant', false),
      () => actions.enablePrivateNetwork('NOT_CONFIGURED', 'authorized-keys', false),
      () => actions.setSshMode('tailnet-identity', false),
    ]
    for (const mutate of mutations) expect(mutate).toThrow('Explicit confirmation')
    expect(calls).toEqual([])
  })
  it('routes confirmed pairing and permissions using exact contract payloads', async () => {
    const { calls, actions } = mockedBackend()
    await actions.startPairing(true)
    await actions.revokeToken(AuthTokenId.make('token'), true)
    for (const decision of ['allow', 'deny', 'block'] as const) await actions.resolveNearby(request(), decision, true)
    for (const decision of ['AllowOnce', 'AllowForSession', 'AlwaysAllow', 'Deny'] as const) await actions.decideCommand('command', decision, true)
    await actions.revokeGrant('grant', true)
    expect(calls[0]).toEqual({ method: 'pairing.start', input: {} })
    expect(calls[1]).toEqual({ method: 'pairing.revokeToken', input: { tokenId: 'token' } })
    expect(calls.slice(2, 5).map(call => call.input)).toEqual(['allow', 'deny', 'block'].map(decision => ({ requestId: 'request', decision })))
    expect(calls.slice(5, 9).map(call => call.input)).toEqual(['AllowOnce', 'AllowForSession', 'AlwaysAllow', 'Deny'].map(decision => ({ _tag: 'decide', id: 'command', decision })))
    expect(calls[9]).toEqual({ method: 'deviceBridge.control', input: { _tag: 'revoke', id: 'grant' } })
  })
  it('refuses expired and invalid nearby requests without contacting the backend', () => {
    const { calls, actions } = mockedBackend()
    expect(() => actions.resolveNearby(request(new Date(0)), 'allow', true)).toThrow('expired')
    expect(calls).toEqual([])
  })
  it('reads a credential by name only after confirmation and uses machine RPCs', async () => {
    const { calls, actions } = mockedBackend()
    vi.stubEnv('TEST_TAILNET_KEY', 'synthetic-test-value')
    expect(() => actions.enablePrivateNetwork('a raw credential', 'authorized-keys', true)).toThrow()
    expect(calls).toEqual([])
    await actions.enablePrivateNetwork('TEST_TAILNET_KEY', 'authorized-keys', true)
    await actions.setSshMode('tailnet-identity', true)
    expect(calls).toEqual([
      { method: 'machine.privateNetwork.enable', input: { authKey: 'synthetic-test-value', sshMode: 'authorized-keys' } },
      { method: 'machine.sshMode.set', input: { mode: 'tailnet-identity' } },
    ])
  })
  it('checks voice capabilities only explicitly and never opens capture', async () => {
    const { calls, actions } = mockedBackend()
    await actions.voiceCapabilities()
    expect(calls).toEqual([{ method: 'voice.capabilities', input: {} }])
  })
  it('hides expired pairing secrets and handles invalid dates', () => {
    expect(pairingDisplay({ code: '123456', expiresAt: new Date(2000) }, 1000)).toEqual({ expired: false, code: '123456' })
    expect(pairingDisplay({ code: '123456', expiresAt: new Date(2000) }, 2000)).toEqual({ expired: true, code: null })
    expect(pairingDisplay({ code: '123456', expiresAt: new Date(NaN) }, 0)).toEqual({ expired: true, code: null })
  })
  it('filters loopback interfaces without claiming listener or network reachability', () => {
    const common = { netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null, family: 'IPv4' as const }
    expect(inspectLocalNetwork({ lo: [{ ...common, address: '127.0.0.1', internal: true }], eth0: [{ ...common, address: '192.0.2.1', internal: false }] })).toEqual([{ name: 'eth0', address: '192.0.2.1', family: 'IPv4' }])
    expect(inspectLocalNetwork({})).toEqual([])
  })
  it('inspects local tailscale through a bounded read-only command only', async () => {
    const runner = vi.fn(async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'device.tailnet.test.' } }) }))
    expect(await inspectLocalTailnet(runner)).toEqual({ backendState: 'Running', dnsName: 'device.tailnet.test' })
    expect(runner).toHaveBeenCalledExactlyOnceWith(['status', '--json'], 5000)
    await expect(inspectLocalTailnet(async () => ({ code: 1, stdout: '', stderr: 'private error' }))).rejects.toThrow('unavailable')
    await expect(inspectLocalTailnet(async () => ({ code: 0, stdout: 'invalid-private-output', stderr: '' }))).rejects.toThrow('invalid status')
  })
  it('uses native flex divs, confirmations, and no unsupported browser/Electron/capture APIs', () => {
    const source = readFileSync(new URL('./settings-network.tsx', import.meta.url), 'utf8')
    const tree = ts.createSourceFile('settings-network.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    let divs = 0
    function visit(node: ts.Node) {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(tree) === 'div') {
        divs++
        expect(node.attributes.getText(tree)).toContain("display: 'flex'")
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
    expect(divs).toBeGreaterThan(0)
    expect(source).toContain('ConfirmAction')
    expect(source).toContain('Check transcription account')
    expect(source).not.toMatch(/getUserMedia|new MediaRecorder|ipcRenderer|localStorage|document\./)
    expect(networkRestrictions.lan).toContain('owned local server')
    expect(networkRestrictions.profiles).toContain('keytar')
  })
})
