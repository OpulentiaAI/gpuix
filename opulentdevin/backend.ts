import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { resolveZuseRoot, verifyZuse } from './bootstrap-zuse.ts'
import { Effect, Stream } from 'effect'
import { makeRpcClientSession } from './zuse-runtime/packages/client-runtime/src/connection.ts'
import { wsClientProtocolLayer, type WsProtocolOptions } from './zuse-runtime/packages/client-runtime/src/ws-protocol.ts'
import { MemoizeRpcs } from './zuse-runtime/packages/contracts/src/rpc.ts'
import { WIRE_PROTOCOL_VERSION } from './zuse-runtime/packages/contracts/src/handshake.ts'

export * as ids from './zuse-runtime/packages/contracts/src/ids.ts'
export { SessionId } from './zuse-runtime/packages/contracts/src/session.ts'
export { emptySessionTimelineState, reduceSessionTimelineFrame, prependSessionTimelineMessages, type SessionTimelineState } from './zuse-runtime/packages/client-runtime/src/session-timeline.ts'

export { ZUSE_REVISION } from './bootstrap-zuse.ts'
export type BackendOptions = WsProtocolOptions & { timeoutMs?: number; protocols?: readonly string[] }
export type Subscription = { done: Promise<void>; cancel: () => void }

function promised<Args extends readonly unknown[], Value, Error>(fn: (...args: Args) => Effect.Effect<Value, Error>) {
  return (...args: Args): Promise<Value> => Effect.runPromise(fn(...args))
}

export async function connectBackend(options: BackendOptions) {
  const timeoutMs = options.timeoutMs ?? 10000
  const session = await makeRpcClientSession(
    wsClientProtocolLayer(options, { openTimeout: timeoutMs, protocols: options.protocols }),
    MemoizeRpcs,
    {
      protocolVersion: WIRE_PROTOCOL_VERSION,
      perform: (client, hello) => client['connect.handshake'](hello).pipe(Effect.timeout(timeoutMs)),
    },
  )
  const client = session.client
  const controllers = new Set<AbortController>()
  let disposed = false
  const subscribe = <Value, Error>(stream: Stream.Stream<Value, Error>, onValue: (value: Value) => void, onError: (error: unknown) => void): Subscription => {
    if (disposed) throw new Error('Backend connection is disposed')
    const controller = new AbortController()
    controllers.add(controller)
    const done = Effect.runPromise(Stream.runForEach(stream, value => Effect.sync(() => onValue(value))), { signal: controller.signal })
      .catch(error => { if (!controller.signal.aborted) onError(error) })
      .finally(() => { controllers.delete(controller) })
    return { done, cancel: () => controller.abort() }
  }
  return {
    client,
    run: <Value, Error>(effect: Effect.Effect<Value, Error>) => Effect.runPromise(effect),
    subscribe,
    dispose: async () => {
      if (disposed) return
      disposed = true
      for (const controller of controllers) controller.abort()
      controllers.clear()
      await session.dispose()
    },
    ping: promised(client['ping.ping']),
    workspaces: {
      list: promised(client['workspace.list']),
      add: promised(client['workspace.add']),
      remove: promised(client['workspace.remove']),
      browse: promised(client['workspace.browseDirectory']),
      create: promised(client['workspace.createProject']),
      clone: promised(client['workspace.cloneRepo']),
      changes: client['workspace.streamChanges'],
    },
    chats: {
      list: promised(client['chat.list']),
      create: promised(client['chat.create']),
      rename: promised(client['chat.rename']),
      delete: promised(client['chat.delete']),
      archive: promised(client['chat.archive']),
      changes: client['chat.streamChanges'],
    },
    sessions: {
      list: promised(client['session.list']),
      get: promised(client['session.get']),
      create: promised(client['session.create']),
      rename: promised(client['session.rename']),
      delete: promised(client['session.delete']),
      resume: promised(client['session.resume']),
      setModel: promised(client['session.setModel']),
      setRuntimeMode: promised(client['session.setRuntimeMode']),
      setPermissionMode: promised(client['session.setPermissionMode']),
      changes: client['session.streamChanges'],
      events: client['session.events'],
      messagesPage: promised(client['session.messages.page']),
      answerQuestion: promised(client['session.answerQuestion']),
      respondToPlan: promised(client['session.plan.respond']),
    },
    messages: {
      list: promised(client['messages.list']),
      send: promised(client['messages.send']),
      interrupt: promised(client['messages.interrupt']),
      queue: promised(client['messages.queue.list']),
    },
    permissions: {
      pending: promised(client['permission.listPending']),
      decide: promised(client['permission.decide']),
      requests: client['permission.requests'],
    },
    providers: {
      list: promised(client['provider.availability']),
      setCredential: promised(client['provider.setCredential']),
      removeCredential: promised(client['provider.removeCredential']),
      login: client['provider.startLogin'],
      update: client['provider.update'],
    },
    files: {
      tree: promised(client['fs.tree']),
      read: promised(client['fs.readFile']),
      write: promised(client['fs.writeFile']),
      create: promised(client['fs.createFile']),
      mkdir: promised(client['fs.createDirectory']),
      remove: promised(client['fs.remove']),
      move: promised(client['fs.move']),
      watch: client['fs.watchTree'],
    },
    terminals: {
      open: promised(client['pty.open']),
      list: promised(client['pty.list']),
      write: promised(client['pty.write']),
      resize: promised(client['pty.resize']),
      close: promised(client['pty.close']),
      restart: promised(client['pty.restart']),
      output: client['pty.output'],
    },
    git: {
      status: promised(client['git.status']),
      branches: promised(client['git.branches']),
      log: promised(client['git.log']),
      changes: client['git.workspaceChanges'],
    },
    settings: {
      get: promised(client['settings.get']),
      update: promised(client['settings.update']),
      changes: client['settings.stream'],
    },
  }
}

export type Backend = Awaited<ReturnType<typeof connectBackend>>

export function startLocalBackend(options: { dataDir: string; port: number; executable?: string; onOutput?: (text: string) => void }): ChildProcess {
  const root = verifyZuse(resolveZuseRoot(import.meta.url))
  const entry = join(root, 'apps/server/src/bin.ts')
  const loader = join(root, 'apps/server/node_modules/tsx/dist/loader.mjs')
  const child = spawn(options.executable ?? 'node', ['--import', loader, entry, 'serve', '--host', '127.0.0.1', '--port', String(options.port), '--data-dir', options.dataDir, '--auth', 'local', '--no-pairing'], {
    cwd: root,
    env: { ...process.env, ZUSE_ENABLE_PAIRING: '0', ZUSE_CONFIG_DIR: join(options.dataDir, 'config') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', chunk => options.onOutput?.(String(chunk)))
  child.stderr?.on('data', chunk => options.onOutput?.(String(chunk)))
  return child
}
