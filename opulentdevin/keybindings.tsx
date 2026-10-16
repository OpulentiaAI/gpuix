import { useEffect, useState } from 'react'
import type { Backend } from './backend'
import { Command, type KeybindingRule } from './zuse-runtime/packages/contracts/src/keybindings'
import type { Palette } from './theme'

export function KeybindingSettings({ backend, palette: p, onError }: { backend: Backend; palette: Palette; onError: (error: unknown) => void }) {
  const [rules, setRules] = useState<readonly KeybindingRule[]>([])
  const [key, setKey] = useState('')
  const [command, setCommand] = useState<Command>('new-chat')
  const [busy, setBusy] = useState(false)
  useEffect(() => { const sub = backend.subscribe(backend.client['keybindings.stream'](), value => setRules(value.rules), onError); return () => sub.cancel() }, [backend])
  async function replace(next: readonly KeybindingRule[]) {
    setBusy(true)
    try { const saved = await backend.run(backend.client['keybindings.replace']({ rules: next })); setRules(saved.rules) } catch (error) { onError(error) } finally { setBusy(false) }
  }
  return <div style={{ display: 'flex', flexDirection: 'column', padding: 16, gap: 10, width: '100%', overflowY: 'scroll' }}>
    <text style={{ color: p.text, fontSize: 18 }}>Keyboard shortcuts</text>
    <text style={{ color: p.secondary, fontSize: 12 }}>Stored in the shared Zuse keybinding service. Native command coverage is shown in the command palette; editor and platform shortcuts retain native behaviour.</text>
    <input value={key} placeholder="Shortcut, for example mod+shift+n" onChange={event => setKey(event.value ?? '')} style={{ padding: 8, color: p.text }} />
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{Command.literals.map(value => <div key={value} onClick={() => setCommand(value)} style={{ padding: 6, cursor: 'pointer', backgroundColor: command === value ? p.selected : p.subtle }}><text style={{ color: p.text, fontSize: 12 }}>{value}</text></div>)}</div>
    <div testId="keybinding-add" onClick={() => { if (!busy && key.trim()) void replace([...rules, { key: key.trim(), command }]) }} style={{ padding: 8, cursor: busy ? 'default' : 'pointer', backgroundColor: p.elevated }}><text style={{ color: p.text }}>Add override</text></div>
    {rules.map((rule, index) => <div key={`${index}:${rule.key}`} style={{ display: 'flex', flexDirection: 'row', justifyContent: 'space-between', padding: 8 }}><text style={{ color: p.text, fontSize: 12 }}>{rule.key} → {rule.command}{rule.when ? ` (${rule.when})` : ''}</text><div onClick={() => { if (!busy) void replace(rules.filter((_, row) => row !== index)) }}><text style={{ color: p.danger, fontSize: 12 }}>Remove</text></div></div>)}
  </div>
}
