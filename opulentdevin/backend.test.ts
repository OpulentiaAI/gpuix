import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { connectBackend, startLocalBackend, ids, type Backend } from './backend.ts'

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('real Zuse backend', () => {
  it('connects, persists workspaces, reads and writes files, and streams real PTY output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opulentdevin-backend-'))
    const project = join(root, 'project')
    await mkdir(project)
    await writeFile(join(project, 'sample.txt'), 'before\n')
    let logs = ''
    let child = startLocalBackend({ dataDir: join(root, 'data'), port: 47691, onOutput: text => { logs += text } })
    let backend: Backend | undefined
    try {
      for (let attempt = 0; attempt < 50; attempt++) {
        if (child.exitCode !== null) throw new Error(`Server exited: ${logs}`)
        try { backend = await connectBackend({ host: '127.0.0.1', port: 47691, timeoutMs: 500 }); break } catch { await pause(200) }
      }
      if (!backend) throw new Error(`Server not ready: ${logs}`)
      expect((await backend.ping({})).message).toBe('pong')
      const folder = await backend.workspaces.add({ path: project })
      expect((await backend.workspaces.list({})).some(item => item.id === folder.id)).toBe(true)
      expect(await backend.sessions.list({ projectId: folder.id })).toEqual([])
      const content = await backend.files.read({ folderId: folder.id, path: 'sample.txt' })
      if (content.kind !== 'text') throw new Error('Expected text fixture')
      await backend.files.write({ commandId: ids.CommandId.make(crypto.randomUUID()), folderId: folder.id, path: 'sample.txt', content: 'after\n', expectedMtime: content.mtime })
      expect(await readFile(join(project, 'sample.txt'), 'utf8')).toBe('after\n')
      await expect(backend.files.write({ commandId: ids.CommandId.make(crypto.randomUUID()), folderId: folder.id, path: 'sample.txt', content: 'stale\n', expectedMtime: '0' })).rejects.toThrow()
      expect(await readFile(join(project, 'sample.txt'), 'utf8')).toBe('after\n')
      await expect(backend.files.read({ folderId: folder.id, path: '../outside.txt' })).rejects.toThrow()
      const providers = await backend.providers.list({})
      expect(providers.length).toBeGreaterThan(0)
      const terminal = await backend.terminals.open({ cwd: project, cols: 80, rows: 24 })
      let output = ''
      const stream = backend.subscribe(backend.terminals.output({ ptyId: terminal.ptyId }), event => {
        output += JSON.stringify(event)
      }, error => { throw error })
      await backend.terminals.write({ ptyId: terminal.ptyId, data: "printf 'native-%s-proof\\n' backend\r" })
      for (let attempt = 0; attempt < 40 && !output.includes('native-backend-proof'); attempt++) await pause(100)
      expect(output).toContain('native-backend-proof')
      stream.cancel()
      await stream.done
      await backend.terminals.close({ ptyId: terminal.ptyId })
      await backend.dispose()
      child.kill('SIGTERM')
      await once(child, 'exit')
      child = startLocalBackend({ dataDir: join(root, 'data'), port: 47691, onOutput: text => { logs += text } })
      backend = undefined
      for (let attempt = 0; attempt < 50; attempt++) {
        if (child.exitCode !== null) throw new Error(`Restart exited: ${logs}`)
        try { backend = await connectBackend({ host: '127.0.0.1', port: 47691, timeoutMs: 500 }); break } catch { await pause(200) }
      }
      if (!backend) throw new Error(`Restart not ready: ${logs}`)
      expect((await backend.workspaces.list({})).some(item => item.id === folder.id)).toBe(true)
      await backend.workspaces.remove({ folderId: folder.id })
    } finally {
      await backend?.dispose()
      if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit') }
      await rm(root, { recursive: true, force: true })
    }
  }, 60000)
})
