import { useEffect, useRef, useState } from 'react'
import { useGpuix } from '@gpuix/react'
import type { Backend } from './backend'
import { inspectQuit, type QuitSnapshot } from './host'
import { SettingsAction, SettingsCard, SettingsNote } from './settings-controls'
import { usePalette } from './theme-context'

export type NativeCloseRenderer = { setCloseGuard: (enabled: boolean) => void; resolveCloseRequest: (requestId: string, allow: boolean) => boolean }
export type NativeCloseRequest = { eventType: 'closeRequested'; elementId: 0; closeRequestId: string; windowGeneration: string }
export function parseNativeCloseRequest(value: unknown): NativeCloseRequest | null {
  if (!value || typeof value !== 'object' || !('eventType' in value) || value.eventType !== 'closeRequested' || !('elementId' in value) || value.elementId !== 0 || !('closeRequestId' in value) || typeof value.closeRequestId !== 'string' || !value.closeRequestId || !('windowGeneration' in value) || typeof value.windowGeneration !== 'string' || !value.windowGeneration) return null
  return { eventType: 'closeRequested', elementId: 0, closeRequestId: value.closeRequestId, windowGeneration: value.windowGeneration }
}
export function asNativeCloseRenderer(value: unknown): NativeCloseRenderer | null {
  if (!value || typeof value !== 'object' || !('setCloseGuard' in value) || typeof value.setCloseGuard !== 'function' || !('resolveCloseRequest' in value) || typeof value.resolveCloseRequest !== 'function') return null
  const setCloseGuard = value.setCloseGuard
  const resolveCloseRequest = value.resolveCloseRequest
  return { setCloseGuard: enabled => { setCloseGuard.call(value, enabled) }, resolveCloseRequest: (id, allow) => resolveCloseRequest.call(value, id, allow) === true }
}
export function createNativeCloseEvents() {
  let pending: NativeCloseRequest | null = null
  const listeners = new Set<(request: NativeCloseRequest) => void>()
  return {
    dispatch(event: unknown): boolean { const request = parseNativeCloseRequest(event); if (!request) return false; pending = request; for (const listener of listeners) listener(request); return true },
    subscribe(listener: (request: NativeCloseRequest) => void) { listeners.add(listener); if (pending) listener(pending); return () => { listeners.delete(listener) } },
    acknowledge(request: NativeCloseRequest) { if (pending?.closeRequestId === request.closeRequestId && pending.windowGeneration === request.windowGeneration) pending = null },
  }
}
export const nativeCloseEvents = createNativeCloseEvents()
export type NativeCloseState = { request: NativeCloseRequest; phase: 'checking' | 'confirm' | 'unknown' | 'cleaning' | 'error' | 'stale'; snapshot?: QuitSnapshot; message?: string } | null
export class NativeCloseController {
  private current: NativeCloseState = null
  private revision = 0
  private disposed = false
  private cleanupRunning = false
  private generation: string | null = null
  private retired = new Set<string>()
  private settled = new Set<string>()
  constructor(private readonly renderer: NativeCloseRenderer, private readonly backends: () => readonly Backend[], private readonly cleanup: () => Promise<void>, private readonly changed: (state: NativeCloseState) => void, private readonly inspect = inspectQuit, private readonly acknowledge: (request: NativeCloseRequest) => void = () => {}) {}
  get state() { return this.current }
  private publish(state: NativeCloseState) { this.current = state; if (!this.disposed) this.changed(state) }
  private key(request: NativeCloseRequest) { return JSON.stringify([request.windowGeneration, request.closeRequestId]) }
  receive(request: NativeCloseRequest) {
    if (this.disposed || this.retired.has(request.windowGeneration) || this.settled.has(this.key(request))) return
    if (this.current && this.key(this.current.request) === this.key(request)) return
    if (this.generation !== null && this.generation !== request.windowGeneration) this.retired.add(this.generation)
    this.generation = request.windowGeneration
    const revision = ++this.revision
    this.publish({ request, phase: 'checking' })
    void this.inspect(this.backends()).then(snapshot => { if (!this.disposed && revision === this.revision) this.publish({ request, phase: 'confirm', snapshot }) }, () => { if (!this.disposed && revision === this.revision) this.publish({ request, phase: 'unknown', message: 'Agent status could not be verified. The window remains open unless you explicitly confirm closure.' }) })
  }
  refreshBackends() {
    if (this.disposed || !this.current || this.cleanupRunning || this.current.phase === 'stale') return
    const request = this.current.request
    const revision = ++this.revision
    this.publish({ request, phase: 'checking' })
    void this.inspect(this.backends()).then(snapshot => { if (!this.disposed && revision === this.revision) this.publish({ request, phase: 'confirm', snapshot }) }, () => { if (!this.disposed && revision === this.revision) this.publish({ request, phase: 'unknown', message: 'Agent status could not be verified. Explicit confirmation is required.' }) })
  }
  deny(): boolean {
    if (this.disposed || !this.current || this.cleanupRunning) return false
    const request = this.current.request
    ++this.revision
    let accepted = false
    try { accepted = this.renderer.resolveCloseRequest(request.closeRequestId, false) } catch {}
    this.settled.add(this.key(request)); this.acknowledge(request)
    this.publish(accepted ? null : { request, phase: 'stale', message: 'This close request is no longer current. The window was not approved for closure.' })
    return accepted
  }
  async approve(explicitConfirmation: boolean): Promise<boolean> {
    if (!explicitConfirmation || this.disposed || !this.current || this.cleanupRunning || this.current.phase === 'checking' || this.current.phase === 'stale') return false
    const request = this.current.request
    const revision = this.revision
    this.cleanupRunning = true
    this.publish({ ...this.current, phase: 'cleaning' })
    try {
      await this.cleanup()
      if (this.disposed || revision !== this.revision || this.generation !== request.windowGeneration) return false
      const accepted = this.renderer.resolveCloseRequest(request.closeRequestId, true)
      this.settled.add(this.key(request)); this.acknowledge(request)
      this.publish(accepted ? null : { request, phase: 'stale', message: 'Cleanup completed, but the native request became stale. No replacement window was closed.' })
      return accepted
    } catch {
      if (!this.disposed && revision === this.revision) this.publish({ request, phase: 'error', message: 'Cleanup failed. Closure was not approved. Retry cleanup or keep this window open.' })
      return false
    } finally { this.cleanupRunning = false }
  }
  dispose() { if (this.disposed) return; const request = this.current?.request; this.disposed = true; ++this.revision; if (request) { try { this.renderer.resolveCloseRequest(request.closeRequestId, false) } catch {}; this.acknowledge(request) }; this.current = null }
}

