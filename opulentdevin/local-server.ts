import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, rmdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { Effect } from 'effect'
import { connectBackend, startLocalBackend, type Backend, type BackendOptions } from './backend'
import { resolveZuseRoot, verifyZuse } from './bootstrap-zuse'
import { inspectTailnetShare, setTailnetShareEnabled, type TailnetCommandRunner } from './zuse-runtime/packages/tailnet/src/index'

export type LocalServerConfig = { dataDir: string; port: number; executable?: string; host?: '127.0.0.1' | '0.0.0.0'; auth?: 'local' | 'protected'; pairing?: boolean; token?: string }
export type LocalServerConnection = { backend: Backend; environmentId: string }
export type LocalServerState = { status: 'stopped' | 'starting' | 'ready' | 'restarting' | 'error'; host: '127.0.0.1' | '0.0.0.0'; auth: 'local' | 'protected'; pairing: boolean; port: number; pid: number | null; environmentId: string | null }
export function normaliseLocalConfig(input: LocalServerConfig) {
  if (!isAbsolute(input.dataDir) || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error('An absolute data directory and valid port are required.')
  const host = input.host ?? '127.0.0.1'
  const auth = input.auth ?? 'local'
  if (host !== '127.0.0.1' && host !== '0.0.0.0') throw new Error('Unsupported listener address.')
  if (auth !== 'local' && auth !== 'protected') throw new Error('Unsupported authentication policy.')
  if (host !== '127.0.0.1' && auth !== 'protected') throw new Error('Network listeners require protected authentication.')
  if (auth === 'protected' && !input.token) throw new Error('Protected startup requires an in-memory credential.')
  return { ...input, host, auth, pairing: input.pairing ?? false }
}
export function localServerArguments(root: string, config: ReturnType<typeof normaliseLocalConfig>) {
  return ['--import', join(root, 'apps/server/node_modules/tsx/dist/loader.mjs'), join(root, 'apps/server/src/bin.ts'), 'serve', '--host', config.host, '--port', String(config.port), '--data-dir', config.dataDir, '--auth', config.auth, ...(config.pairing ? [] : ['--no-pairing'])]
}
async function reserveCheck(port: number) {
  await new Promise<void>((resolve, reject) => { const server = createServer(); server.once('error', () => reject(new Error('The configured local port is already in use.'))); server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve())) })
}
function launch(config: ReturnType<typeof normaliseLocalConfig>) {
  if (config.host === '127.0.0.1' && config.auth === 'local' && !config.pairing) return startLocalBackend(config)
  const root = verifyZuse(resolveZuseRoot(import.meta.url))
  return spawn(config.executable ?? 'node', localServerArguments(root, config), { cwd: root, shell: false, env: { ...process.env, ZUSE_ENABLE_PAIRING: config.pairing ? '1' : '0', ZUSE_CONFIG_DIR: join(config.dataDir, 'config') }, stdio: ['ignore', 'pipe', 'pipe'] })
}
async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const hard = setTimeout(() => child.kill('SIGKILL'), 3000)
    const deadline = setTimeout(() => { clearTimeout(hard); reject(new Error('Owned server did not stop.')) }, 6000)
    child.once('exit', () => { clearTimeout(hard); clearTimeout(deadline); resolve() })
    child.kill('SIGTERM')
  })
}
async function acquireToken(backend: Backend, port: number, environmentId: string) {
  const pairing = await backend.run(backend.client['pairing.start']({}).pipe(Effect.timeout(10000)))
  const response = await fetch(`http://127.0.0.1:${port}/pair`, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pairing.code, deviceId: 'opulentdevin-owned-host', deviceLabel: 'OpulentDevin local host' }), signal: AbortSignal.timeout(10000) })
  if (!response.ok) throw new Error('Local host authentication could not be established.')
  const value: unknown = await response.json()
  if (!value || typeof value !== 'object' || !('token' in value) || typeof value.token !== 'string' || !value.token || !('environmentId' in value) || value.environmentId !== environmentId) throw new Error('Local host credential identity mismatch.')
  return value.token
}
export type LocalServerDependencies = {
  launch: typeof launch
  connect: (options: BackendOptions) => Promise<Backend>
  ensurePortFree: typeof reserveCheck
  stopChild: typeof stopChild
  acquireToken: typeof acquireToken
  pause: (ms: number) => Promise<void>
  lock: (directory: string) => Promise<void>
  unlock: (directory: string) => Promise<void>
  tailnetRunner?: TailnetCommandRunner
}
const defaults: LocalServerDependencies = { launch, connect: connectBackend, ensurePortFree: reserveCheck, stopChild, acquireToken, pause: ms => new Promise(resolve => setTimeout(resolve, ms)), lock: async directory => { await mkdir(directory, { mode: 0o700 }) }, unlock: async directory => { await rmdir(directory) } }

