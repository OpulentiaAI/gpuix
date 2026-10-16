import { describe, expect, it } from 'vitest'
import { filterCommands } from './commands'
import { loadPreferences, savePreferences } from './preferences'
import { mkdtempSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('native command navigation and preferences', () => {
  it('filters across label and metadata without executing commands', () => {
    let called = false
    const commands = [{ id: 'a', label: 'Open workspace', detail: 'Local folder', execute: () => { called = true } }]
    expect(filterCommands(commands, 'workspace local')).toEqual(commands)
    expect(filterCommands(commands, 'cloud')).toEqual([])
    expect(called).toBe(false)
  })
  it('restores real persisted interface state with private file permissions', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'opulentdevin-preferences-')), 'ui.json')
    const expected = { theme: 'light' as const, sidebar: false, workspaceId: 'workspace', sessionId: 'session' }
    savePreferences(expected, path)
    expect(loadPreferences(path)).toEqual(expected)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})
