/** Read-only discovery and single-approval preparation of pinned server update candidates. */
import { join } from 'node:path'
import { lt } from 'semver'
import { z } from 'zod'
import { fetchCatalog, type CatalogItem } from './catalog.ts'
import { activateComponent, highestInstalledComponentVersion, installComponent, listComponentOperations, readComponentPatchRevision, rollbackComponent, type ComponentOperationStatus } from './components.ts'
import type { ResolvedUpdatesConfig } from './config.ts'
import { downloadVerifiedFile } from './download.ts'
import { readRuntimeFacts, type RuntimeFacts } from './facts.ts'
import { assertManagedHome } from './managed-home.ts'
import { fetchNativeRelease, nativeArtifact, prepareNativeUpdate, type NativeRelease, type NativeTarget } from './native.ts'

const version = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u)
const itemRequest = { id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u), version }
/** Model input deliberately cannot select a URL, trust key, local path or profile row. */
export const updateRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('component'), ...itemRequest }),
  z.strictObject({ kind: z.literal('runtime'), ...itemRequest }),
  z.strictObject({ kind: z.literal('native'), version }),
])
/** One explicitly selected immutable candidate. */
export type UpdateRequest = z.infer<typeof updateRequestSchema>

/** Read-only results permit one channel to remain useful when the other is unavailable. */
export interface UpdatesStatus {
  checkedAt: string
  facts: RuntimeFacts
  components: { status: 'available'; generatedAt: string; items: Array<CatalogItem & { compatible: boolean | null }> } | { status: 'unavailable'; error: string }
  native: { status: 'available'; version: string; target: NativeTarget | null; updateAvailable: boolean | null; requires: 'native-installer' } | { status: 'unavailable'; error: string }
  operations: ComponentOperationStatus[]
}

/** Read-only dependencies; preparation always uses the real verified filesystem writers. */
export interface UpdatesDependencies {
  fetchImpl?: typeof fetch
  facts?: (dshHome: string) => Promise<RuntimeFacts>
}

type PinnedPlan = {
  patchRevision: string
  facts: RuntimeFacts
} & ({ kind: 'component' | 'runtime'; item: CatalogItem } | { kind: 'native'; release: NativeRelease; target: NativeTarget })

function failure(error: unknown): string { return error instanceof Error ? error.message : 'Update metadata is unavailable' }

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/** Server channel consumer; metadata checks never create home, cache or profile files. */
export class UpdatesService {
  private changing = false
  private latest: UpdatesStatus | null = null

  /** @param config Fully validated deployment settings. @param dependencies Current-process facts and optional HTTP transport. */
  constructor(private readonly config: ResolvedUpdatesConfig, private readonly dependencies: UpdatesDependencies = {}) {}

  private request(signal: AbortSignal) {
    return { requestTimeoutMs: this.config.requestTimeoutMs, maxCatalogBytes: this.config.maxCatalogBytes,
      signal, ...(this.dependencies.fetchImpl ? { fetchImpl: this.dependencies.fetchImpl } : {}) }
  }

  private catalog(signal: AbortSignal) {
    return fetchCatalog({ ...this.request(signal), catalogUrl: this.config.catalogUrl,
      publicKeyPem: this.config.publicKeyPem, maxDownloadBytes: this.config.maxDownloadBytes })
  }

  private native(signal: AbortSignal) { return fetchNativeRelease({ ...this.request(signal), manifestUrl: this.config.nativeManifestUrl }) }
  private facts() { return (this.dependencies.facts ?? readRuntimeFacts)(this.config.dshHome) }

  private nativeStatus(result: PromiseSettledResult<NativeRelease>, facts: RuntimeFacts): UpdatesStatus['native'] {
    if (result.status === 'rejected') return { status: 'unavailable', error: failure(result.reason) }
    const target = this.config.nativeTarget ?? facts.nativeTarget
    if (target !== null) {
      try { nativeArtifact(result.value, target) }
      catch (error) { return { status: 'unavailable', error: failure(error) } }
    }
    return { status: 'available', version: result.value.version, target,
      updateAvailable: facts.desktopVersion === null ? null : lt(facts.desktopVersion, result.value.version), requires: 'native-installer' }
  }

  /** @returns The last in-memory check, or null before a check completes; does not access disk or network. */
  cached(): UpdatesStatus | null { return this.latest === null ? null : structuredClone(this.latest) }

