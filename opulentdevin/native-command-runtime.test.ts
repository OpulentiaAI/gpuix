import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { Command } from './zuse-runtime/packages/contracts/src/keybindings'
import { canonicalNativeDefaults, createNativeEditorHandshake, dispatchNativeCommand, nativeCommandRequirements, nativeFocusCommand, resolveNativeKey, type CommandOutcome } from './native-command-runtime'
import type { EventPayload } from '@gpuix/react'

const event = (key: string, modifiers: Partial<NonNullable<EventPayload['modifiers']>> = {}): EventPayload => ({ elementId: 1, eventType: 'keyDown', key, modifiers: { cmd: false, ctrl: false, alt: false, shift: false, ...modifiers } })
describe('native canonical command runtime', () => {
  it('covers every canonical command with a real owner or explicit unsupported result', async () => {
    expect(Object.keys(nativeCommandRequirements).sort()).toEqual([...Command.literals].sort())
    for (const command of Command.literals) {
      expect(await dispatchNativeCommand(command, {})).toMatchObject({ status: 'unsupported', reason: expect.stringContaining(command) })
      const owner = vi.fn(() => ({ status: 'handled' as const }))
      expect(await dispatchNativeCommand(command, { [command]: owner })).toEqual({ status: 'handled' })
      expect(owner).toHaveBeenCalledOnce()
    }
  })
  it('matches maintained default bindings without importing renderer UI code', () => {
    const source = readFileSync(new URL('./zuse-runtime/apps/renderer/src/lib/default-keybindings.ts', import.meta.url), 'utf8').split('export const DEFAULT_KEYBINDINGS:')[1].split('];')[0]
    const defaults = [...source.matchAll(/\{ key: "([^"]+)", command: "([^"]+)" \}/g)].map(match => ({ key: match[1], command: match[2] }))
    expect(canonicalNativeDefaults).toEqual(defaults)
  })
  it('keeps tabs, chats and panels distinct', () => {
    expect(resolveNativeKey(event(']', { ctrl: true, shift: true }), [], {}, false)).toBe('next-tab')
    expect(resolveNativeKey(event('tab', { ctrl: true }), [], {}, false)).toBe('next-chat')
    expect(resolveNativeKey(event(']', { ctrl: true, alt: true }), [], {}, false)).toBe('next-panel')
  })
  it('scopes composer and editor bindings and replaces overridden command defaults', () => {
    expect(resolveNativeKey(event('enter'), [], {}, false)).toBeNull()
    expect(resolveNativeKey(event('enter'), [], { composerFocus: true }, false)).toBe('composer.submit')
    expect(resolveNativeKey(event('enter', { shift: true }), [], { composerFocus: true }, false)).toBe('composer.newline')
    expect(resolveNativeKey(event('enter', { ctrl: true }), [], { composerFocus: true }, false)).toBe('composer.forceSubmit')
    expect(resolveNativeKey(event('tab', { shift: true }), [], { composerFocus: true }, false)).toBe('composer.togglePlanMode')
    expect(resolveNativeKey(event('s', { ctrl: true }), [], { editorFocus: true }, false)).toBe('editor.save')
    expect(resolveNativeKey(event('s', { ctrl: true }), [], {}, false)).toBeNull()
    expect(resolveNativeKey(event('n', { ctrl: true }), [{ key: 'mod+x', command: 'new-chat' }], {}, false)).toBeNull()
    expect(resolveNativeKey(event('x', { ctrl: true }), [{ key: 'mod+x', command: 'new-chat', when: 'settingsOpen' }], { settingsOpen: true }, false)).toBe('new-chat')
  })
  it('requires explicit acknowledgements and surfaces handler failures', async () => {
    expect(await dispatchNativeCommand('editor.save', { 'editor.save': () => { throw new Error('disk full') } })).toMatchObject({ status: 'failed', reason: expect.stringContaining('disk full') })
    expect(await dispatchNativeCommand('composer.newline', { 'composer.newline': () => ({ status: 'unsupported', reason: 'Selection insertion is unavailable.' }) })).toMatchObject({ status: 'unsupported' })
  })
  it('verifies native focus rather than claiming an attempted focus succeeded', () => {
    let focused = 0
    expect(nativeFocusCommand({ focusElement: id => { focused = id }, getFocusedElementId: () => focused }, 7)).toEqual({ status: 'handled' })
    expect(nativeFocusCommand(null, 7).status).toBe('unsupported')
    expect(nativeFocusCommand({ focusElement: () => {}, getFocusedElementId: () => 0 }, 7).status).toBe('failed')
  })
  it('uses an acknowledged editor handshake and rejects stale owner completion', async () => {
    const bridge = createNativeEditorHandshake()
    expect((await bridge.dispatch('save')).status).toBe('unsupported')
    let complete!: (result: CommandOutcome) => void
    const unregister = bridge.register('first', { save: () => new Promise(resolve => { complete = resolve }), annotate: () => ({ status: 'handled' }) })
    const pending = bridge.dispatch('save')
    bridge.register('second', { save: () => ({ status: 'handled' }), annotate: () => ({ status: 'handled' }) })
    unregister()
    complete({ status: 'handled' })
    expect(await pending).toMatchObject({ status: 'failed', reason: expect.stringContaining('ownership changed') })
    expect(await bridge.dispatch('annotate')).toEqual({ status: 'handled' })
  })
})
