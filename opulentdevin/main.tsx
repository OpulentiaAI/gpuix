import { activateNativeRuntime } from './install-native'
import type { Backend } from './backend'
import { dataDirectory } from './preferences'

activateNativeRuntime()
const { render, createRenderer, startFrameLoop } = await import('@gpuix/react')
const { nativeCloseEvents, asNativeCloseRenderer } = await import('./native-close')
const { OwnedApp } = await import('./owned-app')
const { ConnectedApp } = await import('./app')
const { connectBackend } = await import('./backend')
const { LocalServerManager } = await import('./local-server')

const port = Number(process.env.OPULENTDEVIN_PORT ?? 41739)
const external = process.env.OPULENTDEVIN_REMOTE === '1'
const manager = external ? null : new LocalServerManager({ dataDir: dataDirectory, port })
let externalBackend: Backend | null = null
let startupError: string | undefined
if (external) {
  try { externalBackend = await connectBackend({ host: '127.0.0.1', port }) }
  catch { startupError = 'The explicitly selected external backend could not be reached.' }
} else {
  try { await manager!.start() }
  catch { startupError = 'Owned local server startup failed. Check the configured port and data-directory lock, then retry.' }
}
const cleanup = async () => { await manager?.stop(); await externalBackend?.dispose() }
let exiting = false
const shutdown = async () => {
  if (exiting) return
  exiting = true
  try { await cleanup() }
  finally { process.exit(0) }
}
process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT', () => { void shutdown() })
process.on('exit', () => manager?.terminateOwnedProcess())
const renderer = createRenderer(event => { nativeCloseEvents.dispatch(event) })
const closeRenderer = asNativeCloseRenderer(renderer)
if (!closeRenderer) { await cleanup(); throw new Error('The verified native close-guard runtime is required before opening the window.') }
closeRenderer.setCloseGuard(true)
try {
  renderer.init({ title: 'OpulentDevin', appName: 'OpulentDevin', appId: 'ai.opulent.devin', width: 1200, height: 760, minWidth: 900, minHeight: 640, focus: process.env.GPUIX_BACKGROUND !== '1' })
  render(manager ? <OwnedApp manager={manager} initialError={startupError} onCloseCleanup={cleanup} /> : <ConnectedApp onCloseCleanup={cleanup} backend={externalBackend} connectionOptions={{ host: '127.0.0.1', port }} connectionError={startupError} />, { renderer })
  startFrameLoop(renderer, { onTerminated: () => { void shutdown() } })
} catch (error) {
  closeRenderer.setCloseGuard(false)
  await cleanup()
  throw error
}
