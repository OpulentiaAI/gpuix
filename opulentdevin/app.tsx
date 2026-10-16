import { useEffect, useRef, useState } from 'react'
import type { JSX } from '@gpuix/react/jsx-runtime'
import type { Backend, BackendOptions } from './backend'
import { useBackendConnection, useTimeline, subscribeLive } from './connection'
import { emptySessionTimelineState, reduceSessionTimelineFrame } from './zuse-runtime/packages/client-runtime/src/session-timeline.ts'
import { CommandId, EnvironmentId } from './zuse-runtime/packages/contracts/src/ids.ts'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Outbox, prepareMessage, prepareChat, type PendingCommand } from './outbox'
import type { ProviderId } from './zuse-runtime/packages/contracts/src/agent.ts'
import type { Message, Session } from './zuse-runtime/packages/contracts/src/session.ts'
import { Icon, type IconName } from './icons'
import { palettes, metrics, typography, type Palette } from './theme'
import { loadPreferences, savePreferences, dataDirectory } from './preferences'
import { ComposerControls, ModelPicker, useProviderModel, emptyComposerInput, ComposerInput } from './composer-controls'
import { SessionManagement } from './session-management'
import { WorkspacePanel } from './workspaces'
import { Workbench } from './workbench'
import { Transcript } from './transcript'
import { useGpuix, type PublicInstance } from '@gpuix/react'
import type { KeybindingRule } from './zuse-runtime/packages/contracts/src/keybindings'
import { matchNativeCommand } from './shortcuts'
import { useCompletionNotifications, loadCompletionNotifications, saveCompletionNotifications } from './completion-notifications'
import { AdvancedSurfaces } from './advanced-surfaces'
import type { LocalServerManager } from './local-server'
import { LocalServerControls } from './local-server-controls'
import { VoiceControls } from './voice-controls'
import { QueuePanel } from './queue'
import { DevinHome, DevinComposerShell } from './devin-home'
import { DevinSidebar } from './devin-sidebar'
import { KeybindingSettings } from './keybindings'
import { CommandPalette } from './commands'
import { BrowserPane } from './browser'
import { SettingsPanel } from './settings'

function Box({ style, ...props }: JSX.IntrinsicElements['div']) {
  return <div {...props} style={{ display: 'flex', flexDirection: 'column', ...style }} />
}

type Folder = Awaited<ReturnType<Backend['workspaces']['list']>>[number]
type Provider = Awaited<ReturnType<Backend['providers']['list']>>[number]

function Action({ label, icon, onClick, active, palette: p, testId }: { label: string; icon?: IconName; onClick: () => void; active?: boolean; palette: Palette; testId?: string }) {
  return <Box testId={testId} onClick={onClick} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 7, borderRadius: 6, cursor: 'pointer', backgroundColor: active ? p.selected : undefined, hover: { backgroundColor: p.hover } }}>
    {icon && <Icon name={icon} size={16} color={p.secondary} />}<text style={{ color: p.text, fontSize: 13 }}>{label}</text>
  </Box>
}


export function ConnectedApp({ backend: initialBackend, connectionError, connectionOptions }: { backend: Backend | null; connectionError?: string; connectionOptions: BackendOptions }) {
  const [error, setError] = useState(connectionError)
  const connection = useBackendConnection(initialBackend, setError, connectionOptions)
  const [remote, setRemote] = useState<{ backend: Backend; environmentId: string } | null>(null)
  useEffect(() => () => { void remote?.backend.dispose() }, [remote])
  const environmentId = remote ? EnvironmentId.make(remote.environmentId) : connection.environmentId
  return <App key={environmentId} backend={remote?.backend ?? connection.backend} connectionError={error} environmentId={environmentId} connectionStatus={remote ? 'remote' : connection.status} reconnect={remote ? () => { setRemote(null) } : connection.reconnect} reportFailure={remote ? cause => setError(`Remote connection interrupted: ${String(cause)}. Return to Host setup to reconnect.`) : connection.reportFailure} onConnect={(backend, identity) => { setRemote({ backend, environmentId: identity }) }} />
}

