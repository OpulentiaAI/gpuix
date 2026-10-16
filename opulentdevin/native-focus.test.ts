import { describe, expect, it, vi } from 'vitest'
import type { KeyEvent } from '@gpuix/native/host'
import { activateSidebarKey } from './devin-sidebar'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

function event(key: string, extra: Partial<KeyEvent> = {}): KeyEvent { return { elementId: 1, eventType: 'keyDown', key, defaultPrevented: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra } }
describe('native sidebar keyboard accessibility', () => {
  it.each(['enter', 'Enter', 'return', ' ', 'space'])('activates %j once after consuming the key', key => { const order: string[] = []; const e = event(key, { preventDefault: () => { order.push('prevent') }, stopPropagation: () => { order.push('stop') } }); activateSidebarKey(e, () => { order.push('activate') }); expect(order).toEqual(['prevent', 'stop', 'activate']) })
  it('ignores unrelated, already handled and command-modified keys', () => { for (const e of [event('tab'), event('escape'), event('enter', { defaultPrevented: true }), event('enter', { modifiers: { ctrl: true, cmd: false, alt: false, shift: false } }), event('space', { modifiers: { ctrl: false, cmd: true, alt: false, shift: false } })]) { const action = vi.fn(); activateSidebarKey(e, action); expect(action).not.toHaveBeenCalled(); expect(e.preventDefault).not.toHaveBeenCalled() } })
  it('all three focusable sidebar control types have token-based non-layout outlines', () => {
    const file = ts.createSourceFile('devin-sidebar.tsx', readFileSync(new URL('./devin-sidebar.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const controls: ts.JsxOpeningElement[] = []
    const visit = (node: ts.Node) => { if (ts.isJsxOpeningElement(node) && node.attributes.properties.some(p => ts.isJsxAttribute(p) && p.name.getText(file) === 'tabIndex')) controls.push(node); ts.forEachChild(node, visit) }; visit(file)
    expect(controls).toHaveLength(3)
    for (const control of controls) {
      const style = control.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(file) === 'style') as ts.JsxAttribute
      const object = (style.initializer as ts.JsxExpression).expression as ts.ObjectLiteralExpression
      const focus = object.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(file) === 'focusVisible') as ts.PropertyAssignment
      expect(focus.initializer.getText(file)).toBe('{ outlineWidth: 2, outlineColor: p.accent, outlineOffset: -2 }')
      expect(focus.initializer.getText(file)).not.toMatch(/padding|borderWidth|height|width:/)
      expect(control.attributes.getText(file)).toContain('activateSidebarKey(event,')
    }
  })
})
