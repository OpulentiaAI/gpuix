import { useEffect, useState } from 'react'
import type { LocalServerManager } from './local-server'
import type { TailnetShareState } from './zuse-runtime/packages/contracts/src/tailnet'
import { SettingsCard as Card, SettingsNote as Note, SettingsAction as Action, ConfirmAction, useSettingsAction } from './settings-controls'

export function LocalServerControls({ manager, onError }: { manager: LocalServerManager; onError: (error: unknown) => void }) {
  const [state, setState] = useState(() => manager.snapshot())
  const [tailnet, setTailnet] = useState<TailnetShareState | null>(null)
  const { busy, message, run } = useSettingsAction(onError)
  useEffect(() => { setState(manager.snapshot()); return manager.subscribe(setState) }, [manager])
  return <Card title="Owned local server sharing">
    <Note>{state.status} · port {state.port} · {state.host} · authentication {state.auth} · pairing bootstrap {state.pairing ? 'enabled' : 'disabled'}</Note>
    <Note>Sharing changes restart only the owned process and reconnect the same verified environment. In-flight work may be interrupted. Network exposure requires protected authentication; disabling sharing never weakens authentication.</Note>
    <ConfirmAction label={state.host === '127.0.0.1' ? 'Enable LAN sharing' : 'Disable LAN sharing'} disabled={busy || state.status !== 'ready'} detail="Restart the owned backend with the selected network listener? LAN access requires a paired token; the local host credential stays in memory only." action={() => { void run('Change LAN sharing', () => manager.setLanEnabled(state.host === '127.0.0.1', true)) }} />
    <ConfirmAction label={state.pairing ? 'Disable pairing bootstrap' : 'Enable pairing bootstrap'} disabled={busy || state.status !== 'ready'} detail="Restart the owned server and change pairing bootstrap? Existing saved credentials are preserved." action={() => { void run('Change pairing bootstrap', () => manager.setPairingEnabled(!state.pairing, true)) }} />
    <Action label="Inspect owned tailnet sharing" disabled={busy || state.status !== 'ready'} onClick={() => { void run('Inspect tailnet', async () => setTailnet(await manager.tailnetStatus())) }} />
    {tailnet && <Note>{tailnet.availability} · {tailnet.enabled ? 'enabled' : 'disabled'} · {tailnet.managedBy ?? 'no owner'}{tailnet.conflict ? ' · existing route conflict; not replaced' : ''}</Note>}
    <ConfirmAction label="Enable owned tailnet sharing" disabled={busy || state.status !== 'ready'} detail="Enable Tailscale Serve for this owned backend? The server is first protected with authentication; conflicting foreign routes will not be replaced." action={() => { void run('Enable tailnet', async () => setTailnet(await manager.setTailnetEnabled(true, true))) }} />
    <ConfirmAction label="Disable owned tailnet sharing" disabled={busy || state.status !== 'ready'} detail="Remove only the verified exclusive route owned by this app? Foreign or daemon-owned configurations remain untouched." action={() => { void run('Disable tailnet', async () => setTailnet(await manager.setTailnetEnabled(false, true))) }} />
    {message && <Note>{message}</Note>}
  </Card>
}
