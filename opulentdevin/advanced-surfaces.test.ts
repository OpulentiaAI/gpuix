import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseUsageDate } from './advanced-surfaces'
import { notificationArguments } from './advanced-host'

describe('advanced service boundaries', () => {
  it('validates UTC calendar filters without normalising impossible dates', () => {
    expect(parseUsageDate('')).toBeUndefined()
    expect(parseUsageDate('2024-02-29')?.toISOString()).toBe('2024-02-29T00:00:00.000Z')
    expect(() => parseUsageDate('2025-02-29')).toThrow()
    expect(() => parseUsageDate('10/12/2026')).toThrow()
  })
  it('uses fixed argv and ends options before user-controlled notification text', () => {
    expect(notificationArguments('--unsafe', '$(ignored)')).toEqual(['--app-name=OpulentDevin', '--', '--unsafe', '$(ignored)'])
    expect(() => notificationArguments('', 'body')).toThrow()
    expect(() => notificationArguments('title', 'x\u0000y')).toThrow()
    expect(() => notificationArguments('title', 'x'.repeat(2001))).toThrow()
  })
  it('has explicit service panels and guarded effect controls rather than generic RPC JSON UI', () => {
    const source = readFileSync(new URL('./advanced-surfaces.tsx', import.meta.url), 'utf8')
    for (const name of ['Diagnostics', 'Usage', 'Analytics', 'Skills', 'Linear', 'Previews', 'Notifications']) expect(source).toContain(`function ${name}(`)
    for (const tag of ['diagnostics.overview', 'diagnostics.events', 'diagnostics.capture', 'diagnostics.export', 'diagnostics.signalProcess', 'usage.report', 'analytics.getContext', 'skill.listForProject', 'linear.prepareContext', 'previews.listServers']) expect(source).toContain(`['${tag}']`)
    expect(source).toContain('ConfirmAction')
    expect(source).not.toContain('JSON.stringify')
    expect(source).not.toContain('context.distinctId')
    expect(source).toContain('!onPreview')
    expect(source).toContain('!onLinearContext')
  })
})
