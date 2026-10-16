import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Browser, BrowserContext, Dialog, ElementHandle, Locator, Page, Request, Response } from 'playwright-core'
import { BrowserCommandResult, type BrowserCommand, type BrowserTarget, type BrowserCommandRequest } from './zuse-runtime/packages/contracts/src/browser'
import type { Backend } from './backend'
import type { AgentSessionId } from './zuse-runtime/packages/contracts/src/ids'
import { dataDirectory } from './preferences'

export const browserViewport = { width: 960, height: 600 }
type BrowserBackend = Pick<Backend, 'subscribe' | 'run'> & { client: {
  'browser.commands': (input: {}) => import('effect').Stream.Stream<BrowserCommandRequest, unknown>
  'browser.respond': (input: { result: BrowserCommandResult }) => import('effect').Effect.Effect<void, unknown>
} }
const browserOwners = new WeakMap<BrowserBackend, symbol>()
export function registerNativeBrowserCommands(backend: BrowserBackend, sessionId: AgentSessionId, host: NativeBrowserHost, onError: (message: string) => void) {
  if (browserOwners.has(backend)) throw new Error('This backend already has an active native browser command owner.')
  const owner = Symbol('native-browser-owner')
  browserOwners.set(backend, owner)
  let active = true
  const handled = new Set<string>()
  let delivery = Promise.resolve()
  const subscription = backend.subscribe(backend.client['browser.commands']({}), request => {
    if (!active || request.sessionId !== sessionId || handled.has(request.id)) return
    handled.add(request.id)
    const respond = async () => {
      if (!active) return
      const result = await host.respond(request)
      if (active && browserOwners.get(backend) === owner) await backend.run(backend.client['browser.respond']({ result }))
    }
    const failed = (error: unknown) => { if (active) onError(error instanceof Error ? error.message : 'Browser response delivery failed.') }
    if (request.command._tag === 'Dialog') void respond().catch(failed)
    else delivery = delivery.then(respond).catch(failed)
  }, error => { if (active) onError(error instanceof Error ? error.message : 'Browser command stream failed.') })
  return () => { active = false; subscription.cancel(); if (browserOwners.get(backend) === owner) browserOwners.delete(backend) }
}
export const browserTestPage = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"><title>Native browser test</title><style>body{font:20px sans-serif;background:#f4f6fa;color:#18243a;padding:32px}input,button{font:20px sans-serif;padding:12px}#spacer{height:1000px}</style><h1>Isolated native browser</h1><p>This fresh page makes no external requests.</p><input aria-label="Test text" placeholder="Type here"><button onclick="document.querySelector('output').textContent='Clicked';console.log('Native click received')">Click test</button><output>Ready</output><div id="spacer"></div><p>Scroll reached the bottom.</p>`)
export type BrowserFrame = { bytes: Buffer; url: string; title: string; width: number; height: number }
export type BrowserNetworkEntry = { id?: string; method: string; url: string; status?: number; failed?: string }
export type BrowserInspection = { text: string; accessibility: string; console: string[]; network: BrowserNetworkEntry[] }
export type BrowserInput = { kind: 'click'; x: number; y: number; button?: 'left' | 'middle' | 'right'; count?: number } | { kind: 'key'; key: string } | { kind: 'text'; text: string } | { kind: 'scroll'; x: number; y: number; deltaX: number; deltaY: number }

