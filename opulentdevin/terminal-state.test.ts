import { afterEach, describe, expect, it } from 'vitest'
import { TerminalState, terminalKey, terminalDimensions, ansiColour } from './terminal-state'
const theme = { foreground: '#eeeeee', background: '#111111' }
const models: TerminalState[] = []
const make = (cols = 20, rows = 6, onData?: (data: string) => void) => { const state = new TerminalState(cols, rows, 'epoch-1', onData); models.push(state); return state }
const text = (state: TerminalState, row = 0) => state.snapshot(theme).lines[row]!.map(cell => cell.text).join('').trimEnd()
afterEach(() => { for (const model of models.splice(0)) model.dispose() })

describe('real xterm headless parsing', () => {
  it('parses split ANSI, indexed and true colour plus inverse attributes', async () => {
    const state = make(); await state.write('\x1b[3'); await state.write('1mR\x1b[38;5;196mI\x1b[38;2;12;34;56mT\x1b[7mV')
    const row = state.snapshot(theme).lines[0]!
    expect(text(state)).toBe('RITV'); expect(row[0]!.foreground).toBe('#cd0000'); expect(row[1]!.foreground).toBe('#ff0000'); expect(row[2]!.foreground).toBe('#0c2238'); expect(row[3]!.background).toBe('#0c2238')
  })
  it('preserves alternate-screen state and restores the normal screen', async () => {
    const state = make(); await state.write('shell\x1b[?1049h\x1b[2J\x1b[Hfull screen\x1b[3;5H@')
    expect(state.snapshot(theme).alternate).toBe(true); expect(text(state)).toBe('full screen'); expect(state.snapshot(theme).cursor).toMatchObject({ x: 5, y: 2 }); expect(text(state, 2)).toBe('    @')
    await state.write('\x1b[?1049l'); expect(state.snapshot(theme).alternate).toBe(false); expect(text(state)).toBe('shell')
  })
  it('handles carriage return, erase, cursor visibility and Unicode cell width', async () => {
    const state = make(); await state.write('progress 100%\r\x1b[2K界e\u0301\x1b[?25l')
    const snapshot = state.snapshot(theme); expect(text(state)).toBe('界é'); expect(snapshot.lines[0]![0]!.width).toBe(2); expect(snapshot.cursor.visible).toBe(false)
    await state.write('\x1b[?25h'); expect(state.snapshot(theme).cursor.visible).toBe(true)
  })
  it('resizes and preserves parser state, responds to device status requests', async () => {
    const replies: string[] = []; const state = make(20, 6, data => replies.push(data)); await state.write('hi\x1b[6n'); expect(replies).toContain('\x1b[1;3R')
    state.resize(40, 10); expect(state.snapshot(theme)).toMatchObject({ cols: 40, rows: 10 }); expect(text(state)).toBe('hi')
    expect(() => terminalDimensions(0, 20)).toThrow(); expect(() => terminalDimensions(10000, 20)).toThrow()
  })
  it('orders output, ignores duplicate/stale epochs, resets replacement processes and exposes gaps', async () => {
    const state = make(); await Promise.all([state.accept({ _tag: 'data', processEpoch: 'epoch-1', sequence: 1, bytes: 'one' }), state.accept({ _tag: 'data', processEpoch: 'epoch-1', sequence: 2, bytes: 'two' })])
    await state.accept({ _tag: 'data', processEpoch: 'epoch-1', sequence: 2, bytes: 'duplicate' }); expect(text(state)).toBe('onetwo')
    await state.accept({ _tag: 'epoch', processEpoch: 'epoch-2', sequence: 0 }); await state.accept({ _tag: 'data', processEpoch: 'epoch-1', sequence: 3, bytes: 'stale' }); expect(text(state)).toBe('')
    await state.accept({ _tag: 'gap', processEpoch: 'epoch-2', requestedAfter: 0, earliestAvailable: 8, latestAvailable: 9 }); await state.accept({ _tag: 'data', processEpoch: 'epoch-2', sequence: 8, bytes: 'tail' }); expect(text(state)).toBe('tail'); expect(state.snapshot(theme).notice).toContain('incomplete')
  })
})
describe('native raw key encoding', () => {
  const modifiers = { ctrl: false, alt: false, cmd: false, shift: false }
  it('sends text directly, no implicit newline', () => { expect(terminalKey({ key: 'a', keyChar: 'a' })).toBe('a'); expect(terminalKey({ key: 'enter' })).toBe('\r'); expect(terminalKey({ key: 'backspace' })).toBe('\x7f') })
  it('encodes control, arrows and modifier combinations', () => { expect(terminalKey({ key: 'c', modifiers: { ...modifiers, ctrl: true } })).toBe('\x03'); expect(terminalKey({ key: 'up' })).toBe('\x1b[A'); expect(terminalKey({ key: 'left' }, true)).toBe('\x1bOD'); expect(terminalKey({ key: 'right', modifiers: { ...modifiers, ctrl: true } })).toBe('\x1b[1;5C'); expect(terminalKey({ key: 'tab', modifiers: { ...modifiers, shift: true } })).toBe('\x1b[Z') })
  it('uses actual parser application-cursor and bracketed-paste modes', async () => { const sent: string[] = []; const state = make(20, 6, data => sent.push(data)); await state.write('\x1b[?1h\x1b[?2004h'); state.key({ key: 'up' }); state.paste('hello'); expect(sent).toEqual(['\x1bOA', '\x1b[200~hello\x1b[201~']) })
  it('maps ANSI cube and grayscale palette endpoints', () => { expect(ansiColour(16)).toBe('#000000'); expect(ansiColour(231)).toBe('#ffffff'); expect(ansiColour(232)).toBe('#080808'); expect(ansiColour(255)).toBe('#eeeeee') })
})
