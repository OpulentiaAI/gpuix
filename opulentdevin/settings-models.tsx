import { useCallback, useEffect, useRef, useState } from 'react'
import type { Backend, Subscription } from './backend'
import type { ProviderId } from './zuse-runtime/packages/contracts/src/agent'
import type { SettingsFile } from './zuse-runtime/packages/contracts/src/settings'
import type { ResolvedModelCatalog } from './zuse-runtime/packages/contracts/src/model-catalog/resolved'
import { modelPatch, readNamedCredential } from './settings-safe'
import { SettingsAction as Action, SettingsCard as Card, SettingsChoices as Choices, SettingsField as Field, SettingsNote as Note, ConfirmAction, useSettingsAction } from './settings-controls'

const providers: readonly ProviderId[] = ['claude', 'codex', 'grok', 'gemini', 'cursor', 'opencode', 'opencode2', 'kiro', 'pi']
export function ModelSettings({ backend, onError }: { backend: Backend; onError: (error: unknown) => void }) {
  const [provider, setProvider] = useState<ProviderId>('claude')
  const [settings, setSettings] = useState<SettingsFile | null>(null)
  const [catalog, setCatalog] = useState<ResolvedModelCatalog | null>(null)
  const [model, setModel] = useState('')
  const [credentialName, setCredentialName] = useState('')
  const [binary, setBinary] = useState('')
  const [update, setUpdate] = useState('')
  const updateSubscription = useRef<Subscription | null>(null)
  const [updating, setUpdating] = useState(false)
  const { busy, message, run } = useSettingsAction(onError)
  const refresh = useCallback(async () => {
    const [nextSettings, nextCatalog] = await Promise.all([backend.settings.get(), backend.run(backend.client['model.catalog']({}))])
    setSettings(nextSettings); setCatalog(nextCatalog)
  }, [backend])
  useEffect(() => { void refresh().catch(() => onError(new Error('Model settings could not be loaded.'))); return () => { updateSubscription.current?.cancel() } }, [refresh])
  useEffect(() => { setBinary(settings?.providerBinaryPaths?.[provider] ?? '') }, [provider, settings])
  const modifyModel = (action: 'default' | 'visibility' | 'add' | 'remove', id: string, enabled = true) => { void run('Save model settings', async () => { const latest = await backend.settings.get(); await backend.settings.update({ patch: modelPatch(latest, provider, action, id, enabled) }); await refresh() }) }
  const updateProvider = () => {
    if (updateSubscription.current) return
    setUpdating(true); setUpdate('Updating provider runtime. Raw installer output is withheld.')
    try {
      const subscription = backend.subscribe(backend.providers.update({ providerId: provider }), event => {
        if (event._tag === 'done') setUpdate(event.ok ? 'Provider update completed. Refresh availability to verify.' : 'Provider update failed. Use the provider’s documented installer for diagnostics.')
      }, () => { setUpdate('Provider update failed; no raw installer output was retained.'); onError(new Error('Provider update failed.')) })
      updateSubscription.current = subscription
      void subscription.done.finally(() => { updateSubscription.current = null; setUpdating(false) })
    } catch { setUpdating(false); setUpdate('Provider update could not start.') }
  }
  const models = catalog?.providers[provider].models ?? []
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <Choices label="Provider" value={provider} values={providers} onChange={setProvider} />
    <Action label="Reload model catalogue" disabled={busy} onClick={() => { void run('Refresh model catalogue', async () => { setCatalog(await backend.run(backend.client['model.catalog']({ refresh: true }))); setSettings(await backend.settings.get()) }) }} />
    <Card title="Provider credentials and runtime">
      <Note>Secret values are never rendered. Name a variable already present in this application's environment; the backend stores its value in its credential store.</Note>
      <Field label="Credential environment variable name" value={credentialName} onChange={setCredentialName} placeholder="ANTHROPIC_API_KEY" disabled={busy} />
      <ConfirmAction label="Save provider credential" detail={`Store the named variable as the ${provider} API key and run the backend's credential validation?`} disabled={busy || !credentialName} action={() => { void run('Save provider credential', async () => { await backend.providers.setCredential({ providerId: provider, apiKey: readNamedCredential(credentialName) }); setCredentialName('') }) }} />
      <ConfirmAction label="Remove provider credential" detail={`Remove the app-managed ${provider} API key? CLI login credentials are separate.`} disabled={busy} action={() => { void run('Remove provider credential', () => backend.providers.removeCredential({ providerId: provider })) }} />
      <Field label="Provider executable path (empty uses automatic discovery)" value={binary} onChange={setBinary} disabled={busy} />
      <Action label="Save executable path" disabled={busy} onClick={() => { void run('Save executable path', async () => { if (/[\r\n\u0000]/.test(binary)) throw new Error('Invalid path'); const current = await backend.settings.get(); const paths = { ...current.providerBinaryPaths }; if (binary.trim()) paths[provider] = binary.trim(); else delete paths[provider]; await backend.settings.update({ patch: { providerBinaryPaths: paths } }); await refresh() }) }} />
      <ConfirmAction label="Install or update provider" detail={`Run Zuse's built-in installer/updater for ${provider}? This may download packages and change the installed runtime.`} disabled={updating || busy} action={updateProvider} />
      {update && <Note>{update}</Note>}
    </Card>
    <Card title="Default and custom models">
      <Note>{`Default: ${settings?.defaultModelByProvider[provider] ?? 'loading'} · live inventory: ${catalog?.providers[provider].live.status ?? 'loading'}`}</Note>
      <Field label="Custom model ID" value={model} onChange={setModel} disabled={busy} />
      <Action label="Add custom model" disabled={busy || !model.trim()} onClick={() => modifyModel('add', model)} />
      {settings?.customModelIdsByProvider[provider].map(id => <div key={id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><Note>{id}</Note><div style={{ display: 'flex',  flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Action label={`Default ${id}`} disabled={busy} onClick={() => modifyModel('default', id)} /><Action label={`Remove ${id}`} disabled={busy || settings.defaultModelByProvider[provider] === id} onClick={() => modifyModel('remove', id)} /></div></div>)}
    </Card>
    {!settings || !catalog ? <Note>Reading model settings…</Note> : models.map(item => { const enabled = settings.modelEnabledByProvider[provider][item.id] ?? item.defaultVisible ?? true; return <Card key={item.id} title={item.label}><Note>{`${item.id} · ${item.origin} · ${item.available ? 'available' : 'not currently available'}`}</Note><div style={{ display: 'flex',  flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Action label={`Use ${item.id} by default`} selected={settings.defaultModelByProvider[provider] === item.id} disabled={busy || !item.available} onClick={() => modifyModel('default', item.id)} /><Action label={`${enabled ? 'Hide' : 'Show'} ${item.id}`} disabled={busy} onClick={() => modifyModel('visibility', item.id, !enabled)} /></div></Card> })}
    {message && <Note>{message}</Note>}
  </div>
}
