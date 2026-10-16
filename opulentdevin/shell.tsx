import { useEffect, useRef, useState } from 'react'
import { useGpuix } from '@gpuix/react'
import type { Backend } from './backend'
import { AwakeController, checkApplicationRelease, inspectAwakeSupport, nativeShellLimits, QuitGuard, validateShellLink, type ReleaseConfiguration, type ReleaseInformation, type QuitSnapshot } from './host'
import type { ParsedConnectLink } from './zuse-runtime/packages/contracts/src/connect-links'
import { SettingsAction as Action, SettingsCard as Card, SettingsNote as Note, ConfirmAction, useSettingsAction } from './settings-controls'

export type ShellProps = { backends: readonly Backend[]; onQuit: () => Promise<void>; onError: (error: unknown) => void; release?: ReleaseConfiguration; pendingLink?: string; onConnectLink?: (link: ParsedConnectLink) => Promise<void>; onDismissLink?: () => void }
export function ShellControls({ backends, onQuit, onError, release, pendingLink, onConnectLink, onDismissLink }: ShellProps) {
  const { renderer: nativeRenderer } = useGpuix()
  const callbacks = useRef({ backends, onQuit }); callbacks.current = { backends, onQuit }
  const [guard] = useState(() => new QuitGuard(() => callbacks.current.backends, () => callbacks.current.onQuit()))
  const [awake] = useState(() => new AwakeController())
  const [quitState, setQuitState] = useState<QuitSnapshot | null>(null)
  const [idle, setIdle] = useState(false)
  const [power, setPower] = useState('Power policy unchanged; check availability explicitly.')
  const [releaseInfo, setReleaseInfo] = useState<ReleaseInformation | null>(null)
  const { busy, message, run } = useSettingsAction(onError)
  useEffect(() => () => { guard.dispose(); void awake.disable().catch(() => {}) }, [guard, awake])
  let link: ParsedConnectLink | null = null
  let linkInvalid = false
  if (pendingLink) { try { link = validateShellLink(pendingLink) } catch { linkInvalid = true } }
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <Card title="Native window"><div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}><Action label="Focus window" disabled={!nativeRenderer?.activateWindow} onClick={() => nativeRenderer?.activateWindow?.()} /><Action label="Minimise window" disabled={!nativeRenderer?.minimizeWindow} onClick={() => nativeRenderer?.minimizeWindow?.()} /><Action label="Maximise or restore window" disabled={!nativeRenderer?.zoomWindow} onClick={() => nativeRenderer?.zoomWindow?.()} /><Action label="Toggle fullscreen" disabled={!nativeRenderer?.toggleFullscreen} onClick={() => nativeRenderer?.toggleFullscreen?.()} /></div><Note>{nativeShellLimits.alwaysOnTop}</Note></Card>
    <Card title="Guarded quit"><Note>Checks all backends supplied by the app, including archived sessions. Running and booting agents block unconfirmed quit. No agent is interrupted merely by checking.</Note><Action label="Check running agents" disabled={busy} onClick={() => { void run('Check running agents', async () => setQuitState(await guard.check())) }} />{quitState && <Note>{quitState.active} active agents across {quitState.environments} environments. Quit checks again before closing.</Note>}
      <Action label="Quit if idle" disabled={busy} onClick={() => { void run('Quit when idle now', () => guard.request(false)) }} />
      <ConfirmAction label="Quit and interrupt active work" disabled={busy} detail="Quit even if agents are running or booting? Parent cleanup may terminate local sessions and tunnels. This cannot guarantee remote tasks stop." action={() => { void run('Confirmed quit', () => guard.request(true)) }} />
      {!idle ? <ConfirmAction label="Quit when agents become idle" disabled={busy} detail="Keep checking known environments and quit automatically once there are no active agents? Unknown/error state never triggers quit." action={() => { setIdle(true); guard.whenIdle(value => { setQuitState(value); if (!value) onError(new Error('Idle quit check unavailable; app remains open.')) }) }} /> : <Action label="Cancel queued quit" onClick={() => { guard.cancelIdle(); setIdle(false) }} />}
      <Note warning>{nativeShellLimits.closeGuard}</Note>
    </Card>
    <Card title="Application release check"><Note>This checks a configured signed native bundle feed only. No download, install or restart is performed, and the Electron/Zuse updater is never called.</Note>{!release && <Note warning>No OpulentDevin signed release feed/public key is configured by the packager.</Note>}<Action label="Check application release" disabled={busy || !release} onClick={() => { if (release) void run('Check signed release', async () => setReleaseInfo(await checkApplicationRelease(release))) }} />{releaseInfo && <Note>{releaseInfo.available ? `Release ${releaseInfo.version} is available (${releaseInfo.format}); install through the trusted distribution channel.` : `No newer signed release than ${releaseInfo.currentVersion}.`}</Note>}</Card>
    <Card title="Connection link handoff"><Note>{nativeShellLimits.deepLinks}</Note>{linkInvalid && <Note warning>Unsupported or malformed link rejected. Its raw contents were not displayed.</Note>}{link && <><Note>Verified link syntax: {link.kind}. The pairing code stays in memory and is not shown. Verify the source before connecting.</Note><ConfirmAction label="Accept pending connection link" disabled={busy || !onConnectLink} detail="Pass this validated pairing link to the app connection owner? It may contact the supplied environment; identity must still be verified before switching." action={() => { if (onConnectLink && link) void run('Dispatch connection link', async () => { await onConnectLink(link); onDismissLink?.() }) }} /></>}{pendingLink && <Action label="Discard pending link" onClick={() => onDismissLink?.()} />}</Card>
    <Card title="Keep this computer awake"><Note>{power}</Note><Action label="Inspect sleep inhibitor support" disabled={busy} onClick={() => { void run('Inspect power support', async () => setPower((await inspectAwakeSupport()).reason)) }} /><ConfirmAction label="Enable sleep inhibition" disabled={busy} detail="Explicitly inhibit idle sleep on this computer until disabled or this control unmounts? This can consume power. No automatic activity-based mode is enabled." action={() => { void run('Enable sleep inhibitor', async () => { await awake.enable(true); setPower(awake.active ? 'Owned sleep inhibitor active.' : 'Sleep inhibitor not active.') }) }} /><Action label="Disable sleep inhibition" disabled={busy} onClick={() => { void run('Disable sleep inhibitor', async () => { await awake.disable(); setPower('Owned sleep inhibitor stopped.') }) }} /></Card>
    <Note>{nativeShellLimits.menu}</Note>{message && <Note>{message}</Note>}
  </div>
}
