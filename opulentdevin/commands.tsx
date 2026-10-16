import { useState } from 'react'
import type { Palette } from './theme'

export type NativeCommand = { id: string; label: string; detail?: string; execute: () => void }
export function filterCommands(commands: readonly NativeCommand[], query: string) {
  const terms = query.trim().toLowerCase().split(/\s+/)
  return commands.filter(command => terms.every(term => `${command.label} ${command.detail ?? ''}`.toLowerCase().includes(term)))
}
export function CommandPalette({ commands, palette: p, onClose }: { commands: readonly NativeCommand[]; palette: Palette; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const matches = filterCommands(commands, query)
  const selected = Math.min(index, Math.max(0, matches.length - 1))
  function run(command?: NativeCommand) { if (!command) return; onClose(); command.execute() }
  return <div testId="command-palette" style={{ display: 'flex', flexDirection: 'column', width: '90%', maxWidth: 680, maxHeight: 500, backgroundColor: p.elevated, borderRadius: 12, padding: 12, gap: 6 }}>
    <input testId="command-query" value={query} placeholder="Search commands and sessions" onChange={event => { setQuery(event.value ?? ''); setIndex(0) }} onSubmit={() => run(matches[selected])} onKeyDown={event => { if (event.key === 'escape') onClose(); if (event.key === 'down') setIndex(Math.min(matches.length - 1, selected + 1)); if (event.key === 'up') setIndex(Math.max(0, selected - 1)) }} style={{ color: p.text, height: 36, padding: 8 }} />
    <div style={{ display: 'flex', flexDirection: 'column', overflowY: 'scroll', maxHeight: 400 }}>
      {matches.map((command, row) => <div key={command.id} testId={`command-${command.id}`} onClick={() => run(command)} style={{ display: 'flex', flexDirection: 'column', padding: 10, gap: 3, cursor: 'pointer', borderRadius: 6, backgroundColor: row === selected ? p.selected : undefined }}><text style={{ color: p.text, fontSize: 13 }}>{command.label}</text>{command.detail && <text style={{ color: p.secondary, fontSize: 11 }}>{command.detail}</text>}</div>)}
      {!matches.length && <text style={{ color: p.secondary, padding: 10 }}>No matching commands.</text>}
    </div>
    <div onClick={onClose} style={{ padding: 6, cursor: 'pointer' }}><text style={{ color: p.secondary, fontSize: 12 }}>Escape to close</text></div>
  </div>
}
