import { Effect } from 'effect'
import { connectBackend, type Backend, type BackendOptions } from './backend'
import type { CloudWorkspaceConnection } from './zuse-runtime/packages/contracts/src/cloud-workspaces'

export type ConnectedEnvironment = { backend: Backend; environmentId: string }
export function cloudConnectionOptions(ticket: CloudWorkspaceConnection, workspaceId: string, now = Date.now()): BackendOptions {
  if (ticket.workspaceId !== workspaceId || ticket.role !== 'client' || !Number.isFinite(ticket.expiresAt) || ticket.expiresAt <= now) throw new Error('Cloud connection ticket is invalid, expired or belongs to another workspace.')
  const endpoint = new URL(ticket.wsUrl)
  if (endpoint.protocol !== 'wss:' || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) throw new Error('Cloud gateway must use a credential-free secure WebSocket endpoint.')
  const protocolToken = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
  if (!protocolToken.test(ticket.protocol) || !protocolToken.test(ticket.credential)) throw new Error('Cloud connection protocols are invalid.')
  return { host: endpoint.hostname, port: Number(endpoint.port || 443), wsBaseUrl: endpoint.href, protocols: [ticket.protocol, ticket.credential] }
}
export async function verifiedEnvironment(backend: Backend, signal: AbortSignal, expectedEnvironmentId?: string): Promise<ConnectedEnvironment> {
  try {
    if (signal.aborted) throw new Error('Connection cancelled')
    const descriptor = await backend.run(backend.client['connect.describe']().pipe(Effect.timeout(15000)))
    if (!descriptor.environmentId.trim() || (expectedEnvironmentId !== undefined && descriptor.environmentId !== expectedEnvironmentId)) throw new Error('Remote environment identity is invalid or changed')
    if (signal.aborted) throw new Error('Connection cancelled')
    return { backend, environmentId: descriptor.environmentId }
  } catch {
    await backend.dispose().catch(() => {})
    throw new Error('Remote environment could not be verified or connection was cancelled.')
  }
}
export async function openCloudBackend(control: Backend, workspaceId: string, signal: AbortSignal): Promise<ConnectedEnvironment> {
  if (signal.aborted) throw new Error('Connection cancelled')
  try {
    const ticket = await control.run(control.client['cloud.workspaces.connect']({ workspaceId }).pipe(Effect.timeout(15000)))
    const options = cloudConnectionOptions(ticket, workspaceId)
    if (signal.aborted) throw new Error('Connection cancelled')
    const backend = await connectBackend(options)
    return await verifiedEnvironment(backend, signal)
  } catch { throw new Error('Cloud connection failed. Verify account access and runtime readiness, then reconnect explicitly. No workspace was provisioned or resumed.') }
}
