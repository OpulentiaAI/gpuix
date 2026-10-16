import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NATIVE_BINARY_SHA256, NATIVE_MANIFEST_SHA256, verifyNativeDelivery } from './install-native'

const scratch: string[] = []
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }) })
describe('native runtime integrity', () => {
  it('pins both the binary and complete reviewed manifest', () => {
    expect(NATIVE_BINARY_SHA256).toMatch(/^[a-f0-9]{64}$/)
    expect(NATIVE_MANIFEST_SHA256).toMatch(/^[a-f0-9]{64}$/)
  })
  it('refuses a self-declared or modified delivery manifest before loading code', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-integrity-')); scratch.push(root)
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ base: 'untrusted', gpui: 'untrusted', files: [] }))
    expect(() => verifyNativeDelivery(root)).toThrow('reviewed build manifest')
  })
})
