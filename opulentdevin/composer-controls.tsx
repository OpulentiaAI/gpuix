import { useEffect, useRef, useState } from 'react'
import { open } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import type { Backend } from './backend'
import type { Session } from './zuse-runtime/packages/contracts/src/session'
import type { FolderId } from './zuse-runtime/packages/contracts/src/ids'
import type { ProviderId } from './zuse-runtime/packages/contracts/src/agent'
import { ComposerInput, type FileRef } from './zuse-runtime/packages/contracts/src/composer'
import type { Skill } from './zuse-runtime/packages/contracts/src/skill'
import type { ResolvedModelOption, ResolvedModelCatalogProvider } from './zuse-runtime/packages/contracts/src/model-catalog/resolved'
import { palettes, type Palette } from './theme'

export { ComposerInput }
export const emptyComposerInput = () => new ComposerInput({ text: '', attachments: [], fileRefs: [], skillRefs: [], annotations: [] })
export type ComposerControlsProps = { backend: Backend; session: Session | null; folderId: FolderId | null; input: ComposerInput; onInput: (input: ComposerInput) => void; onError: (message: string) => void; palette?: Palette }
export type ModelPickerProps = { backend: Backend; providerId: ProviderId; value: string; onChange: (model: string) => void; onError: (message: string) => void; palette?: Palette }

export async function readImageAttachment(path: string) {
  if (!isAbsolute(path)) throw new Error('Choose an absolute local image path.')
  const mime = new Map([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'], ['.webp', 'image/webp']]).get(extname(path).toLowerCase())
  if (!mime) throw new Error('Choose PNG, JPEG, GIF or WebP. Use a workspace file reference for other files.')
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new Error('Choose an image file smaller than 20 MiB.')
    const bytes = new Uint8Array(await file.readFile())
    const signature = Buffer.from(bytes.subarray(0, 12))
    const valid = mime === 'image/png' ? signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : mime === 'image/jpeg' ? signature[0] === 255 && signature[1] === 216 && signature[2] === 255 : mime === 'image/gif' ? /^GIF8[79]a/.test(signature.toString('ascii')) : signature.toString('ascii', 0, 4) === 'RIFF' && signature.toString('ascii', 8, 12) === 'WEBP'
    if (!valid) throw new Error('The file contents do not match the selected image format.')
    return { bytes, mimeType: mime, originalName: basename(path) }
  } finally { await file.close() }
}

export function resolveProviderModel(provider: ResolvedModelCatalogProvider, value: string): string {
  if (provider.models.some(model => model.id === value && model.available)) return value
  return provider.models.some(model => model.id === provider.defaultModelId && model.available) ? provider.defaultModelId : ''
}

export function useProviderModel(backend: Backend | null, providerId: ProviderId, value: string, onChange: (model: string) => void, onError: (message: string) => void) {
  const current = useRef({ value, onChange, onError }); current.current = { value, onChange, onError }
  const [catalogue, setCatalogue] = useState<{ providerId: ProviderId; provider: ResolvedModelCatalogProvider } | null>(null)
  useEffect(() => {
    setCatalogue(null)
    if (!backend) return
    const sub = backend.subscribe(backend.client['model.catalog.stream']({}), next => setCatalogue({ providerId, provider: next.providers[providerId] }), error => current.current.onError(String(error)))
    return () => sub.cancel()
  }, [backend, providerId])
  useEffect(() => {
    if (!catalogue || catalogue.providerId !== providerId) return
    const next = resolveProviderModel(catalogue.provider, value)
    if (next !== value) current.current.onChange(next)
  }, [catalogue, providerId, value])
  return catalogue?.providerId === providerId && resolveProviderModel(catalogue.provider, value) === value && value.length > 0
}

export function ModelPicker({ backend, providerId, value, onChange, onError, palette: p = palettes.dark }: ModelPickerProps) {
  const [models, setModels] = useState<readonly ResolvedModelOption[]>([])
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState('')
  useEffect(() => {
    setModels([])
    const sub = backend.subscribe(backend.client['model.catalog.stream']({}), catalogue => setModels(catalogue.providers[providerId].models), error => onError(String(error)))
    return () => sub.cancel()
  }, [backend, providerId])
  const matches = models.filter(model => model.label.toLowerCase().includes(query.toLowerCase()) || model.id.toLowerCase().includes(query.toLowerCase()))
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
    <div testId="model-picker-toggle" onClick={() => setExpanded(!expanded)} style={{ display: 'flex', height: 28, paddingLeft: 8, paddingRight: 8, borderRadius: 6, backgroundColor: p.subtle, cursor: 'pointer', alignItems: 'center' }}><text style={{ color: p.text, fontSize: 12 }}>{(models.find(model => model.id === value)?.label ?? value) || 'Choose model'}</text></div>
    {expanded && <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 180, overflowY: 'scroll', backgroundColor: p.wash, padding: 8 }}><input value={query} onChange={event => setQuery(event.value ?? '')} placeholder="Filter model catalogue" style={{ height: 28, color: p.text }} />{matches.map(model => <div key={model.id} testId={`model-${model.id}`} onClick={() => { if (model.available) { onChange(model.id); setExpanded(false) } }} style={{ display: 'flex', padding: 6, cursor: model.available ? 'pointer' : 'default', backgroundColor: model.id === value ? p.selected : undefined }}><text style={{ color: model.available ? p.text : p.disabled, fontSize: 12 }}>{model.label}{model.available ? '' : ' · unavailable'}</text></div>)}{matches.length === 0 && <text style={{ color: p.secondary, fontSize: 11 }}>No matching models reported by the server.</text>}</div>}
  </div>
}

