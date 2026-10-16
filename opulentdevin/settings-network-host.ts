import { networkInterfaces } from 'node:os'
import type { Backend } from './backend'
import type { AuthTokenSummary, NearbyPairingRequest, PairingStartResult } from './zuse-runtime/packages/contracts/src/pairing'
import type { DeviceBridgeStatus, DeviceCommandDecision } from './zuse-runtime/packages/contracts/src/device-bridge'
import type { SshMode } from './zuse-runtime/packages/contracts/src/machines'
import { parseTailnetStatus, runTailnetCommand } from './zuse-runtime/packages/tailnet/src/index'
import { readNamedCredential } from './settings-safe'

export const networkRestrictions = {
  lan: 'LAN sharing is unavailable here: the desktop host owns the listener, preference and restart. This RPC connection does not identify an owned local server; changing a preference alone would not enable access.',
  tailnet: 'Local Tailscale sharing needs the owned backend port, Serve ownership/conflict handling and lifecycle. Local status below is not the connected backend’s status.',
  profiles: 'Saved tailnet profiles require the desktop keytar credential store and authenticated environment lifecycle, which this native host does not own.',
  voice: 'Native microphone capture is unavailable: GPUIX exposes no microphone permission, audio-device capture or recording/encoding bridge. Transcription RPC support does not supply recorded audio. No microphone is started.',
} as const

export function inspectLocalNetwork(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()) {
  return Object.entries(interfaces).flatMap(([name, entries]) => (entries ?? [])
    .filter(entry => !entry.internal && (entry.family === 'IPv4' || entry.family === 'IPv6'))
    .map(entry => ({ name, address: entry.address, family: entry.family })))
}
export type LocalInterface = ReturnType<typeof inspectLocalNetwork>[number]

export async function inspectLocalTailnet(runner = runTailnetCommand) {
  const result = await runner(['status', '--json'], 5000)
  if (result.code !== 0 || result.timedOut) throw new Error('Local Tailscale status is unavailable; install/sign in to Tailscale and check daemon permissions.')
  try { return parseTailnetStatus(result.stdout) }
  catch { throw new Error('Local Tailscale returned an invalid status response.') }
}
export type LocalTailnet = Awaited<ReturnType<typeof inspectLocalTailnet>>

export function pairingDisplay(pairing: Pick<PairingStartResult, 'code' | 'expiresAt'>, now = Date.now()) {
  const expired = !Number.isFinite(pairing.expiresAt.getTime()) || pairing.expiresAt.getTime() <= now
  return { expired, code: expired ? null : pairing.code }
}
export function requireNetworkConfirmation(confirmed: boolean) {
  if (!confirmed) throw new Error('Explicit confirmation is required.')
}

export function createNetworkActions(backend: Pick<Backend, 'client' | 'run'>) {
  return {
    tokens: () => backend.run(backend.client['pairing.listTokens']({})),
    nearby: () => backend.run(backend.client['pairing.listNearbyRequests']({})),
    bridge: async (): Promise<DeviceBridgeStatus> => {
      const status = await backend.run(backend.client['deviceBridge.control']({ _tag: 'status' }))
      if (!('version' in status)) throw new Error('Device bridge returned a command instead of status.')
      return status
    },
    privateNetwork: () => backend.run(backend.client['machine.privateNetwork.status']()),
    startPairing: (confirmed: boolean) => { requireNetworkConfirmation(confirmed); return backend.run(backend.client['pairing.start']({})) },
    revokeToken: (tokenId: AuthTokenSummary['id'], confirmed: boolean) => { requireNetworkConfirmation(confirmed); return backend.run(backend.client['pairing.revokeToken']({ tokenId })) },
    resolveNearby: (request: NearbyPairingRequest, decision: 'allow' | 'deny' | 'block', confirmed: boolean) => {
      requireNetworkConfirmation(confirmed)
      if (!Number.isFinite(request.expiresAt.getTime()) || request.expiresAt.getTime() <= Date.now()) throw new Error('Pairing request expired. Refresh the request list.')
      return backend.run(backend.client['pairing.resolveNearbyRequest']({ requestId: request.requestId, decision }))
    },
    decideCommand: (id: string, decision: DeviceCommandDecision, confirmed: boolean) => { requireNetworkConfirmation(confirmed); return backend.run(backend.client['deviceBridge.control']({ _tag: 'decide', id, decision })) },
    revokeGrant: (id: string, confirmed: boolean) => { requireNetworkConfirmation(confirmed); return backend.run(backend.client['deviceBridge.control']({ _tag: 'revoke', id })) },
    enablePrivateNetwork: (variable: string, sshMode: SshMode, confirmed: boolean) => {
      requireNetworkConfirmation(confirmed)
      return backend.run(backend.client['machine.privateNetwork.enable']({ authKey: readNamedCredential(variable), sshMode }))
    },
    setSshMode: (mode: SshMode, confirmed: boolean) => { requireNetworkConfirmation(confirmed); return backend.run(backend.client['machine.sshMode.set']({ mode })) },
    voiceCapabilities: () => backend.run(backend.client['voice.capabilities']({})),
  }
}
