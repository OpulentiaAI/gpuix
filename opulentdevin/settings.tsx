import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Backend, Subscription } from './backend'
import type { AgentAvailability, ProviderId } from './zuse-runtime/packages/contracts/src/agent'
import type { SettingsFile, SettingsPatch } from './zuse-runtime/packages/contracts/src/settings'
import type { McpServerDescriptor, McpServerStatus } from './zuse-runtime/packages/contracts/src/mcp'
import type { Folder } from './zuse-runtime/packages/contracts/src/workspace'
import { FolderId } from './zuse-runtime/packages/contracts/src/ids'
import type { ApiEnvironmentList } from './zuse-runtime/packages/contracts/src/api'
import type { CloudAuthStatus } from './zuse-runtime/packages/contracts/src/cloud-auth'
import type { CloudWorkspaceList } from './zuse-runtime/packages/contracts/src/cloud-workspaces'
import { Icon } from './icons'
import { metrics, palettes } from './theme'
import { ModelSettings } from './settings-models'
import { CloudSettings } from './settings-cloud'
import { HostSettings } from './settings-host-panel'
import { AdvancedSettings } from './settings-advanced'
import { OpenCodeSettings } from './settings-opencode'
import { CloudAccountSettings } from './settings-cloud-account'
import { NetworkSettings } from './settings-network'

export type SettingsPanelProps = {
  backend: Backend
  onError: (error: unknown) => void
  onClose: () => void
  onConnect?: (backend: Backend, environmentId: string) => void
}

type Tab = 'General' | 'Providers' | 'Models' | 'Integrations' | 'Connections' | 'Cloud' | 'Host setup' | 'Coverage'
type Remote<T> = { state: 'loading' } | { state: 'error' } | { state: 'ready'; value: T }
const c = palettes.dark
const providerIds: readonly ProviderId[] = ['claude', 'codex', 'grok', 'gemini', 'cursor', 'opencode', 'opencode2', 'kiro', 'pi']

export const nativeSettingsCapabilities = [
  ['General preferences', 'Editable', 'Typed appearance, completion sound, default provider, automatic worktrees and branch naming patches.'],
  ['Provider availability', 'Live', 'Runtime, version, verified authentication, explicit CLI sign-in and visibility toggles.'],
  ['Provider credentials', 'Implemented / input limit', 'Save/test from an explicitly named environment variable through backend keychain; confirmed removal. GPUIX lacks a masked input primitive, so direct secret entry is not rendered.'],
  ['Provider installation', 'Implemented', 'Confirmed streamed install/update through provider.update, raw logs suppressed, and typed executable-path overrides.'],
  ['Model management', 'Implemented', 'Model catalogue/defaults/visibility/custom IDs plus OpenCode 1/2 sub-provider credentials, visibility and trusted custom HTTPS endpoint editing.'],
  ['Permission and agent defaults', 'Preserved / editable', 'Subagent enablement, preset text, model and turn-limit editors preserve existing runtime/permission modes and tool restrictions.'],
  ['MCP inventory', 'Implemented', 'User/repository-scoped list, probe and supported enablement overrides using actual workspace IDs.'],
  ['MCP add and authentication', 'Partial', 'Explicit native CLI HTTP/stdio addition with literal argv, existing-name guards and streamed OAuth. Secret headers and provider-managed app setup remain provider-owned.'],
  ['Cloud and SSH inventory', 'Live', 'Registered environments, cloud workspaces and verified cloud authentication status.'],
  ['SSH discovery and connection', 'Implemented', 'Explicit discovery, validated host/user/port, strict known-host bootstrap, identity-checked backend handoff and owned tunnel cleanup. Interactive host-key approval/key management remain host UI work.'],
  ['Cloud lifecycle', 'Implemented / access-dependent', 'Sealed credentials, device login, project/workspace lifecycle, image builds, machines, checkout/portal, spending cap and GitHub access controls. Paid/destructive actions require explicit confirmation.'],
  ['Device and network access', 'Partial', 'Backend pairing, nearby requests, device-command permissions and cloud-machine private-network/SSH policy. Local LAN/tailnet serving still needs an owned listener lifecycle; voice capture needs an audio bridge.'],
  ['Repository and Git settings', 'Partial', 'Branch naming, merge and post-merge branch deletion defaults. Hooks, repository overrides and worktree setup remain dedicated app controls.'],
  ['Desktop personalisation', 'Partial', 'Preferences persist. Playback, OS theme, notch tray, locale and keybindings require host wiring. No claim of native parity.'],
  ['Advanced services', 'Not implemented', 'Skills, voice, browser profiles, diagnostics, updates, usage, analytics, Linear, previews and notifications remain dedicated app/service integration work.'],
] as const

