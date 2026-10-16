import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { JSX } from '@gpuix/react/jsx-runtime'
import type { Backend, SessionTimelineState } from './backend'
import type { Message, Session, SessionInteraction, UserQuestionAnswer } from './zuse-runtime/packages/contracts/src/session.ts'
import type { PermissionRequest, PermissionDecision } from './zuse-runtime/packages/contracts/src/permission.ts'
import { CommandId, MessageId } from './zuse-runtime/packages/contracts/src/ids.ts'
import { findPendingPlanInteraction, type PendingPlanInteraction } from './zuse-runtime/packages/client-runtime/src/plan-interactions.ts'
import { PLAN_APPROVAL_PROMPT } from './zuse-runtime/packages/utils/src/proposed-plan.ts'
import { Icon } from './icons'
import { type Palette } from './theme'

type Props = { backend: Backend | null; session: Session | null; timeline: SessionTimelineState; palette: Palette; onError: (error: string) => void }
type Question = Extract<SessionInteraction, { _tag: 'Question' }>
const count = (value: number | null) => value === null ? 'Unknown' : value.toLocaleString()
const duration = (value: number) => `${(value / 1000).toFixed(1)}s`
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const serialise = (value: unknown) => JSON.stringify(value, null, 2) ?? String(value)

export function Box({ style, ...props }: JSX.IntrinsicElements['div']) {
  return <div {...props} style={{ display: 'flex', flexDirection: 'column', ...style }} />
}

