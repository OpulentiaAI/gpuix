import { useEffect, useRef, useState } from 'react'
import type { EventPayload } from '@gpuix/native'
import type { Palette } from './theme'

export type EditorProps = { value: string; onChange: (value: string) => void; onSave: (value: string) => void | Promise<void>; path: string; palette: Palette; readOnly?: boolean }
export type FindMatch = { start: number; end: number; line: number; column: number }

export function lineColumn(value: string, offset: number) {
  const prefix = value.slice(0, Math.max(0, Math.min(offset, value.length)))
  const lines = prefix.split('\n')
  return { line: lines.length, column: Array.from(lines[lines.length - 1]).length + 1 }
}

export function findLiteral(value: string, query: string, caseSensitive = true): FindMatch[] {
  if (!query) return []
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const expression = new RegExp(escaped, caseSensitive ? 'gu' : 'giu')
  return Array.from(value.matchAll(expression), match => ({ start: match.index, end: match.index + match[0].length, ...lineColumn(value, match.index) }))
}

export function replaceLiteral(value: string, query: string, replacement: string, caseSensitive = true) {
  const matches = findLiteral(value, query, caseSensitive)
  let result = value
  for (let i = matches.length - 1; i >= 0; i--) result = result.slice(0, matches[i].start) + replacement + result.slice(matches[i].end)
  return { value: result, count: matches.length }
}

export function Editor({ value, onChange, onSave, path, palette: p, readOnly = false }: EditorProps) {
  const [saved, setSaved] = useState(value)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState(false)
  const [finding, setFinding] = useState(false)
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(true)
  const [active, setActive] = useState(0)
  const [confirmation, setConfirmation] = useState<{ value: string; query: string; replacement: string; caseSensitive: boolean; count: number } | null>(null)
  const latestPath = useRef(path); latestPath.current = path
  const saveLock = useRef(false)
  useEffect(() => { setSaved(value); setError(''); setConfirmation(null); setActive(0); setQuery(''); setFinding(false) }, [path])
  const matches = findLiteral(value, query, caseSensitive)
  const current = matches.length ? matches[Math.min(active, matches.length - 1)] : null
  const dirty = value !== saved
  const save = async () => {
    if (readOnly || saveLock.current) return
    saveLock.current = true; setSaving(true); setError('')
    const requestedPath = path
    try { await onSave(value); if (latestPath.current === requestedPath) setSaved(value) }
    catch (cause) { if (latestPath.current === requestedPath) setError(String(cause)) }
    finally { saveLock.current = false; setSaving(false) }
  }
  const keyDown = (event: EventPayload) => {
    const key = event.key?.toLowerCase()
    if ((event.modifiers?.cmd || event.modifiers?.ctrl) && !event.modifiers.alt) {
      if (key === 's') void save()
      if (key === 'f') { setFinding(true); setPreview(true) }
    }
    if (key === 'escape') { setFinding(false); setConfirmation(null) }
  }
  const button = (label: string, action: () => void, disabled = false) => <div testId={`editor-${label.toLowerCase().replaceAll(' ', '-')}`} tabIndex={0} onClick={() => { if (!disabled) action() }} onKeyDown={event => { if (!disabled && event.key?.toLowerCase() === 'enter') action() }} style={{ display: 'flex', height: 28, paddingLeft: 8, paddingRight: 8, alignItems: 'center', borderRadius: 6, backgroundColor: p.subtle, cursor: disabled ? 'default' : 'pointer' }}><text style={{ color: disabled ? p.disabled : p.text, fontSize: 12 }}>{label}</text></div>
  return <div onKeyDown={keyDown} style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0, gap: 6 }}>
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>{button(saving ? 'Saving' : 'Save', () => void save(), readOnly || saving || !dirty)}{button('Find', () => { setFinding(!finding); setPreview(true) })}{button(preview ? 'Edit text' : 'Syntax preview', () => setPreview(!preview))}<text style={{ color: p.secondary, fontSize: 11 }}>{readOnly ? 'Read only' : dirty ? 'Unsaved changes' : 'Saved'} · {value.split('\n').length} lines · {value.length} UTF-16 units</text></div>
    {finding && <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', flexDirection: 'row', gap: 4 }}><input testId="editor-find" autoFocus value={query} onChange={event => { setQuery(event.value ?? ''); setActive(0); setConfirmation(null) }} placeholder="Find literal text" style={{ height: 28, color: p.text, flexGrow: 1 }} />{button(caseSensitive ? 'Match case' : 'Ignore case', () => { setCaseSensitive(!caseSensitive); setActive(0); setConfirmation(null) })}{button('Previous', () => setActive((active - 1 + matches.length) % matches.length), !matches.length)}{button('Next', () => setActive((active + 1) % matches.length), !matches.length)}</div>
      <text style={{ color: p.secondary, fontSize: 11 }}>{current ? `Match ${Math.min(active + 1, matches.length)}/${matches.length}: Ln ${current.line}, Col ${current.column}` : 'No matches'} · Match position, not caret position</text>
      {!readOnly && <div style={{ display: 'flex', flexDirection: 'row', gap: 4 }}><input testId="editor-replacement" value={replacement} onChange={event => { setReplacement(event.value ?? ''); setConfirmation(null) }} placeholder="Replacement (literal)" style={{ height: 28, color: p.text, flexGrow: 1 }} />{button('Replace match', () => { if (current) onChange(value.slice(0, current.start) + replacement + value.slice(current.end)) }, !current)}{button('Replace all', () => setConfirmation({ value, query, replacement, caseSensitive, count: matches.length }), !matches.length)}</div>}
      {confirmation && <div style={{ display: 'flex', flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><text style={{ color: p.warning, fontSize: 12 }}>Replace {confirmation.count} matches across the entire file?</text>{button('Confirm replace all', () => { if (value !== confirmation.value) { setError('File changed after confirmation was opened. Review the replacements again.'); setConfirmation(null); return } onChange(replaceLiteral(value, confirmation.query, confirmation.replacement, confirmation.caseSensitive).value); setConfirmation(null) })}{button('Cancel replacement', () => setConfirmation(null))}</div>}
    </div>}
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, overflowY: 'scroll', backgroundColor: p.wash, padding: 8 }}>
      <div style={{ display: preview ? 'none' : 'flex', flexDirection: 'column', width: '100%' }}><textarea key={path} testId="native-file-editor" value={value} readOnly={readOnly} minRows={12} maxRows={200} onChange={event => { if (!readOnly) onChange(event.value ?? '') }} style={{ width: '100%', color: p.text, fontFamily: 'monospace', fontSize: 13, lineHeight: 19 }} /></div>
      {preview && <code testId="editor-syntax-preview" code={value} path={path} showLineNumbers highlight={finding && query ? { query, caseSensitive, activeIndex: active } : null} style={{ width: '100%', color: p.text, fontSize: 13, lineHeight: 19 }} />}
    </div>
    {error && <text style={{ color: p.danger, fontSize: 11 }}>{error}</text>}
    <text style={{ color: p.secondary, fontSize: 11 }}>Native text editing · Cmd/Ctrl+S save · Cmd/Ctrl+F find · native undo/redo · syntax preview is separate. Caret position and selection jumps are unavailable.</text>
  </div>
}
