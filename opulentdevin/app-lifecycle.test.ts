import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { draftMatchesCommand } from './drafts'
import { ComposerInput } from './zuse-runtime/packages/contracts/src/composer'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('./app.tsx', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('app.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function dispatchSource() {
  let result: ts.FunctionDeclaration | undefined
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'dispatch') result = node
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  if (!result) throw new Error('App dispatch function was not found')
  return ts.transpileModule(result.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
}
const input = (text: string) => ComposerInput.make({ text, attachments: [], fileRefs: [], skillRefs: [], annotations: [] })
function fixture(kind: 'chat.create' | 'messages.send' = 'chat.create') {
  let resolve!: (value: { initialSession: { id: string; projectId: string } }) => void
  const response = new Promise<{ initialSession: { id: string; projectId: string } }>(done => { resolve = done })
  const backend = { chats: { create: vi.fn(() => response) }, messages: { send: vi.fn(() => response) } }
  const submittedInput = input('Original')
  const submittedDraft = { owner: { environmentId: 'env-a', workspaceId: 'folder-a', sessionId: kind === 'messages.send' ? 'session-a' : null }, input: submittedInput, generation: 'generation-a', revision: 'revision-a' }
  const scope = {
    draftMatchesCommand, backend, environmentId: 'env-a', sending: { current: false }, setBusy: vi.fn(), setError: vi.fn(),
    latestInput: { current: submittedInput }, composerDraft: { snapshot: vi.fn(() => submittedDraft), clearExact: vi.fn(() => true) },
    selectionEpoch: { current: 0 }, folder: { id: 'folder-a' }, liveFolder: { current: 'folder-a' }, liveBackend: { current: backend },
    setSession: vi.fn(), outbox: { ack: vi.fn(), pending: vi.fn(() => []) }, setPending: vi.fn(), report: vi.fn(),
  }
  scope.setSession.mockImplementation(() => { scope.selectionEpoch.current++ })
  const dispatch = new Function(...Object.keys(scope), `${dispatchSource()}; return dispatch`)(...Object.values(scope)) as (entry: unknown) => Promise<void>
  const payload = kind === 'messages.send' ? { sessionId: 'session-a', input: submittedInput } : { projectId: 'folder-a', startupInput: submittedInput, initialPrompt: submittedInput.text }
  const entry = { command: { kind, commandId: 'command-a', payload }, fingerprint: 'fingerprint-a' }
  return { scope, submittedDraft, entry, dispatch, resolve: () => resolve({ initialSession: { id: 'created-a', projectId: 'folder-a' } }) }
}

describe('App deferred command lifecycle', () => {
  it('acknowledges and clears the exact submitted draft after selecting the created session', async () => {
    const f = fixture()
    const done = f.dispatch(f.entry)
    f.resolve(); await done
    expect(f.scope.setSession).toHaveBeenCalledWith({ id: 'created-a', projectId: 'folder-a' })
    expect(f.scope.outbox.ack).toHaveBeenCalledWith('command-a', 'fingerprint-a')
    expect(f.scope.composerDraft.clearExact).toHaveBeenCalledWith(f.submittedDraft)
    expect(f.scope.report).not.toHaveBeenCalled()
  })
  it('does not override a manual session selection while creation is pending', async () => {
    const f = fixture()
    const done = f.dispatch(f.entry)
    f.scope.selectionEpoch.current++
    f.scope.latestInput.current = input('Another session draft')
    f.resolve(); await done
    expect(f.scope.setSession).not.toHaveBeenCalled()
    expect(f.scope.composerDraft.clearExact).not.toHaveBeenCalled()
    expect(f.scope.outbox.ack).toHaveBeenCalledOnce()
  })
  it('does not select or clear after a workspace change but still acknowledges success', async () => {
    const f = fixture()
    const done = f.dispatch(f.entry)
    f.scope.liveFolder.current = 'folder-b'
    f.resolve(); await done
    expect(f.scope.setSession).not.toHaveBeenCalled()
    expect(f.scope.composerDraft.clearExact).not.toHaveBeenCalled()
    expect(f.scope.outbox.ack).toHaveBeenCalledOnce()
  })
  it('does not select workspace A when retrying its saved create while already in workspace B', async () => {
    const f = fixture()
    f.scope.folder.id = 'folder-b'
    f.scope.liveFolder.current = 'folder-b'
    f.submittedDraft.owner.workspaceId = 'folder-b'
    f.submittedDraft.input = input('Workspace B unsent work')
    f.scope.latestInput.current = f.submittedDraft.input
    const done = f.dispatch(f.entry)
    f.resolve(); await done
    expect(f.scope.backend.chats.create).toHaveBeenCalledWith(f.entry.command.payload)
    expect(f.scope.setSession).not.toHaveBeenCalled()
    expect(f.scope.composerDraft.clearExact).not.toHaveBeenCalled()
    expect(f.scope.outbox.ack).toHaveBeenCalledWith('command-a', 'fingerprint-a')
    expect(f.scope.report).not.toHaveBeenCalled()
  })
  it('does not select or clear after backend replacement but still acknowledges success', async () => {
    const f = fixture()
    const done = f.dispatch(f.entry)
    f.scope.liveBackend.current = { ...f.scope.backend }
    f.resolve(); await done
    expect(f.scope.setSession).not.toHaveBeenCalled()
    expect(f.scope.composerDraft.clearExact).not.toHaveBeenCalled()
    expect(f.scope.outbox.ack).toHaveBeenCalledOnce()
  })
  it('does not clear newer input typed while the original send is pending', async () => {
    const f = fixture('messages.send')
    const done = f.dispatch(f.entry)
    f.scope.latestInput.current = input('Newer unsent work')
    f.resolve(); await done
    expect(f.scope.composerDraft.clearExact).not.toHaveBeenCalled()
    expect(f.scope.outbox.ack).toHaveBeenCalledOnce()
  })
  it('does not clear a different draft that was already present when retrying a saved command', async () => {
    const f = fixture('messages.send')
    const different = input('Unrelated draft composed after the unknown outcome')
    f.scope.latestInput.current = different
    f.submittedDraft.input = different
    const done = f.dispatch(f.entry)
    f.resolve(); await done
    expect(f.scope.composerDraft.clearExact).not.toHaveBeenCalled()
    expect(f.scope.outbox.ack).toHaveBeenCalledOnce()
  })
})
