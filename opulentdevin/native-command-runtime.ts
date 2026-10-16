import { useCallback, useRef } from 'react'
import type { EventPayload, NativeRenderer } from '@gpuix/react'
import type { Command, KeybindingRule } from './zuse-runtime/packages/contracts/src/keybindings'
import { parseKey, parseWhen, evaluateWhen, matchesShortcut } from './zuse-runtime/packages/contracts/src/keybindings-parse'

export const canonicalNativeDefaults: readonly KeybindingRule[] = [
  { key: 'mod+n', command: 'new-chat' }, { key: 'mod+o', command: 'open-project' }, { key: 'mod+,', command: 'settings' },
  { key: 'mod+w', command: 'close-tab' }, { key: 'mod+b', command: 'toggle-left-sidebar' }, { key: 'mod+alt+b', command: 'toggle-right-sidebar' },
  { key: 'mod+j', command: 'toggle-terminal' }, { key: 'mod+l', command: 'focus-composer' },
  { key: 'mod+shift+]', command: 'next-tab' }, { key: 'mod+shift+[', command: 'prev-tab' },
  { key: 'mod+1', command: 'select-tab-1' }, { key: 'mod+2', command: 'select-tab-2' }, { key: 'mod+3', command: 'select-tab-3' }, { key: 'mod+4', command: 'select-tab-4' },
  { key: 'mod+5', command: 'select-tab-5' }, { key: 'mod+6', command: 'select-tab-6' }, { key: 'mod+7', command: 'select-tab-7' }, { key: 'mod+8', command: 'select-tab-8' },
  { key: 'mod+9', command: 'select-last-tab' }, { key: 'mod+t', command: 'new-tab' },
  { key: 'ctrl+tab', command: 'next-chat' }, { key: 'ctrl+shift+tab', command: 'prev-chat' },
  { key: 'mod+alt+]', command: 'next-panel' }, { key: 'mod+alt+[', command: 'prev-panel' },
  { key: 'ctrl+`', command: 'focus-next-pane' }, { key: 'ctrl+shift+`', command: 'focus-prev-pane' },
  { key: 'mod+k', command: 'open-chat-switcher' }, { key: 'mod+p', command: 'search-files' },
  { key: 'enter', command: 'composer.submit' }, { key: 'shift+enter', command: 'composer.newline' },
  { key: 'mod+enter', command: 'composer.forceSubmit' }, { key: 'shift+tab', command: 'composer.togglePlanMode' },
  { key: 'mod+s', command: 'editor.save' }, { key: 'mod+shift+a', command: 'editor.annotate' },
]

export type CommandOutcome = { status: 'handled' } | { status: 'unsupported' | 'failed'; reason: string }
export type NativeCommandCallback = () => CommandOutcome | Promise<CommandOutcome>
export type NativeCommandAdapters = Partial<Record<Command, NativeCommandCallback>>
export const nativeCommandRequirements: Record<Command, string> = {
  'new-chat': 'Create a new chat in the selected project.', 'open-project': 'Open the native workspace picker.', settings: 'Open settings.',
  'close-tab': 'Close the active tab without deleting its chat.', 'toggle-left-sidebar': 'Toggle projects sidebar.', 'toggle-right-sidebar': 'Toggle files sidebar.',
  'toggle-terminal': 'Open the right pane and select its terminal.', 'focus-composer': 'Focus the mounted native composer.',
  'next-tab': 'Select the next tab within the active chat.', 'prev-tab': 'Select the previous tab within the active chat.',
  'select-tab-1': 'Select active-chat tab 1.', 'select-tab-2': 'Select active-chat tab 2.', 'select-tab-3': 'Select active-chat tab 3.', 'select-tab-4': 'Select active-chat tab 4.',
  'select-tab-5': 'Select active-chat tab 5.', 'select-tab-6': 'Select active-chat tab 6.', 'select-tab-7': 'Select active-chat tab 7.', 'select-tab-8': 'Select active-chat tab 8.',
  'select-last-tab': 'Select the last tab within the active chat.', 'new-tab': 'Create a session in the active chat.',
  'next-chat': 'Select the next non-archived chat in the project.', 'prev-chat': 'Select the previous non-archived chat in the project.',
  'next-panel': 'Select the next right-pane panel.', 'prev-panel': 'Select the previous right-pane panel.',
  'focus-next-pane': 'Focus the next mounted native pane.', 'focus-prev-pane': 'Focus the previous mounted native pane.',
  'open-chat-switcher': 'Open the chat switcher.', 'search-files': 'Open file search in the selected workspace.',
  'composer.submit': 'Submit through the composer submit policy.', 'composer.newline': 'Insert newline at the native selection, preserving undo.',
  'composer.forceSubmit': 'Force-submit through the composer force-submit policy.', 'composer.togglePlanMode': 'Toggle plan mode through the canonical session action.',
  'editor.save': 'Save through the active editor owner and await its acknowledgement.', 'editor.annotate': 'Annotate the active editor selection through its owner.',
}

