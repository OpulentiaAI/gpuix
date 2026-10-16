import { describe, it, expect } from 'vitest'
import { modelPatch, readNamedCredential, publicHttpsUrl, sshTarget, mcpAddArguments } from './settings-safe'
import type { SettingsFile } from './zuse-runtime/packages/contracts/src/settings'
import { readFileSync } from 'node:fs'

const settings = { defaultModelByProvider: { claude: 'old', codex: 'keep' }, modelEnabledByProvider: { claude: { old: true }, codex: { keep: true } }, customModelIdsByProvider: { claude: ['custom'], codex: ['keep'] } } as unknown as SettingsFile

describe('typed native settings patches', () => {
  it('changes only the selected model default and preserves other providers', () => { expect(modelPatch(settings, 'claude', 'default', 'new')).toEqual({ defaultModelByProvider: { claude: 'new', codex: 'keep' } }) })
  it('preserves other visibility values', () => { expect(modelPatch(settings, 'claude', 'visibility', 'new', false)).toEqual({ modelEnabledByProvider: { claude: { old: true, new: false }, codex: { keep: true } } }) })
  it('deduplicates custom model IDs and prevents deleting the default', () => { expect(modelPatch(settings, 'claude', 'add', 'custom').customModelIdsByProvider?.claude).toEqual(['custom']); expect(() => modelPatch(settings, 'claude', 'remove', 'old')).toThrow() })
  it('rejects blank and multiline model IDs', () => { expect(() => modelPatch(settings, 'claude', 'add', '')).toThrow(); expect(() => modelPatch(settings, 'claude', 'add', 'bad\nvalue')).toThrow() })
})
describe('credential and host boundaries', () => {
  it('only accepts a named environment binding and never includes its value in an error', () => { expect(readNamedCredential('TEST_KEY', { TEST_KEY: 'example-only' })).toBe('example-only'); expect(() => readNamedCredential('missing', {})).toThrow('environment variable name'); expect(() => readNamedCredential('TEST_KEY', {})).toThrow('unavailable') })
  it('rejects secret-bearing and non-HTTPS endpoint URLs', () => { for (const url of ['http://example.com', 'https://u:p@example.com', 'https://example.com?token=value', 'https://example.com#secret']) expect(() => publicHttpsUrl(url)).toThrow(); expect(publicHttpsUrl('https://example.com/mcp')).toBe('https://example.com/mcp') })
  it('rejects SSH option/shell injection and invalid ports', () => { for (const host of ['-oProxyCommand=x', 'x;touch a', 'a b', 'a\nb']) expect(() => sshTarget(host, '', '')).toThrow(); expect(() => sshTarget('host', 'x;id', '')).toThrow(); expect(() => sshTarget('host', '', '65536')).toThrow(); expect(sshTarget('work-box', 'dev', '22')).toEqual({ alias: 'work-box', hostname: 'work-box', username: 'dev', port: 22 }) })
  it('builds fixed MCP argv with no shell, header or arbitrary command surface', () => { expect(mcpAddArguments('claude', 'example', 'https://example.com/mcp')).toEqual(['mcp', 'add', '--transport', 'http', '--scope', 'user', 'example', 'https://example.com/mcp']); expect(() => mcpAddArguments('codex', '--help', 'https://example.com')).toThrow() })
})
describe('native capability surface', () => {
  it('has explicit cloud/provider/SSH actions and does not pretend RPC access equals parity', () => { const settings = readFileSync(new URL('./settings.tsx', import.meta.url), 'utf8'); expect(settings).toContain('Backend RPC availability is not UI parity'); expect(settings).toContain("tab === 'Cloud'"); expect(settings).toContain("tab === 'Models'"); expect(settings).toContain("tab === 'Host setup'") })
  it('uses a native flex layout and test IDs for shared action controls', () => { const source = readFileSync(new URL('./settings-controls.tsx', import.meta.url), 'utf8'); expect(source).toContain("display: 'flex'"); expect(source).toContain('testId='); expect(source).not.toContain('document.'); expect(source).not.toContain('localStorage') })
})
