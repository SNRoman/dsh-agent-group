/** Durable organization directory and DSH service composition. */
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { WorkspaceId } from './ids.ts'
import { agentWorkspaceSpec } from './spec.ts'
import { WorkspaceDirectory } from './workspace-directory.ts'
import { WorkspaceRuntime } from './workspace-runtime.ts'
import { WorkspaceAdmission } from './workspace-admission.ts'
import { WorkspaceOperationId } from './workspace-record.ts'
import type { WorkspaceDirectoryEntry, WorkspaceRecordV2 } from './workspace-record.ts'
import { createWorkspaceExportV3, prepareWorkspaceImport } from './workspace-portable.ts'
import type { WorkspaceImportLimits } from './workspace-import.ts'
import type { OrganizationImportPreview, OrganizationExport, OrganizationRpcService } from './organization-rpc.ts'
import { registerWorkspaceTaskTools } from './task-tools.ts'
import type { WorkspaceToolRegistry } from './task-tools.ts'
import { registerWorkspaceMemoryTools } from './memory-tools.ts'
import { registerWorkspaceWorkflowTools } from './workflow-tools.ts'
import { inspectTaskDelivery } from './task-delivery.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { agentWorkspace: AgentWorkspaceDomainService }
}

/** Identity of the released local organization, never an implicit RPC fallback. */
export const LOCAL_WORKSPACE_ID = WorkspaceId('local')

/** Host deployment limits; the Browser transport has a separate request-body limit. */
export interface Config {
  childProvider?: string
  memoryCharacterBudget?: number
  memorySearchResultLimit?: number
  importMaxBytes?: number
  importMaxEntities?: number
  importMaxEvents?: number
  importMaxStringBytes?: number
  importMaxDepth?: number
}

/** Deployment options after Cordis configuration validation. */
export type ResolvedConfig = Required<Config>

/** Directory owner; every runtime returned by forWorkspace is permanently scoped. */
export class AgentWorkspaceDomainService extends Service implements OrganizationRpcService {
  static inject = ['storageDomain']
  static Config: z<Config> = z.object({
    childProvider: z.string().default('spawn'),
    memoryCharacterBudget: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(4000),
    memorySearchResultLimit: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(10),
    importMaxBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(256 * 1024),
    importMaxEntities: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(50_000),
    importMaxEvents: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(20_000),
    importMaxStringBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(128 * 1024),
    importMaxDepth: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(64),
  })

  private directory: WorkspaceDirectory | undefined
  private readonly runtimes = new Map<WorkspaceId, WorkspaceRuntime>()
  private readonly metadataFlights = new Map<WorkspaceId, Promise<WorkspaceRecordV2>>()
  private readonly config: ResolvedConfig
  private readonly admission = new WorkspaceAdmission()
  private closing = false
  private disposal: Promise<void> | undefined
  private closeDomain: (() => Promise<void>) | undefined

