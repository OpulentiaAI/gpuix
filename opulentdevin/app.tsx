import { useEffect, useRef, useState } from 'react'
import type { JSX } from '@gpuix/react/jsx-runtime'
import type { Backend, BackendOptions } from './backend'
import { useBackendConnection, useTimeline, subscribeLive } from './connection'
import { emptySessionTimelineState, reduceSessionTimelineFrame } from './zuse-runtime/packages/client-runtime/src/session-timeline.ts'
import { CommandId, EnvironmentId } from './zuse-runtime/packages/contracts/src/ids.ts'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Outbox, prepareMessage, prepareChat, hasComposerContent, type PendingCommand } from './outbox'
import type { ProviderId } from './zuse-runtime/packages/contracts/src/agent.ts'
import type { Message, Session } from './zuse-runtime/packages/contracts/src/session.ts'
import { Icon, type IconName } from './icons'
import { palettes, metrics, typography, type Palette } from './theme'
import { loadPreferences, savePreferences, dataDirectory } from './preferences'
import { ComposerControls, ModelPicker, useProviderModel, emptyComposerInput, ComposerInput } from './composer-controls'
import { SessionManagement } from './session-management'
import { WorkspacePanel } from './workspaces'
import { Workbench, type WorkbenchPanel } from './workbench'
import { TranscriptViewport } from './transcript-viewport'
import { useGpuix, type PublicInstance } from '@gpuix/react'
import type { KeybindingRule } from './zuse-runtime/packages/contracts/src/keybindings'
import { resolveNativeKey, dispatchNativeCommand, nativeFocusCommand, createNativeEditorHandshake, type NativeCommandAdapters } from './native-command-runtime'
import { useChatSidebar } from './sidebar-model'
import { useCompletionNotifications, loadCompletionNotifications, saveCompletionNotifications } from './completion-notifications'
import { AdvancedSurfaces } from './advanced-surfaces'
import type { LocalServerManager } from './local-server'
import { LocalServerControls } from './local-server-controls'
import { VoiceControls } from './voice-controls'
import { ShellControls } from './shell'
import { useComposerDraft, draftMatchesCommand } from './drafts'
import { SessionExtras } from './session-extras'
import { QueuePanel } from './queue'
import { DevinHome, DevinComposerShell, DevinSendControl } from './devin-home'
import { DevinSidebar } from './devin-sidebar'
import { PaletteProvider, isActivationKey } from './theme-context'
import { KeybindingSettings } from './keybindings'
import { CommandPalette } from './commands'
import { BrowserPane } from './browser'
import { SettingsPanel } from './settings'
import { NativeCloseGuard } from './native-close'

function Box({ style, ...props }: JSX.IntrinsicElements['div']) {
  return <div {...props} style={{ display: 'flex', flexDirection: 'column', ...style }} />
}

type Folder = Awaited<ReturnType<Backend['workspaces']['list']>>[number]
type Provider = Awaited<ReturnType<Backend['providers']['list']>>[number]

function Action({ label, icon, onClick, active, palette: p, testId }: { label: string; icon?: IconName; onClick: () => void; active?: boolean; palette: Palette; testId?: string }) {
  return <Box testId={testId} role="button" aria-label={label || 'Expand sidebar'} tabIndex={0} onClick={onClick} onKeyDown={event => { if (!event.defaultPrevented && isActivationKey(event.key) && !event.modifiers?.ctrl && !event.modifiers?.alt && !event.modifiers?.cmd) { event.preventDefault(); event.stopPropagation(); onClick() } }} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 7, borderRadius: 6, cursor: 'pointer', backgroundColor: active ? p.selected : undefined, hover: { backgroundColor: p.hover }, focusVisible: { outlineWidth: 2, outlineColor: p.accent, outlineOffset: -2 } }}>
    {icon && <Icon name={icon} size={16} color={p.secondary} />}<text style={{ color: p.text, fontSize: 13 }}>{label}</text>
  </Box>
}


