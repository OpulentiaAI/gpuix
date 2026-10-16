import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, statSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkbenchBufferStore, restoreFileBuffer } from './workbench-buffer-store'
import { EnvironmentId, FolderId, WorktreeId } from './zuse-runtime/packages/contracts/src/ids'
const roots: string[] = []
const scope = { environmentId: EnvironmentId.make('env-a'), folderId: FolderId.make('folder-a'), worktreeId: null }
const draft = { path: 'src/app.ts', content: 'dirty', saved: 'original', mtime: '123' }
function setup() { const root = mkdtempSync(join(tmpdir(), 'workbench-store-')); roots.push(root); return { root, store: new WorkbenchBufferStore(join(root, 'buffers')) } }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
describe('durable workbench buffers', () => {
  it('survives new instances with mtime baseline and private permissions', () => { const { store } = setup(); store.save(scope, 'empty', [draft]); expect(new WorkbenchBufferStore(store.directory).read(scope).buffers[0]).toEqual(draft); expect(statSync(store.path(scope)).mode & 0o777).toBe(0o600); expect(statSync(store.directory).mode & 0o777).toBe(0o700) })
  it('isolates environments folders and worktrees', () => { const { store } = setup(); store.save(scope, 'empty', [draft]); expect(store.read({ ...scope, environmentId: EnvironmentId.make('env-b') }).buffers).toEqual([]); expect(store.read({ ...scope, folderId: FolderId.make('folder-b') }).buffers).toEqual([]); expect(store.read({ ...scope, worktreeId: WorktreeId.make('tree-b') }).buffers).toEqual([]) })
  it('removes clean drafts and fences stale writers', () => { const { store } = setup(); const saved = store.save(scope, 'empty', [draft]); expect(() => store.save(scope, 'empty', [])).toThrow('another window'); store.save(scope, saved.revision, [{ ...draft, content: draft.saved }]); expect(store.read(scope).buffers).toEqual([]) })
  it('refuses corrupt data without deleting it', () => { const { store } = setup(); store.save(scope, 'empty', [draft]); writeFileSync(store.path(scope), '{'); expect(() => store.read(scope)).toThrow(); expect(statSync(store.path(scope)).size).toBe(1) })
  it('refuses symlink directories and files', () => { const { root, store } = setup(); const target = join(root, 'target'); mkdirSync(target, { mode: 0o700 }); symlinkSync(target, store.directory); expect(() => store.save(scope, 'empty', [draft])).toThrow(); const other = new WorkbenchBufferStore(join(root, 'safe')); other.save(scope, 'empty', [draft]); rmSync(other.path(scope)); symlinkSync(join(root, 'target.json'), other.path(scope)); expect(() => other.read(scope)).toThrow() })
  it('preserves dirty content and blocks mismatched live baselines', () => { expect(restoreFileBuffer(draft, { content: 'original', mtime: '123' }).conflict).toBe(false); expect(restoreFileBuffer(draft, { content: 'external', mtime: '124' })).toEqual({ ...draft, conflict: true }) })
})
