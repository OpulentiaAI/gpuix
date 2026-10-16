import { describe, expect, it, vi } from 'vitest'
import { Effect, Stream } from 'effect'
import { AgentSessionId } from './zuse-runtime/packages/contracts/src/ids'
import { BrowserCommandRequest } from './zuse-runtime/packages/contracts/src/browser'
import React from 'react'
import { mkdirSync, readFileSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'
import { NativeBrowserHost, registerNativeBrowserCommands, browserKey, browserNavigation, browserPoint, browserTestPage, localBrowserEndpoint, type BrowserFrame, type BrowserInput } from './browser-host'
import { dataDirectory } from './preferences'

const modifiers = { ctrl: false, alt: false, cmd: false, shift: false }
describe('native browser safety and input mapping', () => {
  it('requires explicit loopback browser endpoints without secrets', () => {
    for (const endpoint of ['', 'https://example.com', 'http://localhost:9222', 'http://127.0.0.1:9222/?token=secret', 'http://user:pass@127.0.0.1:9222', 'file:///tmp/chrome', 'ws://127.0.0.1:9222/devtools/page/private']) expect(() => localBrowserEndpoint(endpoint)).toThrow()
    expect(localBrowserEndpoint('http://127.0.0.1:9222')).toBe('http://127.0.0.1:9222/')
    expect(localBrowserEndpoint('ws://[::1]:9222/devtools/browser/abc-123')).toContain('/devtools/browser/')
  })
  it('refuses file and javascript navigation and credential-bearing URLs', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'http://user:pass@example.com', 'about:settings']) expect(() => browserNavigation(url)).toThrow()
    expect(browserNavigation(browserTestPage)).toBe(browserTestPage)
    expect(browserNavigation('https://example.com')).toBe('https://example.com/')
  })
  it('maps window coordinates through actual native bounds and rejects misses', () => {
    const bounds = { x: 100, y: 80, width: 480, height: 300 }
    expect(browserPoint(340, 230, bounds)).toEqual({ x: 480, y: 300 })
    expect(browserPoint(99, 230, bounds)).toBeNull()
    expect(browserPoint(580, 230, bounds)).toBeNull()
    expect(browserPoint(200, 200, { ...bounds, width: 0 })).toBeNull()
    expect(browserPoint(NaN, 200, bounds)).toBeNull()
  })
  it('maps Unicode text, navigation and modified keys separately', () => {
    expect(browserKey({ key: 'a', keyChar: 'a', modifiers })).toEqual({ kind: 'text', text: 'a' })
    expect(browserKey({ key: 's', keyChar: 'ß', modifiers })).toEqual({ kind: 'text', text: 'ß' })
    expect(browserKey({ key: 'left', modifiers })).toEqual({ kind: 'key', key: 'ArrowLeft' })
    expect(browserKey({ key: 'enter', keyChar: '\r', modifiers })).toEqual({ kind: 'key', key: 'Enter' })
    expect(browserKey({ key: 'a', keyChar: 'a', modifiers: { ...modifiers, ctrl: true } })).toEqual({ kind: 'key', key: 'Control+a' })
    expect(browserKey({ key: 'shift', modifiers })).toBeNull()
  })
  it('starts disconnected and rejects browser actions without a connection', async () => {
    const host = new NativeBrowserHost()
    await expect(host.frame()).rejects.toThrow('disconnected')
    await expect(host.input({ kind: 'text', text: 'test' })).rejects.toThrow('disconnected')
    await host.disconnect()
  })
  it('scopes command ownership, deduplicates and sends truthful errors', async () => {
    const host = new NativeBrowserHost()
    const sessionId = AgentSessionId.make('browser-session')
    const own = BrowserCommandRequest.make({ id: 'own', sessionId, command: { _tag: 'Status' } })
    const other = BrowserCommandRequest.make({ id: 'other', sessionId: AgentSessionId.make('other-session'), command: { _tag: 'Status' } })
    const responses: { id: string; ok: boolean; error?: string }[] = []
    const cancel = vi.fn()
    const backend: Parameters<typeof registerNativeBrowserCommands>[0] = {
      client: { 'browser.commands': () => Stream.make(other, own, own), 'browser.respond': ({ result }) => Effect.sync(() => { responses.push(result) }) },
      run: effect => Effect.runPromise(effect),
      subscribe: (stream, onValue, onError) => { const done = Effect.runPromise(Stream.runForEach(stream, value => Effect.sync(() => onValue(value)))).catch(onError); return { done, cancel } },
    }
    const errors = vi.fn()
    const stop = registerNativeBrowserCommands(backend, sessionId, host, errors)
    expect(() => registerNativeBrowserCommands(backend, sessionId, host, errors)).toThrow('owner')
    await vi.waitFor(() => expect(responses).toHaveLength(1))
    expect(responses[0]).toMatchObject({ id: 'own', ok: false, error: expect.stringContaining('disconnected') })
    stop(); expect(cancel).toHaveBeenCalledOnce(); expect(errors).not.toHaveBeenCalled()
  })
  it('uses an isolated self-contained test page without external resources', () => {
    const html = decodeURIComponent(browserTestPage.split(',').slice(1).join(','))
    expect(html).toContain("default-src 'none'")
    expect(html).not.toMatch(/(?:src|href)=["']https?:/)
  })
})

