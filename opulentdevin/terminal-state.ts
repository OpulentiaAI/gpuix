import { Terminal, type IBufferCell } from '@xterm/headless'
import type { EventPayload } from '@gpuix/native'
import type { PtyEvent } from './zuse-runtime/packages/contracts/src/pty'

export type TerminalCell = { x: number; text: string; width: number; foreground: string; background: string; bold: boolean; dim: boolean; underline: boolean; strike: boolean }
export type TerminalSnapshot = { cols: number; rows: number; lines: TerminalCell[][]; cursor: { x: number; y: number; visible: boolean }; alternate: boolean; viewportY: number; baseY: number; notice: string; exited: boolean }
export type TerminalTheme = { foreground: string; background: string }
const ansi = ['#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5', '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff']
export function ansiColour(index: number): string {
  if (index < 16) return ansi[index] ?? ansi[7]!
  if (index > 231) { const level = 8 + (index - 232) * 10; return `#${level.toString(16).padStart(2, '0').repeat(3)}` }
  const cube = index - 16
  const channel = (value: number) => (value === 0 ? 0 : 55 + value * 40).toString(16).padStart(2, '0')
  return `#${channel(Math.floor(cube / 36))}${channel(Math.floor(cube / 6) % 6)}${channel(cube % 6)}`
}
function colour(cell: IBufferCell, foreground: boolean, fallback: string) {
  if (foreground ? cell.isFgDefault() : cell.isBgDefault()) return fallback
  const value = foreground ? cell.getFgColor() : cell.getBgColor()
  return (foreground ? cell.isFgRGB() : cell.isBgRGB()) ? `#${value.toString(16).padStart(6, '0')}` : ansiColour(value)
}
export function terminalDimensions(cols: number, rows: number) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1 || cols > 300 || rows > 120) throw new Error('Native terminal size must be 2–300 columns and 1–120 rows.')
  return { cols, rows }
}
export function terminalKey(event: Pick<EventPayload, 'key' | 'keyChar' | 'modifiers'>, applicationCursor = false): string | null {
  const key = (event.key ?? '').toLowerCase()
  const { ctrl = false, shift = false, alt = false, cmd = false } = event.modifiers ?? {}
  if (cmd) return null
  const modifier = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0)
  const arrows: Record<string, string> = { up: 'A', arrowup: 'A', down: 'B', arrowdown: 'B', right: 'C', arrowright: 'C', left: 'D', arrowleft: 'D', home: 'H', end: 'F' }
  if (arrows[key]) return modifier > 1 ? `\x1b[1;${modifier}${arrows[key]}` : `\x1b${applicationCursor ? 'O' : '['}${arrows[key]}`
  const tilde: Record<string, number> = { insert: 2, delete: 3, pageup: 5, pagedown: 6, 'page-up': 5, 'page-down': 6, f5: 15, f6: 17, f7: 18, f8: 19, f9: 20, f10: 21, f11: 23, f12: 24 }
  if (tilde[key]) return `\x1b[${tilde[key]}${modifier > 1 ? `;${modifier}` : ''}~`
  if (/^f[1-4]$/.test(key)) return modifier > 1 ? `\x1b[1;${modifier}${String.fromCharCode(79 + Number(key.slice(1)))}` : `\x1bO${String.fromCharCode(79 + Number(key.slice(1)))}`
  if (key === 'tab') return shift ? '\x1b[Z' : '\t'
  if (key === 'enter' || key === 'return') return alt ? '\x1b\r' : '\r'
  if (key === 'escape' || key === 'esc') return '\x1b'
  if (key === 'backspace') return `${alt ? '\x1b' : ''}${ctrl ? '\b' : '\x7f'}`
  if (ctrl) {
    const controls: Record<string, string> = { ' ': '\0', space: '\0', '@': '\0', '[': '\x1b', '\\': '\x1c', ']': '\x1d', '^': '\x1e', '_': '\x1f', '?': '\x7f' }
    const control = key.length === 1 && key >= 'a' && key <= 'z' ? String.fromCharCode(key.charCodeAt(0) - 96) : controls[key]
    return control === undefined ? null : `${alt ? '\x1b' : ''}${control}`
  }
  const text = event.keyChar || (key === 'space' ? ' ' : [...(event.key ?? '')].length === 1 ? (shift ? event.key!.toUpperCase() : event.key!) : '')
  return text ? `${alt ? '\x1b' : ''}${text}` : null
}

