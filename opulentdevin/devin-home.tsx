import type { ReactNode } from 'react'
import type { Palette } from './theme'
import type { KeyEvent } from '@gpuix/native/host'
import { Icon } from './icons'
import { isActivationKey } from './theme-context'

export type DevinSendControlProps = {
  palette: Palette
  running: boolean
  hasDraft?: boolean
  disabled?: boolean
  onSend: () => void
  onStop: () => void
  onOptions?: () => void
  optionsOpen?: boolean
}

export function sendControlState(props: Pick<DevinSendControlProps, 'running' | 'hasDraft' | 'disabled' | 'onOptions'>) {
  const stopping = props.running && props.hasDraft !== true
  const disabled = Boolean(props.disabled || (!props.running && props.hasDraft === false))
  const optionsDisabled = disabled || !props.onOptions
  return { stopping, disabled, split: true, optionsDisabled, width: 54, label: stopping ? 'Stop agent' : 'Send message' }
}

export function activateSendKey(event: KeyEvent, disabled: boolean, action: () => void) {
  if (disabled || event.defaultPrevented || !isActivationKey(event.key) || event.modifiers?.ctrl || event.modifiers?.alt || event.modifiers?.cmd) return
  event.preventDefault(); event.stopPropagation(); action()
}

export function DevinSendControl(props: DevinSendControlProps) {
  const { palette: p, onSend, onStop, onOptions, optionsOpen = false } = props
  const state = sendControlState(props)
  const activate = () => { if (!state.disabled) (state.stopping ? onStop : onSend)() }
  const more = () => { if (!state.optionsDisabled) onOptions?.() }
  const tint = p.page === '#141414' ? '#00000014' : '#ffffff14'
  const focus = { outlineWidth: 1, outlineColor: p.accent, outlineOffset: -1 }
  return <div testId="send-control" style={{ display: 'flex', flexDirection: 'row', width: state.width, height: 28, flexShrink: 0, borderRadius: 9999, borderWidth: 0, backgroundColor: p.inverse, opacity: state.disabled ? 0.5 : 1 }}>
    <div testId={state.stopping ? 'stop' : 'send'} role="button" aria-label={state.label} tabIndex={state.disabled ? -1 : 0} onClick={activate} onKeyDown={event => activateSendKey(event, state.disabled, activate)} style={{ display: 'flex', width: 28, height: 28, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 9999, cursor: state.disabled ? 'default' : 'pointer', hover: { backgroundColor: state.disabled ? undefined : tint }, active: { backgroundColor: state.disabled ? undefined : tint }, focusVisible: focus }}><Icon name={state.stopping ? 'stop' : 'send'} size={18} color={p.inverseText} /></div>
    {state.split && <><div style={{ width: 1, height: 16, marginTop: 6, backgroundColor: tint, flexShrink: 0 }} /><div testId="more-send-options" role="button" aria-label="More send options" aria-expanded={optionsOpen} tabIndex={state.optionsDisabled ? -1 : 0} onClick={more} onKeyDown={event => activateSendKey(event, state.optionsDisabled, more)} style={{ display: 'flex', width: 25, height: 28, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 9999, backgroundColor: optionsOpen ? tint : undefined, opacity: !state.disabled && state.optionsDisabled ? 0.5 : 1, cursor: state.optionsDisabled ? 'default' : 'pointer', hover: { backgroundColor: state.optionsDisabled ? undefined : tint }, active: { backgroundColor: state.optionsDisabled ? undefined : tint }, focusVisible: focus }}><svg source={'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6 4 4 4-4"/></svg>'} style={{ width: 14, height: 14, color: p.inverseText }} /></div></>}
  </div>
}

export function DevinHome({ composer, palette, title, subtitle, children }: { composer: ReactNode; palette: Palette; title?: string; subtitle?: string; children?: ReactNode }) {
  return <div testId="devin-home" style={{ display: 'flex', flexDirection: 'column', width: '100%', flexGrow: 1, minHeight: 0, alignItems: 'center', overflowY: 'scroll', paddingLeft: 24, paddingRight: 24, backgroundColor: palette.page }}><div style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 700, paddingTop: 64, paddingBottom: 64, gap: 24 }}>{title && <text style={{ color: palette.text, fontSize: 22, lineHeight: 28, fontWeight: 500 }}>{title}</text>}{subtitle && <text style={{ color: palette.secondary, fontSize: 14, lineHeight: 20 }}>{subtitle}</text>}{composer}{children}</div></div>
}

export function DevinComposerShell({ editor, controls, context, palette, mode = 'thread' }: { editor: ReactNode; controls: ReactNode; context?: ReactNode; palette: Palette; mode?: 'home' | 'thread' }) {
  return <div style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: mode === 'home' ? 700 : 740, flexShrink: 0, paddingLeft: mode === 'thread' ? 8 : 0, paddingRight: mode === 'thread' ? 8 : 0, paddingBottom: 8 }}><div testId="composer-shell" style={{ display: 'flex', flexDirection: 'column', borderRadius: 20, backgroundColor: palette.elevated, borderWidth: 0, boxShadow: { offsetX: 0, offsetY: 1, blurRadius: 3, spreadRadius: 0, color: palette.page === '#141414' ? '#00000040' : '#0000000f' }, padding: 12, gap: 4 }}><div style={{ display: 'flex', flexDirection: 'column', minHeight: 54, padding: 4 }}>{editor}</div>{context}<div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 28, gap: 12 }}>{controls}</div></div></div>
}
