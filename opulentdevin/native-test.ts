import { launch, type App } from '@gpuix/react/automation'
import { spawn } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { connectBackend, type Backend } from './backend'
import { PtyOwnerId } from './zuse-runtime/packages/contracts/src/ids'

const root = await mkdtemp('/opulent/work/native-smoke-')
const runtime = join(root, 'runtime')
const workspace = join(root, 'project')
const data = join(root, 'data')
await Promise.all([mkdir(runtime), mkdir(workspace), mkdir(data)])
await chmod(runtime, 0o700)
await writeFile(join(workspace, 'smoke.txt'), 'Before native edit\n')
const env = { ...process.env, XDG_RUNTIME_DIR: runtime, WAYLAND_DISPLAY: 'native-smoke', ZED_HEADLESS: undefined, OPULENTDEVIN_DATA_DIR: data, OPULENTDEVIN_PORT: '41747', GPUIX_BACKGROUND: '0' }
const weston = spawn('weston', ['--backend=x11', '--renderer=gl', '--socket=native-smoke', '--width=1440', '--height=940', '--idle-time=0', '--no-config'], { env: { ...env, WAYLAND_DISPLAY: undefined }, stdio: ['ignore', 'ignore', 'inherit'] })
let app: App | undefined
let backend: Backend | undefined
const results: { name: string; status: 'passed' | 'failed' | 'blocked'; detail: string }[] = []
async function check(name: string, operation: () => Promise<string>) {
  try { const detail = await operation(); results.push({ name, status: 'passed', detail }); console.log('PASS', name, detail); return true }
  catch (error) { const detail = String(error); results.push({ name, status: 'failed', detail }); console.log('FAIL', name, detail); return false }
}
async function bounded<T>(promise: Promise<T>, label: string, ms = 30000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms) })]) }
  finally { clearTimeout(timer) }
}
async function click(id: string) { if (!app) throw new Error('App unavailable'); await app.getByTestId(id).waitFor({ timeoutMs: 5000 }); await app.getByTestId(id).click() }
async function text(value: string) { if (!app) throw new Error('App unavailable'); await app.getByText(value).waitFor({ timeoutMs: 5000 }); await app.getByText(value).click() }
async function start() {
  app = await launch({ command: '/opulent/work/toolchain/node_modules/.bin/bun', args: ['main.tsx'], cwd: import.meta.dir, env })
  await bounded(app.getByTestId('workbench-toggle').waitFor({ timeoutMs: 30000 }), 'native launch')
}
try {
  let socket = false
  for (let i = 0; i < 50; i++) { try { await access(join(runtime, 'native-smoke')); socket = true; break } catch {} if (weston.exitCode !== null) break; await delay(200) }
  if (!socket) throw new Error('Weston failed to create its socket')
  await start()
  console.log('NATIVE_SMOKE_LIVE', root)
  await check('painted native app', async () => { const value = await app!.getByTestId('workspace-picker').bounds(); if (value.width <= 0 || value.height <= 0) throw new Error('Workspace picker has no painted bounds'); return JSON.stringify(value) })
  const added = await check('add workspace by native input', async () => {
    await click('workspace-picker'); await app!.getByTestId('workspace-path').waitFor({ timeoutMs: 5000 }); await app!.getByTestId('workspace-path').fill(workspace); await click('workspace-add');
    backend = await connectBackend({ host: '127.0.0.1', port: 41747 })
    await app!.getByTestId('workspace-picker').getByText('project').waitFor({ timeoutMs: 5000 })
    const folders = await backend.workspaces.list({}); if (!folders.some(folder => folder.path === workspace)) throw new Error('Native form did not add workspace')
    return workspace
  })
  if (added) await check('native file edit and save', async () => {
    await click('workbench-toggle'); await text('smoke.txt'); await app!.getByTestId('native-file-editor').waitFor({ timeoutMs: 5000 })
    await app!.getByTestId('native-file-editor').fill('NATIVE SAVE'); await click('editor-save')
    let saved = ''
    for (let attempt = 0; attempt < 20; attempt++) { saved = await readFile(join(workspace, 'smoke.txt'), 'utf8'); if (saved === 'NATIVE SAVE') break; await delay(100) }
    if (saved !== 'NATIVE SAVE') throw new Error(`Saved content mismatch: ${JSON.stringify(saved)}`)
    return saved
  })
  await check('settings tabs and provider list', async () => {
    await click('settings'); await click('settings-action-providers'); const providers = await backend?.providers.list({}); if (!providers?.length) throw new Error('Provider list unavailable')
    await app!.getByText(providers[0].displayName).waitFor({ timeoutMs: 5000 })
    for (const id of ['models', 'integrations', 'connections', 'cloud', 'host-setup', 'coverage', 'general']) await click(`settings-action-${id}`)
    await click('settings-action-close'); return `${providers.length} real provider entries; all settings tabs clicked`
  })
  await check('theme and sidebar persist across restart', async () => {
    await click('theme-toggle'); await click('sidebar-collapse'); await app!.getByTestId('sidebar-expand').waitFor({ timeoutMs: 5000 });
    const before = JSON.parse(await readFile(join(data, 'ui.json'), 'utf8')) as { theme: string; sidebar: boolean }
    if (before.theme !== 'light' || before.sidebar !== false) throw new Error('Preferences were not persisted')
    await backend?.dispose(); backend = undefined; await app!.close(); await delay(1500); await start()
    await app!.getByTestId('sidebar-expand').waitFor({ timeoutMs: 5000 }); await click('sidebar-expand')
    await app!.getByTestId('theme-toggle').waitFor({ timeoutMs: 5000 }); const label = await app!.getByTestId('theme-toggle').textContent(); if (label !== 'Dark') throw new Error(`Theme was not restored: ${label}`)
    return JSON.stringify(before)
  })
  if (added) await check('terminal lifecycle', async () => {
    backend ??= await connectBackend({ host: '127.0.0.1', port: 41747 })
    const folder = (await backend.workspaces.list({})).find(value => value.path === workspace)
    if (!folder) throw new Error('Workspace fixture absent')
    const created = await backend.chats.create({ projectId: folder.id, providerId: 'claude', model: 'default', title: 'Native smoke empty session' })
    if (created.initialMessage !== null) throw new Error('Unexpected initial message')
    await click(`session-${created.initialSession.id}`); await click('workbench-toggle');
    await app!.getByText('Terminal').waitFor({ timeoutMs: 5000 }); console.log('TERMINAL_TAB_BOUNDS', JSON.stringify(await app!.getByText('Terminal').bounds()))
    await text('Terminal');
    await delay(200)
    console.log('NEW_TERMINAL_BOUNDS', JSON.stringify(await app!.getByText('New terminal').bounds()))
    await click('workbench-new-terminal'); console.log('TERMINAL_OPEN_CLICKED')
    await delay(300)
    console.log('PTY_CATALOG_AFTER_CLICK', JSON.stringify(await backend.terminals.list({ ownerId: PtyOwnerId.make(`opulentdevin:${created.initialSession.id}`), includePolicy: true })))
    await app!.getByText('Close terminal').waitFor({ timeoutMs: 5000 })
    await app!.getByTestId('terminal-grid').press('p r i n t f space N A T I V E _ P T Y _ O K enter')
    for (let attempt = 0; attempt < 20; attempt++) { const output = await app!.getByTestId('terminal-grid').textContent(); if (output.includes('NATIVE_PTY_OK')) break; if (attempt === 19) throw new Error('Raw terminal output missing NATIVE_PTY_OK'); await delay(100) }
    await app!.getByTestId('terminal-grid').press('t o u c h space n a t i v e - p t y . t x t enter')
    let shellEffect = false
    for (let attempt = 0; attempt < 20; attempt++) { try { await access(join(workspace, 'native-pty.txt')); shellEffect = true; break } catch {} await delay(100) }
    if (!shellEffect) throw new Error('Raw grid input did not execute shell command')
    await text('Close terminal')
    let closed = false
    for (let attempt = 0; attempt < 20; attempt++) { const catalogue = await backend.terminals.list({ ownerId: PtyOwnerId.make(`opulentdevin:${created.initialSession.id}`), includePolicy: true }); const terminals = 'terminals' in catalogue ? catalogue.terminals : catalogue; if (!terminals.some(terminal => terminal.status === 'running')) { closed = true; break } await delay(100) }
    if (!closed) throw new Error('Native Close terminal left a running PTY')
    return 'Empty session, native terminal open, raw keys executed touch, grid output, close verified in PTY catalogue'
  })
  await writeFile(join(root, 'painted-text.json'), JSON.stringify(await app!.call('getPaintedText', {}), null, 2))
  await writeFile(join(root, 'final-tree.json'), JSON.stringify(await app!.call('getTree', {}), null, 2))
  if (process.env.NATIVE_SMOKE_HOLD) await delay(Number(process.env.NATIVE_SMOKE_HOLD) * 1000)
} catch (error) { results.push({ name: 'harness', status: 'failed', detail: String(error) }); console.error(error) }
finally { await backend?.dispose(); await app?.close(); weston.kill('SIGTERM'); await delay(1200); await writeFile(join(root, 'results.json'), JSON.stringify(results, null, 2)); console.log('RESULTS', join(root, 'results.json'), JSON.stringify(results)); }
process.exitCode = results.some(result => result.status !== 'passed') ? 1 : 0
