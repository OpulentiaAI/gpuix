import React, { useEffect, useRef, useState } from 'react'
import { randomUUID } from 'node:crypto'
import type { Effect } from 'effect'
import type { Backend } from './backend'
import { emptySessionTimelineState, reduceSessionTimelineFrame } from './backend'
import { CommandId, type AgentTurnId } from './zuse-runtime/packages/contracts/src/ids'
import { ComposerInput } from './zuse-runtime/packages/contracts/src/composer'
import type { Session, QueueState, QueuedMessage } from './zuse-runtime/packages/contracts/src/session'
import { palettes, type Palette } from './theme'

type Pending = { label: string; execute: () => Promise<unknown>; acknowledged: boolean; enqueued: boolean; composer?: string; running?: boolean }
const pendingByBackend = new WeakMap<Backend, Map<string, Pending>>()
export type QueuePanelProps = { backend: Backend; session: Session; input: ComposerInput; onQueued: () => void; onError: (message: string) => void; palette?: Palette }

export function QueuePanel({ backend, session, input, onQueued, onError, palette = palettes.dark }: QueuePanelProps) {
  const [snapshot, setSnapshot] = useState<{ backend: Backend; sessionId: string; queue: QueueState } | null>(null)
  const [turn, setTurn] = useState<AgentTurnId | null>(null)
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState<Pending | null>(null)
  const [edit, setEdit] = useState<{ item: QueuedMessage; text: string } | null>(null)
  const current = useRef({ backend, sessionId: session.id })
  const running = useRef(false)
  const request = useRef(0)
  current.current = { backend, sessionId: session.id }
  const queue = snapshot?.backend === backend && snapshot.sessionId === session.id ? snapshot.queue : null
  const alive = useRef(true)
  const latestInput = useRef(input)
  latestInput.current = input
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const matching = () => alive.current && current.current.backend === backend && current.current.sessionId === session.id
  const style = { padding: 6, borderRadius: 5, backgroundColor: palette.elevated, color: palette.text, cursor: 'pointer' as const, fontSize: 12 }
  const fail = (error: unknown) => { if (matching()) onError(error instanceof Error ? error.message : 'Queue operation failed.') }
  async function refresh() {
    const id = ++request.current
    const state = await backend.run(backend.client['messages.queue.list']({ sessionId: session.id }))
    if (matching() && request.current === id) setSnapshot({ backend, sessionId: session.id, queue: state })
  }
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    setSnapshot(null); setEdit(null); setBusy(false); setTurn(null)
    let timeline = emptySessionTimelineState()
    setRetry(pendingByBackend.get(backend)?.get(session.id) ?? null)
    void refresh().catch(fail)
    const subscription = backend.subscribe(backend.client['session.events']({ sessionId: session.id }), frame => {
      timeline = reduceSessionTimelineFrame(timeline, frame)
      if (active && matching()) setTurn(timeline.projection?.currentTurn?.turnId ?? null)
      clearTimeout(timer)
      timer = setTimeout(() => { if (active) void refresh().catch(fail) }, 100)
    }, fail)
    return () => { active = false; request.current++; clearTimeout(timer); subscription.cancel() }
  }, [backend, session.id])
  function pendingMap() { let map = pendingByBackend.get(backend); if (!map) { map = new Map(); pendingByBackend.set(backend, map) } return map }
  async function execute(action: Pending) {
    if (running.current || action.running) return
    action.running = true
    running.current = true; setBusy(true); setRetry(action)
    pendingMap().set(session.id, action)
    try {
      if (!action.acknowledged) {
        await action.execute(); action.acknowledged = true
        if (matching() && action.enqueued && action.composer === JSON.stringify(latestInput.current)) onQueued()
      }
      await refresh()
      pendingMap().delete(session.id)
      if (matching()) { setRetry(null); setEdit(null) }
    } catch (error) { fail(error) }
    finally { action.running = false; running.current = false; if (matching()) setBusy(false) }
  }
  function mutate(label: string, operation: (commandId: CommandId) => Effect.Effect<unknown, unknown>, enqueued = false) {
    if (busy || retry || running.current || pendingMap().has(session.id)) return
    const commandId = CommandId.make(randomUUID())
    const effect = operation(commandId)
    void execute({ label, execute: () => backend.run(effect), acknowledged: false, enqueued, composer: enqueued ? JSON.stringify(input) : undefined })
  }
  function move(item: QueuedMessage, offset: number) {
    if (!queue) return
    const ids = queue.items.map(row => row.id)
    const source = ids.indexOf(item.id); const destination = source + offset
    if (source < 0 || destination < 0 || destination >= ids.length) return
    ;[ids[source], ids[destination]] = [ids[destination], ids[source]]
    mutate('Reorder queue', commandId => backend.client['messages.queue.reorder']({ commandId, sessionId: session.id, queueIds: ids }))
  }
  const populated = input.text.trim() || input.attachments.length || input.fileRefs.length || input.skillRefs.length || input.annotations.length
  return <div testId="queue-panel" style={{ gap: 6, padding: 8, borderWidth: 1, borderColor: palette.border, borderRadius: 7, maxHeight: 320, overflow: 'scroll' }}>
    <div style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><text style={{ fontWeight: 600 }}>Queue {queue ? `(${queue.items.length})` : ''}</text><text style={{ color: palette.muted, fontSize: 12 }}>{queue ? queue.paused ? 'Paused on server' : 'Ready on server' : 'Loading server state'}</text><div style={style} onClick={() => void refresh().catch(fail)}>Refresh</div></div>
    {retry && <div style={{ gap: 5 }}><text style={{ color: palette.warning, fontSize: 12 }}>{retry.acknowledged ? `${retry.label} acknowledged; refresh failed. Retry only reads server state.` : `${retry.label} has no acknowledgement. Retry reuses the same command and payload.`}</text><div style={style} onClick={() => void execute(retry)}>{busy ? 'Working…' : 'Retry safely'}</div></div>}
    <div style={{ flexDirection: 'row', gap: 6 }}>
      <div testId="queue-add" style={style} onClick={() => { if (!populated) return; const captured = new ComposerInput({ ...input }); const queueId = randomUUID(); mutate('Enqueue message', commandId => backend.client['messages.queue.add']({ commandId, queueId, sessionId: session.id, input: captured, flush: false }), true) }}>Queue current composer</div>
      <div style={style} onClick={() => mutate('Flush queue', commandId => backend.client['messages.queue.flush']({ commandId, sessionId: session.id }))}>Run queued messages</div>
      {turn && !queue?.paused && <div style={style} onClick={() => mutate('Stop turn and pause queue', commandId => backend.client['messages.interrupt']({ commandId, sessionId: session.id, expectedTurnId: turn }))}>Stop turn and pause queue</div>}
      {queue?.paused && <div style={style} onClick={() => mutate('Resume queue', commandId => backend.client['messages.queue.resume']({ commandId, sessionId: session.id }))}>Resume queue</div>}
    </div>
    <text style={{ color: palette.muted, fontSize: 11 }}>Pause also stops the active turn. When idle, this runtime has no independent pause command. Queueing here does not auto-flush.</text>
    {queue?.items.map((item, index) => <div key={item.id} style={{ padding: 8, backgroundColor: palette.wash, borderRadius: 5, gap: 5 }}>
      <text style={{ fontSize: 12 }}>{index + 1}. {item.ready ? 'Ready' : 'Held'}{item.input.asGoal ? ' · Goal' : ''}</text>
      {edit?.item.id === item.id ? <textarea testId="queue-edit-text" value={edit.text} style={{ height: 70, backgroundColor: palette.elevated, color: palette.text, padding: 6 }} onChange={event => setEdit({ ...edit, text: event.value ?? '' })} /> : <text>{item.input.text || '(Rich input without text)'}</text>}
      <text style={{ color: palette.muted, fontSize: 11 }}>{item.input.attachments.map(file => file.originalName).join(', ')}{item.input.fileRefs.length ? ` · ${item.input.fileRefs.length} files` : ''}{item.input.skillRefs.length ? ` · ${item.input.skillRefs.length} skills` : ''}{item.input.annotations.length ? ` · ${item.input.annotations.length} annotations` : ''}</text>
      <div style={{ flexDirection: 'row', gap: 5 }}>
        {edit?.item.id === item.id ? <><div style={style} onClick={() => { if (item.updatedAt.getTime() !== edit.item.updatedAt.getTime()) { onError('This queued message changed on the server. Cancel and reopen the editor before saving.'); return }; const original = edit.item; const revised = new ComposerInput({ ...original.input, text: edit.text }); mutate('Update queue item', commandId => backend.client['messages.queue.update']({ commandId, sessionId: session.id, queueId: item.id, input: revised })) }}>Save text; retain rich input</div><div style={style} onClick={() => setEdit(null)}>Cancel</div></> : <div style={style} onClick={() => { if (!busy && !retry) setEdit({ item, text: item.input.text }) }}>Edit</div>}
        <div style={style} onClick={() => move(item, -1)}>Up</div><div style={style} onClick={() => move(item, 1)}>Down</div>
        <div style={style} onClick={() => mutate('Remove queued message', commandId => backend.client['messages.queue.delete']({ commandId, sessionId: session.id, queueId: item.id }))}>Remove</div>
        <div style={style} onClick={() => mutate('Run queued item next', commandId => backend.client['messages.queue.runNext']({ commandId, sessionId: session.id, queueId: item.id }))}>Run next</div>
      </div>
    </div>)}
    {queue?.items.length === 0 && <text style={{ color: palette.muted }}>No queued messages.</text>}
  </div>
}
