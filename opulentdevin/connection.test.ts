import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, readdir, stat, readFile, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { Effect, Stream } from 'effect'
import { startLocalBackend, type Backend } from './backend'
import { NativeTimelineCache, mergeOlderTimeline, historyFenceMatches, connectionEnvironmentId, createBackendConnection, subscribeLive, timelineViewState } from './connection'
import { makeSessionTimelineCacheEntry } from './zuse-runtime/packages/client-runtime/src/session-timeline-cache'
import { SessionTimelineProjection, Message } from './zuse-runtime/packages/contracts/src/session'
import { EnvironmentId, AgentSessionId, MessageId } from './zuse-runtime/packages/contracts/src/ids'
import { emptyResourceView } from './zuse-runtime/packages/client-runtime/src/resource-state'

const ref = { environmentId: EnvironmentId.make('local:cache-test'), sessionId: AgentSessionId.make('session-cache') }
const message = (id: string) => Message.make({ id: MessageId.make(id), sessionId: ref.sessionId, role: 'user', content: { _tag: 'user', text: id }, createdAt: new Date(0) })
const projection = () => SessionTimelineProjection.make({ messages: [message('new')], olderMessageSequence: 8, status: 'idle', currentTurn: null, queue: { items: [], paused: false }, permissionMode: 'default', runtimeMode: 'approval-required', interactions: [] })

