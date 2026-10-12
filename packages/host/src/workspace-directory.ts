/** Durable directory of independent organization records. */

import { createHash, randomUUID } from 'node:crypto'
import canonicalize from 'canonicalize'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceId } from './ids.ts'
import type { StoredWorkspace, WorkspaceRecordV2, WorkspaceOperationId, WorkspaceDirectoryEntry, WorkspaceDescriptor } from './workspace-record.ts'
import { storedWorkspaceSchema, workspaceRecordV2Schema, workspaceDescriptorSchema, assertWorkflowOperationDigests, workflowRequestDigest } from './workspace-record.ts'
import type { WorkspaceState } from './types.ts'
import type { WorkspaceImportLimits } from './workspace-import.ts'
import { assertWorkspaceImportBudget } from './workspace-import.ts'
import { prepareWorkspaceImport } from './workspace-portable.ts'
import { assertWorkspaceInvariants } from './invariant.ts'
import { createInitialState } from './state.ts'
import type { HumanId } from './ids.ts'
import type { WorkflowCommand, WorkflowEndpoint, WorkflowExpectedRevisions, WorkflowMutationResult, WorkflowMutationValueMap, WorkflowOperationId, WorkflowReceipt } from './workflow-contract.ts'
import { applyWorkflowCommand, assertWorkflowInvariants, createInitialWorkflowState, WorkflowBusinessError } from './workflow.ts'
import { workflowCommandSchema } from './workflow-schema.ts'
import { WorkspaceBusinessError } from './errors.ts'

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
          if (!('recordVersion' in value) || value.recordVersion !== 2) {
            await this.table.update(id, current => {
              const parsed = validateEntries(this.table.entries()).get(id)
              if (parsed === undefined) throw new Error('workspace record is missing')
              return validateRecord(id, current)
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
  record(id: WorkspaceId): WorkspaceRecordV2 {
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
    return this.updateRecord(id, record => ({ record: { ...record, aggregate: fn(structuredClone(record.aggregate)) }, value: undefined })).then(result => result.record.aggregate)
  }

  /**
   * Atomically transform the full detached record using the directory's existing queue.
   * @param id Organization identity.
   * @param transform Synchronous pure transform; all record invariants are checked before commit.
   * @param signal Cancellation checked after queue admission and before the atomic callback.
   * @returns Detached committed record and transform value. Cancellation after commit does not undo it.
   */
  updateRecord<Value>(id: WorkspaceId, transform: (record: WorkspaceRecordV2) => { readonly record: WorkspaceRecordV2; readonly value: Value }, signal?: AbortSignal): Promise<{ readonly record: WorkspaceRecordV2; readonly value: Value }> {
    return this.enqueue(async () => {
      signal?.throwIfAborted()
      this.records()
      let value!: Value
      const updated = await this.table.update(id, current => {
        signal?.throwIfAborted()
        const transformed = transform(structuredClone(validateRecord(id, current)))
        value = transformed.value
        return this.validateReplacement(id, transformed.record)
      })
      return { record: structuredClone(validateRecord(id, updated)), value: structuredClone(value) }
    })
  }

  /**
   * Commit both revision checks, transition and retry receipt in one record replacement.
   * @param id Organization identity.
   * @param request Expected revisions and semantic command under a stable operation identity.
   * @param context Trusted human identity and canonical Host time.
   * @param signal Cancellation checked while queued and immediately before commit.
   * @returns Stable receipt with current revisions; identical retries append nothing.
   */
  executeWorkflow<K extends WorkflowEndpoint>(id: WorkspaceId, request: WorkflowExpectedRevisions & { readonly operationId: WorkflowOperationId; readonly command: WorkflowCommand<K> }, context: { readonly humanId: HumanId; readonly occurredAt: string }, signal?: AbortSignal): Promise<WorkflowMutationResult<WorkflowMutationValueMap[K]>> {
    return this.updateRecord(id, record => {
      if (record.descriptor.lifecycle !== 'active') throw new WorkflowBusinessError('workflow-read-only', { workspaceId: id })
      if (!workspaceDescriptorSchema.shape.creation.unwrap().shape.operationId.safeParse(request.operationId).success || request.operationId === '__proto__') throw new Error('workflow operation identity is invalid')
      const command = workflowCommandSchema.parse(request.command)
      const digest = workflowRequestDigest(context.humanId, command)
      if (Object.hasOwn(record.workflow.operations, request.operationId)) {
        const previous = record.workflow.operations[request.operationId]!
        if (previous.requestDigest !== digest) throw new WorkflowBusinessError('workflow-operation-reused', { operationId: request.operationId })
        return { record, value: { receipt: previous.receipt.value as WorkflowMutationValueMap[K], replayed: true } }
      }
      if (record.aggregate.revision !== request.expectedAggregateRevision) throw new WorkspaceBusinessError('stale-revision', { expectedRevision: request.expectedAggregateRevision, actualRevision: record.aggregate.revision })
      if (record.workflow.revision !== request.expectedWorkflowRevision) throw new WorkflowBusinessError('stale-workflow-revision', { expectedWorkflowRevision: request.expectedWorkflowRevision, actualWorkflowRevision: record.workflow.revision })
      const transition = applyWorkflowCommand({ aggregate: record.aggregate, workflow: record.workflow }, command, context)
      const receipt = { type: command.type, value: structuredClone(transition.value) } as WorkflowReceipt
      const workflow = { ...transition.workflow, operations: { ...transition.workflow.operations, [request.operationId]: { id: request.operationId, requestDigest: digest, receipt, aggregateRevision: transition.aggregate.revision, workflowRevision: transition.workflow.revision } } }
      return { record: { ...record, aggregate: transition.aggregate, workflow }, value: { receipt: transition.value as WorkflowMutationValueMap[K], replayed: false } }
    }, signal).then(({ record, value }) => ({ workspaceId: id, aggregateRevision: record.aggregate.revision, workflowRevision: record.workflow.revision, value: value.receipt, replayed: value.replayed }))
  }

  /**
   * Create an empty organization or return the record committed for an identical operation retry.
   * @param request Stable operation identifier and organization label.
   * @returns Detached committed record with a newly generated identity.
   */
  create(request: CreateWorkspaceRequest): Promise<WorkspaceRecordV2> {
    return this.enqueue(async () => {
      request.signal?.throwIfAborted()
      const digest = requestDigest({ kind: 'created', label: request.label })
      const previous = this.operationRetry(request.operationId, digest)
      if (previous !== undefined) return structuredClone(previous)
      const id = WorkspaceId(`org-${randomUUID()}`)
      return this.insert({
        recordVersion: 2,
        descriptor: { id, label: request.label, lifecycle: 'active', creation: {
          kind: 'created', createdAt: new Date().toISOString(), operationId: request.operationId, requestDigest: digest,
        } },
        aggregate: createInitialState(id),
        workflow: createInitialWorkflowState(),
      })
    })
  }

  /**
   * Import a portable organization or return an identical operation's durable record.
   * @param request Raw source JSON, optional label override, operation identity and explicit budgets.
   * @returns Detached committed record with a new identity and no source session bindings.
   */
  import(request: ImportWorkspaceRequest): Promise<WorkspaceRecordV2> {
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
        recordVersion: 2,
        descriptor: { ...prepared.descriptor, label: request.label ?? prepared.descriptor.label, creation: {
          kind: 'imported', createdAt: new Date().toISOString(), operationId: request.operationId, requestDigest: digest,
        } },
        aggregate: prepared.state,
        workflow: prepared.workflow,
      })
    })
  }

  /**
   * Change only user-facing organization metadata.
   * @param id Organization identity.
   * @param label Nonblank display label.
   * @returns Detached committed record with its aggregate unchanged.
   */
  rename(id: WorkspaceId, label: string, signal?: AbortSignal): Promise<WorkspaceRecordV2> {
    return this.updateDescriptor(id, descriptor => ({ ...descriptor, label }), signal)
  }

  /**
   * Change only durable lifecycle metadata; the Host must coordinate employee admission and shutdown.
   * @param id Organization identity.
   * @param lifecycle New lifecycle.
   * @returns Detached committed record with its aggregate unchanged.
   */
  setLifecycle(id: WorkspaceId, lifecycle: WorkspaceDescriptor['lifecycle'], signal?: AbortSignal): Promise<WorkspaceRecordV2> {
    return this.updateDescriptor(id, descriptor => ({ ...descriptor, lifecycle }), signal)
  }

  private records(): Map<WorkspaceId, WorkspaceRecordV2> {
    if (!this.initialized) throw new Error('workspace directory is not initialized')
    return validateEntries(this.table.entries())
  }

  private operationRetry(operationId: WorkspaceOperationId, digest: string): WorkspaceRecordV2 | undefined {
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

  private async insert(record: WorkspaceRecordV2): Promise<WorkspaceRecordV2> {
    const id = record.descriptor.id
    if (this.table.get(id) !== undefined) throw new Error('workspace identity already exists')
    const validated = this.validateReplacement(id, record)
    await this.table.put(id, validated)
    return structuredClone(validated)
  }

  private updateDescriptor(id: WorkspaceId, fn: (descriptor: WorkspaceDescriptor) => WorkspaceDescriptor, signal?: AbortSignal): Promise<WorkspaceRecordV2> {
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

  private validateReplacement(id: WorkspaceId, candidate: WorkspaceRecordV2): WorkspaceRecordV2 {
    const parsed = workspaceRecordV2Schema.safeParse(candidate)
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

function validateEntries(entries: Iterable<[WorkspaceId, StoredWorkspace]>): Map<WorkspaceId, WorkspaceRecordV2> {
  const result = new Map<WorkspaceId, WorkspaceRecordV2>()
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

function validateRecord(id: WorkspaceId, value: StoredWorkspace): WorkspaceRecordV2 {
  const parsed = storedWorkspaceSchema.safeParse(value)
  if (!parsed.success) throw new Error('invalid workspace record')
  const record = 'recordVersion' in parsed.data
    ? parsed.data.recordVersion === 2 ? parsed.data : { ...parsed.data, recordVersion: 2 as const, workflow: createInitialWorkflowState() }
    : wrapLegacy(parsed.data)
  if (record.descriptor.id !== id) throw new Error('workspace descriptor does not match its table key')
  assertWorkspaceInvariants(record.aggregate, id)
  assertWorkflowInvariants(record.aggregate, record.workflow)
  assertWorkflowOperationDigests(record.workflow)
  return record
}

function wrapLegacy(aggregate: WorkspaceState): WorkspaceRecordV2 {
  return { recordVersion: 2, descriptor: { id: aggregate.workspaceId, label: 'Local organization', lifecycle: 'active' }, aggregate, workflow: createInitialWorkflowState() }
}

function requestDigest(value: { kind: 'created'; label: string } | { kind: 'imported'; label: string | null; sourceDigest: string }): string {
  const json = canonicalize(value)
  if (json === undefined) throw new Error('invalid workspace operation request')
  return createHash('sha256').update(json).digest('hex')
}