export function App({ backend, connectionError, environmentId, connectionStatus, reconnect, reportFailure, onConnect, localServer }: { backend: Backend | null; connectionError?: string; environmentId: EnvironmentId; connectionStatus: string; reconnect: () => void; reportFailure: (error: unknown) => void; onConnect: (backend: Backend, environmentId: string) => void; localServer?: LocalServerManager }) {
  const [preferences, setPreferences] = useState(loadPreferences)
  const [keybindings, setKeybindings] = useState<readonly KeybindingRule[]>([])
  const composerRef = useRef<PublicInstance>(null)
  const { renderer } = useGpuix()
  useEffect(() => { if (!backend) return; const sub = backend.subscribe(backend.client['keybindings.stream'](), value => setKeybindings(value.rules), onError => reportFailure(onError)); return () => sub.cancel() }, [backend])
  const p = palettes[preferences.theme]
  const [notificationsEnabled, setNotificationsEnabled] = useState(loadCompletionNotifications)
  const [folders, setFolders] = useState<readonly Folder[]>([])
  const [folder, setFolder] = useState<Folder | null>(null)
  const [sessions, setSessions] = useState<readonly Session[]>([])
  const [session, setSession] = useState<Session | null>(null)
  const [providers, setProviders] = useState<readonly Provider[]>([])
  const [provider, setProvider] = useState<ProviderId>('claude')
  const [model, setModel] = useState('')
  const [outbox] = useState(() => new Outbox(join(dataDirectory, `outbox-${createHash('sha256').update(environmentId).digest('hex').slice(0, 24)}.json`), environmentId))
  const [pending, setPending] = useState<readonly PendingCommand[]>(() => outbox.pending())
  const sending = useRef(false)
  const [input, setInput] = useState(emptyComposerInput)
  const latestInput = useRef(input)
  latestInput.current = input
  const draft = input.text
  const setDraft = (text: string) => setInput(value => new ComposerInput({ ...value, text }))
  const [filter, setFilter] = useState('')
  const [panel, setPanel] = useState<'none' | 'workspace' | 'providers' | 'settings' | 'search' | 'browser' | 'commands' | 'keybindings' | 'tools' | 'queue' | 'sharing' | 'voice'>('none')
  const [workbench, setWorkbench] = useState(false)
  const [previewUrl, setPreviewUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(connectionError ?? '')
  const [plan, setPlan] = useState(false)
  const generation = useRef(0)
  useCompletionNotifications({ backend, projectId: folder?.id ?? null, enabled: notificationsEnabled, onError: setError })
  const timeline = useTimeline(backend, session?.id ?? null, environmentId, setError, reportFailure)
  const modelReady = useProviderModel(session ? null : backend, provider, model, setModel, setError)
  const report = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))
  useEffect(() => { savePreferences(preferences) }, [preferences])
  useEffect(() => {
    if (!backend) return
    let live = true
    backend.workspaces.list({}).then(rows => { if (!live) return; setFolders(rows); setFolder(rows.find(row => row.id === preferences.workspaceId) ?? rows[0] ?? null) }).catch(report)
    backend.providers.list({}).then(rows => { if (live) setProviders(rows) }).catch(report)
    const subscription = subscribeLive(backend, backend.workspaces.changes({}), rows => { if (live) setFolders(rows) }, report, reportFailure)
    return () => { live = false; subscription.cancel() }
  }, [backend])
  useEffect(() => {
    if (!backend || !folder) return
    const current = ++generation.current
    setPreferences(value => ({ ...value, workspaceId: folder.id }))
    setSession(null)
    backend.sessions.list({ projectId: folder.id }).then(rows => { if (current !== generation.current) return; setSessions(rows); setSession(rows.find(row => row.id === preferences.sessionId) ?? null) }).catch(report)
    const subscription = subscribeLive(backend, backend.sessions.changes({ projectId: folder.id }), change => {
      if (current !== generation.current) return
      if (change._tag === 'snapshot') setSessions(change.sessions)
      else if (change._tag === 'remove') setSessions(rows => rows.filter(row => row.id !== change.sessionId))
      else setSessions(rows => [change.session, ...rows.filter(row => row.id !== change.session.id)])
    }, report, reportFailure)
    return () => subscription.cancel()
  }, [backend, folder?.id])
  useEffect(() => {
    if (!session) return
    setPreferences(value => ({ ...value, sessionId: session.id }))
    setProvider(session.providerId); setModel(session.model)
    setInput(emptyComposerInput())
  }, [session?.id])
  async function dispatch(entry: PendingCommand) {
    if (!backend || sending.current) return
    sending.current = true; setBusy(true); setError('')
    const submittedInput = latestInput.current
    try {
      if (entry.command.kind === 'messages.send') await backend.messages.send(entry.command.payload)
      else setSession((await backend.chats.create(entry.command.payload)).initialSession)
      outbox.ack(entry.command.commandId, entry.fingerprint)
      setPending(outbox.pending())
      if (latestInput.current === submittedInput) setInput(emptyComposerInput())
    } catch (cause) { report(cause) } finally { sending.current = false; setBusy(false) }
  }
  async function send() {
    if (!backend || busy || sending.current || (!draft.trim() && !input.attachments.length && !input.fileRefs.length && !input.skillRefs.length)) return
    if (pending.length) { setError('A previous send has an unknown outcome. Retry its saved identity before starting another turn.'); return }
    if (!folder) { setPanel('workspace'); return }
    if (!session && (!model || !modelReady)) { setPanel('providers'); setError('Choose an available model from the provider catalogue.'); return }
    try {
      const command = session ? prepareMessage({ sessionId: session.id, input }) : prepareChat({ projectId: folder.id, providerId: provider, model, initialPrompt: draft, startupInput: input, title: draft.slice(0, 70) || 'New session', permissionMode: plan ? 'plan' : 'default', background: true })
      const queued = outbox.enqueue(command)
      setPending(outbox.pending())
      if (queued.state === 'pending') await dispatch(queued.entry)
    } catch (cause) { report(cause) }
  }
  async function stop() {
    if (!backend || !session) return
    try { await backend.messages.interrupt({ commandId: CommandId.make(crypto.randomUUID()), sessionId: session.id, ...(timeline.projection?.currentTurn ? { expectedTurnId: timeline.projection.currentTurn.turnId } : {}) }) } catch (cause) { report(cause) }
  }
  const running = busy || timeline.projection?.status === 'running'
  const visibleSessions = sessions.filter(row => !row.archivedAt && row.title.toLowerCase().includes(filter.toLowerCase()))
  function runShortcut(command: string) {
    if (command === 'new-chat') { setSession(null); setInput(emptyComposerInput()) }
    else if (command === 'open-project') setPanel('workspace')
    else if (command === 'settings') setPanel('settings')
    else if (command === 'open-chat-switcher') setPanel('commands')
    else if (command === 'toggle-left-sidebar') setPreferences(value => ({ ...value, sidebar: !value.sidebar }))
    else if (['toggle-right-sidebar', 'toggle-terminal', 'search-files'].includes(command)) setWorkbench(value => !value)
    else if (command === 'focus-composer' && composerRef.current) renderer?.focusElement?.(composerRef.current.id)
    else if (command === 'composer.submit' || command === 'composer.forceSubmit') void send()
    else if (command === 'close-tab') setSession(null)
    else if (command === 'next-chat' || command === 'prev-chat' || command === 'next-tab' || command === 'prev-tab') { const offset = command.startsWith('prev') ? -1 : 1; const index = sessions.findIndex(row => row.id === session?.id); setSession(sessions[(index + offset + sessions.length) % sessions.length] ?? null) }
    else if (command.startsWith('select-tab-')) setSession(sessions[Number(command.slice(-1)) - 1] ?? null)
    else if (command === 'select-last-tab') setSession(sessions.at(-1) ?? null)
  }
  const composer = <DevinComposerShell palette={p} mode={session ? 'thread' : 'home'} editor={<textarea ref={composerRef} testId="composer" value={draft} placeholder="Ask OpulentDevin to do something..." minRows={2} maxRows={8} onChange={event => setDraft(event.value ?? '')} onSubmit={send} style={{ color: p.text, fontSize: 14, lineHeight: 20, width: '100%' }} />} context={backend ? <ComposerControls backend={backend} session={session} folderId={folder?.id ?? null} input={input} onInput={setInput} onError={setError} palette={p} /> : undefined} controls={<Box style={{ width: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><Box style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}><Action label={provider} icon="bolt" testId="provider-picker" palette={p} onClick={() => setPanel(panel === 'providers' ? 'none' : 'providers')} /><Action label={(session ? timeline.projection?.permissionMode === 'plan' : plan) ? 'Plan' : 'Build'} palette={p} testId="plan-toggle" onClick={() => { if (session && backend) void backend.sessions.setPermissionMode({ commandId: CommandId.make(crypto.randomUUID()), sessionId: session.id, mode: timeline.projection?.permissionMode === 'plan' ? 'default' : 'plan' }).catch(report); else setPlan(!plan) }} /></Box><Box testId={running ? 'stop' : 'send'} onClick={running ? stop : send} style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: p.inverse, opacity: draft.trim() || input.attachments.length || running ? 1 : 0.25, cursor: 'pointer' }}><Icon name={running ? 'stop' : 'send'} size={18} color={p.inverseText} /></Box></Box>} />
  const commands = [
    { id: 'new', label: 'New session', execute: () => { setSession(null); setInput(emptyComposerInput()) } },
    { id: 'workspace', label: 'Open workspace', execute: () => setPanel('workspace') },
    { id: 'settings', label: 'Settings and providers', execute: () => setPanel('settings') },
    { id: 'voice', label: 'Voice input and audio transcription', execute: () => setPanel('voice') },
    { id: 'sharing', label: 'Local server and private sharing', execute: () => setPanel('sharing') },
    { id: 'queue', label: 'Queued messages', execute: () => setPanel('queue') },
    { id: 'tools', label: 'Tools, diagnostics, usage and integrations', execute: () => setPanel('tools') },
    { id: 'shortcuts', label: 'Keyboard shortcuts', execute: () => setPanel('keybindings') },
    { id: 'browser', label: 'Open native browser', execute: () => setPanel('browser') },
    { id: 'workbench', label: 'Toggle files, terminal and changes', execute: () => setWorkbench(value => !value) },
    { id: 'theme', label: 'Toggle light and dark theme', execute: () => setPreferences(value => ({ ...value, theme: value.theme === 'dark' ? 'light' : 'dark' })) },
    ...sessions.map(row => ({ id: row.id, label: row.title, detail: `${row.providerId} · ${row.status}`, execute: () => setSession(row) })),
  ]
  return <Box onKeyDown={event => { const command = matchNativeCommand(event, keybindings, { settingsOpen: panel === 'settings', composerFocus: renderer?.getFocusedElementId?.() === composerRef.current?.id }); if (command) runShortcut(command); if ((event.modifiers?.cmd || event.modifiers?.ctrl) && event.key?.toLowerCase() === 'k') setPanel('commands'); if (event.key === 'escape') setPanel('none') }} style={{ height: '100%', width: '100%', flexDirection: 'row', backgroundColor: p.page, fontFamily: typography.family }}>
    {preferences.sidebar && <DevinSidebar palette={p} workspaceName="OpulentDevin" selectedSessionId={session?.id} onCollapse={() => setPreferences(v => ({ ...v, sidebar: false }))} actions={[
      { id: 'new-session', label: 'New session', icon: 'plus', onClick: () => { setSession(null); setInput(emptyComposerInput()); setPanel('none') } },
      { id: 'command-palette-toggle', label: 'Commands', icon: 'bolt', onClick: () => setPanel('commands') },
      { id: 'search-sessions', label: 'Search sessions', icon: 'search', onClick: () => setPanel(panel === 'search' ? 'none' : 'search') },
      { id: 'workspace-picker', label: folder?.name ?? 'Add a workspace', icon: 'folder', onClick: () => setPanel(panel === 'workspace' ? 'none' : 'workspace') },
    ]} sessions={visibleSessions.map(row => ({ id: row.id, title: row.title, detail: `${row.providerId} · ${row.status}`, onClick: () => setSession(row) }))} filter={panel === 'search' ? <input testId="session-search" value={filter} placeholder="Search sessions..." onChange={event => setFilter(event.value ?? '')} style={{ color: p.text, padding: 8, fontSize: 13 }} /> : null} footer={<><Action label="Local workspace" icon="settings" palette={p} testId="settings" onClick={() => setPanel('settings')} /><Action label={preferences.theme === 'dark' ? 'Light' : 'Dark'} palette={p} testId="theme-toggle" onClick={() => setPreferences(v => ({ ...v, theme: v.theme === 'dark' ? 'light' : 'dark' }))} /></>} />}
    <Box style={{ flexGrow: 1, minWidth: 0, height: '100%' }}>
      <Box style={{ height: 44, flexShrink: 0, flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 16, justifyContent: 'space-between', borderBottomWidth: 1, borderColor: p.borderSubtle }}>
        <Box style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>{!preferences.sidebar && <Action label="" icon="panel" testId="sidebar-expand" palette={p} onClick={() => setPreferences(v => ({ ...v, sidebar: true }))} />}<text style={{ color: p.secondary, fontSize: 13 }}>{folder?.name ?? 'Workspace'} /</text><text style={{ color: p.text, fontSize: 13 }}>{session?.title ?? 'New session'}</text></Box>
        <Box style={{ flexDirection: 'row', gap: 8 }}>{backend && <SessionManagement backend={backend} session={session} folderId={folder?.id ?? null} onSelect={setSession} onError={setError} palette={p} />}<Action label="Tools" icon="bolt" testId="tools-toggle" palette={p} onClick={() => setPanel('tools')} /><Action label="Browser" icon="globe" testId="browser-toggle" palette={p} onClick={() => setPanel(panel === 'browser' ? 'none' : 'browser')} /><Action label="Workspace" icon="terminal" testId="workbench-toggle" palette={p} active={workbench} onClick={() => setWorkbench(!workbench)} /></Box>
      </Box>
      <Box style={{ flexGrow: 1, minHeight: 0, flexDirection: 'row' }}>
        <Box style={{ flexGrow: 1, minWidth: 0, alignItems: 'center' }}>
          {panel === 'commands' && <CommandPalette commands={commands} palette={p} onClose={() => setPanel('none')} />}
          {panel === 'workspace' && backend && <WorkspacePanel backend={backend} folders={folders} onSelect={row => { setFolder(row); setPanel('none') }} onError={report} palette={p} />}
          {panel === 'voice' && backend ? <VoiceControls backend={backend} onError={report} onTranscript={text => { setDraft(draft ? `${draft}\n${text}` : text); setPanel('none') }} /> : panel === 'sharing' && localServer ? <LocalServerControls manager={localServer} onError={report} /> : panel === 'queue' && backend && session ? <QueuePanel backend={backend} session={session} input={input} onQueued={() => setInput(emptyComposerInput())} onError={report} palette={p} /> : panel === 'tools' && backend ? <AdvancedSurfaces notificationsEnabled={notificationsEnabled} onNotificationsChange={enabled => { saveCompletionNotifications(enabled); setNotificationsEnabled(enabled) }} backend={backend} session={session} projectId={folder?.id} providerId={provider} onError={report} onPreview={server => { if (!environmentId.startsWith('local:')) { setError('Remote previews require an authenticated environment tunnel; local loopback was not opened.'); return }; setPreviewUrl(`http://127.0.0.1:${server.port}`); setPanel('browser') }} onSkill={skill => { setInput(value => new ComposerInput({ ...value, skillRefs: [...value.skillRefs, { name: skill.name, scope: skill.scope, providerId: skill.providerId, args: '' }] })); setPanel('none') }} onLinearContext={context => { setInput(value => new ComposerInput({ ...value, fileRefs: [...value.fileRefs, ...context.files.map(file => ({ relPath: file.relPath, absPath: file.absPath, kind: 'file' as const }))], attachments: [...value.attachments, ...context.attachments] })); setPanel('none'); if (context.warnings.length) setError(context.warnings.map(value => value.message).join('\n')) }} /> : panel === 'keybindings' && backend ? <KeybindingSettings backend={backend} palette={p} onError={report} /> : panel === 'browser' ? <BrowserPane initialUrl={previewUrl} backend={backend ?? undefined} sessionId={session?.id} onError={setError} palette={p} /> : panel === 'settings' && backend ? <SettingsPanel backend={backend} onConnect={onConnect} onError={report} onClose={() => setPanel('none')} /> : <>
          {!session ? <DevinHome composer={composer} palette={p} title="What would you like to build?" /> : <Box testId="transcript" style={{ flexGrow: 1, minHeight: 0, width: '100%', overflow: 'scroll', alignItems: 'center', padding: 24 }}>
            <Box style={{ width: '100%', maxWidth: 740 }}>
              {!session && <Box style={{ paddingTop: 100, paddingBottom: 40, alignItems: 'center', gap: 16 }}><text style={{ color: p.text, fontSize: 28, fontWeight: 500 }}>What would you like to build?</text><text style={{ color: p.secondary, fontSize: 14 }}>Your workspace, tools and agents. A native desktop experience.</text></Box>}
              <Transcript backend={backend} session={session} timeline={timeline} palette={p} onError={report} />
            </Box>
          </Box>}
          {error && <Box testId="error-banner" style={{ width: '90%', maxWidth: 740, padding: 12, backgroundColor: p.dangerBg, borderRadius: 8, marginBottom: 12 }}><text style={{ color: p.danger, fontSize: 12 }}>{error}</text><Action label="Dismiss" palette={p} onClick={() => setError('')} /></Box>}
          {pending.map(entry => <Box key={entry.command.commandId} style={{ width: '90%', maxWidth: 740, padding: 12, gap: 6, backgroundColor: p.warningBg }}><text style={{ color: p.warning, fontSize: 12 }}>Unconfirmed {entry.command.kind}: retry uses the original saved identity.</text><Action label="Retry saved send" testId="retry-pending-send" palette={p} onClick={() => { void dispatch(entry) }} /></Box>)}
          {panel === 'providers' && <Box style={{ width: '90%', maxWidth: 740, backgroundColor: p.elevated, padding: 12, gap: 4, borderRadius: 12 }}>{providers.map(row => <Action key={row.providerId} label={`${row.displayName} · ${row.cliLoggedIn || row.hasApiKey ? 'Ready' : 'Not connected'}`} palette={p} active={row.providerId === provider} onClick={() => { if (!session) setProvider(row.providerId); setPanel('none') }} />)}{backend && <ModelPicker backend={backend} providerId={provider} value={model} onChange={value => { if (session && backend) void backend.sessions.setModel({ sessionId: session.id, model: value }).then(() => setModel(value)).catch(report); else setModel(value) }} onError={setError} palette={p} />}</Box>}
          {session ? composer : null}
          <Action label={`Connection: ${connectionStatus}`} testId="reconnect" palette={p} onClick={reconnect} /><text style={{ color: p.tertiary, fontSize: 11, marginBottom: 12 }}>{backend ? 'Connected to Zuse · Native GPUIX' : 'Connecting to local Zuse service...'}</text>
          </>}
        </Box>
        {workbench && <Box style={{ width: '60%', minWidth: 560, borderLeftWidth: 1, borderColor: p.border }}><Workbench backend={backend} folderId={folder?.id ?? null} sessionId={session?.id ?? null} onError={setError} palette={p} /></Box>}
      </Box>
    </Box>
  </Box>
}
