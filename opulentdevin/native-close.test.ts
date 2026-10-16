import { describe, expect, it, vi } from 'vitest'
import type { Backend } from './backend'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { NativeCloseController, createNativeCloseEvents, parseNativeCloseRequest, asNativeCloseRenderer, type NativeCloseRequest } from './native-close'

const event = (id = '1', generation = 'window-1'): NativeCloseRequest => ({ eventType: 'closeRequested', elementId: 0, closeRequestId: id, windowGeneration: generation })
const tick = async () => { await Promise.resolve(); await Promise.resolve() }
function setup(inspect = vi.fn(async () => ({ active: 2, environments: 1, checkedAt: 1 })), cleanup = vi.fn(async () => {})) {
  const renderer = { setCloseGuard: vi.fn(), resolveCloseRequest: vi.fn(() => true) }
  const changed = vi.fn()
  const acknowledge = vi.fn()
  return { renderer, changed, cleanup, inspect, acknowledge, controller: new NativeCloseController(renderer, () => [], cleanup, changed, inspect, acknowledge) }
}
describe('native close event bridge', () => {
  it('validates only exact lifecycle payloads', () => { expect(parseNativeCloseRequest(event())).toEqual(event()); for (const value of [null, {}, { ...event(), elementId: 1 }, { ...event(), closeRequestId: 1 }, { ...event(), windowGeneration: '' }]) expect(parseNativeCloseRequest(value)).toBeNull() })
  it('preserves method receivers and rejects unavailable native methods', () => { const renderer = { armed: false, setCloseGuard(value: boolean) { this.armed = value }, resolveCloseRequest() { return this.armed } }; const native = asNativeCloseRenderer(renderer)!; native.setCloseGuard(true); expect(native.resolveCloseRequest('1', true)).toBe(true); expect(asNativeCloseRenderer({})).toBeNull() })
  it('retains startup requests and acknowledges only matching generation', () => { const hub = createNativeCloseEvents(); hub.dispatch(event()); const first = vi.fn(); const off = hub.subscribe(first); expect(first).toHaveBeenCalledWith(event()); off(); hub.acknowledge(event('1', 'other')); const second = vi.fn(); hub.subscribe(second); expect(second).toHaveBeenCalledWith(event()); hub.acknowledge(event()); const third = vi.fn(); hub.subscribe(third); expect(third).not.toHaveBeenCalled() })
})
describe('close approval state machine', () => {
  it('retains the controller across startup identity and cleanup removal transitions', async () => {
    let backends: readonly Backend[] = []
    let finish!: () => void
    const renderer = { setCloseGuard: vi.fn(), resolveCloseRequest: vi.fn(() => true) }
    const inspect = vi.fn(async (values: readonly Backend[]) => { if (!values.length) throw new Error('unknown'); return { active: 1, environments: values.length, checkedAt: 1 } })
    const controller = new NativeCloseController(renderer, () => backends, () => new Promise<void>(resolve => { finish = resolve }), () => {}, inspect)
    controller.receive(event()); await tick(); expect(controller.state?.phase).toBe('unknown')
    backends = [{} as Backend]; controller.refreshBackends(); await tick(); expect(controller.state?.snapshot?.active).toBe(1)
    const pending = controller.approve(true); backends = []; controller.refreshBackends(); expect(controller.state?.phase).toBe('cleaning'); finish(); expect(await pending).toBe(true); expect(renderer.resolveCloseRequest).toHaveBeenCalledWith('1', true)
  })
  it('keeps ownership guards outside environment-keyed content conditionals', () => {
    for (const [file, name] of [['owned-app.tsx', 'OwnedApp'], ['app.tsx', 'ConnectedApp']] as const) {
      const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      const owner = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name)!
      const returned = owner.body!.statements.filter(ts.isReturnStatement); expect(returned).toHaveLength(1)
      const root = returned[0]!.expression; expect(root && ts.isJsxElement(root)).toBe(true)
      const guard = (root as ts.JsxElement).children.find((node): node is ts.JsxSelfClosingElement => ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'NativeCloseGuard')
      expect(guard).toBeDefined(); expect(guard!.attributes.properties.some(node => ts.isJsxAttribute(node) && node.name.getText(source) === 'key')).toBe(false)
    }
  })
  it('shows active-agent confirmation without automatic approval', async () => { const s = setup(); s.controller.receive(event()); await tick(); expect(s.controller.state?.snapshot?.active).toBe(2); expect(s.controller.state?.phase).toBe('confirm'); expect(s.cleanup).not.toHaveBeenCalled(); expect(s.renderer.resolveCloseRequest).not.toHaveBeenCalled(); expect(await s.controller.approve(false)).toBe(false) })
  it('denies native close and keeps the window without cleanup', async () => { const s = setup(); s.controller.receive(event()); await tick(); expect(s.controller.deny()).toBe(true); expect(s.renderer.resolveCloseRequest).toHaveBeenCalledWith('1', false); expect(s.cleanup).not.toHaveBeenCalled(); expect(s.controller.state).toBeNull() })
  it('awaits cleanup before approving and coalesces duplicate confirmation', async () => { let finish!: () => void; const cleanup = vi.fn(() => new Promise<void>(resolve => { finish = resolve })); const s = setup(undefined, cleanup); s.controller.receive(event()); await tick(); const pending = s.controller.approve(true); expect(s.renderer.resolveCloseRequest).not.toHaveBeenCalled(); expect(await s.controller.approve(true)).toBe(false); finish(); expect(await pending).toBe(true); expect(cleanup).toHaveBeenCalledTimes(1); expect(s.renderer.resolveCloseRequest).toHaveBeenCalledWith('1', true) })
  it('keeps unknown status open but allows deliberate cleanup confirmation', async () => { const s = setup(vi.fn(async () => { throw new Error('offline') })); s.controller.receive(event()); await tick(); expect(s.controller.state?.phase).toBe('unknown'); expect(s.renderer.resolveCloseRequest).not.toHaveBeenCalled(); expect(await s.controller.approve(true)).toBe(true) })
  it('refuses close after failed cleanup', async () => { const s = setup(undefined, vi.fn(async () => { throw new Error('failed') })); s.controller.receive(event()); await tick(); expect(await s.controller.approve(true)).toBe(false); expect(s.controller.state?.phase).toBe('error'); expect(s.renderer.resolveCloseRequest).not.toHaveBeenCalled() })
  it('never approves replacement request/generation after old async cleanup', async () => { let finish!: () => void; const s = setup(undefined, vi.fn(() => new Promise<void>(resolve => { finish = resolve }))); s.controller.receive(event()); await tick(); const pending = s.controller.approve(true); s.controller.receive(event('2', 'window-2')); await tick(); finish(); expect(await pending).toBe(false); expect(s.renderer.resolveCloseRequest).not.toHaveBeenCalled(); s.controller.receive(event('late', 'window-1')); expect(s.controller.state?.request.windowGeneration).toBe('window-2') })
  it('ignores duplicate deliveries and stale inspection results', async () => { let first!: (value: { active: number; environments: number; checkedAt: number }) => void; const inspect = vi.fn().mockImplementationOnce(() => new Promise(resolve => { first = resolve })).mockResolvedValue({ active: 0, environments: 1, checkedAt: 2 }); const s = setup(inspect); s.controller.receive(event()); s.controller.receive(event()); expect(inspect).toHaveBeenCalledTimes(1); s.controller.receive(event('2')); await tick(); first({ active: 9, environments: 1, checkedAt: 1 }); await tick(); expect(s.controller.state?.request.closeRequestId).toBe('2'); expect(s.controller.state?.snapshot?.active).toBe(0) })
  it('reports native stale resolution without claiming replacement closed', async () => { const s = setup(); s.renderer.resolveCloseRequest.mockReturnValue(false); s.controller.receive(event()); await tick(); expect(await s.controller.approve(true)).toBe(false); expect(s.controller.state?.phase).toBe('stale') })
  it('unmount denies pending request and never disables the pre-armed guard', async () => { const s = setup(); s.controller.receive(event()); s.controller.dispose(); await tick(); expect(s.renderer.resolveCloseRequest).toHaveBeenCalledWith('1', false); expect(s.renderer.setCloseGuard).not.toHaveBeenCalled(); expect(s.controller.state).toBeNull() })
})
