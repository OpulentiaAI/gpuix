import { useEffect, useRef } from 'react'
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import type { Backend } from './backend'
import type { FolderId } from './zuse-runtime/packages/contracts/src/ids'
import type { SessionStatus, SessionSummaryChange } from './zuse-runtime/packages/contracts/src/session'
import { dataDirectory } from './preferences'
import { sendNativeNotification } from './advanced-host'

export type CompletionNotice = { title: string; body: string }
export class CompletionTracker {
  private statuses = new Map<string, SessionStatus>()
  private hydrated = false
  accept(event: SessionSummaryChange): CompletionNotice | null {
    if (event._tag === 'snapshot') {
      this.statuses = new Map(event.sessions.map(session => [session.id, session.status]))
      this.hydrated = true
      return null
    }
    if (event._tag === 'remove') { this.statuses.delete(event.sessionId); return null }
    const previous = this.statuses.get(event.session.id)
    this.statuses.set(event.session.id, event.session.status)
    if (!this.hydrated || previous !== 'running' || !['idle', 'closed', 'error'].includes(event.session.status)) return null
    return { title: 'OpulentDevin', body: event.session.status === 'error' ? 'An agent run ended with an error. Open the app for details.' : 'An agent run has ended. Open the app to review its result.' }
  }
}
export function loadCompletionNotifications(directory = dataDirectory): boolean {
  try { const value: unknown = JSON.parse(readFileSync(join(directory, 'notifications.json'), 'utf8')); return typeof value === 'object' && value !== null && 'enabled' in value && value.enabled === true } catch { return false }
}
export function saveCompletionNotifications(enabled: boolean, directory = dataDirectory): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, 'notifications.json')
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify({ enabled }), { mode: 0o600, flag: 'wx' })
  renameSync(temporary, path); chmodSync(path, 0o600)
}
export function useCompletionNotifications({ backend, projectId, enabled, onError }: { backend: Backend | null; projectId: FolderId | null; enabled: boolean; onError: (error: string) => void }) {
  const report = useRef(onError); report.current = onError
  useEffect(() => {
    if (!backend || !projectId || !enabled) return
    let active = true
    const tracker = new CompletionTracker()
    const subscription = backend.subscribe(backend.sessions.changes({ projectId }), event => {
      if (!active) return
      const notice = tracker.accept(event)
      if (notice) void sendNativeNotification(notice.title, notice.body).catch(() => { if (active) report.current('Desktop notification delivery failed; no notification content was retained.') })
    }, () => { if (active) report.current('Completion notifications disconnected; reconnect the backend to resume.') })
    return () => { active = false; subscription.cancel() }
  }, [backend, projectId, enabled])
}
