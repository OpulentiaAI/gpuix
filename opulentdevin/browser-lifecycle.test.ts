import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, flushSync, handleGpuixEvent, type NativeRenderer } from '@gpuix/react'
import { BrowserPane, BrowserImage } from './browser'
import { NativeBrowserHost } from './browser-host'
import * as browserHost from './browser-host'
import type { Backend } from './backend'
import { AgentSessionId } from './zuse-runtime/packages/contracts/src/ids'

const frame = { bytes: Buffer.from('fixture'), width: 960, height: 600, url: 'data:', title: 'Lifecycle fixture' }
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
function harness() {
  const ids = new Map<string, number>()
  const renderer: NativeRenderer = { applyBatch: raw => { const mutations: unknown[][] = JSON.parse(raw); const destroyed: number[] = []; for (const [kind, id, key, value] of mutations) { if (kind === 'setCustomProp' && key === 'testId' && typeof id === 'number' && typeof value === 'string') ids.set(value, id); if (kind === 'destroyElement' && typeof id === 'number') { destroyed.push(id); for (const [name, node] of ids) if (node === id) ids.delete(name) } }; return destroyed }, setImage: vi.fn() }
  const root = createRoot(renderer)
  const render = async (active: boolean, sessionId = 'session-a', backend?: Backend) => { flushSync(() => root.render(React.createElement(BrowserPane, { active, backend, sessionId: AgentSessionId.make(sessionId), onError: vi.fn() }))); await Promise.resolve(); flushSync() }
  const connect = async () => { const id = ids.get('browser-connect'); expect(id).toBeTypeOf('number'); flushSync(() => { handleGpuixEvent({ elementId: id!, eventType: 'click' }, renderer) }); await Promise.resolve(); await Promise.resolve(); flushSync() }
  return { root, render, connect, ids }
}
describe('BrowserPane visibility lifetime', () => {
  it('translates native press/release into one bounded drag without duplicate click', () => {
    let surface = 0
    const inputs = vi.fn()
    const renderer: NativeRenderer = { applyBatch: raw => { for(const [kind,id,key,value] of JSON.parse(raw)) if(kind==='setCustomProp'&&key==='testId'&&value==='browser-surface')surface=id;return [] },setImage:vi.fn(),focusElement:vi.fn(),getElementBounds:()=>({x:0,y:0,width:720,height:450}) }
    const root=createRoot(renderer)
    try {
      flushSync(()=>root.render(React.createElement(BrowserImage,{frame,onInput:inputs})))
      for(const event of [{eventType:'mouseDown',x:10,y:20},{eventType:'mouseMove',x:80,y:90},{eventType:'mouseUp',x:100,y:120},{eventType:'click',x:100,y:120}])flushSync(()=>{handleGpuixEvent({elementId:surface,...event,button:0},renderer)})
      expect(inputs).toHaveBeenCalledOnce();expect(inputs.mock.calls[0][0]).toMatchObject({kind:'drag',from:{x:10*960/720,y:20*600/450},to:{x:100*960/720,y:120*600/450}})
    }finally{root.unmount()}
  })
  it('keeps command ownership while hidden and releases it on backend change', async () => {
    vi.spyOn(NativeBrowserHost.prototype, 'connect').mockResolvedValue(frame)
    const disconnect = vi.spyOn(NativeBrowserHost.prototype, 'disconnect').mockResolvedValue()
    const unregister = vi.fn()
    const register = vi.spyOn(browserHost, 'registerNativeBrowserCommands').mockReturnValue(unregister)
    const first = {} as Backend
    const second = {} as Backend
    const h = harness()
    try {
      await h.render(true, 'session-a', first); await h.connect(); await vi.waitFor(() => expect(register).toHaveBeenCalledOnce())
      await h.render(false, 'session-a', first); expect(unregister).not.toHaveBeenCalled(); expect(disconnect).not.toHaveBeenCalled()
      await h.render(true, 'session-a', first); expect(register).toHaveBeenCalledOnce()
      await h.render(false, 'session-a', second); expect(unregister).toHaveBeenCalledOnce(); expect(disconnect).toHaveBeenCalledOnce()
    } finally { h.root.unmount() }
  })
  it('hides native views and pauses polling without disconnecting, then resumes', async () => {
    vi.useFakeTimers()
    const connect = vi.spyOn(NativeBrowserHost.prototype, 'connect').mockResolvedValue(frame)
    const disconnect = vi.spyOn(NativeBrowserHost.prototype, 'disconnect').mockResolvedValue()
    const capture = vi.spyOn(NativeBrowserHost.prototype, 'frame').mockResolvedValue(frame)
    const h = harness()
    try {
      await h.render(true); await h.connect(); expect(connect).toHaveBeenCalledOnce()
      await h.render(false); expect(h.ids.has('browser-pane')).toBe(false); expect(h.ids.has('browser-image')).toBe(false)
      await vi.advanceTimersByTimeAsync(3000); expect(capture).not.toHaveBeenCalled(); expect(disconnect).not.toHaveBeenCalled()
      await h.render(true); await vi.advanceTimersByTimeAsync(800); expect(capture).toHaveBeenCalledOnce(); expect(connect).toHaveBeenCalledOnce()
    } finally { h.root.unmount() }
    expect(disconnect).toHaveBeenCalledOnce()
  })
  it('closes the owned context on session change even while hidden', async () => {
    vi.spyOn(NativeBrowserHost.prototype, 'connect').mockResolvedValue(frame)
    const disconnect = vi.spyOn(NativeBrowserHost.prototype, 'disconnect').mockResolvedValue()
    const h = harness()
    try { await h.render(true); await h.connect(); await h.render(false); await h.render(false, 'session-b'); expect(disconnect).toHaveBeenCalledOnce(); await h.render(true, 'session-b'); expect(h.ids.has('browser-image')).toBe(false) } finally { h.root.unmount() }
    expect(disconnect).toHaveBeenCalledOnce()
  })
})
