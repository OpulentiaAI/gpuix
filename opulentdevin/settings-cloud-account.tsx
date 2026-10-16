import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import type { Backend } from './backend'
import type { CloudAccountImage, CloudAccountImageBuildMode } from './zuse-runtime/packages/contracts/src/cloud-workspaces'
import type { MachineOffer, MachineRecord } from './zuse-runtime/packages/contracts/src/machines'
import { SettingsAction as Action, SettingsCard as Card, SettingsNote as Note, SettingsField as Field, SettingsChoices as Choices, ConfirmAction, useSettingsAction } from './settings-controls'

type Props = { backend: Backend; onError: (error: unknown) => void }
export type CloudAccountBackend = Pick<Backend, 'client' | 'run'>

export function capMicros(value: string): number {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value.trim())) throw new Error('Enter a non-negative USD amount with at most six decimal places.')
  const [whole, fraction = ''] = value.trim().split('.')
  const micros = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('The cap is too large.')
  return Number(micros)
}

export function accountLink(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || url.hash) throw new Error('The service returned an unsafe link.')
  return url.href
}

async function openAccountLink(value: string) {
  const url = accountLink(value)
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open'
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
  await new Promise<void>((resolve, reject) => execFile(command, args, { timeout: 15000, windowsHide: true, shell: false }, error => error ? reject(new Error('The secure account page could not be opened.')) : resolve()))
}

export function machineActions(machine: MachineRecord) {
  const active = machine.state !== 'destroyed' && machine.state !== 'destroying'
  return { cancel: active && machine.state !== 'suspended' && machine.desiredState === 'ready', recover: active && machine.state === 'suspended', destroy: active }
}

export function imageCanBuild(image: CloudAccountImage) {
  return image.state !== 'building' && !image.builds.some(build => build.state === 'queued' || build.state === 'building' || build.state === 'sanitizing')
}

export function accountCommands(backend: CloudAccountBackend) {
  return {
    build: (mode: CloudAccountImageBuildMode, providerId: string, idempotencyKey: string) => backend.run(backend.client['cloud.image.build']({ mode, providerId, idempotencyKey })),
    cap: (value: string, idempotencyKey: string) => backend.run(backend.client['cloud.billing.setCap']({ overageCapMicros: capMicros(value), idempotencyKey })),
    create: (offer: MachineOffer, label: string, idempotencyKey: string) => {
      if (!offer.available || offer.kind !== 'persistent') throw new Error('Select an available persistent machine offer.')
      return backend.run(backend.client['machines.create']({ offerId: offer.offerId, label: label.trim() || undefined, idempotencyKey }))
    },
    checkout: (offer: MachineOffer) => {
      if (!offer.available) throw new Error('This offer is unavailable.')
      return backend.run(backend.client['machines.checkout']({ offerId: offer.offerId }))
    },
    cancel: (machine: MachineRecord) => {
      if (!machineActions(machine).cancel) throw new Error('Cancellation is not available in this state.')
      return backend.run(backend.client['machines.cancel']({ machineId: machine.machineId }))
    },
    recover: (machine: MachineRecord) => {
      if (!machineActions(machine).recover) throw new Error('Recovery is not available in this state.')
      return backend.run(backend.client['machines.recover']({ machineId: machine.machineId }))
    },
    destroy: (machine: MachineRecord) => {
      if (!machineActions(machine).destroy) throw new Error('Destruction is not available in this state.')
      return backend.run(backend.client['machines.destroy']({ machineId: machine.machineId, confirmation: 'destroy' }))
    },
    disconnect: async (installationId: number) => {
      const result = await backend.run(backend.client['cloud.github.disconnect']({ installationId }))
      if (!result.ok) throw new Error('GitHub disconnection was not confirmed.')
    },
  }
}

