/** Durable directory of independent organization records. */

import { createHash, randomUUID } from 'node:crypto'
import canonicalize from 'canonicalize'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceId } from './ids.ts'
import type { StoredWorkspace, WorkspaceRecordV1, WorkspaceOperationId, WorkspaceDirectoryEntry, WorkspaceDescriptor } from './workspace-record.ts'
import { storedWorkspaceSchema, workspaceRecordSchema, workspaceDescriptorSchema } from './workspace-record.ts'
import type { WorkspaceState } from './types.ts'
import type { WorkspaceImportLimits } from './workspace-import.ts'
import { assertWorkspaceImportBudget } from './workspace-import.ts'
import { prepareWorkspaceImport } from './workspace-portable.ts'
import { assertWorkspaceInvariants } from './invariant.ts'
import { createInitialState } from './state.ts'

/** Fields of one retryable empty-organization request. */
export interface CreateWorkspaceRequest {
  readonly operationId: WorkspaceOperationId
  readonly label: string
  readonly signal?: AbortSignal
}

/** Fields of one retryable portable-organization import request. */
export interface ImportWorkspaceRequest {
  readonly operationId: WorkspaceOperationId
  readonly json: string
  readonly label?: string
  readonly limits: WorkspaceImportLimits
  readonly signal?: AbortSignal
}

/**
 * Serializes directory mutations and validates relationships across all stored organizations.
 * The Host owns employee admission, draining and orphaned-child repair separately.
 */
export class WorkspaceDirectory {
  private chain: Promise<void> = Promise.resolve()
  private initialized = false

  /**
   * @param table Authoritative domain table; the directory owns all its organization writes.
   */
  constructor(private readonly table: KvTable<WorkspaceId, StoredWorkspace>) {}

  /**
   * Validate the whole table before migrating the released local aggregate once.
   * Only an empty table receives a new local organization. Existing records never receive fabricated creation metadata.
   * @returns Resolution after any required single-record write is durable.
   */
  initialize(): Promise<void> {
    return this.enqueue(async () => {
      const records = validateEntries(this.table.entries())
      if (records.size === 0) {
        const id = WorkspaceId('local')
        await this.table.put(id, wrapLegacy(createInitialState(id)))
      } else {
        for (const [id, value] of this.table.entries()) {
          if (!('recordVersion' in value)) {
            await this.table.update(id, current => {
              const parsed = validateEntries(this.table.entries()).get(id)
              if (parsed === undefined) throw new Error('workspace record is missing')
              return 'recordVersion' in current ? parsed : wrapLegacy(parsed.aggregate)
            })
          }
        }
      }
      this.initialized = true
    })
  }

  /**
   * @returns Detached descriptors and aggregate counts for every stored organization.
   */
  list(): WorkspaceDirectoryEntry[] {
    return [...this.records().values()].map(({ descriptor, aggregate }) => ({
      descriptor: structuredClone(descriptor),
      revision: aggregate.revision,
      eventCount: aggregate.events.length,
      agentCount: Object.keys(aggregate.agents).length,
    }))
  }

  /**
   * @param id Organization identity.
   * @returns Detached record, or throws when the organization does not exist or the directory is invalid.
   */
  record(id: WorkspaceId): WorkspaceRecordV1 {
    const record = this.records().get(id)
    if (record === undefined) throw new Error('workspace record is missing')
    return structuredClone(record)
  }

  /**
   * @param id Organization identity.
   * @returns Detached business aggregate.
   */
  snapshot(id: WorkspaceId): WorkspaceState { return this.record(id).aggregate }

  /**
   * Apply a pure business mutation while preserving organization metadata.
   * @param id Organization identity.
   * @param fn Pure synchronous transform of a detached aggregate.
   * @returns Detached aggregate after the replacement is durable.
   */
  updateAggregate(id: WorkspaceId, fn: (state: WorkspaceState) => WorkspaceState): Promise<WorkspaceState> {
    return this.enqueue(async () => {
      this.records()
      const updated = await this.table.update(id, current => {
        const record = validateRecord(id, current)
        return this.validateReplacement(id, { ...record, aggregate: fn(structuredClone(record.aggregate)) })
      })
      return structuredClone(validateRecord(id, updated).aggregate)
    })
  }

  /**
   * Create an empty organization or return the record committed for an identical operation retry.
   * @param request Stable operation identifier and organization label.
   * @returns Detached committed record with a newly generated identity.
   */
  create(request: CreateWorkspaceRequest): Promise<WorkspaceRecordV1> {
    return this.enqueue(async () => {
      request.signal?.throwIfAborted()
      const digest = requestDigest({ kind: 'created', label: request.label })
      const previous = this.operationRetry(request.operationId, digest)
      if (previous !== undefined) return structuredClone(previous)
      const id = WorkspaceId(`org-${randomUUID()}`)
      return this.insert({
        recordVersion: 1,
        descriptor: { id, label: request.label, lifecycle: 'active', creation: {
          kind: 'created', createdAt: new Date().toISOString(), operationId: request.operationId, requestDigest: digest,
        } },
        aggregate: createInitialState(id),
      })
    })
  }