  /** Read both channels and current-process facts without downloading artifacts.
   * @param signal Owning command, tool or plugin lifetime.
   * @returns Current metadata with channel-local failures and honest activation limits.
   */
  async check(signal: AbortSignal): Promise<UpdatesStatus> {
    signal.throwIfAborted()
    const [components, native, observed] = await Promise.allSettled([this.catalog(signal), this.native(signal), this.facts()])
    signal.throwIfAborted()
    if (observed.status === 'rejected') throw observed.reason
    const facts = observed.value
    const status: UpdatesStatus = {
      checkedAt: new Date().toISOString(), facts,
      components: components.status === 'fulfilled'
        ? { status: 'available', generatedAt: components.value.generatedAt, items: components.value.components.map(item => ({ ...item, compatible: facts.dshVersion === null ? null : item.requiresDshVersion === facts.dshVersion })) }
        : { status: 'unavailable', error: failure(components.reason) },
      native: this.nativeStatus(native, facts),
      operations: await listComponentOperations(this.config.dshHome),
    }
    this.latest = structuredClone(status)
    return status
  }

  private async plan(request: UpdateRequest, signal: AbortSignal): Promise<PinnedPlan> {
    await assertManagedHome(this.config.dshHome)
    const facts = await this.facts()
    const patchRevision = await readComponentPatchRevision(this.config.dshHome)
    signal.throwIfAborted()
    if (request.kind === 'native') {
      const release = await this.native(signal)
      if (release.version !== request.version) throw new Error('The requested native version is not the current server candidate')
      if (facts.desktopVersion && lt(release.version, facts.desktopVersion)) throw new Error('Native update would downgrade this desktop')
      const target = this.config.nativeTarget ?? facts.nativeTarget
      if (!target) throw new Error('Native installer target is unknown; configure nativeTarget for this desktop')
      nativeArtifact(release, target)
      return freeze({ kind: 'native', release: structuredClone(release), target, facts, patchRevision })
    }
    const catalog = await this.catalog(signal)
    const item = catalog.components.find(candidate => candidate.kind === request.kind && candidate.id === request.id && candidate.version === request.version)
    if (!item) throw new Error('The requested version is not present in the signed component catalog')
    if (!facts.dshVersion || item.requiresDshVersion !== facts.dshVersion) throw new Error('This update requires a different or unverified DSH runtime version')
    if (item.kind === 'component' && item.size > this.config.maxComponentArchiveBytes) throw new Error('Component exceeds its configured archive byte limit')
    if (item.kind === 'component') await this.rejectDowngrade(item)
    return freeze({ kind: request.kind, item: structuredClone(item), facts, patchRevision })
  }

  private async rejectDowngrade(item: CatalogItem): Promise<void> {
    const installed = await highestInstalledComponentVersion(this.config.dshHome, item.id)
    if (installed !== null && lt(item.version, installed)) throw new Error('Component update would downgrade a verified installed version; use the explicit rollback workflow instead')
  }

  private summary(plan: PinnedPlan): string {
    const chinese = this.config.locale === 'zh-CN'
    if (plan.kind === 'native') return chinese
      ? `下载并验签 ClawMaster ${plan.release.version}（${plan.target}）安装包到 ${join(this.config.dshHome, 'clawmaster-updates', 'downloads')}；需要原生安装器后续安装，本次不会启动安装器或重启。配置修订：${plan.patchRevision}`
      : `Download and verify ClawMaster ${plan.release.version} (${plan.target}) into ${join(this.config.dshHome, 'clawmaster-updates', 'downloads')}. Native installation remains required; this action does not launch the installer or restart. Profile revision: ${plan.patchRevision}`
    const operation = plan.item.kind === 'runtime' ? (chinese ? '仅下载并验签运行时，当前桌面不支持切换' : 'download and verify runtime; desktop activation support is required')
      : plan.item.activation === 'restart' ? plan.item.id === 'updates'
        ? (chinese ? '安装到独立组件目录并暂存；支持组件维护的桌面将在 Host 停止后的下次启动应用更新，插件实际加载后才确认成功' : 'install into an isolated component directory and stage; a maintenance-capable desktop applies the update before its next Host starts and confirms success only after the plugin loads')
        : (chinese ? '安装到独立组件目录并暂存；重启不会自动应用，需停止 Host 后另行安装' : 'install into an isolated component directory and stage; restarting will not apply this automatically, and installation must be completed separately with the Host stopped')
        : (chinese ? '安装到独立组件目录并修改更新器专属配置行；等待 DSH Loader 激活' : 'install into an isolated component directory and edit the updater-owned profile row; await DSH Loader activation')
    return `${plan.item.packageName} ${plan.item.version}: ${operation}. SHA-256: ${plan.item.sha256}. ${chinese ? '目录' : 'Home'}: ${this.config.dshHome}. ${chinese ? '配置修订' : 'Profile revision'}: ${plan.patchRevision}`
  }