function useAccountRead<T>(backend: Backend, load: (backend: Backend) => Promise<T>, onError: Props['onError']) {
  const [result, setResult] = useState<{ owner: Backend; load: typeof load; value: T } | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const current = useRef({ backend, epoch: 0, mounted: true })
  const report = useRef(onError)
  report.current = onError
  current.current.backend = backend
  const refresh = useCallback(async () => {
    if (!current.current.mounted || current.current.backend !== backend) return
    const epoch = ++current.current.epoch
    setLoading(true); setFailed(false)
    try {
      const value = await load(backend)
      if (current.current.mounted && current.current.backend === backend && current.current.epoch === epoch) setResult({ owner: backend, load, value })
    } catch {
      if (current.current.mounted && current.current.backend === backend && current.current.epoch === epoch) {
        setResult(null); setFailed(true)
        report.current(new Error('Cloud account data could not be loaded. Check connectivity and account access.'))
      }
    } finally {
      if (current.current.mounted && current.current.backend === backend && current.current.epoch === epoch) setLoading(false)
    }
  }, [backend, load])
  useEffect(() => { current.current.mounted = true; void refresh(); return () => { current.current.mounted = false; current.current.epoch++ } }, [refresh])
  return { data: result?.owner === backend && result.load === load ? result.value : null, loading, failed, refresh }
}

const money = (micros: number) => `USD ${(micros / 1_000_000).toFixed(2)}`
const date = (value?: number) => value === undefined ? 'Not reported' : new Date(value).toLocaleString('en-GB')
const loadMachines = async (backend: Backend) => {
  const [offers, machines, entitlements] = await Promise.all([backend.run(backend.client['machines.offers']()), backend.run(backend.client['machines.list']()), backend.run(backend.client['machines.entitlements']())])
  return { offers: offers.offers, machines: machines.machines, entitlements: entitlements.entitlements }
}
const loadBilling = async (backend: Backend) => {
  const [summary, usage] = await Promise.all([backend.run(backend.client['cloud.billing.summary']()), backend.run(backend.client['cloud.billing.usage']({ limit: 20 }))])
  return { summary, usage }
}
const loadGithub = (backend: Backend) => backend.run(backend.client['cloud.github.status']())
const loadProviders = (backend: Backend) => backend.run(backend.client['cloud.providers']())

function ReadState({ loading, failed }: { loading: boolean; failed: boolean }) {
  return loading ? <Note>Loading account data…</Note> : failed ? <Note warning>Unavailable. Check account access and retry this section.</Note> : null
}

