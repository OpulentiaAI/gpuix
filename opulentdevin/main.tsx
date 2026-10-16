import { render } from '@gpuix/react'
import { OwnedApp } from './owned-app'
import { ConnectedApp } from './app'
import { connectBackend, type Backend } from './backend'
import { LocalServerManager } from './local-server'
import { dataDirectory } from './preferences'

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
let exiting = false
const shutdown = async () => {
  if (exiting) return
  exiting = true
  try { await manager?.stop(); await externalBackend?.dispose() }
  finally { process.exit(0) }
}
process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT', () => { void shutdown() })
process.on('exit', () => manager?.terminateOwnedProcess())
render(manager ? <OwnedApp manager={manager} initialError={startupError} /> : <ConnectedApp backend={externalBackend} connectionOptions={{ host: '127.0.0.1', port }} connectionError={startupError} />, { title: 'OpulentDevin', appName: 'OpulentDevin', appId: 'ai.opulent.devin', width: 1200, height: 760, minWidth: 900, minHeight: 640, focus: process.env.GPUIX_BACKGROUND !== '1' })
