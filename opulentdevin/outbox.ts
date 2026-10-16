import { randomUUID } from 'node:crypto'
import { constants, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync, mkdirSync, fstatSync, fchmodSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Schema } from 'effect'
import { CommandId, MessageId, ChatId, AgentSessionId, EnvironmentId } from './zuse-runtime/packages/contracts/src/ids.ts'
import { MessagesSendRpc, ChatCreateRpc } from './zuse-runtime/packages/contracts/src/session.ts'
import { assertCommandFingerprint, commandFingerprint, canonicalClientCommandJson } from './zuse-runtime/packages/client-runtime/src/client-persistence.ts'

export type SendPayload = typeof MessagesSendRpc.payloadSchema.Type
export type CreatePayload = typeof ChatCreateRpc.payloadSchema.Type
export type OutgoingCommand =
  | Readonly<{ kind: 'messages.send'; commandId: CommandId; payload: SendPayload }>
  | Readonly<{ kind: 'chat.create'; commandId: CommandId; payload: CreatePayload }>

export function prepareMessage(payload: Omit<SendPayload, 'commandId' | 'clientMessageId'>): OutgoingCommand & { kind: 'messages.send' } {
  const commandId = CommandId.make(randomUUID())
  return { kind: 'messages.send', commandId, payload: { ...payload, commandId, clientMessageId: MessageId.make(randomUUID()) } }
}
export function prepareChat(payload: Omit<CreatePayload, 'operationId' | 'chatId' | 'initialSessionId' | 'startupQueueId'>): OutgoingCommand & { kind: 'chat.create' } {
  const commandId = CommandId.make(randomUUID())
  return { kind: 'chat.create', commandId, payload: { ...payload, operationId: commandId, chatId: ChatId.make(randomUUID()), initialSessionId: AgentSessionId.make(randomUUID()), startupQueueId: randomUUID() } }
}

const CommandSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('messages.send'), commandId: CommandId, payload: MessagesSendRpc.payloadSchema }),
  Schema.Struct({ kind: Schema.Literal('chat.create'), commandId: CommandId, payload: ChatCreateRpc.payloadSchema }),
])
const PendingSchema = Schema.Struct({ command: CommandSchema, fingerprint: Schema.String, createdAt: Schema.Number })
const ReceiptSchema = Schema.Struct({ commandId: CommandId, fingerprint: Schema.String, acknowledgedAt: Schema.Number })
const StoreSchema = Schema.Struct({ version: Schema.Literal(1), environmentId: EnvironmentId, entries: Schema.Array(PendingSchema), receipts: Schema.Array(ReceiptSchema) })
export type PendingCommand = typeof PendingSchema.Type
export type CommandAcknowledgement = typeof ReceiptSchema.Type
export type EnqueueResult = { state: 'pending'; entry: PendingCommand } | { state: 'acknowledged'; receipt: CommandAcknowledgement }
type Store = typeof StoreSchema.Type
const decodeCommand = Schema.decodeUnknownSync(CommandSchema, { onExcessProperty: 'error' })
const decodeStore = Schema.decodeUnknownSync(StoreSchema, { onExcessProperty: 'error' })
const MAX_BYTES = 16 * 1024 * 1024

function validated(command: OutgoingCommand): OutgoingCommand {
  const decoded = decodeCommand(JSON.parse(canonicalClientCommandJson(command)))
  if (decoded.kind === 'messages.send') {
    if (decoded.payload.commandId !== decoded.commandId || !decoded.payload.clientMessageId) throw new Error('Message retry requires matching commandId and stable clientMessageId')
    if (decoded.payload.text === undefined && decoded.payload.input === undefined) throw new Error('Message requires text or structured input')
  } else if (decoded.payload.operationId !== decoded.commandId || !decoded.payload.chatId || !decoded.payload.initialSessionId || !decoded.payload.startupQueueId) {
    throw new Error('Chat retry requires stable operation, chat, session and queue identities')
  }
  return decoded
}
function fingerprint(command: OutgoingCommand, environmentId: EnvironmentId): string {
  return commandFingerprint({ ...command, environmentId, resource: null, retry: 'safe', createdAt: 0 })
}