export async function dispatchNativeCommand(command: Command, adapters: NativeCommandAdapters): Promise<CommandOutcome> {
  const callback = adapters[command]
  if (!callback) return { status: 'unsupported', reason: `${command}: ${nativeCommandRequirements[command]} No native owner is registered.` }
  try {
    const result = await callback()
    if (!result || !['handled', 'unsupported', 'failed'].includes(result.status)) return { status: 'failed', reason: `${command}: owner did not acknowledge the command.` }
    if (result.status !== 'handled' && !result.reason.trim()) return { status: 'failed', reason: `${command}: owner supplied no failure reason.` }
    return result
  } catch (error) { return { status: 'failed', reason: `${command}: ${error instanceof Error ? error.message : String(error)}` } }
}

export function resolveNativeKey(event: EventPayload, rules: readonly KeybindingRule[], context: Readonly<Record<string, boolean>>, isMac = process.platform === 'darwin'): Command | null {
  const overridden = new Set(rules.map(rule => rule.command))
  const merged = [...canonicalNativeDefaults.filter(rule => !overridden.has(rule.command)), ...rules]
  const aliases: Record<string, string> = { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', space: ' ' }
  const key = aliases[event.key ?? ''] ?? event.key ?? ''
  for (const rule of merged.reverse()) {
    if (rule.command.startsWith('composer.') && !context.composerFocus) continue
    if (rule.command.startsWith('editor.') && !context.editorFocus) continue
    if (context.settingsOpen && (rule.command.startsWith('composer.') || rule.command.startsWith('editor.'))) continue
    const shortcut = parseKey(rule.key)
    const when = rule.when ? parseWhen(rule.when) : null
    if (!shortcut || (when && 'message' in when)) continue
    if (evaluateWhen(when, context) && matchesShortcut({ key, metaKey: event.modifiers?.cmd ?? false, ctrlKey: event.modifiers?.ctrl ?? false, altKey: event.modifiers?.alt ?? false, shiftKey: event.modifiers?.shift ?? false }, shortcut, isMac)) return rule.command
  }
  return null
}

export function nativeFocusCommand(renderer: Pick<NativeRenderer, 'focusElement' | 'getFocusedElementId'> | null, elementId: number | null): CommandOutcome {
  if (elementId === null || !renderer?.focusElement || !renderer.getFocusedElementId) return { status: 'unsupported', reason: 'Native focus target or focus verification is unavailable.' }
  renderer.focusElement(elementId)
  return renderer.getFocusedElementId() === elementId ? { status: 'handled' } : { status: 'failed', reason: 'Native renderer did not focus the requested element.' }
}

export function createNativeEditorHandshake() {
  let owner: { token: symbol; id: string; save: NativeCommandCallback; annotate: NativeCommandCallback } | null = null
  return {
    register(id: string, callbacks: { save: NativeCommandCallback; annotate: NativeCommandCallback }) {
      const token = Symbol(id)
      owner = { token, id, ...callbacks }
      return () => { if (owner?.token === token) owner = null }
    },
    async dispatch(action: 'save' | 'annotate'): Promise<CommandOutcome> {
      const captured = owner
      if (!captured) return { status: 'unsupported', reason: `No active native editor owns ${action}.` }
      const result = await dispatchNativeCommand(action === 'save' ? 'editor.save' : 'editor.annotate', { [action === 'save' ? 'editor.save' : 'editor.annotate']: captured[action] })
      if (owner?.token !== captured.token) return { status: 'failed', reason: `Editor ownership changed during ${action}; the previous editor may have completed it. Do not replay automatically.` }
      return result
    },
  }
}

export function useNativeCommandRuntime(options: { adapters: NativeCommandAdapters; rules: readonly KeybindingRule[]; context: Readonly<Record<string, boolean>>; onError: (message: string) => void; isMac?: boolean }) {
  const latest = useRef(options)
  latest.current = options
  const dispatch = useCallback(async (command: Command) => {
    const result = await dispatchNativeCommand(command, latest.current.adapters)
    if (result.status !== 'handled') latest.current.onError(result.reason)
    return result
  }, [])
  const onKeyDown = useCallback((event: EventPayload) => {
    const current = latest.current
    const command = resolveNativeKey(event, current.rules, current.context, current.isMac)
    if (!command) return { matched: false as const }
    return { matched: true as const, command, completion: dispatch(command) }
  }, [dispatch])
  return { dispatch, onKeyDown }
}