export class LocalServerManager {
  private config: ReturnType<typeof normaliseLocalConfig>
  private child: ChildProcess | null = null
  private connection: LocalServerConnection | null = null
  private identity: string | null = null
  private status: LocalServerState['status'] = 'stopped'
  private locked = false
  private active = false
  private tailnetOwned = false
  private readonly listeners = new Set<(state: LocalServerState) => void>()
  private readonly deps: LocalServerDependencies
  constructor(config: LocalServerConfig, private readonly onConnection?: (connection: LocalServerConnection | null) => void, dependencies: Partial<LocalServerDependencies> = {}) { this.config = normaliseLocalConfig(config); this.deps = { ...defaults, ...dependencies } }
  terminateOwnedProcess() { if (this.child && this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGTERM') }
  currentConnection(): LocalServerConnection | null { return this.connection }
  async reconnect(): Promise<LocalServerConnection> {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return this.start()
    return this.exclusive(async () => {
      const next = await this.deps.connect({ host: '127.0.0.1', port: this.config.port, token: this.config.token, timeoutMs: 2000 })
      try {
        const descriptor = await next.run(next.client['connect.describe']().pipe(Effect.timeout(5000)))
        if (descriptor.environmentId !== this.identity) throw new Error('Identity changed')
        const previous = this.connection; this.connection = { backend: next, environmentId: descriptor.environmentId }; this.status = 'ready'; await previous?.backend.dispose(); this.emit(); this.onConnection?.(this.connection); return this.connection
      } catch { await next.dispose(); throw new Error('Owned local reconnection failed identity verification.') }
    })
  }
  snapshot(): LocalServerState { return { status: this.status, host: this.config.host, auth: this.config.auth, pairing: this.config.pairing, port: this.config.port, pid: this.child?.pid ?? null, environmentId: this.identity } }
  subscribe(listener: (state: LocalServerState) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit() { for (const listener of this.listeners) listener(this.snapshot()) }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> { if (this.active) throw new Error('A local-server change is already in progress.'); this.active = true; try { return await action() } finally { this.active = false } }
  private assertOwned() { if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null || !this.connection || this.status !== 'ready') throw new Error('The owned local backend is not ready.') }
  private async verifyCurrent() { this.assertOwned(); const descriptor = await this.connection!.backend.run(this.connection!.backend.client['connect.describe']().pipe(Effect.timeout(5000))); if (descriptor.environmentId !== this.identity) throw new Error('Owned backend identity changed.') }
  private async boot() {
    await this.deps.ensurePortFree(this.config.port)
    const child = this.deps.launch(this.config); this.child = child
    let failed = false
    let listening = false
    let marker = ''
    child.stdout?.on('data', chunk => { marker = (marker + String(chunk)).slice(-256); if (marker.includes('Zuse Serve:')) { listening = true; marker = '' } }); child.stderr?.resume()
    child.once('error', () => { failed = true })
    child.once('exit', () => { if (this.child === child && this.status === 'ready') { this.status = 'error'; this.connection = null; this.onConnection?.(null); this.emit() } })
    for (let attempt = 0; attempt < 40; attempt++) {
      if (failed || child.exitCode !== null || child.signalCode !== null) break
      if (!listening) { await this.deps.pause(250); continue }
      let backend: Backend | undefined
      try {
        backend = await this.deps.connect({ host: '127.0.0.1', port: this.config.port, token: this.config.token, timeoutMs: 1000 })
        const descriptor = await backend.run(backend.client['connect.describe']().pipe(Effect.timeout(2000)))
        if (this.identity && this.identity !== descriptor.environmentId) { await backend.dispose(); throw new Error('Owned backend identity changed.') }
        this.identity = descriptor.environmentId; this.connection = { backend, environmentId: descriptor.environmentId }; this.status = 'ready'; this.emit(); this.onConnection?.(this.connection); return this.connection
      } catch { await backend?.dispose().catch(() => {}); if (this.connection?.backend === backend) this.connection = null }
      await this.deps.pause(250)
    }
    await this.deps.stopChild(child); this.child = null; this.status = 'error'; this.emit(); throw new Error('The owned local backend did not become ready. No foreign process was adopted.')
  }
  async start(confirmedSharing = false) { return this.exclusive(async () => { if (this.config.host !== '127.0.0.1' && !confirmedSharing) throw new Error('Explicit sharing confirmation is required.'); if (this.connection && this.status === 'ready') return this.connection; await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 }); if (!this.locked) { await this.deps.lock(join(this.config.dataDir, 'native-host.lock')); this.locked = true }; this.status = 'starting'; this.emit(); try { return await this.boot() } catch { if (this.locked && !this.child) { await this.deps.unlock(join(this.config.dataDir, 'native-host.lock')); this.locked = false }; throw new Error('Local backend startup failed; verify its owned port and lock.') } }) }
  private async restart(next: ReturnType<typeof normaliseLocalConfig>) {
    const previous = this.config; const old = this.connection; this.status = 'restarting'; this.emit(); this.onConnection?.(null); this.connection = null
    await old?.backend.dispose(); if (this.child) await this.deps.stopChild(this.child); this.child = null; this.config = next
    try { return await this.boot() } catch { this.config = previous; this.status = 'starting'; try { await this.boot() } catch { this.status = 'error'; this.emit() }; throw new Error('Listener change failed. The previous owned configuration was restored where possible.') }
  }
  async setLanEnabled(enabled: boolean, confirmed: boolean) { return this.exclusive(async () => { if (!confirmed) throw new Error('Explicit sharing confirmation is required.'); await this.verifyCurrent(); const token = this.config.token ?? await this.deps.acquireToken(this.connection!.backend, this.config.port, this.identity!); const next = normaliseLocalConfig({ ...this.config, token, auth: 'protected', host: enabled ? '0.0.0.0' : '127.0.0.1' }); return this.restart(next) }) }
  async setPairingEnabled(enabled: boolean, confirmed: boolean) { return this.exclusive(async () => { if (!confirmed) throw new Error('Explicit pairing confirmation is required.'); await this.verifyCurrent(); return this.restart({ ...this.config, pairing: enabled }) }) }
  private probe = async (port: number): Promise<'zuse' | 'unreachable' | 'other'> => { if (port !== this.config.port) return 'other'; try { await this.verifyCurrent(); return 'zuse' } catch { return 'unreachable' } }
  async tailnetStatus() { await this.verifyCurrent(); return inspectTailnetShare(this.config.port, this.deps.tailnetRunner, { ownershipDir: this.config.dataDir, probe: this.probe }) }
  async setTailnetEnabled(enabled: boolean, confirmed: boolean) { return this.exclusive(async () => {
    if (!confirmed) throw new Error('Explicit tailnet sharing confirmation is required.')
    await this.verifyCurrent()
    if (!enabled && !this.tailnetOwned) throw new Error('This manager did not create the tailnet route and will not remove it.')
    const before = await inspectTailnetShare(this.config.port, this.deps.tailnetRunner, { ownershipDir: this.config.dataDir, probe: this.probe })
    if (enabled && before.enabled && !this.tailnetOwned) throw new Error('A pre-existing tailnet route will not be adopted or changed by this manager.')
    if (enabled && before.availability !== 'available') return before
    if (enabled && this.config.auth !== 'protected') { const token = await this.deps.acquireToken(this.connection!.backend, this.config.port, this.identity!); await this.restart(normaliseLocalConfig({ ...this.config, token, auth: 'protected' })) }
    const result = await setTailnetShareEnabled({ enabled, port: this.config.port, ownershipDir: this.config.dataDir, probe: this.probe }, this.deps.tailnetRunner)
    if (result.enabled && result.managedBy !== 'zuse-serve') this.tailnetOwned = true
    if (!result.enabled) this.tailnetOwned = false
    return result
  }) }
  async stop() { return this.exclusive(async () => { if (this.tailnetOwned && this.connection && this.status === 'ready') { const result = await setTailnetShareEnabled({ enabled: false, port: this.config.port, ownershipDir: this.config.dataDir, probe: this.probe }, this.deps.tailnetRunner); if (result.enabled) throw new Error('Owned tailnet route could not be disabled. Server remains running to avoid leaving an orphaned route.'); this.tailnetOwned = false }; this.status = 'stopped'; this.onConnection?.(null); const connection = this.connection; this.connection = null; await connection?.backend.dispose(); if (this.child) { await this.deps.stopChild(this.child); this.child = null }; if (this.locked) { await this.deps.unlock(join(this.config.dataDir, 'native-host.lock')); this.locked = false }; this.emit() }) }
}
