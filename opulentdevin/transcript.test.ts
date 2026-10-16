import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { Box, RetryIntent, questionSteps, planSteps, transcriptEnvironmentKey } from './transcript'
import type { Backend } from './backend'
import { AgentSessionId, AgentItemId, EnvironmentId } from './zuse-runtime/packages/contracts/src/ids.ts'
import type { PendingPlanInteraction } from './zuse-runtime/packages/client-runtime/src/plan-interactions.ts'

vi.mock('@gpuix/react/jsx-runtime', () => ({ jsx: (type: unknown, props: unknown) => ({ type, props }), jsxs: (type: unknown, props: unknown) => ({ type, props }) }))
const environmentId = EnvironmentId.make('environment-a')
const otherEnvironmentId = EnvironmentId.make('environment-b')
const sessionId = AgentSessionId.make('session-test')
const itemId = AgentItemId.make('question-test')
function backend() {
  return { sessions: { answerQuestion: vi.fn(), respondToPlan: vi.fn(), setPermissionMode: vi.fn() }, messages: { send: vi.fn() }, permissions: { decide: vi.fn() } } as unknown as Backend
}
describe('transcript retry intents', () => {
  it('freezes answers and preserves the command ID after an unknown result', async () => {
    const b = backend()
    vi.mocked(b.sessions.answerQuestion).mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(undefined)
    const answers = [{ questionIndex: 0, selected: [1], other: 'Original' }]
    const retry = new RetryIntent(environmentId)
    await expect(retry.run(b, environmentId, () => questionSteps(sessionId, itemId, answers))).rejects.toThrow('timeout')
    answers[0]!.other = 'Changed'
    const prepare = vi.fn(() => questionSteps(sessionId, itemId, answers))
    await retry.run(b, environmentId, prepare)
    expect(prepare).not.toHaveBeenCalled()
    const calls = vi.mocked(b.sessions.answerQuestion).mock.calls
    expect(calls[0]).toEqual(calls[1])
    expect(calls[1]![0].answers[0]!.other).toBe('Original')
    expect(retry.state).toBe('sent')
  })
  it('retries native plan outcome and feedback without changing identity', async () => {
    const b = backend()
    vi.mocked(b.sessions.respondToPlan).mockRejectedValueOnce(new Error('lost receipt')).mockResolvedValue(undefined)
    const plan: PendingPlanInteraction = { kind: 'native', native: { toolCallId: itemId, messageId: 'plan', plan: 'Steps' }, plan: 'Steps', sourceMessageId: 'plan' }
    const retry = new RetryIntent(environmentId)
    await expect(retry.run(b, environmentId, () => planSteps(plan, sessionId, 'cancelled', 'Revise'))).rejects.toThrow()
    await retry.run(b, environmentId, () => planSteps(plan, sessionId, 'approved', 'Changed'))
    const calls = vi.mocked(b.sessions.respondToPlan).mock.calls
    expect(calls[0]).toEqual(calls[1])
    expect(calls[1]![0].outcome).toBe('cancelled')
    expect(calls[1]![0].feedback).toBe('Revise')
  })
  it('does not repeat a confirmed mode change when the following send times out', async () => {
    const b = backend()
    vi.mocked(b.messages.send).mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(undefined)
    const plan: PendingPlanInteraction = { kind: 'emulated', emulated: { messageId: 'plan', plan: 'Steps' }, plan: 'Steps', sourceMessageId: 'plan' }
    const retry = new RetryIntent(environmentId)
    await expect(retry.run(b, environmentId, () => planSteps(plan, sessionId, 'approved', ''))).rejects.toThrow()
    await retry.run(b, environmentId, () => { throw new Error('must retain original steps') })
    expect(b.sessions.setPermissionMode).toHaveBeenCalledTimes(1)
    const calls = vi.mocked(b.messages.send).mock.calls
    expect(calls[0]).toEqual(calls[1])
    expect(calls[0]![0].clientMessageId).toBeTruthy()
  })
  it('does not send a turn for emulated cancellation', async () => {
    const b = backend()
    const plan: PendingPlanInteraction = { kind: 'emulated', emulated: { messageId: 'plan', plan: 'Steps' }, plan: 'Steps', sourceMessageId: 'plan' }
    await new RetryIntent(environmentId).run(b, environmentId, () => planSteps(plan, sessionId, 'cancelled', ''))
    expect(b.sessions.setPermissionMode).toHaveBeenCalledOnce()
    expect(b.messages.send).not.toHaveBeenCalled()
  })
  it('prevents duplicate dispatch during flight and after success', async () => {
    const b = backend()
    let release!: () => void
    const operation = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
    const retry = new RetryIntent(environmentId)
    const first = retry.run(b, environmentId, () => [operation])
    await retry.run(b, environmentId, () => [operation])
    release(); await first
    await retry.run(b, environmentId, () => [operation])
    expect(operation).toHaveBeenCalledOnce()
  })
  it.each(['question', 'permission', 'plan'])('isolates %s keys for identical session and interaction IDs in two environments', kind => {
    const key = `${sessionId}:${kind}:${itemId}`
    const a = transcriptEnvironmentKey(environmentId, key)
    const b = transcriptEnvironmentKey(otherEnvironmentId, key)
    expect(a).not.toBe(b)
    expect(transcriptEnvironmentKey(environmentId, key)).toBe(a)
    expect(transcriptEnvironmentKey(environmentId, sessionId)).not.toBe(transcriptEnvironmentKey(otherEnvironmentId, sessionId))
  })
  it('rejects cross-environment replay without preparing or sending and preserves same-environment reconnect', async () => {
    const original = backend()
    const replacement = backend()
    const foreign = backend()
    vi.mocked(original.sessions.answerQuestion).mockRejectedValueOnce(new Error('unknown outcome'))
    const retry = new RetryIntent(environmentId)
    await expect(retry.run(original, environmentId, () => questionSteps(sessionId, itemId, [{ questionIndex: 0, selected: [0], other: 'Original answer' }]))).rejects.toThrow('unknown outcome')
    const foreignPrepare = vi.fn(() => questionSteps(sessionId, itemId, [{ questionIndex: 0, selected: [1] }]))
    await expect(retry.run(foreign, otherEnvironmentId, foreignPrepare)).rejects.toThrow('different environment')
    expect(foreignPrepare).not.toHaveBeenCalled()
    expect(foreign.sessions.answerQuestion).not.toHaveBeenCalled()
    expect(retry.state).toBe('failed')
    await retry.run(replacement, environmentId, () => { throw new Error('Original intent must survive reconnection') })
    expect(replacement.sessions.answerQuestion).toHaveBeenCalledWith(vi.mocked(original.sessions.answerQuestion).mock.calls[0]![0])
    expect(retry.state).toBe('sent')
    await expect(retry.run(foreign, otherEnvironmentId, foreignPrepare)).rejects.toThrow('different environment')
    expect(foreign.sessions.answerQuestion).not.toHaveBeenCalled()
  })
  it('rejects an environment mismatch before the first mutation', async () => {
    const foreign = backend()
    const prepare = vi.fn(() => questionSteps(sessionId, itemId, []))
    const retry = new RetryIntent(environmentId)
    await expect(retry.run(foreign, otherEnvironmentId, prepare)).rejects.toThrow('different environment')
    expect(prepare).not.toHaveBeenCalled()
    expect(retry.state).toBe('idle')
    expect(retry.retained).toBe(false)
  })
  it('rejects empty environment identities', () => {
    expect(() => new RetryIntent(' ' as EnvironmentId)).toThrow('verified environment identity')
    expect(() => transcriptEnvironmentKey(' ' as EnvironmentId, sessionId)).toThrow('verified environment identity')
  })
  it('activates all native transcript containers through the shared flex wrapper', () => {
    const column = Box({ style: { gap: 8 } })
    const row = Box({ style: { flexDirection: 'row', gap: 8 } })
    expect(column.props.style).toMatchObject({ display: 'flex', flexDirection: 'column', gap: 8 })
    expect(row.props.style).toMatchObject({ display: 'flex', flexDirection: 'row', gap: 8 })
    const source = readFileSync(new URL('./transcript.tsx', import.meta.url), 'utf8')
    expect(source.match(/<div\b/g)).toHaveLength(1)
  })
})