export function ConnectedApp({ backend: initialBackend, connectionError, connectionOptions, onCloseCleanup }: { backend: Backend | null; connectionError?: string; connectionOptions: BackendOptions; onCloseCleanup?: () => Promise<void> }) {
  const [error, setError] = useState(connectionError)
  const connection = useBackendConnection(initialBackend, setError, connectionOptions)
  const [remote, setRemote] = useState<{ backend: Backend; environmentId: string } | null>(null)
  const [remoteFailed, setRemoteFailed] = useState(false)
  useEffect(() => { setRemoteFailed(false); return () => { void remote?.backend.dispose() } }, [remote])
  const environmentId = remote ? EnvironmentId.make(remote.environmentId) : connection.environmentId
  const closeBackends = [connection.backend, remote?.backend].filter((value): value is Backend => Boolean(value))
  const closeCleanup = async () => { await remote?.backend.dispose(); await connection.backend?.dispose(); await onCloseCleanup?.() }
  const content = !remote && !connection.identityVerified ? <Box style={{ padding: 24, gap: 12 }}><text>Verifying environment identity...</text><text>{error ?? connection.status}</text><Box onClick={connection.reconnect}><text>Reconnect</text></Box></Box>
  : <App onCloseCleanup={closeCleanup} quitBackends={closeBackends} key={environmentId} backend={remoteFailed ? null : remote?.backend ?? connection.backend} connectionError={error} environmentId={environmentId} connectionStatus={remoteFailed ? 'interrupted' : remote ? 'remote' : connection.status} reconnect={remote ? () => { setRemote(null) } : connection.reconnect} reportFailure={remote ? () => { setRemoteFailed(true); setError('Remote connection interrupted. Return to Host setup to reconnect.') } : connection.reportFailure} onConnect={(backend, identity) => { setRemote({ backend, environmentId: identity }) }} />
  return <Box style={{ position: 'relative', width: '100%', height: '100%' }}>{content}<NativeCloseGuard backends={closeBackends} onCloseCleanup={closeCleanup} onError={cause => setError(cause instanceof Error ? cause.message : String(cause))} /></Box>
}