function ImageSettings({ backend, onError }: Props) {
  const providers = useAccountRead(backend, loadProviders, onError)
  const [selection, setSelection] = useState('')
  const provider = providers.data?.providers.find(item => item.providerId === selection) ?? providers.data?.providers[0]
  const providerId = provider?.providerId
  const loadImage = useCallback(async (owner: Backend) => providerId ? owner.run(owner.client['cloud.image.status']({ providerId })) : null, [providerId])
  const image = useAccountRead(backend, loadImage, onError)
  const { busy, message, run } = useSettingsAction(onError)
  const request = useRef({ input: '', key: '' })
  const build = (mode: CloudAccountImageBuildMode) => run('Build account image', async () => {
    if (!providerId || !image.data || !imageCanBuild(image.data)) throw new Error('Image is not ready for a new build.')
    const input = `${providerId}:${mode}`
    if (request.current.input !== input) request.current = { input, key: randomUUID() }
    await accountCommands(backend).build(mode, providerId, request.current.key)
    request.current = { input: '', key: '' }
    await image.refresh()
  })
  return <Card title="Cloud account images">
    <Note>Private account images use the existing connected repositories and provider credentials. No permission or secret settings are changed here.</Note>
    <Action label="Refresh images" disabled={busy || image.loading || providers.loading} onClick={() => { void providers.refresh(); void image.refresh() }} />
    <ReadState loading={providers.loading || image.loading} failed={providers.failed || image.failed} />
    {providers.data && providers.data.providers.length === 0 && <Note>No cloud image providers are available.</Note>}
    {provider && <Choices label="Image provider" value={provider.providerId} values={providers.data!.providers.map(item => item.providerId)} onChange={value => { if (!busy) setSelection(value) }} />}
    {image.data && <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Note>{provider?.displayName}: {image.data.state} · generation {image.data.generation ?? 'not built'} · runtime {image.data.runtimeVersion ?? 'not reported'}</Note>
      <Note>Built {date(image.data.builtAt)} · updated {date(image.data.updatedAt)}</Note>
      {image.data.repositories.map(repository => <Note key={repository.projectId}>{repository.displayName} · {repository.defaultBranch} · {repository.sourceCommit ?? 'commit not reported'}</Note>)}
      {image.data.providers.map(auth => <Note key={auth.providerId}>{auth.providerId}: {auth.state} · {auth.method ?? 'method not reported'}</Note>)}
      {image.data.builds.length === 0 && <Note>No build history.</Note>}
      {image.data.builds.map(attempt => <Note key={attempt.buildId}>{attempt.buildId} · {attempt.mode} · {attempt.state} · {date(attempt.updatedAt)}</Note>)}
      <Note>Raw build logs and diagnostics are deliberately not displayed.</Note>
      <ConfirmAction key={`update:${providerId}`} label="Update image" disabled={busy || image.loading || !imageCanBuild(image.data)} detail={`Update the private image on ${provider?.displayName}. This starts a cloud build and may incur charges.`} action={() => { void build('update') }} />
      <ConfirmAction key={`rebuild:${providerId}`} label="Rebuild image" disabled={busy || image.loading || !imageCanBuild(image.data)} detail={`Rebuild the private image on ${provider?.displayName} from scratch. This may incur charges.`} action={() => { void build('rebuild') }} />
    </div>}
    {message && <Note>{message}</Note>}
  </Card>
}

