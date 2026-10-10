/** Durable organization metadata and strict readers for released workspace records. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { WorkspaceId } from './ids.ts'
import type { WorkspaceState } from './types.ts'
import { workspaceStateSchema } from './workspace-state-schema.ts'

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

/** Released local aggregate or its version one metadata wrapper. */
export type StoredWorkspace = WorkspaceState | WorkspaceRecordV1

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

/** Legacy records are accepted only for the released local organization. */
export const storedWorkspaceSchema = z.preprocess((value, ctx) => {
  if (containsPrototypeKey(value)) ctx.addIssue({ code: 'custom', message: 'invalid workspace object key' })
  return value
}, z.union([
  workspaceStateSchema.refine(state => state.workspaceId === 'local'),
  recordSchema,
])) satisfies z.ZodType<StoredWorkspace>

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