export function ComposerControls({ backend, session, folderId, input, onInput, onError, palette: p = palettes.dark }: ComposerControlsProps) {
  const [panel, setPanel] = useState<'files' | 'skills' | 'image' | null>(null)
  const [path, setPath] = useState('')
  const [query, setQuery] = useState('')
  const [args, setArgs] = useState('')
  const [files, setFiles] = useState<readonly FileRef[]>([])
  const [skills, setSkills] = useState<readonly Skill[]>([])
  const [busy, setBusy] = useState(false)
  const latest = useRef(input); latest.current = input
  const currentSession = useRef(session?.id); currentSession.current = session?.id
  useEffect(() => { setFiles([]); setSkills([]); setPanel(null); setQuery(''); setArgs('') }, [session?.id])
  useEffect(() => {
    if (panel !== 'files' || !folderId) return
    let live = true
    const timer = setTimeout(() => void backend.run(backend.client['workspace.searchFiles']({ projectId: folderId, query, worktreeId: session?.worktreeId, limit: 30 })).then(result => { if (live) setFiles(result) }).catch(error => { if (live) onError(String(error)) }), 150)
    return () => { live = false; clearTimeout(timer) }
  }, [panel, query, folderId, session?.worktreeId, backend])
  useEffect(() => {
    if (!session) return
    const sub = backend.subscribe(backend.client['skill.stream']({ sessionId: session.id }), setSkills, error => onError(String(error)))
    return () => sub.cancel()
  }, [backend, session?.id])
  const update = (patch: Partial<ComposerInput>) => onInput(new ComposerInput({ ...latest.current, ...patch }))
  const button = (label: string, run: () => void, disabled = false) => <div key={label} onClick={() => { if (!busy && !disabled) run() }} style={{ display: 'flex', height: 28, paddingLeft: 8, paddingRight: 8, alignItems: 'center', borderRadius: 6, backgroundColor: p.subtle, cursor: disabled || busy ? 'default' : 'pointer' }}><text style={{ color: disabled || busy ? p.disabled : p.text, fontSize: 12 }}>{label}</text></div>
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <div style={{ display: 'flex', flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{button('Workspace file', () => setPanel(panel === 'files' ? null : 'files'), !folderId)}{button('Skill', () => setPanel(panel === 'skills' ? null : 'skills'), !session)}{button('Attach image', () => setPanel(panel === 'image' ? null : 'image'), !session)}{session && <ModelPicker backend={backend} providerId={session.providerId} value={session.model} onError={onError} palette={p} onChange={model => { void backend.sessions.setModel({ sessionId: session.id, model }).catch(error => onError(String(error))) }} />}</div>
    {!session && <text style={{ color: p.secondary, fontSize: 11 }}>Select a session to upload images or choose its skills. Workspace references can be prepared now.</text>}
    {panel === 'files' && <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 160, overflowY: 'scroll' }}><input value={query} onChange={event => setQuery(event.value ?? '')} placeholder="Search this workspace" style={{ height: 28, color: p.text }} />{files.map(file => button(file.relPath, () => { if (!input.fileRefs.some(ref => ref.absPath === file.absPath)) update({ fileRefs: [...latest.current.fileRefs, file] }); setPanel(null) }))}{files.length === 0 && <text style={{ color: p.secondary, fontSize: 11 }}>No files reported.</text>}</div>}
    {panel === 'skills' && <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 160, overflowY: 'scroll' }}><input value={args} onChange={event => setArgs(event.value ?? '')} placeholder="Skill arguments (if required)" style={{ height: 28, color: p.text }} />{skills.map(skill => button(`${skill.name} · ${skill.scope}`, () => { update({ skillRefs: [...latest.current.skillRefs, { name: skill.name, scope: skill.scope, providerId: skill.providerId, args }] }); setPanel(null) }))}{skills.length === 0 && <text style={{ color: p.secondary, fontSize: 11 }}>This provider has not reported any skills.</text>}</div>}
    {panel === 'image' && <div style={{ display: 'flex', flexDirection: 'row', gap: 6 }}><input value={path} onChange={event => setPath(event.value ?? '')} placeholder="Absolute local image path (20 MiB maximum)" style={{ height: 28, flexGrow: 1, color: p.text }} />{button(busy ? 'Uploading' : 'Upload', () => { const selected = session; if (!selected) return; setBusy(true); void readImageAttachment(path.trim()).then(async image => { const uploaded = await backend.run(backend.client['attachments.upload']({ sessionId: selected.id, ...image })); if (currentSession.current === selected.id) { update({ attachments: [...latest.current.attachments, { id: uploaded.id, mimeType: uploaded.mimeType, originalName: image.originalName }] }); setPanel(null); setPath('') } }).catch(error => onError(String(error))).finally(() => setBusy(false)) }, !path.trim())}</div>}
    <div style={{ display: 'flex', flexDirection: 'row', gap: 4, flexWrap: 'wrap' }}>{input.attachments.map(ref => button(`Remove ${ref.originalName}`, () => update({ attachments: latest.current.attachments.filter(item => item.id !== ref.id) })))}{input.fileRefs.map(ref => button(`Remove ${ref.relPath}`, () => update({ fileRefs: latest.current.fileRefs.filter(item => item.absPath !== ref.absPath) })))}{input.skillRefs.map((ref, index) => button(`Remove /${ref.name} (${index + 1})`, () => update({ skillRefs: latest.current.skillRefs.filter((_, i) => i !== index) })))}</div>
  </div>
}