export function App({ backend, connectionError, environmentId, connectionStatus, reconnect, reportFailure, onConnect, localServer, quitBackends, onCloseCleanup }: { backend: Backend | null; connectionError?: string; environmentId: EnvironmentId; connectionStatus: string; reconnect: () => void; reportFailure: (error: unknown) => void; onConnect: (backend: Backend, environmentId: string) => void; localServer?: LocalServerManager; quitBackends?: readonly Backend[]; onCloseCleanup?: () => Promise<void> }) {
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
  const [session, updateSession] = useState<Session | null>(null)
  const selectionEpoch = useRef(0)
  const setSession = (next: Session | null) => { selectionEpoch.current++; updateSession(next) }
  const liveBackend = useRef(backend); liveBackend.current = backend
  const liveFolder = useRef(folder?.id); liveFolder.current = folder?.id
  const [providers, setProviders] = useState<readonly Provider[]>([])
  const [provider, setProvider] = useState<ProviderId>('claude')
  const [model, setModel] = useState('')
  const [outbox] = useState(() => new Outbox(join(dataDirectory, `outbox-${createHash('sha256').update(environmentId).digest('hex').slice(0, 24)}.json`), environmentId))
  const [pending, setPending] = useState<readonly PendingCommand[]>(() => outbox.pending())
  const sending = useRef(false)
  const [error, setError] = useState(connectionError ?? '')
  const composerDraft = useComposerDraft({ environmentId, workspaceId: folder?.id ?? null, sessionId: session?.id ?? null }, setError)
  const { input, setInput } = composerDraft
  const latestInput = useRef(input)
  latestInput.current = input
  const draft = input.text
  const setDraft = (text: string) => setInput(value => new ComposerInput({ ...value, text }))
  const [filter, setFilter] = useState('')
  const [panel, setPanel] = useState<'none' | 'workspace' | 'providers' | 'settings' | 'search' | 'browser' | 'commands' | 'keybindings' | 'tools' | 'queue' | 'sharing' | 'voice' | 'session-services' | 'shell'>('none')
  const [workbench, setWorkbench] = useState(false)
  const [workbenchPanel, setWorkbenchPanel] = useState<WorkbenchPanel>('Files')
  const [editorCommands] = useState(createNativeEditorHandshake)
  const [previewUrl, setPreviewUrl] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (connectionError) setError(connectionError) }, [connectionError])
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
    const selectedAtRequest = selectionEpoch.current
    const selectedFolder = folder.id
    setPreferences(value => ({ ...value, workspaceId: folder.id }))
    updateSession(value => value?.projectId === folder.id ? value : null)
    backend.sessions.list({ projectId: folder.id }).then(rows => { if (current !== generation.current) return; setSessions(rows); if (selectionEpoch.current === selectedAtRequest && liveFolder.current === selectedFolder) updateSession(value => value && rows.some(row => row.id === value.id) ? value : rows.find(row => row.id === preferences.sessionId) ?? null) }).catch(report)
    const subscription = subscribeLive(backend, backend.sessions.changes({ projectId: folder.id }), change => {
      if (current !== generation.current) return
      if (change._tag === 'snapshot') setSessions(change.sessions)
      else if (change._tag === 'remove') setSessions(rows => rows.filter(row => row.id !== change.sessionId))
      else setSessions(rows => [change.session, ...rows.filter(row => row.id !== change.session.id)])
    }, report, reportFailure)
    return () => { generation.current++; subscription.cancel() }
  }, [backend, folder?.id])
  useEffect(() => {
    if (!session) return
    setPreferences(value => ({ ...value, sessionId: session.id }))
    setProvider(session.providerId); setModel(session.model)
  }, [session?.id])
  async function dispatch(entry: PendingCommand) {
    if (!backend || sending.current) return
    sending.current = true; setBusy(true); setError('')
    const submittedInput = latestInput.current
    const submittedDraft = composerDraft.snapshot()
    const selectedAtSend = selectionEpoch.current
    const folderAtSend = folder?.id
    const backendAtSend = backend
    try {
      if (entry.command.kind === 'messages.send') await backend.messages.send(entry.command.payload)
      else { const created = await backend.chats.create(entry.command.payload); if (entry.command.payload.projectId === folderAtSend && created.initialSession.projectId === folderAtSend && selectionEpoch.current === selectedAtSend && liveFolder.current === folderAtSend && liveBackend.current === backendAtSend) setSession(created.initialSession) }
      outbox.ack(entry.command.commandId, entry.fingerprint)
      setPending(outbox.pending())
      if (draftMatchesCommand(submittedDraft, entry.command) && latestInput.current === submittedInput && liveFolder.current === folderAtSend && liveBackend.current === backendAtSend) composerDraft.clearExact(submittedDraft)
    } catch (cause) { report(cause) } finally { sending.current = false; setBusy(false) }
  }
  async function send() {
    if (!backend || busy || sending.current || !hasComposerContent(input)) return
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
  const sidebar = useChatSidebar({ backend, folderId: folder?.id ?? null, query: filter, onError: report })
  const selectSidebarChat = async (chat: (typeof sidebar.chats)[number]) => { const epoch = ++selectionEpoch.current; const next = await sidebar.selectChat(chat); if (epoch === selectionEpoch.current && next) setSession(next) }
  const visibleSessions = sessions.filter(row => !row.archivedAt && row.title.toLowerCase().includes(filter.toLowerCase()))
  const tabs = sessions.filter(row => row.chatId === session?.chatId && !row.archivedAt)
  const handled = { status: 'handled' as const }
  const tabAt = (index: number) => { const next = tabs[index]; if (!next) return { status: 'unsupported' as const, reason: 'No session tab exists at this position.' }; setSession(next); return handled }
  const cyclePanel = (offset: number) => { const panels: WorkbenchPanel[] = ['Files', 'Terminal', 'Changes']; setWorkbench(true); setWorkbenchPanel(panels[(panels.indexOf(workbenchPanel) + offset + panels.length) % panels.length]); return handled }
  const adapters: NativeCommandAdapters = {
    'new-chat': () => { setSession(null); return handled },
    'open-project': () => { setPanel('workspace'); return handled },
    settings: () => { setPanel('settings'); return handled },
    'close-tab': () => { setSession(null); return handled },
    'toggle-left-sidebar': () => { setPreferences(value => ({ ...value, sidebar: !value.sidebar })); return handled },
    'toggle-right-sidebar': () => { setWorkbench(value => !value); return handled },
    'toggle-terminal': () => { setWorkbench(true); setWorkbenchPanel('Terminal'); return handled },
    'focus-composer': () => nativeFocusCommand(renderer ?? null, composerRef.current?.id ?? null),
    'next-tab': () => tabAt((tabs.findIndex(row => row.id === session?.id) + 1) % tabs.length),
    'prev-tab': () => tabAt((tabs.findIndex(row => row.id === session?.id) - 1 + tabs.length) % tabs.length),
    'select-tab-1': () => tabAt(0), 'select-tab-2': () => tabAt(1), 'select-tab-3': () => tabAt(2), 'select-tab-4': () => tabAt(3),
    'select-tab-5': () => tabAt(4), 'select-tab-6': () => tabAt(5), 'select-tab-7': () => tabAt(6), 'select-tab-8': () => tabAt(7),
    'select-last-tab': () => tabAt(tabs.length - 1),
    'new-tab': async () => { if (!backend || !session) return { status: 'unsupported', reason: 'Select a chat before creating a session tab.' }; setSession(await backend.sessions.create({ chatId: session.chatId, providerId: session.providerId, model: session.model })); return handled },
    'next-chat': async () => { const index = sidebar.chats.findIndex(row => row.id === session?.chatId); const next = sidebar.chats[(index + 1) % sidebar.chats.length]; if (next) await selectSidebarChat(next); return next ? handled : { status: 'unsupported', reason: 'No chat is available.' } },
    'prev-chat': async () => { const index = sidebar.chats.findIndex(row => row.id === session?.chatId); const next = sidebar.chats[(index - 1 + sidebar.chats.length) % sidebar.chats.length]; if (next) await selectSidebarChat(next); return next ? handled : { status: 'unsupported', reason: 'No chat is available.' } },
    'next-panel': () => cyclePanel(1), 'prev-panel': () => cyclePanel(-1),
    'open-chat-switcher': () => { setPanel('commands'); return handled },
    'search-files': () => { setWorkbench(true); setWorkbenchPanel('Files'); return handled },
    'composer.submit': async () => { await send(); return handled },
    'composer.forceSubmit': async () => { await send(); return handled },
    'composer.newline': () => ({ status: 'unsupported', reason: 'Use Shift+Enter in the native composer to preserve selection and undo.' }),
    'composer.togglePlanMode': async () => { if (session && backend) await backend.sessions.setPermissionMode({ commandId: CommandId.make(crypto.randomUUID()), sessionId: session.id, mode: timeline.projection?.permissionMode === 'plan' ? 'default' : 'plan' }); else setPlan(value => !value); return handled },
    'editor.save': () => editorCommands.dispatch('save'),
    'editor.annotate': () => editorCommands.dispatch('annotate'),
  }
  const runShortcut = (command: keyof NativeCommandAdapters) => { void dispatchNativeCommand(command, adapters).then(result => { if (result.status !== 'handled') setError(result.reason) }) }
  const composer = <DevinComposerShell palette={p} mode={session ? 'thread' : 'home'} editor={<textarea ref={composerRef} testId="composer" value={draft} placeholder="Ask OpulentDevin to do something..." minRows={2} maxRows={8} onChange={event => setDraft(event.value ?? '')} onSubmit={send} style={{ color: p.text, fontSize: 14, lineHeight: 20, width: '100%' }} />} context={backend ? <ComposerControls backend={backend} session={session} folderId={folder?.id ?? null} input={input} onInput={setInput} onError={setError} palette={p} /> : undefined} controls={<Box style={{ width: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><Box style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}><Action label={provider} icon="bolt" testId="provider-picker" palette={p} onClick={() => setPanel(panel === 'providers' ? 'none' : 'providers')} /><Action label={(session ? timeline.projection?.permissionMode === 'plan' : plan) ? 'Plan' : 'Build'} palette={p} testId="plan-toggle" onClick={() => { if (session && backend) void backend.sessions.setPermissionMode({ commandId: CommandId.make(crypto.randomUUID()), sessionId: session.id, mode: timeline.projection?.permissionMode === 'plan' ? 'default' : 'plan' }).catch(report); else setPlan(!plan) }} /></Box><DevinSendControl palette={p} running={running} disabled={!backend || (!running && (!hasComposerContent(input) || busy))} onSend={() => { void send() }} onStop={() => { void stop() }} onOptions={session && backend ? () => setPanel('queue') : undefined} optionsOpen={panel === 'queue'} /></Box>} />
  const commands = [
    { id: 'new', label: 'New session', execute: () => { setSession(null) } },
    { id: 'workspace', label: 'Open workspace', execute: () => setPanel('workspace') },
    { id: 'settings', label: 'Settings and providers', execute: () => setPanel('settings') },
    { id: 'shell', label: 'Window, updates and safe quit', execute: () => setPanel('shell') },
    { id: 'session-services', label: 'Goals, external threads and Pokédex', execute: () => setPanel('session-services') },
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
  return <PaletteProvider palette={p}><Box onKeyDown={event => { const command = resolveNativeKey(event, keybindings, { settingsOpen: panel === 'settings', composerFocus: renderer?.getFocusedElementId?.() === composerRef.current?.id, editorFocus: workbench && workbenchPanel === 'Files' && renderer?.getFocusedElementId?.() !== composerRef.current?.id }); if (command && command !== 'composer.submit' && command !== 'composer.newline') runShortcut(command); if ((event.modifiers?.cmd || event.modifiers?.ctrl) && event.key?.toLowerCase() === 'k') setPanel('commands'); if (event.key === 'escape') setPanel('none') }} style={{ height: '100%', width: '100%', flexDirection: 'row', backgroundColor: p.page, fontFamily: typography.family }}>
    {preferences.sidebar && <DevinSidebar palette={p} workspaceName="OpulentDevin" selectedSessionId={session?.chatId} onCollapse={() => setPreferences(v => ({ ...v, sidebar: false }))} actions={[
      { id: 'new-session', label: 'New session', icon: 'plus', onClick: () => { setSession(null); setPanel('none') } },
      { id: 'command-palette-toggle', label: 'Commands', icon: 'bolt', onClick: () => setPanel('commands') },
      { id: 'search-sessions', label: 'Search sessions', icon: 'search', onClick: () => setPanel(panel === 'search' ? 'none' : 'search') },
      { id: 'workspace-picker', label: folder?.name ?? 'Add a workspace', icon: 'folder', onClick: () => setPanel(panel === 'workspace' ? 'none' : 'workspace') },
    ]} sessions={sidebar.chats.map(row => ({ id: row.id, title: row.title, detail: `${sessions.filter(value => value.chatId === row.id).length} sessions`, onClick: () => { void selectSidebarChat(row).catch(report) } }))} filter={panel === 'search' ? <input testId="session-search" value={filter} placeholder="Search sessions..." onChange={event => setFilter(event.value ?? '')} style={{ color: p.text, padding: 8, fontSize: 13 }} /> : null} footer={<><Action label="Local workspace" icon="settings" palette={p} testId="settings" onClick={() => setPanel('settings')} /><Action label={preferences.theme === 'dark' ? 'Light' : 'Dark'} palette={p} testId="theme-toggle" onClick={() => setPreferences(v => ({ ...v, theme: v.theme === 'dark' ? 'light' : 'dark' }))} /></>} />}
    <Box style={{ flexGrow: 1, minWidth: 0, height: '100%' }}>
      <Box style={{ height: 44, flexShrink: 0, flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 16, justifyContent: 'space-between', borderBottomWidth: 1, borderColor: p.borderSubtle }}>
        <Box style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>{!preferences.sidebar && <Action label="" icon="panel" testId="sidebar-expand" palette={p} onClick={() => setPreferences(v => ({ ...v, sidebar: true }))} />}<text style={{ color: p.secondary, fontSize: 13, whiteSpace: 'nowrap', flexShrink: 0 }}>{folder?.name ?? 'Workspace'} /</text><text style={{ color: p.text, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden' }}>{session?.title ?? 'New session'}</text></Box>
        <Box style={{ flexDirection: 'row', gap: 8 }}>{backend && <SessionManagement backend={backend} session={session} folderId={folder?.id ?? null} onSelect={setSession} onError={setError} palette={p} />}<Action label="Tools" icon="bolt" testId="tools-toggle" palette={p} onClick={() => setPanel('tools')} /><Action label="Browser" icon="globe" testId="browser-toggle" palette={p} onClick={() => setPanel(panel === 'browser' ? 'none' : 'browser')} /><Action label="Workspace" icon="terminal" testId="workbench-toggle" palette={p} active={workbench} onClick={() => setWorkbench(!workbench)} /></Box>
      </Box>
      <Box style={{ flexGrow: 1, minHeight: 0, flexDirection: 'row' }}>
        <Box style={{ flexGrow: 1, minWidth: 0, alignItems: 'center' }}>
          <BrowserPane active={panel === 'browser'} initialUrl={previewUrl} backend={backend ?? undefined} sessionId={session?.id} onError={setError} palette={p} />
          {panel === 'commands' && <CommandPalette commands={commands} palette={p} onClose={() => setPanel('none')} />}
          {panel === 'workspace' && backend && <WorkspacePanel backend={backend} folders={folders} onSelect={row => { setFolder(row); setPanel('none') }} onError={report} palette={p} />}
          {panel === 'shell' && backend ? <ShellControls backends={quitBackends ?? (backend ? [backend] : [])} onError={report} onQuit={async () => { if (onCloseCleanup) await onCloseCleanup(); else if (localServer) await localServer.stop(); else await backend.dispose(); process.kill(process.pid, 'SIGTERM') }} /> : panel === 'session-services' && backend ? <SessionExtras backend={backend} session={session} onError={report} onContinue={result => { setPreferences(value => ({ ...value, workspaceId: result.project.id, sessionId: result.session.id })); setFolder(result.project); setSession(result.session); setInput(emptyComposerInput()); setPanel('none') }} /> : panel === 'voice' && backend ? <VoiceControls backend={backend} onError={report} onTranscript={text => { setDraft(draft ? `${draft}\n${text}` : text); setPanel('none') }} /> : panel === 'sharing' && localServer ? <LocalServerControls manager={localServer} onError={report} /> : panel === 'queue' && backend && session ? <QueuePanel backend={backend} session={session} input={input} draft={composerDraft} onError={report} palette={p} /> : panel === 'tools' && backend ? <AdvancedSurfaces notificationsEnabled={notificationsEnabled} onNotificationsChange={enabled => { saveCompletionNotifications(enabled); setNotificationsEnabled(enabled) }} backend={backend} session={session} projectId={folder?.id} providerId={provider} onError={report} onPreview={server => { if (!environmentId.startsWith('local:')) { setError('Remote previews require an authenticated environment tunnel; local loopback was not opened.'); return }; setPreviewUrl(`http://127.0.0.1:${server.port}`); setPanel('browser') }} onSkill={skill => { setInput(value => new ComposerInput({ ...value, skillRefs: [...value.skillRefs, { name: skill.name, scope: skill.scope, providerId: skill.providerId, args: '' }] })); setPanel('none') }} onLinearContext={context => { setInput(value => new ComposerInput({ ...value, fileRefs: [...value.fileRefs, ...context.files.map(file => ({ relPath: file.relPath, absPath: file.absPath, kind: 'file' as const }))], attachments: [...value.attachments, ...context.attachments] })); setPanel('none'); if (context.warnings.length) setError(context.warnings.map(value => value.message).join('\n')) }} /> : panel === 'keybindings' && backend ? <KeybindingSettings backend={backend} palette={p} onError={report} /> : panel === 'browser' ? null : panel === 'settings' && backend ? <SettingsPanel backend={backend} onConnect={onConnect} onError={report} onClose={() => setPanel('none')} /> : <>
          {!session ? <DevinHome composer={composer} palette={p} title="What would you like to build?" /> : <TranscriptViewport environmentId={environmentId} backend={backend} session={session} timeline={timeline} palette={p} onError={report} loadOlder={timeline.loadOlder} loadingOlder={timeline.loadingOlder} hasOlder={timeline.hasOlder} />}
          {error && <Box testId="error-banner" style={{ width: '90%', maxWidth: 740, padding: 12, backgroundColor: p.dangerBg, borderRadius: 8, marginBottom: 12 }}><text style={{ color: p.danger, fontSize: 12 }}>{error}</text><Action label="Dismiss" palette={p} onClick={() => setError('')} /></Box>}
          {pending.map(entry => <Box key={entry.command.commandId} style={{ width: '90%', maxWidth: 740, padding: 12, gap: 6, backgroundColor: p.warningBg }}><text style={{ color: p.warning, fontSize: 12 }}>Unconfirmed {entry.command.kind}: retry uses the original saved identity.</text><Action label="Retry saved send" testId="retry-pending-send" palette={p} onClick={() => { void dispatch(entry) }} /></Box>)}
          {panel === 'providers' && <Box style={{ width: '90%', maxWidth: 740, backgroundColor: p.elevated, padding: 12, gap: 4, borderRadius: 12 }}>{providers.map(row => <Action key={row.providerId} label={`${row.displayName} · ${row.cliLoggedIn || row.hasApiKey ? 'Ready' : 'Not connected'}`} palette={p} active={row.providerId === provider} onClick={() => { if (!session) setProvider(row.providerId); setPanel('none') }} />)}{backend && <ModelPicker backend={backend} providerId={provider} value={model} onChange={value => { if (session && backend) void backend.sessions.setModel({ sessionId: session.id, model: value }).then(() => setModel(value)).catch(report); else setModel(value) }} onError={setError} palette={p} />}</Box>}
          {session ? composer : null}
          <Action label={`Connection: ${connectionStatus}`} testId="reconnect" palette={p} onClick={reconnect} /><text style={{ color: p.tertiary, fontSize: 11, marginBottom: 12 }}>{backend ? 'Connected to Zuse · Native GPUIX' : 'Connecting to local Zuse service...'}</text>
          </>}
        </Box>
        {workbench && <Box style={{ width: '60%', minWidth: 560, borderLeftWidth: 1, borderColor: p.border }}><Workbench onAnnotate={annotation => { setInput(value => new ComposerInput({ ...value, annotations: [...value.annotations, annotation] })); setPanel('none') }} environmentId={environmentId} requestedPanel={workbenchPanel} onPanelChange={setWorkbenchPanel} editorCommands={editorCommands} backend={backend} folderId={folder?.id ?? null} sessionId={session?.id ?? null} onError={setError} palette={p} /></Box>}
      </Box>
    </Box>
  </Box></PaletteProvider>
}