  /** @param ctx DSH service context. @param config Validated deployment settings. */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'agentWorkspace')
    this.config = config as ResolvedConfig
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(agentWorkspaceSpec)
    this.closeDomain = () => domain.close()
    this.ctx.effect(() => () => this.shutdown(), 'agentWorkspace.teardown')
    const directory = new WorkspaceDirectory(domain.table('workspaces'))
    await directory.initialize()
    this.directory = directory
    for (const entry of directory.list()) await this.materializeRuntime(entry.descriptor.id)
    this.ctx.inject(['tools'], toolCtx => {
      const tools = toolCtx.get('tools') as WorkspaceToolRegistry | undefined
      if (tools === undefined) return
      const resolve = (agent: Agent): WorkspaceRuntime | undefined => this.runtimeForAgent(agent)
      toolCtx.effect(() => registerWorkspaceTaskTools(tools, resolve), 'agentWorkspace.taskTools')
      toolCtx.effect(() => registerWorkspaceWorkflowTools(tools, resolve), 'agentWorkspace.workflowTools')
      toolCtx.effect(() => registerWorkspaceMemoryTools(tools, resolve, {
        characterBudget: this.config.memoryCharacterBudget, resultLimit: this.config.memorySearchResultLimit,
      }), 'agentWorkspace.memoryTools')
    })
  }

  /** @param id Explicit organization identity. @returns Its fixed runtime; missing identities fail. */
  forWorkspace(id: WorkspaceId): WorkspaceRuntime {
    const runtime = this.runtimes.get(id)
    if (runtime === undefined) throw new Error('organization runtime is unavailable')
    return runtime
  }

  /** @returns Detached directory entries, including archived organizations. */
  listOrganizations(): readonly WorkspaceDirectoryEntry[] { return this.requireDirectory().list() }

  /** @param operationId Stable retry identity. @param label Display name. @returns New or idempotently recovered record. */
  async createOrganization(operationId: WorkspaceOperationId, label: string, signal?: AbortSignal): Promise<WorkspaceRecordV2> {
    return await this.admission.run(async () => {
      const record = await this.requireDirectory().create({ operationId, label, ...(signal === undefined ? {} : { signal }) })
      await this.materializeRuntime(record.descriptor.id)
      return record
    })
  }

  /** @param json Untrusted portable document. @returns Validation facts without any durable writes or runtime creation. */
  previewImport(json: string): OrganizationImportPreview {
    const prepared = prepareWorkspaceImport(json, { workspaceId: WorkspaceId(`org-${randomUUID()}`), limits: this.importLimits() })
    return {
      operationId: WorkspaceOperationId(randomUUID()), sourceWorkspaceId: prepared.sourceWorkspaceId,
      sourcePluginVersion: prepared.sourcePluginVersion, exportedAt: prepared.exportedAt,
      label: prepared.descriptor.label, lifecycle: prepared.descriptor.lifecycle,
      eventCount: prepared.state.events.length, agentCount: Object.keys(prepared.state.agents).length,
      taskCount: Object.keys(prepared.state.tasks).length, sessionBindingsExcluded: true,
    }
  }

  /** @param operationId Preview retry identity. @param json Original portable document. @param label Confirmed name. @returns A new organization, never the source. */
  async importOrganization(operationId: WorkspaceOperationId, json: string, label: string, signal?: AbortSignal): Promise<WorkspaceRecordV2> {
    return await this.admission.run(async () => {
      const record = await this.requireDirectory().import({ operationId, json, label, limits: this.importLimits(), ...(signal === undefined ? {} : { signal }) })
      await this.materializeRuntime(record.descriptor.id)
      return record
    })
  }

  /** @param id Selected active organization. @param label New display name. @returns Committed record. */
  renameOrganization(id: WorkspaceId, label: string, signal?: AbortSignal): Promise<WorkspaceRecordV2> {
    return this.metadataOperation(id, () => this.forWorkspace(id).admission.run(() => this.requireDirectory().rename(id, label, signal)))
  }

  /** @param id Selected organization. @param mode Stop exact work or drain admitted work. @returns Archived record only after full cleanup. */
  archiveOrganization(id: WorkspaceId, mode: 'stop' | 'wait', signal?: AbortSignal): Promise<WorkspaceRecordV2> {
    return this.metadataOperation(id, async () => {
      signal?.throwIfAborted()
      const runtime = this.forWorkspace(id)
      const rollback = runtime.admission.close()
      try { await this.requireDirectory().setLifecycle(id, 'archived', signal) }
      catch (error) { rollback(); throw error }
      if (mode === 'stop') await runtime.stopAdmittedWork()
      await runtime.admission.drain()
      await runtime.drainDeliveries()
      const record = this.requireDirectory().record(id)
      assertNoUnfinishedWork(record)
      return record
    })
  }

  /** @param id Quiescent archived organization. @returns Active record with history unchanged. */
  reopenOrganization(id: WorkspaceId, signal?: AbortSignal): Promise<WorkspaceRecordV2> {
    if (this.forWorkspace(id).admission.pending !== 0 || this.metadataFlights.has(id)) return Promise.reject(new Error('organization is busy'))
    return this.metadataOperation(id, async () => {
      const runtime = this.forWorkspace(id)
      return await runtime.admission.withIdle(async () => {
        const record = await this.requireDirectory().setLifecycle(id, 'active', signal)
        runtime.prepareReopen()
        return record
      }).then(record => { runtime.admission.reopen(); return record })
    })
  }

  /** @param id Idle organization. @returns A canonical document without local sessions or operation metadata. */
  exportOrganization(id: WorkspaceId, signal?: AbortSignal): Promise<OrganizationExport> {
    return this.admission.run(async () => {
      const runtime = this.forWorkspace(id)
      if (this.metadataFlights.has(id)) throw new Error('organization is busy')
      return runtime.admission.withIdle(async () => {
        signal?.throwIfAborted()
        const record = this.requireDirectory().record(id)
        assertNoUnfinishedWork(record)
        return createWorkspaceExportV3(record, { exportedAt: new Date().toISOString() })
      })
    })
  }

  private shutdown(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.closing = true
    this.admission.close()
    for (const runtime of this.runtimes.values()) runtime.closeAdmission()
    this.disposal = this.close()
    return this.disposal
  }

  private async close(): Promise<void> {
    const existing = new Set(this.runtimes.values())
    const cleanup = Promise.allSettled([...existing].map(runtime => runtime.dispose()))
    await this.admission.drain()
    const results = [
      ...await cleanup,
      ...await Promise.allSettled([...this.runtimes.values()].filter(runtime => !existing.has(runtime)).map(runtime => runtime.dispose())),
    ]
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    try { await this.closeDomain?.() }
    catch (error) { failures.push(error) }
    if (failures.length > 0) throw new AggregateError(failures, 'organization shutdown failed')
  }

  private runtimeForAgent(agent: Agent): WorkspaceRuntime | undefined {
    return [...this.runtimes.values()].find(runtime => runtime.agentIdFor(agent) !== undefined)
  }

  private async materializeRuntime(id: WorkspaceId): Promise<void> {
    if (this.runtimes.has(id)) return
    const runtime = new WorkspaceRuntime(this.ctx, this.config, this.requireDirectory(), id)
    if (this.closing) runtime.closeAdmission()
    this.runtimes.set(id, runtime)
    try { await runtime.initialize() }
    catch (error) { this.runtimes.delete(id); throw error }
  }

  private requireDirectory(): WorkspaceDirectory {
    if (this.directory === undefined) throw new Error('organization directory is not initialized')
    return this.directory
  }

  private importLimits(): WorkspaceImportLimits {
    return { maxBytes: this.config.importMaxBytes, maxEntities: this.config.importMaxEntities, maxEvents: this.config.importMaxEvents, maxStringBytes: this.config.importMaxStringBytes, maxDepth: this.config.importMaxDepth }
  }

  private metadataOperation(id: WorkspaceId, operation: () => Promise<WorkspaceRecordV2>): Promise<WorkspaceRecordV2> {
    if (this.metadataFlights.has(id)) return Promise.reject(new Error('organization metadata operation is already in progress'))
    const result = this.admission.run(operation)
    this.metadataFlights.set(id, result)
    void result.finally(() => { if (this.metadataFlights.get(id) === result) this.metadataFlights.delete(id) }).catch((_error) => { /* The caller owns the operation failure. */ })
    return result
  }
}