export class TerminalState {
  readonly terminal: Terminal
  private visible = true
  private notice = ''
  private exited = false
  private sequence = 0
  private epoch: string
  private disposed = false
  private pending = Promise.resolve()
  private pendingBytes = 0
  private listeners = new Set<() => void>()
  constructor(cols: number, rows: number, epoch = 'legacy', onData: (data: string) => void = () => {}) {
    terminalDimensions(cols, rows)
    this.epoch = epoch
    this.terminal = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true, logLevel: 'off', convertEol: false })
    this.terminal.onData(onData)
    this.terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, params => { if (params.includes(25)) this.visible = true; return false })
    this.terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, params => { if (params.includes(25)) this.visible = false; return false })
    this.terminal.parser.registerEscHandler({ final: 'c' }, () => { this.visible = true; return false })
    this.terminal.onWriteParsed(() => this.emit())
  }
  private emit() { if (!this.disposed) for (const listener of this.listeners) listener() }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  write(bytes: string): Promise<void> {
    if (this.disposed) return Promise.resolve()
    return new Promise(resolve => this.terminal.write(bytes, () => { this.emit(); resolve() }))
  }
  accept(event: typeof PtyEvent.Type): Promise<void> {
    const bytes = event._tag === 'data' ? event.bytes.length : 0
    if (this.pendingBytes + bytes > 8 * 1024 * 1024) return Promise.reject(new Error('Terminal output exceeded the bounded parser queue. Reconnect the terminal to replay.'))
    this.pendingBytes += bytes
    const task = this.pending.then(async () => {
      if (this.disposed) return
      if (event._tag === 'epoch') {
        if (event.processEpoch !== this.epoch) { this.terminal.reset(); this.epoch = event.processEpoch; this.sequence = 0; this.visible = true; this.exited = false; this.notice = 'Terminal process restarted.' }
        this.emit(); return
      }
      if (event.processEpoch !== this.epoch) return
      if (event._tag === 'gap') { this.terminal.reset(); this.visible = true; this.sequence = event.earliestAvailable - 1; this.notice = 'Output history was truncated. The displayed screen may be incomplete until the program redraws.'; this.emit(); return }
      if (event.sequence <= this.sequence) return
      if (event._tag === 'data') { await this.write(event.bytes); this.sequence = event.sequence }
      else if (event._tag === 'exit') { this.sequence = event.sequence; this.exited = true; this.notice = `Process exited (${event.exitCode ?? event.signal ?? 'unknown'}).`; this.emit() }
      else this.sequence = event.sequence
    }).finally(() => { this.pendingBytes -= bytes })
    this.pending = task.catch(() => {})
    return task
  }
  resize(cols: number, rows: number) { terminalDimensions(cols, rows); this.terminal.resize(cols, rows); this.emit() }
  key(event: Pick<EventPayload, 'key' | 'keyChar' | 'modifiers'>) { const data = terminalKey(event, this.terminal.modes.applicationCursorKeysMode); if (data && !this.exited && !this.disposed) { this.terminal.scrollToBottom(); this.terminal.input(data, true); this.emit() }; return data }
  paste(text: string) { if (!this.exited && !this.disposed) this.terminal.input(this.terminal.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text, true) }
  scroll(lines: number) { this.terminal.scrollLines(lines); this.emit() }
  snapshot(theme: TerminalTheme): TerminalSnapshot {
    const buffer = this.terminal.buffer.active
    const lines: TerminalCell[][] = []
    for (let y = 0; y < this.terminal.rows; y++) {
      const row: TerminalCell[] = []
      const line = buffer.getLine(buffer.viewportY + y)
      for (let x = 0; x < this.terminal.cols; x++) {
        const cell = line?.getCell(x)
        if (!cell || cell.getWidth() === 0) continue
        let foreground = colour(cell, true, theme.foreground)
        let background = colour(cell, false, theme.background)
        if (cell.isInverse()) [foreground, background] = [background, foreground]
        row.push({ x, width: cell.getWidth(), text: cell.isInvisible() ? ' ' : cell.getChars() || ' ', foreground, background, bold: !!cell.isBold(), dim: !!cell.isDim(), underline: !!cell.isUnderline(), strike: !!cell.isStrikethrough() })
      }
      lines.push(row)
    }
    return { cols: this.terminal.cols, rows: this.terminal.rows, lines, cursor: { x: Math.min(buffer.cursorX, this.terminal.cols - 1), y: buffer.baseY + buffer.cursorY - buffer.viewportY, visible: this.visible && !this.exited }, alternate: buffer.type === 'alternate', viewportY: buffer.viewportY, baseY: buffer.baseY, notice: this.notice, exited: this.exited }
  }
  dispose() { this.disposed = true; this.listeners.clear(); this.terminal.dispose() }
}
