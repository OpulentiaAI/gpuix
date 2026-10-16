import { useState } from 'react'
import type { Backend } from './backend'
import { ProjectTemplate } from './zuse-runtime/packages/contracts/src/workspace.ts'
import type { Palette } from './theme'

type Folder = Awaited<ReturnType<Backend['workspaces']['list']>>[number]
export function WorkspacePanel({ backend, folders, onSelect, onError, palette: p }: { backend: Backend; folders: readonly Folder[]; onSelect: (folder: Folder) => void; onError: (error: unknown) => void; palette: Palette }) {
  const [mode, setMode] = useState<'open' | 'clone' | 'create'>('open')
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [template, setTemplate] = useState<typeof ProjectTemplate.Type>(ProjectTemplate.literals[0])
  const [busy, setBusy] = useState(false)
  async function submit() {
    if (busy || !path.trim()) return
    setBusy(true)
    try {
      const folder = mode === 'open' ? await backend.workspaces.add({ path: path.trim() }) : mode === 'clone' ? await backend.workspaces.clone({ url, parent: path }) : await backend.workspaces.create({ name, parent: path, template, alsoCreateGithubRepo: false })
      onSelect(folder)
    } catch (error) { onError(error) } finally { setBusy(false) }
  }
  const field = { color: p.text, backgroundColor: p.page, padding: 10, borderRadius: 8, fontSize: 13 }
  return <div testId="workspace-dialog" style={{ marginTop: 24, width: '90%', maxWidth: 680, borderRadius: 16, backgroundColor: p.elevated, padding: 20, gap: 12 }}>
    <text style={{ color: p.text, fontSize: 18 }}>Workspaces</text>
    {folders.map(folder => <div key={folder.id} onClick={() => onSelect(folder)} style={{ padding: 8, cursor: 'pointer', hover: { backgroundColor: p.hover } }}><text style={{ color: p.text, fontSize: 13 }}>{folder.name}</text><text style={{ color: p.secondary, fontSize: 12 }}>{folder.path}</text></div>)}
    <div style={{ display: 'flex', flexDirection: 'row', gap: 8 }}>{(['open', 'clone', 'create'] as const).map(value => <div key={value} testId={`workspace-mode-${value}`} onClick={() => setMode(value)} style={{ padding: 8, borderRadius: 6, backgroundColor: mode === value ? p.selected : undefined, cursor: 'pointer' }}><text style={{ color: p.text, fontSize: 13 }}>{value === 'open' ? 'Open folder' : value === 'clone' ? 'Clone repository' : 'Create project'}</text></div>)}</div>
    <input testId="workspace-path" value={path} placeholder={mode === 'open' ? 'Absolute path to a project folder' : 'Absolute parent directory'} onChange={e => setPath(e.value ?? '')} onSubmit={submit} style={field} />
    {mode === 'clone' && <input value={url} placeholder="Repository URL" onChange={e => setUrl(e.value ?? '')} style={field} />}
    {mode === 'create' && <><input value={name} placeholder="Project name" onChange={e => setName(e.value ?? '')} style={field} /><div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>{ProjectTemplate.literals.map(value => <div key={value} onClick={() => setTemplate(value)} style={{ padding: 6, cursor: 'pointer', backgroundColor: template === value ? p.selected : undefined }}><text style={{ color: p.text, fontSize: 12 }}>{value}</text></div>)}</div><text style={{ color: p.secondary, fontSize: 12 }}>Creates local files and installs the selected template. No repository is published.</text></>}
    <div testId="workspace-add" onClick={submit} style={{ padding: 10, borderRadius: 8, backgroundColor: p.inverse, opacity: busy ? 0.5 : 1, cursor: busy ? 'default' : 'pointer' }}><text style={{ color: p.inverseText, fontSize: 13 }}>{busy ? 'Working...' : mode === 'open' ? 'Open folder' : mode === 'clone' ? 'Clone repository' : 'Create project'}</text></div>
  </div>
}
