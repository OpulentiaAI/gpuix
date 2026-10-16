import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'
import { readFileSync } from 'node:fs'
import type { Backend } from './backend'
import type { CloudWorkspaceConnection } from './zuse-runtime/packages/contracts/src/cloud-workspaces'
import { cloudConnectionOptions, openCloudBackend, verifiedEnvironment } from './settings-connection'

const connect = vi.hoisted(() => vi.fn())
vi.mock('./backend', () => ({ connectBackend: connect }))
const ticket: CloudWorkspaceConnection = { workspaceId: 'workspace-one', wsUrl: 'wss://gateway.example.test/rpc/workspace-one', protocol: 'zuse.v1', role: 'client', generation: 1, gatewayEpoch: 1, credential: 'test-only-ticket', expiresAt: 9999999999999 }
function fakeBackend(environmentId = 'verified-environment') {
  const describe = vi.fn(() => Effect.succeed({ environmentId }))
  const mint = vi.fn(() => Effect.succeed(ticket))
  const dispose = vi.fn(async () => {})
  const backend = { client: { 'connect.describe': describe, 'cloud.workspaces.connect': mint }, run: Effect.runPromise, dispose } as unknown as Backend
  return { backend, describe, mint, dispose }
}
beforeEach(() => connect.mockReset())
describe('verified remote environment handoff', () => {
  it('uses ticket subprotocols without putting credentials in the URL', () => { const options = cloudConnectionOptions(ticket, 'workspace-one', 1); expect(options.protocols).toEqual(['zuse.v1', 'test-only-ticket']); expect(options.wsBaseUrl).toBe(ticket.wsUrl); expect(options.token).toBeUndefined() })
  it('rejects mismatched, expired and insecure tickets', () => { expect(() => cloudConnectionOptions(ticket, 'other')).toThrow(); expect(() => cloudConnectionOptions({ ...ticket, expiresAt: 1 }, 'workspace-one', 2)).toThrow(); for (const wsUrl of ['ws://gateway.example.test', 'wss://user:secret@gateway.example.test', 'wss://gateway.example.test?token=secret']) expect(() => cloudConnectionOptions({ ...ticket, wsUrl }, 'workspace-one')).toThrow() })
  it('returns descriptor identity rather than the endpoint or workspace label', async () => { const remote = fakeBackend(); const result = await verifiedEnvironment(remote.backend, new AbortController().signal); expect(result).toEqual({ backend: remote.backend, environmentId: 'verified-environment' }); expect(remote.dispose).not.toHaveBeenCalled() })
  it('disposes the candidate on identity mismatch or cancellation', async () => { const remote = fakeBackend(); await expect(verifiedEnvironment(remote.backend, new AbortController().signal, 'wrong')).rejects.toThrow(); expect(remote.dispose).toHaveBeenCalledTimes(1); const controller = new AbortController(); controller.abort(); const cancelled = fakeBackend(); await expect(verifiedEnvironment(cancelled.backend, controller.signal)).rejects.toThrow(); expect(cancelled.describe).not.toHaveBeenCalled(); expect(cancelled.dispose).toHaveBeenCalledOnce() })
  it('only mints an explicit connection ticket and verifies its runtime, without resume/provision', async () => { const control = fakeBackend(); const remote = fakeBackend('cloud-runtime-id'); connect.mockResolvedValue(remote.backend); const result = await openCloudBackend(control.backend, 'workspace-one', new AbortController().signal); expect(control.mint).toHaveBeenCalledWith({ workspaceId: 'workspace-one' }); expect(connect).toHaveBeenCalledOnce(); expect(result.environmentId).toBe('cloud-runtime-id'); expect(control.dispose).not.toHaveBeenCalled() })
  it('suppresses credential-bearing transport errors and cleans up failed verification', async () => { const control = fakeBackend(); connect.mockRejectedValue(new Error('test-only-ticket')); await expect(openCloudBackend(control.backend, 'workspace-one', new AbortController().signal)).rejects.toThrow('Cloud connection failed'); const remote = fakeBackend(''); connect.mockResolvedValue(remote.backend); await expect(openCloudBackend(control.backend, 'workspace-one', new AbortController().signal)).rejects.toThrow('Cloud connection failed'); expect(remote.dispose).toHaveBeenCalledOnce() })
  it('SSH handoff carries the same descriptor identity used by the persisted profile', () => { const source = readFileSync(new URL('./settings-host.ts', import.meta.url), 'utf8'); expect(source).toContain('return { backend: owned, environmentId: descriptor.environmentId }'); const panel = readFileSync(new URL('./settings-host-panel.tsx', import.meta.url), 'utf8'); expect(panel).toContain('onConnect(remote.backend, remote.environmentId)') })
})
