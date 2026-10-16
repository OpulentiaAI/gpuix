import { describe, expect, it, vi } from 'vitest'
import { createRoot } from '@gpuix/react'
import { createRendererState, type NativeRenderer } from '@gpuix/native/host'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { nativeAppRoot, NATIVE_MANIFEST_SHA256, verifyNativeDelivery, verifyInstalledAdapters } from './install-native'

describe('reviewed React adapter delivery', () => {
  it('installs matching React runtime and native metadata from one manifest', () => {
    const root = nativeAppRoot(); const runtime = join(root, '.native-runtime/releases', NATIVE_MANIFEST_SHA256)
    const manifest = verifyNativeDelivery(runtime)
    expect(manifest.files.some(file => file.path === 'react-runtime/dist/reconciler/reconciler.js')).toBe(true)
    expect(manifest.files.some(file => file.path === 'runtime/package.json')).toBe(true)
    expect(() => verifyInstalledAdapters(runtime, root)).not.toThrow()
    const source = readFileSync(join(runtime, 'react-source/src/reconciler/reconciler.ts'), 'utf8')
    expect(source).toContain('Always on: the Tab and Escape defaults')
  })
  it('installed createRoot enables window keydown without an app handler and routes Tab both ways', () => {
    const renderer: NativeRenderer = { applyBatch: vi.fn(() => []), setWindowKeyEvents: vi.fn(), focusNext: vi.fn(), focusPrevious: vi.fn() }
    const root = createRoot(renderer)
    try {
      expect(renderer.setWindowKeyEvents).toHaveBeenCalledWith(true, false, expect.any(Number))
      const state = createRendererState(renderer); const elementId = state.current()!.windowKeyEventId
      state.dispatch({ eventType: 'windowKeyDown', elementId, key: 'tab', keystrokeId: 1 })
      state.dispatch({ eventType: 'windowKeyDown', elementId, key: 'tab', keystrokeId: 2, modifiers: { shift: true, ctrl: false, alt: false, cmd: false } })
      expect(renderer.focusNext).toHaveBeenCalledTimes(1); expect(renderer.focusPrevious).toHaveBeenCalledTimes(1)
    } finally { root.unmount() }
  })
  it('installed root forwards opt-out rather than silently losing tabNavigation', () => {
    const renderer: NativeRenderer = { applyBatch: vi.fn(() => []), setWindowKeyEvents: vi.fn(), focusNext: vi.fn() }
    const root = createRoot(renderer, { tabNavigation: false })
    try { const state = createRendererState(renderer); state.dispatch({ eventType: 'windowKeyDown', elementId: state.current()!.windowKeyEventId, key: 'tab', keystrokeId: 1 }); expect(renderer.focusNext).not.toHaveBeenCalled() } finally { root.unmount() }
  })
})
