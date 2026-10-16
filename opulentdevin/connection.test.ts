import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { Stream } from 'effect'
import { startLocalBackend, type Backend } from './backend'
import { connectionEnvironmentId, createBackendConnection, subscribeLive, timelineViewState } from './connection'
import { emptyResourceView } from './zuse-runtime/packages/client-runtime/src/resource-state'

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('connection ownership', () => {
  it('requires stable remote identity and never persists ticket URLs as identity', () => {
    expect(() => connectionEnvironmentId({ host: 'remote.example', port: 443 })).toThrow('stable environmentId')
    expect(connectionEnvironmentId({ host: 'remote.example', port: 443, cloudWorkspaceId: 'workspace-1', token: 'test-token' })).toBe('cloud:workspace-1')
    expect(connectionEnvironmentId({ host: '127.0.0.1', port: 47693, environmentId: 'local:test-data' })).toBe('local:test-data')
    expect(timelineViewState({ ...emptyResourceView(), sync: 'failed' }).phase).toBe('stale')
  })
  it('reconnects the same endpoint and reports unexpected live-stream completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-connection-'))
    let logs = ''
    const child = startLocalBackend({ dataDir: root, port: 47693, onOutput: text => { logs += text } })
    const owner = createBackendConnection(null, { host: '127.0.0.1', port: 47693, environmentId: 'local:test-data', timeoutMs: 500 })
    let backend: Backend | null = null
    const off = owner.subscribe(next => { backend = next })
    try {
      for (let attempt = 0; attempt < 100 && !backend; attempt++) { if (child.exitCode !== null) throw new Error(logs); await pause(100) }
      const first = backend as Backend | null
      if (!first) throw new Error(`Connection failed: ${logs}`)
      expect((await first.ping({})).message).toBe('pong')
      const generation = owner.snapshot().generation
      let error: unknown
      const stream = subscribeLive(first, Stream.empty, () => {}, cause => { error = cause }, cause => owner.reportFailure(cause))
      await stream.done
      expect(String(error)).toContain('completed unexpectedly')
      for (let attempt = 0; attempt < 100 && (owner.snapshot().generation <= generation || owner.snapshot().status !== 'connected'); attempt++) await pause(100)
      expect(owner.snapshot().status).toBe('connected')
      expect(owner.snapshot().generation).toBeGreaterThan(generation)
      expect(owner.environmentId).toBe('local:test-data')
    } finally {
      off(); await owner.dispose()
      if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit') }
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)
})
