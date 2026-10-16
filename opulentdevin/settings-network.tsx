import { useEffect, useRef, useState } from 'react'
import type { Backend } from './backend'
import type { DeviceBridgeStatus } from './zuse-runtime/packages/contracts/src/device-bridge'
import type { AuthTokenSummary, NearbyPairingRequest, PairingStartResult } from './zuse-runtime/packages/contracts/src/pairing'
import type { MachinePrivateNetworkStatus, SshMode } from './zuse-runtime/packages/contracts/src/machines'
import { ConfirmAction, SettingsAction as Action, SettingsCard as Card, SettingsChoices as Choices, SettingsField as Field, SettingsNote as Note, useSettingsAction } from './settings-controls'
import { createNetworkActions, inspectLocalNetwork, inspectLocalTailnet, networkRestrictions, pairingDisplay, type LocalInterface, type LocalTailnet } from './settings-network-host'

type NetworkSnapshot = {
  tokens: readonly AuthTokenSummary[] | null
  nearby: readonly NearbyPairingRequest[] | null
  bridge: DeviceBridgeStatus | null
  privateNetwork: MachinePrivateNetworkStatus | null
}
const emptySnapshot: NetworkSnapshot = { tokens: null, nearby: null, bridge: null, privateNetwork: null }

export function NetworkSettings({ backend, onError }: { backend: Backend; onError: (error: unknown) => void }) {
  const actions = createNetworkActions(backend)
  const epoch = useRef(0)
  const [snapshot, setSnapshot] = useState<NetworkSnapshot>(emptySnapshot)
  const [loaded, setLoaded] = useState(false)
  const [pairing, setPairing] = useState<PairingStartResult | null>(null)
  const [now, setNow] = useState(Date.now())
  const [interfaces, setInterfaces] = useState<LocalInterface[] | null>(null)
  const [tailnet, setTailnet] = useState<LocalTailnet | null>(null)
  const [variable, setVariable] = useState('')
  const [sshMode, setSshMode] = useState<SshMode>('authorized-keys')
  const [voice, setVoice] = useState<{ available: boolean; maxDurationSeconds: number; maxBytes: number } | null>(null)
  const { busy, message, run } = useSettingsAction(onError)
  const refresh = async () => {
    const current = ++epoch.current
    const [tokens, nearby, bridge, privateNetwork] = await Promise.allSettled([actions.tokens(), actions.nearby(), actions.bridge(), actions.privateNetwork()])
    if (current !== epoch.current) return
    setSnapshot({ tokens: tokens.status === 'fulfilled' ? tokens.value : null, nearby: nearby.status === 'fulfilled' ? nearby.value : null, bridge: bridge.status === 'fulfilled' ? bridge.value : null, privateNetwork: privateNetwork.status === 'fulfilled' ? privateNetwork.value : null })
    setLoaded(true)
  }
  useEffect(() => {
    setSnapshot(emptySnapshot); setLoaded(false); setPairing(null); setVoice(null)
    void refresh()
    return () => { epoch.current++ }
  }, [backend])
  useEffect(() => {
    if (!pairing) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [pairing])
  const mutate = (label: string, action: () => Promise<unknown>) => { const current = epoch.current; void run(label, async () => { await action(); if (current === epoch.current) await refresh() }) }
  const display = pairing ? pairingDisplay(pairing, now) : null
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <Note>Device permissions and pairing apply to the connected backend. Local host inspection applies to this native app’s computer.</Note>
    <Action label="Refresh devices and network" disabled={busy} onClick={() => { void run('Refresh devices and network', refresh) }} />
    {message && <Note>{message}</Note>}
    {!loaded && <Note>Loading connected backend capabilities…</Note>}
    <Card title="Paired devices">
      {loaded && snapshot.tokens === null && <Note warning>Pairing inventory unavailable on this backend. The local launcher disables pairing by default.</Note>}
      {snapshot.tokens?.length === 0 && <Note>No paired device tokens.</Note>}
      {snapshot.tokens?.map(token => <div key={token.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Note>{token.label ?? token.deviceId ?? token.id} · {token.revokedAt ? 'Revoked' : 'Active'} · Created {token.createdAt.toLocaleString()}</Note>
        {!token.revokedAt && <ConfirmAction label={`Revoke ${token.label ?? token.id}`} detail="This device loses access to the connected backend. Its current connection may close." disabled={busy} action={() => mutate('Revoke device token', () => actions.revokeToken(token.id, true))} />}
      </div>)}
      <ConfirmAction label="Create pairing code" detail="Creates a temporary credential that can grant another device access. Only share it with the intended device." disabled={busy || !loaded || snapshot.tokens === null} action={() => { const current = epoch.current; void run('Create pairing code', async () => { const result = await actions.startPairing(true); if (epoch.current === current) { setNow(Date.now()); setPairing(result) } }) }} />
      {display && <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><Note warning>{display.expired ? 'Pairing code expired.' : `Pairing code: ${display.code} · Expires ${pairing?.expiresAt.toLocaleString()}`}</Note>{!display.expired && <Action label="Hide pairing code" onClick={() => setPairing(null)} />}</div>}
      <Note>Pairing credentials stay in memory; links containing credentials are not opened, logged or persisted.</Note>
    </Card>
    <Card title="Nearby pairing requests">
      {loaded && snapshot.nearby === null && <Note warning>Nearby pairing is unavailable on this backend.</Note>}
      {snapshot.nearby?.length === 0 && <Note>No nearby requests. Refresh to check again.</Note>}
      {snapshot.nearby?.map(request => <div key={request.requestId} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Note>{request.deviceLabel} · {request.deviceIdentifier} · Expires {request.expiresAt.toLocaleString()}</Note>
        <Note>Verify this safety phrase on the other device: {request.safetyPhrase}</Note>
        <div style={{ display: 'flex', flexDirection: 'row', gap: 8 }}>{(['allow', 'deny', 'block'] as const).map(decision => <ConfirmAction key={decision} label={`${decision} ${request.deviceLabel}`} detail={decision === 'allow' ? 'Allow only after the safety phrase matches on both devices. This grants backend access.' : `${decision === 'block' ? 'Block this device' : 'Deny this request'} on the connected backend.`} disabled={busy || request.expiresAt.getTime() <= Date.now()} action={() => mutate('Resolve nearby pairing', () => actions.resolveNearby(request, decision, true))} />)}</div>
      </div>)}
    </Card>
    <Card title="Device command permissions">
      {loaded && !snapshot.bridge && <Note warning>Device bridge status is unavailable on this backend.</Note>}
      {snapshot.bridge && <><Note>{snapshot.bridge.deviceName} · {snapshot.bridge.enabled ? 'Enabled' : 'Disabled'} · {snapshot.bridge.connected ? 'Connected' : 'Disconnected'}</Note>
        <Note>Commands run on this backend’s device, not necessarily the computer displaying this app.</Note>
        {snapshot.bridge.commands.filter(command => command.state === 'pending').map(command => <div key={command.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Note>{command.chatTitle} · {command.deviceName} · Directory: {command.cwd}</Note><Note>{command.command}</Note>
          <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{(['AllowOnce', 'AllowForSession', 'AlwaysAllow', 'Deny'] as const).map(decision => <ConfirmAction key={decision} label={`${decision} ${command.id}`} detail={`${decision}: changes command execution permission for ${command.deviceName}. AlwaysAllow creates persistent access; AllowForSession covers this session.`} disabled={busy} action={() => mutate('Decide device command', () => actions.decideCommand(command.id, decision, true))} />)}</div>
        </div>)}
        {snapshot.bridge.grants.length === 0 && <Note>No active command grants.</Note>}
        {snapshot.bridge.grants.map(grant => <ConfirmAction key={grant.id} label={`Revoke grant ${grant.id}`} detail={`Removes ${grant.chatId ? 'chat-scoped' : 'persistent'} access for device ${grant.deviceId}.`} disabled={busy} action={() => mutate('Revoke command grant', () => actions.revokeGrant(grant.id, true))} />)}
      </>}
    </Card>
    <Card title="Connected machine private network">
      {loaded && !snapshot.privateNetwork && <Note warning>This backend does not expose machine private-network status, or access was refused. Policy controls remain unavailable.</Note>}
      {snapshot.privateNetwork && <><Note>{snapshot.privateNetwork.enabled ? 'Enabled' : 'Disabled'} · SSH: {snapshot.privateNetwork.sshMode} · {snapshot.privateNetwork.privateIp ?? 'No private IP'} · {snapshot.privateNetwork.dnsName ?? 'No DNS name'}</Note>
        <Choices label="Requested SSH policy" value={sshMode} values={['authorized-keys', 'tailnet-identity']} onChange={setSshMode} />
        <Field label="Tailnet auth-key environment variable" value={variable} onChange={setVariable} placeholder="TAILSCALE_AUTH_KEY" disabled={busy} />
        <Note>Enter a saved variable name, never the key. The key is sent only to the connected machine after confirmation.</Note>
        <ConfirmAction label="Enable machine private network" detail={`Join the connected machine to the tailnet using the named credential and set SSH to ${sshMode}. This is an external network policy change.`} disabled={busy || !variable} action={() => mutate('Enable machine private network', () => actions.enablePrivateNetwork(variable, sshMode, true))} />
        <ConfirmAction label="Apply machine SSH policy" detail={`Set the connected machine’s SSH policy to ${sshMode}. Existing SSH access may be interrupted.`} disabled={busy || sshMode === snapshot.privateNetwork.sshMode} action={() => mutate('Apply machine SSH policy', () => actions.setSshMode(sshMode, true))} />
        <Note>The contract exposes no private-network disable RPC; no fake disconnect action is offered.</Note>
      </>}
    </Card>
    <Card title="Local LAN and tailnet host">
      <Action label="Inspect local network interfaces" disabled={busy} onClick={() => { void run('Inspect local network interfaces', async () => setInterfaces(inspectLocalNetwork())) }} />
      {interfaces?.length === 0 && <Note>No non-loopback interfaces found.</Note>}
      {interfaces?.map(item => <Note key={`${item.name}-${item.address}`}>{item.name} · {item.family} · {item.address}</Note>)}
      <Action label="Inspect local Tailscale status" disabled={busy} onClick={() => { void run('Inspect local Tailscale status', async () => setTailnet(await inspectLocalTailnet())) }} />
      {tailnet && <Note>{tailnet.backendState ?? 'Unknown Tailscale state'} · {tailnet.dnsName ?? 'No tailnet DNS name'}</Note>}
      <Note warning>{networkRestrictions.lan}</Note><Note warning>{networkRestrictions.tailnet}</Note><Note warning>{networkRestrictions.profiles}</Note>
    </Card>
    <Card title="Voice availability">
      <Note warning>{networkRestrictions.voice}</Note>
      <ConfirmAction label="Check transcription account" detail="This refreshes the connected backend’s Codex/ChatGPT account authentication. It does not open the microphone or upload audio." disabled={busy} action={() => { const current = epoch.current; void run('Check transcription account', async () => { const result = await actions.voiceCapabilities(); if (current === epoch.current) setVoice(result) }) }} />
      {voice && <Note>{voice.available ? 'Transcription account available' : 'Compatible signed-in ChatGPT account unavailable'} · Limit {voice.maxDurationSeconds}s / {voice.maxBytes} bytes. Capture remains unavailable.</Note>}
    </Card>
  </div>
}
