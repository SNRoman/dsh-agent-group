/** Durable organization metadata and strict readers for released workspace records. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import canonicalize from 'canonicalize'
import { WorkspaceId } from './ids.ts'
import type { WorkspaceState } from './types.ts'
import { workspaceStateSchema } from './workspace-state-schema.ts'
import type { WorkflowCommand, WorkflowState } from './workflow-contract.ts'
import type { HumanId } from './ids.ts'
import { workflowCommandSchema, workflowStateSchema } from './workflow-schema.ts'
import type { CommunicationState } from './communication-contract.ts'
import { communicationStateSchema } from './communication-schema.ts'

/** Identifies one retryable organization creation or import request. */
export type WorkspaceOperationId = Branded<'AgentWorkspaceOperationId'>

/**
 * Brand a caller-owned operation identifier.
 * @param value Stable identifier reused when retrying the same request.
 * @returns Branded operation identifier.
 */
export function WorkspaceOperationId(value: string): WorkspaceOperationId { return value as WorkspaceOperationId }

/** Origin recorded only for organizations created or imported by the directory. */
export interface WorkspaceCreation {
  readonly kind: 'created' | 'imported'
  readonly createdAt: string
  readonly operationId: WorkspaceOperationId
  readonly requestDigest: string
}

/** Organization identity and metadata independent of its business aggregate. */
export interface WorkspaceDescriptor {
  readonly id: WorkspaceId
  readonly label: string
  readonly lifecycle: 'active' | 'archived'
  readonly creation?: WorkspaceCreation | undefined
}

/** Version one durable organization record. */
export interface WorkspaceRecordV1 {
  readonly recordVersion: 1
  readonly descriptor: WorkspaceDescriptor
  readonly aggregate: WorkspaceState
}

/** Released local aggregate, frozen metadata wrappers or communication successor record. */
export type StoredWorkspace = WorkspaceState | WorkspaceRecordV1 | WorkspaceRecordV2 | WorkspaceRecordV3

/** Successor record stores workflow beside the frozen aggregate in one atomic value. */
export interface WorkspaceRecordV2 {
  readonly recordVersion: 2
  readonly descriptor: WorkspaceDescriptor
  readonly aggregate: WorkspaceState
  readonly workflow: WorkflowState
}

/** Successor record preserves raw audit data alongside communication and context rebuild metadata. */
export interface WorkspaceRecordV3 extends Omit<WorkspaceRecordV2, 'recordVersion'> {
  readonly recordVersion: 3
  readonly communication: CommunicationState
}

/** Detached directory entry for selecting an organization. */
export interface WorkspaceDirectoryEntry {
  readonly descriptor: WorkspaceDescriptor
  readonly revision: number
  readonly eventCount: number
  readonly agentCount: number
}

/** Nonempty organization identities safe for task message identifiers. */
export const workspaceIdentitySchema = z.string().min(1)
  .refine(value => !/[\s:\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value))
  .transform(WorkspaceId)

/** Metadata reader used at durable and portable input parsing. */
export const workspaceDescriptorSchema = z.object({
  id: workspaceIdentitySchema,
  label: z.string().refine(value => value.trim() !== '' && !/[\ud800-\udfff]/u.test(value)),
  lifecycle: z.enum(['active', 'archived']),
  creation: z.object({
    kind: z.enum(['created', 'imported']),
    createdAt: z.string().refine(value => {
      const date = new Date(value)
      return !Number.isNaN(date.valueOf()) && date.toISOString() === value
    }),
    operationId: z.string().refine(value => value.trim() !== '' && !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value)).transform(WorkspaceOperationId),
    requestDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }).strict().optional(),
}).strict() satisfies z.ZodType<WorkspaceDescriptor>

/** Strict version one records require descriptor and aggregate identities to agree. */
const recordSchema = z.object({
  recordVersion: z.literal(1),
  descriptor: workspaceDescriptorSchema,
  aggregate: workspaceStateSchema,
}).strict().refine(record => record.descriptor.id === record.aggregate.workspaceId) satisfies z.ZodType<WorkspaceRecordV1>

