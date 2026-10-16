import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { WorkbenchBufferStore, type BufferScope } from './workbench-buffer-store'
import { dataDirectory } from './preferences'
import { join } from 'node:path'
import type { CodeAnnotation } from './zuse-runtime/packages/contracts/src/composer'
import { Editor, type NativeEditorCommands } from './editor'
import { FileControls, GitControls } from './git-controls'
import { TerminalGrid } from './terminal-grid'
import type { Backend } from './backend'
import { palettes, type Palette } from './theme'
import { CommandId, PtyOwnerId, type EnvironmentId, type AgentSessionId, type FolderId, type WorktreeId } from './zuse-runtime/packages/contracts/src/ids.ts'
import type { FsEntry } from './zuse-runtime/packages/contracts/src/fs.ts'
import type { GitChange, GitDiffResult, GitStatusSummary } from './zuse-runtime/packages/contracts/src/git.ts'
import { PtyOpenToken, PtyOwnership, type PtySummary } from './zuse-runtime/packages/contracts/src/pty.ts'

export type WorkbenchPanel = 'Files' | 'Terminal' | 'Changes'

export type WorkbenchProps = {
  environmentId: EnvironmentId
  backend: Backend | null
  folderId: FolderId | null
  sessionId: AgentSessionId | null
  onError: (message: string) => void
  palette?: Palette
  onAnnotate?: (annotation: CodeAnnotation) => void | Promise<void>
  editorCommands?: NativeEditorCommands
  requestedPanel?: WorkbenchPanel
  onPanelChange?: (panel: WorkbenchPanel) => void
}

type Checkout = { environmentId: EnvironmentId; folderId: FolderId; worktreeId: WorktreeId | null; cwd: string }
type PaneProps = { backend: Backend; checkout: Checkout; palette: Palette; report: (error: unknown) => void; active: boolean }
type FileBuffer = { path: string; content: string; saved: string; mtime: string; conflict?: boolean }

