import { useCallback, useEffect, useRef, useState } from 'react'
import { Effect, Stream } from 'effect'
import { connectBackend, type Backend, type BackendOptions } from './backend'
import { createConnectionSupervisor, type ConnectionSnapshot } from './zuse-runtime/packages/client-runtime/src/supervisor'
import { makeSessionTimelineResourceDriver } from './zuse-runtime/packages/client-runtime/src/session-timeline-driver'
import { emptyResourceView, type ResourceView } from './zuse-runtime/packages/client-runtime/src/resource-state'
import { EnvironmentId } from './zuse-runtime/packages/contracts/src/ids'
import { createHash, randomUUID } from 'node:crypto'
import { constants, openSync, readFileSync, writeFileSync, fsyncSync, closeSync, renameSync, mkdirSync, readdirSync, lstatSync, unlinkSync, fstatSync, fchmodSync } from 'node:fs'
import { join } from 'node:path'
import { dataDirectory } from './preferences'
import { encodeSessionTimelineCacheEntry, decodeSessionTimelineCacheEntry, makeSessionTimelineCacheEntry, type SessionTimelineCache, type SessionTimelineCacheEntry } from './zuse-runtime/packages/client-runtime/src/session-timeline-cache'
import { resourceRefKey, type SessionRef } from './zuse-runtime/packages/client-runtime/src/resource-ref'
import { emptySessionTimelineState, prependSessionTimelineMessages, type SessionTimelineState } from './zuse-runtime/packages/client-runtime/src/session-timeline'
import type { SessionId, SessionTimelineProjection } from './zuse-runtime/packages/contracts/src/session'

export function connectionEnvironmentId(options: BackendOptions): EnvironmentId {
  if (options.environmentId?.trim()) return EnvironmentId.make(options.environmentId.trim())
  throw new Error('A verified stable environmentId is required; endpoints and cloud workspace labels are not environment identity.')
}

