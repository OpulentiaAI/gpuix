import { useCallback, useEffect, useRef, useState } from 'react'
import { Effect, Stream } from 'effect'
import { connectBackend, type Backend, type BackendOptions } from './backend'
import { createConnectionSupervisor, type ConnectionSnapshot } from './zuse-runtime/packages/client-runtime/src/supervisor'
import { makeSessionTimelineResourceDriver } from './zuse-runtime/packages/client-runtime/src/session-timeline-driver'
import { emptyResourceView, type ResourceView } from './zuse-runtime/packages/client-runtime/src/resource-state'
import { EnvironmentId } from './zuse-runtime/packages/contracts/src/ids'
import { emptySessionTimelineState, type SessionTimelineState } from './zuse-runtime/packages/client-runtime/src/session-timeline'
import type { SessionId, SessionTimelineProjection } from './zuse-runtime/packages/contracts/src/session'

export function connectionEnvironmentId(options: BackendOptions): EnvironmentId {
  if (options.environmentId?.trim()) return EnvironmentId.make(options.environmentId.trim())
  if (options.cloudWorkspaceId?.trim()) return EnvironmentId.make(`cloud:${options.cloudWorkspaceId.trim()}`)
  const url = new URL(options.wsBaseUrl || `ws://${options.host}:${options.port}`)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Remote connections require an explicit stable environmentId or cloudWorkspaceId for command isolation.')
  return EnvironmentId.make(`local:${url.hostname}:${url.port || (url.protocol === 'wss:' ? '443' : '80')}`)
}

export function createBackendConnection(initialBackend: Backend | null, options: BackendOptions) {
  const environmentId = connectionEnvironmentId(options)
  let seed = initialBackend
  const supervisor = createConnectionSupervisor<BackendOptions, Backend>({
    keyOf: () => environmentId,
    createClient: async endpoint => {
      const backend = seed ?? await connectBackend(endpoint)
      seed = null
      return { client: backend, dispose: () => backend.dispose() }
    },
    validateClient: async backend => { await backend.run(backend.client['ping.ping']({}).pipe(Effect.timeout(5000))) },
    isOnline: () => true,
    schedule: (delay, task) => { const timer = setTimeout(task, delay); return () => clearTimeout(timer) },
    maxAutomaticAttempts: 5,
  })
  const entry = supervisor.get(options)
  let disposed = false
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let heartbeatBusy = false
  const listeners = new Set<(backend: Backend | null, snapshot: ConnectionSnapshot) => void>()
  let current: Backend | null = null
  const notify = (backend: Backend | null, snapshot: ConnectionSnapshot) => { current = backend; for (const listener of listeners) listener(backend, snapshot) }
  const unsubscribe = entry.subscribe(snapshot => {
    if (heartbeat) clearInterval(heartbeat)
    if (snapshot.status !== 'connected') { notify(null, snapshot); return }
    void Effect.runPromise(entry.getClient()).then(backend => {
      if (disposed || entry.snapshot().generation !== snapshot.generation || entry.snapshot().status !== 'connected') return
      notify(backend, snapshot)
      heartbeat = setInterval(() => {
        if (heartbeatBusy || disposed) return
        heartbeatBusy = true
        void backend.run(backend.client['ping.ping']({}).pipe(Effect.timeout(5000))).catch(error => entry.reportFailure(error, snapshot.generation)).finally(() => { heartbeatBusy = false })
      }, 10000)
    }).catch(error => entry.reportFailure(error, snapshot.generation))
  })
  void Effect.runPromise(entry.getClient()).catch(() => undefined)
  return {
    environmentId,
    snapshot: () => entry.snapshot(),
    subscribe: (listener: (backend: Backend | null, snapshot: ConnectionSnapshot) => void) => { listeners.add(listener); listener(current, entry.snapshot()); return () => { listeners.delete(listener) } },
    reconnect: () => entry.retryNow(),
    reportFailure: (error: unknown) => { entry.reportFailure(error, entry.snapshot().generation) },
    dispose: async () => { disposed = true; if (heartbeat) clearInterval(heartbeat); unsubscribe(); listeners.clear(); await supervisor.dispose() },
  }
}