  /**
   * Import a portable organization or return an identical operation's durable record.
   * @param request Raw source JSON, optional label override, operation identity and explicit budgets.
   * @returns Detached committed record with a new identity and no source session bindings.
   */
  import(request: ImportWorkspaceRequest): Promise<WorkspaceRecordV1> {
    return this.enqueue(async () => {
      request.signal?.throwIfAborted()
      assertWorkspaceImportBudget(request.json, request.limits)
      const sourceDigest = createHash('sha256').update(request.json).digest('hex')
      const digest = requestDigest({ kind: 'imported', label: request.label ?? null, sourceDigest })
      const previous = this.operationRetry(request.operationId, digest)
      if (previous !== undefined) return structuredClone(previous)
      const id = WorkspaceId(`org-${randomUUID()}`)
      const prepared = prepareWorkspaceImport(request.json, { workspaceId: id, limits: request.limits })
      return this.insert({
        recordVersion: 1,
        descriptor: { ...prepared.descriptor, label: request.label ?? prepared.descriptor.label, creation: {
          kind: 'imported', createdAt: new Date().toISOString(), operationId: request.operationId, requestDigest: digest,
        } },
        aggregate: prepared.state,
      })
    })
  }

  /**
   * Change only user-facing organization metadata.
   * @param id Organization identity.
   * @param label Nonblank display label.
   * @returns Detached committed record with its aggregate unchanged.
   */
  rename(id: WorkspaceId, label: string, signal?: AbortSignal): Promise<WorkspaceRecordV1> {
    return this.updateDescriptor(id, descriptor => ({ ...descriptor, label }), signal)
  }

  /**
   * Change only durable lifecycle metadata; the Host must coordinate employee admission and shutdown.
   * @param id Organization identity.
   * @param lifecycle New lifecycle.
   * @returns Detached committed record with its aggregate unchanged.
   */
  setLifecycle(id: WorkspaceId, lifecycle: WorkspaceDescriptor['lifecycle'], signal?: AbortSignal): Promise<WorkspaceRecordV1> {
    return this.updateDescriptor(id, descriptor => ({ ...descriptor, lifecycle }), signal)
  }

  private records(): Map<WorkspaceId, WorkspaceRecordV1> {
    if (!this.initialized) throw new Error('workspace directory is not initialized')
    return validateEntries(this.table.entries())
  }

  private operationRetry(operationId: WorkspaceOperationId, digest: string): WorkspaceRecordV1 | undefined {
    if (!workspaceDescriptorSchema.shape.creation.unwrap().shape.operationId.safeParse(operationId).success) {
      throw new Error('workspace operation identity is invalid')
    }
    for (const record of this.records().values()) {
      if (record.descriptor.creation?.operationId !== operationId) continue
      if (record.descriptor.creation.requestDigest !== digest) throw new Error('workspace operation was reused for a different request')
      return record
    }
    return undefined
  }

  private async insert(record: WorkspaceRecordV1): Promise<WorkspaceRecordV1> {
    const id = record.descriptor.id
    if (this.table.get(id) !== undefined) throw new Error('workspace identity already exists')
    const validated = this.validateReplacement(id, record)
    await this.table.put(id, validated)
    return structuredClone(validated)
  }

  private updateDescriptor(id: WorkspaceId, fn: (descriptor: WorkspaceDescriptor) => WorkspaceDescriptor, signal?: AbortSignal): Promise<WorkspaceRecordV1> {
    return this.enqueue(async () => {
      signal?.throwIfAborted()
      this.records()
      const updated = await this.table.update(id, current => {
        signal?.throwIfAborted()
        const record = validateRecord(id, current)
        return this.validateReplacement(id, { ...record, descriptor: fn(structuredClone(record.descriptor)) })
      })
      return structuredClone(validateRecord(id, updated))
    })
  }

  private validateReplacement(id: WorkspaceId, candidate: WorkspaceRecordV1): WorkspaceRecordV1 {
    const parsed = workspaceRecordSchema.safeParse(candidate)
    if (!parsed.success) throw new Error('invalid workspace record')
    const entries = new Map(this.table.entries())
    entries.set(id, parsed.data)
    const validated = validateEntries(entries.entries()).get(id)
    if (validated === undefined) throw new Error('workspace record is missing')
    return validated
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation)
    this.chain = result.then(() => undefined, () => undefined)
    return result
  }
}

function validateEntries(entries: Iterable<[WorkspaceId, StoredWorkspace]>): Map<WorkspaceId, WorkspaceRecordV1> {
  const result = new Map<WorkspaceId, WorkspaceRecordV1>()
  const sessions = new Set<string>()
  const operations = new Set<WorkspaceOperationId>()
  for (const [id, value] of entries) {
    const record = validateRecord(id, value)
    const operationId = record.descriptor.creation?.operationId
    if (operationId !== undefined) {
      if (operations.has(operationId)) throw new Error('workspace operation is recorded more than once')
      operations.add(operationId)
    }
    for (const sessionId of Object.values(record.aggregate.sessionBindings)) {
      if (sessions.has(sessionId)) throw new Error('workspace session is bound in more than one organization')
      sessions.add(sessionId)
    }
    result.set(id, record)
  }
  return result
}

function validateRecord(id: WorkspaceId, value: StoredWorkspace): WorkspaceRecordV1 {
  const parsed = storedWorkspaceSchema.safeParse(value)
  if (!parsed.success) throw new Error('invalid workspace record')
  const record = 'recordVersion' in parsed.data ? parsed.data : wrapLegacy(parsed.data)
  if (record.descriptor.id !== id) throw new Error('workspace descriptor does not match its table key')
  assertWorkspaceInvariants(record.aggregate, id)
  return record
}

function wrapLegacy(aggregate: WorkspaceState): WorkspaceRecordV1 {
  return { recordVersion: 1, descriptor: { id: aggregate.workspaceId, label: 'Local organization', lifecycle: 'active' }, aggregate }
}

function requestDigest(value: { kind: 'created'; label: string } | { kind: 'imported'; label: string | null; sourceDigest: string }): string {
  const json = canonicalize(value)
  if (json === undefined) throw new Error('invalid workspace operation request')
  return createHash('sha256').update(json).digest('hex')
}
