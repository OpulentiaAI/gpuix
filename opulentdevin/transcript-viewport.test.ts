import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { transcriptRows } from './transcript'
import { listIsAtEnd } from './transcript-viewport'

describe('native transcript viewport', () => {
  it('keeps every message a distinct keyed virtual row through history prepends', () => {
    const message = (id: string) => createElement('div', { key: id }, id)
    const previous = transcriptRows([false, null, [message('a'), message('b')], [message('question')]])
    const next = transcriptRows([false, null, [message('older'), message('a'), message('b')], [message('question')]])
    expect(previous).toHaveLength(3)
    expect(next).toHaveLength(4)
    expect(next.slice(1).map(row => row.key)).toEqual(previous.map(row => row.key))
    expect(new Set(next.map(row => row.key)).size).toBe(4)
  })
  it('keeps authority rows distinct when a status banner is inserted', () => {
    const message = createElement('div', { key: 'message' })
    const permission = createElement('div', { key: 'permission' })
    const before = transcriptRows([false, null, [message], [permission]])
    const after = transcriptRows([createElement('text', null, 'error'), createElement('text', null, 'cached'), [message], [permission]])
    expect(after.slice(2).map(row => row.key)).toEqual(before.map(row => row.key))
  })
  it('reads native at-end sentinel rather than guessing from the visible final row', () => {
    expect(listIsAtEnd([100, 0, 500], 100)).toBe(true)
    expect(listIsAtEnd([99, 100, 500], 100)).toBe(false)
    expect(listIsAtEnd([10, -20, 500], 100)).toBe(false)
    expect(listIsAtEnd(null, 100)).toBe(false)
    expect(listIsAtEnd(null, 0)).toBe(true)
  })
  it('uses one actual GPUI virtual list, native follow and keyed prepend anchoring', () => {
    const source = readFileSync(new URL('./transcript-viewport.tsx', import.meta.url), 'utf8')
    expect(source.match(/<virtual-list\b/g)).toHaveLength(1)
    expect(source).toContain('alignment="bottom" followTail')
    expect(source).toContain('key={row.key}')
    expect(source).toContain('renderer.scrollToItem(list.current.id, rows.length)')
    expect(source).not.toMatch(/overflow(?:Y|X)?:\s*['"]scroll/)
    expect(source).not.toContain('itemCount=')
    expect(source).toContain('<Transcript {...props} renderRows={renderRows}')
    expect(source).toContain("phase !== 'live'")
  })
})