export class Outbox {
  readonly path: string
  readonly environmentId: EnvironmentId
  constructor(path: string, environmentId: EnvironmentId) {
    this.path = resolve(path)
    this.environmentId = EnvironmentId.make(environmentId)
  }
  pending(): readonly PendingCommand[] {
    return this.read().entries
  }
  enqueue(command: OutgoingCommand): EnqueueResult {
    const safe = validated(command)
    const hash = fingerprint(safe, this.environmentId)
    return this.transaction(store => {
      const receipt = store.receipts.find(r => r.commandId === safe.commandId)
      if (receipt) {
        assertCommandFingerprint(safe.commandId, receipt.fingerprint, hash)
        return { store, result: { state: 'acknowledged', receipt } as EnqueueResult }
      }
      const existing = store.entries.find(e => e.command.commandId === safe.commandId)
      if (existing) {
        assertCommandFingerprint(safe.commandId, existing.fingerprint, hash)
        return { store, result: { state: 'pending', entry: existing } as EnqueueResult }
      }
      const entry = { command: safe, fingerprint: hash, createdAt: Date.now() }
      return { store: { ...store, entries: [...store.entries, entry] }, result: { state: 'pending', entry } as EnqueueResult }
    })
  }
  ack(commandId: CommandId, expectedFingerprint: string): CommandAcknowledgement {
    return this.transaction(store => {
      const receipt = store.receipts.find(r => r.commandId === commandId)
      if (receipt) {
        assertCommandFingerprint(commandId, receipt.fingerprint, expectedFingerprint)
        return { store, result: receipt }
      }
      const entry = store.entries.find(e => e.command.commandId === commandId)
      if (!entry) throw new Error('Cannot acknowledge an unknown command')
      assertCommandFingerprint(commandId, entry.fingerprint, expectedFingerprint)
      const next = { commandId, fingerprint: entry.fingerprint, acknowledgedAt: Date.now() }
      return { store: { ...store, entries: store.entries.filter(e => e !== entry), receipts: [...store.receipts, next] }, result: next }
    })
  }
  private read(): Store {
    let fd: number
    try { fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { version: 1, environmentId: this.environmentId, entries: [], receipts: [] }
      throw error
    }
    let store: Store
    try {
      const info = fstatSync(fd)
      if (!info.isFile() || info.size > MAX_BYTES) throw new Error('Invalid or oversized outbox file')
      if ((info.mode & 0o077) !== 0) throw new Error('Outbox file must have private mode 0600')
      store = decodeStore(JSON.parse(readFileSync(fd, 'utf8')))
    } finally { closeSync(fd) }
    if (store.environmentId !== this.environmentId) throw new Error('Outbox belongs to a different backend environment')
    const ids = new Set<string>()
    for (const entry of store.entries) {
      const command = validated(entry.command)
      assertCommandFingerprint(command.commandId, entry.fingerprint, fingerprint(command, this.environmentId))
      if (ids.has(command.commandId)) throw new Error('Duplicate outbox command identity')
      ids.add(command.commandId)
    }
    for (const receipt of store.receipts) {
      if (ids.has(receipt.commandId)) throw new Error('Duplicate acknowledged command identity')
      ids.add(receipt.commandId)
    }
    return store
  }
  private transaction<T>(change: (store: Store) => { store: Store; result: T }): T {
    const directory = dirname(this.path)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const lock = `${this.path}.lock`
    const lockFd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    const temporary = `${this.path}.${randomUUID()}.tmp`
    let temporaryExists = false
    try {
      const previous = this.read()
      const { store, result } = change(previous)
      if (store === previous) return result
      const bytes = canonicalClientCommandJson(store)
      if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('Outbox storage limit reached; no command was sent')
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      temporaryExists = true
      try { fchmodSync(fd, 0o600); writeFileSync(fd, bytes, 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(temporary, this.path)
      temporaryExists = false
      const directoryFd = openSync(directory, constants.O_RDONLY)
      try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
      return result
    } finally {
      if (temporaryExists) unlinkSync(temporary)
      closeSync(lockFd)
      unlinkSync(lock)
    }
  }
}