function Action({ children, onClick, disabled = false, palette }: { children: ReactNode; onClick: () => void; disabled?: boolean; palette: Palette }) {
  return <div testId={typeof children === 'string' ? `workbench-${children.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : undefined} role="button" tabIndex={disabled ? -1 : 0} onClick={() => { if (!disabled) onClick() }} onKeyDown={event => { if (!disabled && (event.key?.toLowerCase() === 'enter' || event.key === ' ')) onClick() }} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', flexShrink: 0, minWidth: 0, padding: 7, borderRadius: 5, cursor: disabled ? 'default' : 'pointer', backgroundColor: palette.subtle, opacity: disabled ? 0.45 : 1 }}><text style={{ color: palette.text, fontSize: 12, whiteSpace: 'nowrap' }}>{children}</text></div>
}

export function Workbench(props: WorkbenchProps) {
  return <WorkbenchScope key={`${props.environmentId}:${props.folderId ?? ''}:${props.sessionId ?? ''}`} {...props} />
}

function WorkbenchScope({ environmentId, backend, folderId, sessionId, onError, palette = palettes.dark, editorCommands, requestedPanel, onPanelChange, onAnnotate }: WorkbenchProps) {
  const [tab, setTab] = useState<WorkbenchPanel>(requestedPanel ?? 'Files')
  useEffect(() => { if (requestedPanel) setTab(requestedPanel) }, [requestedPanel])
  const selectPanel = (panel: WorkbenchPanel) => { setTab(panel); onPanelChange?.(panel) }
  const [checkout, setCheckout] = useState<Checkout | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const errorHandler = useRef(onError)
  errorHandler.current = onError
  const report = useCallback((reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason)
    setError(message)
    errorHandler.current(message)
  }, [])

  useEffect(() => {
    let active = true
    setCheckout(null)
    if (!backend || !folderId) return
    void (async () => {
      const folders = await backend.workspaces.list({})
      const folder = folders.find(item => item.id === folderId)
      if (!folder) throw new Error('The selected workspace is no longer available.')
      const session = sessionId ? await backend.sessions.get({ sessionId }) : null
      if (session && session.projectId !== folderId) throw new Error('The selected session belongs to another workspace.')
      const worktreeId = session?.worktreeId ?? null
      const worktree = worktreeId ? await backend.run(backend.client['worktree.get']({ worktreeId })) : null
      if (worktreeId && (!worktree || worktree.projectId !== folderId)) throw new Error('The session checkout is unavailable. No files were opened in the main checkout.')
      if (active) setCheckout({ environmentId, folderId, worktreeId, cwd: worktree?.path ?? folder.path })
    })().catch(reason => { if (active) report(reason) })
    return () => { active = false }
  }, [environmentId, backend, folderId, sessionId, attempt, report])

  return <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, minWidth: 0, backgroundColor: palette.page }}>
    <div style={{ display: 'flex', gap: 6, padding: 10, borderBottomWidth: 1, borderColor: palette.border }}>
      {(['Files', 'Terminal', 'Changes'] as const).map(name => <div key={name} role="button" tabIndex={0} onClick={() => selectPanel(name)} onKeyDown={event => { if (event.key?.toLowerCase() === 'enter') selectPanel(name) }} style={{ padding: 9, borderRadius: 6, backgroundColor: name === tab ? palette.selected : palette.page }}><text style={{ fontSize: 13, color: name === tab ? palette.text : palette.muted }}>{name}</text></div>)}
    </div>
    {error ? <div style={{ padding: 10, backgroundColor: palette.dangerBg, display: 'flex', gap: 8, alignItems: 'center' }}><text style={{ color: palette.danger, flexGrow: 1, fontSize: 12 }}>{error}</text><Action palette={palette} onClick={() => { setError(''); if (!checkout) setAttempt(value => value + 1) }}>{checkout ? 'Dismiss' : 'Retry'}</Action></div> : null}
    {!backend ? <Empty palette={palette}>Connect to Zuse to open the workbench.</Empty> : !folderId ? <Empty palette={palette}>Choose a workspace to browse its files, terminal and changes.</Empty> : !checkout ? <Empty palette={palette}>{error ? 'Workspace could not be opened.' : 'Opening workspace…'}</Empty> : <>
      <FilesPane onAnnotate={onAnnotate} editorCommands={editorCommands} active={tab === 'Files'} backend={backend} checkout={checkout} palette={palette} report={report} />
      {sessionId ? <TerminalPane active={tab === 'Terminal'} backend={backend} checkout={checkout} sessionId={sessionId} palette={palette} report={report} /> : tab === 'Terminal' ? <Empty palette={palette}>Choose a session to open its terminal. Files and changes are available without a session.</Empty> : null}
      <ChangesPane active={tab === 'Changes'} backend={backend} checkout={checkout} palette={palette} report={report} />
    </>}
  </div>
}

function Empty({ children, palette }: { children: ReactNode; palette: Palette }) {
  return <div style={{ padding: 24, flexGrow: 1 }}><text style={{ color: palette.muted, fontSize: 13 }}>{children}</text></div>
}

function FilesPane({ backend, checkout, palette, report, active, editorCommands, onAnnotate }: PaneProps & { editorCommands?: NativeEditorCommands; onAnnotate?: WorkbenchProps['onAnnotate'] }) {
  const [store] = useState(() => new WorkbenchBufferStore(join(dataDirectory, 'editor-drafts')))
  const scope: BufferScope = { environmentId: checkout.environmentId, folderId: checkout.folderId, worktreeId: checkout.worktreeId }
  const [discarding, setDiscarding] = useState(false)
  const [tree, setTree] = useState<Record<string, readonly FsEntry[]>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set(['']))
  const [buffers, setBuffers] = useState<readonly FileBuffer[]>([])
  const draftRevision = useRef('empty')
  const persist = (next: readonly FileBuffer[]) => { draftRevision.current = store.save(scope, draftRevision.current, next).revision }
  const [selected, setSelected] = useState<string | null>(null)
  const [recovery, setRecovery] = useState<{ path: string; content: string; mtime: string } | null>(null)
  const [discardPath, setDiscardPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState<string | null>(null)
  const alive = useRef(true)
  const pendingWrite = useRef<Parameters<Backend['files']['write']>[0] | null>(null)
  const current = buffers.find(buffer => buffer.path === selected)
  const latestBuffers = useRef(buffers); latestBuffers.current = buffers
  const loadTree = useCallback(async (path: string) => {
    const entries = await backend.files.tree({ folderId: checkout.folderId, worktreeId: checkout.worktreeId, path })
    if (alive.current) setTree(value => ({ ...value, [path]: entries }))
  }, [backend, checkout])
  useEffect(() => {
    alive.current = true
    void loadTree('').catch(report)
    try {
      const snapshot = store.read(scope)
      draftRevision.current = snapshot.revision
      const drafts = snapshot.buffers
      setBuffers(drafts.map(draft => ({ path: draft.path, content: draft.content, saved: draft.saved, mtime: draft.mtime, conflict: true })))
      setSelected(drafts[0]?.path ?? null)
      for (const draft of drafts) void backend.files.read({ folderId: checkout.folderId, worktreeId: checkout.worktreeId, path: draft.path }).then(live => {
        if (alive.current && live.kind === 'text') setBuffers(value => value.map(buffer => buffer.path === draft.path ? { ...buffer, conflict: live.mtime !== draft.mtime || live.content !== draft.saved } : buffer))
      }).catch(report)
    } catch (error) { report(error) }
    return () => { alive.current = false }
  }, [loadTree, report])

  const open = async (entry: FsEntry) => {
    if (entry.kind === 'directory') {
      if (!expanded.has(entry.path)) await loadTree(entry.path)
      if (alive.current) setExpanded(value => { const next = new Set(value); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next })
      return
    }
    if (buffers.some(buffer => buffer.path === entry.path)) { setSelected(entry.path); return }
    setLoading(entry.path)
    try {
      const result = await backend.files.read({ folderId: checkout.folderId, worktreeId: checkout.worktreeId, path: entry.path })
      if (result.kind !== 'text') throw new Error(`${entry.path} is binary (${result.size} bytes); text editing is unavailable.`)
      if (alive.current) {
        setBuffers(value => value.some(buffer => buffer.path === entry.path) ? value : [...value, { path: entry.path, content: result.content, saved: result.content, mtime: result.mtime }])
        setSelected(entry.path)
      }
    } finally { if (alive.current) setLoading(null) }
  }
  const save = async (content: string) => {
    if (!current) throw new Error('No file is selected.')
    if (current.conflict) throw new Error('Draft conflicts with the current file. Review recovery or discard it before saving.')
    if (busy) throw new Error('A file save is already in progress.')
    setBusy(true)
    const prior = pendingWrite.current
    const payload = prior && prior.path === current.path && prior.content === content && prior.expectedMtime === current.mtime ? prior : {
      folderId: checkout.folderId, worktreeId: checkout.worktreeId, path: current.path, content, expectedMtime: current.mtime, commandId: CommandId.make(crypto.randomUUID()),
    }
    pendingWrite.current = payload
    try {
      const result = await backend.files.write(payload)
      pendingWrite.current = null
      const latest = latestBuffers.current.find(buffer => buffer.path === payload.path)
      const updated = { path: payload.path, content: latest?.content ?? payload.content, saved: payload.content, mtime: result.mtime }
      persist(latestBuffers.current.map(buffer => buffer.path === updated.path ? updated : buffer))
      if (alive.current) setBuffers(value => value.map(buffer => buffer.path === payload.path ? updated : buffer))
    } finally { if (alive.current) setBusy(false) }
  }
  const rows = (path: string, depth = 0): ReactNode => (tree[path] ?? []).map(entry => <div key={entry.path} style={{ display: 'flex', flexDirection: 'column' }}>
    <div role="button" tabIndex={0} onClick={() => { void open(entry).catch(report) }} onKeyDown={event => { if (event.key?.toLowerCase() === 'enter') void open(entry).catch(report) }} style={{ padding: 7, paddingLeft: 10 + depth * 14, backgroundColor: selected === entry.path ? palette.selected : palette.page, cursor: 'pointer' }}><text style={{ color: entry.kind === 'directory' ? palette.muted : palette.text, fontSize: 12 }}>{`${entry.kind === 'directory' ? (expanded.has(entry.path) ? '− ' : '+ ') : ''}${entry.name}`}</text></div>
    {entry.kind === 'directory' && expanded.has(entry.path) ? rows(entry.path, depth + 1) : null}
  </div>)

  if (!active) return null
  return <div style={{ display: 'flex', flexGrow: 1, minHeight: 0, minWidth: 0 }}>
    <div style={{ width: 185, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRightWidth: 1, borderColor: palette.border }}>
      <div style={{ padding: 8 }}><Action palette={palette} onClick={() => { void Promise.all([...expanded].map(loadTree)).catch(report) }}>Refresh files</Action></div>
      <FileControls backend={backend} scope={checkout} palette={palette} onError={report} onChanged={() => { void Promise.all([...expanded].map(loadTree)).catch(report) }} path={current?.path ?? null} dirty={current ? current.content !== current.saved : false} onRemoved={path => { setBuffers(value => value.filter(buffer => buffer.path !== path)); setSelected(null) }} onMoved={(from, to) => { setBuffers(value => value.map(buffer => buffer.path === from ? { ...buffer, path: to } : buffer)); setSelected(to) }} />
      <div style={{ flexGrow: 1, minHeight: 0, overflow: 'scroll' }}>{tree[''] ? tree[''].length ? rows('') : <Empty palette={palette}>This directory is empty.</Empty> : <Empty palette={palette}>Loading files…</Empty>}</div>
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, minHeight: 0 }}>
      <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 4, padding: 8 }}>{buffers.map(buffer => <Action key={buffer.path} palette={palette} onClick={() => setSelected(buffer.path)}>{`${buffer.path.split('/').pop()}${buffer.content !== buffer.saved ? ' •' : ''}${selected === buffer.path ? ' ‹' : ''}`}</Action>)}</div>
      {current ? <>
        <div style={{ padding: 8 }}><text style={{ fontSize: 11, color: palette.muted }}>{current.path}</text></div>
        {current.conflict ? <div style={{ display: 'flex', flexDirection: 'column', padding: 8, gap: 6 }}><text style={{ color: palette.warning, fontSize: 12 }}>Recovered draft differs from disk, or disk verification is pending. Saving is blocked.</text><Action palette={palette} onClick={() => { void backend.files.read({ folderId: checkout.folderId, worktreeId: checkout.worktreeId, path: current.path }).then(live => { if (live.kind !== 'text') throw new Error('Cannot recover against a binary file'); setRecovery({ path: current.path, content: live.content, mtime: live.mtime }) }).catch(report) }}>Review recovery</Action>{recovery?.path === current.path ? <><text style={{ color: palette.muted, fontSize: 12 }}>Current disk version (draft stays in the editor below). Accepting this baseline allows the next Save to replace it.</text><code code={recovery.content} path={current.path} /><Action palette={palette} onClick={() => { const updated = { ...current, saved: recovery.content, mtime: recovery.mtime, conflict: false }; try { persist(latestBuffers.current.map(buffer => buffer.path === updated.path ? updated : buffer)); setBuffers(value => value.map(buffer => buffer.path === current.path ? updated : buffer)); setRecovery(null) } catch (error) { report(error) } }}>Use reviewed baseline</Action></> : null}</div> : null}
        {current.content !== current.saved ? <div style={{ display: 'flex', padding: 6, gap: 5 }}><Action palette={palette} onClick={() => setDiscardPath(current.path)}>Discard draft</Action>{discardPath === current.path ? <Action palette={palette} onClick={() => { try { persist(latestBuffers.current.filter(buffer => buffer.path !== current.path)); setBuffers(value => value.filter(buffer => buffer.path !== current.path)); setSelected(null); setDiscardPath(null) } catch (error) { report(error) } }}>Confirm discard draft</Action> : null}</div> : null}
        <Editor onAnnotate={onAnnotate} absolutePath={join(checkout.cwd, current.path)} editorCommands={editorCommands} key={current.path} value={current.content} savedValue={current.saved} path={current.path} palette={palette} onChange={content => { const updated = { ...current, content }; try { persist(latestBuffers.current.map(buffer => buffer.path === updated.path ? updated : buffer)) } catch (error) { report(error) }; setBuffers(value => value.map(buffer => buffer.path === current.path ? updated : buffer)) }} onSave={save} />
        <div style={{ padding: 8 }}><text style={{ fontSize: 11, color: palette.muted }}>{`${current.content === current.saved ? 'Saved' : 'Unsaved edits'} · ${current.content.split('\n').length} lines · Edits are stored privately for this environment and checkout.`}</text></div>
      </> : <Empty palette={palette}>{loading ? `Opening ${loading}…` : 'Select a file to read or edit it.'}</Empty>}
    </div>
  </div>
}

function TerminalPane({ backend, checkout, sessionId, palette, report, active }: PaneProps & { sessionId: AgentSessionId }) {
  const ownerId = PtyOwnerId.make(`opulentdevin:${sessionId}`)
  const [terminals, setTerminals] = useState<readonly PtySummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const current = terminals.find(terminal => terminal.ptyId === selected)
  const alive = useRef(true)
  const openToken = useRef<PtyOpenToken | null>(null)
  const refresh = useCallback(async () => {
    const result = await backend.terminals.list({ ownerId, includePolicy: true })
    const items = 'terminals' in result ? result.terminals : result
    if (alive.current) { setTerminals(items); setSelected(value => items.some(item => item.ptyId === value) ? value : items[0]?.ptyId ?? null) }
  }, [backend, ownerId])
  useEffect(() => { alive.current = true; void refresh().catch(report); return () => { alive.current = false } }, [refresh, report])
  const create = async () => {
    if (busy) return
    setBusy(true)
    openToken.current ??= PtyOpenToken.make(crypto.randomUUID())
    try {
      const result = await backend.terminals.open({ cwd: checkout.cwd, cols: 100, rows: 28, ownership: new PtyOwnership({ ownerId, scope: 'session', label: 'Workbench', openToken: openToken.current }) })
      openToken.current = null
      await refresh()
      if (alive.current) setSelected(result.ptyId)
    } finally { if (alive.current) setBusy(false) }
  }
  const close = async () => {
    if (!current || busy) return
    setBusy(true)
    try { await backend.terminals.close({ ptyId: current.ptyId, ownerId }); await refresh() }
    finally { if (alive.current) setBusy(false) }
  }
  if (!active) return null
  return <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, minWidth: 0 }}>
    <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 5, padding: 8 }}><Action palette={palette} disabled={busy} onClick={() => { void create().catch(report) }}>New terminal</Action><Action palette={palette} onClick={() => { void refresh().catch(report) }}>Refresh</Action>{terminals.map((terminal, index) => <Action key={terminal.ptyId} palette={palette} onClick={() => setSelected(terminal.ptyId)}>{`${index + 1} · ${terminal.label ?? 'Shell'}${selected === terminal.ptyId ? ' ‹' : ''}`}</Action>)}</div>
    <div style={{ padding: 8 }}><text style={{ color: palette.muted, fontSize: 11 }}>{current ? `${current.cwd} · ${current.status}` : checkout.cwd}</text></div>
    {current ? <><TerminalGrid backend={backend} terminal={current} ownerId={ownerId} palette={palette} onError={report} onExit={() => { void refresh().catch(report) }} /><div style={{ display: 'flex', padding: 8 }}><Action palette={palette} disabled={busy} onClick={() => { void close().catch(report) }}>Close terminal</Action></div></> : <Empty palette={palette}>No terminals in this session. Open a terminal to start the workspace shell.</Empty>}
  </div>
}

function ChangesPane({ backend, checkout, palette, report, active }: PaneProps) {
  const [status, setStatus] = useState<GitStatusSummary | null>(null)
  const [changes, setChanges] = useState<readonly GitChange[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [patch, setPatch] = useState<GitDiffResult | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    const refresh = async () => {
      const [nextStatus, nextChanges] = await Promise.all([backend.git.status({ folderId: checkout.folderId, worktreeId: checkout.worktreeId }), backend.run(backend.client['git.changes']({ folderId: checkout.folderId, worktreeId: checkout.worktreeId }))])
      if (active) { setStatus(nextStatus); setChanges(nextChanges); setLoaded(true); setSelected(value => nextChanges.some(change => change.path === value) ? value : nextChanges[0]?.path ?? null) }
    }
    void refresh().catch(report)
    const subscription = backend.subscribe(backend.client['git.workspaceChanges']({ folderId: checkout.folderId, worktreeId: checkout.worktreeId }), () => { void refresh().catch(report); setPatch(null) }, report)
    return () => { active = false; subscription.cancel() }
  }, [backend, checkout, report, revision])
  useEffect(() => {
    let active = true
    setPatch(null)
    if (selected) void backend.run(backend.client['git.diff']({ folderId: checkout.folderId, worktreeId: checkout.worktreeId, path: selected })).then(value => { if (active) setPatch(value) }).catch(report)
    return () => { active = false }
  }, [backend, checkout, selected, revision, changes, report])
  if (!active) return null
  return <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, minWidth: 0 }}>
    <div style={{ padding: 10, display: 'flex', alignItems: 'center', gap: 8 }}><text style={{ color: palette.text, fontSize: 12, flexGrow: 1 }}>{status ? `${status.branch ?? 'Detached HEAD'} · ${status.dirtyFiles} changed · ↑${status.ahead} ↓${status.behind}` : 'Repository status'}</text><Action palette={palette} onClick={() => setRevision(value => value + 1)}>Refresh changes</Action></div>
    <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 5, padding: 8 }}>{changes.map(change => <Action key={change.path} palette={palette} onClick={() => setSelected(change.path)}>{`${change.kind} · ${change.path}${change.staged ? ' · staged' : ''}${selected === change.path ? ' ‹' : ''}`}</Action>)}</div>
    <div style={{ flexGrow: 1, minHeight: 0, overflow: 'scroll', padding: 10 }}><GitControls backend={backend} scope={checkout} palette={palette} onError={report} onChanged={() => setRevision(value => value + 1)} changes={changes} />{!loaded ? <Empty palette={palette}>Loading changes…</Empty> : !changes.length ? <Empty palette={palette}>Your working tree is clean.</Empty> : !patch ? <Empty palette={palette}>Loading diff…</Empty> : <>{patch.truncated ? <text style={{ color: palette.warning, fontSize: 12 }}>The server truncated this patch.</text> : null}{patch.patch ? <diff patch={patch.patch} wordDiff theme={{ appearance: palette === palettes.light ? 'light' : 'dark' }} /> : <Empty palette={palette}>{patch.mode === 'binary' ? 'Binary file: no text diff is available.' : 'No text patch is available for this path.'}</Empty>}</>}</div>
  </div>
}
