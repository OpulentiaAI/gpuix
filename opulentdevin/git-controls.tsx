import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Backend } from './backend'
import type { Palette } from './theme'
import type { FolderId, WorktreeId } from './zuse-runtime/packages/contracts/src/ids'
import type { GitBranchInfo, GitChange, GitPrDetails } from './zuse-runtime/packages/contracts/src/git'
import type { Worktree } from './zuse-runtime/packages/contracts/src/worktree'

type Scope = { folderId: FolderId; worktreeId: WorktreeId | null }
type Props = { backend: Backend; scope: Scope; palette: Palette; onChanged: () => void; onError: (error: unknown) => void }
type Confirmation = { label: string; run: () => Promise<void> }

function Button({ id, label, disabled = false, click, palette }: { id: string; label: string; disabled?: boolean; click: () => void; palette: Palette }) {
  return <div testId={id} role="button" tabIndex={disabled ? -1 : 0} onClick={() => { if (!disabled) click() }} onKeyDown={event => { if (!disabled && event.key?.toLowerCase() === 'enter') click() }} style={{ display: 'flex', flexDirection: 'row', flexShrink: 0, padding: 6, borderRadius: 5, opacity: disabled ? 0.45 : 1, backgroundColor: palette.subtle, cursor: disabled ? 'default' : 'pointer' }}><text style={{ fontSize: 12, color: palette.text, whiteSpace: 'nowrap' }}>{label}</text></div>
}
function Row({ children }: { children: ReactNode }) { return <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}>{children}</div> }
function useConfirmation(onChanged: () => void, onError: (error: unknown) => void) {
  const [pending, setPending] = useState<Confirmation | null>(null)
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const confirm = async () => {
    if (!pending || lock.current) return
    lock.current = true; setBusy(true)
    try { await pending.run(); setPending(null); onChanged() } catch (error) { onError(error); setPending(null) }
    finally { lock.current = false; setBusy(false) }
  }
  return { pending, setPending, busy, confirm }
}

