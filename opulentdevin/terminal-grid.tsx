import { memo, useEffect, useRef, useState } from 'react'
import type { Backend, Subscription } from './backend'
import type { PtySummary } from './zuse-runtime/packages/contracts/src/pty'
import type { PtyOwnerId } from './zuse-runtime/packages/contracts/src/ids'
import type { Palette } from './theme'
import { TerminalState, terminalDimensions, type TerminalCell, type TerminalSnapshot } from './terminal-state'

export type TerminalGridProps = {
  backend: Backend
  terminal: PtySummary
  ownerId: PtyOwnerId
  palette: Palette
  onError: (error: unknown) => void
  onExit?: () => void
  cols?: number
  rows?: number
}
const cellWidth = 8
const cellHeight = 18
const GridRow = memo(function GridRow({ cells, cursorX, cursorColour }: { cells: TerminalCell[]; cursorX: number; cursorColour: string }) {
  return <div style={{ display: 'flex', flexDirection: 'row', height: cellHeight, flexShrink: 0 }}>{cells.map(cell => {
    const cursor = cursorX >= cell.x && cursorX < cell.x + cell.width
    return <div key={cell.x} style={{ display: 'flex', flexDirection: 'column', width: cell.width * cellWidth, height: cellHeight, flexShrink: 0, backgroundColor: cursor ? cursorColour : cell.background, overflow: 'hidden' }}><text style={{ fontFamily: 'monospace', fontSize: 13, lineHeight: cellHeight, whiteSpace: 'nowrap', color: cursor ? cell.background : cell.foreground, fontWeight: cell.bold ? 700 : 400, opacity: cell.dim ? 0.65 : 1, textDecoration: cell.underline ? 'underline' : cell.strike ? 'line-through' : 'none' }}>{cell.text}</text></div>
  })}</div>
})

