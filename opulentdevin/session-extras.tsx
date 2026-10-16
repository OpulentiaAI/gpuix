import { useEffect, useRef, useState } from 'react'
import type { Backend } from './backend'
import type { Session, ThreadGoal, ThreadGoalSetInput, ThreadGoalStatus } from './zuse-runtime/packages/contracts/src/session'
import type { ExternalThread, ContinueExternalThreadInput, ContinueExternalThreadResult } from './zuse-runtime/packages/contracts/src/external-thread'
import type { PokemonPokedexEntry } from './zuse-runtime/packages/contracts/src/pokemon'
import { SettingsAction as Action, SettingsCard as Card, SettingsField as Field, SettingsNote as Note, SettingsChoices as Choices, ConfirmAction, useSettingsAction } from './settings-controls'

export type SessionExtrasProps = {
  backend: Backend
  session?: Session | null
  onError: (error: unknown) => void
  onContinue?: (result: ContinueExternalThreadResult) => void
}
export function goalInput(objective: string, budget: string): ThreadGoalSetInput {
  if (!objective.trim()) throw new Error('A goal objective is required.')
  if (budget.trim() && !/^[1-9]\d*$/.test(budget.trim())) throw new Error('Token budget must be a positive whole number, or blank for no limit.')
  const tokenBudget = budget.trim() ? Number(budget) : null
  if (tokenBudget !== null && !Number.isSafeInteger(tokenBudget)) throw new Error('Token budget is too large.')
  return { objective: objective.trim(), tokenBudget }
}
export function externalThreadInput(thread: ExternalThread): ContinueExternalThreadInput {
  if (!thread.available) throw new Error('This provider thread is unavailable.')
  if (!thread.cursor || !thread.projectPath) throw new Error('This provider thread has no resumable source identity.')
  return { providerId: thread.providerId, cursor: thread.cursor, projectPath: thread.projectPath, title: thread.title, sourcePath: thread.sourcePath }
}
export function filterPokedex(entries: readonly PokemonPokedexEntry[], query: string, unlockedOnly: boolean) {
  const needle = query.trim().toLowerCase()
  return entries.filter(entry => (!unlockedOnly || entry.unlocked) && (!needle || `${entry.number} ${entry.name} ${entry.slug} ${entry.rarity}`.toLowerCase().includes(needle)))
}
export function SessionExtras(props: SessionExtrasProps) {
  const [tab, setTab] = useState<'Goals' | 'External threads' | 'Pokédex'>('Goals')
  return <div testId="session-extras" style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, width: '100%', minHeight: 0, overflowY: 'scroll' }}><Choices label="Session services" value={tab} values={['Goals', 'External threads', 'Pokédex']} onChange={setTab} />{tab === 'Goals' ? <Goals key={props.session?.id ?? 'no-session'} {...props} /> : tab === 'External threads' ? <ExternalThreads {...props} /> : <Pokedex {...props} />}</div>
}
function Goals({ backend, session, onError }: SessionExtrasProps) {
  const [goal, setGoal] = useState<ThreadGoal | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [objective, setObjective] = useState('')
  const [budget, setBudget] = useState('')
  const [live, setLive] = useState(false)
  const { busy, message, run } = useSettingsAction(onError)
  useEffect(() => {
    if (!session) return
    let active = true
    const subscription = backend.subscribe(backend.client['session.goal.stream']({ sessionId: session.id }), event => {
      if (active && event.sessionId === session.id) { setGoal(event.goal); setLoaded(true); setLive(true) }
    }, () => { if (active) { setLive(false); onError(new Error('Goal updates are unavailable for this provider or connection. Use Refresh to inspect support.')) } })
    return () => { active = false; subscription.cancel() }
  }, [backend, session?.id])
  if (!session) return <Card title="Session goal"><Note>Select a session to inspect its provider-supported goal.</Note></Card>
  const refresh = () => void run('Read goal', async () => { const current = await backend.run(backend.client['session.goal.get']({ sessionId: session.id })); setGoal(current); setLoaded(true); setObjective(current?.objective ?? ''); setBudget(current?.tokenBudget === null || current?.tokenBudget === undefined ? '' : String(current.tokenBudget)) })
  const status = (value: ThreadGoalStatus) => void run(`Set goal ${value}`, async () => setGoal(await backend.run(backend.client['session.goal.set']({ sessionId: session.id, goal: { status: value } }))))
  return <Card title="Session goal"><Note>Goal support is provider-specific. Setting or activating a goal may start provider work; no action runs automatically.</Note><Action label="Refresh goal and load editor" disabled={busy} onClick={refresh} /><Note>{message}</Note><Note>{live ? 'Live provider goal updates' : 'Goal stream unavailable or connecting'}</Note>{loaded && (goal ? <><Note>{goal.objective}</Note><Note>Status: {goal.status} · {goal.tokensUsed.toLocaleString()} tokens used / {goal.tokenBudget === null ? 'no budget limit' : goal.tokenBudget.toLocaleString()} · {goal.timeUsedSeconds}s elapsed</Note><Note>Updated {new Date(goal.updatedAt).toLocaleString()}</Note></> : <Note>No goal is set.</Note>)}<Field label="Goal objective" value={objective} onChange={setObjective} disabled={busy} /><Field label="Token budget (blank removes limit)" value={budget} onChange={setBudget} disabled={busy} /><ConfirmAction label="Save goal" detail="Save this goal and token budget to the selected provider session? This can start provider execution." disabled={busy || !objective.trim()} action={() => void run('Save goal', async () => setGoal(await backend.run(backend.client['session.goal.set']({ sessionId: session.id, goal: goalInput(objective, budget) }))))} />{goal && <><div style={{ display: 'flex', flexDirection: 'row', gap: 8 }}><ConfirmAction label="Activate goal" detail="Activate the goal and allow the provider to continue its work?" disabled={busy} action={() => status('active')} /><Action label="Pause goal" disabled={busy} onClick={() => status('paused')} /><ConfirmAction label="Mark goal complete" detail="Mark this goal complete?" disabled={busy} action={() => status('complete')} /></div><ConfirmAction label="Clear goal" detail="Remove the selected session goal?" disabled={busy} action={() => void run('Clear goal', async () => { await backend.run(backend.client['session.goal.clear']({ sessionId: session.id })); setGoal(null); setLoaded(true) })} /></>}</Card>
}
function ExternalThreads({ backend, onContinue, onError }: SessionExtrasProps) {
  const [threads, setThreads] = useState<readonly ExternalThread[]>([])
  const [query, setQuery] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [uncertain, setUncertain] = useState<ReadonlySet<string>>(new Set())
  const lock = useRef(false)
  const { busy, message, run } = useSettingsAction(onError)
  const filtered = threads.filter(thread => `${thread.title} ${thread.projectName} ${thread.providerId}`.toLowerCase().includes(query.toLowerCase()))
  return <Card title="Continue an external provider thread"><Note>Reads the connected environment’s provider history. Continuing imports the selected thread and may resume provider execution. No generated conversation data is used.</Note><Action label="Load recent external threads" disabled={busy} onClick={() => void run('Read external threads', async () => { setThreads(await backend.run(backend.client['externalThreads.list']({ limit: 100 }))); setLoaded(true) })} /><Field label="Filter provider, project or title" value={query} onChange={setQuery} /><Note>{message}</Note>{!onContinue && <Note warning>Parent session-navigation callback is not connected; continue actions are disabled.</Note>}{loaded && filtered.length === 0 && <Note>No matching external threads.</Note>}{filtered.map(thread => <Card key={`${thread.providerId}:${thread.id}`} title={thread.title || thread.id}><Note>{thread.providerId} · {thread.projectName} · {thread.updatedAt.toLocaleString()} · {thread.available ? 'Available' : 'Unavailable'}</Note><Note>{thread.preview}</Note><Note>Project: {thread.projectPath} · Resume strategy: {thread.resumeStrategy}</Note>{uncertain.has(thread.id) ? <Note warning>Continuation was submitted. If the response was lost, inspect the session list before retrying; this RPC has no command-id retry contract.</Note> : <ConfirmAction label="Import and continue thread" detail={`Import and continue this ${thread.providerId} thread in its source project? This may start agent work.`} disabled={busy || !thread.available || !onContinue} action={() => {
      if (lock.current || !onContinue) return
      lock.current = true
      setUncertain(old => new Set([...old, thread.id]))
      void run('Continue external thread', async () => { try { const result = await backend.run(backend.client['externalThreads.continue'](externalThreadInput(thread))); onContinue(result) } finally { lock.current = false } })
    }} />}</Card>)}</Card>
}
function Pokedex({ backend, onError }: SessionExtrasProps) {
  const [entries, setEntries] = useState<readonly PokemonPokedexEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const [query, setQuery] = useState('')
  const [unlockedOnly, setUnlockedOnly] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
  const { busy, message, run } = useSettingsAction(onError)
  const shown = filterPokedex(entries, query, unlockedOnly)
  const detail = entries.find(entry => entry.number === selected)
  return <Card title="Pokédex"><Action label="Load Pokédex" disabled={busy} onClick={() => void run('Read Pokédex', async () => { setEntries(await backend.run(backend.client['pokemon.pokedex']({}))); setLoaded(true) })} /><Note>{message}</Note><Field label="Find name, number or rarity" value={query} onChange={setQuery} /><Action label={unlockedOnly ? 'Show all entries' : 'Show unlocked entries'} selected={unlockedOnly} onClick={() => setUnlockedOnly(value => !value)} />{loaded && <Note>{entries.filter(entry => entry.unlocked).length} unlocked / {entries.length} total · {shown.length} matching</Note>}<div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{shown.map(entry => <Action key={entry.number} label={`#${entry.number} ${entry.name} · ${entry.unlocked ? entry.rarity : 'locked'}`} selected={selected === entry.number} onClick={() => setSelected(entry.number)} />)}</div>{detail && <Card title={`#${detail.number} ${detail.name}`}><Note>Generation {detail.generation} · {detail.rarity} · {detail.points} points · {detail.unlocked ? 'Unlocked' : 'Locked'}</Note>{detail.unlockedAt && <Note>Unlocked {detail.unlockedAt.toLocaleString()}</Note>}{detail.worktreeId && <Note>Associated worktree: {detail.worktreeId}</Note>}<Note>Variants: {detail.variants.map(variant => variant.label).join(', ') || 'None'}</Note><Note>Evolution: {detail.evolutionLine.map(step => `${step.name} (${step.unlocked ? 'unlocked' : 'locked'})`).join(' → ') || 'None'}</Note><ConfirmAction label="Cache artwork for this entry" detail="Download this entry’s artwork through the existing backend cache?" disabled={busy} action={() => void run('Cache Pokédex artwork', async () => { const updated = await backend.run(backend.client['pokemon.ensureSpriteCached']({ number: detail.number })); setEntries(old => old.map(entry => entry.number === updated.number ? updated : entry)) })} /><Note>Artwork references are retained by the backend. Native image loading is intentionally not pointed at an unverified custom-protocol or remote URL.</Note></Card>}</Card>
}
