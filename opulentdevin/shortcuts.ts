import type { EventPayload } from '@gpuix/react'
import type { Command, KeybindingRule } from './zuse-runtime/packages/contracts/src/keybindings'
import { parseKey, parseWhen, evaluateWhen, matchesShortcut } from './zuse-runtime/packages/contracts/src/keybindings-parse'

export const nativeDefaults: readonly KeybindingRule[] = [
  { key: 'mod+n', command: 'new-chat' },
  { key: 'mod+o', command: 'open-project' },
  { key: 'mod+,', command: 'settings' },
  { key: 'mod+b', command: 'toggle-left-sidebar' },
  { key: 'mod+j', command: 'toggle-terminal' },
  { key: 'mod+shift+p', command: 'open-chat-switcher' },
  { key: 'mod+tab', command: 'next-chat' },
  { key: 'mod+shift+tab', command: 'prev-chat' },
]
export function matchNativeCommand(event: EventPayload, rules: readonly KeybindingRule[], context: Readonly<Record<string, boolean>>, isMac = process.platform === 'darwin'): Command | null {
  const keyEvent = { key: event.key ?? '', metaKey: event.modifiers?.cmd ?? false, ctrlKey: event.modifiers?.ctrl ?? false, altKey: event.modifiers?.alt ?? false, shiftKey: event.modifiers?.shift ?? false }
  for (const rule of [...nativeDefaults, ...rules].reverse()) {
    const shortcut = parseKey(rule.key)
    const when = rule.when ? parseWhen(rule.when) : null
    if (!shortcut || (when && 'message' in when)) continue
    if (evaluateWhen(when, context) && matchesShortcut(keyEvent, shortcut, isMac)) return rule.command
  }
  return null
}