export class EnvironmentIdentityMismatch extends Error {}
export function createBackendConnection(initialBackend: Backend | null, options: BackendOptions, connector = connectBackend) {
  const connectionKey = `connection:${randomUUID()}`
  let environmentId: EnvironmentId | null = null
  const expectedEnvironmentId = options.environmentId?.trim() || null
  let seed = initialBackend
  const supervisor = createConnectionSupervisor<BackendOptions, Backend>({
    keyOf: () => connectionKey,
    createClient: async endpoint => {
      const backend = seed ?? await connector(endpoint)
      seed = null
      return { client: backend, dispose: () => backend.dispose() }
    },
    validateClient: async backend => {
      const descriptor = await backend.run(backend.client['connect.describe']().pipe(Effect.timeout(5000)))
      const identity = descriptor.environmentId.trim()
      if (!identity || (expectedEnvironmentId && identity !== expectedEnvironmentId) || (environmentId && identity !== environmentId)) throw new EnvironmentIdentityMismatch('Environment identity changed or did not match the asserted identity; connection refused.')
      environmentId = EnvironmentId.make(identity)
      await backend.run(backend.client['ping.ping']({}).pipe(Effect.timeout(5000)))
    },
    classifyError: cause => cause instanceof EnvironmentIdentityMismatch ? 'auth' : 'transient',
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
    get environmentId() { return environmentId },
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
  const binding = JSON.stringify([options.host, options.port, options.wsBaseUrl, options.token, options.environmentId, options.cloudWorkspaceId])
  const [verifiedBinding, setVerifiedBinding] = useState<string | null>(null)
  const pendingIdentity = useRef(EnvironmentId.make(`pending:${randomUUID()}`))
  const [verifiedEnvironmentId, setVerifiedEnvironmentId] = useState<EnvironmentId | null>(null)
  useEffect(() => {
    setVerifiedEnvironmentId(null)
    const connection = createBackendConnection(initialBackend, options); owner.current = connection
    const unsubscribe = connection.subscribe((next, status) => { setBackend(next); setVerifiedBinding(binding); setVerifiedEnvironmentId(connection.environmentId); setSnapshot(status); if (status.error) onErrorRef.current(status.error) })
    return () => { unsubscribe(); owner.current = null; void connection.dispose() }
  }, [initialBackend, options.host, options.port, options.wsBaseUrl, options.token, options.environmentId, options.cloudWorkspaceId])
  const reconnect = useCallback(() => owner.current?.reconnect(), [])
  const reportFailure = useCallback((error: unknown) => owner.current?.reportFailure(error), [])
  const sameBinding = binding === verifiedBinding
  return { backend: sameBinding ? backend : null, status: sameBinding ? snapshot.status : 'connecting' as const, snapshot, generation: snapshot.generation, environmentId: sameBinding && verifiedEnvironmentId ? verifiedEnvironmentId : pendingIdentity.current, verifiedEnvironmentId: sameBinding ? verifiedEnvironmentId : null, identityVerified: sameBinding && verifiedEnvironmentId !== null, reconnect, reportFailure }
}

export class NativeTimelineCache implements SessionTimelineCache {
  constructor(readonly directory = join(dataDirectory, 'timeline-cache'), readonly maxEntries = 40, readonly maxBytes = 32 * 1024 * 1024) {}
  private path(ref: SessionRef) { return join(this.directory, `${createHash('sha256').update(resourceRefKey(ref)).digest('hex')}.json`) }
  async load(ref: SessionRef): Promise<SessionTimelineCacheEntry | null> {
    let fd: number
    try { fd = openSync(this.path(ref), constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    try {
      const info = fstatSync(fd)
      if (!info.isFile() || info.size > this.maxBytes || info.nlink !== 1) throw new Error('Unsafe timeline cache file')
      fchmodSync(fd, 0o600)
      const entry = decodeSessionTimelineCacheEntry(JSON.parse(readFileSync(fd, 'utf8')))
      if (resourceRefKey(entry.ref) !== resourceRefKey(ref) || entry.projection.messages.some(message => message.sessionId !== ref.sessionId)) throw new Error('Timeline cache identity mismatch')
      return entry
    } finally { closeSync(fd) }
  }
  async save(entry: SessionTimelineCacheEntry): Promise<void> {
    if (entry.projection.messages.some(message => message.sessionId !== entry.ref.sessionId)) throw new Error('Timeline cache identity mismatch')
    const bytes = JSON.stringify(encodeSessionTimelineCacheEntry(entry))
    if (Buffer.byteLength(bytes) > this.maxBytes) throw new Error('Timeline cache entry exceeds storage budget')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    if (lstatSync(this.directory).isSymbolicLink()) throw new Error('Unsafe timeline cache directory')
    const target = this.path(entry.ref)
    const temporary = `${target}.${randomUUID()}.tmp`
    let fd: number | undefined
    try {
      fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
      writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined
      renameSync(temporary, target)
      const directory = openSync(this.directory, constants.O_RDONLY)
      try { fsyncSync(directory) } finally { closeSync(directory) }
    } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
    await this.prune()
  }
  async remove(ref: SessionRef) { try { unlinkSync(this.path(ref)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
  async prune(limits: { maxEntries?: number; maxBytes?: number } = {}) {
    let names: string[]
    try { names = readdirSync(this.directory) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    const files = names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => { const path = join(this.directory, name); const info = lstatSync(path); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Unsafe timeline cache entry'); return { path, bytes: info.size, modified: info.mtimeMs } }).sort((a, b) => b.modified - a.modified)
    let bytes = 0
    for (let i = 0; i < files.length; i++) { bytes += files[i]!.bytes; if (i >= (limits.maxEntries ?? this.maxEntries) || bytes > (limits.maxBytes ?? this.maxBytes)) unlinkSync(files[i]!.path) }
  }
}
export type NativeTimelineState = SessionTimelineState & { loadOlder: () => Promise<void>; loadingOlder: boolean; hasOlder: boolean }
export function mergeOlderTimeline(view: ResourceView<SessionTimelineProjection>, page: Awaited<ReturnType<Backend['sessions']['messagesPage']>>): ResourceView<SessionTimelineProjection> {
  const merged = prependSessionTimelineMessages(timelineViewState(view), page.messages, page.olderMessageSequence)
  return { ...view, data: merged.projection }
}
export function historyFenceMatches(start: { key: string; generation: number; epoch: string | undefined; before: number }, current: { key: string; generation: number; view: ResourceView<SessionTimelineProjection> }) {
  return start.key === current.key && start.generation === current.generation && start.epoch === current.view.cursor?.epoch && start.before === current.view.data?.olderMessageSequence && current.view.sync === 'live'
}
export function useTimeline(backend: Backend | null, sessionId: SessionId | null, environmentId: EnvironmentId, onError: (message: string) => void, reportFailure?: (error: unknown) => void): NativeTimelineState {
  const [view, setView] = useState<ResourceView<SessionTimelineProjection>>(() => emptyResourceView())
  const [loadingOlder, setLoadingOlder] = useState(false)
  const paging = useRef(false)
  const cache = useRef<NativeTimelineCache | null>(null)
  cache.current ??= new NativeTimelineCache()
  const cell = useRef({ key: '', view: emptyResourceView<SessionTimelineProjection>(), generation: 0 })
  const callbacks = useRef({ onError, reportFailure }); callbacks.current = { onError, reportFailure }
  useEffect(() => {
    const key = JSON.stringify([environmentId, sessionId])
    if (cell.current.key !== key) cell.current = { key, view: emptyResourceView(), generation: cell.current.generation + 1 }
    const generation = ++cell.current.generation
    paging.current = false; setLoadingOlder(false)
    let active = true
    let stop: (() => void) | undefined
    const current = () => active && cell.current.key === key && cell.current.generation === generation
    const persist = () => {
      const snapshot = cell.current.view
      if (!sessionId || !snapshot.data || !snapshot.cursor) return
      void cache.current!.save(makeSessionTimelineCacheEntry({ ref: { environmentId, sessionId }, projection: snapshot.data, cursor: snapshot.cursor })).catch(() => { if (current()) callbacks.current.onError('Timeline cache could not be saved; live data remains available.') })
    }
    setView({ ...cell.current.view, sync: cell.current.view.data ? 'cached' : 'empty' })
    void (async () => {
      if (sessionId && !cell.current.view.data) {
        try {
          const saved = await cache.current!.load({ environmentId, sessionId })
          if (!current()) return
          if (saved) { cell.current.view = { ...emptyResourceView(), data: saved.projection, cursor: saved.cursor, origin: 'cache', sync: 'cached', generation }; setView(cell.current.view) }
        } catch { if (current()) callbacks.current.onError('Timeline cache was unreadable; requesting a fresh server snapshot.') }
      }
      if (!current()) return
      if (!backend || !sessionId) { cell.current.view = { ...cell.current.view, connection: 'offline', sync: cell.current.view.data ? 'cached' : 'empty' }; setView(cell.current.view); return }
      cell.current.view = { ...cell.current.view, connection: 'connected', sync: 'synchronizing', generation }
      setView(cell.current.view)
      const driver = makeSessionTimelineResourceDriver({ backgroundHistory: () => true, reportFailure: (_environment, _generation, cause) => { if (current()) { callbacks.current.onError(String(cause)); callbacks.current.reportFailure?.(cause) } } })
      stop = driver.stop
      driver.start({
        key: { kind: 'session-timeline', ref: { environmentId, sessionId } }, client: backend.client, generation,
        data: cell.current.view.data, cursor: cell.current.view.cursor,
        snapshot: () => current() ? cell.current.view : null,
        isCurrent: current,
        emit: update => {
          if (!current()) return false
          cell.current.view = { ...cell.current.view, ...(update.data !== undefined ? { data: update.data, origin: 'runtime' as const } : {}), ...(update.cursor !== undefined ? { cursor: update.cursor } : {}), ...(update.sync !== undefined ? { sync: update.sync } : {}) }
          if (update.persist) persist()
          if (update.notify !== false) setView(cell.current.view)
          return true
        },
      })
    })()
    return () => { stop?.(); active = false; cell.current.generation += 1 }
  }, [backend, sessionId, environmentId])
  const loadOlder = useCallback(async () => {
    const before = cell.current.view.data?.olderMessageSequence
    const key = JSON.stringify([environmentId, sessionId])
    if (!backend || !sessionId || paging.current || before == null || cell.current.key !== key || cell.current.view.sync !== 'live') return
    const start = { key, generation: cell.current.generation, epoch: cell.current.view.cursor?.epoch, before }
    paging.current = true; setLoadingOlder(true)
    try {
      const page = await backend.sessions.messagesPage({ sessionId, beforeSequence: before, limit: 100 })
      if (!historyFenceMatches(start, cell.current)) return
      if (page.olderMessageSequence !== null && page.olderMessageSequence >= before) throw new Error('Transcript pagination did not advance')
      if (page.messages.some(message => message.sessionId !== sessionId)) throw new Error('History page session identity mismatch')
      cell.current.view = mergeOlderTimeline(cell.current.view, page)
      setView(cell.current.view)
      if (cell.current.view.data && cell.current.view.cursor) await cache.current!.save(makeSessionTimelineCacheEntry({ ref: { environmentId, sessionId }, projection: cell.current.view.data, cursor: cell.current.view.cursor }))
    } catch (error) { if (cell.current.key === key && cell.current.generation === start.generation) callbacks.current.onError(String(error)) }
    finally { if (cell.current.key === key && cell.current.generation === start.generation) { paging.current = false; setLoadingOlder(false) } }
  }, [backend, sessionId, environmentId])
  const currentKey = JSON.stringify([environmentId, sessionId])
  const state = cell.current.key === currentKey ? timelineViewState(view) : emptySessionTimelineState()
  return { ...state, loadOlder, loadingOlder: cell.current.key === currentKey && loadingOlder, hasOlder: state.projection?.olderMessageSequence != null }
}

export function timelineViewState(view: ResourceView<SessionTimelineProjection>): SessionTimelineState {
  return { ...emptySessionTimelineState(), projection: view.data, cursor: view.cursor, appliedVersion: view.cursor?.version ?? 0, phase: view.sync === 'hydrating-cache' ? 'cached' : view.sync === 'failed' ? 'stale' : view.sync, error: view.sync === 'failed' ? 'Timeline stream failed; reconnect to resume.' : null }
}

export function subscribeLive<Value, Error>(backend: Backend, stream: Stream.Stream<Value, Error>, onValue: (value: Value) => void, onError: (error: unknown) => void, reportFailure: (error: unknown) => void) {
  const checked = stream.pipe(Stream.concat(Stream.fail(new Error('Live subscription completed unexpectedly'))))
  return backend.subscribe(checked, onValue, error => { reportFailure(error); onError(error) })
}
