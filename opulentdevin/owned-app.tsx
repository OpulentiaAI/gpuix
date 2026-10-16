import { useEffect, useRef, useState } from 'react'
import { App } from './app'
import type { Backend } from './backend'
import { LocalServerManager, type LocalServerConnection } from './local-server'
import { NativeCloseGuard } from './native-close'
import { EnvironmentId } from './zuse-runtime/packages/contracts/src/ids'

export function OwnedApp({ manager, initialError, onCloseCleanup }: { manager: LocalServerManager; initialError?: string; onCloseCleanup?: () => Promise<void> }) {
  const [local, setLocal] = useState<LocalServerConnection | null>(() => manager.currentConnection())
  const [status, setStatus] = useState(() => manager.snapshot())
  const [remote, setRemote] = useState<LocalServerConnection | null>(null)
  const remoteRef = useRef<LocalServerConnection | null>(null)
  const [error, setError] = useState(initialError ?? '')
  const [failedBackend, setFailedBackend] = useState<Backend | null>(null)
  useEffect(() => manager.subscribe(next => { setStatus(next); setLocal(manager.currentConnection()) }), [manager])
  useEffect(() => () => { void remoteRef.current?.backend.dispose(); remoteRef.current = null }, [])
  const switchRemote = (backend: Backend, environmentId: string) => {
    if (!environmentId.trim()) { void backend.dispose(); setError('Remote identity was not verified.'); return }
    const previous = remoteRef.current
    const next = { backend, environmentId }
    remoteRef.current = next; setRemote(next); setFailedBackend(null); setError('')
    if (previous && previous.backend !== backend) void previous.backend.dispose()
  }
  const reconnect = () => {
    if (remoteRef.current) { const previous = remoteRef.current; remoteRef.current = null; setRemote(null); setError(''); void previous.backend.dispose(); return }
    void manager.reconnect().then(() => { setFailedBackend(null); setError('') }).catch(() => setError('Owned local connection could not be restored. Check its process and port; no foreign server was adopted.'))
  }
  const current = remote ?? local
  const identity = current?.environmentId ?? status.environmentId
  const closeBackends = [local?.backend, remote?.backend].filter((value): value is Backend => Boolean(value))
  const closeCleanup = async () => { await remoteRef.current?.backend.dispose(); if (onCloseCleanup) await onCloseCleanup(); else await manager.stop() }
  const content = !identity ? <div style={{ display: 'flex', flexDirection: 'column', padding: 28, gap: 12 }}><text>Starting the owned local environment…</text><text>{error || status.status}</text><div testId="owned-server-retry" role="button" tabIndex={0} onClick={reconnect}><text>Retry local startup</text></div></div>
  : <App onCloseCleanup={closeCleanup} quitBackends={closeBackends} key={identity} backend={current?.backend === failedBackend ? null : current?.backend ?? null} environmentId={EnvironmentId.make(identity)} connectionStatus={current?.backend === failedBackend ? 'interrupted' : remote ? 'remote' : status.status} connectionError={error || undefined} reconnect={reconnect} reportFailure={() => { setFailedBackend(current?.backend ?? null); setError(remote ? 'Remote connection interrupted. Return to local settings to reconnect manually.' : 'Local connection interrupted. Reconnect explicitly; no new process was adopted.') }} onConnect={switchRemote} localServer={remote ? undefined : manager} />
  return <div style={{ display: 'flex', flexDirection: 'column', position: 'relative', width: '100%', height: '100%' }}>{content}<NativeCloseGuard backends={closeBackends} onCloseCleanup={closeCleanup} onError={cause => setError(cause instanceof Error ? cause.message : String(cause))} /></div>
}
