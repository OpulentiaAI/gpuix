import { useEffect, useMemo, useReducer, useRef, type Dispatch, type SetStateAction } from 'react'
import { constants, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync, mkdirSync, lstatSync, fstatSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join, parse, resolve } from 'node:path'
import { Schema } from 'effect'
import { ComposerInput } from './zuse-runtime/packages/contracts/src/composer'
import { EnvironmentId, FolderId, AgentSessionId } from './zuse-runtime/packages/contracts/src/ids'
import { dataDirectory } from './preferences'
import type { OutgoingCommand } from './outbox'

const OwnerSchema = Schema.Struct({ environmentId: EnvironmentId, workspaceId: Schema.NullOr(FolderId), sessionId: Schema.NullOr(AgentSessionId) })
export type DraftOwner = typeof OwnerSchema.Type
const StoredDraft = Schema.Struct({ version: Schema.Literal(1), owner: OwnerSchema, revision: Schema.String, input: ComposerInput })
const decode = Schema.decodeUnknownSync(StoredDraft, { onExcessProperty: 'error' })
const encode = Schema.encodeSync(StoredDraft)
const encodeInput = Schema.encodeSync(ComposerInput)
const decodeInput = Schema.decodeUnknownSync(ComposerInput, { onExcessProperty: 'error' })
export const MAX_DRAFT_BYTES = 256 * 1024
const empty = () => ComposerInput.make({ text: '', attachments: [], fileRefs: [], skillRefs: [], annotations: [] })
const ownerKey = (owner: DraftOwner) => JSON.stringify([owner.environmentId, owner.workspaceId, owner.sessionId])
const sameInput = (a: ComposerInput, b: ComposerInput) => JSON.stringify(encodeInput(a)) === JSON.stringify(encodeInput(b))
function code(error: unknown) { return error instanceof Error && 'code' in error ? error.code : undefined }
function privateDirectory(path: string) {
  const absolute = resolve(path)
  let current = parse(absolute).root
  for (const segment of absolute.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, segment)
    try { const info = lstatSync(current); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Draft storage path must contain only real directories.') }
    catch (error) { if (code(error) !== 'ENOENT') throw error; mkdirSync(current, { mode: 0o700 }) }
  }
  const info = lstatSync(absolute)
  if ((info.mode & 0o077) !== 0) throw new Error('Draft storage directory must be private (0700).')
}
export type DraftSnapshot = { readonly owner: DraftOwner; readonly generation: string; readonly revision: string; readonly input: ComposerInput }
export function draftMatchesCommand(snapshot: DraftSnapshot, command: OutgoingCommand): boolean {
  try {
    if (command.kind === 'messages.send') {
      if (snapshot.owner.sessionId !== command.payload.sessionId) return false
      const input = command.payload.input ?? ComposerInput.make({ ...empty(), text: command.payload.text ?? '', asGoal: command.payload.asGoal })
      const canonical = command.payload.asGoal === undefined ? input : ComposerInput.make({ ...input, asGoal: command.payload.asGoal })
      return sameInput(snapshot.input, canonical)
    }
    if (snapshot.owner.sessionId !== null || snapshot.owner.workspaceId !== command.payload.projectId) return false
    const input = command.payload.startupInput ?? ComposerInput.make({ ...empty(), text: command.payload.initialPrompt ?? '' })
    return sameInput(snapshot.input, input)
  } catch { return false }
}
export class DraftStore {
  readonly directory: string
  constructor(directory = join(dataDirectory, 'composer-drafts')) { this.directory = resolve(directory) }
  path(owner: DraftOwner) { return join(this.directory, createHash('sha256').update(ownerKey(owner)).digest('hex') + '.json') }
  read(owner: DraftOwner) {
    privateDirectory(this.directory)
    let fd: number
    try { fd = openSync(this.path(owner), constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) { if (code(error) === 'ENOENT') return { version: 1 as const, owner, revision: 'empty', input: empty() }; throw error }
    try {
      const info = fstatSync(fd)
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_DRAFT_BYTES || (info.mode & 0o777) !== 0o600) throw new Error('Draft file is oversized, unsafe or not private (0600).')
      const value = decode(JSON.parse(readFileSync(fd, 'utf8')))
      if (ownerKey(value.owner) !== ownerKey(owner)) throw new Error('Draft owner mismatch.')
      return value
    } catch { throw new Error('Draft cannot be safely decoded; preserved without overwrite.') }
    finally { closeSync(fd) }
  }
  save(owner: DraftOwner, expectedRevision: string, input: ComposerInput) {
    privateDirectory(this.directory)
    const value = { version: 1 as const, owner, revision: randomUUID(), input: decodeInput(encodeInput(input)) }
    const bytes = JSON.stringify(encode(value))
    if (Buffer.byteLength(bytes) > MAX_DRAFT_BYTES) throw new Error('Draft exceeds the 256 KiB limit; existing draft preserved.')
    const path = this.path(owner)
    const lock = path + '.lock'
    let lockFd: number
    try { lockFd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
    catch { throw new Error('Draft is locked by another writer; existing draft preserved.') }
    const temporary = path + '.' + randomUUID() + '.tmp'
    let created = false
    try {
      if (this.read(owner).revision !== expectedRevision) throw new Error('Draft changed in another owner; reload before saving. Existing draft preserved.')
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      created = true
      try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(temporary, path); created = false
      const dir = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { fsyncSync(dir) } finally { closeSync(dir) }
      return value
    } finally { if (created) unlinkSync(temporary); closeSync(lockFd); unlinkSync(lock) }
  }
}
export class ComposerDraftController {
  generation = randomUUID()
  activate() { this.generation = randomUUID() }
  readonly owner: DraftOwner
  private revision = 'empty'
  private value = empty()
  private failed: string | null = null
  constructor(readonly store: DraftStore, owner: DraftOwner) {
    this.owner = Schema.decodeUnknownSync(OwnerSchema)(owner)
    try { const saved = store.read(this.owner); this.revision = saved.revision; this.value = saved.input }
    catch (error) { this.failed = error instanceof Error ? error.message : 'Draft load failed; preserved.' }
  }
  get error() { return this.failed }
  get input() { return this.value }
  snapshot(): DraftSnapshot { return { owner: this.owner, generation: this.generation, revision: this.revision, input: decodeInput(encodeInput(this.value)) } }
  setInput(action: SetStateAction<ComposerInput>) {
    const next = typeof action === 'function' ? action(this.value) : action
    this.value = decodeInput(encodeInput(next))
    if (this.failed) return
    try { const saved = this.store.save(this.owner, this.revision, this.value); this.revision = saved.revision }
    catch (error) { this.failed = error instanceof Error ? error.message : 'Draft save failed; unsaved text retained in memory.' }
  }
  clearExact(snapshot: DraftSnapshot) {
    if (this.failed || snapshot.generation !== this.generation || ownerKey(snapshot.owner) !== ownerKey(this.owner) || snapshot.revision !== this.revision || !sameInput(snapshot.input, this.value)) return false
    try { const saved = this.store.save(this.owner, this.revision, empty()); this.revision = saved.revision; this.value = saved.input; return true }
    catch (error) { this.failed = error instanceof Error ? error.message : 'Draft clear failed; preserved.'; return false }
  }
}
export function useComposerDraft(owner: DraftOwner, onError: (message: string) => void, directory = join(dataDirectory, 'composer-drafts')) {
  const key = ownerKey(owner)
  const retained = useRef(new Map<string, ComposerDraftController>())
  const controller = useMemo(() => {
    const cacheKey = JSON.stringify([directory, key])
    const previous = retained.current.get(cacheKey)
    const next = previous?.error ? previous : new ComposerDraftController(new DraftStore(directory), owner)
    next.activate(); retained.current.set(cacheKey, next)
    return next
  }, [key, directory])
  const generation = controller.generation
  const current = useRef(controller); current.current = controller
  const mounted = useRef(true)
  const [, update] = useReducer(value => value + 1, 0)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if (controller.error) onError(controller.error) }, [controller])
  const changed = () => { if (mounted.current && current.current === controller) update(); if (controller.error) onError(controller.error) }
  const setInput: Dispatch<SetStateAction<ComposerInput>> = action => { if (!mounted.current || current.current !== controller || controller.generation !== generation) return; controller.setInput(action); changed() }
  return { input: controller.input, setInput, snapshot: () => controller.snapshot(), clearExact: (snapshot: DraftSnapshot) => { if (!mounted.current || current.current !== controller || controller.generation !== generation) return false; const cleared = controller.clearExact(snapshot); changed(); return cleared }, ownerGeneration: controller.generation, error: controller.error }
}
