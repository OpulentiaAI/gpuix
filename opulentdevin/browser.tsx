import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useGpuix, type ImgInstance, type PublicInstance, type EventPayload } from '@gpuix/react'
import { NativeBrowserHost, registerNativeBrowserCommands, browserKey, browserPoint, browserTestPage, type BrowserFrame, type BrowserInput, type BrowserInspection } from './browser-host'
import type { Backend } from './backend'
import type { AgentSessionId } from './zuse-runtime/packages/contracts/src/ids'
import { palettes, type Palette } from './theme'

export function BrowserImage({ frame, onInput, width = 720, height = 450 }: { frame: BrowserFrame; onInput: (input: BrowserInput) => void; width?: number; height?: number }) {
  const image = useRef<ImgInstance>(null)
  const surface = useRef<PublicInstance>(null)
  const { renderer } = useGpuix()
  useLayoutEffect(() => { image.current?.setImage(frame.bytes) }, [frame])
  function point(event: EventPayload) {
    const bounds = image.current && renderer?.getElementBounds?.(image.current.id)
    return bounds && event.x !== undefined && event.y !== undefined ? browserPoint(event.x, event.y, bounds, frame) : null
  }
  function click(event: EventPayload) {
    const position = point(event)
    if (!position) return
    if (surface.current) renderer?.focusElement?.(surface.current.id)
    onInput({ kind: 'click', ...position, count: event.clickCount ?? 1, button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left' })
  }
  return <div ref={surface} testId="browser-surface" tabIndex={0} style={{ width, height, flexShrink: 0 }} onClick={click} onAuxClick={click} onKeyDown={event => { const input = browserKey(event); if (input) onInput(input) }} onScroll={event => {
    const position = point(event)
    if (position) onInput({ kind: 'scroll', ...position, deltaX: -(event.deltaX ?? 0) * (event.precise ? 1 : 40), deltaY: -(event.deltaY ?? 0) * (event.precise ? 1 : 40) })
  }}><img ref={image} testId="browser-image" alt="Live isolated browser page" objectFit="fill" style={{ width, height }} /></div>
}

export function BrowserPane({ onError, palette = palettes.dark, backend, sessionId, initialUrl, active = true }: { onError: (message: string) => void; palette?: Palette; backend?: Backend; sessionId?: AgentSessionId; initialUrl?: string; active?: boolean }) {
  const host = useRef<NativeBrowserHost | null>(null)
  const mounted = useRef(true)
  const [frame, setFrame] = useState<BrowserFrame | null>(null)
  const [address, setAddress] = useState(initialUrl ?? '')
  useEffect(() => { if (initialUrl !== undefined) setAddress(initialUrl) }, [initialUrl])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('Disconnected — no tabs or cookies are accessed.')
  const [inspection, setInspection] = useState<BrowserInspection | null>(null)
  const [tab, setTab] = useState<'text' | 'accessibility' | 'console' | 'network'>('text')
  const [capturePath, setCapturePath] = useState('')
  const [text, setText] = useState('')
  const button = { paddingLeft: 10, paddingRight: 10, paddingTop: 7, paddingBottom: 7, backgroundColor: palette.elevated, color: palette.text, borderRadius: 5, cursor: 'pointer' as const }
  useEffect(() => {
    setFrame(null); setInspection(null); setBusy(false); setStatus('Disconnected — no tabs or cookies are accessed.'); setCapturePath(''); setText('')
    return () => { const current = host.current; host.current = null; void current?.disconnect().catch(() => {}) }
  }, [backend, sessionId])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; const current = host.current; host.current = null; void current?.disconnect().catch(() => {}) } }, [])
  function failure(error: unknown) { const message = error instanceof Error ? error.message : 'Browser action failed.'; if (mounted.current) { setStatus(message); onError(message) } }
  async function run(action: (browser: NativeBrowserHost) => Promise<unknown>) {
    const current = host.current
    if (!current || busy) return
    setBusy(true)
    try { await action(current); const next = await current.frame(); if (mounted.current && host.current === current) { setFrame(next); setStatus(next.title || 'Connected') } }
    catch (error) { failure(error) }
    finally { if (mounted.current) setBusy(false) }
  }
  async function connect() {
    if (host.current || busy) return
    const current = new NativeBrowserHost()
    host.current = current; setBusy(true)
    try { const next = await current.connect(); if (mounted.current && host.current === current) { setFrame(next); setStatus('Connected to a fresh isolated page') } }
    catch (error) { if (host.current === current) { host.current = null; failure(error) } }
    finally { if (mounted.current && (host.current === current || host.current === null)) setBusy(false) }
  }
  async function disconnect() {
    const current = host.current
    host.current = null; setFrame(null); setInspection(null); setBusy(true)
    try { await current?.disconnect(); if (mounted.current) setStatus('Disconnected — isolated context closed. Existing browser preserved.') }
    catch (error) { failure(error) }
    finally { if (mounted.current) setBusy(false) }
  }
  useEffect(() => {
    if (!frame || !backend || !sessionId || !host.current) return
    try { return registerNativeBrowserCommands(backend, sessionId, host.current, onError) } catch (error) { failure(error) }
  }, [backend, sessionId, Boolean(frame)])
  useEffect(() => {
    if (!frame || !active) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      const current = host.current
      if (!current || cancelled) return
      try { const next = await current.frame(); if (!cancelled && mounted.current && host.current === current) setFrame(next) }
      catch (error) {         if (!cancelled) { host.current = null; setFrame(null); setInspection(null); void current.disconnect().catch(() => {}); failure(error) }; return }
      if (!cancelled) timer = setTimeout(refresh, 750)
    }
    timer = setTimeout(refresh, 750)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [Boolean(frame), active])
  const inspectionText = !inspection ? '' : tab === 'text' ? inspection.text : tab === 'accessibility' ? inspection.accessibility : tab === 'console' ? inspection.console.join('\n') : inspection.network.map(entry => `${entry.method} ${entry.status ?? entry.failed ?? 'pending'} ${entry.url}`).join('\n')
  if (!active) return null
  return <div testId="browser-pane" style={{ flexGrow: 1, minWidth: 0, minHeight: 0, backgroundColor: palette.page, color: palette.text, padding: 12, gap: 10, overflow: 'scroll' }}>
    <div style={{ flexDirection: 'row', gap: 8 }}>
      <div testId="browser-connect" style={button} onClick={() => void connect()}>{busy ? 'Working…' : frame ? 'Connected' : 'Connect local Chromium'}</div>
      <div testId="browser-disconnect" style={button} onClick={() => void disconnect()}>Disconnect</div>
      <div style={{ color: palette.muted, fontSize: 12 }}>Explicit OPULENTDEVIN_BROWSER_CDP required</div>
    </div>
    <div style={{ color: palette.muted, fontSize: 12 }}>{status}</div>
    {capturePath && <div style={{ color: palette.muted, fontSize: 11 }}>Saved private capture: {capturePath}</div>}
    {frame && <>
      <div style={{ flexDirection: 'row', gap: 6 }}>
        {(['back', 'forward', 'reload'] as const).map(action => <div key={action} testId={`browser-${action}`} style={button} onClick={() => void run(browser => browser.command({ _tag: 'History', action }))}>{action === 'back' ? 'Back' : action === 'forward' ? 'Forward' : 'Reload'}</div>)}
        <input testId="browser-address" value={address} placeholder="Enter an explicit http(s) URL" style={{ width: 310, backgroundColor: palette.elevated, color: palette.text, padding: 6 }} onChange={event => setAddress(event.value ?? '')} onSubmit={() => void run(browser => browser.command({ _tag: 'Navigate', url: address }))} />
        <div style={button} onClick={() => void run(browser => browser.command({ _tag: 'Navigate', url: address }))}>Go</div>
        <div style={button} onClick={() => void run(browser => browser.command({ _tag: 'Navigate', url: browserTestPage }))}>Test page</div>
      </div>
      <div style={{ color: palette.muted, fontSize: 11 }}>{frame.url}</div>
      {host.current?.pendingDialog() && <div style={{ gap: 6 }}><text>{host.current.pendingDialog()?.message}</text><div style={{ flexDirection: 'row', gap: 8 }}>{(['accept', 'dismiss'] as const).map(action => <div key={action} style={button} onClick={() => { const current = host.current; if (current) void current.command({ _tag: 'Dialog', action, promptText: action === 'accept' ? text : undefined }).catch(failure) }}>{action === 'accept' ? 'Accept dialog (text field supplies prompt)' : 'Dismiss dialog'}</div>)}</div></div>}
      <BrowserImage frame={frame} onInput={input => { const current = host.current; if (current) void current.input(input).catch(failure) }} />
      <div style={{ flexDirection: 'row', gap: 8 }}>
        <input testId="browser-text" value={text} placeholder="Unicode text to insert into the focused page field" style={{ width: 440, backgroundColor: palette.elevated, color: palette.text, padding: 7 }} onChange={event => setText(event.value ?? '')} onSubmit={() => void run(browser => browser.input({ kind: 'text', text }))} />
        <div style={button} onClick={() => void run(browser => browser.input({ kind: 'text', text }))}>Insert text</div>
        <div style={button} onClick={() => void run(async browser => { const result = await browser.inspect(); if (mounted.current) setInspection(result) })}>Inspect</div>
        <div style={button} onClick={() => void run(browser => browser.command({ _tag: 'RecordingStart' }))}>Start recording (60s limit)</div>
        <div style={button} onClick={() => void run(async browser => { const result = await browser.command({ _tag: 'RecordingStop' }) as {path:string}; if(mounted.current) setCapturePath(result.path) })}>Stop and save recording</div>
        <div style={button} onClick={() => void run(browser => browser.command({ _tag: 'Overlay', action: 'clear' }))}>Clear overlays</div>
        <div style={button} onClick={() => void run(async browser => { const path = await browser.command({ _tag: 'Screenshot' }); if (mounted.current) setCapturePath(String(path)) })}>Save capture</div>
      </div>
      {inspection && <div style={{ gap: 8 }}><div style={{ flexDirection: 'row', gap: 6 }}>{(['text', 'accessibility', 'console', 'network'] as const).map(name => <div key={name} style={{ ...button, backgroundColor: name === tab ? palette.selected : palette.elevated }} onClick={() => setTab(name)}>{name}</div>)}</div><div style={{ maxHeight: 240, overflow: 'scroll', padding: 10, backgroundColor: palette.wash }}><text style={{ fontFamily: 'monospace', fontSize: 12 }}>{inspectionText || 'No entries.'}</text></div></div>}
    </>}
    <div style={{ color: palette.muted, fontSize: 12 }}>Native image bridge · refreshed every 750 ms. No imported cookies or existing tabs. Recording uses local ffmpeg, has no audio and stops after 60 seconds. Credential injection, downloads, remote forwarding, drag and IME composition are not yet supported.</div>
  </div>
}