describe('native GPUI image update compatibility', () => {
  it.runIf(Boolean(process.env.OPULENTDEVIN_BROWSER_NATIVE_BUN))('updates encoded frames in a real Linux GPUI window', async () => {
    const { launch } = await import('@gpuix/react/automation')
    mkdirSync(join(dataDirectory, 'browser-tests'), { recursive: true, mode: 0o700 })
    const output = mkdtempSync(join(dataDirectory, 'browser-tests', 'live-image-'))
    const runtime = join(output, 'runtime'); mkdirSync(runtime, { mode: 0o700 })
    const rendererUrl = import.meta.resolve('@gpuix/react')
    const reactUrl = import.meta.resolve('react')
    const componentUrl = new URL('./browser.tsx', import.meta.url).href
    const fixture = join(output, 'fixture.mjs')
    writeFileSync(fixture, `import React, {useState} from ${JSON.stringify(reactUrl)};\nimport {render} from ${JSON.stringify(rendererUrl)};\nimport {BrowserImage} from ${JSON.stringify(componentUrl)};\nfunction Fixture(){ const [changed,setChanged]=useState(false); const [count,setCount]=useState(0); const frame={bytes:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600"><rect width="960" height="600" fill="'+(changed?'#2266dd':'#dd2222')+'"/></svg>'),width:960,height:600,title:'Fresh image',url:'data:'}; return React.createElement('div',{style:{width:800,height:600}},React.createElement('div',{testId:'replace',onClick:()=>setChanged(true),style:{height:40}},'Replace frame'),React.createElement('div',{testId:'events',style:{height:30}},'Events '+count),React.createElement(BrowserImage,{frame,onInput:()=>setCount(value=>value+1)})); }\nrender(React.createElement(Fixture),{title:'Native browser image verification',width:800,height:600});\n`, { mode: 0o600 })
    const env = { ...process.env, XDG_RUNTIME_DIR: runtime, WAYLAND_DISPLAY: 'browser-image-test', ZED_HEADLESS: undefined, GPUIX_BACKGROUND: '0' }
    const weston = spawn('weston', ['--backend=x11', '--renderer=gl', '--socket=browser-image-test', '--width=840', '--height=660', '--idle-time=0', '--no-config'], { env: { ...env, WAYLAND_DISPLAY: undefined }, stdio: 'ignore' })
    let app: Awaited<ReturnType<typeof launch>> | undefined
    try {
      for (let attempt = 0; attempt < 50 && !existsSync(join(runtime, 'browser-image-test')); attempt++) { if (weston.exitCode !== null) throw new Error('Native image test compositor exited'); await delay(100) }
      expect(existsSync(join(runtime, 'browser-image-test'))).toBe(true)
      app = await launch({ command: process.env.OPULENTDEVIN_BROWSER_NATIVE_BUN!, args: [fixture], cwd: fileURLToPath(new URL('.', import.meta.url)), env })
      await app.getByTestId('browser-image').waitFor({ timeoutMs: 15000 })
      if (process.platform !== 'linux') await app.screenshot({ path: join(output, 'before.png') })
      await app.getByTestId('replace').click()
      if (process.platform !== 'linux') {
        await app.screenshot({ path: join(output, 'after.png') })
        expect(readFileSync(join(output, 'before.png')).equals(readFileSync(join(output, 'after.png')))).toBe(false)
      } else console.log('NATIVE_IMAGE_PIXEL_CHECK_BLOCKED: Linux captureScreenshot unsupported; desktop evidence required')
      await app.getByTestId('browser-surface').click()
      await app.getByTestId('browser-surface').press('a')
      await app.getByTestId('browser-surface').wheel(0, -40)
      expect(Number((await app.getByTestId('events').textContent()).replace('Events ', ''))).toBeGreaterThanOrEqual(3)
      console.log('NATIVE_BROWSER_IMAGE_EVIDENCE', output)
      const hold = Number(process.env.OPULENTDEVIN_BROWSER_NATIVE_HOLD ?? 0)
      if (Number.isFinite(hold) && hold > 0) await delay(Math.min(hold, 60) * 1000)
    } finally { await app?.close(); weston.kill('SIGTERM') }
  })
  it('paints fresh encoded image frames and dispatches native input', async context => {
    const { createTestRoot, hasNativeTestRenderer } = await import('@gpuix/react/testing')
    if (!hasNativeTestRenderer) { context.skip(); return }
    const { BrowserImage } = await import('./browser')
    mkdirSync(join(dataDirectory, 'browser-tests'), { recursive: true, mode: 0o700 })
    const output = mkdtempSync(join(dataDirectory, 'browser-tests', 'image-'))
    const root = createTestRoot({ width: 800, height: 600 })
    const inputs: BrowserInput[] = []
    const frame = (colour: string): BrowserFrame => ({ bytes: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600"><rect width="960" height="600" fill="${colour}"/></svg>`), width: 960, height: 600, title: 'Fresh native image test', url: 'data:' })
    try {
      root.render(React.createElement(BrowserImage, { frame: frame('#dd2222'), onInput: input => inputs.push(input) }))
      root.renderer.flush()
      const image = root.renderer.findByTestId('browser-image')!
      const surface = root.renderer.findByTestId('browser-surface')!
      const bounds = root.renderer.getElementBounds(image.id)!
      expect(bounds.width).toBe(720)
      root.renderer.captureScreenshot(join(output, 'red.png'))
      root.renderer.nativeSimulateClick(bounds.x + 100, bounds.y + 100)
      root.renderer.nativeSimulateKeyDown(surface.id, 'enter')
      expect(inputs.some(input => input.kind === 'click')).toBe(true)
      expect(inputs.some(input => input.kind === 'key' && input.key === 'Enter')).toBe(true)
      root.render(React.createElement(BrowserImage, { frame: frame('#2244dd'), onInput: input => inputs.push(input) }))
      root.renderer.flush()
      root.renderer.captureScreenshot(join(output, 'blue.png'))
      expect(readFileSync(join(output, 'red.png')).equals(readFileSync(join(output, 'blue.png')))).toBe(false)
      console.log('NATIVE_BROWSER_IMAGE_EVIDENCE', output)
    } finally { root.unmount() }
  })
})

it.skipIf(!process.env.OPULENTDEVIN_BROWSER_CDP)('controls only a fresh data page in the explicitly configured existing Chromium', async () => {
  const host = new NativeBrowserHost()
  try {
    const initial = await host.connect()
    expect(initial.title).toBe('Native browser test')
    expect(initial.bytes.subarray(1, 4).toString()).toBe('PNG')
    await host.input({ kind: 'key', key: 'Tab' })
    await host.input({ kind: 'text', text: 'Native Unicode ✓' })
    await host.input({ kind: 'key', key: 'Tab' })
    await host.input({ kind: 'key', key: 'Enter' })
    expect((await host.inspect()).accessibility).toContain('Native Unicode ✓')
    await host.command({ _tag: 'Type', target: { _tag: 'Css', selector: 'input' }, text: 'Typed through contract' })
    await host.command({ _tag: 'Click', target: { _tag: 'Role', role: 'button', name: 'Click test' } })
    await host.command({ _tag: 'WaitFor', text: 'Clicked' })
    expect(await host.command({ _tag: 'Snapshot' })).toMatchObject({ snapshot: expect.stringContaining('Typed through contract') })
    expect(await host.command({ _tag: 'Inspect', target: { _tag: 'Css', selector: 'input' } })).toMatchObject({ bounds: expect.any(Object) })
    expect(await host.command({ _tag: 'Evaluate', expression: '1+1' })).toEqual({ value: 2, truncated: false })
    const inspection = await host.inspect()
    expect(inspection.text).toContain('Clicked')
    expect(inspection.accessibility).toContain('Typed through contract')
    expect(inspection.console.some(line => line.includes('Native click received'))).toBe(true)
    expect(inspection.network.filter(entry => /^https?:/.test(entry.url))).toEqual([])
    await expect(host.command({ _tag: 'Read', ref: 'e1' })).rejects.toThrow('Stale')
    await host.command({ _tag: 'Navigate', url: 'data:text/html,<title>Second page</title><p>Second page</p>' })
    await host.command({ _tag: 'History', action: 'back' })
    expect((await host.frame()).title).toBe('Native browser test')
    await host.command({ _tag: 'History', action: 'forward' })
    expect((await host.frame()).title).toBe('Second page')
    await host.command({ _tag: 'History', action: 'reload' })
    expect((await host.frame()).title).toBe('Second page')
    await host.command({ _tag: 'Navigate', url: browserTestPage })
    await host.command({ _tag: 'Resize', mode: 'custom', width: 640, height: 480 })
    expect(await host.frame()).toMatchObject({ width: 640, height: 480 })
    const captured = await host.command({ _tag: 'Snapshot', screenshot: 'viewport' }) as { snapshot: string; screenshot: string }
    expect(Buffer.from(captured.screenshot, 'base64').subarray(1, 4).toString()).toBe('PNG')
    const inputRef = captured.snapshot.split('\n').find(line => line.includes('"tag":"input"'))!.split(' ')[0]
    await host.command({ _tag: 'FillForm', fields: [{ ref: inputRef, value: 'Reference fill' }] })
    await host.command({ _tag: 'Hover', ref: inputRef })
    await host.command({ _tag: 'Press', ref: inputRef, key: 'End' })
    await host.command({ _tag: 'Scroll', ref: inputRef })
    await host.command({ _tag: 'History', action: 'reload' })
    await expect(host.command({ _tag: 'Type', ref: inputRef, text: 'stale' })).rejects.toThrow('Stale')
    const form = 'data:text/html,' + encodeURIComponent('<select aria-label="Choice"><option value="a">Alpha</option><option value="b">Beta</option></select>')
    await host.command({ _tag: 'Navigate', url: form })
    const selectSnapshot = await host.command({ _tag: 'Snapshot' }) as { snapshot: string }
    const selectRef = selectSnapshot.snapshot.split('\n').find(line => line.includes('"tag":"select"'))!.split(' ')[0]
    await host.command({ _tag: 'Select', ref: selectRef, value: 'b' })
    expect((await host.inspect()).accessibility).toContain('Beta')
    await expect(host.command({ _tag: 'Dialog', action: 'dismiss' })).rejects.toThrow('No dialog')
    await host.command({ _tag: 'Navigate', url: 'data:text/html,' + encodeURIComponent('<button onclick="alert(\'Controlled dialog\');document.querySelector(\'output\').textContent=\'Resolved\'">Dialog test</button><output>Ready</output>') })
    const clickDialog = host.command({ _tag: 'Click', target: { _tag: 'Text', text: 'Dialog test', exact: true } })
    await vi.waitFor(async () => { await host.command({ _tag: 'Dialog', action: 'accept' }) }, { timeout: 3000, interval: 50 })
    await clickDialog
    expect(await host.command({ _tag: 'Read' })).toContain('Resolved')
  } finally { await host.disconnect() }
})
