import type { ProviderId } from './zuse-runtime/packages/contracts/src/agent'
import type { SettingsFile, SettingsPatch } from './zuse-runtime/packages/contracts/src/settings'

export function readNamedCredential(name: string, environment: NodeJS.ProcessEnv = process.env): string {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error('Enter an uppercase environment variable name, not a credential.')
  const value = environment[name]
  if (!value?.trim()) throw new Error('The named environment variable is unavailable.')
  return value
}
export function publicHttpsUrl(value: string): string {
  const url = new URL(value.trim())
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTPS URL without credentials, query parameters or fragments.')
  return url.href
}
export function modelPatch(settings: SettingsFile, provider: ProviderId, action: 'default' | 'visibility' | 'add' | 'remove', modelId: string, enabled = true): SettingsPatch {
  const id = modelId.trim()
  if (!id || /[\r\n\u0000]/.test(id)) throw new Error('A valid model ID is required.')
  if (action === 'default') return { defaultModelByProvider: { ...settings.defaultModelByProvider, [provider]: id } }
  if (action === 'visibility') return { modelEnabledByProvider: { ...settings.modelEnabledByProvider, [provider]: { ...settings.modelEnabledByProvider[provider], [id]: enabled } } }
  const previous = settings.customModelIdsByProvider[provider]
  if (action === 'remove' && settings.defaultModelByProvider[provider] === id) throw new Error('Choose a different default model before removing this one.')
  return { customModelIdsByProvider: { ...settings.customModelIdsByProvider, [provider]: action === 'add' ? [...new Set([...previous, id])] : previous.filter(value => value !== id) } }
}
export function presetModelPatch(settings: SettingsFile, key: string, model: string, maxTurns: string): SettingsPatch {
  const current = settings.subagents.presets[key]
  if (!current) throw new Error('Preset no longer exists')
  const turns = maxTurns.trim() ? Number(maxTurns) : undefined
  if (turns !== undefined && (!Number.isSafeInteger(turns) || turns < 1)) throw new Error('Maximum turns must be a positive integer or blank.')
  if (/[\r\n\u0000]/.test(model)) throw new Error('Invalid model ID')
  const overrides = { ...current.overrides }
  if (model.trim()) overrides.model = model.trim(); else delete overrides.model
  if (turns !== undefined) overrides.maxTurns = turns; else delete overrides.maxTurns
  return { subagents: { ...settings.subagents, presets: { ...settings.subagents.presets, [key]: { ...current, overrides } } } }
}
export function sshTarget(host: string, user: string, port: string) {
  const alias = host.trim()
  const username = user.trim() || null
  const parsedPort = port.trim() ? Number(port) : null
  if (!/^[A-Za-z0-9][A-Za-z0-9._:%-]*$/.test(alias)) throw new Error('Enter an SSH hostname or configured alias, without shell syntax.')
  if (username !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(username)) throw new Error('Invalid SSH username.')
  if (parsedPort !== null && (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535)) throw new Error('SSH port must be 1–65535.')
  return { alias, hostname: alias, username, port: parsedPort }
}
export function mcpStdioArguments(provider: 'claude' | 'codex', name: string, executable: string, argumentsText: string): readonly string[] {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error('Invalid server name')
  if (!executable.startsWith('/') || /[\r\n\u0000]/.test(executable)) throw new Error('Choose an absolute executable path without control characters.')
  const args = argumentsText ? argumentsText.split('\n').map(value => value.replace(/\r$/, '')) : []
  if (args.some(value => value.includes('\0'))) throw new Error('Arguments cannot contain NUL bytes.')
  return provider === 'claude' ? ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', name, '--', executable, ...args] : ['mcp', 'add', name, '--', executable, ...args]
}
export function mcpAddArguments(provider: 'claude' | 'codex', name: string, endpoint: string): readonly string[] {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error('Use a server name beginning with a letter, with letters, digits, underscores or hyphens.')
  const url = publicHttpsUrl(endpoint)
  return provider === 'claude' ? ['mcp', 'add', '--transport', 'http', '--scope', 'user', name, url] : ['mcp', 'add', name, '--url', url]
}
