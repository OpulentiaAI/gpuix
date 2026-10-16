import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureQueueDraft, type QueueDraftOwner } from './queue'
import { ComposerDraftController, DraftStore, type DraftOwner } from './drafts'
import { AgentSessionId, EnvironmentId, FolderId } from './zuse-runtime/packages/contracts/src/ids'
import { ComposerInput } from './zuse-runtime/packages/contracts/src/composer'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const owner: DraftOwner = { environmentId: EnvironmentId.make('local'), workspaceId: FolderId.make('workspace'), sessionId: AgentSessionId.make('session') }
const session = { id: owner.sessionId!, projectId: owner.workspaceId! }
const input = (text: string) => ComposerInput.make({ text, attachments: [], fileRefs: [], skillRefs: [], annotations: [] })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'queue-draft-')); roots.push(root)
  const store = new DraftStore(join(root, 'drafts'))
  const controller = new ComposerDraftController(store, owner)
  controller.setInput(input('same'))
  const draft: QueueDraftOwner = { snapshot: () => controller.snapshot(), clearExact: snapshot => controller.clearExact(snapshot) }
  return { controller, draft, store }
}

describe('queue composer acknowledgement ownership', () => {
  it('clears the exact captured draft once after acknowledgement', () => {
    const { controller, draft } = fixture()
    const captured = captureQueueDraft(draft, session)
    expect(captured.input.text).toBe('same')
    expect(captured.complete()).toBe(true)
    controller.setInput(input('same'))
    expect(captured.complete()).toBe(false)
    expect(controller.input.text).toBe('same')
  })
  it('does not clear same-content ABA after a delayed enqueue', async () => {
    const { controller, draft } = fixture()
    const captured = captureQueueDraft(draft, session)
    let acknowledge: () => void = () => {}
    const pending = new Promise<void>(resolve => { acknowledge = resolve }).then(captured.complete)
    controller.setInput(input('newer'))
    controller.setInput(input('same'))
    acknowledge()
    expect(await pending).toBe(false)
    expect(controller.input.text).toBe('same')
  })
  it('does not clear a reactivated generation even with identical input', () => {
    const { controller, draft } = fixture()
    const captured = captureQueueDraft(draft, session)
    controller.activate()
    expect(captured.complete()).toBe(false)
    expect(controller.input.text).toBe('same')
  })
  it('captures the original completion closure instead of a later owner callback', () => {
    const { controller, draft, store } = fixture()
    const captured = captureQueueDraft(draft, session)
    const other = new ComposerDraftController(store, { ...owner, sessionId: AgentSessionId.make('other') })
    other.setInput(input('same'))
    draft.clearExact = snapshot => other.clearExact(snapshot)
    expect(captured.complete()).toBe(true)
    expect(controller.input.text).toBe('')
    expect(other.input.text).toBe('same')
  })
  it('preserves an owner that is no longer mounted when completion runs', () => {
    const { controller } = fixture()
    let mounted = true
    const captured = captureQueueDraft({ snapshot: () => controller.snapshot(), clearExact: snapshot => mounted && controller.clearExact(snapshot) }, session)
    mounted = false
    expect(captured.complete()).toBe(false)
    expect(controller.input.text).toBe('same')
  })
  it('rejects session and workspace mismatches before enqueue payload capture', () => {
    const { draft } = fixture()
    expect(() => captureQueueDraft(draft, { ...session, id: AgentSessionId.make('different') })).toThrow('owner')
    expect(() => captureQueueDraft(draft, { ...session, projectId: FolderId.make('different') })).toThrow('owner')
  })
})
