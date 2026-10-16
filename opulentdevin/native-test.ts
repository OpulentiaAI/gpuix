import { activateNativeRuntime } from './install-native'
import { launch, type App } from '@gpuix/react/automation'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
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
const binaryPath = activateNativeRuntime(import.meta.dir)
const binarySha = createHash('sha256').update(await readFile(binaryPath)).digest('hex')
console.log('NATIVE_BINARY', binaryPath, binarySha)
await writeFile(join(root, 'native-binary.json'), JSON.stringify({ binaryPath, binarySha }))
const env = { ...process.env, NAPI_RS_NATIVE_LIBRARY_PATH: binaryPath, XDG_RUNTIME_DIR: runtime, WAYLAND_DISPLAY: 'native-smoke', ZED_HEADLESS: undefined, OPULENTDEVIN_DATA_DIR: data, OPULENTDEVIN_PORT: '41747', GPUIX_BACKGROUND: '0' }
const weston = spawn('weston', ['--backend=x11', '--renderer=gl', '--socket=native-smoke', '--width=1440', '--height=940', '--idle-time=0', '--no-config'], { env: { ...env, WAYLAND_DISPLAY: undefined }, stdio: ['ignore', 'ignore', 'inherit'] })
let app: App | undefined
let backend: Backend | undefined
const results: { name: string; status: 'passed' | 'failed' | 'blocked'; detail: string }[] = []
async function check(name: string, operation: () => Promise<string>) {
  try { const detail = await operation(); results.push({ name, status: 'passed', detail }); console.log('PASS', name, detail); return true }
  catch (error) { const detail = error instanceof Error ? error.stack ?? error.message : String(error); results.push({ name, status: 'failed', detail }); console.log('FAIL', name, detail); return false }
}
async function bounded<T>(promise: Promise<T>, label: string, ms = 30000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms) })]) }
  finally { clearTimeout(timer) }
}
async function click(id: string) { if (!app) throw new Error('App unavailable'); await app.getByTestId(id).waitFor({ timeoutMs: 5000 }); await delay(150); await app.getByTestId(id).click() }
async function text(value: string) { if (!app) throw new Error('App unavailable'); await delay(100); const found = (await app.getByText(value).all()).filter(node => node.text === value); if (found.length !== 1) throw new Error(`Exact text ${value}: ${found.length} matches`); const bounds = found[0].bounds ?? (await app.call('getBounds', { elementId: found[0].id })).bounds; if (!bounds) throw new Error(`No bounds for ${value}`); await app.mouse.click({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }) }
async function selectChat(chatId: string, sessionId: string) {
  await click(`session-${chatId}`)
  for (let attempt = 0; attempt < 30; attempt++) { const prefs = JSON.parse(await readFile(join(data, 'ui.json'), 'utf8')) as { sessionId: string }; if (prefs.sessionId === sessionId) { await delay(100); return }; await delay(100) }
  throw new Error(`Chat ${chatId} did not select session ${sessionId}`)
}
async function selectedComposer(expected: string) {
  await app!.getByTestId('composer').press('ctrl-end !')
  let confirmed = false
  for (let attempt = 0; attempt < 20; attempt++) {
    const names = await readdir(join(data, 'composer-drafts'))
    const drafts = await Promise.all(names.filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(data, 'composer-drafts', name), 'utf8')) as { input: { text: string } }))
    if (drafts.some(draft => draft.input.text === expected + '!')) { confirmed = true; break }
    await delay(100)
  }
  if (!confirmed) throw new Error(`Restored native composer did not append to ${expected}`)
  await app!.getByTestId('composer').press('backspace')
}
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
    await click(`session-${created.chat.id}`); await click('workbench-toggle');
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
  if (added) await check('composer drafts across chats and workspaces', async () => {
    backend ??= await connectBackend({ host: '127.0.0.1', port: 41747 })
    const folder = (await backend.workspaces.list({})).find(item => item.path === workspace)
    if (!folder) throw new Error('Workspace missing')
    const first = await backend.chats.create({ projectId: folder.id, providerId: 'claude', model: 'default', title: 'Draft first' })
    const second = await backend.chats.create({ projectId: folder.id, providerId: 'claude', model: 'default', title: 'Draft second' })
    await selectChat(first.chat.id, first.initialSession.id); await app!.getByTestId('composer').fill('FIRST DRAFT')
    await selectChat(second.chat.id, second.initialSession.id); await app!.getByTestId('composer').fill('SECOND DRAFT')
    await selectChat(first.chat.id, first.initialSession.id)
    await selectedComposer('FIRST DRAFT')
    const otherPath = join(root, 'other-project'); await mkdir(otherPath)
    await click('workspace-picker'); await app!.getByTestId('workspace-path').fill(otherPath); await click('workspace-add')
    await app!.getByTestId('workspace-picker').getByText('other-project').waitFor({ timeoutMs: 5000 })
    await app!.getByTestId('composer').fill('OTHER WORKSPACE DRAFT')
    await click('workspace-picker'); await app!.getByText(workspace).click(); await selectChat(first.chat.id, first.initialSession.id)
    await selectedComposer('FIRST DRAFT')
    return 'Chat and workspace draft restored without submitting any message'
  })
  if (added) await check('native UTF16 selection revision and syntax', async () => {
    if (!(await app!.getByText('Files').count())) await click('workbench-toggle')
    await text('Files'); await text('smoke.txt'); await app!.getByTestId('native-file-editor').waitFor({ timeoutMs: 5000 })
    await app!.getByTestId('native-file-editor').fill('const emoji = "😀";')
    await app!.getByTestId('native-file-editor').press('ctrl-a')
    await app!.getByText('19 selected').waitFor({ timeoutMs: 5000 })
    await click('editor-find'); const findInput = (await app!.getByTestId('editor-find').all()).find(node => node.type === 'input'); if (!findInput) throw new Error('Find input absent'); await app!.call('keystrokes', { elementId: findInput.id, keys: 'ctrl-a 😀' }); await click('editor-select-match')
    await app!.getByText('2 selected').waitFor({ timeoutMs: 5000 })
    const editor = await app!.getByTestId('native-file-editor').element()
    await writeFile(join(root, 'selection-editor.json'), JSON.stringify(editor, null, 2))
    await click('editor-annotate-selection'); await app!.getByTestId('editor-annotation-comment').fill('Explain selected emoji'); await click('editor-confirm-annotation')
    let annotationSaved = false
    for (let attempt = 0; attempt < 20; attempt++) {
      const names = await readdir(join(data, 'composer-drafts'))
      const drafts = await Promise.all(names.filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(data, 'composer-drafts', name), 'utf8')) as { input: { annotations: { relPath?: string; comment?: string; startLine?: number; endLine?: number }[] } }))
      if (drafts.some(draft => draft.input.annotations.some(note => note.relPath === 'smoke.txt' && note.comment === 'Explain selected emoji' && note.startLine === 1 && note.endLine === 1))) { annotationSaved = true; break }
      await delay(100)
    }
    if (!annotationSaved) throw new Error('Native annotation was not appended to composer draft')
    await click('editor-syntax-preview'); await app!.getByTestId('editor-syntax-preview').waitFor({ timeoutMs: 5000 })
    console.log('NATIVE_SYNTAX_READY', root)
    return 'UTF16 full range19 and emoji range2 observed; revision-fenced Select match acknowledged; syntax preview mounted'
  })
  if (added) await check('durable editor buffers and conflict fence', async () => {
    await click('editor-edit-text'); await app!.getByTestId('native-file-editor').fill('DURABLE EDITOR DRAFT')
    await click('workbench-toggle'); await click('workbench-toggle'); await app!.getByTestId('native-file-editor').waitFor({ timeoutMs: 5000 })
    await app!.getByTestId('native-file-editor').press('ctrl-end !'); await click('editor-save')
    for (let attempt = 0; attempt < 20; attempt++) { if (await readFile(join(workspace, 'smoke.txt'), 'utf8') === 'DURABLE EDITOR DRAFT!') break; if (attempt === 19) throw new Error('Pane reopen lost draft'); await delay(100) }
    await app!.getByTestId('native-file-editor').fill('RECOVER AFTER RESTART')
    await backend?.dispose(); backend = undefined; await app!.close(); await delay(1500); await start(); await click('workbench-toggle'); await text('Files')
    await app!.getByTestId('native-file-editor').waitFor({ timeoutMs: 5000 }); await app!.getByTestId('native-file-editor').press('ctrl-end !'); await click('editor-save')
    for (let attempt = 0; attempt < 20; attempt++) { if (await readFile(join(workspace, 'smoke.txt'), 'utf8') === 'RECOVER AFTER RESTART!') break; if (attempt === 19) throw new Error('Process restart lost draft'); await delay(100) }
    await app!.getByTestId('native-file-editor').fill('CONFLICT DRAFT'); await click('workbench-toggle'); await writeFile(join(workspace, 'smoke.txt'), 'EXTERNAL CHANGE'); await click('workbench-toggle')
    await app!.getByText('Recovered draft differs').waitFor({ timeoutMs: 5000 }); await click('editor-save'); await delay(150)
    if (await readFile(join(workspace, 'smoke.txt'), 'utf8') !== 'EXTERNAL CHANGE') throw new Error('Conflict overwrote external content')
    await click('workbench-discard-draft'); await click('workbench-confirm-discard-draft')
    return 'Dirty buffers survive pane removal and process restart; changed disk baseline blocks save; confirmed discard preserves external bytes'
  })
  await writeFile(join(root, 'painted-text.json'), JSON.stringify(await app!.call('getPaintedText', {}), null, 2))
  await writeFile(join(root, 'final-tree.json'), JSON.stringify(await app!.call('getTree', {}), null, 2))
  if (process.env.NATIVE_SMOKE_HOLD) await delay(Number(process.env.NATIVE_SMOKE_HOLD) * 1000)
} catch (error) { results.push({ name: 'harness', status: 'failed', detail: String(error) }); console.error(error) }
finally { await backend?.dispose(); await app?.close(); weston.kill('SIGTERM'); await delay(1200); await writeFile(join(root, 'results.json'), JSON.stringify(results, null, 2)); console.log('RESULTS', join(root, 'results.json'), JSON.stringify(results)); }
process.exitCode = results.some(result => result.status !== 'passed') ? 1 : 0
