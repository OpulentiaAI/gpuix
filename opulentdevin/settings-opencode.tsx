import { useCallback, useEffect, useRef, useState } from 'react'
import type { Backend } from './backend'
import type { SettingsFile } from './zuse-runtime/packages/contracts/src/settings'
import type { OpencodeInventory } from './zuse-runtime/packages/contracts/src/agent'
import { publicHttpsUrl, readNamedCredential } from './settings-safe'
import { SettingsAction as Action, SettingsCard as Card, SettingsChoices as Choices, SettingsField as Field, SettingsNote as Note, ConfirmAction, useSettingsAction } from './settings-controls'

export function customEndpointModels(lines: string) {
  const models = lines.split('\n').map(line => line.trim()).filter(Boolean).map(line => { const [id, ...name] = line.split('|'); if (!id?.trim() || /[\u0000-\u001f]/.test(line)) throw new Error('Invalid model entry'); return { id: id.trim(), name: name.join('|').trim() || id.trim() } })
  if (!models.length || new Set(models.map(model => model.id)).size !== models.length) throw new Error('Provide unique model IDs, one per line.')
  return models
}
export function OpenCodeSettings({ backend, onError }: { backend: Backend; onError: (error: unknown) => void }) {
  const [harness, setHarness] = useState<'opencode' | 'opencode2'>('opencode')
  const [inventory, setInventory] = useState<OpencodeInventory | null>(null)
  const [settings, setSettings] = useState<SettingsFile | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState('')
  const [variable, setVariable] = useState('')
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [models, setModels] = useState('')
  const [npm, setNpm] = useState<string>('@ai-sdk/openai-compatible')
  const { busy, message, run } = useSettingsAction(onError)
  const generation = useRef(0)
  const refresh = useCallback(async () => { const request = ++generation.current; const [catalog, prefs] = await Promise.all([backend.run(backend.client['model.catalog']({ refresh: true })), backend.settings.get()]); if (request !== generation.current) return; setInventory((harness === 'opencode' ? catalog.providers.opencode.opencode : catalog.providers.opencode2.opencode2) ?? null); setSettings(prefs) }, [backend, harness])
  useEffect(() => { setSelected(''); void refresh().catch(() => onError(new Error('OpenCode inventory unavailable. Verify its runtime and connection.'))); return () => { generation.current++ } }, [refresh])
  const visible = harness === 'opencode' ? settings?.opencodeProviderVisible : settings?.opencode2ProviderVisible
  const modelVisible = harness === 'opencode' ? settings?.opencodeModelVisibleByProvider : settings?.opencode2ModelVisibleByProvider
  const custom = (harness === 'opencode' ? settings?.opencodeCustomProviders : settings?.opencode2CustomProviders) ?? []
  const provider = inventory?.providers.find(item => item.id === selected)
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <Card title="OpenCode provider manager"><Choices label="OpenCode harness" value={harness} values={['opencode', 'opencode2']} onChange={value => { if (!busy) { setHarness(value); setInventory(null); setSettings(null); setSelected(''); setId(''); setName(''); setUrl(''); setModels(''); setVariable(''); setNpm('@ai-sdk/openai-compatible') } }} /><Action label="Refresh OpenCode providers" disabled={busy} onClick={() => { void run('Refresh OpenCode providers', refresh) }} /><Field label="Filter sub-providers" value={query} onChange={setQuery} />
      {!inventory && <Note warning>No live inventory available. No connected providers are assumed.</Note>}
      {inventory?.providers.filter(item => `${item.id} ${item.name}`.toLowerCase().includes(query.toLowerCase())).map(item => <Action key={item.id} label={`${item.name} (${item.connected ? 'connected' : 'not connected'})`} selected={selected === item.id} onClick={() => { setSelected(item.id); setVariable(item.apiKeyEnv) }} />)}
    </Card>
    {provider && <Card title={provider.name}>
      <Field label="Credential environment variable name" value={variable} onChange={setVariable} disabled={busy} />
      <ConfirmAction label="Save OpenCode provider credential" detail={`Send the named credential to ${harness}'s auth store for ${provider.id}? No secret enters settings.`} disabled={busy || !variable} action={() => { void run('Save OpenCode auth', async () => { const input = { providerId: provider.id, apiKey: readNamedCredential(variable) }; if (harness === 'opencode') await backend.run(backend.client['provider.opencode.setAuth'](input)); else await backend.run(backend.client['provider.opencode2.setAuth'](input)); setVariable(''); await refresh() }) }} />
      <ConfirmAction label="Remove OpenCode provider credential" detail={`Remove the stored credential for ${provider.id}? Sessions using it may fail.`} disabled={busy} action={() => { void run('Remove OpenCode auth', async () => { if (harness === 'opencode') await backend.run(backend.client['provider.opencode.removeAuth']({ providerId: provider.id })); else await backend.run(backend.client['provider.opencode2.removeAuth']({ providerId: provider.id })); await refresh() }) }} />
      <Action label={visible?.[provider.id] === false ? 'Show OpenCode provider' : 'Hide OpenCode provider'} disabled={busy} onClick={() => { void run('Save OpenCode visibility', async () => { const latest = await backend.settings.get(); const map = harness === 'opencode' ? latest.opencodeProviderVisible : latest.opencode2ProviderVisible; const next = { ...map, [provider.id]: map[provider.id] === false }; await backend.settings.update({ patch: harness === 'opencode' ? { opencodeProviderVisible: next } : { opencode2ProviderVisible: next } }); await refresh() }) }} />
      {provider.models.map(model => <Action key={model.id} label={`${modelVisible?.[provider.id]?.[model.id] === false ? 'Show' : 'Hide'} ${model.label}`} disabled={busy} onClick={() => { void run('Save OpenCode model visibility', async () => { const latest = await backend.settings.get(); const map = harness === 'opencode' ? latest.opencodeModelVisibleByProvider : latest.opencode2ModelVisibleByProvider; const next = { ...map, [provider.id]: { ...map[provider.id], [model.id]: map[provider.id]?.[model.id] === false } }; await backend.settings.update({ patch: harness === 'opencode' ? { opencodeModelVisibleByProvider: next } : { opencode2ModelVisibleByProvider: next } }); await refresh() }) }} />)}
    </Card>}
    <Card title="Custom OpenAI-compatible endpoint"><Note>HTTPS endpoints only. API key comes from a named process variable and is stored only by the backend provider auth mechanism. Existing IDs require deliberate replacement confirmation.</Note>
      <Field label="Custom provider ID" value={id} onChange={setId} disabled={busy} /><Field label="Display name" value={name} onChange={setName} disabled={busy} /><Field label="Base HTTPS URL" value={url} onChange={setUrl} disabled={busy} /><Choices label="Provider SDK package" value={npm} values={['@ai-sdk/openai-compatible', '@ai-sdk/openai']} onChange={setNpm} /><Field label="Custom provider credential variable name" value={variable} onChange={setVariable} disabled={busy} />
      <Note>Models: one ID per line, optionally ID | Display name.</Note><textarea testId="opencode-custom-models" value={models} minRows={3} readOnly={busy} onChange={event => setModels(event.value ?? '')} />
      <ConfirmAction label="Save custom OpenCode endpoint" detail={custom.some(item => item.id === id.trim()) ? `Replace custom provider ${id} and its credential/model list?` : `Create trusted custom provider ${id}? Its SDK may contact this endpoint.`} disabled={busy || !id || !name || !url || !variable || !models} action={() => { void run('Save custom endpoint', async () => { if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id.trim())) throw new Error('Invalid provider ID'); const input = { id: id.trim(), name: name.trim(), baseURL: publicHttpsUrl(url), npm, apiKey: readNamedCredential(variable), models: customEndpointModels(models) }; if (harness === 'opencode') await backend.run(backend.client['provider.opencode.addCustom'](input)); else await backend.run(backend.client['provider.opencode2.addCustom'](input)); setVariable(''); await refresh() }) }} />
      {custom.map(item => <div key={item.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><Action label={`Edit endpoint ${item.name}`} onClick={() => { setId(item.id); setName(item.name); setUrl(item.baseURL); setNpm(item.npm); setModels(item.models.map(model => `${model.id} | ${model.name}`).join('\n')); setVariable('') }} /><ConfirmAction label={`Remove endpoint ${item.id}`} detail="Remove this custom provider definition and associated configuration?" disabled={busy} action={() => { void run('Remove custom endpoint', async () => { if (harness === 'opencode') await backend.run(backend.client['provider.opencode.removeCustom']({ id: item.id })); else await backend.run(backend.client['provider.opencode2.removeCustom']({ id: item.id })); await refresh() }) }} /></div>)}
    </Card>{message && <Note>{message}</Note>}
  </div>
}