function MachineSettings({ backend, onError }: Props) {
  const resource = useAccountRead(backend, loadMachines, onError)
  const [label, setLabel] = useState('')
  const { busy, message, run } = useSettingsAction(onError)
  const request = useRef({ input: '', key: '' })
  const commands = accountCommands(backend)
  return <Card title="Cloud machines and subscriptions">
    <Action label="Refresh machines" disabled={busy || resource.loading} onClick={() => { void resource.refresh() }} />
    <ReadState loading={resource.loading} failed={resource.failed} />
    {resource.data && <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Note>Purchasing and provisioning are separate, explicitly confirmed actions. Provisioning requires an existing entitlement; checkout never silently creates a machine.</Note>
      <Field label="New machine label" value={label} onChange={setLabel} disabled={busy} />
      {resource.data.offers.length === 0 && <Note>No machine or workspace offers available.</Note>}
      {resource.data.offers.map(offer => <div key={offer.offerId} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Note>{offer.displayName} · {offer.kind} · {offer.vcpuCount} vCPU · {offer.memoryMib} MiB · {offer.diskGib} GiB · {offer.location}</Note>
        <Note>{offer.currency} {(offer.monthlyPriceCents / 100).toFixed(2)} per month · backups {offer.automaticBackups ? 'included' : 'not included'} · {offer.available ? 'available' : 'unavailable'}</Note>
        <ConfirmAction label={`Checkout ${offer.displayName}`} disabled={busy || resource.loading || !offer.available} detail={`Open checkout for ${offer.displayName} at ${offer.currency} ${(offer.monthlyPriceCents / 100).toFixed(2)} per month. Payment requires your confirmation on the secure checkout page.`} action={() => { void run('Open checkout', async () => { const result = await commands.checkout(offer); await openAccountLink(result.checkoutUrl) }) }} />
        {offer.kind === 'persistent' && <ConfirmAction key={`${offer.offerId}:${label}`} label={`Provision ${offer.displayName}`} disabled={busy || resource.loading || !offer.available} detail={`Create a real ${offer.displayName} machine${label.trim() ? ` named ${label.trim()}` : ''} using your existing entitlement. This consumes cloud resources.`} action={() => { void run('Provision machine', async () => {
          const input = `${offer.offerId}:${label.trim()}`
          if (request.current.input !== input) request.current = { input, key: randomUUID() }
          await commands.create(offer, label, request.current.key); request.current = { input: '', key: '' }; await resource.refresh()
        }) }} />}
      </div>)}
      {resource.data.machines.length === 0 && <Note>No managed machines.</Note>}
      {resource.data.machines.map(machine => <div key={machine.machineId} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Note>{machine.label ?? machine.offer.displayName} · {machine.machineId} · {machine.state} · {machine.statusCode}</Note>
        <Note>Paid through {date(machine.paidThrough)} · recovery deadline {date(machine.recoveryDeadline)}</Note>
        {machineActions(machine).cancel && <ConfirmAction label={`Cancel subscription ${machine.machineId}`} disabled={busy || resource.loading} detail="Cancel renewal at the end of the paid period. Access continues only through the paid period." action={() => { void run('Cancel subscription', async () => { await commands.cancel(machine); await resource.refresh() }) }} />}
        {machineActions(machine).recover && <ConfirmAction label={`Recover ${machine.machineId}`} disabled={busy || resource.loading} detail="Restore this suspended machine before its recovery deadline. Billing and entitlement checks still apply." action={() => { void run('Recover machine', async () => { await commands.recover(machine); await resource.refresh() }) }} />}
        {machineActions(machine).destroy && <ConfirmAction label={`Destroy ${machine.machineId}`} disabled={busy || resource.loading} detail="Permanently destroy this machine and its data. This cannot be undone." action={() => { void run('Destroy machine', async () => { await commands.destroy(machine); await resource.refresh() }) }} />}
      </div>)}
      {resource.data.entitlements.length === 0 && <Note>No entitlements.</Note>}
      {resource.data.entitlements.map(entitlement => <Note key={entitlement.entitlementId}>{entitlement.kind} · {entitlement.status} · {entitlement.offerId ?? 'no offer'} · paid through {date(entitlement.paidThrough)}</Note>)}
    </div>}
    <ConfirmAction label="Open billing portal" disabled={busy} detail="Open the secure account billing portal. Any subscription changes must be confirmed there." action={() => { void run('Open billing portal', async () => { const result = await backend.run(backend.client['machines.billingPortal']()); await openAccountLink(result.portalUrl) }) }} />
    {message && <Note>{message}</Note>}
  </Card>
}

