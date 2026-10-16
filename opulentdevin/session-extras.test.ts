import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { Schema } from 'effect'
import { goalInput, externalThreadInput, filterPokedex } from './session-extras'
import { ThreadGoalSetInput } from './zuse-runtime/packages/contracts/src/session'
import { ContinueExternalThreadInput, ExternalThread } from './zuse-runtime/packages/contracts/src/external-thread'
import { PokemonPokedexEntry } from './zuse-runtime/packages/contracts/src/pokemon'

const thread = ExternalThread.make({ id: 'source-1', providerId: 'claude', title: 'Test thread', preview: 'Test preview', projectPath: '/test/project', projectName: 'Project', updatedAt: new Date(0), sourcePath: '/test/source', cursor: 'exact-cursor', resumeStrategy: 'claude-session-id', available: true })
const entry = PokemonPokedexEntry.make({ number: 1, slug: 'entry', name: 'Test entry', generation: 1, rarity: 'rare', points: 20, unlocked: true, unlockedAt: new Date(0), worktreeId: null, spriteUrl: null, silhouetteUrl: 'https://example.invalid/test', variants: [], evolutionLine: [] })
describe('session extras', () => {
  it('validates positive bounded goal budgets against the real schema', () => {
    expect(goalInput('  Objective  ', '')).toEqual({ objective: 'Objective', tokenBudget: null })
    expect(Schema.is(ThreadGoalSetInput)(goalInput('Objective', '1200'))).toBe(true)
    for (const invalid of ['0', '-1', '1.5', 'Infinity', '9007199254740992']) expect(() => goalInput('Goal', invalid)).toThrow()
    expect(() => goalInput(' ', '10')).toThrow()
  })
  it('preserves exact external source identities without fabricated resume data', () => {
    const input = externalThreadInput(thread)
    expect(Schema.is(ContinueExternalThreadInput)(input)).toBe(true)
    expect(input).toEqual({ providerId: 'claude', cursor: 'exact-cursor', projectPath: '/test/project', title: 'Test thread', sourcePath: '/test/source' })
    expect(() => externalThreadInput(ExternalThread.make({ ...thread, available: false }))).toThrow()
    expect(() => externalThreadInput(ExternalThread.make({ ...thread, cursor: '' }))).toThrow()
  })
  it('filters real catalogue rows without changing unlocked state or metadata', () => {
    const locked = PokemonPokedexEntry.make({ ...entry, number: 2, name: 'Locked entry', unlocked: false })
    expect(filterPokedex([entry, locked], 'RARE', false)).toEqual([entry, locked])
    expect(filterPokedex([entry, locked], '', true)).toEqual([entry])
    expect(filterPokedex([entry, locked], '2', false)).toEqual([locked])
    expect(locked.unlocked).toBe(false)
  })
  it('exposes typed actions with explicit confirmation and unknown-outcome fencing', () => {
    const source = readFileSync(new URL('./session-extras.tsx', import.meta.url), 'utf8')
    for (const tag of ['session.goal.get', 'session.goal.set', 'session.goal.clear', 'session.goal.stream', 'externalThreads.list', 'externalThreads.continue', 'pokemon.pokedex', 'pokemon.ensureSpriteCached']) expect(source).toContain(`['${tag}']`)
    expect(source).toContain('ConfirmAction')
    expect(source).toContain('uncertain.has(thread.id)')
    expect(source).toContain('!onContinue')
    expect(source).not.toContain('JSON.stringify')
  })
})
