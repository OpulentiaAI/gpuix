import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QuitGuard, inspectQuit, validateShellLink, acquireShellInstance, checkApplicationRelease, releaseOptions, awakeCommand, inspectAwakeSupport } from './host'
import { isActivationKey } from './theme-context'
import { readFileSync } from 'node:fs'

describe('guarded quit', () => {
  it('blocks active agents unless explicitly confirmed and calls cleanup once', async () => { const quit = vi.fn(async () => {}); const guard = new QuitGuard(() => [], quit, async () => ({ active: 2, environments: 1, checkedAt: 1 })); await expect(guard.request()).rejects.toThrow(); expect(quit).not.toHaveBeenCalled(); await guard.request(true); await guard.request(true); expect(quit).toHaveBeenCalledTimes(1) })
  it('refuses unknown empty scope', async () => { await expect(inspectQuit([])).rejects.toThrow() })
  it('checks again when idle and cancels the timer', async () => { vi.useFakeTimers(); const quit = vi.fn(async () => {}); let active = 1; const guard = new QuitGuard(() => [], quit, async () => ({ active, environments: 1, checkedAt: 1 })); guard.whenIdle(() => {}); await vi.advanceTimersByTimeAsync(10); expect(quit).not.toHaveBeenCalled(); active = 0; await vi.advanceTimersByTimeAsync(3000); expect(quit).toHaveBeenCalledTimes(1); guard.dispose(); vi.useRealTimers() })
})
describe('native shell boundaries', () => {
  it('validates pairing routes without dispatching auth or executable links', () => { expect(validateShellLink('zuse:///connect/pair?pairingUrl=wss%3A%2F%2Fexample.com%2Frpc#token=ABCDEFGH').kind).toBe('remote'); for (const value of ['zuse://auth/callback?code=secret', 'javascript:alert(1)', 'https://u:p@example.com/#pair=ABCDEFGH', 'http://public.example.com/#pair=ABCDEFGH', 'zuse:///connect/pair?pairingUrl=ws%3A%2F%2Flocalhost#token=%ZZ']) expect(() => validateShellLink(value)).toThrow() })
  it('enforces one owner without deleting an existing lock', async () => { const path = await mkdtemp(join(tmpdir(), 'native-shell-test-')); try { const owner = await acquireShellInstance(path); await expect(acquireShellInstance(path)).rejects.toThrow(); await owner.release(); const next = await acquireShellInstance(path); await next.release() } finally { await rm(path, { recursive: true, force: true }) } })
  it('checks signed feed metadata without exposing/installing update object', async () => { const install = vi.fn(); const check = vi.fn(async () => ({ version: '2.0.0', date: null, format: 'appimage', downloadAndInstall: install })); const result = await checkApplicationRelease({ currentVersion: '1.0.0', endpoints: ['https://example.com/{{target}}'], publicKey: 'public-key' }, check); expect(result.available).toBe(true); expect(install).not.toHaveBeenCalled(); expect(result).not.toHaveProperty('downloadAndInstall'); expect(() => releaseOptions({ currentVersion: '1.0.0', endpoints: ['http://example.com'], publicKey: 'key' })).toThrow() })
  it('gates unsupported power platforms and uses fixed argv', async () => { expect((await inspectAwakeSupport('win32', async () => true)).supported).toBe(false); expect(awakeCommand('darwin', 123).args).toEqual(['-i', '-w', '123']); expect(awakeCommand('linux', 123).program).toBe('/usr/bin/systemd-inhibit'); expect(() => awakeCommand('win32', 123)).toThrow() })
  it('normalises native Enter and uses context-local palettes', () => { for (const key of ['Enter', 'enter', 'return', ' ', 'space']) expect(isActivationKey(key)).toBe(true); expect(isActivationKey('escape')).toBe(false); for (const file of ['settings.tsx', 'settings-controls.tsx']) { const source = readFileSync(new URL(file, import.meta.url), 'utf8'); expect(source).not.toContain('palettes.dark'); expect(source).toContain('usePalette()'); expect(source).toContain('isActivationKey(event.key)') } })
})
