/// <reference path="./zuse-runtime/apps/server/node_modules/node-pty/typings/node-pty.d.ts" />
import { expect, it } from 'vitest'
import { createRequire } from 'node:module'
const { spawn }: typeof import('node-pty') = createRequire(import.meta.url)('./zuse-runtime/apps/server/node_modules/node-pty')
import { TerminalState } from './terminal-state'

const theme = { foreground: '#eeeeee', background: '#111111' }
function until(state: TerminalState, predicate: () => boolean, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let remove = () => {}
    const timer = setTimeout(() => { remove(); reject(new Error(`Timed out: ${label}`)) }, 5000)
    const check = () => { if (predicate()) { clearTimeout(timer); remove(); resolve() } }
    remove = state.subscribe(check)
    check()
  })
}

it('uses a real local PTY for fullscreen ANSI, raw arrow/Ctrl-C bytes and kernel resize', async () => {
  const program = [
    'import os,sys,tty,termios,fcntl,struct',
    'tty.setraw(0)',
    'def send(s): os.write(1,s.encode())',
    'def take(n):',
    ' data=b""',
    ' while len(data)<n: data+=os.read(0,n-len(data))',
    ' return data',
    'send("normal\\r\\n\\x1b[?1049h\\x1b[2J\\x1b[H\\x1b[31mREADY\\x1b[0m\\x1b[?1h")',
    'arrow=take(3)',
    'send("\\x1b[2;1HKEY="+arrow.hex())',
    'take(1)',
    'r,c,_,_=struct.unpack("HHHH",fcntl.ioctl(0,termios.TIOCGWINSZ,b"\\0"*8))',
    'send("\\x1b[3;1HSIZE="+str(c)+"x"+str(r))',
    'control=take(1)',
    'send("\\x1b[4;1HCTRL="+control.hex())',
    'take(1)',
    'send("\\x1b[?1049l\\r\\nDONE\\r\\n")',
  ].join('\n')
  const pty = spawn('python3', ['-u', '-c', program], { name: 'xterm-256color', cols: 30, rows: 8, cwd: process.cwd(), env: { PATH: process.env.PATH ?? '', TERM: 'xterm-256color' } })
  const state = new TerminalState(30, 8, 'test', data => pty.write(data))
  const output = pty.onData(data => { void state.write(data) })
  const lines = () => state.snapshot(theme).lines.map(row => row.map(cell => cell.text).join('')).join('\n')
  const exit = new Promise<number>(resolve => pty.onExit(event => resolve(event.exitCode)))
  try {
    await until(state, () => lines().includes('READY'), 'fullscreen ready')
    expect(state.snapshot(theme).alternate).toBe(true)
    expect(state.snapshot(theme).lines[0]![0]!.foreground).toBe('#cd0000')
    state.key({ key: 'up' })
    await until(state, () => lines().includes('KEY=1b4f41'), 'application arrow reached raw PTY')
    pty.resize(42, 12); state.resize(42, 12); state.key({ key: 's' })
    await until(state, () => lines().includes('SIZE=42x12'), 'kernel PTY size changed')
    state.key({ key: 'c', modifiers: { ctrl: true, shift: false, alt: false, cmd: false } })
    await until(state, () => lines().includes('CTRL=03'), 'raw Ctrl-C byte reached PTY')
    state.key({ key: 'q' })
    await until(state, () => lines().includes('DONE'), 'normal screen restored')
    expect(state.snapshot(theme).alternate).toBe(false)
    expect(lines()).toContain('normal')
    expect(await exit).toBe(0)
  } finally { output.dispose(); pty.kill(); state.dispose() }
}, 15000)

it('delivers Ctrl-C through the PTY line discipline as SIGINT', async () => {
  const pty = spawn('python3', ['-u', '-c', 'import signal,sys,time\nsignal.signal(signal.SIGINT,lambda *_:(print("INTERRUPTED",flush=True),sys.exit(0)))\nprint("READY",flush=True)\nwhile True: time.sleep(1)'], { name: 'xterm-256color', cols: 30, rows: 8, cwd: process.cwd(), env: { PATH: process.env.PATH ?? '', TERM: 'xterm-256color' } })
  const state = new TerminalState(30, 8, 'test', data => pty.write(data))
  const output = pty.onData(data => { void state.write(data) })
  const text = () => state.snapshot(theme).lines.map(row => row.map(cell => cell.text).join('')).join('\n')
  const exit = new Promise<number>(resolve => pty.onExit(event => resolve(event.exitCode)))
  try { await until(state, () => text().includes('READY'), 'interruptible process ready'); state.key({ key: 'c', modifiers: { ctrl: true, shift: false, alt: false, cmd: false } }); await until(state, () => text().includes('INTERRUPTED'), 'SIGINT delivered'); expect(await exit).toBe(0) }
  finally { output.dispose(); pty.kill(); state.dispose() }
}, 10000)