  /** Pin authenticated metadata and the current profile, then request one approval before any write.
   * @param input Selected signed candidate; arbitrary URLs and paths are rejected.
   * @param approve DSH user-approval request for the concrete pinned operation.
   * @param signal Tool and plugin cancellation.
   * @returns Verified download or pending component activation; never claims a restart or installer ran.
   */
  async change(input: unknown, approve: (summary: string) => Promise<string>, signal: AbortSignal): Promise<unknown> {
    const request = updateRequestSchema.parse(input)
    if (this.changing) throw new Error('Another update is awaiting approval or being prepared')
    this.changing = true
    try {
      signal.throwIfAborted()
      const plan = await this.plan(request, signal)
      signal.throwIfAborted()
      const outcome = await approve(this.summary(plan))
      if (outcome !== 'allowed-once') throw new Error(`approval_${outcome}: no update files were written`)
      signal.throwIfAborted()
      await assertManagedHome(this.config.dshHome)
      if (await readComponentPatchRevision(this.config.dshHome) !== plan.patchRevision) throw new Error('The profile changed during approval; no update files were written')
      const now = await this.facts()
      if (now.hostPid !== plan.facts.hostPid || now.runId !== plan.facts.runId || now.dshVersion !== plan.facts.dshVersion) throw new Error('The running Host changed during approval; no update files were written')
      if (plan.kind === 'component') await this.rejectDowngrade(plan.item)
      signal.throwIfAborted()
      const options = {
        cacheDir: join(this.config.dshHome, 'clawmaster-updates', 'downloads'), downloadTimeoutMs: this.config.downloadTimeoutMs,
        maxDownloadBytes: this.config.maxDownloadBytes, signal, ...(this.dependencies.fetchImpl ? { fetchImpl: this.dependencies.fetchImpl } : {}),
      }
      if (plan.kind === 'native') return prepareNativeUpdate(plan.release, plan.target, { ...options, publicKey: this.config.nativePublicKey })
      const downloaded = await downloadVerifiedFile(plan.item, options)
      signal.throwIfAborted()
      if (plan.item.kind === 'runtime') return { ...downloaded, kind: 'runtime', id: plan.item.id, version: plan.item.version, status: 'requires-desktop-support' }
      const installed = await installComponent({ archivePath: downloaded.path, descriptor: plan.item, dshHome: this.config.dshHome,
        dshVersion: plan.item.requiresDshVersion, providedPackages: plan.facts.providedPackages,
        limits: { archiveBytes: this.config.maxComponentArchiveBytes, expandedBytes: this.config.maxExpandedBytes, entries: this.config.maxArchiveEntries } })
      signal.throwIfAborted()
      const activation = await activateComponent({ dshHome: this.config.dshHome, id: plan.item.id, version: plan.item.version,
        expectedPatchRevision: plan.patchRevision, confirmed: true })
      return { ...activation, kind: 'component', id: plan.item.id, version: plan.item.version, directory: installed.directory }
    } finally { this.changing = false }
  }

  /** Request one approval to restore a selected component operation without fetching a different candidate.
   * @param token Previously observed operation token from discovery.
   * @param approve Approval provider for the exact token and current profile revision.
   * @param signal Owning agent lifetime.
   * @returns pending activation or restart; application data is never restored or migrated by this operation.
   */
  async rollback(token: string, approve: (summary: string) => Promise<string>, signal: AbortSignal): Promise<unknown> {
    if (this.changing) throw new Error('Another update is awaiting approval or being prepared')
    this.changing = true
    try {
      signal.throwIfAborted()
      const operation = (await listComponentOperations(this.config.dshHome)).find(operation => operation.token === token)
      if (!operation) throw new Error('The selected update operation does not exist')
      if (operation.id !== 'updates') throw new Error('User rollback is limited to the stateless updater; other components require a reviewed data-compatibility procedure')
      const expectedPatchRevision = await readComponentPatchRevision(this.config.dshHome)
      const facts = await this.facts()
      const reason = this.config.locale === 'zh-CN'
        ? `恢复更新操作 ${token} 之前的更新器组件配置；退出后下次启动应用。不会回退业务数据库。配置修订：${expectedPatchRevision}`
        : `Restore the updater selection before operation ${token}; apply before the next Host starts. Business databases are not downgraded. Profile revision: ${expectedPatchRevision}`
      if (await approve(reason) !== 'allowed-once') throw new Error('Rollback was not approved; no files were changed')
      signal.throwIfAborted()
      const now = await this.facts()
      if (now.hostPid !== facts.hostPid || now.runId !== facts.runId) throw new Error('The Host changed during rollback approval')
      return rollbackComponent({ dshHome: this.config.dshHome, rollbackToken: token, expectedPatchRevision, confirmed: true })
    } finally { this.changing = false }
  }
}
