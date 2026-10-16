import { describe, expect, it, vi } from 'vitest'
import type { KeyEvent } from '@gpuix/native/host'
import { DevinSendControl, activateSendKey, sendControlState } from './devin-home'
import { palettes } from './theme'

const callback = () => {}
describe('Devin split send control', () => {
  it('preserves split geometry and gates options on real callback availability', () => {
    expect(sendControlState({ running: false, hasDraft: false })).toMatchObject({ stopping: false, disabled: true, split: true, width: 54 })
    expect(sendControlState({ running: false, hasDraft: true, onOptions: callback })).toMatchObject({ stopping: false, disabled: false, split: true, width: 54 })
    expect(sendControlState({ running: true, hasDraft: false, onOptions: callback })).toMatchObject({ stopping: true, disabled: false, split: true })
    expect(sendControlState({ running: true, hasDraft: true, onOptions: callback })).toMatchObject({ stopping: false, disabled: false, split: true, width: 54 })
    expect(sendControlState({ running: true, hasDraft: true })).toMatchObject({ split: true, width: 54, optionsDisabled: true })
  })
  it('calls only the appropriate real callback and preserves the 54 by 28 measured shell', () => {
    const onSend = vi.fn(), onStop = vi.fn(), onOptions = vi.fn()
    const node = DevinSendControl({ palette: palettes.dark, running: true, hasDraft: true, onSend, onStop, onOptions })
    expect(node.props.style).toMatchObject({ width: 54, height: 28, borderWidth: 0, opacity: 1, backgroundColor: palettes.dark.inverse })
    const primary = node.props.children[0]
    primary.props.onClick()
    expect(onSend).toHaveBeenCalledOnce(); expect(onStop).not.toHaveBeenCalled()
    const split = node.props.children[1].props.children
    expect(split[0].props.style.width + split[1].props.style.width + primary.props.style.width).toBe(54)
    split[1].props.onClick(); expect(onOptions).toHaveBeenCalledOnce()
    expect(split[1].props['aria-label']).toBe('More send options')
    expect(primary.props.style.focusVisible).toEqual({ outlineWidth: 1, outlineColor: palettes.dark.accent, outlineOffset: -1 })
  })
  it('dims exactly once and blocks disabled click and keyboard activation', () => {
    const onSend = vi.fn(), onStop = vi.fn()
    const node = DevinSendControl({ palette: palettes.light, running: false, hasDraft: false, onSend, onStop })
    expect(node.props.style.opacity).toBe(0.5)
    expect(node.props.children[0].props.style.opacity).toBeUndefined()
    expect(node.props.children[0].props.tabIndex).toBe(-1)
    node.props.children[0].props.onClick()
    const event = { key: 'Enter', preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyEvent
    activateSendKey(event, true, onSend)
    expect(onSend).not.toHaveBeenCalled()
  })
  it('supports unmodified Enter and Space without bubbling into composer submit', () => {
    for (const key of ['Enter', ' ']) {
      const action = vi.fn(), preventDefault = vi.fn(), stopPropagation = vi.fn()
      activateSendKey({ key, preventDefault, stopPropagation } as unknown as KeyEvent, false, action)
      expect(action).toHaveBeenCalledOnce(); expect(preventDefault).toHaveBeenCalledOnce(); expect(stopPropagation).toHaveBeenCalledOnce()
    }
    const action = vi.fn()
    activateSendKey({ key: 'Enter', modifiers: { ctrl: true }, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyEvent, false, action)
    expect(action).not.toHaveBeenCalled()
  })
  it('retains stop semantics and explicit pending disable', () => {
    const onSend = vi.fn(), onStop = vi.fn()
    const node = DevinSendControl({ palette: palettes.dark, running: true, hasDraft: false, onSend, onStop })
    node.props.children[0].props.onClick()
    expect(onStop).toHaveBeenCalledOnce(); expect(onSend).not.toHaveBeenCalled()
    expect(sendControlState({ running: true, hasDraft: true, disabled: true, onOptions: callback }).disabled).toBe(true)
  })
})