function Action({ label, onClick, disabled = false, selected = false }: { label: string; onClick: () => void; disabled?: boolean; selected?: boolean }) {
  return <div testId={`settings-action-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`} role="button" aria-label={label} tabIndex={disabled ? -1 : 0} onClick={() => { if (!disabled) onClick() }} onKeyDown={event => { if (!disabled && (event.key === 'Enter' || event.key === ' ')) onClick() }} style={{ display: 'flex', flexDirection: 'column', flexShrink: 0, paddingLeft: 10, paddingRight: 10, height: 30, justifyContent: 'center', borderRadius: metrics.rowRadius, backgroundColor: selected ? c.accentSoft : c.hover, borderWidth: 1, borderColor: selected ? c.accent : c.border, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1 }}><text style={{ fontSize: 12, color: selected ? c.accentText : c.text }}>{label}</text></div>
}

function Note({ children, warning = false }: { children: ReactNode; warning?: boolean }) {
  return <text style={{ fontSize: 12, color: warning ? c.warning : c.secondary }}>{children}</text>
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0, padding: 16, gap: 12, borderRadius: metrics.menuRadius, backgroundColor: c.elevated, borderWidth: 1, borderColor: c.border }}><text style={{ color: c.strong, fontSize: 14, fontWeight: 500 }}>{title}</text>{children}</div>
}

