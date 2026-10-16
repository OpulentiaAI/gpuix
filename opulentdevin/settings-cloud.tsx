import { useCallback, useEffect, useRef, useState } from 'react'
import { randomUUID } from 'node:crypto'
import type { Backend } from './backend'
import type { CloudAuthStatus, CloudAuthProvider, CloudAuthMethod, CloudAuthLoginOperation } from './zuse-runtime/packages/contracts/src/cloud-auth'
import type { CloudWorkspaceList, CloudProviderList, CloudProjectList } from './zuse-runtime/packages/contracts/src/cloud-workspaces'
import { sealCloudAuthSecret } from './zuse-runtime/packages/utils/src/cloud-auth-crypto'
import { readNamedCredential, publicHttpsUrl } from './settings-safe'
import { openCloudBackend } from './settings-connection'
import { SettingsAction as Action, SettingsCard as Card, SettingsChoices as Choices, SettingsField as Field, SettingsNote as Note, ConfirmAction, useSettingsAction } from './settings-controls'

export function CloudSettings({ backend, onError, onConnect }: { backend: Backend; onError: (error: unknown) => void; onConnect?: (backend: Backend, environmentId: string) => void }) {
  const pendingConnection = useRef<AbortController | null>(null)
  useEffect(() => () => { pendingConnection.current?.abort() }, [backend])
  const connectWorkspace = async (workspaceId: string) => {
    if (!onConnect) throw new Error('Parent connection switching is unavailable')
    const controller = new AbortController()
    pendingConnection.current?.abort(); pendingConnection.current = controller
    const remote = await openCloudBackend(backend, workspaceId, controller.signal)
    if (controller.signal.aborted) { await remote.backend.dispose(); return }
    pendingConnection.current = null
    try { onConnect(remote.backend, remote.environmentId) } catch { await remote.backend.dispose(); throw new Error('The parent could not activate the cloud connection') }
  }
  const [auth, setAuth] = useState<CloudAuthStatus | null>(null)
  const [workspaces, setWorkspaces] = useState<CloudWorkspaceList | null>(null)
  const [providers, setProviders] = useState<CloudProviderList | null>(null)
  const [projects, setProjects] = useState<CloudProjectList | null>(null)
  const [provider, setProvider] = useState<CloudAuthProvider>('claude')
  const [method, setMethod] = useState<CloudAuthMethod>('api-key')
  const [variable, setVariable] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [modelProvider, setModelProvider] = useState('')
  const [operation, setOperation] = useState<CloudAuthLoginOperation | null>(null)
  const [project, setProject] = useState('')
  const [cloudProvider, setCloudProvider] = useState('')
  const [size, setSize] = useState('')
  const [baseRef, setBaseRef] = useState('')
  const [branch, setBranch] = useState('')
  const [agent, setAgent] = useState('claude')
  const [model, setModel] = useState('')
  const [repository, setRepository] = useState('')
  const [visibility, setVisibility] = useState<'public' | 'private'>('private')
  const [requestId, setRequestId] = useState(() => randomUUID())
  const { busy, message, run } = useSettingsAction(onError)
  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([
      backend.run(backend.client['cloud.auth.status']()).then(setAuth),
      backend.run(backend.client['cloud.workspaces.list']({})).then(setWorkspaces),
      backend.run(backend.client['cloud.providers']()).then(setProviders),
      backend.run(backend.client['cloud.projects.list']()).then(setProjects),
    ])
    if (results.some(result => result.status === 'rejected')) throw new Error('One or more cloud inventories are unavailable.')
  }, [backend])
  useEffect(() => { void refresh().catch(() => onError(new Error('Some cloud settings are unavailable. Account credentials or control-plane access may be missing.'))) }, [refresh])
  const lifecycle = (workspaceId: string, action: 'pause' | 'resume' | 'restart' | 'archive' | 'unarchive' | 'delete') => { void run(`${action} cloud workspace`, async () => {
    const input = { workspaceId, commandId: randomUUID() }
    if (action === 'pause') await backend.run(backend.client['cloud.workspaces.pause'](input))
    else if (action === 'resume') await backend.run(backend.client['cloud.workspaces.resume'](input))
    else if (action === 'restart') await backend.run(backend.client['cloud.workspaces.restart'](input))
    else if (action === 'archive') await backend.run(backend.client['cloud.workspaces.archive'](input))
    else if (action === 'unarchive') await backend.run(backend.client['cloud.workspaces.unarchive'](input))
    else await backend.run(backend.client['cloud.workspaces.delete'](input))
    await refresh()
  }) }
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <Action label="Refresh cloud status" disabled={busy} onClick={() => { void run('Refresh cloud status', refresh) }} />
    <Note>No provisioning, credential mutation, login or lifecycle action runs automatically. Refresh reads account state; unavailable access is not treated as disconnected or empty.</Note>
    <Card title="Cloud provider credentials">
      <Note>{auth ? `Credential authority: ${auth.authorityState}` : 'Credential authority unavailable: sign-in or control-plane access may be required.'}</Note>
      {auth?.providers.map(item => <Note key={item.providerId}>{`${item.providerId}: ${item.state} · ${item.method ?? 'method unknown'}`}</Note>)}
      <ConfirmAction label="Provision credential authority" disabled={busy} detail="Create or provision the account-owned credential authority? This may allocate cloud resources." action={() => { void run('Provision credential authority', async () => setAuth(await backend.run(backend.client['cloud.auth.provision']()))) }} />
      <Choices label="Cloud agent provider" values={['claude', 'codex', 'cursor', 'grok']} value={provider} onChange={setProvider} />
      <Choices label="Authentication method" values={['api-key', 'subscription', 'custom']} value={method} onChange={setMethod} />
      <Field label="Secret environment variable name (never enter the secret here)" value={variable} onChange={setVariable} disabled={busy} />
      {method === 'custom' && <><Field label="Custom HTTPS base URL" value={baseUrl} onChange={setBaseUrl} disabled={busy} /><Field label="Model provider name" value={modelProvider} onChange={setModelProvider} disabled={busy} /></>}
      <Note>The named value is encrypted with the authority's public key using Zuse's RSA-OAEP sealing helper, then sent to cloud.auth.configure. That action saves and validates the credential; there is no separate generic provider test RPC.</Note>
      <ConfirmAction label="Save and validate cloud credential" disabled={busy || !variable || !auth?.encryptionKeyId || !auth.encryptionPublicJwk} detail={`Replace and validate the ${provider} cloud credential using the named process variable? The raw value is not persisted locally.`} action={() => { void run('Save and validate cloud credential', async () => {
        const current = await backend.run(backend.client['cloud.auth.status']())
        if (!current.encryptionKeyId || !current.encryptionPublicJwk) throw new Error('Credential authority is not ready.')
        const ciphertext = await sealCloudAuthSecret(current.encryptionPublicJwk, readNamedCredential(variable))
        await backend.run(backend.client['cloud.auth.configure']({ providerId: provider, method, sealedSecret: { keyId: current.encryptionKeyId, ciphertext }, ...(method === 'custom' && baseUrl ? { baseUrl: publicHttpsUrl(baseUrl) } : {}), ...(method === 'custom' && modelProvider.trim() ? { modelProvider: modelProvider.trim() } : {}) }))
        setVariable(''); await refresh()
      }) }} />
      {(provider === 'codex' || provider === 'grok') && <Action label={`Start ${provider} cloud login`} disabled={busy} onClick={() => { const id = provider; if (id !== 'codex' && id !== 'grok') return; void run('Start cloud login', async () => setOperation(await backend.run(backend.client['cloud.auth.login.start']({ providerId: id })))) }} />}
      <ConfirmAction label="Disconnect cloud provider" disabled={busy} detail={`Disconnect ${provider} cloud authentication? Existing runtime access may be affected.`} action={() => { void run('Disconnect cloud provider', async () => { await backend.run(backend.client['cloud.auth.disconnect']({ providerId: provider })); await refresh() }) }} />
      {operation && <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><Note>{`${operation.providerId}: ${operation.state}`}</Note>{operation.verificationUrl && <input readOnly value={operation.verificationUrl} style={{ height: 34 }} />}{operation.verificationCode && <Note>{`Temporary verification code: ${operation.verificationCode}`}</Note>}<Action label="Check cloud login result" disabled={busy} onClick={() => { void run('Check cloud login', async () => { setOperation(await backend.run(backend.client['cloud.auth.login.poll']({ operationId: operation.operationId }))); await refresh() }) }} /><Action label="Cancel cloud login" disabled={busy} onClick={() => { void run('Cancel cloud login', async () => setOperation(await backend.run(backend.client['cloud.auth.login.cancel']({ operationId: operation.operationId })))) }} /></div>}
    </Card>
    <Card title="Connect a cloud repository">
      <Field label="Repository HTTPS URL" value={repository} onChange={setRepository} disabled={busy} /><Field label="Repository default branch / launch base ref" value={baseRef} onChange={setBaseRef} disabled={busy} /><Choices label="Repository visibility" values={['private', 'public']} value={visibility} onChange={setVisibility} />
      <ConfirmAction label="Connect cloud repository" disabled={busy || !repository || !baseRef} detail="Register this repository with the cloud account? Private repositories require existing account access." action={() => { void run('Connect cloud repository', async () => { await backend.run(backend.client['cloud.projects.connect']({ repositoryUrl: publicHttpsUrl(repository), defaultBranch: baseRef.trim(), visibility, idempotencyKey: requestId })); setRequestId(randomUUID()); await refresh() }) }} />
      <Note>{projects ? `${projects.projects.length} registered projects` : 'Project inventory unavailable.'}</Note>
      {projects?.projects.map(item => <Action key={item.projectId} label={`Select project ${item.displayName}`} selected={project === item.projectId} onClick={() => setProject(item.projectId)} />)}
    </Card>
    <Card title="Create cloud workspace">
      <Note>Creation can incur charges. No initial prompt is sent, and permission defaults come from current Zuse settings.</Note>
      <Field label="Cloud project ID" value={project} onChange={setProject} disabled={busy} />
      {providers?.providers.map(item => <Action key={item.providerId} label={`Use cloud provider ${item.displayName}`} selected={cloudProvider === item.providerId} onClick={() => { setCloudProvider(item.providerId); setSize('') }} />)}
      {!providers && <Note warning>Cloud provider inventory unavailable. No provider is assumed.</Note>}
      <Field label="Cloud provider ID" value={cloudProvider} onChange={setCloudProvider} disabled={busy} /><Field label="Size ID (optional provider default)" value={size} onChange={setSize} disabled={busy} /><Field label="Base ref" value={baseRef} onChange={setBaseRef} disabled={busy} /><Field label="Branch (optional)" value={branch} onChange={setBranch} disabled={busy} /><Field label="Agent provider" value={agent} onChange={setAgent} disabled={busy} /><Field label="Model ID" value={model} onChange={setModel} disabled={busy} />
      <ConfirmAction label="Create cloud workspace" disabled={busy || !project || !cloudProvider || !baseRef || !model} detail="Allocate a new cloud workspace using these parameters? This may incur usage charges." action={() => { void run('Create cloud workspace', async () => { const settings = await backend.settings.get(); await backend.run(backend.client['cloud.workspaces.create']({ projectId: project.trim(), providerId: cloudProvider.trim(), ...(size.trim() ? { sizeId: size.trim() } : {}), baseRef: baseRef.trim(), ...(branch.trim() ? { branch: branch.trim() } : {}), agent: agent.trim(), model: model.trim(), runtimeMode: settings.defaultRuntimeMode, idempotencyKey: requestId })); setRequestId(randomUUID()); await refresh() }) }} />
    </Card>
    {!workspaces && <Note warning>Cloud workspaces unavailable; credentials or service access may be missing.</Note>}
    {workspaces?.workspaces.map(item => <Card key={item.workspaceId} title={item.branch || item.workspaceId}><Note>{`${item.workspaceId} · ${item.providerId} · ${item.state} · ${item.statusCode}`}</Note><div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{(['pause', 'resume', 'restart', 'archive', 'unarchive', 'delete'] as const).map(action => <ConfirmAction key={action} label={`${action} ${item.workspaceId}`} disabled={busy} detail={action === 'delete' ? 'Permanently delete this workspace? This cannot be undone.' : `${action} this workspace? Work may be interrupted; resuming may incur charges.`} action={() => lifecycle(item.workspaceId, action)} />)}</div></Card>)}
    <Card title="Connect to an existing cloud workspace">
      <Note>Connection requests a short-lived gateway ticket only. It never provisions, resumes or restarts the workspace. Identity comes from the runtime descriptor, not its disposable endpoint. Reconnect manually after expiry or disconnection.</Note>
      {workspaces?.workspaces.map(item => <Action key={item.workspaceId} label={`Connect cloud ${item.workspaceId}`} disabled={busy || !onConnect} onClick={() => { void run('Connect cloud workspace', () => connectWorkspace(item.workspaceId)) }} />)}
      {!onConnect && <Note warning>Parent environment switching is not connected.</Note>}
      <Action label="Cancel pending cloud connection" onClick={() => pendingConnection.current?.abort()} />
    </Card>
    {message && <Note>{message}</Note>}
  </div>
}