function Button({ label, action, palette: p, disabled = false, selected = false, testId }: { label: string; action: () => void; palette: Palette; disabled?: boolean; selected?: boolean; testId?: string }) {
  return <Box testId={testId} tabIndex={disabled ? -1 : 0} onClick={() => { if (!disabled) action() }} onKeyDown={event => { if (!disabled && (event.key === 'Enter' || event.key === ' ')) action() }} style={{ padding: 8, borderRadius: 6, backgroundColor: selected ? p.accentSoft : p.hover, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1, hover: { backgroundColor: p.selected } }}><text style={{ color: selected ? p.accentText : p.text, fontSize: 13 }}>{label}</text></Box>
}
function Note({ children, palette: p, error = false }: { children: ReactNode; palette: Palette; error?: boolean }) {
  return <text style={{ color: error ? p.danger : p.secondary, fontSize: 12 }}>{children}</text>
}
function Prose({ text, palette: p }: { text: string; palette: Palette }) {
  return <markdown source={text} style={{ color: p.text, fontSize: 14, width: '100%' }} />
}
function Card({ title, children, palette: p, error = false }: { title: string; children: ReactNode; palette: Palette; error?: boolean }) {
  return <Box style={{ gap: 10, padding: 16, borderRadius: 16, backgroundColor: p.elevated, borderWidth: 1, borderColor: error ? p.danger : p.borderSubtle, width: '100%' }}><text style={{ color: error ? p.danger : p.text, fontSize: 14, fontWeight: 500 }}>{title}</text>{children}</Box>
}
function Disclosure({ title, children, palette: p, initialOpen = false }: { title: string; children: ReactNode; palette: Palette; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen)
  return <Box style={{ gap: 8, width: '100%' }}><Box tabIndex={0} onClick={() => setOpen(!open)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') setOpen(!open) }} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, padding: 4, cursor: 'pointer' }}><Icon name={open ? 'panel' : 'chevron'} size={14} color={p.secondary} /><text style={{ color: p.secondary, fontSize: 13 }}>{title}</text></Box>{open && children}</Box>
}
function Details({ value, palette: p }: { value: unknown; palette: Palette }) {
  return <Disclosure title="Details" palette={p}><code code={serialise(value)} language="json" style={{ width: '100%' }} /></Disclosure>
}
function Payload({ value, palette: p }: { value: unknown; palette: Palette }) {
  if (typeof value === 'string') return <Prose text={value} palette={p} />
  if (Array.isArray(value)) return <Box style={{ gap: 8 }}>{value.map((item, index) => <Payload key={index} value={item} palette={p} />)}</Box>
  if (!record(value)) return <Note palette={p}>{String(value)}</Note>
  const textKeys = ['text', 'message', 'summary', 'description', 'plan', 'stdout', 'stderr', 'output', 'command', 'path', 'file_path', 'url', 'status', 'title', 'name', 'content', 'diff', 'patch']
  const visible = Object.entries(value).filter(([key]) => textKeys.includes(key))
  if (visible.length === 0) return <code code={serialise(value)} language="json" style={{ width: '100%' }} />
  return <Box style={{ gap: 8 }}>{visible.map(([key, item]) => <Box key={key} style={{ gap: 4 }}><Note palette={p}>{key.replaceAll('_', ' ')}</Note>{typeof item === 'string' && ['command', 'stdout', 'stderr', 'diff', 'patch'].includes(key) ? <code code={item} language={key === 'command' ? 'bash' : ['diff', 'patch'].includes(key) ? 'diff' : 'text'} style={{ width: '100%' }} /> : <Payload value={item} palette={p} />}</Box>)}{Object.keys(value).some(key => !textKeys.includes(key)) && <Details value={value} palette={p} />}</Box>
}
type IntentStep = (backend: Backend) => Promise<unknown>
export class RetryIntent {
  state: 'idle' | 'sending' | 'failed' | 'sent' = 'idle'
  error: string | null = null
  private steps: readonly IntentStep[] | null = null
  private nextStep = 0
  private listeners = new Set<() => void>()
  get retained() { return this.steps !== null }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private notify() { for (const listener of this.listeners) listener() }
  async run(backend: Backend, prepare: () => readonly IntentStep[]) {
    if (this.state === 'sending' || this.state === 'sent') return
    this.steps ??= prepare()
    this.state = 'sending'; this.error = null; this.notify()
    try {
      while (this.nextStep < this.steps.length) {
        await this.steps[this.nextStep]!(backend)
        this.nextStep += 1
      }
      this.state = 'sent'
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : String(cause)
      this.state = 'failed'
      throw cause
    } finally { this.notify() }
  }
}
const interactionIntents = new Map<string, RetryIntent>()
const retainedPlans = new Map<string, PendingPlanInteraction>()
export function questionSteps(sessionId: Session['id'], itemId: Question['id'], answers: readonly UserQuestionAnswer[]): readonly IntentStep[] {
  const payload = { commandId: CommandId.make(crypto.randomUUID()), sessionId, itemId, answers: structuredClone(answers) }
  return [backend => backend.sessions.answerQuestion(payload)]
}
export function planSteps(plan: PendingPlanInteraction, sessionId: Session['id'], outcome: 'approved' | 'cancelled', feedback: string): readonly IntentStep[] {
  if (plan.kind === 'permission') {
    const payload = { requestId: plan.request.id, decision: { _tag: outcome === 'approved' ? 'AllowOnce' as const : 'Deny' as const } }
    return [backend => backend.permissions.decide(payload)]
  }
  if (plan.kind === 'native') {
    const payload = { commandId: CommandId.make(crypto.randomUUID()), sessionId, toolCallId: plan.native.toolCallId, outcome, feedback: feedback.trim() || undefined }
    return [backend => backend.sessions.respondToPlan(payload)]
  }
  const mode = { commandId: CommandId.make(crypto.randomUUID()), sessionId, mode: 'default' as const }
  const message = { commandId: CommandId.make(crypto.randomUUID()), clientMessageId: MessageId.make(crypto.randomUUID()), sessionId, text: PLAN_APPROVAL_PROMPT }
  return outcome === 'approved' ? [backend => backend.sessions.setPermissionMode(mode), backend => backend.messages.send(message)] : [backend => backend.sessions.setPermissionMode(mode)]
}
function useSubmission(key: string, backend: Backend, onError: Props['onError']) {
  let intent = interactionIntents.get(key)
  if (!intent) { intent = new RetryIntent(); interactionIntents.set(key, intent) }
  const stable = intent
  const [, update] = useState(0)
  useEffect(() => stable.subscribe(() => update(n => n + 1)), [stable])
  const submit = async (prepare: () => readonly IntentStep[]) => {
    try { await stable.run(backend, prepare) } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)) }
  }
  return { submit, state: stable.state, error: stable.error, retained: stable.retained, busy: stable.state === 'sending' || stable.state === 'sent' }
}
function MessageRow({ message, messages, palette: p }: { message: Message; messages: readonly Message[]; palette: Palette }) {
  const c = message.content
  let body: ReactNode
  switch (c._tag) {
    case 'user':
    case 'user_rich':
      body = <Card title={c.origin ? `Message from ${c.origin.providerId} agent` : c.goal ? 'Your goal' : 'You'} palette={p}><Prose text={c.text} palette={p} />{c.origin && <Note palette={p}>Source session: {c.origin.sessionId} · chat: {c.origin.chatId}</Note>}{c._tag === 'user_rich' && <><Box style={{ gap: 6 }}>{c.attachments.map(a => <Note key={a.id} palette={p}>Attachment: {a.originalName} · {a.mimeType} · {a.id}</Note>)}{c.fileRefs.map((f, i) => <Note key={i} palette={p}>{f.kind}: {f.relPath} · {f.absPath}</Note>)}{c.skillRefs.map((s, i) => <Note key={i} palette={p}>Skill: /{s.name} {s.args} · {s.scope} · {s.providerId}</Note>)}{c.annotations.map(a => <Disclosure key={a.id} title={'relPath' in a ? `${a.relPath}:${a.startLine}–${a.endLine}` : a._tag === 'browser' ? `Browser: ${a.pageTitle ?? a.pageUrl}` : a.label} palette={p}><Prose text={a.comment} palette={p} /><Details value={a} palette={p} /></Disclosure>)}</Box></>}</Card>
      break
    case 'assistant': body = <Box style={{ gap: 8 }}>{c.isPlan && <Note palette={p}>Proposed plan</Note>}<Prose text={c.text} palette={p} />{c.parentItemId && <Note palette={p}>Parent task: {c.parentItemId}</Note>}{c.checkpoint && <Details value={c.checkpoint} palette={p} />}</Box>; break
    case 'thinking': body = <Disclosure title={c.redacted ? 'Thinking · content withheld by provider' : 'Thinking'} palette={p}>{c.redacted ? <Note palette={p}>The provider did not disclose this reasoning.</Note> : <Prose text={c.text} palette={p} />}{c.parentItemId && <Note palette={p}>Parent task: {c.parentItemId}</Note>}{c.checkpoint && <Details value={c.checkpoint} palette={p} />}</Disclosure>; break
    case 'tool_use': body = <Disclosure title={`${c.tool}${c.subagent ? ' · subagent' : ''}${c.backgroundTask ? ' · background' : ''}`} palette={p}><Payload value={c.input} palette={p} /><Note palette={p}>Invocation: {c.itemId}{c.parentItemId ? ` · parent ${c.parentItemId}` : ''}</Note>{c.backgroundTask && <Note palette={p}>Background task: {c.backgroundTask.taskId}</Note>}{c.subagent && <Note palette={p}>Child session: {c.subagent.childSessionId} · {c.subagent.presentation}</Note>}</Disclosure>; break
    case 'tool_result': {
      const invocation = messages.find(m => m.content._tag === 'tool_use' && m.content.itemId === c.itemId)?.content
      body = <Disclosure title={`${invocation?._tag === 'tool_use' ? invocation.tool : 'Tool'} · ${c.isError ? 'failed' : 'result'}`} palette={p} initialOpen={c.isError}><Card title={c.isError ? 'Tool failed' : 'Tool output'} palette={p} error={c.isError}><Payload value={c.output} palette={p} /><Note palette={p}>Invocation: {c.itemId}{c.parentItemId ? ` · parent ${c.parentItemId}` : ''}</Note></Card></Disclosure>; break
    }
    case 'error': body = <Card title="Run error" palette={p} error><Prose text={c.message} palette={p} /></Card>; break
    case 'interrupted': body = <Note palette={p}>Interrupted by user</Note>; break
    case 'subagent_summary': body = <Card title={`${c.agentName} · ${c.isError ? 'failed' : 'completed'}`} palette={p} error={c.isError}><Prose text={c.summary} palette={p} /><Note palette={p}>{c.model} · {c.turns} turns · {duration(c.durationMs)}</Note>{c.childSessionId && <Note palette={p}>Child session: {c.childSessionId} · {c.presentation ?? 'inline'}</Note>}<Note palette={p}>Invocation: {c.itemId}</Note></Card>; break
    case 'subagent_progress': body = <Card title={`Subagent · ${c.status}`} palette={p} error={c.errorCount > 0}><Note palette={p}>{c.turns} turns · {c.toolCalls} tool calls · {count(c.tokens)} tokens · {duration(c.durationMs)} · {c.contextPercentage}% context · {c.errorCount} errors</Note><Note palette={p}>Tools: {c.toolsUsed.join(', ') || 'None yet'}</Note><Note palette={p}>Child: {c.childId} · session: {c.childSessionId} · parent: {c.parentId}</Note></Card>; break
    case 'usage': body = <Disclosure title={`${c.model} · ${count(c.inputTokens)} input / ${count(c.outputTokens)} output tokens`} palette={p}><Note palette={p}>Cache read: {count(c.cacheReadTokens)} · cache creation: {count(c.cacheCreationTokens)}{c.parentItemId ? ` · parent ${c.parentItemId}` : ''}</Note></Disclosure>; break
    case 'context_usage': body = <Note palette={p}>Context: {count(c.usedTokens)} / {count(c.windowTokens)} tokens · {c.precision} · {c.providerId}{c.source ? ` · ${c.source}` : ''}</Note>; break
    case 'context_compaction': body = <Card title={c.status === 'in_progress' ? 'Compacting context' : 'Context compacted'} palette={p}><Note palette={p}>{count(c.beforeTokens)} → {count(c.afterTokens)} tokens · {duration(c.durationMs)} · {c.providerId}</Note><Note palette={p}>Started: {new Date(c.startedAt).toLocaleString()} · {c.itemId}</Note></Card>; break
    case 'usage_limit': body = <Card title={c.label} palette={p}><Note palette={p}>{c.providerId} · {c.usedPercent === null ? 'Usage unknown' : `${c.usedPercent}% used`}{c.windowMinutes === null ? '' : ` · ${c.windowMinutes}-minute window`}</Note><Note palette={p}>{c.resetsAt ? `Resets ${c.resetsAt}` : 'Reset time unknown'}</Note></Card>; break
    case 'user_question': body = <Disclosure title={`${c.questions.length} question${c.questions.length === 1 ? '' : 's'} asked`} palette={p}>{c.questions.map((q, i) => <Box key={i} style={{ gap: 6 }}><Prose text={q.question} palette={p} />{q.options.map((o, j) => <Note key={j} palette={p}>{j + 1}. {o}</Note>)}<Note palette={p}>{q.multiSelect ? 'Multiple choices allowed' : 'One choice or a written answer'}</Note></Box>)}</Disclosure>; break
    case 'user_question_answer': {
      const question = messages.find(m => m.content._tag === 'user_question' && m.content.itemId === c.itemId)?.content
      body = <Card title={c.resolution ? `Question ${c.resolution}` : 'Your answers'} palette={p}>{c.answers.map(a => <Box key={a.questionIndex} style={{ gap: 6 }}><Note palette={p}>{question?._tag === 'user_question' ? question.questions[a.questionIndex]?.question ?? `Question ${a.questionIndex + 1}` : `Question ${a.questionIndex + 1}`}</Note>{a.selected.map(index => <Prose key={index} text={question?._tag === 'user_question' ? question.questions[a.questionIndex]?.options[index] ?? `Option ${index + 1}` : `Option ${index + 1}`} palette={p} />)}{a.other && <Prose text={a.other} palette={p} />}</Box>)}</Card>; break
    }
    default: { const exhaustive: never = c; body = <Payload value={exhaustive} palette={p} /> }
  }
  return <Box testId={`message-${message.id}`} style={{ width: '100%', marginBottom: 18, gap: 4 }}>{body}<Note palette={p}>{message.createdAt.toLocaleTimeString()}</Note></Box>
}
function QuestionCard({ question, backend, session, palette: p, actionable, onError }: { question: Question; backend: Backend; session: Session; palette: Palette; actionable: boolean; onError: Props['onError'] }) {
  const [answers, setAnswers] = useState<UserQuestionAnswer[]>(question.questions.map((_, questionIndex) => ({ questionIndex, selected: [], other: '' })))
  const submission = useSubmission(`${session.id}:question:${question.id}`, backend, onError)
  const valid = answers.every(a => a.selected.length > 0 || (a.other?.trim().length ?? 0) > 0)
  const disabled = submission.retained || !actionable
  return <Card title="Your input is needed" palette={p}>{question.questions.map((q, i) => <Box key={i} style={{ gap: 8 }}><Prose text={q.question} palette={p} /><Note palette={p}>{q.multiSelect ? 'Select any that apply, or write an answer.' : 'Select one, or write an answer.'}</Note>{q.options.map((option, index) => <Button key={index} palette={p} disabled={disabled} label={`${answers[i]?.selected.includes(index) ? 'Selected: ' : ''}${option}`} selected={answers[i]?.selected.includes(index)} action={() => setAnswers(old => old.map((a, j) => j !== i ? a : { ...a, selected: q.multiSelect ? a.selected.includes(index) ? a.selected.filter(v => v !== index) : [...a.selected, index] : a.selected.includes(index) ? [] : [index], other: q.multiSelect ? a.other : '' }))} />)}<input value={answers[i]?.other ?? ''} placeholder="Other answer" readOnly={disabled} onChange={event => setAnswers(old => old.map((a, j) => j !== i ? a : { ...a, other: event.value ?? '', selected: q.multiSelect ? a.selected : [] }))} style={{ width: '100%', height: 36, color: p.text, backgroundColor: p.wash, padding: 8, borderRadius: 6 }} /></Box>)}{!actionable && <Note palette={p}>Waiting for the provider to reconnect this question.</Note>}{submission.error && <Note palette={p} error>{submission.error}</Note>}<Button palette={p} label={submission.state === 'sent' ? 'Answer sent · awaiting confirmation' : submission.state === 'sending' ? 'Sending answer…' : submission.retained ? 'Retry original answer' : 'Submit answers'} disabled={submission.busy || !actionable || (!submission.retained && !valid)} action={() => void submission.submit(() => questionSteps(session.id, question.id, answers.map(a => ({ ...a, other: a.other?.trim() || undefined }))))} /></Card>
}
function PermissionCard({ request, backend, palette: p, actionable, onError }: { request: PermissionRequest; backend: Backend; palette: Palette; actionable: boolean; onError: Props['onError'] }) {
  const submission = useSubmission(`${request.sessionId}:permission:${request.id}`, backend, onError)
  const kind = request.kind
  const title = kind._tag === 'Bash' ? 'Run shell command?' : kind._tag === 'FileWrite' ? 'Write file?' : kind._tag === 'Network' ? 'Make network request?' : `Use ${kind.tool}?`
  const detail = kind._tag === 'Bash' ? kind.command : kind._tag === 'FileWrite' ? kind.path : kind._tag === 'Network' ? kind.url : kind.summary
  const expired = request.recoveryState === 'expired'
  const decide = (decision: PermissionDecision) => {
    if (!actionable || (expired && submission.retained) || (expired && decision._tag !== 'Deny') || (request.forcePrompt && ['AllowForSession', 'AlwaysAllow'].includes(decision._tag))) return
    void submission.submit(() => {
      const payload = { requestId: request.id, decision: structuredClone(decision) }
      const interrupt = { commandId: CommandId.make(crypto.randomUUID()), sessionId: request.sessionId }
      return decision._tag === 'Deny' && !expired
        ? [client => client.permissions.decide(payload), client => client.messages.interrupt(interrupt)]
        : [client => client.permissions.decide(payload)]
    })
  }
  return <Card title={title} palette={p}><code code={detail} language={kind._tag === 'Bash' ? 'bash' : 'text'} style={{ width: '100%' }} />{request.forcePrompt && <Note palette={p}>This request requires a one-time decision. Persistent approval is unavailable.</Note>}{expired && <Note palette={p}>This provider callback expired. Dismiss it; it cannot be approved.</Note>}{!actionable && <Note palette={p}>Reconnecting approval request…</Note>}<Box style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}><Button palette={p} label={submission.retained ? 'Retry original decision' : expired ? 'Dismiss' : 'Deny'} disabled={submission.busy || !actionable || (expired && submission.retained)} action={() => decide({ _tag: 'Deny' })} /><Button palette={p} label="Allow once" disabled={submission.retained || expired || !actionable} action={() => decide({ _tag: 'AllowOnce' })} />{!request.forcePrompt && !expired && !submission.retained && <><Button palette={p} label="Allow for session" disabled={submission.busy || !actionable} action={() => decide({ _tag: 'AllowForSession' })} /><Button palette={p} label="Always allow in folder" disabled={submission.busy || !actionable} action={() => decide({ _tag: 'AlwaysAllow', scope: 'folder' })} /></>}</Box>{submission.state !== 'idle' && <Note palette={p}>{submission.state === 'sent' ? 'Decision sent · awaiting confirmation' : 'Sending decision…'}</Note>}{submission.error && <Note palette={p} error>{submission.error}</Note>}</Card>
}
function PlanCard({ plan, backend, session, palette: p, onError, actionable }: { plan: PendingPlanInteraction; backend: Backend; session: Session; palette: Palette; onError: Props['onError']; actionable: boolean }) {
  const [feedback, setFeedback] = useState('')
  const key = `${session.id}:plan:${plan.kind === 'permission' ? plan.request.id : plan.sourceMessageId}`
  const submission = useSubmission(key, backend, onError)
  const respond = (outcome: 'approved' | 'cancelled') => {
    if (!actionable) return
    retainedPlans.set(session.id, plan)
    void submission.submit(() => planSteps(plan, session.id, outcome, feedback))
  }
  return <Card title="Review proposed plan" palette={p}>{plan.plan && <Prose text={plan.plan} palette={p} />}{plan.kind === 'native' && <input value={feedback} readOnly={submission.retained} placeholder="Optional feedback" onChange={event => setFeedback(event.value ?? '')} style={{ width: '100%', height: 36, color: p.text, backgroundColor: p.wash, padding: 8, borderRadius: 6 }} />}<Box style={{ flexDirection: 'row', gap: 8 }}>{submission.retained ? <Button palette={p} label="Retry original plan decision" disabled={submission.busy || !actionable} action={() => respond('approved')} /> : <><Button palette={p} label="Cancel plan" disabled={!actionable} action={() => respond('cancelled')} /><Button palette={p} label="Approve implementation" disabled={!actionable} action={() => respond('approved')} /></>}</Box>{submission.state !== 'idle' && <Note palette={p}>{submission.state === 'sent' ? 'Decision sent · awaiting confirmation' : 'Sending decision…'}</Note>}{submission.error && <Note palette={p} error>{submission.error}</Note>}</Card>
}
export function Transcript({ backend, session, timeline, palette: p, onError }: Props) {
  const [attachedQuestions, setAttachedQuestions] = useState<ReadonlySet<string>>(new Set())
  const [livePermissions, setLivePermissions] = useState<ReadonlyMap<string, PermissionRequest>>(new Map())
  const [authoritySession, setAuthoritySession] = useState<string | null>(null)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  useEffect(() => {
    setAttachedQuestions(new Set()); setLivePermissions(new Map()); setAuthoritySession(null)
    if (!backend || !session) return
    const sessionId = session.id
    let active = true
    const questions = backend.subscribe(backend.client['session.questionAttachments']({}), event => {
      if (!active) return
      setAuthoritySession(sessionId)
      setAttachedQuestions(old => {
        if (event._tag === 'snapshot') return new Set(event.attachments.filter(a => a.sessionId === sessionId).map(a => a.itemId))
        const next = new Set(old)
        if (event._tag === 'remove' && event.sessionId === sessionId) next.delete(event.itemId)
        if (event._tag === 'change' && event.attachment.sessionId === sessionId) next.add(event.attachment.itemId)
        return next
      })
    }, error => { if (active) { setAttachedQuestions(new Set()); onErrorRef.current(String(error)) } })
    const permissions = backend.subscribe(backend.permissions.requests({}), event => {
      if (!active) return
      setAuthoritySession(sessionId)
      setLivePermissions(old => {
        if (event._tag === 'snapshot') return new Map(event.requests.filter(r => r.sessionId === sessionId).map(r => [r.id, r]))
        const next = new Map(old)
        if (event._tag === 'remove') next.delete(event.requestId)
        if (event._tag === 'change' && event.request.sessionId === sessionId) next.set(event.request.id, event.request)
        return next
      })
    }, error => { if (active) { setLivePermissions(new Map()); onErrorRef.current(String(error)) } })
    return () => { active = false; questions.cancel(); permissions.cancel() }
  }, [backend, session?.id])
  const messages = timeline.projection?.messages ?? []
  const interactions = timeline.projection?.interactions ?? []
  const coherent = session !== null && authoritySession === session.id && timeline.phase === 'live'
  const detectedPlan = session && timeline.projection ? findPendingPlanInteraction({ messages, requests: [...livePermissions.values()], sessionId: session.id, providerId: session.providerId, permissionMode: timeline.projection.permissionMode, isRunning: timeline.projection.status === 'running' }) : null
  const retainedPlan = session ? retainedPlans.get(session.id) : undefined
  const retainedKey = retainedPlan && session ? `${session.id}:plan:${retainedPlan.kind === 'permission' ? retainedPlan.request.id : retainedPlan.sourceMessageId}` : null
  const retainedState = retainedKey ? interactionIntents.get(retainedKey)?.state : undefined
  const plan = retainedPlan && (retainedState === 'sending' || retainedState === 'failed') ? retainedPlan : detectedPlan
  return <Box testId="session-transcript" style={{ width: '100%', gap: 12 }}>{timeline.error && <Note palette={p} error>{timeline.error}</Note>}{timeline.phase !== 'live' && <Note palette={p}>{timeline.phase === 'deleted' ? 'This session was deleted.' : `Timeline ${timeline.phase} · controls wait for live state.`}</Note>}{messages.map(message => <MessageRow key={message.id} message={message} messages={messages} palette={p} />)}{backend && session && interactions.map(item => item._tag === 'Question' ? <QuestionCard key={`${session.id}:question:${item.id}`} question={item} backend={backend} session={session} palette={p} actionable={coherent && attachedQuestions.has(item.id)} onError={onError} /> : plan?.kind === 'permission' && plan.request.id === item.request.id ? null : <PermissionCard key={`${session.id}:permission:${item.id}`} request={livePermissions.get(item.request.id) ?? item.request} backend={backend} palette={p} actionable={coherent && livePermissions.has(item.request.id)} onError={onError} />)}{backend && session && plan && <PlanCard key={`${session.id}:plan:${plan.kind === 'permission' ? plan.request.id : plan.sourceMessageId}`} plan={plan} backend={backend} session={session} palette={p} actionable={timeline.phase === 'live' && (plan.kind !== 'permission' || (coherent && livePermissions.has(plan.request.id) && livePermissions.get(plan.request.id)?.recoveryState !== 'expired'))} onError={onError} />}</Box>
}
