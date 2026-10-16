import { createTerminalInputPump } from './zuse-runtime/packages/client-runtime/src/terminal-input-pump'

export const TERMINAL_INPUT_BLOCKED = 'Terminal input is blocked after an uncertain write or interrupted input sequence. No queued bytes were replayed. Close this terminal and start a new process to recover.'
const blockedProcesses = new Set<string>()
export type TerminalInputIdentity = { ownerId: string; ptyId: string; processEpoch: string }

export function createTerminalInput(identity: TerminalInputIdentity, write: (data: string) => Promise<void>, onBlocked: (message: string) => void) {
  const key = JSON.stringify([identity.ownerId, identity.ptyId, identity.processEpoch])
  let inFlight = false
  let disposed = false
  const block = () => {
    const newlyBlocked = !blockedProcesses.has(key)
    blockedProcesses.add(key)
    if (newlyBlocked && !disposed) onBlocked(TERMINAL_INPUT_BLOCKED)
  }
  const pump = createTerminalInputPump({
    maxQueuedCharacters: 65536,
    write: async data => {
      if (blockedProcesses.has(key) || disposed) throw new Error(TERMINAL_INPUT_BLOCKED)
      inFlight = true
      try { await write(data) }
      catch (error) { block(); throw error }
      finally { inFlight = false }
    },
    onFailure: block,
  })
  return {
    get failed() { return blockedProcesses.has(key) },
    enqueue(data: string) {
      if (disposed) return
      if (blockedProcesses.has(key)) { onBlocked(TERMINAL_INPUT_BLOCKED); return }
      pump.enqueue(data)
    },
    whenIdle: () => pump.whenIdle(),
    dispose() {
      if (inFlight) block()
      disposed = true
      pump.dispose()
    },
  }
}
