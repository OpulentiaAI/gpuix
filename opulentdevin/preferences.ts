import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const dataDirectory = process.env.OPULENTDEVIN_DATA_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'opulentdevin')
export type Preferences = { theme: 'dark' | 'light'; sidebar: boolean; workspaceId: string | null; sessionId: string | null }
const defaults: Preferences = { theme: 'dark', sidebar: true, workspaceId: null, sessionId: null }
export function loadPreferences(path = join(dataDirectory, 'ui.json')): Preferences {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof value !== 'object' || value === null) return defaults
    return {
      theme: 'theme' in value && value.theme === 'light' ? 'light' : 'dark',
      sidebar: !('sidebar' in value && value.sidebar === false),
      workspaceId: 'workspaceId' in value && typeof value.workspaceId === 'string' ? value.workspaceId : null,
      sessionId: 'sessionId' in value && typeof value.sessionId === 'string' ? value.sessionId : null,
    }
  } catch { return defaults }
}
export function savePreferences(value: Preferences, path = join(dataDirectory, 'ui.json')) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 })
  renameSync(temporary, path)
}