/** Strict version one record reader rejects raw object keys before Zod record conversion. */
export const workspaceRecordSchema = z.preprocess((value, ctx) => {
  if (containsPrototypeKey(value)) ctx.addIssue({ code: 'custom', message: 'invalid workspace object key' })
  return value
}, recordSchema)

const recordV2Schema = z.object({ recordVersion: z.literal(2), descriptor: workspaceDescriptorSchema, aggregate: workspaceStateSchema, workflow: workflowStateSchema }).strict().refine(record => record.descriptor.id === record.aggregate.workspaceId) satisfies z.ZodType<WorkspaceRecordV2>

/** Strict successor reader rejects prototype keys before record conversion. */
export const workspaceRecordV2Schema = z.preprocess((value, ctx) => {
  if (containsPrototypeKey(value)) ctx.addIssue({ code: 'custom', message: 'invalid workspace object key' })
  return value
}, recordV2Schema)

const recordV3Schema = z.object({ recordVersion: z.literal(3), descriptor: workspaceDescriptorSchema, aggregate: workspaceStateSchema, workflow: workflowStateSchema, communication: communicationStateSchema }).strict().refine(record => record.descriptor.id === record.aggregate.workspaceId) satisfies z.ZodType<WorkspaceRecordV3>

/** Strict communication successor reader; relationship validation belongs to the durable owner. */
export const workspaceRecordV3Schema = z.preprocess((value, ctx) => {
  if (containsPrototypeKey(value)) ctx.addIssue({ code: 'custom', message: 'invalid workspace object key' })
  return value
}, recordV3Schema)

/** Legacy records are accepted only for the released local organization. */
export const storedWorkspaceSchema = z.preprocess((value, ctx) => {
  if (containsPrototypeKey(value)) ctx.addIssue({ code: 'custom', message: 'invalid workspace object key' })
  return value
}, z.union([
  workspaceStateSchema.refine(state => state.workspaceId === 'local'),
  recordSchema,
  recordV2Schema,
  recordV3Schema,
])) satisfies z.ZodType<StoredWorkspace>

/**
 * Hash normalized semantic workflow fields; transport revisions and Host time are excluded.
 * @param humanId Trusted actor recorded in the corresponding human fact.
 * @param command Semantic command, including any expected draft revision.
 * @returns SHA-256 retry identity shared by durable validation and new commits.
 */
export function workflowRequestDigest(humanId: HumanId, command: WorkflowCommand): string {
  const json = canonicalize({ humanId, command: workflowCommandSchema.parse(command) })
  if (json === undefined) throw new Error('invalid workflow operation request')
  return createHash('sha256').update(json).digest('hex')
}

/**
 * Validate persisted operation identity against its exact human fact before restart or import.
 * @param workflow Complete workflow, with structural and relationship validation performed by its caller.
 * @returns Nothing; throws if a digest or operation-to-fact ownership differs.
 */
export function assertWorkflowOperationDigests(workflow: WorkflowState): void {
  const revisions = new Set<number>()
  for (const operation of Object.values(workflow.operations)) {
    const fact = workflow.facts[operation.workflowRevision - 1]
    if (fact === undefined || fact.type === 'workflow/employee/proposed' || revisions.has(operation.workflowRevision)) throw new Error('workflow operation fact ownership is invalid')
    revisions.add(operation.workflowRevision)
    if (operation.requestDigest !== workflowRequestDigest(fact.actor.id, fact.command)) throw new Error('workflow operation digest does not match its fact')
  }
}

function containsPrototypeKey(value: unknown): boolean {
  const pending: unknown[] = [value]
  const seen = new Set<object>()
  while (pending.length > 0) {
    const item = pending.pop()
    if (item === null || typeof item !== 'object' || seen.has(item)) continue
    seen.add(item)
    for (const [key, child] of Object.entries(item)) {
      if (key === '__proto__') return true
      pending.push(child)
    }
  }
  return false
}
