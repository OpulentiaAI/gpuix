import { useRef, useState, type ReactNode } from 'react'
import { metrics } from './theme'
import { usePalette, isActivationKey } from './theme-context'
export function SettingsAction({ label, onClick, disabled = false, selected = false }: { label: string; onClick: () => void; disabled?: boolean; selected?: boolean }) { const c = usePalette();
  return <div testId={`settings-action-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`} role="button" aria-label={label} tabIndex={disabled ? -1 : 0} onClick={() => { if (!disabled) onClick() }} onKeyDown={event => { if (!disabled && isActivationKey(event.key)) onClick() }} style={{ display: 'flex', flexDirection: 'column', flexShrink: 0, paddingLeft: 10, paddingRight: 10, height: 30, justifyContent: 'center', borderRadius: metrics.rowRadius, backgroundColor: selected ? c.accentSoft : c.hover, borderWidth: 1, borderColor: selected ? c.accent : c.border, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1 }}><text style={{ fontSize: 12, color: selected ? c.accentText : c.text }}>{label}</text></div>
}
export function SettingsNote({ children, warning = false }: { children: ReactNode; warning?: boolean }) { const c = usePalette(); return <text style={{ fontSize: 12, color: warning ? c.warning : c.secondary }}>{children}</text> }
export function SettingsCard({ title, children }: { title: string; children: ReactNode }) { const c = usePalette(); return <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0, padding: 16, gap: 12, borderRadius: metrics.menuRadius, backgroundColor: c.elevated, borderWidth: 1, borderColor: c.border }}><text style={{ color: c.strong, fontSize: 14, fontWeight: 500 }}>{title}</text>{children}</div> }
export function SettingsField({ label, value, onChange, placeholder, disabled }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; disabled?: boolean }) { const c = usePalette(); return <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}><SettingsNote>{label}</SettingsNote><input testId={`settings-field-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`} aria-label={label} value={value} placeholder={placeholder} readOnly={disabled} onChange={event => onChange(event.value ?? '')} style={{ height: 34, padding: 8, color: c.text, backgroundColor: c.wash, borderRadius: 6 }} /></div> }
export function SettingsChoices<T extends string>({ label, value, values, onChange }: { label: string; value: T; values: readonly T[]; onChange: (value: T) => void }) { return <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}><SettingsNote>{label}</SettingsNote><div style={{ display: 'flex',  flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{values.map(option => <SettingsAction key={option} label={option} selected={option === value} onClick={() => onChange(option)} />)}</div></div> }
export function useSettingsAction(onError: (error: unknown) => void) {
  const active = useRef(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const run = async (label: string, action: () => Promise<unknown>) => {
    if (active.current) return
    active.current = true; setBusy(true); setMessage(`${label}…`)
    try { await action(); setMessage(`${label} completed`) }
    catch { const text = `${label} failed. Check connectivity, permissions and configured credentials; no raw diagnostic or secret was retained.`; setMessage(text); onError(new Error(text)) }
    finally { active.current = false; setBusy(false) }
  }
  return { busy, message, run }
}
export function ConfirmAction({ label, detail, action, disabled }: { label: string; detail: string; action: () => void; disabled?: boolean }) {
  const [confirm, setConfirm] = useState(false)
  return confirm ? <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><SettingsNote warning>{detail}</SettingsNote><div style={{ display: 'flex',  flexDirection: 'row', gap: 8 }}><SettingsAction disabled={disabled} label={`Confirm ${label}`} onClick={() => { setConfirm(false); action() }} /><SettingsAction label="Cancel" onClick={() => setConfirm(false)} /></div></div> : <SettingsAction label={label} disabled={disabled} onClick={() => setConfirm(true)} />
}