function BillingSettings({ backend, onError }: Props) {
  const resource = useAccountRead(backend, loadBilling, onError)
  const [cap, setCap] = useState('')
  const [page, setPage] = useState<{ owner: Backend; usage: Awaited<ReturnType<typeof loadBilling>>['usage'] } | null>(null)
  const { busy, message, run } = useSettingsAction(onError)
  const request = useRef({ input: '', key: '' })
  const usage = page?.owner === backend ? page.usage : resource.data?.usage
  const summary = resource.data?.summary
  return <Card title="Cloud usage and spending cap">
    <Action label="Refresh billing" disabled={busy || resource.loading} onClick={() => { setPage(null); void resource.refresh() }} />
    <ReadState loading={resource.loading} failed={resource.failed} />
    {summary && <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Note>{summary.status} · {date(summary.periodStart)} to {date(summary.periodEnd)}</Note>
      <Note>Invoice estimate {money(summary.currentInvoiceEstimateMicros)} · base {money(summary.basePriceMicros)} · overage charge {money(summary.overageChargeMicros)}</Note>
      <Note>Provider cost {money(summary.providerCostMicros)} · included used {money(summary.includedUsedMicros)} · included remaining {money(summary.includedRemainingMicros)}</Note>
      <Note>Current overage cap {money(summary.overageCapMicros)} · usage {summary.usageProvisional ? 'provisional, subject to reconciliation' : 'reconciled'}</Note>
      <Field label="New overage cap in USD" value={cap} onChange={setCap} placeholder={String(summary.overageCapMicros / 1_000_000)} disabled={busy} />
      <ConfirmAction key={cap} label="Save overage cap" disabled={busy || resource.loading || !cap.trim()} detail={`Set the overage spending cap to USD ${cap}. Increasing it authorises additional billable usage; zero disables overage.`} action={() => { void run('Save overage cap', async () => {
        capMicros(cap)
        if (request.current.input !== cap) request.current = { input: cap, key: randomUUID() }
        await accountCommands(backend).cap(cap, request.current.key); request.current = { input: '', key: '' }; await resource.refresh()
      }) }} />
      <Note>Usage entries show provider costs, not final invoice charges.</Note>
      {usage?.items.length === 0 && <Note>No usage entries in this page.</Note>}
      {usage?.items.map(item => <Note key={item.entryId}>{item.resourceKind} {item.resourceId} · {item.provider} · {date(item.startedAt)} to {date(item.endedAt)} · {item.vcpuCount} vCPU / {item.memoryMib} MiB · {money(item.providerCostMicros)} · {item.status}</Note>)}
      {usage?.nextCursor && <Action label="Next usage page" disabled={busy || resource.loading} onClick={() => { void run('Load usage page', async () => { const next = await backend.run(backend.client['cloud.billing.usage']({ cursor: usage.nextCursor, limit: 20 })); setPage({ owner: backend, usage: next }) }) }} />}
    </div>}
    {message && <Note>{message}</Note>}
  </Card>
}

function GithubSettings({ backend, onError }: Props) {
  const resource = useAccountRead(backend, loadGithub, onError)
  const { busy, message, run } = useSettingsAction(onError)
  return <Card title="Cloud GitHub access">
    <Action label="Refresh GitHub" disabled={busy || resource.loading} onClick={() => { void resource.refresh() }} />
    <ReadState loading={resource.loading} failed={resource.failed} />
    {resource.data && <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Note>{resource.data.configured ? 'GitHub App configured' : 'GitHub App is not configured on this service.'}</Note>
      <ConfirmAction label="Install or manage GitHub App" disabled={busy || resource.loading || !resource.data.configured} detail="Open GitHub to choose the account and repository permissions for the app. Review access before approving on GitHub." action={() => { void run('Open GitHub installation', async () => { const result = await backend.run(backend.client['cloud.github.install']()); await openAccountLink(result.url) }) }} />
      {resource.data.installations.length === 0 && <Note>No linked GitHub installations.</Note>}
      {resource.data.installations.map(installation => <div key={installation.installationId} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Note>{installation.accountLogin} · {installation.accountType} · {installation.repositorySelection} repositories · {installation.suspended ? 'suspended' : 'active'}</Note>
        <ConfirmAction label={`Disconnect GitHub ${installation.accountLogin}`} disabled={busy || resource.loading} detail={`Disconnect installation ${installation.installationId} for ${installation.accountLogin} from this cloud account. Workspaces may lose repository access.`} action={() => { void run('Disconnect GitHub', async () => { await accountCommands(backend).disconnect(installation.installationId); await resource.refresh() }) }} />
      </div>)}
      {resource.data.repositories.length === 0 && <Note>No accessible GitHub repositories.</Note>}
      {resource.data.repositories.map(repository => <Note key={repository.nameWithOwner}>{repository.nameWithOwner} · {repository.isPrivate ? 'private' : 'public'} · {repository.defaultBranch}</Note>)}
    </div>}
    {message && <Note>{message}</Note>}
  </Card>
}

export function CloudAccountSettings(props: Props) {
  const accountKey = useMemo(() => randomUUID(), [props.backend])
  return <div key={accountKey} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <ImageSettings {...props} />
    <MachineSettings {...props} />
    <BillingSettings {...props} />
    <GithubSettings {...props} />
  </div>
}
