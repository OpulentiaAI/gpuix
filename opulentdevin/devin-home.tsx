import type { ReactNode } from 'react'
import type { Palette } from './theme'

export function DevinHome({ composer, palette, title, subtitle, children }: { composer: ReactNode; palette: Palette; title?: string; subtitle?: string; children?: ReactNode }) {
  return <div testId="devin-home" style={{ display: 'flex', flexDirection: 'column', width: '100%', flexGrow: 1, minHeight: 0, alignItems: 'center', overflowY: 'scroll', paddingLeft: 24, paddingRight: 24, backgroundColor: palette.page }}><div style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 700, paddingTop: 64, paddingBottom: 64, gap: 24 }}>{title && <text style={{ color: palette.text, fontSize: 22, lineHeight: 28, fontWeight: 500 }}>{title}</text>}{subtitle && <text style={{ color: palette.secondary, fontSize: 14, lineHeight: 20 }}>{subtitle}</text>}{composer}{children}</div></div>
}

export function DevinComposerShell({ editor, controls, context, palette, mode = 'thread' }: { editor: ReactNode; controls: ReactNode; context?: ReactNode; palette: Palette; mode?: 'home' | 'thread' }) {
  return <div style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: mode === 'home' ? 700 : 740, flexShrink: 0, paddingLeft: mode === 'thread' ? 8 : 0, paddingRight: mode === 'thread' ? 8 : 0, paddingBottom: 8 }}><div testId="composer-shell" style={{ display: 'flex', flexDirection: 'column', borderRadius: 20, backgroundColor: palette.elevated, borderWidth: 0, boxShadow: { offsetX: 0, offsetY: 1, blurRadius: 3, spreadRadius: 0, color: palette.page === '#141414' ? '#00000040' : '#0000000f' }, padding: 12, gap: 4 }}><div style={{ display: 'flex', flexDirection: 'column', minHeight: 54, padding: 4 }}>{editor}</div>{context}<div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 28, gap: 12 }}>{controls}</div></div></div>
}
