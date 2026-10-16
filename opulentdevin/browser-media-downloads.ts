import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rename, rm } from 'node:fs/promises'
import { join, parse, resolve } from 'node:path'
import type { Browser, CDPSession, Page } from 'playwright-core'
import { dataDirectory } from './preferences'

export const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024
export type BrowserDownload = { id: string; name: string; state: 'receiving' | 'saved' | 'cancelled' | 'failed'; bytes: number; path?: string; reason?: string }
export function downloadFile(directory: string, id: string) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid Chromium download identity.')
  return join(directory, id)
}
async function privateDirectory(path: string) {
  const absolute = resolve(path)
  let current = parse(absolute).root
  for (const part of absolute.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part)
    try { const info = await lstat(current); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Download storage must not contain symlinks.') }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') await mkdir(current, { mode: 0o700 }); else throw error }
  }
  if ((await lstat(absolute)).mode & 0o077) throw new Error('Download storage must be private.')
}
export class NativeBrowserDownloads {
  private target: CDPSession | null = null
  private ownedFrames = new Set<string>()
  private cdp: CDPSession | null = null
  private contextId = ''
  private directory = ''
  private records = new Map<string, BrowserDownload>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private pending = new Set<Promise<void>>()
  private finalising = new Set<string>()
  private enabled = false
  list() { return [...this.records.values()].map(item => ({ ...item })) }
  get active() { return this.enabled }
  async enable(browser: Browser, page: Page) {
    if (this.enabled) return
    if (this.records.size) throw new Error('Reconnect a fresh browser scope before enabling another download batch.')
    if (this.cdp) throw new Error('Download manager is still closing.')
    const target = await page.context().newCDPSession(page)
    let frameId: string
    try {
      const info = await target.send('Target.getTargetInfo')
      if (!info.targetInfo.browserContextId) throw new Error('Downloads require an isolated browser context.')
      this.contextId = info.targetInfo.browserContextId
      await target.send('Page.enable')
      target.on('Page.frameAttached', event => { if (this.ownedFrames.has(event.parentFrameId)) this.ownedFrames.add(event.frameId) })
      target.on('Page.frameNavigated', event => { if (!event.frame.parentId || this.ownedFrames.has(event.frame.parentId)) this.ownedFrames.add(event.frame.id) })
      const tree = (await target.send('Page.getFrameTree')).frameTree
      const visit = (node: typeof tree): void => { this.ownedFrames.add(node.frame.id); for (const child of node.childFrames ?? []) visit(child) }
      visit(tree); frameId = tree.frame.id; this.target = target
    } catch (error) { await target.detach(); throw error }
    await privateDirectory(join(dataDirectory, 'browser-downloads'))
    this.directory = await mkdtemp(join(dataDirectory, 'browser-downloads', 'session-')); await chmod(this.directory, 0o700)
    const cdp = await browser.newBrowserCDPSession(); this.cdp = cdp
    cdp.on('Browser.downloadWillBegin', event => {
      if (!this.ownedFrames.has(event.frameId)) return
      if (event.frameId !== frameId) {
        void cdp.send('Browser.cancelDownload', { guid: event.guid, browserContextId: this.contextId }).catch(() => {})
        return
      }
      try { downloadFile(this.directory, event.guid) } catch { return }
      if (!this.enabled || this.records.size >= 2) { void cdp.send('Browser.cancelDownload', { guid: event.guid, browserContextId: this.contextId }).catch(() => {}); return }
      const name = event.suggestedFilename.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 160)
      this.records.set(event.guid, { id: event.guid, name, state: 'receiving', bytes: 0 })
      this.timers.set(event.guid, setTimeout(() => { void this.cancel(event.guid, 'Download exceeded 30 seconds.') }, 30000))
    })
    cdp.on('Browser.downloadProgress', event => {
      const item = this.records.get(event.guid)
      if (!item || item.state !== 'receiving') return
      item.bytes = event.receivedBytes
      if (event.receivedBytes > MAX_DOWNLOAD_BYTES || event.totalBytes > MAX_DOWNLOAD_BYTES) { void this.cancel(event.guid, 'Download exceeds 10 MiB.'); return }
      if (event.state === 'canceled') { item.state = 'cancelled'; this.clearTimer(item.id); return }
      if (event.state !== 'completed' || this.finalising.has(item.id)) return
      this.finalising.add(item.id)
      const job = this.save(item).catch(() => { item.state = 'failed'; item.reason = 'Private download finalisation failed.' }).finally(() => { this.clearTimer(item.id); this.pending.delete(job); this.finalising.delete(item.id) })
      this.pending.add(job)
    })
    this.enabled = true
    try { await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', browserContextId: this.contextId, downloadPath: this.directory, eventsEnabled: true }) }
    catch (error) { this.enabled = false; await cdp.detach(); this.cdp = null; throw error }
  }
  private clearTimer(id: string) { clearTimeout(this.timers.get(id)); this.timers.delete(id) }
  private async save(item: BrowserDownload) {
    const source = downloadFile(this.directory, item.id)
    const fd = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { const info = await fd.stat(); if (!info.isFile() || info.nlink !== 1 || info.size > MAX_DOWNLOAD_BYTES) throw new Error('Invalid completed download.'); await fd.chmod(0o600); item.bytes = info.size }
    finally { await fd.close() }
    if (item.state !== 'receiving') { await rm(source, { force: true }); return }
    const path = `${source}.download`
    await rename(source, path)
    if (item.state !== 'receiving' || !this.enabled) { await rm(path, { force: true }); return }
    item.path = path; item.state = 'saved'
  }
  async cancel(id: string, reason = 'Cancelled by the user.') {
    const item = this.records.get(id)
    if (!item || item.state !== 'receiving') return
    item.state = 'cancelled'; item.reason = reason; this.clearTimer(id)
    await this.cdp?.send('Browser.cancelDownload', { guid: id, browserContextId: this.contextId }).catch(() => {})
  }
  async close() {
    this.enabled = false
    await this.target?.detach(); this.target = null; this.ownedFrames.clear()
    const cdp = this.cdp
    if (!cdp) return
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny', browserContextId: this.contextId }).catch(() => {})
    await Promise.all([...this.records.values()].filter(item => item.state === 'receiving').map(item => this.cancel(item.id, 'Browser scope closed.')))
    await Promise.all(this.pending)
    for (const item of this.records.values()) {
      if (item.state !== 'saved') {
        const path = downloadFile(this.directory, item.id)
        await rm(path, { force: true }); await rm(`${path}.crdownload`, { force: true })
      }
    }
    for (const name of await readdir(this.directory)) {
      if (/^[a-f0-9-]{36}(\.crdownload)?$/i.test(name)) await rm(join(this.directory, name), { force: true })
    }
    await cdp.detach(); this.cdp = null
  }
}
