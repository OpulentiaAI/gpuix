import { describe, it, expect } from 'vitest'
import { presetModelPatch, mcpStdioArguments } from './settings-safe'
import { customEndpointModels } from './settings-opencode'
import type { SettingsFile } from './zuse-runtime/packages/contracts/src/settings'
import { readFileSync } from 'node:fs'

const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')
describe('preset model and turn edits', () => {
  const current = { subagents: { enableForNewSessions: true, presets: { tester: { enabled: true, overrides: { model: 'old', maxTurns: 4, prompt: 'test', permissionMode: 'approval-required', disallowedTools: ['Write'] } }, other: { enabled: false, overrides: {} } } } } as unknown as SettingsFile
  it('preserves permission modes, tool restrictions and other presets', () => { const next = presetModelPatch(current, 'tester', 'new', '12'); expect(next.subagents?.presets.tester?.overrides).toEqual({ model: 'new', maxTurns: 12, prompt: 'test', permissionMode: 'approval-required', disallowedTools: ['Write'] }); expect(next.subagents?.presets.other).toEqual(current.subagents.presets.other) })
  it('can restore inherited values without dropping permissions', () => { const next = presetModelPatch(current, 'tester', '', ''); expect(next.subagents?.presets.tester?.overrides.model).toBeUndefined(); expect(next.subagents?.presets.tester?.overrides.maxTurns).toBeUndefined(); expect(next.subagents?.presets.tester?.overrides.permissionMode).toBe('approval-required') })
  it('rejects invalid turn counts and missing presets', () => { for (const turns of ['0', '-1', '1.5', 'NaN']) expect(() => presetModelPatch(current, 'tester', '', turns)).toThrow(); expect(() => presetModelPatch(current, 'gone', '', '')).toThrow() })
})
describe('OpenCode custom models and MCP stdio', () => {
  it('parses explicit named models and rejects duplicate/empty model IDs', () => { expect(customEndpointModels('alpha | Alpha\nbeta')).toEqual([{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'beta' }]); expect(() => customEndpointModels('alpha\nalpha')).toThrow(); expect(() => customEndpointModels('')).toThrow() })
  it('uses literal argv boundaries with fixed provider flags', () => { expect(mcpStdioArguments('claude', 'example', '/usr/bin/server', 'argument with spaces\n$(not-a-shell)')).toEqual(['mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'example', '--', '/usr/bin/server', 'argument with spaces', '$(not-a-shell)']); expect(mcpStdioArguments('codex', 'example', '/usr/bin/server', '')).toEqual(['mcp', 'add', 'example', '--', '/usr/bin/server']); expect(() => mcpStdioArguments('codex', 'example', 'sh -c something', '')).toThrow() })
  it('scopes list, refresh and mutations to selected repository without a raw RPC editor', () => { const settings = source('./settings.tsx'); expect(settings).toContain("backend.client['mcp.refresh'](projectId ? { projectId: FolderId.make(projectId) }"); expect(settings).toContain("backend.client['mcp.list'](projectId ? { projectId: FolderId.make(projectId) }"); expect(settings).toContain("backend.client['mcp.setEnabled']({ ...scope"); expect(settings).not.toContain('eval(') })
})
