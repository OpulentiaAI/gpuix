import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import type { Backend } from './backend'
import type { CheckUpdateOptions } from '@gpuix/native'
import { parseConnectLink, type ParsedConnectLink } from './zuse-runtime/packages/contracts/src/connect-links'

export const nativeShellLimits = {
  alwaysOnTop: 'Installed GPUIX has no dynamic always-on-top API. Wayland layerShell is a creation-time surface role, not a toggle for this window.',
  closeGuard: 'Window close requests use native confirmation and cleanup. Forced termination and OS application quit can bypass this window guard; recoverable drafts are persisted independently.',
  deepLinks: 'No GPUIX OS URL-event/single-instance forwarding API. Validate supplied argv or pasted links in memory; OS protocol registration and activation routing belong to the packaged launcher.',
  menu: 'No native application-menu registration API. The in-app registry exposes window focus, minimise, maximise/fullscreen, update check and guarded quit; it does not pretend to register OS menus.',
} as const
export type QuitSnapshot = { active: number; environments: number; checkedAt: number }
export async function inspectQuit(backends: readonly Backend[]): Promise<QuitSnapshot> {
  if (!backends.length) throw new Error('No verified environment is available for the running-agent check.')
  let active = 0
  for (const backend of [...new Set(backends)]) {
    const folders = await backend.run(backend.client['workspace.list']({}).pipe(Effect.timeout(5000)))
    for (const folder of folders) {
      const sessions = await backend.run(backend.client['session.list']({ projectId: folder.id, includeArchived: true }).pipe(Effect.timeout(5000)))
      active += sessions.filter(session => session.status === 'running' || session.status === 'booting').length
    }
  }
  return { active, environments: new Set(backends).size, checkedAt: Date.now() }
}
export class QuitGuard {
  private quitting = false
  private timer: ReturnType<typeof setInterval> | null = null
  private generation = 0
  private checking = false
  constructor(private readonly backends: () => readonly Backend[], private readonly quit: () => Promise<void>, private readonly inspect = inspectQuit) {}
  check() { return this.inspect(this.backends()) }
  async request(confirmedActive = false) {
    if (this.quitting) return
    this.quitting = true
    try {
      const state = await this.check()
      if (state.active > 0 && !confirmedActive) throw new Error('Agents are running. Confirm interruption or choose quit when idle.')
      this.cancelIdle(); await this.quit()
    } catch { this.quitting = false; throw new Error('Quit refused or cleanup failed. Check running agents and confirm before retrying.') }
  }
  whenIdle(onStatus: (state: QuitSnapshot | null) => void) {
    this.cancelIdle(); const generation = this.generation
    const check = async () => {
      if (this.checking || generation !== this.generation) return
      this.checking = true
      try { const state = await this.check(); if (generation !== this.generation) return; onStatus(state); if (state.active === 0) await this.request(false) }
      catch { if (generation === this.generation) onStatus(null) }
      finally { this.checking = false }
    }
    this.timer = setInterval(() => { void check() }, 3000); void check()
  }
  cancelIdle() { this.generation++; if (this.timer) clearInterval(this.timer); this.timer = null }
  dispose() { this.cancelIdle() }
}
export function validateShellLink(input: string): ParsedConnectLink {
  if (!input || input.length > 8192 || /[\u0000-\u0020]/.test(input)) throw new Error('Invalid connection link.')
  try {
    const outer = new URL(input)
    if (outer.username || outer.password) throw new Error('Invalid link')
    if (outer.protocol === 'zuse:' || outer.protocol === 'memoize:') {
      if (outer.hostname || outer.pathname !== '/connect/pair' || [...outer.searchParams.keys()].some(key => key !== 'pairingUrl')) throw new Error('Unsupported deep-link route')
    } else if (outer.protocol !== 'https:' && outer.protocol !== 'http:') throw new Error('Unsupported scheme')
    const parsed = parseConnectLink(input)
    if (!parsed.ok) throw new Error('Unsupported connection link')
    const endpoint = new URL(parsed.link.wsBaseUrl)
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Invalid endpoint')
    return parsed.link
  } catch { throw new Error('Only a valid Zuse pairing link with a secure or private/local endpoint is accepted. OAuth callbacks and executable links are not dispatched.') }
}
export async function acquireShellInstance(directory: string) {
  if (!isAbsolute(directory)) throw new Error('An absolute instance directory is required.')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const lock = join(directory, 'native-shell.lock'); const owner = randomUUID(); const file = join(lock, 'owner')
  try { await mkdir(lock, { mode: 0o700 }) } catch { throw new Error('Another instance or stale ownership lock exists. Do not start a second window; inspect ownership before removing a stale lock.') }
  try { await writeFile(file, owner, { flag: 'wx', mode: 0o600 }) } catch { await rmdir(lock).catch(() => {}); throw new Error('Could not record shell ownership.') }
  let released = false
  return { release: async () => { if (released) return; if (await readFile(file, 'utf8') !== owner) throw new Error('Shell lock ownership changed; refusing removal.'); await unlink(file); await rmdir(lock); released = true } }
}
export type ReleaseConfiguration = { currentVersion: string; endpoints: readonly string[]; publicKey: string }
export type ReleaseInformation = { currentVersion: string; available: boolean; version?: string; date?: string | null; format?: string }
type UpdateResult = { version: string; date: string | null; format: string } | null
export function releaseOptions(config: ReleaseConfiguration): CheckUpdateOptions {
  if (!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(config.currentVersion) || !config.publicKey.trim() || !config.endpoints.length) throw new Error('Packaged release version, signed feed endpoints and public key must be configured by the application owner.')
  for (const endpoint of config.endpoints) { const url = new URL(endpoint.replace(/\{\{(?:target|arch|current_version)\}\}/g, 'value')); if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('Update feeds must be credential-free HTTPS URLs.') }
  return { endpoints: [...config.endpoints], pubkey: config.publicKey, timeoutMs: 10000 }
}
export async function checkApplicationRelease(config: ReleaseConfiguration, check: (version: string, options: CheckUpdateOptions) => Promise<UpdateResult> = async (version, options) => (await import('@gpuix/native')).checkUpdate(version, options)): Promise<ReleaseInformation> {
  const options = releaseOptions(config)
  try { const update = await check(config.currentVersion, options); return update ? { currentVersion: config.currentVersion, available: true, version: update.version, date: update.date, format: update.format } : { currentVersion: config.currentVersion, available: false } }
  catch { throw new Error('Signed release check failed. No installer was downloaded or executed.') }
}
export type AwakeSupport = { supported: boolean; program: string | null; reason: string }
export async function inspectAwakeSupport(platform = process.platform, executable = async (path: string) => { try { await access(path, constants.X_OK); return true } catch { return false } }): Promise<AwakeSupport> {
  if (platform === 'darwin' && await executable('/usr/bin/caffeinate')) return { supported: true, program: '/usr/bin/caffeinate', reason: 'Explicit macOS caffeinate idle-sleep inhibition.' }
  if (platform === 'linux' && await executable('/usr/bin/systemd-inhibit') && await executable('/usr/bin/sleep')) return { supported: true, program: '/usr/bin/systemd-inhibit', reason: 'Explicit logind idle/sleep inhibitor; daemon authorisation is checked when started.' }
  return { supported: false, program: null, reason: 'No supported OS sleep-inhibition adapter is available. Windows requires a native SetThreadExecutionState bridge.' }
}
export function awakeCommand(platform: string, pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid owner process')
  if (platform === 'darwin') return { program: '/usr/bin/caffeinate', args: ['-i', '-w', String(pid)] }
  if (platform === 'linux') return { program: '/usr/bin/systemd-inhibit', args: ['--what=idle:sleep', '--mode=block', '--who=OpulentDevin', '--why=Explicit keep-awake request', '/usr/bin/sleep', 'infinity'] }
  throw new Error('Power adapter unavailable')
}
export class AwakeController {
  private child: ChildProcess | null = null
  constructor(private readonly spawnProcess: typeof spawn = spawn, private readonly platform = process.platform) {}
  get active() { return this.child !== null && this.child.exitCode === null && this.child.signalCode === null }
  async enable(confirmed: boolean) {
    if (!confirmed) throw new Error('Explicit power-policy confirmation is required.')
    if (this.active) return
    const support = await inspectAwakeSupport(this.platform)
    if (!support.supported) throw new Error(support.reason)
    const command = awakeCommand(this.platform, process.pid)
    const child = this.spawnProcess(command.program, command.args, { stdio: 'ignore', shell: false, detached: true }); this.child = child
    const stopGroup = () => { if (child.pid && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') } } }
    process.once('exit', stopGroup)
    child.once('exit', () => process.off('exit', stopGroup))
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, 250); child.once('error', () => { clearTimeout(timer); this.child = null; reject(new Error('OS sleep inhibition was refused.')) }); child.once('exit', () => { clearTimeout(timer); if (this.child === child) this.child = null; reject(new Error('OS sleep inhibitor exited before readiness.')) }) })
  }
  async disable() {
    const child = this.child; if (!child) return
    this.child = null
    if (child.exitCode !== null || child.signalCode !== null) return
    const signal = (value: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, value); else child.kill(value) } catch { child.kill(value) } }
    await new Promise<void>((resolve, reject) => { const hard = setTimeout(() => signal('SIGKILL'), 2000); const deadline = setTimeout(() => { clearTimeout(hard); reject(new Error('Owned sleep inhibitor did not stop.')) }, 5000); child.once('exit', () => { clearTimeout(hard); clearTimeout(deadline); resolve() }); signal('SIGTERM') })
  }
}
export const shellCommandIds = ['window.focus', 'window.minimise', 'window.maximise', 'window.fullscreen', 'app.checkUpdate', 'app.quit', 'app.quitWhenIdle'] as const
