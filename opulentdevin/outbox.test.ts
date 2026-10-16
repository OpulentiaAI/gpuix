import { mkdtempSync, readFileSync, writeFileSync, chmodSync, statSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Outbox, prepareMessage, prepareChat, type OutgoingCommand } from './outbox'
import { AgentSessionId, EnvironmentId, FolderId } from '../../zuse/packages/contracts/src/ids.ts'

const roots: string[] = []
const environment = EnvironmentId.make('native-test-environment')
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'opulentdevin-outbox-'))
  roots.push(root)
  const path = join(root, 'private', 'outbox.json')
  return { root, path, outbox: new Outbox(path, environment) }
}
const message = () => prepareMessage({ sessionId: AgentSessionId.make('session-test'), text: 'User-owned prompt' })
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('native durable outgoing command outbox', () => {
  it('persists exact send identities and payload before retry across process recreation', () => {
    const { path, outbox } = setup()
    const command = message()
    const queued = outbox.enqueue(command)
    expect(queued.state).toBe('pending')
    expect(new Outbox(path, environment).pending()[0]?.command).toEqual(command)
    expect(command.payload.commandId).toBe(command.commandId)
    expect(command.payload.clientMessageId).toBeTruthy()
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(path, '..'))).toEqual(['outbox.json'])
  })
  it('retains a timed-out accepted send and retries with identical server identities', async () => {
    const { path, outbox } = setup()
    const command = message()
    const queued = outbox.enqueue(command)
    if (queued.state !== 'pending') throw new Error('Expected pending')
    const accepted = new Set<string>()
    let turns = 0
    const dispatch = async (entry: OutgoingCommand, dropReply: boolean) => {
      if (!accepted.has(entry.commandId)) { accepted.add(entry.commandId); turns++ }
      if (dropReply) throw new Error('Connection lost after server acceptance')
    }
    await expect(dispatch(queued.entry.command, true)).rejects.toThrow('Connection lost')
    const reopened = new Outbox(path, environment)
    const restored = reopened.pending()[0]!
    await dispatch(restored.command, false)
    reopened.ack(restored.command.commandId, restored.fingerprint)
    expect(turns).toBe(1)
    expect(reopened.pending()).toEqual([])
    expect(reopened.enqueue(command).state).toBe('acknowledged')
  })
  it('deduplicates canonical payload order and rejects command identity collisions', () => {
    const { outbox } = setup()
    const command = message()
    outbox.enqueue(command)
    outbox.enqueue({ ...command, payload: { text: command.payload.text, clientMessageId: command.payload.clientMessageId, sessionId: command.payload.sessionId, commandId: command.commandId } })
    expect(outbox.pending()).toHaveLength(1)
    expect(() => outbox.enqueue({ ...command, payload: { ...command.payload, text: 'Changed prompt' } })).toThrow('reused for a different command')
  })
  it('atomically records acknowledgement tombstones and refuses wrong fingerprints', () => {
    const { path, outbox } = setup()
    const command = message()
    const queued = outbox.enqueue(command)
    if (queued.state !== 'pending') throw new Error('Expected pending')
    expect(() => outbox.ack(command.commandId, 'wrong')).toThrow()
    expect(outbox.pending()).toHaveLength(1)
    outbox.ack(command.commandId, queued.entry.fingerprint)
    outbox.ack(command.commandId, queued.entry.fingerprint)
    expect(new Outbox(path, environment).enqueue(command).state).toBe('acknowledged')
    expect(readFileSync(path, 'utf8')).not.toContain('User-owned prompt')
  })
  it('persists all chat creation identities, startup input and selected settings', () => {
    const { path, outbox } = setup()
    const command = prepareChat({ projectId: FolderId.make('folder-test'), providerId: 'claude', model: 'chosen-model', startupInput: { text: 'Start here', attachments: [], fileRefs: [], skillRefs: [], annotations: [] }, background: true, permissionMode: 'plan' })
    outbox.enqueue(command)
    const restored = new Outbox(path, environment).pending()[0]!.command
    expect(restored).toEqual(command)
    if (restored.kind !== 'chat.create') throw new Error('Wrong command kind')
    expect(restored.payload.operationId).toBe(restored.commandId)
    expect(restored.payload.chatId).toBeTruthy()
    expect(restored.payload.initialSessionId).toBeTruthy()
    expect(restored.payload.startupQueueId).toBeTruthy()
  })
  it('retains rich message content rather than silently reducing it to text', () => {
    const { outbox } = setup()
    const command = prepareMessage({ sessionId: AgentSessionId.make('session-test'), input: { text: 'Inspect the file', attachments: [{ id: 'attachment-test', originalName: 'sample.png', mimeType: 'image/png' }], fileRefs: [{ relPath: 'a.ts', absPath: '/project/a.ts', kind: 'file' }], skillRefs: [], annotations: [] }, modelOptions: { reasoning: 'high' }, asGoal: true })
    outbox.enqueue(command)
    expect(outbox.pending()[0]!.command).toEqual(command)
  })
  it('rejects malformed or credential-bearing extra payload fields without writing them', () => {
    const { outbox, path } = setup()
    const command = message()
    const extra = { ...command, payload: { ...command.payload, authToken: 'not-a-real-secret' } }
    expect(() => outbox.enqueue(extra)).toThrow()
    expect(outbox.pending()).toEqual([])
    expect(() => statSync(path)).toThrow()
  })
  it('fails closed on corrupt storage, wrong backend and public permissions', () => {
    const { path, outbox } = setup()
    outbox.enqueue(message())
    expect(() => new Outbox(path, EnvironmentId.make('other-environment')).pending()).toThrow('different backend')
    chmodSync(path, 0o644)
    expect(() => outbox.pending()).toThrow('private mode')
    chmodSync(path, 0o600)
    writeFileSync(path, '{invalid')
    expect(() => outbox.enqueue(message())).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('{invalid')
  })
  it('refuses symlink files and locks rather than overwriting another writer', () => {
    const { path, outbox, root } = setup()
    outbox.enqueue(message())
    const before = readFileSync(path, 'utf8')
    writeFileSync(`${path}.lock`, '', { mode: 0o600 })
    expect(() => outbox.enqueue(message())).toThrow()
    expect(readFileSync(path, 'utf8')).toBe(before)
    rmSync(`${path}.lock`)
    const link = join(root, 'alias.json')
    symlinkSync(path, link)
    expect(() => new Outbox(link, environment).pending()).toThrow()
  })
  it('detects tampering and does not silently replace the persisted command', () => {
    const { path, outbox } = setup()
    outbox.enqueue(message())
    const contents = JSON.parse(readFileSync(path, 'utf8'))
    contents.entries[0].command.payload.text = 'Changed after persistence'
    writeFileSync(path, JSON.stringify(contents), { mode: 0o600 })
    expect(() => outbox.pending()).toThrow('reused for a different command')
  })
})