export function GitControls({ backend, scope, palette, onChanged, onError, changes }: Props & { changes: readonly GitChange[] }) {
  const [open, setOpen] = useState(false)
  const [chosen, setChosen] = useState<readonly string[]>([])
  const [message, setMessage] = useState('')
  const [branch, setBranch] = useState('')
  const [branches, setBranches] = useState<readonly GitBranchInfo[]>([])
  const [worktrees, setWorktrees] = useState<readonly Worktree[]>([])
  const [pr, setPr] = useState<GitPrDetails | null>(null)
  const [reviewPath, setReviewPath] = useState('')
  const [reviewLine, setReviewLine] = useState('1')
  const [reviewBody, setReviewBody] = useState('')
  const [receipt, setReceipt] = useState('')
  const { pending, setPending, busy, confirm } = useConfirmation(onChanged, onError)
  const field = { minWidth: 80, flexGrow: 1, padding: 6, color: palette.text, backgroundColor: palette.wash, fontSize: 12 }
  useEffect(() => { setChosen(paths => paths.filter(path => changes.some(change => change.path === path))) }, [changes])
  const loadLocal = async () => {
    const [nextBranches, nextWorktrees] = await Promise.all([backend.run(backend.client['git.branches'](scope)), backend.run(backend.client['worktree.list']({ projectId: scope.folderId }))])
    setBranches(nextBranches); setWorktrees(nextWorktrees)
  }
  const selected = chosen.filter(path => changes.some(change => change.path === path))
  const requestCommit = () => {
    if (!selected.length || !message.trim()) return
    const paths = [...selected]; const body = message.trim()
    setPending({ label: `Stage and commit only these paths: ${paths.join(', ')}. Message: ${body}`, run: async () => { const result = await backend.run(backend.client['git.commit']({ ...scope, paths, message: body })); setReceipt(`Committed ${result.sha}`); setMessage(''); setChosen([]) } })
  }
  const requestBranch = (create: boolean) => {
    const name = branch.trim(); if (!name) return
    setPending({ label: `${create ? 'Create from HEAD and switch to' : 'Switch checkout to'} branch ${name}. Save editor buffers first; unsaved edits are not written.`, run: async () => { const result = await backend.run(backend.client['git.switchBranch']({ ...scope, branch: name, ...(create ? { createFrom: 'HEAD' as const } : {}) })); setReceipt(`Branch: ${result.branch ?? 'detached'}`); await loadLocal() } })
  }
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, borderBottomWidth: 1, borderColor: palette.border, flexShrink: 0 }}>
    <Row><Button id="git-controls-toggle" label={open ? 'Hide Git actions' : 'Git actions'} click={() => setOpen(value => !value)} palette={palette} />{receipt && <text style={{ color: palette.success, fontSize: 11 }}>{receipt}</text>}</Row>
    {open && <>
      <text style={{ color: palette.muted, fontSize: 11 }}>Select paths for a local commit. Separate stage/unstage is unavailable in this Zuse contract; this does not pretend to change the index.</text>
      <Row>{changes.map(change => <Button key={change.path} id={`git-select-${change.path}`} label={`${chosen.includes(change.path) ? '[x]' : '[ ]'} ${change.path}${change.staged ? ' (index)' : ''}`} click={() => setChosen(paths => paths.includes(change.path) ? paths.filter(path => path !== change.path) : [...paths, change.path])} palette={palette} />)}</Row>
      <Row><input testId="git-commit-message" aria-label="Commit message" value={message} onChange={event => setMessage(event.value ?? '')} placeholder="Commit message" style={field} /><Button id="git-commit" label="Review commit" disabled={busy || !selected.length || !message.trim()} click={requestCommit} palette={palette} /></Row>
      <Row><Button id="git-load-local" label="Load branches and worktrees" click={() => { void loadLocal().catch(onError) }} palette={palette} /><input testId="git-branch" aria-label="Branch name" value={branch} onChange={event => setBranch(event.value ?? '')} placeholder="Branch name" style={field} /><Button id="git-switch" label="Switch branch" disabled={busy || !branch.trim()} click={() => requestBranch(false)} palette={palette} /><Button id="git-create-branch" label="New branch from HEAD" disabled={busy || !branch.trim()} click={() => requestBranch(true)} palette={palette} /></Row>
      <Row>{branches.map(item => <Button key={`${item.kind}:${item.name}`} id={`git-branch-${item.name}`} label={`${item.current ? 'Current: ' : ''}${item.name}`} click={() => setBranch(item.name)} palette={palette} />)}</Row>
      <Button id="git-worktree-create" label="Create worktree from branch" disabled={busy || !branch.trim()} click={() => { const name = branch.trim(); setPending({ label: `Create a local worktree from existing branch ${name}. Zuse may run this project's configured setup scripts. No remote provisioning is requested.`, run: async () => { const value = await backend.run(backend.client['worktree.create']({ projectId: scope.folderId, source: { _tag: 'branch', branch: name, remote: null } })); setReceipt(`Created worktree ${value.path}`); await loadLocal() } }) }} palette={palette} />
      {worktrees.map(item => <Row key={item.id}><text style={{ color: palette.muted, fontSize: 11 }}>{`${item.branch} · ${item.path} · setup ${item.setupStatus}`}</text><Button id={`git-worktree-remove-${item.id}`} label="Remove worktree" disabled={busy || item.id === scope.worktreeId} click={() => setPending({ label: `Remove checkout ${item.path}. Zuse checkpoints dirty state first. This may affect sessions using it; removal cannot be undone from this screen.`, run: async () => { await backend.run(backend.client['worktree.remove']({ worktreeId: item.id })); setReceipt(`Removed ${item.path}`); await loadLocal() } })} palette={palette} /></Row>)}
      <Button id="git-pr-load" label="Load PR checks and reviews" click={() => { void backend.run(backend.client['git.prDetails'](scope)).then(setPr).catch(onError) }} palette={palette} />
      {pr && <><text style={{ color: palette.text, fontSize: 12 }}>{`${pr.title || 'No pull request'} · ${pr.state} · ${pr.checks}`}</text><text style={{ color: palette.muted, fontSize: 11 }}>{pr.url ?? 'No remote PR URL'}</text>{pr.checkRuns.map((check, index) => <text key={`${check.name}:${index}`} style={{ color: palette.muted, fontSize: 11 }}>{`${check.name}: ${check.conclusion ?? check.status}`}</text>)}{pr.reviews.map((review, index) => <text key={index} style={{ color: palette.muted, fontSize: 11 }}>{`${review.author} · ${review.state}: ${review.body}`}</text>)}{pr.comments.map((comment, index) => <text key={index} style={{ color: palette.muted, fontSize: 11 }}>{`${comment.author}: ${comment.body}`}</text>)}
        {pr.number !== null && <><Row><input testId="git-review-path" value={reviewPath} onChange={event => setReviewPath(event.value ?? '')} placeholder="Changed file path" style={field} /><input testId="git-review-line" value={reviewLine} onChange={event => setReviewLine(event.value ?? '')} placeholder="Added-side line" style={{ ...field, width: 80 }} /></Row><textarea testId="git-review-body" value={reviewBody} onChange={event => setReviewBody(event.value ?? '')} placeholder="Inline review comment (remote write)" minRows={2} style={field} /><Button id="git-review-submit" label="Review remote comment" disabled={busy || !reviewBody.trim() || !reviewPath.trim() || !Number.isInteger(Number(reviewLine)) || Number(reviewLine) < 1} click={() => { const path = reviewPath.trim(); const line = Number(reviewLine); const body = reviewBody.trim(); setPending({ label: `Post a public inline comment on ${pr.url ?? `PR ${pr.number}`} at ${path}:${line} (additions): ${body}`, run: async () => { const fresh = await backend.run(backend.client['git.prDetails'](scope)); if (fresh.number !== pr.number || fresh.headSha !== pr.headSha) throw new Error('The pull request changed; reload it and review the comment again.'); const result = await backend.run(backend.client['git.createReviewComment']({ ...scope, path, line, side: 'additions', body })); setReceipt(result.url ?? 'Review comment posted'); setReviewBody('') } }) }} palette={palette} /></>}
      </>}
      <text style={{ color: palette.muted, fontSize: 11 }}>No automatic push, merge, approval, provisioning or inference. PR checks/reviews load on demand.</text>
    </>}
    {pending && <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, backgroundColor: palette.warningBg }}><text style={{ color: palette.warning, fontSize: 12 }}>{pending.label}</text><Row><Button id="git-confirm" label={busy ? 'Working…' : 'Confirm action'} disabled={busy} click={() => { void confirm() }} palette={palette} /><Button id="git-cancel" label="Cancel" disabled={busy} click={() => setPending(null)} palette={palette} /></Row></div>}
  </div>
}

