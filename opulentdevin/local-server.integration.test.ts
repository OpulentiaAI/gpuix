import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { LocalServerManager } from './local-server'

it.runIf(process.env.RUN_LOCAL_SERVER_INTEGRATION === '1')('boots and rebinds the real owned server on loopback with stable protected identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-owned-integration-'))
  const port = await new Promise<number>((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') { server.close(); reject(new Error('No port')); return }; server.close(error => error ? reject(error) : resolve(address.port)) }) })
  const manager = new LocalServerManager({ dataDir: directory, port })
  try {
    const initial = await manager.start()
    expect(manager.snapshot()).toMatchObject({ host: '127.0.0.1', auth: 'local', status: 'ready' })
    const changed = await manager.setLanEnabled(false, true)
    expect(changed.environmentId).toBe(initial.environmentId)
    expect(manager.snapshot()).toMatchObject({ host: '127.0.0.1', auth: 'protected', status: 'ready' })
    expect((await changed.backend.ping({})).message).toBe('pong')
  } finally { await manager.stop(); await rm(directory, { recursive: true, force: true }) }
}, 60000)
