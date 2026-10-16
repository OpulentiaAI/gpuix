import { useEffect, useRef, useState } from 'react'
import type { Backend, Subscription } from './backend'
import type { DiscoveredSshHost, RemoteEnvironmentProfile } from './zuse-runtime/packages/contracts/src/ssh'
import { addNativeMcp, discoverNativeSsh, listSshProfiles, openSshBackend, removeSshProfile } from './settings-host'
import { SettingsAction as Action, SettingsCard as Card, SettingsNote as Note, SettingsField as Field, SettingsChoices as Choices, ConfirmAction, useSettingsAction } from './settings-controls'

export function HostSettings({ backend, onError, onConnect }: { backend: Backend; onError: (error: unknown) => void; onConnect?: (backend: Backend, environmentId: string) => void }) {
  const [host, setHost] = useState('')
  const [user, setUser] = useState('')
  const [port, setPort] = useState('22')
  const [label, setLabel] = useState('')
  const [profiles, setProfiles] = useState<readonly RemoteEnvironmentProfile[]>([])
  const [discovered, setDiscovered] = useState<readonly DiscoveredSshHost[]>([])
  const [mcpProvider, setMcpProvider] = useState<'claude' | 'codex'>('claude')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [transport, setTransport] = useState<'http' | 'stdio'>('http')
  const [executable, setExecutable] = useState('')
  const [argumentsText, setArgumentsText] = useState('')
  const [authKey, setAuthKey] = useState('')
  const [authMessage, setAuthMessage] = useState('')
  const [localConfirmed, setLocalConfirmed] = useState(false)
  const auth = useRef<Subscription | null>(null)
  const abort = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  const { busy, message, run } = useSettingsAction(onError)
  useEffect(() => { mounted.current = true; void listSshProfiles().then(setProfiles).catch(() => onError(new Error('SSH profiles could not be read.'))); return () => { mounted.current = false; abort.current?.abort(); auth.current?.cancel() } }, [])
  const connect = async (hostname: string, username: string, sshPort: string, display: string) => {
    if (!onConnect) throw new Error('Parent connection switching is not connected')
    const controller = new AbortController(); abort.current = controller
    const remote = await openSshBackend(hostname, username, sshPort, display, controller.signal)
    if (!mounted.current || controller.signal.aborted) { await remote.backend.dispose(); return }
    abort.current = null
    try { onConnect(remote.backend, remote.environmentId) } catch { await remote.backend.dispose(); throw new Error('The parent could not activate the SSH connection') }
  }
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <Card title="SSH computers">
      <Note>Uses the pinned Zuse SSH bootstrap and tunnel primitives, with strict known-host verification and key/agent authentication. A connection can install/start Zuse on the selected host. No password is collected. Trust new host keys in your SSH client first.</Note>
      <Action label="Discover configured SSH and tailnet hosts" disabled={busy} onClick={() => { void run('Discover SSH hosts', async () => setDiscovered(await discoverNativeSsh())) }} />
      {discovered.map(item => <Action key={item.alias} label={`Select host ${item.displayName}`} disabled={busy} onClick={() => { setHost(item.alias); setUser(item.username ?? ''); setPort(item.port ? String(item.port) : ''); setLabel(item.displayName) }} />)}
      <Field label="SSH hostname or configured alias" value={host} onChange={setHost} disabled={busy} /><Field label="SSH username (blank uses config)" value={user} onChange={setUser} disabled={busy} /><Field label="SSH port (blank uses config)" value={port} onChange={setPort} disabled={busy} /><Field label="Computer display name" value={label} onChange={setLabel} disabled={busy} />
      <ConfirmAction label="Connect SSH computer" detail={`Connect to ${host || 'the entered host'} and install/start the pinned Zuse runtime if required? Only proceed for a computer you control.`} disabled={busy || !host || !onConnect} action={() => { void run('Connect SSH computer', () => connect(host, user, port, label)) }} />
      {busy && <Action label="Cancel pending SSH connection" onClick={() => abort.current?.abort()} />}
      {!onConnect && <Note warning>The parent has not supplied onConnect; connection actions stay disabled.</Note>}
      {profiles.map(profile => <div key={profile.profileId} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><Note>{`${profile.label} · ${profile.target.alias} · last connected ${profile.lastConnectedAt}`}</Note><ConfirmAction label={`Reconnect ${profile.label}`} detail="Reconnect and verify the previously recorded remote identity?" disabled={busy || !onConnect} action={() => { void run('Reconnect SSH profile', () => connect(profile.target.alias, profile.target.username ?? '', profile.target.port ? String(profile.target.port) : '', profile.label)) }} /><ConfirmAction label={`Remove profile ${profile.label}`} detail="Remove this saved identity and disconnect its owned tunnel? A future connection will require trusting its identity again." disabled={busy} action={() => { void run('Remove SSH profile', async () => { await removeSshProfile(profile.profileId); setProfiles(await listSshProfiles()) }) }} /></div>)}
    </Card>
    <Card title="Add MCP server to this computer">
      <Note>This host action uses the provider CLI with fixed arguments, not a shell or arbitrary file editor. It changes the native account-level provider config on THIS computer, which may differ from the active backend. Existing inventory names are refused.</Note>
      <Choices label="Transport" value={transport} values={['http', 'stdio']} onChange={setTransport} /><Choices label="Provider config owner" value={mcpProvider} values={['claude', 'codex']} onChange={setMcpProvider} /><Field label="Server name" value={name} onChange={setName} disabled={busy} />{transport === 'http' ? <Field label="Public HTTPS MCP endpoint (no credentials or query)" value={url} onChange={setUrl} disabled={busy} /> : <><Field label="Trusted absolute MCP executable path" value={executable} onChange={setExecutable} disabled={busy} /><Note>Arguments: one literal argument per line. No shell parsing. Do not enter passwords, tokens or credentials; inherit configured process environment instead.</Note><textarea testId="settings-mcp-stdio-arguments" value={argumentsText} minRows={3} readOnly={busy} onChange={event => setArgumentsText(event.value ?? '')} /></>}
      <Action label={localConfirmed ? 'Local backend scope confirmed' : 'Confirm backend uses this computer’s provider configuration'} selected={localConfirmed} onClick={() => setLocalConfirmed(!localConfirmed)} />
      <ConfirmAction label="Add native MCP server" detail="Add this trusted server to the chosen provider’s native config? A stdio server executes the named programme with these literal arguments; its tools may become available to sessions. Do not include credential values." disabled={busy || !name || (transport === 'http' ? !url : !executable) || !localConfirmed} action={() => { void run('Add MCP server', async () => { const inventory = await backend.run(backend.client['mcp.list']({})); await addNativeMcp(mcpProvider, name.trim(), url, inventory.servers.map(server => server.name), transport === 'stdio' ? { executable, argumentsText } : undefined); setName(''); setUrl('') }) }} />
    </Card>
    <Card title="Authenticate an existing MCP server">
      <Field label="Exact MCP inventory key" value={authKey} onChange={setAuthKey} disabled={busy} />
      <Action label="Start MCP OAuth" disabled={busy || !authKey || auth.current !== null} onClick={() => { void run('Start MCP OAuth', async () => {
        const inventory = await backend.run(backend.client['mcp.list']({})); const server = inventory.servers.find(item => item.key === authKey)
        if (server?.authenticationAction !== 'native-oauth') throw new Error('This server does not expose native OAuth')
        auth.current = backend.subscribe(backend.client['mcp.authenticate']({ key: authKey }), event => { if (!mounted.current) return; if (event._tag === 'browser-opened') setAuthMessage('The backend opened the provider browser; complete sign-in there.'); else if (event._tag === 'completed') setAuthMessage('Authentication completed. Refresh MCP inventory.'); else setAuthMessage('Authentication failed; no raw diagnostic retained.') }, () => setAuthMessage('MCP authentication failed.'))
        const stream = auth.current; void stream.done.finally(() => { if (auth.current === stream) auth.current = null })
      }) }} />
      <Action label="Stop MCP OAuth listener" onClick={() => { auth.current?.cancel(); auth.current = null; setAuthMessage('Listener stopped; provider authorisation may still be active.') }} /><Note>{authMessage}</Note>
    </Card>
    {message && <Note>{message}</Note>}
  </div>
}
