import { describe, expect, it } from 'vitest'
import type { AgentAvailability } from './zuse-runtime/packages/contracts/src/agent'
import { subscriptionVerdict } from './provider-smoke'

const codex: AgentAvailability = { providerId: 'codex', displayName: 'Codex', cliInstalled: true, cliLoggedIn: true, hasApiKey: false, authStatus: 'authenticated', authType: 'chatgpt', authLabel: 'ChatGPT Plus Subscription', cliVersionStatus: 'ok' }
describe('subscription-only smoke permission gate', () => {
  it('permits only verified subscription metadata without API bindings', () => { expect(subscriptionVerdict(codex, []).allowed).toBe(true) })
  it('rejects inherited API credentials even with a subscription account', () => { expect(subscriptionVerdict(codex, ['OPENAI_API_KEY']).allowed).toBe(false) })
  it('rejects app API keys and unknown billing route', () => { expect(subscriptionVerdict({ ...codex, hasApiKey: true }, []).allowed).toBe(false); expect(subscriptionVerdict({ ...codex, authType: 'apiKey' }, []).allowed).toBe(false); expect(subscriptionVerdict({ ...codex, authType: undefined }, []).allowed).toBe(false) })
  it('rejects missing old unauthenticated and unavailable runtimes', () => { for (const patch of [{ cliInstalled: false }, { cliVersionStatus: 'outdated' as const }, { authStatus: 'unknown' as const }, { cliLoggedIn: false }, { runtimeAvailable: false }]) expect(subscriptionVerdict({ ...codex, ...patch }, []).allowed).toBe(false) })
  it('does not upgrade Claude credential metadata into live auth proof', () => { expect(subscriptionVerdict({ ...codex, providerId: 'claude', authType: 'oauth', authLabel: 'Claude Pro Subscription' }, []).allowed).toBe(false) })
  it('does not assume arbitrary CLI login means subscription', () => { expect(subscriptionVerdict({ ...codex, providerId: 'gemini', authType: 'cli' }, []).allowed).toBe(false) })
})
