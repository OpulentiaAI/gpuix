import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFile } from 'node:fs/promises'
import { Effect, Schema } from 'effect'
import { connectBackend, type Backend } from './backend'
import { dataDirectory } from './preferences'
import { sshTarget, mcpAddArguments, mcpStdioArguments } from './settings-safe'
import { AtomicProfileStore } from './zuse-runtime/apps/desktop/src/profile-store'
import { RemoteEnvironmentProfile } from './zuse-runtime/packages/contracts/src/ssh'
import { COMPATIBLE_SERVE_RUNTIME_VERSION } from './zuse-runtime/packages/contracts/src/serve'
import { discoverSshHosts, openTunnel, parseLaunchResult, remoteBootstrapScript, resolveSshTarget } from './zuse-runtime/packages/ssh/src/index'

const executeFile = promisify(execFile)
const profiles = new AtomicProfileStore<RemoteEnvironmentProfile>(dataDirectory, { fileName: 'remote-environments.json', decode: Schema.decodeUnknownSync(RemoteEnvironmentProfile) })
let loaded: Promise<ReadonlyArray<RemoteEnvironmentProfile>> | null = null
const connections = new Map<string, Backend>()
export function listSshProfiles() { return loaded ??= profiles.load() }
export function discoverNativeSsh() { return Effect.runPromise(discoverSshHosts()) }
export async function removeSshProfile(id: string) { await connections.get(id)?.dispose(); await profiles.remove(id); loaded = Promise.resolve(profiles.list()) }
export async function openSshBackend(host: string, user: string, port: string, label: string, signal: AbortSignal): Promise<{ backend: Backend; environmentId: string }> {
  await listSshProfiles()
  const target = await Effect.runPromise(resolveSshTarget(sshTarget(host, user, port)))
  if (signal.aborted) throw new Error('SSH cancelled')
  const id = `ssh_${createHash('sha256').update(JSON.stringify([target.alias, target.hostname, target.username, target.port])).digest('hex').slice(0, 24)}`
  const saved = profiles.list().find(profile => profile.profileId === id)
  const existing = connections.get(id)
  if (existing) throw new Error('This SSH backend is already owned by the app. Switch back to it rather than opening a duplicate.')
  const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', ...(target.port ? ['-p', String(target.port)] : []), target.username ? `${target.username}@${target.alias}` : target.alias, 'sh', '-s']
  const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'ignore'], shell: false, signal })
  child.stdin.on('error', () => {})
  child.stdin.end(remoteBootstrapScript(COMPATIBLE_SERVE_RUNTIME_VERSION))
  let output = ''
  child.stdout.on('data', chunk => { output = (output + String(chunk)).slice(-65536) })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('SSH bootstrap timed out')) }, 120000)
    child.once('error', () => { clearTimeout(timer); reject(new Error('SSH bootstrap could not start')) })
    child.once('exit', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error('SSH bootstrap failed; verify trusted host and key authentication')) })
  })
  const launch = parseLaunchResult(output.trim().split(/\r?\n/).at(-1) ?? '')
  output = ''
  if (!Number.isInteger(launch.remotePort) || launch.remotePort < 1 || launch.remotePort > 65535 || signal.aborted) throw new Error('Invalid or cancelled SSH launch')
  const tunnel = await Effect.runPromise(openTunnel({ target, remotePort: launch.remotePort }))
  let backend: Backend | undefined
  try {
    if (signal.aborted) throw new Error('SSH cancelled')
    backend = await connectBackend({ host: '127.0.0.1', port: tunnel.localPort, wsBaseUrl: tunnel.wsBaseUrl })
    const descriptor = await backend.run(backend.client['connect.describe']().pipe(Effect.timeout(15000)))
    if (saved && saved.environmentId !== descriptor.environmentId) throw new Error('Remote identity changed; remove the saved profile before reconnecting')
    if (signal.aborted) throw new Error('SSH cancelled')
    const profile = RemoteEnvironmentProfile.make({ profileId: id, environmentId: descriptor.environmentId, label: label.trim() || target.alias, target, lastConnectedAt: new Date().toISOString() })
    await profiles.put(profile); loaded = Promise.resolve(profiles.list())
    const connected = backend
    const owned: Backend = { ...connected, dispose: async () => { connections.delete(id); try { await connected.dispose() } finally { await tunnel.close() } } }
    connections.set(id, owned)
    return { backend: owned, environmentId: descriptor.environmentId }
  } catch { await backend?.dispose(); await tunnel.close(); throw new Error('SSH handshake failed, identity changed or connection cancelled') }
}
export async function addNativeMcp(provider: 'claude' | 'codex', name: string, url: string, existingNames: readonly string[], stdio?: { executable: string; argumentsText: string }) {
  if (existingNames.includes(name)) throw new Error('A server with this name already exists; replacement is not permitted.')
  const args = stdio ? mcpStdioArguments(provider, name, stdio.executable, stdio.argumentsText) : mcpAddArguments(provider, name, url)
  const nativePath = provider === 'claude' ? join(homedir(), '.claude.json') : join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml')
  let nativeConfig = ''
  try { nativeConfig = await readFile(nativePath, 'utf8') } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new Error('Native provider configuration could not be safely read.') }
  if (nativeConfig.includes(name)) throw new Error('This name already occurs in native provider configuration. Choose a new unique name; replacement is not permitted.')
  try { await executeFile(provider, [...args], { timeout: 30000, maxBuffer: 65536, windowsHide: true, shell: false }) }
  catch { throw new Error('Provider MCP setup failed. Confirm its CLI is installed and supports native MCP add. Raw output was not retained.') }
}
export async function closeNativeSsh() { await Promise.all([...connections.values()].map(connection => connection.dispose())) }
