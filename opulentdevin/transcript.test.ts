import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { Box, RetryIntent, questionSteps, planSteps } from './transcript'
import type { Backend } from './backend'
import { AgentSessionId, AgentItemId } from './zuse-runtime/packages/contracts/src/ids.ts'
import type { PendingPlanInteraction } from './zuse-runtime/packages/client-runtime/src/plan-interactions.ts'

vi.mock('@gpuix/react/jsx-runtime', () => ({ jsx: (type: unknown, props: unknown) => ({ type, props }), jsxs: (type: unknown, props: unknown) => ({ type, props }) }))
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
    const retry = new RetryIntent()
    await expect(retry.run(b, () => questionSteps(sessionId, itemId, answers))).rejects.toThrow('timeout')
    answers[0]!.other = 'Changed'
    const prepare = vi.fn(() => questionSteps(sessionId, itemId, answers))
    await retry.run(b, prepare)
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
    const retry = new RetryIntent()
    await expect(retry.run(b, () => planSteps(plan, sessionId, 'cancelled', 'Revise'))).rejects.toThrow()
    await retry.run(b, () => planSteps(plan, sessionId, 'approved', 'Changed'))
    const calls = vi.mocked(b.sessions.respondToPlan).mock.calls
    expect(calls[0]).toEqual(calls[1])
    expect(calls[1]![0].outcome).toBe('cancelled')
    expect(calls[1]![0].feedback).toBe('Revise')
  })
  it('does not repeat a confirmed mode change when the following send times out', async () => {
    const b = backend()
    vi.mocked(b.messages.send).mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(undefined)
    const plan: PendingPlanInteraction = { kind: 'emulated', emulated: { messageId: 'plan', plan: 'Steps' }, plan: 'Steps', sourceMessageId: 'plan' }
    const retry = new RetryIntent()
    await expect(retry.run(b, () => planSteps(plan, sessionId, 'approved', ''))).rejects.toThrow()
    await retry.run(b, () => { throw new Error('must retain original steps') })
    expect(b.sessions.setPermissionMode).toHaveBeenCalledTimes(1)
    const calls = vi.mocked(b.messages.send).mock.calls
    expect(calls[0]).toEqual(calls[1])
    expect(calls[0]![0].clientMessageId).toBeTruthy()
  })
  it('does not send a turn for emulated cancellation', async () => {
    const b = backend()
    const plan: PendingPlanInteraction = { kind: 'emulated', emulated: { messageId: 'plan', plan: 'Steps' }, plan: 'Steps', sourceMessageId: 'plan' }
    await new RetryIntent().run(b, () => planSteps(plan, sessionId, 'cancelled', ''))
    expect(b.sessions.setPermissionMode).toHaveBeenCalledOnce()
    expect(b.messages.send).not.toHaveBeenCalled()
  })
  it('prevents duplicate dispatch during flight and after success', async () => {
    const b = backend()
    let release!: () => void
    const operation = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
    const retry = new RetryIntent()
    const first = retry.run(b, () => [operation])
    await retry.run(b, () => [operation])
    release(); await first
    await retry.run(b, () => [operation])
    expect(operation).toHaveBeenCalledOnce()
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
