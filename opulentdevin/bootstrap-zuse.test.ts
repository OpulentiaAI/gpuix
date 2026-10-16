import { describe, expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { applicationRoot, resolveZuseRoot, verifyZuse, ZUSE_REVISION } from './bootstrap-zuse.ts'

describe('pinned Zuse bootstrap', () => {
  it('resolves the same development backend from source and built entrypoints', () => {
    const source = pathToFileURL('/project/gpuix/opulentdevin/backend.ts').href
    const built = pathToFileURL('/project/gpuix/opulentdevin/dist/main.js').href
    expect(applicationRoot(source)).toBe('/project/gpuix/opulentdevin')
    expect(applicationRoot(built)).toBe('/project/gpuix/opulentdevin')
    expect(resolveZuseRoot(source, '')).toBe('/project/zuse')
    expect(resolveZuseRoot(built, '')).toBe('/project/zuse')
    expect(resolveZuseRoot(built, '/opt/pinned-zuse')).toBe('/opt/pinned-zuse')
  })
  it('verifies the actual pinned clean checkout and rejects an absent backend', () => {
    expect(ZUSE_REVISION).toMatch(/^[0-9a-f]{40}$/)
    expect(verifyZuse(resolveZuseRoot())).toBe(resolveZuseRoot())
    expect(() => verifyZuse('/nonexistent/opulentdevin-zuse')).toThrow('run bun bootstrap-zuse.ts')
  })
})