export function useBackendConnection(initialBackend: Backend | null, onError: (message: string) => void, options: BackendOptions) {
  const owner = useRef<ReturnType<typeof createBackendConnection> | null>(null)
  const onErrorRef = useRef(onError); onErrorRef.current = onError
  const [backend, setBackend] = useState<Backend | null>(null)
  const [snapshot, setSnapshot] = useState<ConnectionSnapshot>({ key: '', status: 'connecting', generation: 0, attempt: 0, error: null })
  const environmentId = connectionEnvironmentId(options)
  useEffect(() => {
    const connection = createBackendConnection(initialBackend, options); owner.current = connection
    const unsubscribe = connection.subscribe((next, status) => { setBackend(next); setSnapshot(status); if (status.error) onErrorRef.current(status.error) })
    return () => { unsubscribe(); owner.current = null; void connection.dispose() }
  }, [initialBackend, options.host, options.port, options.wsBaseUrl, options.token, options.environmentId, options.cloudWorkspaceId])
  const reconnect = useCallback(() => owner.current?.reconnect(), [])
  const reportFailure = useCallback((error: unknown) => owner.current?.reportFailure(error), [])
  return { backend, status: snapshot.status, snapshot, generation: snapshot.generation, environmentId, reconnect, reportFailure }
}

export function useTimeline(backend: Backend | null, sessionId: SessionId | null, environmentId: EnvironmentId, onError: (message: string) => void, reportFailure?: (error: unknown) => void): SessionTimelineState {
  const [view, setView] = useState<ResourceView<SessionTimelineProjection>>(() => emptyResourceView())
  const cell = useRef({ key: '', view: emptyResourceView<SessionTimelineProjection>(), generation: 0 })
  const callbacks = useRef({ onError, reportFailure }); callbacks.current = { onError, reportFailure }
  useEffect(() => {
    const key = JSON.stringify([environmentId, sessionId])
    if (cell.current.key !== key) cell.current = { key, view: emptyResourceView(), generation: cell.current.generation + 1 }
    if (!backend || !sessionId) { cell.current.view = { ...cell.current.view, connection: 'offline', sync: cell.current.view.data ? 'stale' : 'empty' }; setView(cell.current.view); return }
    const generation = ++cell.current.generation
    let active = true
    cell.current.view = { ...cell.current.view, connection: 'connected', sync: 'synchronizing', generation }
    setView(cell.current.view)
    const driver = makeSessionTimelineResourceDriver({ reportFailure: (_environment, _generation, cause) => { if (active) { callbacks.current.onError(String(cause)); callbacks.current.reportFailure?.(cause) } } })
    driver.start({
      key: { kind: 'session-timeline', ref: { environmentId, sessionId } }, client: backend.client, generation,
      data: cell.current.view.data, cursor: cell.current.view.cursor,
      snapshot: () => active ? cell.current.view : null,
      isCurrent: () => active && cell.current.key === key && cell.current.generation === generation,
      emit: update => {
        if (!active || cell.current.key !== key || cell.current.generation !== generation) return false
        cell.current.view = { ...cell.current.view, ...(update.data !== undefined ? { data: update.data, origin: 'runtime' as const } : {}), ...(update.cursor !== undefined ? { cursor: update.cursor } : {}), ...(update.sync !== undefined ? { sync: update.sync } : {}) }
        if (update.notify !== false) setView(cell.current.view)
        return true
      },
    })
    return () => { driver.stop(); active = false }
  }, [backend, sessionId, environmentId])
  const currentKey = JSON.stringify([environmentId, sessionId])
  return cell.current.key === currentKey ? timelineViewState(view) : emptySessionTimelineState()
}

export function timelineViewState(view: ResourceView<SessionTimelineProjection>): SessionTimelineState {
  return { ...emptySessionTimelineState(), projection: view.data, cursor: view.cursor, appliedVersion: view.cursor?.version ?? 0, phase: view.sync === 'hydrating-cache' ? 'cached' : view.sync === 'failed' ? 'stale' : view.sync, error: view.sync === 'failed' ? 'Timeline stream failed; reconnect to resume.' : null }
}

export function subscribeLive<Value, Error>(backend: Backend, stream: Stream.Stream<Value, Error>, onValue: (value: Value) => void, onError: (error: unknown) => void, reportFailure: (error: unknown) => void) {
  const checked = stream.pipe(Stream.concat(Stream.fail(new Error('Live subscription completed unexpectedly'))))
  return backend.subscribe(checked, onValue, error => { reportFailure(error); onError(error) })
}
