import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ComposerInput } from './zuse-runtime/packages/contracts/src/composer'
import { AgentSessionId, EnvironmentId, FolderId } from './zuse-runtime/packages/contracts/src/ids'
import { ComposerDraftController, DraftStore, MAX_DRAFT_BYTES, draftMatchesCommand, type DraftOwner } from './drafts'
import { prepareMessage, prepareChat } from './outbox'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const owner: DraftOwner = { environmentId: EnvironmentId.make('local-a'), workspaceId: FolderId.make('project-a'), sessionId: AgentSessionId.make('session-a') }
const rich = (text = 'Unsent') => ComposerInput.make({ text, attachments: [{ id: 'a-1', mimeType: 'image/png', originalName: 'image.png' }], fileRefs: [{ absPath: '/project/file.ts', relPath: 'file.ts', kind: 'file' }], skillRefs: [{ name: 'review', scope: 'project', args: 'safe', providerId: 'codex' }], annotations: [{ id: 'note', relPath: 'file.ts', absPath: '/project/file.ts', startLine: 1, endLine: 2, comment: 'Keep this' }], asGoal: true })
function setup() { const root = mkdtempSync(join(tmpdir(), 'native-drafts-')); roots.push(root); return new DraftStore(join(root, 'drafts')) }
describe('private native composer drafts', () => {
  it('matches only the complete submitted message input and session', () => {
    const controller = new ComposerDraftController(setup(), owner)
    controller.setInput(rich())
    const snapshot = controller.snapshot()
    expect(draftMatchesCommand(snapshot, prepareMessage({ sessionId: owner.sessionId!, input: rich() }))).toBe(true)
    expect(draftMatchesCommand(snapshot, prepareMessage({ sessionId: AgentSessionId.make('other'), input: rich() }))).toBe(false)
    expect(draftMatchesCommand(snapshot, prepareMessage({ sessionId: owner.sessionId!, text: 'Unsent', asGoal: true }))).toBe(false)
    for (const field of ['attachments', 'fileRefs', 'skillRefs', 'annotations'] as const) {
      expect(draftMatchesCommand(snapshot, prepareMessage({ sessionId: owner.sessionId!, input: ComposerInput.make({ ...rich(), [field]: [] }) }))).toBe(false)
    }
    expect(draftMatchesCommand(snapshot, prepareMessage({ sessionId: owner.sessionId!, input: ComposerInput.make({ ...rich(), asGoal: false }) }))).toBe(false)
  })
  it('normalises plain message text without discarding goal mode', () => {
    const controller = new ComposerDraftController(setup(), owner)
    controller.setInput(ComposerInput.make({ text: 'Plain', attachments: [], fileRefs: [], skillRefs: [], annotations: [], asGoal: true }))
    expect(draftMatchesCommand(controller.snapshot(), prepareMessage({ sessionId: owner.sessionId!, text: 'Plain', asGoal: true }))).toBe(true)
    expect(draftMatchesCommand(controller.snapshot(), prepareMessage({ sessionId: owner.sessionId!, text: 'Plain' }))).toBe(false)
  })
  it('matches chat startup only to its project landing draft', () => {
    const controller = new ComposerDraftController(setup(), { ...owner, sessionId: null })
    controller.setInput(rich())
    const command = prepareChat({ projectId: owner.workspaceId!, providerId: 'claude', model: 'test', startupInput: rich(), initialPrompt: 'Unsent' })
    expect(draftMatchesCommand(controller.snapshot(), command)).toBe(true)
    expect(draftMatchesCommand({ ...controller.snapshot(), owner }, command)).toBe(false)
    expect(draftMatchesCommand({ ...controller.snapshot(), owner: { ...owner, sessionId: null, workspaceId: FolderId.make('other') } }, command)).toBe(false)
    expect(draftMatchesCommand(controller.snapshot(), prepareChat({ projectId: owner.workspaceId!, providerId: 'claude', model: 'test', initialPrompt: 'Unsent' }))).toBe(false)
  })
  it('round trips the entire canonical rich input across restart with private modes', () => { const store = setup(); const controller = new ComposerDraftController(store, owner); controller.setInput(rich()); expect(controller.error).toBeNull(); const restored = new ComposerDraftController(new DraftStore(store.directory), owner); expect(restored.input).toEqual(rich()); expect(statSync(store.path(owner)).mode & 0o777).toBe(0o600); expect(statSync(store.directory).mode & 0o777).toBe(0o700) })
  it('separates every environment workspace and session including landing', () => { const store = setup(); new ComposerDraftController(store, owner).setInput(rich()); for (const other of [{ ...owner, environmentId: EnvironmentId.make('remote') }, { ...owner, workspaceId: FolderId.make('other') }, { ...owner, sessionId: AgentSessionId.make('other') }, { ...owner, sessionId: null }]) expect(new ComposerDraftController(store, other).input.attachments).toEqual([]) })
  it('clears only the exact sent revision and generation', () => { const store = setup(); const controller = new ComposerDraftController(store, owner); controller.setInput(rich()); const sent = controller.snapshot(); controller.setInput(previous => ComposerInput.make({ ...previous, text: 'New text' })); expect(controller.clearExact(sent)).toBe(false); const latest = controller.snapshot(); controller.activate(); expect(controller.clearExact(latest)).toBe(false); expect(controller.clearExact(controller.snapshot())).toBe(true); expect(new ComposerDraftController(store, owner).input.text).toBe('') })
  it('preserves a newer writer when an old acknowledgement tries to clear', () => { const store = setup(); const a = new ComposerDraftController(store, owner); a.setInput(rich()); const sent = a.snapshot(); const b = new ComposerDraftController(store, owner); b.setInput(rich('Other window')); expect(a.clearExact(sent)).toBe(false); expect(new ComposerDraftController(store, owner).input.text).toBe('Other window') })
  it('preserves corruption and retains newly typed input in memory', () => { const store = setup(); store.read(owner); writeFileSync(store.path(owner), '{bad', { mode: 0o600 }); const controller = new ComposerDraftController(store, owner); expect(controller.error).toContain('preserved'); controller.setInput(rich('Do not lose')); expect(controller.input.text).toBe('Do not lose'); expect(readFileSync(store.path(owner), 'utf8')).toBe('{bad'); expect(controller.clearExact(controller.snapshot())).toBe(false) })
  it('refuses symlink files and directory ancestors without touching targets', () => { const store = setup(); store.read(owner); const target = join(roots.at(-1)!, 'target'); writeFileSync(target, 'private', { mode: 0o600 }); symlinkSync(target, store.path(owner)); expect(() => store.read(owner)).toThrow(); expect(readFileSync(target, 'utf8')).toBe('private'); const link = join(roots.at(-1)!, 'link'); symlinkSync(store.directory, link); expect(() => new DraftStore(join(link, 'nested')).read(owner)).toThrow('real directories') })
  it('refuses nonprivate files oversized inputs and stale locks', () => { const store = setup(); const controller = new ComposerDraftController(store, owner); controller.setInput(rich()); const before = readFileSync(store.path(owner), 'utf8'); expect(() => store.save(owner, controller.snapshot().revision, rich('x'.repeat(MAX_DRAFT_BYTES)))).toThrow('limit'); expect(readFileSync(store.path(owner), 'utf8')).toBe(before); writeFileSync(store.path(owner) + '.lock', '', { mode: 0o600 }); expect(() => store.save(owner, controller.snapshot().revision, rich())).toThrow('locked'); chmodSync(store.path(owner), 0o644); expect(() => store.read(owner)).toThrow() })
})