export function FileControls({ backend, scope, palette, onChanged, onError, path, dirty, onRemoved, onMoved }: Props & { path: string | null; dirty: boolean; onRemoved: (path: string) => void; onMoved: (from: string, to: string) => void }) {
  const [target, setTarget] = useState('')
  const { pending, setPending, busy, confirm } = useConfirmation(onChanged, onError)
  useEffect(() => { setPending(null) }, [path, dirty])
  const valid = target.trim().length > 0 && !target.startsWith('/') && !target.split(/[\\/]/).includes('..')
  return <div style={{ display: 'flex', flexDirection: 'column', padding: 8, gap: 5 }}>
    <input testId="file-operation-path" aria-label="Project relative file path" value={target} onChange={event => setTarget(event.value ?? '')} placeholder="Project-relative path" style={{ padding: 6, color: palette.text, backgroundColor: palette.wash, fontSize: 12 }} />
    <Row><Button id="file-create" label="Create file" disabled={busy || !valid} click={() => { const next = target.trim(); setPending({ label: `Create empty file ${next}? Existing files will not be overwritten.`, run: async () => { await backend.files.create({ ...scope, path: next }); setTarget('') } }) }} palette={palette} /><Button id="file-rename" label="Rename selected" disabled={busy || !path || !valid || dirty} click={() => { if (!path) return; const from = path; const to = target.trim(); setPending({ label: `Move ${from} to ${to}? Existing destinations will not be overwritten.`, run: async () => { await backend.files.move({ ...scope, fromPath: from, toPath: to }); onMoved(from, to); setTarget('') } }) }} palette={palette} /><Button id="file-delete" label="Delete selected" disabled={busy || !path || dirty} click={() => { if (!path) return; const selected = path; setPending({ label: `Permanently delete file ${selected}? There is no undo in this screen.`, run: async () => { await backend.files.remove({ ...scope, path: selected }); onRemoved(selected) } }) }} palette={palette} /></Row>
    {dirty && <text style={{ color: palette.warning, fontSize: 11 }}>Save unsaved edits before renaming or deleting.</text>}
    {pending && <><text style={{ color: palette.warning, fontSize: 11 }}>{pending.label}</text><Row><Button id="file-confirm" label={busy ? 'Working…' : 'Confirm file action'} disabled={busy} click={() => { void confirm() }} palette={palette} /><Button id="file-cancel" label="Cancel" disabled={busy} click={() => setPending(null)} palette={palette} /></Row></>}
  </div>
}