function assertNoUnfinishedWork(record: WorkspaceRecordV2): void {
  for (const task of Object.values(record.aggregate.tasks)) {
    const phase = inspectTaskDelivery(record.aggregate, task.id).phase
    if (phase === 'started' || phase === 'accepted') throw new Error('organization has unfinished task delivery')
  }
  if (Object.values(record.aggregate.childRuns).some(child => child.status === 'running')) throw new Error('organization has unfinished child work')
}

export default AgentWorkspaceDomainService
export { WorkspaceRuntime } from './workspace-runtime.ts'
export { projectDefinitionHistory } from './definition-history.ts'
export type { DefinitionHistoryItem, DefinitionRevisionCreationEvent } from './definition-history.ts'
export { queryAgentMemory } from './memory-query.ts'
export type { MemoryActor, MemoryDefinitionRevision, MemoryItem, MemoryPage, MemoryQuery, MemorySource, MemorySubject } from './memory-query.ts'
export { createForwardWorkspaceExportV1, WORKSPACE_EXPORT_FORMAT, WORKSPACE_EXPORT_FORMAT_VERSION, WORKSPACE_EXPORT_COMPATIBLE_IMPORT_RANGE, AGENT_WORKSPACE_PLUGIN_VERSION } from './forward-export.ts'
export type { ForwardWorkspaceAggregateV1, ForwardWorkspaceDescriptorV1, ForwardWorkspaceExportDocumentV1, ForwardWorkspaceExportEnvelopeV1 } from './forward-export.ts'
