import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import type { AgentAvailability } from './zuse-runtime/packages/contracts/src/agent'
import { connectBackend, startLocalBackend, type Backend } from './backend'

export type SubscriptionVerdict = { allowed: boolean; reason: string }
export function subscriptionVerdict(provider: AgentAvailability, environmentNames: readonly string[]): SubscriptionVerdict {
  if (!provider.cliInstalled || provider.runtimeAvailable === false) return { allowed: false, reason: 'The provider CLI/runtime is not installed.' }
  if (provider.cliVersionStatus === 'outdated') return { allowed: false, reason: 'The provider CLI is below the maintained runtime version floor.' }
  if (provider.authStatus !== 'authenticated' || !provider.cliLoggedIn) return { allowed: false, reason: 'A live authenticated CLI account is not established.' }
  if (provider.hasApiKey) return { allowed: false, reason: 'An app-managed API credential may override the subscription; API spending is not authorised.' }
  const conflicting = provider.providerId === 'codex' ? ['OPENAI_API_KEY', 'CODEX_API_KEY'] : provider.providerId === 'claude' ? ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'] : []
  if (conflicting.some(name => environmentNames.includes(name))) return { allowed: false, reason: 'A provider API environment binding makes the billing route ambiguous.' }
  if (provider.providerId === 'codex' && provider.authType === 'chatgpt') return { allowed: true, reason: 'Zuse account/read reports an existing ChatGPT subscription route.' }
  if (provider.providerId === 'claude' && provider.authType === 'oauth' && /subscription/i.test(provider.authLabel ?? '') && !/requires/i.test(provider.authLabel ?? '')) return { allowed: false, reason: 'Zuse Claude OAuth metadata is credential-file evidence, not live CLI confirmation; do not infer spending authority from it.' }
  return { allowed: false, reason: 'No unambiguous supported subscription billing route was verified.' }
}

export async function probeProvisionedProviders(root: string, port: number) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Supply an explicit unprivileged local probe port.')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(root, 'provider-probe-'))
  const child = startLocalBackend({ dataDir: join(directory, 'data'), port })
  let backend: Backend | undefined
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null) throw new Error('Pinned Zuse sidecar exited before the availability handshake.')
      try { backend = await connectBackend({ host: '127.0.0.1', port, timeoutMs: 500 }); break } catch { await delay(200) }
    }
    if (!backend) throw new Error('Pinned Zuse sidecar did not become ready within the bounded startup deadline.')
    const environmentNames = Object.keys(process.env).filter(name => /^(OPENAI|CODEX|ANTHROPIC|CLAUDE|GEMINI|GOOGLE_API)/.test(name)).sort()
    const providers = (await backend.providers.list({ refresh: true })).map(provider => ({ providerId: provider.providerId, cliInstalled: provider.cliInstalled, cliVersion: provider.cliVersion, runtimeAvailable: provider.runtimeAvailable, cliLoggedIn: provider.cliLoggedIn, hasApiKey: provider.hasApiKey, authStatus: provider.authStatus, authType: provider.authType, authLabel: provider.authLabel, verdict: subscriptionVerdict(provider, environmentNames) }))
    const result = { environmentNames, providers, inferenceStarted: false, note: 'Read-only provider availability; no model turn, installation, login or credential mutation performed.' }
    const path = join(directory, 'availability.json')
    await writeFile(path, JSON.stringify(result, null, 2), { mode: 0o600 })
    return { path, ...result }
  } finally {
    await backend?.dispose()
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited }
  }
}

if (import.meta.main) {
  const root = process.env.OPULENTDEVIN_PROVIDER_SMOKE_ROOT
  const port = Number(process.env.OPULENTDEVIN_PROVIDER_SMOKE_PORT)
  if (!root) throw new Error('Set OPULENTDEVIN_PROVIDER_SMOKE_ROOT to a private evidence directory.')
  console.log(JSON.stringify(await probeProvisionedProviders(root, port), null, 2))
}