export function localBrowserEndpoint(value = process.env.OPULENTDEVIN_BROWSER_CDP): string {
  if (!value) throw new Error('Set OPULENTDEVIN_BROWSER_CDP to an explicitly authorised local Chromium CDP endpoint before connecting.')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('The configured browser endpoint is not a valid URL.') }
  if (!['http:', 'ws:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password || url.search || url.hash) throw new Error('Browser CDP must use an explicit loopback IP and port without credentials, query or fragment.')
  if (url.protocol === 'http:' && url.pathname !== '/') throw new Error('HTTP CDP endpoints must use the root path.')
  if (url.protocol === 'ws:' && !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(url.pathname)) throw new Error('WebSocket CDP must address a browser endpoint, never an existing page.')
  return url.href
}

export function browserNavigation(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:', 'data:', 'about:'].includes(url.protocol) || url.username || url.password || (url.protocol === 'about:' && value !== 'about:blank')) throw new Error('Only http, https, data pages and about:blank can be opened.')
  return url.href
}

export function browserPoint(x: number, y: number, bounds: { x: number; y: number; width: number; height: number }, viewport = browserViewport) {
  if (![x, y, bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0 || x < bounds.x || y < bounds.y || x >= bounds.x + bounds.width || y >= bounds.y + bounds.height) return null
  return { x: (x - bounds.x) * viewport.width / bounds.width, y: (y - bounds.y) * viewport.height / bounds.height }
}

export function browserKey(event: { key?: string; keyChar?: string; modifiers?: { ctrl: boolean; alt: boolean; cmd: boolean; shift: boolean } }): BrowserInput | null {
  if (!event.key) return null
  const modifiers = event.modifiers
  if (event.keyChar && !/[\u0000-\u001f\u007f]/.test(event.keyChar) && !modifiers?.ctrl && !modifiers?.cmd && !modifiers?.alt) return { kind: 'text', text: event.keyChar }
  const aliases: Record<string, string> = { enter: 'Enter', escape: 'Escape', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', space: 'Space' }
  const key = aliases[event.key] ?? (/^f\d+$/.test(event.key) ? event.key.toUpperCase() : event.key)
  if (['shift', 'control', 'alt', 'cmd', 'super', 'meta'].includes(key)) return null
  return { kind: 'key', key: [modifiers?.ctrl && 'Control', modifiers?.alt && 'Alt', modifiers?.cmd && 'Meta', modifiers?.shift && 'Shift', key].filter(Boolean).join('+') }
}

function readableUrl(value: string) {
  if (value.startsWith('data:')) return 'data: (isolated page)'
  try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href } catch { return '(unknown URL)' }
}

export class NativeBrowserHost {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private consoleLines: string[] = []
  private network: BrowserNetworkEntry[] = []
  private closing = false
  private viewport = { ...browserViewport }
  private refs = new Map<string, ElementHandle<Node>>()
  private snapshotId = 0
  private lastFrame: BrowserFrame | null = null
  private dialog: Dialog | null = null
  private responses = new Map<string, Response>()
  private requests = new WeakMap<Request, string>()

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation)
    this.queue = next.catch(() => {})
    return next
  }

  connect(endpoint?: string): Promise<BrowserFrame> {
    return this.serial(async () => {
      if (this.page || this.closing) throw new Error('Browser is already connected or closing.')
      const configured = localBrowserEndpoint(endpoint)
      const require = createRequire(import.meta.url)
      const version: unknown = require('playwright-core/package.json').version
      if (typeof version !== 'string' || Number(version.split('.')[0]) !== 1 || Number(version.split('.')[1]) < 60) throw new Error('Install pinned playwright-core 1.60.0 or newer: noDefaults is required to preserve the existing browser context.')
      const { chromium } = await import('playwright-core')
      this.browser = await chromium.connectOverCDP(configured, { timeout: 10000, noDefaults: true })
      try {
        this.context = await this.browser.newContext({ viewport: this.viewport, acceptDownloads: false, serviceWorkers: 'block' })
        this.context.setDefaultTimeout(10000)
        this.page = await this.context.newPage()
        const page = this.page
        this.context.on('page', popup => { if (popup !== page) void popup.close().catch(() => {}) })
        page.on('framenavigated', frame => { if (frame === page.mainFrame()) { this.consoleLines = []; this.clearRefs() } })
        page.on('dialog', dialog => { this.dialog = dialog })
        page.on('console', message => { this.consoleLines = [...this.consoleLines.slice(-99), `${message.type()}: ${message.text().slice(0, 2000)}`] })
        page.on('pageerror', error => { this.consoleLines = [...this.consoleLines.slice(-99), `error: ${error.message.slice(0, 2000)}`] })
        page.on('request', request => { const id = randomUUID(); this.requests.set(request, id); this.network = [...this.network.slice(-199), { id, method: request.method(), url: readableUrl(request.url()) }] })
        page.on('response', response => { const id = this.requests.get(response.request()) ?? randomUUID(); this.responses.set(id, response); if (this.responses.size > 200) this.responses.delete(this.responses.keys().next().value!); const entry = this.network.find(entry => entry.id === id); if (entry) entry.status = response.status(); else this.network = [...this.network.slice(-199), { id, method: response.request().method(), url: readableUrl(response.url()), status: response.status() }] })
        page.on('requestfailed', request => { this.network = [...this.network.slice(-199), { method: request.method(), url: readableUrl(request.url()), failed: request.failure()?.errorText }] })
        await page.goto(browserTestPage, { waitUntil: 'load' })
        return await this.capture()
      } catch (error) { await this.release(); throw error }
    })
  }

  private ownedPage() {
    if (!this.page || this.page.isClosed() || this.closing) throw new Error('Browser disconnected. Connect a fresh isolated page to continue.')
    return this.page
  }

  private async capture(): Promise<BrowserFrame> {
    const page = this.ownedPage()
    if (this.dialog && this.lastFrame) return { ...this.lastFrame, title: `Dialog pending (${this.dialog.type()}) — displayed frame is paused` }
    const frame = { bytes: await page.screenshot({ type: 'png', timeout: 10000 }), url: readableUrl(page.url()), title: await page.title(), ...this.viewport }
    this.lastFrame = frame
    return frame
  }

  pendingDialog() { return this.dialog ? { type: this.dialog.type(), message: this.dialog.message().slice(0, 2000) } : null }
  frame() { return this.dialog ? this.capture() : this.serial(() => this.capture()) }

  input(input: BrowserInput) {
    return this.serial(async () => {
      const page = this.ownedPage()
      if (this.dialog) throw new Error(`Browser dialog pending: ${this.dialog.type()}. Use an explicit Dialog action.`)
      if (input.kind === 'click' || input.kind === 'scroll') {
        if (!Number.isFinite(input.x) || !Number.isFinite(input.y) || input.x < 0 || input.y < 0 || input.x >= this.viewport.width || input.y >= this.viewport.height) throw new Error('Pointer is outside the browser viewport.')
      }
      if (input.kind === 'click') await page.mouse.click(input.x, input.y, { button: input.button ?? 'left', clickCount: Math.min(3, Math.max(1, input.count ?? 1)) })
      if (input.kind === 'text') await page.keyboard.insertText(input.text)
      if (input.kind === 'key') await page.keyboard.press(input.key)
      if (input.kind === 'scroll') {
        if (!Number.isFinite(input.deltaX) || !Number.isFinite(input.deltaY)) throw new Error('Invalid scroll delta.')
        await page.mouse.move(input.x, input.y)
        await page.mouse.wheel(input.deltaX, input.deltaY)
      }
    })
  }

  private clearRefs() { for (const handle of this.refs.values()) void handle.dispose().catch(() => {}); this.refs.clear() }

  private async reference(ref: string) {
    const handle = this.refs.get(ref)
    if (!handle || !await handle.evaluate(element => element.isConnected)) throw new Error('Stale snapshot reference. Capture a new Snapshot.')
    return handle
  }

  private async snapshot(page: Page, screenshot?: 'viewport' | 'full-page') {
    this.clearRefs()
    const prefix = `s${++this.snapshotId}e`
    const elements = page.locator('a,button,input,textarea,select,[role],[tabindex]')
    const count = Math.min(await elements.count(), 200)
    const lines: string[] = []
    for (let index = 0; index < count; index++) {
      const handle = await elements.nth(index).elementHandle()
      if (!handle) continue
      if (!await handle.isVisible()) { await handle.dispose(); continue }
      const ref = prefix + (lines.length + 1)
      const description = await handle.evaluate(element => {
        if (!(element instanceof Element)) throw new Error('Snapshot target is not an element.')
        return { tag: element.tagName.toLowerCase(), role: element.getAttribute('role'), name: element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 160) ?? '', value: element instanceof HTMLInputElement && element.type !== 'password' ? element.value : undefined }
      })
      this.refs.set(ref, handle); lines.push(`${ref} ${JSON.stringify(description)}`)
    }
    return { snapshot: ((await page.locator('body').ariaSnapshot()).slice(0, 16000) + '\n\nTargets:\n' + lines.join('\n')), ...(screenshot ? { screenshot: (await page.screenshot({ type: 'png', fullPage: screenshot === 'full-page', timeout: 10000 })).toString('base64') } : {}) }
  }

  private target(page: Page, target?: BrowserTarget, ref?: string): Locator {
    if (ref || target?._tag === 'Ref') throw new Error('This action requires the reference resolver.')
    if (!target) return page.locator(':focus')
    if (target._tag === 'Css') return page.locator(target.selector)
    if (target._tag === 'Text') return page.getByText(target.text, { exact: target.exact })
    if (target._tag === 'Role') {
      const role = target.role
      if (role === 'button' || role === 'link' || role === 'textbox' || role === 'checkbox' || role === 'radio' || role === 'combobox' || role === 'option' || role === 'heading' || role === 'tab' || role === 'menuitem') return page.getByRole(role, { name: target.name, exact: target.exact })
      throw new Error(`Role ${role} is not supported by this adapter; use a CSS or text target.`)
    }
    throw new Error('This action requires an element target, not a point.')
  }

  private element(page: Page, target?: BrowserTarget, ref?: string) {
    const key = ref ?? (target?._tag === 'Ref' ? target.ref : undefined)
    return key ? this.reference(key) : Promise.resolve(this.target(page, target))
  }

  command(command: BrowserCommand): Promise<unknown> {
    const execute = async () => {
      const page = this.ownedPage()
      if (this.dialog && command._tag !== 'Dialog' && command._tag !== 'Status') throw new Error(`Dialog pending (${this.dialog.type()}): ${this.dialog.message().slice(0, 1000)}. Resolve it explicitly with Dialog.`)
      switch (command._tag) {
        case 'Dialog': {
          const dialog = this.dialog
          if (!dialog) throw new Error('No dialog is pending.')
          if (command.action === 'accept') await dialog.accept(command.promptText)
          else await dialog.dismiss()
          this.dialog = null; return
        }
        case 'Evaluate': {
          if (command.expression.length > 20000) throw new Error('Page expression exceeds 20000 characters.')
          const cdp = await this.context!.newCDPSession(page)
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            const result = await Promise.race([cdp.send('Runtime.evaluate', { expression: command.expression, awaitPromise: command.awaitPromise ?? false, returnByValue: true, timeout: 5000 }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Page evaluation timed out; do not assume side effects were cancelled.')), 6000) })])
            if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description?.slice(0, 2000) ?? result.exceptionDetails.text)
            const encoded = JSON.stringify(result.result.value ?? result.result.unserializableValue ?? null)
            if (encoded.length > 20000) return { value: encoded.slice(0, 20000), truncated: true }
            return { value: result.result.value ?? result.result.unserializableValue ?? null, truncated: false }
          } finally { clearTimeout(timer); await cdp.detach() }
        }
        case 'Resize': {
          if (command.lockAspectRatio) throw new Error('Persistent aspect-ratio locking is not supported.')
          const sizes = { fill: browserViewport, phone: { width: 390, height: 844 }, tablet: { width: 768, height: 1024 }, laptop: { width: 1366, height: 768 }, desktop: { width: 1920, height: 1080 }, custom: { width: command.width ?? 0, height: command.height ?? 0 } }
          let { width, height } = sizes[command.mode]
          width = command.width ?? width; height = command.height ?? height
          if (![width, height].every(value => Number.isInteger(value) && value >= 100 && value <= 3840)) throw new Error('Viewport dimensions must be integers between 100 and 3840.')
          if (command.orientation === 'portrait' && width > height || command.orientation === 'landscape' && width < height) [width, height] = [height, width]
          await page.setViewportSize({ width, height }); this.viewport = { width, height }; return this.viewport
        }
        case 'Hover': await (await this.reference(command.ref)).hover(); return
        case 'Select': {
          const element = await this.reference(command.ref)
          try { await element.selectOption({ value: command.value }) } catch { await element.selectOption({ label: command.value }) }
          return
        }
        case 'FillForm': {
          const fields = await Promise.all(command.fields.map(async field => ({ element: await this.reference(field.ref), value: field.value })))
          for (const field of fields) {
            const tag = await field.element.evaluate(element => element instanceof Element ? element.tagName.toLowerCase() : '')
            if (tag === 'select') await field.element.selectOption(field.value)
            else await field.element.fill(field.value)
          }
          if (command.submit && fields.length) await fields[fields.length - 1].element.press('Enter')
          return
        }
        case 'Navigate':
          if (command.environmentPort !== undefined || command.environmentProtocol !== undefined) throw new Error('Remote environment port forwarding is not supported by this local browser.')
          this.consoleLines = []; this.network = []
          await page.goto(browserNavigation(command.url), { waitUntil: command.readiness === 'immediate' ? 'commit' : command.readiness === 'load' ? 'load' : 'domcontentloaded' }); return
        case 'History':
          this.consoleLines = []; this.network = []
          if (command.action === 'back') await page.goBack({ waitUntil: 'domcontentloaded' })
          else if (command.action === 'forward') await page.goForward({ waitUntil: 'domcontentloaded' })
          else await page.reload({ waitUntil: 'domcontentloaded' })
          return
        case 'Click':
          if (!command.ref && command.target?._tag === 'Point') {
            const { x, y } = command.target
            if (!browserPoint(x, y, { x: 0, y: 0, ...this.viewport })) throw new Error('Click point is outside the viewport.')
            await page.mouse.click(x, y)
          } else await (await this.element(page, command.target, command.ref)).click()
          return
        case 'Type':
          if (command.target || command.ref) await (await this.element(page, command.target, command.ref)).fill(command.text)
          else await page.keyboard.insertText(command.text)
          if (command.submit) await page.keyboard.press('Enter')
          return
        case 'Scroll':
          if (command.ref) { await (await this.reference(command.ref)).scrollIntoViewIfNeeded(); return }
          if (command.direction === 'top') await page.keyboard.press('Control+Home')
          else if (command.direction === 'bottom') await page.keyboard.press('Control+End')
          else if (command.direction === 'up' || command.direction === 'down') await page.mouse.wheel(0, command.direction === 'up' ? -500 : 500)
          else throw new Error('A scroll direction is required.')
          return
        case 'Snapshot': return this.snapshot(page, command.screenshot)
        case 'Inspect': {
          const locator = await this.element(page, command.target)
          return { text: (await locator.innerText()).slice(0, 20000), bounds: await locator.boundingBox() }
        }
        case 'Wait':
        case 'WaitFor': {
          const timeout = Math.min(15000, Math.max(1, command.timeoutMs ?? 10000))
          if ('target' in command && command.target) await this.target(page, command.target).waitFor({ state: 'visible', timeout })
          else if (command.selector) await page.locator(command.selector).waitFor({ state: 'visible', timeout })
          else if (command.text) await page.getByText(command.text).first().waitFor({ state: 'visible', timeout })
          else if ('urlIncludes' in command && command.urlIncludes) { const includes = command.urlIncludes; await page.waitForURL(url => url.href.includes(includes), { timeout }) }
          else if ('loadingComplete' in command && command.loadingComplete) await page.waitForLoadState('load', { timeout })
          else if (command.ms !== undefined && Number.isFinite(command.ms) && command.ms >= 0 && command.ms <= 15000) await new Promise(resolve => setTimeout(resolve, command.ms))
          else throw new Error('A supported wait condition or bounded duration is required.')
          return
        }
        case 'Status': return { url: readableUrl(page.url()), title: await page.title(), viewport: this.viewport }
        case 'Read':
          return (await (command.ref ? await this.reference(command.ref) : page.locator('body')).innerText()).slice(0, 20000)
        case 'Network': {
          if (!command.id) return this.network.filter(entry => !command.filter || entry.url.includes(command.filter))
          const response = this.responses.get(command.id)
          if (!response) throw new Error('Network response is unavailable or expired.')
          const headers = await response.allHeaders()
          const length = Number(headers['content-length'])
          const readable = /^(text\/|application\/(json|javascript|xml))/.test(headers['content-type'] ?? '')
          const canRead = readable && headers['content-encoding'] === undefined && Number.isFinite(length) && length >= 0 && length <= 65536
          return { id: command.id, status: response.status(), url: readableUrl(response.url()), headers: Object.fromEntries(Object.entries(headers).filter(([key]) => ['content-type', 'content-length', 'cache-control', 'content-encoding'].includes(key))), body: canRead ? (await response.text()).slice(0, 65536) : undefined, bodyOmitted: canRead ? undefined : 'Body requires a textual response with known uncompressed size at most 65536 bytes.' }
        }
        case 'Console': return [...this.consoleLines]
        case 'Press':
          if (command.ref) await (await this.reference(command.ref)).press(command.key)
          else await page.keyboard.press(command.key)
          return
        case 'Screenshot': {
          const directory = join(dataDirectory, 'browser-captures')
          await mkdir(directory, { recursive: true, mode: 0o700 })
          const path = join(directory, `${randomUUID()}.png`)
          await writeFile(path, await page.screenshot({ type: 'png', fullPage: command.fullPage, timeout: 10000 }), { mode: 0o600, flag: 'wx' })
          return path
        }
        default: throw new Error(`Browser command ${command._tag} is not implemented by the native local surface.`)
      }
    }
    return command._tag === 'Dialog' ? execute() : this.serial(execute)
  }

  async respond(request: BrowserCommandRequest): Promise<BrowserCommandResult> {
    try {
      const value = await this.command(request.command)
      const status = await this.command({ _tag: 'Status' }) as { url: string; title: string }
      if (request.command._tag === 'Screenshot') return BrowserCommandResult.make({ id: request.id, ok: true, ...status, screenshot: (await readFile(String(value))).toString('base64') })
      if (request.command._tag === 'Snapshot') return BrowserCommandResult.make({ id: request.id, ok: true, ...status, ...(value as { snapshot: string; screenshot?: string }), detail: 'References are invalidated by navigation and each new snapshot.' })
      if (['Read', 'Console', 'Network'].includes(request.command._tag)) return BrowserCommandResult.make({ id: request.id, ok: true, ...status, text: typeof value === 'string' ? value : JSON.stringify(value) })
      return BrowserCommandResult.make({ id: request.id, ok: true, ...status, detail: `${request.command._tag} completed in the isolated native browser.`, payload: value })
    } catch (error) { return BrowserCommandResult.make({ id: request.id, ok: false, error: error instanceof Error ? error.message : 'Native browser command failed.' }) }
  }

  inspect(): Promise<BrowserInspection> {
    return this.serial(async () => {
      const page = this.ownedPage()
      return { text: (await page.locator('body').innerText()).slice(0, 20000), accessibility: (await page.locator('body').ariaSnapshot()).slice(0, 20000), console: [...this.consoleLines], network: [...this.network] }
    })
  }

  private async release() {
    const context = this.context
    const browser = this.browser
    this.clearRefs(); this.responses.clear(); this.dialog = null; this.lastFrame = null
    this.page = null; this.context = null; this.browser = null
    this.consoleLines = []; this.network = []
    try { await context?.close() } finally { await browser?.close() }
  }

  disconnect() {
    this.closing = true
    return this.serial(async () => { try { await this.release() } finally { this.closing = false } })
  }
}
