import { constants, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync, mkdirSync, lstatSync, fstatSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve, parse } from 'node:path'
import { Schema } from 'effect'
import { EnvironmentId, FolderId, WorktreeId } from './zuse-runtime/packages/contracts/src/ids'
import { dataDirectory } from './preferences'

const ScopeSchema = Schema.Struct({ environmentId: EnvironmentId, folderId: FolderId, worktreeId: Schema.NullOr(WorktreeId) })
const BufferSchema = Schema.Struct({ path: Schema.String, content: Schema.String, saved: Schema.String, mtime: Schema.String })
const SnapshotSchema = Schema.Struct({ version: Schema.Literal(1), scope: ScopeSchema, revision: Schema.String, buffers: Schema.Array(BufferSchema) })
export type BufferScope = typeof ScopeSchema.Type
export type StoredFileBuffer = typeof BufferSchema.Type
const decode = Schema.decodeUnknownSync(SnapshotSchema, { onExcessProperty: 'error' })
const encode = Schema.encodeSync(SnapshotSchema)
const key = (scope: BufferScope) => JSON.stringify([scope.environmentId, scope.folderId, scope.worktreeId])
const maxBytes = 16 * 1024 * 1024
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT'
function privateDirectory(directory: string) {
  const absolute = resolve(directory)
  let path = parse(absolute).root
  for (const segment of absolute.slice(path.length).split('/').filter(Boolean)) {
    path = join(path, segment)
    try { const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Editor draft path must contain only real directories.') }
    catch (error) { if (!missing(error)) throw error; mkdirSync(path, { mode: 0o700 }) }
  }
  if ((lstatSync(absolute).mode & 0o077) !== 0) throw new Error('Editor draft directory must be private (0700).')
}
export class WorkbenchBufferStore {
  readonly directory: string
  constructor(directory = join(dataDirectory, 'editor-drafts')) { this.directory = resolve(directory) }
  path(scope: BufferScope) { return join(this.directory, createHash('sha256').update(key(scope)).digest('hex') + '.json') }
  read(scope: BufferScope) {
    privateDirectory(this.directory)
    let fd: number
    try { fd = openSync(this.path(scope), constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) { if (missing(error)) return { version: 1 as const, scope, revision: 'empty', buffers: [] as readonly StoredFileBuffer[] }; throw error }
    try {
      const info = fstatSync(fd)
      if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes || (info.mode & 0o777) !== 0o600) throw new Error('Editor draft file is oversized, unsafe or not private (0600).')
      const value = decode(JSON.parse(readFileSync(fd, 'utf8')))
      if (key(value.scope) !== key(scope)) throw new Error('Editor draft scope mismatch.')
      const paths = new Set<string>()
      for (const buffer of value.buffers) {
        if (!buffer.path || buffer.path.startsWith('/') || buffer.path.split('/').includes('..') || paths.has(buffer.path)) throw new Error('Editor draft contains invalid or duplicate paths.')
        paths.add(buffer.path)
      }
      return value
    } finally { closeSync(fd) }
  }
  save(scope: BufferScope, expectedRevision: string, buffers: readonly StoredFileBuffer[]) {
    privateDirectory(this.directory)
    const value = decode({ version: 1, scope, revision: randomUUID(), buffers: buffers.filter(buffer => buffer.content !== buffer.saved).map(({ path, content, saved, mtime }) => ({ path, content, saved, mtime })) })
    const bytes = JSON.stringify(encode(value))
    if (Buffer.byteLength(bytes) > maxBytes) throw new Error('Editor draft exceeds the 16 MiB safety limit; existing draft preserved.')
    const path = this.path(scope), lock = path + '.lock', temporary = path + '.' + randomUUID() + '.tmp'
    const lockFd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    let created = false
    try {
      if (this.read(scope).revision !== expectedRevision) throw new Error('Editor drafts changed in another window; reload before editing. Existing drafts preserved.')
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created = true
      try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(temporary, path); created = false
      const dir = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { fsyncSync(dir) } finally { closeSync(dir) }
      return value
    } finally { closeSync(lockFd); unlinkSync(lock); if (created) unlinkSync(temporary) }
  }
}
export function restoreFileBuffer(buffer: StoredFileBuffer, live: { content: string; mtime: string }) {
  return { ...buffer, conflict: buffer.mtime !== live.mtime || buffer.saved !== live.content }
}