describe('durable native timeline cache', () => {
  it('round trips canonical classes and dates with projection/cursor atomically and mode0600', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'timeline-cache-'))
    try {
      const cache = new NativeTimelineCache(directory)
      await cache.save(makeSessionTimelineCacheEntry({ ref, projection: projection(), cursor: { epoch: 'epoch-1', version: 9 } }))
      const saved = await cache.load(ref)
      expect(saved?.projection).toBeInstanceOf(SessionTimelineProjection)
      expect(saved?.projection.messages[0]?.createdAt).toBeInstanceOf(Date)
      expect(saved?.cursor).toEqual({ epoch: 'epoch-1', version: 9 })
      const files = await readdir(directory)
      expect(files).toHaveLength(1)
      expect((await stat(join(directory, files[0]!))).mode & 0o777).toBe(0o600)
      expect(timelineViewState({ ...emptyResourceView(), data: saved!.projection, cursor: saved!.cursor, sync: 'cached' }).phase).toBe('cached')
      expect(await cache.load({ ...ref, environmentId: EnvironmentId.make('other') })).toBeNull()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('rejects identity tampering and symlink reads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'timeline-cache-'))
    try {
      const cache = new NativeTimelineCache(directory)
      await cache.save(makeSessionTimelineCacheEntry({ ref, projection: projection(), cursor: { epoch: 'e', version: 1 } }))
      const file = join(directory, (await readdir(directory))[0]!)
      const encoded = JSON.parse(await readFile(file, 'utf8'))
      encoded.ref.environmentId = 'wrong'
      await writeFile(file, JSON.stringify(encoded))
      await expect(cache.load(ref)).rejects.toThrow('identity')
      await rm(file); await symlink(join(directory, 'missing'), file)
      await expect(cache.load(ref)).rejects.toThrow()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('prunes to entry/byte budgets and removes exact scoped cache entries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'timeline-cache-'))
    try {
      const cache = new NativeTimelineCache(directory, 2)
      for (let i = 0; i < 3; i++) await cache.save(makeSessionTimelineCacheEntry({ ref: { ...ref, environmentId: EnvironmentId.make(`env-${i}`) }, projection: projection(), cursor: { epoch: 'e', version: i } }))
      expect(await readdir(directory)).toHaveLength(2)
      await cache.prune({ maxBytes: 1 })
      expect(await readdir(directory)).toHaveLength(0)
      await cache.save(makeSessionTimelineCacheEntry({ ref, projection: projection(), cursor: { epoch: 'e', version: 1 } }))
      await cache.remove(ref); expect(await cache.load(ref)).toBeNull()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('prepends canonical history without moving live cursor or duplicating messages', () => {
    const view = { ...emptyResourceView<SessionTimelineProjection>(), data: projection(), cursor: { epoch: 'e', version: 9 }, sync: 'live' as const }
    const merged = mergeOlderTimeline(view, { messages: [message('old'), message('new')], olderMessageSequence: null })
    expect(merged.data?.messages.map(item => item.id)).toEqual(['old', 'new'])
    expect(merged.cursor).toBe(view.cursor)
    expect(merged.data?.olderMessageSequence).toBeNull()
  })
  it('fences history from stale sessions, generations, resets and boundary changes', () => {
    const view = { ...emptyResourceView<SessionTimelineProjection>(), data: projection(), cursor: { epoch: 'e', version: 10 }, sync: 'live' as const }
    const start = { key: 'key', generation: 2, epoch: 'e', before: 8 }
    expect(historyFenceMatches(start, { key: 'key', generation: 2, view })).toBe(true)
    expect(historyFenceMatches(start, { key: 'other', generation: 2, view })).toBe(false)
    expect(historyFenceMatches(start, { key: 'key', generation: 3, view })).toBe(false)
    expect(historyFenceMatches(start, { key: 'key', generation: 2, view: { ...view, cursor: { epoch: 'reset', version: 0 } } })).toBe(false)
    expect(historyFenceMatches(start, { key: 'key', generation: 2, view: { ...view, sync: 'cached' } })).toBe(false)
  })
})

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('connection ownership', () => {
  it('pins descriptor identity before exposing clients and refuses another environment on the same port', async () => {
    const disposed: string[] = []; const exposed: string[] = []
    const fake = (id: string) => ({ run: Effect.runPromise, dispose: async () => { disposed.push(id) }, client: { 'connect.describe': () => Effect.succeed({ environmentId: id }), 'ping.ping': () => Effect.succeed({ message: 'pong' }) } }) as unknown as Backend
    const a = fake('environment-A'); const b = fake('environment-B')
    const owner = createBackendConnection(a, { host: '127.0.0.1', port: 49999 }, async () => b)
    expect(owner.environmentId).toBeNull()
    const off = owner.subscribe(client => { if (client) exposed.push(client === a ? 'A' : 'B') })
    try {
      for (let i = 0; i < 50 && owner.snapshot().status !== 'connected'; i++) await pause(10)
      expect(owner.environmentId).toBe('environment-A')
      owner.reportFailure(new Error('connection lost')); owner.reconnect()
      for (let i = 0; i < 50 && owner.snapshot().status !== 'blockedAuth'; i++) await pause(10)
      expect(owner.snapshot().status).toBe('blockedAuth')
      expect(owner.environmentId).toBe('environment-A')
      expect(exposed).not.toContain('B')
      expect(disposed).toContain('environment-B')
    } finally { off(); await owner.dispose() }
  })
  it('requires stable remote identity and never persists ticket URLs as identity', () => {
    expect(() => connectionEnvironmentId({ host: 'remote.example', port: 443 })).toThrow('stable environmentId')
    expect(() => connectionEnvironmentId({ host: 'remote.example', port: 443, cloudWorkspaceId: 'workspace-1', token: 'test-token' })).toThrow('stable environmentId')
    expect(connectionEnvironmentId({ host: '127.0.0.1', port: 47693, environmentId: 'local:test-data' })).toBe('local:test-data')
    expect(timelineViewState({ ...emptyResourceView(), sync: 'failed' }).phase).toBe('stale')
  })
  it('reconnects the same endpoint and reports unexpected live-stream completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-connection-'))
    let logs = ''
    const child = startLocalBackend({ dataDir: root, port: 47693, onOutput: text => { logs += text } })
    const owner = createBackendConnection(null, { host: '127.0.0.1', port: 47693, timeoutMs: 500 })
    let backend: Backend | null = null
    const off = owner.subscribe(next => { backend = next })
    try {
      for (let attempt = 0; attempt < 100 && !backend; attempt++) { if (child.exitCode !== null) throw new Error(logs); await pause(100) }
      const first = backend as Backend | null
      if (!first) throw new Error(`Connection failed: ${logs}`)
      expect((await first.ping({})).message).toBe('pong')
      const pinnedIdentity = owner.environmentId
      const generation = owner.snapshot().generation
      let error: unknown
      const stream = subscribeLive(first, Stream.empty, () => {}, cause => { error = cause }, cause => owner.reportFailure(cause))
      await stream.done
      expect(String(error)).toContain('completed unexpectedly')
      for (let attempt = 0; attempt < 100 && (owner.snapshot().generation <= generation || owner.snapshot().status !== 'connected'); attempt++) await pause(100)
      expect(owner.snapshot().status).toBe('connected')
      expect(owner.snapshot().generation).toBeGreaterThan(generation)
      expect(owner.environmentId).toBe(pinnedIdentity)
      expect(pinnedIdentity).toBeTruthy()
    } finally {
      off(); await owner.dispose()
      if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit') }
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)
})