export function TerminalGrid({ backend, terminal, ownerId, palette, onError, onExit, cols, rows }: TerminalGridProps) {
  const state = useRef<TerminalState | null>(null)
  const [snapshot, setSnapshot] = useState<TerminalSnapshot | null>(null)
  const [focused, setFocused] = useState(false)
  const [requestedCols, setRequestedCols] = useState(String(cols ?? terminal.cols))
  const [requestedRows, setRequestedRows] = useState(String(rows ?? terminal.rows))
  const [resizeBusy, setResizeBusy] = useState(false)
  const [error, setError] = useState('')
  const callbacks = useRef({ onError, onExit, palette })
  callbacks.current = { onError, onExit, palette }
  const resizeLock = useRef(false)
  useEffect(() => {
    let live = true
    let writes = Promise.resolve()
    let queuedBytes = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const report = (message: string) => { if (live) { setError(message); callbacks.current.onError(new Error(message)) } }
    const model = new TerminalState(terminal.cols, terminal.rows, terminal.processEpoch, data => {
      if (!live || terminal.status !== 'running') return
      if (queuedBytes + data.length > 65536) { report('Terminal input queue is full; wait for the backend to catch up.'); return }
      queuedBytes += data.length
      writes = writes.then(async () => { if (live) await backend.terminals.write({ ptyId: terminal.ptyId, ownerId, data }) }).catch(() => report('Terminal input could not be delivered; the failed input was not replayed.')).finally(() => { queuedBytes -= data.length })
    })
    state.current = model
    setError('')
    setRequestedCols(String(cols ?? terminal.cols)); setRequestedRows(String(rows ?? terminal.rows))
    const draw = () => { if (live) { const p = callbacks.current.palette; setSnapshot(model.snapshot({ foreground: p.text, background: p.page })) } }
    const unlisten = model.subscribe(() => { if (!timer) timer = setTimeout(() => { timer = undefined; draw() }, 16) })
    draw()
    let subscription: Subscription | null = null
    let gapRecoveries = 0
    const subscribe = (afterSequence: number, processEpoch: string) => {
      if (!live) return
      subscription = backend.subscribe(backend.terminals.output({ ptyId: terminal.ptyId, ownerId, processEpoch, afterSequence }), event => {
        void model.accept(event).then(() => {
          if (!live) return
          if (event._tag === 'gap') { subscription?.cancel(); if (++gapRecoveries <= 3) subscribe(event.earliestAvailable - 1, event.processEpoch); else report('Terminal history keeps advancing beyond replay. Reconnect after output settles.') }
          if (event._tag === 'exit') callbacks.current.onExit?.()
        }).catch(() => { subscription?.cancel(); report('Terminal replay exceeded its safe parser budget; reconnect to request fresh output.') })
      }, () => report('Terminal output stream disconnected. Select the terminal again to replay available output.'))
    }
    subscribe(0, terminal.processEpoch)
    return () => { live = false; subscription?.cancel(); unlisten(); if (timer) clearTimeout(timer); model.dispose(); if (state.current === model) state.current = null }
  }, [backend, terminal.ptyId, terminal.processEpoch, ownerId])
  useEffect(() => { const model = state.current; if (model) setSnapshot(model.snapshot({ foreground: palette.text, background: palette.page })) }, [palette])
  const resize = async (nextCols: number, nextRows: number) => {
    if (resizeLock.current || terminal.status !== 'running') return
    const model = state.current
    if (!model) return
    resizeLock.current = true; setResizeBusy(true)
    try {
      terminalDimensions(nextCols, nextRows)
      await backend.terminals.resize({ ptyId: terminal.ptyId, ownerId, cols: nextCols, rows: nextRows })
      if (state.current === model) { model.resize(nextCols, nextRows); setRequestedCols(String(nextCols)); setRequestedRows(String(nextRows)); setError('') }
    } catch { setError('Resize failed. Use 2–300 columns and 1–120 rows; confirm the PTY is running.'); onError(new Error('Terminal resize failed.')) }
    finally { resizeLock.current = false; setResizeBusy(false) }
  }
  useEffect(() => { if (cols !== undefined && rows !== undefined && state.current && (state.current.terminal.cols !== cols || state.current.terminal.rows !== rows)) void resize(cols, rows) }, [cols, rows, terminal.ptyId, terminal.processEpoch])
  return <div testId="terminal-grid-pane" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, minWidth: 0, backgroundColor: palette.page }}>
    <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: 6 }}>
      <text style={{ fontSize: 11, color: palette.muted }}>{snapshot?.alternate ? 'Alternate screen' : 'Terminal'} · {snapshot?.cols ?? terminal.cols} × {snapshot?.rows ?? terminal.rows} · {focused ? 'Raw keyboard input active' : 'Click the grid to type'}</text>
      <input testId="terminal-columns" aria-label="Terminal columns" value={requestedCols} onChange={event => setRequestedCols(event.value ?? '')} style={{ width: 52, height: 26, color: palette.text, backgroundColor: palette.elevated }} />
      <input testId="terminal-rows" aria-label="Terminal rows" value={requestedRows} onChange={event => setRequestedRows(event.value ?? '')} style={{ width: 45, height: 26, color: palette.text, backgroundColor: palette.elevated }} />
      <div testId="terminal-resize" role="button" aria-label="Resize terminal" tabIndex={0} onClick={() => { if (!resizeBusy) void resize(Number(requestedCols), Number(requestedRows)) }} style={{ display: 'flex', padding: 5, backgroundColor: palette.hover, cursor: 'pointer' }}><text style={{ fontSize: 11, color: palette.text }}>{resizeBusy ? 'Resizing…' : 'Resize'}</text></div>
      <div testId="terminal-interrupt" role="button" aria-label="Send Ctrl-C" tabIndex={0} onClick={() => state.current?.key({ key: 'c', modifiers: { ctrl: true, shift: false, alt: false, cmd: false } })} style={{ display: 'flex', padding: 5, backgroundColor: palette.hover, cursor: 'pointer' }}><text style={{ fontSize: 11, color: palette.text }}>Ctrl-C</text></div>
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, overflow: 'scroll', padding: 4 }}>
      <div testId="terminal-grid" role="textbox" aria-label="Interactive terminal grid" aria-description="Raw terminal keyboard input. Control C interrupts; arrows navigate the foreground application." tabIndex={0} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onKeyDown={event => state.current?.key(event)} onScroll={event => { if (!snapshot?.alternate && event.deltaY) state.current?.scroll(Math.trunc(event.deltaY / (event.precise ? cellHeight : 1))) }} style={{ display: 'flex', flexDirection: 'column', flexShrink: 0, width: (snapshot?.cols ?? terminal.cols) * cellWidth, height: (snapshot?.rows ?? terminal.rows) * cellHeight, backgroundColor: palette.page, borderWidth: 1, borderColor: focused ? palette.accent : palette.border }}>
        {snapshot?.lines.map((cells, y) => <GridRow key={y} cells={cells} cursorX={focused && snapshot.cursor.visible && snapshot.cursor.y === y ? snapshot.cursor.x : -1} cursorColour={palette.text} />)}
      </div>
    </div>
    {(error || snapshot?.notice) && <text style={{ color: palette.warning, fontSize: 11, padding: 6 }}>{error || snapshot?.notice}</text>}
  </div>
}