function Choices<T extends string>({ label, value, values, onChange }: { label: string; value: T; values: readonly T[]; onChange: (value: T) => void }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}><Note>{label}</Note><div style={{ display: 'flex',  flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{values.map(option => <Action key={option} label={option} selected={option === value} onClick={() => onChange(option)} />)}</div></div>
}

function useRemote<T>(load: () => Promise<T>, onError: (error: unknown) => void, label: string) {
  const [data, setData] = useState<Remote<T>>({ state: 'loading' })
  const [revision, setRevision] = useState(0)
  const errorRef = useRef(onError)
  errorRef.current = onError
  useEffect(() => {
    let current = true
    setData({ state: 'loading' })
    void load().then(value => { if (current) setData({ state: 'ready', value }) }).catch(() => {
      if (!current) return
      setData({ state: 'error' })
      errorRef.current(new Error(`${label} unavailable. Check the backend connection and account credentials, then retry.`))
    })
    return () => { current = false }
  }, [load, revision, label])
  return { data, refresh: () => setRevision(value => value + 1) }
}

function General({ backend, onError }: Pick<SettingsPanelProps, 'backend' | 'onError'>) {
  const load = useCallback(() => backend.settings.get(), [backend])
  const { data, refresh } = useRemote(load, onError, 'Settings')
  const [patch, setPatch] = useState<SettingsPatch>({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const saving = useRef(false)
  const dirty = Object.keys(patch).length > 0
  if (data.state !== 'ready') return <Card title="General preferences"><Note warning={data.state === 'error'}>{data.state === 'loading' ? 'Reading settings from Zuse…' : 'Settings could not be read. No defaults have been written.'}</Note><Action label="Retry" onClick={refresh} /></Card>
  const settings: SettingsFile = { ...data.value, ...patch }
  const change = (next: SettingsPatch) => { if (saving.current) return; setPatch(previous => ({ ...previous, ...next })); setMessage('Unsaved changes') }
  const save = async () => {
    if (saving.current || !dirty) return
    saving.current = true
    setBusy(true)
    try {
      await backend.settings.update({ patch })
      setPatch({})
      setMessage('Saved to Zuse settings')
      refresh()
    } catch {
      setMessage('Save failed; your draft is still here. Retry when the backend is available.')
      onError(new Error('Settings save failed. The draft has been retained.'))
    } finally { saving.current = false; setBusy(false) }
  }
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <Card title="Appearance and feedback">
      <Choices label="Appearance preference" value={settings.appearanceMode} values={['system', 'light', 'dark']} onChange={value => change({ appearanceMode: value })} />
      <Note>The native shell currently uses its own dark palette. This preference is saved for Zuse; OS theme following and sound playback are not wired here.</Note>
      <div style={{ display: 'flex',  flexDirection: 'row', gap: 8, alignItems: 'center' }}><Action label={settings.completionSoundEnabled ? 'Sound enabled' : 'Sound disabled'} selected={settings.completionSoundEnabled} onClick={() => change({ completionSoundEnabled: !settings.completionSoundEnabled })} /><Note>Completion sound preference</Note></div>
      <Choices label="Sound preset" value={settings.completionSoundPreset} values={['chime', 'soft', 'pop', 'bell', 'rise', 'bloom']} onChange={value => change({ completionSoundPreset: value })} />
    </Card>
    <Card title="New sessions and branches">
      <Choices label="Default provider (availability is shown in Providers)" value={settings.defaultProviderId} values={providerIds} onChange={value => change({ defaultProviderId: value })} />
      <Action label={settings.defaultAutoCreateWorktree ? 'Automatic worktrees enabled' : 'Automatic worktrees disabled'} selected={settings.defaultAutoCreateWorktree} onClick={() => change({ defaultAutoCreateWorktree: !settings.defaultAutoCreateWorktree })} />
      <Choices label="Branch naming" value={settings.branchNamingStyle} values={['username-slug', 'slug', 'feat-slug', 'custom']} onChange={value => change({ branchNamingStyle: value })} />
      {settings.branchNamingStyle === 'custom' && <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><Note>Custom branch prefix</Note><input value={settings.branchNamingPrefix} placeholder="wip" readOnly={busy} onChange={event => change({ branchNamingPrefix: event.value ?? '' })} style={{ height: 34, padding: 8, color: c.text, backgroundColor: c.wash, borderRadius: 6 }} /></div>}
      <Note>Permission mode is {settings.defaultRuntimeMode}. Security defaults and unrelated settings are preserved.</Note>
    </Card>
    <div style={{ display: 'flex',  flexDirection: 'row', gap: 8 }}><Action label={busy ? 'Saving…' : 'Save preferences'} disabled={busy || !dirty} onClick={() => { void save() }} /><Action label="Discard draft" disabled={busy || !dirty} onClick={() => { setPatch({}); setMessage('Draft discarded') }} /><Action label="Reload" disabled={busy || dirty} onClick={refresh} /></div>
    {message && <Note>{message}</Note>}
    <Note>Only changed fields are sent. Leaving this tab discards an unsaved draft.</Note>
  </div>
}

function Providers({ backend, onError }: Pick<SettingsPanelProps, 'backend' | 'onError'>) {
  const load = useCallback(async () => ({ providers: await backend.providers.list({ refresh: true }), settings: await backend.settings.get() }), [backend])
  const { data, refresh } = useRemote(load, onError, 'Provider availability')
  const [busy, setBusy] = useState<ProviderId | null>(null)
  const [login, setLogin] = useState<{ provider: ProviderId; status: string; url?: string } | null>(null)
  const subscription = useRef<Subscription | null>(null)
  const [loginActive, setLoginActive] = useState(false)
  const loginGeneration = useRef(0)
  const mutation = useRef(false)
  useEffect(() => () => { loginGeneration.current += 1; subscription.current?.cancel(); subscription.current = null }, [backend])
  const signIn = (provider: AgentAvailability) => {
    if (subscription.current) return
    const generation = ++loginGeneration.current
    setLoginActive(true)
    setLogin({ provider: provider.providerId, status: 'Starting sign-in. No credentials are collected by this panel.' })
    try {
      const stream = backend.subscribe(backend.providers.login({ providerId: provider.providerId }), event => {
        if (generation !== loginGeneration.current) return
        if (event._tag === 'url') {
          try {
            const url = new URL(event.url)
            if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Unsafe login URL')
            setLogin({ provider: provider.providerId, status: 'Copy this temporary sign-in URL into your browser. It is not saved.', url: url.href })
          } catch { setLogin({ provider: provider.providerId, status: 'The login URL could not be safely displayed. Use the provider’s own sign-in flow.' }) }
        } else if (event._tag === 'done') {
          setLogin({ provider: provider.providerId, status: event.ok ? 'Sign-in completed. Refreshing verified availability…' : 'Sign-in did not complete. This runtime may not support CLI login; use its own sign-in flow.' })
          refresh()
        }
      }, () => { if (generation !== loginGeneration.current) return; setLogin({ provider: provider.providerId, status: 'Sign-in failed. No log output or credentials have been retained.' }); onError(new Error('Provider sign-in failed.')) })
      subscription.current = stream
      void stream.done.finally(() => { if (generation === loginGeneration.current) { subscription.current = null; setLoginActive(false) } })
    } catch { setLoginActive(false); setLogin({ provider: provider.providerId, status: 'Sign-in could not start.' }); onError(new Error('Provider sign-in could not start.')) }
  }
  const toggle = async (provider: ProviderId, enabled: boolean) => {
    if (mutation.current) return
    mutation.current = true
    setBusy(provider)
    try {
      const latest = await backend.settings.get()
      await backend.settings.update({ patch: { providerEnabled: { ...latest.providerEnabled, [provider]: enabled } } })
      refresh()
    } catch { onError(new Error('Provider visibility could not be saved.')) }
    finally { mutation.current = false; setBusy(null) }
  }
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <div style={{ display: 'flex',  flexDirection: 'row', gap: 10 }}><Action label="Refresh availability" onClick={refresh} disabled={busy !== null} /></div>
    <Note>Runtime presence is not proof of authentication. Sign-in starts only when you choose it; raw CLI logs are never shown.</Note>
    {data.state === 'loading' && <Note>Checking installed providers and credentials…</Note>}
    {data.state === 'error' && <Note warning>Provider availability could not be checked. Retry after reconnecting the backend.</Note>}
    {data.state === 'ready' && data.value.providers.length === 0 && <Note>No providers were returned by this backend.</Note>}
    {data.state === 'ready' && data.value.providers.map(provider => {
      const enabled = data.value.settings.providerEnabled[provider.providerId]
      const available = provider.runtimeAvailable ?? provider.cliInstalled
      return <Card key={provider.providerId} title={provider.displayName}>
        <Note>{`${provider.runtimeKind ?? 'cli'} · ${available ? 'runtime available' : 'runtime unavailable'} · ${provider.cliVersion ?? 'version unknown'}`}</Note>
        <Note warning={provider.authStatus !== 'authenticated'}>{`Authentication: ${provider.authStatus ?? 'unknown'} · API key: ${provider.hasApiKey ? (provider.apiKeyStatus ?? 'present, not verified') : 'not configured'}`}</Note>
        {provider.authLabel && <Note>{provider.authLabel}</Note>}
        {provider.cliVersionStatus === 'outdated' && <Note warning>{`Runtime update required${provider.cliVersionMinRequired ? `: minimum ${provider.cliVersionMinRequired}` : ''}. Installation is not managed here.`}</Note>}
        <div style={{ display: 'flex',  flexDirection: 'row', gap: 8 }}><Action label={enabled ? 'Enabled in picker' : 'Hidden from picker'} selected={enabled} disabled={busy !== null} onClick={() => { void toggle(provider.providerId, !enabled) }} /><Action label="Start sign-in" disabled={!available || loginActive} onClick={() => signIn(provider)} /></div>
      </Card>
    })}
    {login && <Card title={`Sign-in · ${login.provider}`}><Note>{login.status}</Note>{login.url && <input value={login.url} readOnly style={{ height: 36, color: c.text, backgroundColor: c.wash, padding: 8 }} />}<Action label="Dismiss / stop listening" onClick={() => { loginGeneration.current += 1; subscription.current?.cancel(); subscription.current = null; setLoginActive(false); setLogin(null) }} /><Note>Stopping the stream does not guarantee that a provider-owned browser login is cancelled.</Note></Card>}
  </div>
}

function Integrations({ backend, onError }: Pick<SettingsPanelProps, 'backend' | 'onError'>) {
  const [probe, setProbe] = useState(false)
  const [projectId, setProjectId] = useState('')
  const [folders, setFolders] = useState<readonly Folder[]>([])
  useEffect(() => { void backend.workspaces.list({}).then(setFolders).catch(() => onError(new Error('MCP repository scopes could not be loaded.'))) }, [backend])
  const scope = projectId ? { projectId: FolderId.make(projectId) } : {}
  const load = useCallback(() => backend.run(probe ? backend.client['mcp.refresh'](projectId ? { projectId: FolderId.make(projectId) } : {}) : backend.client['mcp.list'](projectId ? { projectId: FolderId.make(projectId) } : {})), [backend, probe, projectId])
  const { data, refresh } = useRemote<{ readonly servers: readonly McpServerDescriptor[]; readonly statuses: readonly McpServerStatus[] }>(load, onError, 'MCP inventory')
  const [busy, setBusy] = useState<string | null>(null)
  const mutation = useRef(false)
  const toggle = async (server: McpServerDescriptor) => {
    if (mutation.current || !server.toggleSupported) return
    mutation.current = true
    setBusy(server.key)
    try { await backend.run(backend.client['mcp.setEnabled']({ ...scope, key: server.key, enabled: server.disabledByZuse || !server.enabledInConfig })); refresh() }
    catch { onError(new Error('MCP visibility could not be changed. Provider-managed entries may require their own settings.')) }
    finally { mutation.current = false; setBusy(null) }
  }
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <Card title="Connected tools"><Note>{projectId ? 'Repository-scoped MCP inventory and enablement overrides.' : 'User-level MCP inventory and global enablement overrides.'}</Note><Action label="Use global MCP scope" disabled={busy !== null} selected={!projectId} onClick={() => setProjectId('')} />{folders.map(folder => <Action key={folder.id} label={`MCP scope ${folder.name}`} disabled={busy !== null} selected={projectId === folder.id} onClick={() => setProjectId(folder.id)} />)}<Action label="Refresh and probe" disabled={busy !== null} onClick={() => { if (probe) refresh(); else setProbe(true) }} /><Note warning>Use Host setup for explicit native CLI server addition and MCP OAuth. The typed backend has no add-server RPC; host configuration belongs to this computer, not a remote backend.</Note></Card>
    {data.state === 'loading' && <Note>Reading connected tools…</Note>}
    {data.state === 'error' && <Note warning>MCP inventory is unavailable. Check the backend and provider configuration, then refresh.</Note>}
    {data.state === 'ready' && data.value.servers.length === 0 && <Note>No user-level MCP servers were returned.</Note>}
    {data.state === 'ready' && data.value.servers.map(server => {
      const status = data.value.statuses.find(item => item.key === server.key)
      return <Card key={server.key} title={server.name}>
        <Note>{`${server.source} · ${server.transport ?? server.kind} · ${status?.state ?? 'not probed'} · ${status?.toolCount ?? '?'} tools`}</Note>
        <Note>{`Available to: ${server.availableProviders.join(', ') || 'no provider reported'}`}</Note>
        {server.envVarNames.length > 0 && <Note>{`Credential references: ${server.envVarNames.join(', ')} (values withheld)`}</Note>}
        {status?.requirements.some(requirement => !requirement.satisfied) && <Note warning>Connection prerequisites are missing. Complete credentials, command installation or authentication in the provider’s native setup.</Note>}
        {status?.state === 'needs-auth' && <Note warning>Authentication required. Use Host setup for supported native MCP OAuth. Token entry needs the provider’s secure credential setup.</Note>}
        {server.toggleSupported ? <Action label={server.disabledByZuse || !server.enabledInConfig ? 'Enable server' : 'Disable server'} disabled={busy !== null} onClick={() => { void toggle(server) }} /> : <Note>This entry is provider-managed; its native configuration cannot be toggled here.</Note>}
      </Card>
    })}
  </div>
}

function Connections({ backend, onError }: Pick<SettingsPanelProps, 'backend' | 'onError'>) {
  const environmentLoad = useCallback(() => backend.run(backend.client['environments.list']()), [backend])
  const workspaceLoad = useCallback(() => backend.run(backend.client['cloud.workspaces.list']({})), [backend])
  const authLoad = useCallback(() => backend.run(backend.client['cloud.auth.status']()), [backend])
  const environments = useRemote<ApiEnvironmentList>(environmentLoad, onError, 'Registered environments')
  const workspaces = useRemote<CloudWorkspaceList>(workspaceLoad, onError, 'Cloud workspaces')
  const auth = useRemote<CloudAuthStatus>(authLoad, onError, 'Cloud credentials')
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <Action label="Refresh connections" onClick={() => { environments.refresh(); workspaces.refresh(); auth.refresh() }} />
    <Note>Read-only inventory. This panel does not provision machines, start SSH tunnels, request connection tokens or collect passwords.</Note>
    <Card title="Registered environments · including SSH">
      {environments.data.state === 'loading' && <Note>Loading registered environments…</Note>}
      {environments.data.state === 'error' && <Note warning>Environment inventory unavailable. Account credentials may be absent or the API unreachable; SSH connectivity has not been verified.</Note>}
      {environments.data.state === 'ready' && environments.data.value.environments.length === 0 && <Note>No registered environments. Local SSH config discovery is not exposed by this backend RPC.</Note>}
      {environments.data.state === 'ready' && environments.data.value.environments.map(environment => <div key={environment.environmentId} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><text style={{ color: c.text, fontSize: 13 }}>{environment.label ?? environment.environmentId}</text><Note>{`${environment.providerKind} · ${environment.serviceState ?? 'service state unknown'} · ${environment.runtimeVersion ?? 'version unknown'}`}</Note></div>)}
    </Card>
    <Card title="Cloud authentication">
      {auth.data.state === 'loading' && <Note>Checking cloud credential status…</Note>}
      {auth.data.state === 'error' && <Note warning>Cloud authentication status unavailable. No credential readiness is assumed; sign in or configure the account in the supported Zuse client, then refresh.</Note>}
      {auth.data.state === 'ready' && <><Note>{`Credential authority: ${auth.data.value.authorityState}`}</Note>{auth.data.value.providers.length === 0 && <Note warning>No cloud provider authentication has been reported.</Note>}{auth.data.value.providers.map(provider => <Note key={provider.providerId} warning={provider.state !== 'connected'}>{`${provider.providerId}: ${provider.state}${provider.method ? ` · ${provider.method}` : ''}`}</Note>)}</>}
    </Card>
    <Card title="Cloud workspaces">
      {workspaces.data.state === 'loading' && <Note>Loading cloud workspaces…</Note>}
      {workspaces.data.state === 'error' && <Note warning>Cloud workspace inventory unavailable. Account credentials or cloud service access are required; no provisioning was attempted.</Note>}
      {workspaces.data.state === 'ready' && workspaces.data.value.workspaces.length === 0 && <Note>No cloud workspaces were returned.</Note>}
      {workspaces.data.state === 'ready' && workspaces.data.value.workspaces.map(workspace => <div key={workspace.workspaceId} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><text style={{ color: c.text, fontSize: 13 }}>{workspace.branch || workspace.workspaceId}</text><Note>{`${workspace.providerId} · ${workspace.state} · ${workspace.statusCode}`}</Note></div>)}
    </Card>
  </div>
}

export function SettingsPanel({ backend, onError, onClose, onConnect }: SettingsPanelProps) {
  const [tab, setTab] = useState<Tab>('General')
  return <div testId="settings-panel" style={{ display: 'flex',  width: '100%', height: '100%', minHeight: 0, backgroundColor: c.page, flexDirection: 'column' }}>
    <div style={{ display: 'flex',  height: 58, flexShrink: 0, flexDirection: 'row', alignItems: 'center', paddingLeft: 24, paddingRight: 24, gap: 12, borderBottomWidth: 1, borderColor: c.border }}><Icon name="settings" color={c.text} /><text style={{ color: c.strong, fontSize: 18, fontWeight: 500, flexGrow: 1 }}>Settings</text><Action label="Close" onClick={onClose} /></div>
    <div style={{ display: 'flex',  flexDirection: 'row', flexShrink: 0, gap: metrics.tabGap, padding: 16 }}>{(['General', 'Providers', 'Models', 'Integrations', 'Connections', 'Cloud', 'Host setup', 'Coverage'] as const).map(value => <Action key={value} label={value} selected={tab === value} onClick={() => setTab(value)} />)}</div>
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, overflowY: 'scroll', paddingLeft: 24, paddingRight: 24, paddingBottom: 24, gap: 12 }}>
      {tab === 'General' && <><General backend={backend} onError={onError} /><AdvancedSettings backend={backend} onError={onError} /></>}
      {tab === 'Providers' && <Providers backend={backend} onError={onError} />}
      {tab === 'Models' && <><ModelSettings backend={backend} onError={onError} /><OpenCodeSettings backend={backend} onError={onError} /></>}
      {tab === 'Cloud' && <><CloudSettings backend={backend} onError={onError} onConnect={onConnect} /><CloudAccountSettings backend={backend} onError={onError} /></>}
      {tab === 'Host setup' && <HostSettings backend={backend} onError={onError} onConnect={onConnect} />}
      {tab === 'Integrations' && <Integrations backend={backend} onError={onError} />}
      {tab === 'Connections' && <><Connections backend={backend} onError={onError} /><NetworkSettings backend={backend} onError={onError} /></>}
      {tab === 'Coverage' && <><Card title="Native capability coverage"><Note>Backend RPC availability is not UI parity. This matrix describes this settings panel, not the complete Zuse client. Unsupported controls are not simulated.</Note></Card>{nativeSettingsCapabilities.map(([capability, state, detail]) => <Card key={capability} title={capability}><text style={{ color: state === 'Not implemented' ? c.warning : c.accentText, fontSize: 12 }}>{state}</text><Note>{detail}</Note></Card>)}</>}
    </div>
  </div>
}
