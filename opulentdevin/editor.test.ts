import { describe, expect, it } from 'vitest'
import { findLiteral, replaceLiteral, lineColumn } from './editor'

describe('native editor text operations', () => {
  it('finds literal metacharacters without executing a regular expression', () => {
    expect(findLiteral('a.* b.*', '.*').map(match => match.start)).toEqual([1, 5])
    expect(findLiteral('abc', '')).toEqual([])
  })
  it('reports Unicode-aware match columns and CRLF line positions', () => {
    expect(lineColumn('😀x\r\ny', 2)).toEqual({ line: 1, column: 2 })
    expect(findLiteral('😀x\r\ny', 'y')[0]).toEqual({ start: 5, end: 6, line: 2, column: 1 })
  })
  it('replaces nonoverlapping matches literally, including dollar signs', () => {
    expect(replaceLiteral('aa aa', 'aa', '$&')).toEqual({ value: '$& $&', count: 2 })
    expect(replaceLiteral('Aa aA', 'aa', 'b', false)).toEqual({ value: 'b b', count: 2 })
    expect(replaceLiteral('abc', '', 'x')).toEqual({ value: 'abc', count: 0 })
    expect(replaceLiteral('aaaa', 'aa', '')).toEqual({ value: '', count: 2 })
  })
})
