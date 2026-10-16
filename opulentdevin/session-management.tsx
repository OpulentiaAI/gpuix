import { useEffect, useRef, useState } from 'react'
import { writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { Backend } from './backend'
import { ids } from './backend'
import type { Session } from './zuse-runtime/packages/contracts/src/session'
import type { FolderId } from './zuse-runtime/packages/contracts/src/ids'
import type { Worktree } from './zuse-runtime/packages/contracts/src/worktree'
import { palettes, type Palette } from './theme'

export type SessionManagementProps = { backend: Backend; session: Session | null; folderId: FolderId | null; onSelect: (session: Session | null) => void; onError: (message: string) => void; palette?: Palette }

export async function saveTranscriptExclusive(path: string, markdown: string) {
  if (!isAbsolute(path) || !path.toLowerCase().endsWith('.md')) throw new Error('Choose an absolute path ending in .md; existing files are never overwritten.')
  await writeFile(path, markdown, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
}

export function SessionManagement({ backend, session, folderId, onSelect, onError, palette: p = palettes.dark }: SessionManagementProps) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState(session?.title ?? '')
  const [destination, setDestination] = useState('')
  const [confirm, setConfirm] = useState<'archive' | 'delete' | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [worktrees, setWorktrees] = useState<readonly Worktree[]>([])
  const [tabs, setTabs] = useState<readonly Session[]>([])
  const [canChangeTree, setCanChangeTree] = useState(false)
  const current = useRef(session?.id)
  current.current = session?.id
  useEffect(() => { setTitle(session?.title ?? ''); setConfirm(null); setNotice(''); setCanChangeTree(false) }, [session?.id, session?.title])
  useEffect(() => {
    if (!open || !session || !folderId) return
    let live = true
    Promise.all([backend.run(backend.client['worktree.list']({ projectId: folderId })), backend.sessions.list({ projectId: folderId })]).then(async ([trees, sessions]) => {
      const siblings = sessions.filter(item => item.chatId === session.chatId)
      const histories = await Promise.all(siblings.map(item => backend.messages.list({ sessionId: item.id })))
      if (live) { setWorktrees(trees); setTabs(siblings); setCanChangeTree(histories.every(messages => messages.length === 0)) }
    }).catch(error => { if (live) onError(String(error)) })
    return () => { live = false }
  }, [open, backend, session?.id, folderId])
  if (!session || !folderId) return null
  const selected = session
  const action = async (work: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setNotice('')
    try { await work() } catch (error) { onError(String(error)) } finally { setBusy(false) }
  }
  const choose = (updated: Session | null) => { if (current.current === selected.id) onSelect(updated) }
  const button = (label: string, run: () => void, disabled = false, danger = false) => <div key={label} testId={`session-${label.toLowerCase().replaceAll(' ', '-')}`} onClick={() => { if (!busy && !disabled) run() }} style={{ display: 'flex', height: 28, paddingLeft: 8, paddingRight: 8, alignItems: 'center', borderRadius: 6, cursor: busy || disabled ? 'default' : 'pointer', backgroundColor: p.subtle }}><text style={{ fontSize: 12, color: disabled || busy ? p.disabled : danger ? p.danger : p.text }}>{label}</text></div>
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    {button(open ? 'Close session actions' : 'Session actions', () => setOpen(!open))}
    {open && <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 10, backgroundColor: p.wash, borderRadius: 6 }}>
      <div style={{ display: 'flex', flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{tabs.map(tab => button(tab.title || 'Untitled tab', () => onSelect(tab), tab.id === session.id))}{button('New session tab', () => void action(async () => { const created = await backend.sessions.create({ chatId: selected.chatId, providerId: selected.providerId, model: selected.model, runtimeMode: selected.runtimeMode, permissionMode: selected.permissionMode }); choose(created) }))}</div>
      <div style={{ display: 'flex', flexDirection: 'row', gap: 6 }}><input testId="session-title" value={title} onChange={event => setTitle(event.value ?? '')} placeholder="Session title" style={{ height: 28, flexGrow: 1, color: p.text }} />{button('Rename', () => void action(async () => { choose(await backend.sessions.rename({ sessionId: selected.id, title: title.trim(), commandId: ids.CommandId.make(crypto.randomUUID()) })) }), !title.trim())}</div>
      <text style={{ color: p.secondary, fontSize: 11 }}>{canChangeTree ? 'Worktree applies to every tab in this chat.' : 'Worktree is locked after a message; the server enforces this too.'}</text>
      <div style={{ display: 'flex', flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{[{ id: null, name: 'Main checkout' }, ...worktrees].map(tree => button(tree.name, () => void action(async () => { await backend.run(backend.client['session.setWorktree']({ sessionId: selected.id, worktreeId: tree.id })); choose(await backend.sessions.get({ sessionId: selected.id })) }), !canChangeTree || selected.worktreeId === tree.id))}</div>
      <div style={{ display: 'flex', flexDirection: 'row', gap: 6 }}><input testId="transcript-path" value={destination} onChange={event => setDestination(event.value ?? '')} placeholder="Absolute path for new transcript.md" style={{ height: 28, flexGrow: 1, color: p.text }} />{button('Export transcript', () => void action(async () => { const result = await backend.run(backend.client['session.exportTranscript']({ sessionId: selected.id })); await saveTranscriptExclusive(destination.trim(), result.markdown); setNotice(`Saved ${destination.trim()}`) }), !destination.trim())}</div>
      <div style={{ display: 'flex', flexDirection: 'row', gap: 6 }}>{button('Archive', () => setConfirm('archive'))}{button('Delete', () => setConfirm('delete'), false, true)}</div>
      {confirm && <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><text style={{ color: p.warning, fontSize: 12 }}>{confirm === 'delete' ? `Permanently delete “${selected.title}” and its transcript?` : `Archive “${selected.title}”?`}</text><div style={{ display: 'flex', flexDirection: 'row', gap: 6 }}>{button(`Confirm ${confirm}`, () => void action(async () => { if (confirm === 'delete') await backend.sessions.delete({ sessionId: selected.id }); else await backend.run(backend.client['session.archive']({ sessionId: selected.id })); setConfirm(null); choose(null) }), false, confirm === 'delete')}{button('Cancel', () => setConfirm(null))}</div></div>}
      {notice && <text style={{ fontSize: 11, color: p.success }}>{notice}</text>}
    </div>}
  </div>
}
