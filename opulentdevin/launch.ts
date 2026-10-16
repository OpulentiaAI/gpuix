import { spawn } from 'node:child_process'
import { mkdtemp, chmod, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = fileURLToPath(new URL('.', import.meta.url))
const entry = process.argv.includes('--built') ? 'dist/main.js' : 'main.tsx'
let compositor: ReturnType<typeof spawn> | undefined
let app: ReturnType<typeof spawn> | undefined
let runtime: string | undefined
let closing = false
async function close() {
  if (closing) return
  closing = true
  app?.kill('SIGTERM')
  compositor?.kill('SIGTERM')
  if (runtime) await rm(runtime, { recursive: true, force: true })
}
process.once('SIGTERM', () => { void close() })
process.once('SIGINT', () => { void close() })
try {
  const env = { ...process.env }
  if (process.platform === 'linux' && !env.WAYLAND_DISPLAY) {
    if (!env.DISPLAY) throw new Error('A Wayland or X11 desktop is required; no display is available.')
    runtime = await mkdtemp(join(tmpdir(), 'opulentdevin-wayland-'))
    await chmod(runtime, 0o700)
    const socket = 'opulentdevin'
    compositor = spawn('weston', ['--backend=x11', '--renderer=gl', `--socket=${socket}`, '--width=1240', '--height=820', '--idle-time=0', '--no-config'], { env: { ...env, XDG_RUNTIME_DIR: runtime }, stdio: ['ignore', 'inherit', 'inherit'] })
    let launchError: Error | undefined
    compositor.once('error', error => { launchError = error })
    let ready = false
    for (let attempt = 0; attempt < 50; attempt++) {
      if (launchError) throw new Error(`Weston is required for this GPUIX Linux release on X11: ${launchError.message}`)
      if (compositor.exitCode !== null) throw new Error('Weston exited before creating a native Wayland surface.')
      try { await access(join(runtime, socket)); ready = true; break } catch { await Bun.sleep(100) }
    }
    if (!ready) throw new Error('Native Wayland compositor did not become ready.')
    env.XDG_RUNTIME_DIR = runtime
    env.WAYLAND_DISPLAY = socket
  }
  app = spawn(process.execPath, [entry], { cwd: appRoot, env, stdio: 'inherit' })
  const status = await new Promise<number>((resolve, reject) => { app!.once('error', reject); app!.once('exit', code => resolve(code ?? 1)) })
  process.exitCode = status
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally { await close() }
