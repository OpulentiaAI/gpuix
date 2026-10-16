import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CompletionTracker, loadCompletionNotifications, saveCompletionNotifications } from './completion-notifications'
import { Session, type SessionStatus, type SessionSummaryChange } from './zuse-runtime/packages/contracts/src/session'
import { AgentSessionId, FolderId, ChatId } from './zuse-runtime/packages/contracts/src/ids'

function row(status: SessionStatus): Session {
  return { id: AgentSessionId.make('s'), title: 'PRIVATE_TITLE', status, projectId: FolderId.make('p'), chatId: ChatId.make('c') } as Session
}
const snapshot = (status: SessionStatus): SessionSummaryChange => ({ _tag: 'snapshot', cursor: 1, sessions: [row(status)] })
const change = (status: SessionStatus): SessionSummaryChange => ({ _tag: 'change', sequence: 2, session: row(status) })
describe('completion notification policy', () => {
  it('does not alert on initial/reconnect snapshots or unknown sessions', () => {
    const tracker = new CompletionTracker()
    expect(tracker.accept(change('closed'))).toBeNull()
    expect(tracker.accept(snapshot('closed'))).toBeNull()
    expect(tracker.accept(snapshot('running'))).toBeNull()
    expect(tracker.accept(snapshot('idle'))).toBeNull()
    expect(tracker.accept(change('idle'))).toBeNull()
  })
  it('alerts only on observed running-to-ended transitions without private content', () => {
    const tracker = new CompletionTracker()
    tracker.accept(snapshot('running'))
    const result = tracker.accept(change('idle'))
    expect(result?.body).toContain('run has ended')
    expect(JSON.stringify(result)).not.toContain('PRIVATE_TITLE')
    expect(tracker.accept(change('idle'))).toBeNull()
    tracker.accept(change('running'))
    expect(tracker.accept(change('error'))?.body).toContain('error')
  })
  it('defaults disabled and persists an explicit private opt-in', () => {
    const directory = mkdtempSync(join(tmpdir(), 'completion-opt-in-'))
    try {
      expect(loadCompletionNotifications(directory)).toBe(false)
      saveCompletionNotifications(true, directory)
      expect(loadCompletionNotifications(directory)).toBe(true)
      expect(statSync(join(directory, 'notifications.json')).mode & 0o777).toBe(0o600)
      saveCompletionNotifications(false, directory)
      expect(loadCompletionNotifications(directory)).toBe(false)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
