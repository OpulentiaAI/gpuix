import { useEffect, useState } from 'react'
import type { Backend } from './backend'
import type { SettingsFile, SettingsPatch } from './zuse-runtime/packages/contracts/src/settings'
import type { ProviderId } from './zuse-runtime/packages/contracts/src/agent'
import { presetModelPatch } from './settings-safe'
import { SettingsCard as Card, SettingsAction as Action, SettingsChoices as Choices, SettingsField as Field, SettingsNote as Note, useSettingsAction } from './settings-controls'

export function AdvancedSettings({ backend, onError }: { backend: Backend; onError: (error: unknown) => void }) {
  const [settings, setSettings] = useState<SettingsFile | null>(null)
  const [provider, setProvider] = useState<ProviderId>('claude')
  const [binary, setBinary] = useState('')
  const [preset, setPreset] = useState('')
  const [description, setDescription] = useState('')
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('')
  const [maxTurns, setMaxTurns] = useState('')
  const { busy, message, run } = useSettingsAction(onError)
  useEffect(() => { void backend.settings.get().then(setSettings).catch(() => onError(new Error('Advanced settings unavailable.'))) }, [backend])
  const save = (label: string, patch: (latest: SettingsFile) => SettingsPatch) => void run(label, async () => { const latest = await backend.settings.get(); setSettings(await backend.settings.update({ patch: patch(latest) })) })
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <Note>These forms preserve runtime/permission modes and unrelated settings. No commands are executed by saving a preference.</Note>
    {message && <Note>{message}</Note>}
    {!settings && <Action label="Load advanced settings" onClick={() => { void run('Read settings', async () => setSettings(await backend.settings.get())) }} />}
    {settings && <>
      <Card title="Git defaults"><Choices label="Merge method preference" value={settings.mergePrefs.method} values={['merge', 'squash', 'rebase']} onChange={method => save('Save merge preference', latest => ({ mergePrefs: { ...latest.mergePrefs, method } }))} /><Action label={settings.mergePrefs.deleteBranch ? 'Keep branch after merge' : 'Delete branch after merge'} disabled={busy} onClick={() => save('Save branch deletion preference', latest => ({ mergePrefs: { ...latest.mergePrefs, deleteBranch: !latest.mergePrefs.deleteBranch } }))} /><Note>Saving the default does not merge or delete any branch.</Note></Card>
      <Card title="Provider executable override"><Choices label="Provider" value={provider} values={['claude', 'codex', 'grok', 'gemini', 'cursor', 'opencode', 'opencode2', 'kiro', 'pi']} onChange={value => { setProvider(value); setBinary(settings.providerBinaryPaths?.[value] ?? '') }} /><Field label="Absolute executable path; blank restores discovery" value={binary} onChange={setBinary} disabled={busy} /><Action label="Save executable override" disabled={busy} onClick={() => save('Save executable override', latest => { if (binary && (!binary.startsWith('/') || /[\r\n\u0000]/.test(binary))) throw new Error('Use an absolute path without control characters'); const paths = { ...latest.providerBinaryPaths }; if (binary.trim()) paths[provider] = binary.trim(); else delete paths[provider]; return { providerBinaryPaths: paths } })} /></Card>
      <Card title="Subagent presets"><Action label={settings.subagents.enableForNewSessions ? 'Disable subagents for new sessions' : 'Enable subagents for new sessions'} disabled={busy} onClick={() => save('Save subagent default', latest => ({ subagents: { ...latest.subagents, enableForNewSessions: !latest.subagents.enableForNewSessions } }))} /><Choices label="Existing preset" value={preset} values={Object.keys(settings.subagents.presets)} onChange={key => { setPreset(key); setDescription(settings.subagents.presets[key]?.overrides.description ?? ''); setPrompt(settings.subagents.presets[key]?.overrides.prompt ?? ''); setModel(settings.subagents.presets[key]?.overrides.model ?? ''); setMaxTurns(settings.subagents.presets[key]?.overrides.maxTurns?.toString() ?? '') }} />{preset && <><Field label="Model override (blank inherits)" value={model} onChange={setModel} disabled={busy} /><Field label="Maximum turns (blank inherits)" value={maxTurns} onChange={setMaxTurns} disabled={busy} /><Action label="Save preset model and turns" disabled={busy} onClick={() => save('Save preset model and turns', latest => presetModelPatch(latest, preset, model, maxTurns))} /><Field label="Description override" value={description} onChange={setDescription} disabled={busy} /><Field label="Prompt override" value={prompt} onChange={setPrompt} disabled={busy} /><Action label="Save preset text" disabled={busy} onClick={() => save('Save preset text', latest => { const current = latest.subagents.presets[preset]; if (!current) throw new Error('Preset no longer exists'); return { subagents: { ...latest.subagents, presets: { ...latest.subagents.presets, [preset]: { ...current, overrides: { ...current.overrides, description, prompt } } } } } })} /><Action label="Toggle selected preset" disabled={busy} onClick={() => save('Save preset enablement', latest => { const current = latest.subagents.presets[preset]; if (!current) throw new Error('Preset no longer exists'); return { subagents: { ...latest.subagents, presets: { ...latest.subagents.presets, [preset]: { ...current, enabled: !current.enabled } } } } })} /></>}<Note>Model and turn limits change only via their save action. Existing tool restrictions and permission modes are preserved.</Note></Card>
    </>}
  </div>
}
