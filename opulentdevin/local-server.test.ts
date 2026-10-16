import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import type { Backend } from './backend'
import { LocalServerManager, localServerArguments, normaliseLocalConfig, type LocalServerDependencies } from './local-server'
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture(identities = ['env-owned']) {
  const dataDir = await mkdtemp(join(tmpdir(), 'native-local-server-')); directories.push(dataDir)
  const children: ChildProcess[] = []
  const configs: ReturnType<typeof normaliseLocalConfig>[] = []
  const disposals: ReturnType<typeof vi.fn>[] = []
  const states: (string | null)[] = []
  const dependencies: LocalServerDependencies = {
    launch: config => { configs.push({ ...config }); const child = Object.assign(new EventEmitter(), { pid: 100 + children.length, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() }) as unknown as ChildProcess; children.push(child); queueMicrotask(() => child.stdout!.emit('data', 'Zuse Serve: http://127.0.0.1/')); return child },
    connect: vi.fn(async () => { const identity = identities[Math.min(children.length - 1, identities.length - 1)]; const dispose = vi.fn(async () => {}); disposals.push(dispose); return { client: { 'connect.describe': () => Effect.succeed({ environmentId: identity }) }, run: Effect.runPromise, dispose } as unknown as Backend }),
    ensurePortFree: vi.fn(async () => {}), stopChild: vi.fn(async child => { Object.assign(child, { exitCode: 0 }); child.emit('exit', 0) }), acquireToken: vi.fn(async () => 'fixture-token'), pause: async () => { await Promise.resolve() }, lock: vi.fn(async () => {}), unlock: vi.fn(async () => {}),
  }
  const manager = new LocalServerManager({ dataDir, port: 41239 }, connection => states.push(connection?.environmentId ?? null), dependencies)
  return { manager, dependencies, configs, children, states, disposals, dataDir }
}
describe('local server authentication policy', () => {
  it('defaults loopback and rejects unprotected network bind', () => { expect(normaliseLocalConfig({ dataDir: '/tmp/test', port: 1234 })).toMatchObject({ host: '127.0.0.1', auth: 'local', pairing: false }); expect(() => normaliseLocalConfig({ dataDir: '/tmp/test', port: 1234, host: '0.0.0.0' })).toThrow(); expect(() => normaliseLocalConfig({ dataDir: '/tmp/test', port: 1234, auth: 'protected' })).toThrow() })
  it('never places a credential in argv', () => { const config = normaliseLocalConfig({ dataDir: '/tmp/test', port: 1234, auth: 'protected', token: 'fixture-token' }); const args = localServerArguments('/runtime', config); expect(args).toContain('protected'); expect(args).not.toContain('fixture-token'); expect(args).toContain('--no-pairing') })
  it('rejects invalid ports and relative state directories', () => { expect(() => normaliseLocalConfig({ dataDir: 'relative', port: 1234 })).toThrow(); expect(() => normaliseLocalConfig({ dataDir: '/tmp/test', port: 0 })).toThrow() })
})
describe('owned lifecycle (mocked processes; no network binding)', () => {
  it('starts only its child, verifies identity and cleans up only that child', async () => { const f = await fixture(); const result = await f.manager.start(); expect(result.environmentId).toBe('env-owned'); expect(f.manager.snapshot()).toMatchObject({ pid: 100, status: 'ready', host: '127.0.0.1' }); await f.manager.stop(); expect(f.dependencies.stopChild).toHaveBeenCalledWith(f.children[0]); expect(f.dependencies.unlock).toHaveBeenCalledOnce(); expect(f.disposals[0]).toHaveBeenCalledOnce() })
  it('requires sharing confirmation before token creation or restart', async () => { const f = await fixture(); await f.manager.start(); await expect(f.manager.setLanEnabled(true, false)).rejects.toThrow('confirmation'); expect(f.dependencies.acquireToken).not.toHaveBeenCalled(); expect(f.configs).toHaveLength(1); await f.manager.stop() })
  it('rebinds protected with stable identity and never downgrades when LAN is disabled', async () => { const f = await fixture(); await f.manager.start(); await f.manager.setLanEnabled(true, true); expect(f.configs[1]).toMatchObject({ host: '0.0.0.0', auth: 'protected', pairing: false, token: 'fixture-token' }); expect(JSON.stringify(f.manager.snapshot())).not.toContain('fixture-token'); await f.manager.setLanEnabled(false, true); expect(f.configs[2]).toMatchObject({ host: '127.0.0.1', auth: 'protected', token: 'fixture-token' }); expect(f.states).toEqual(['env-owned', null, 'env-owned', null, 'env-owned']); await f.manager.stop() })
  it('rejects a foreign identity after restart and restores the prior owned configuration', async () => { const f = await fixture(['env-owned', 'env-foreign', 'env-owned']); await f.manager.start(); await expect(f.manager.setLanEnabled(true, true)).rejects.toThrow('restored'); expect(f.manager.snapshot()).toMatchObject({ environmentId: 'env-owned', host: '127.0.0.1', status: 'ready' }); expect(f.configs).toHaveLength(3); await f.manager.stop() })
  it('preserves auth while enabling pairing explicitly', async () => { const f = await fixture(); await f.manager.start(); await f.manager.setLanEnabled(true, true); await f.manager.setPairingEnabled(true, true); expect(f.configs.at(-1)).toMatchObject({ auth: 'protected', pairing: true }); await f.manager.stop() })
  it('refuses occupied ports without spawning or adopting a process', async () => { const f = await fixture(); f.dependencies.ensurePortFree = vi.fn(async () => { throw new Error('busy') }); const manager = new LocalServerManager({ dataDir: f.dataDir, port: 41239 }, undefined, f.dependencies); await expect(manager.start()).rejects.toThrow(); expect(f.configs).toHaveLength(0); expect(f.dependencies.unlock).toHaveBeenCalledOnce() })
  it('requires explicit tailnet confirmation without invoking any CLI', async () => { const f = await fixture(); await f.manager.start(); await expect(f.manager.setTailnetEnabled(true, false)).rejects.toThrow('confirmation'); expect(f.dependencies.acquireToken).not.toHaveBeenCalled(); await f.manager.stop() })
})