export type NativeCloseGuardProps = { backends: readonly Backend[]; onCloseCleanup: () => Promise<void>; onError?: (error: unknown) => void; events?: ReturnType<typeof createNativeCloseEvents> }
export function NativeCloseGuard({ backends, onCloseCleanup, onError, events = nativeCloseEvents }: NativeCloseGuardProps) {
  const { renderer } = useGpuix()
  const palette = usePalette()
  const latest = useRef({ backends, onCloseCleanup, onError }); latest.current = { backends, onCloseCleanup, onError }
  const controller = useRef<NativeCloseController | null>(null)
  const [state, setState] = useState<NativeCloseState>(null)
  useEffect(() => {
    const native = asNativeCloseRenderer(renderer)
    if (!native) { latest.current.onError?.(new Error('Native close guarding is unavailable in the loaded renderer. OS close is not guarded.')); return }
    const owner = new NativeCloseController(native, () => latest.current.backends, () => latest.current.onCloseCleanup(), setState, inspectQuit, events.acknowledge)
    controller.current = owner
    const unsubscribe = events.subscribe(request => owner.receive(request))
    return () => { unsubscribe(); owner.dispose(); if (controller.current === owner) controller.current = null }
  }, [renderer, events])
  const observedBackends = useRef(backends)
  useEffect(() => {
    if (backends.length !== observedBackends.current.length || backends.some((backend, index) => backend !== observedBackends.current[index])) {
      observedBackends.current = backends
      controller.current?.refreshBackends()
    }
  })
  if (!state) return null
  return <div testId="native-close-confirmation" role="dialog" aria-label="Confirm native window close" style={{ display: 'flex', flexDirection: 'column', position: 'absolute', top: 50, left: 30, right: 30, padding: 18, backgroundColor: palette.page, borderWidth: 2, borderColor: palette.warning }}>
    <SettingsCard title="Close this window?">
      {state.phase === 'checking' && <SettingsNote>Checking running and booting agents in all supplied environments. No close has been approved.</SettingsNote>}
      {state.snapshot && <SettingsNote warning={state.snapshot.active > 0}>{state.snapshot.active} running or booting agents across {state.snapshot.environments} environments.</SettingsNote>}
      {state.message && <SettingsNote warning>{state.message}</SettingsNote>}
      <SettingsNote>Closing runs local cleanup and may terminate local agents or tunnels. It does not promise remote tasks stop. Native OS application quit remains a separate lifecycle boundary.</SettingsNote>
      <SettingsAction label="Keep window open" disabled={state.phase === 'cleaning'} onClick={() => { controller.current?.deny() }} />
      <SettingsAction label={state.phase === 'cleaning' ? 'Cleaning up before close…' : state.phase === 'unknown' ? 'Close despite unknown agent status' : 'Confirm cleanup and close'} disabled={state.phase === 'checking' || state.phase === 'cleaning' || state.phase === 'stale'} onClick={() => { void controller.current?.approve(true) }} />
    </SettingsCard>
  </div>
}
