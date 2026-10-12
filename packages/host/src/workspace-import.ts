/** Preparation of portable workspace documents for a new durable workspace. */

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import canonicalize from 'canonicalize'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { WorkspaceId } from './ids.ts'
import type { ForwardWorkspaceDescriptorV1 } from './forward-export.ts'
import type { WorkspaceState } from './types.ts'
import { WORKSPACE_EXPORT_FORMAT, WORKSPACE_EXPORT_FORMAT_VERSION } from './forward-export.ts'
import { workspaceStateSchema } from './workspace-state-schema.ts'
import { assertWorkspaceInvariants } from './invariant.ts'
import { inspectTaskDelivery } from './task-delivery.ts'

/** Explicit resource budgets for one untrusted import document. */
export interface WorkspaceImportLimits {
  readonly maxBytes: number
  readonly maxEntities: number
  readonly maxEvents: number
  readonly maxStringBytes: number
  /** Maximum nested JSON containers, with the root container counted as one. */
  readonly maxDepth: number
}

/** Source metadata and detached aggregate ready for caller-owned persistence. */
export interface PreparedWorkspaceImportV1 {
  readonly descriptor: ForwardWorkspaceDescriptorV1
  readonly sourceWorkspaceId: WorkspaceId
  readonly sourcePluginVersion: string
  readonly exportedAt: string
  readonly state: WorkspaceState
}

const documentSchema = z.object({
  format: z.literal(WORKSPACE_EXPORT_FORMAT),
  formatVersion: z.literal(WORKSPACE_EXPORT_FORMAT_VERSION),
  pluginVersion: z.string(),
  compatibleImportRange: z.string(),
  exportedAt: z.string().refine(value => {
    const date = new Date(value)
    return !Number.isNaN(date.valueOf()) && date.toISOString() === value
  }),
  workspace: z.object({
    descriptor: z.object({
      id: z.literal('local').transform(WorkspaceId),
      label: z.string().min(1),
      lifecycle: z.enum(['active', 'archived']),
    }).strict(),
    aggregate: workspaceStateSchema.omit({ workspaceId: true, sessionBindings: true }),
  }).strict(),
  diagnostics: z.object({ sessionBindingCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict().optional(),
  digest: z.object({
    algorithm: z.literal('sha-256'),
    canonicalization: z.literal('RFC8785'),
    hex: z.string().regex(/^[0-9a-f]{64}$/u),
  }).strict(),
}).strict()

/** Frozen version one reader reused by the current multi-version portable reader. */
export const workspaceImportDocumentV1Schema = documentSchema

const limitFields = ['maxBytes', 'maxEntities', 'maxEvents', 'maxStringBytes', 'maxDepth'] as const
const entityFields = [
  'definitions', 'definitionRevisions', 'agents', 'rooms', 'memberships',
  'tasks', 'taskAssignments', 'delegationGrants', 'childRuns',
] as const

/**
 * Validate a frozen v1 export and detach it for a new workspace without executing or storing it.
 * The digest detects corruption; it does not authenticate the source. Compatibility ranges are metadata.
 * Rejects duplicate JSON keys and isolated Unicode surrogates as required by RFC 8785.
 * Rejects unfinished child runs and delivery attempts. The caller checks target identity uniqueness.
 * @param json Portable source JSON.
 * @param options New workspace identity and explicit resource budgets.
 * @returns Detached source metadata and prepared durable state.
 */
export function prepareWorkspaceImportV1(
  json: string,
  options: { readonly workspaceId: WorkspaceId; readonly limits: WorkspaceImportLimits },
): PreparedWorkspaceImportV1 {
  return prepareWorkspaceImportWithSchema(json, options, documentSchema)
}

/** Complete portable input fields consumed by the shared import validation. */
export type WorkspaceImportDocument = Omit<z.output<typeof documentSchema>, 'formatVersion'> & { readonly formatVersion: number }

/**
 * Apply input budgets, raw-envelope hashing, and source and target aggregate validation for a format reader.
 * @param json Untrusted portable JSON.
 * @param options Target identity and explicit budgets.
 * @param schema Strict reader for the selected portable format version.
 * @returns Detached prepared metadata and aggregate.
 */
export function prepareWorkspaceImportWithSchema(
  json: string,
  options: { readonly workspaceId: WorkspaceId; readonly limits: WorkspaceImportLimits },
  schema: z.ZodType<WorkspaceImportDocument>,
): PreparedWorkspaceImportV1
/** Project additional validated portable fields without reparsing or changing the v1 result. */
export function prepareWorkspaceImportWithSchema<Document extends WorkspaceImportDocument, Value>(
  json: string,
  options: { readonly workspaceId: WorkspaceId; readonly limits: WorkspaceImportLimits },
  schema: z.ZodType<Document>,
  project: (document: Document, source: WorkspaceState, target: WorkspaceState, prepared: PreparedWorkspaceImportV1) => Value,
): Value
export function prepareWorkspaceImportWithSchema<Document extends WorkspaceImportDocument, Value>(
  json: string,
  options: { readonly workspaceId: WorkspaceId; readonly limits: WorkspaceImportLimits },
  schema: z.ZodType<Document>,
  project?: (document: Document, source: WorkspaceState, target: WorkspaceState, prepared: PreparedWorkspaceImportV1) => Value,
): PreparedWorkspaceImportV1 | Value {
  assertImportLimits(options.limits)
  if (options.workspaceId.trim() === '' || /[\s:\u0000-\u001f\u007f-\u009f]/u.test(options.workspaceId)) {
    throw new Error('workspace import target identity is invalid')
  }
  assertImportByteLimit(json, options.limits)
  let input: unknown
  try {
    input = JSON.parse(json)
  } catch (_error) {
    // Parser diagnostics can contain source text.
    throw new Error('workspace import contains invalid JSON')
  }
  assertTreeLimits(input, options.limits)
  assertUniqueObjectKeys(json, options.limits.maxDepth)
  assertCollectionLimits(input, options.limits)
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new Error('invalid workspace import document')
  const { digest, ...envelope } = parsed.data
  const { digest: _sourceDigest, ...sourceEnvelope } = requireRecord(input)
  const canonical = canonicalize(sourceEnvelope)
  if (canonical === undefined || createHash('sha256').update(canonical).digest('hex') !== digest.hex) {
    throw new Error('workspace import digest does not match the document')
  }
  const descriptor = envelope.workspace.descriptor
  if (options.workspaceId === descriptor.id) throw new Error('workspace import target identity must be new')
  const source: WorkspaceState = { ...envelope.workspace.aggregate, workspaceId: descriptor.id, sessionBindings: {} }
  assertImportInvariants(source)
  if (Object.values(source.childRuns).some(run => run.status === 'running')) {
    throw new Error('workspace import has an unfinished child run')
  }
  for (const task of Object.values(source.tasks)) {
    const { phase } = inspectTaskDelivery(source, task.id)
    if (phase === 'started' || phase === 'accepted') throw new Error('workspace import has an unfinished task delivery')
  }
  const detached = structuredClone(source)
  const state: WorkspaceState = {
    ...detached,
    workspaceId: options.workspaceId,
    sessionBindings: {},
    events: detached.events.map(event => 'messageId' in event
      ? { ...event, messageId: MessageId(`agent-workspace-task:${options.workspaceId}:${event.taskDeliveryAttemptId}`) }
      : event),
  }
  assertImportInvariants(state)
  const prepared: PreparedWorkspaceImportV1 = {
    descriptor: { ...descriptor, id: options.workspaceId },
    sourceWorkspaceId: descriptor.id,
    sourcePluginVersion: envelope.pluginVersion,
    exportedAt: envelope.exportedAt,
    state,
  }
  return project === undefined ? prepared : project(parsed.data, source, state, prepared)
}

/**
 * Enforce explicit budgets and raw byte size before processing an import operation request.
 * @param json Untrusted source JSON.
 * @param limits Explicit positive resource budgets.
 * @returns Nothing; throws before parsing or canonicalizing an oversized input.
 */
export function assertWorkspaceImportBudget(json: string, limits: WorkspaceImportLimits): void {
  assertImportLimits(limits)
  assertImportByteLimit(json, limits)
}

function assertImportLimits(limits: WorkspaceImportLimits): void {
  for (const field of limitFields) {
    if (!Number.isSafeInteger(limits[field]) || limits[field] <= 0) {
      throw new Error('workspace import limits must be explicit positive safe integers')
    }
  }
}

function assertImportByteLimit(json: string, limits: WorkspaceImportLimits): void {
  if (Buffer.byteLength(json, 'utf8') > limits.maxBytes) throw new Error('workspace import exceeds maxBytes')
}

function assertImportInvariants(state: WorkspaceState): void {
  try {
    assertWorkspaceInvariants(state, state.workspaceId)
  } catch (_error) {
    // Relationship diagnostics can contain imported identifiers.
    throw new Error('invalid workspace import relationships or counters')
  }
}

function assertTreeLimits(input: unknown, limits: WorkspaceImportLimits): void {
  const pending: { value: unknown; depth: number }[] = [{ value: input, depth: 1 }]
  while (pending.length > 0) {
    const { value, depth } = pending.pop()!
    if (typeof value === 'string') assertString(value, limits.maxStringBytes)
    if (value === null || typeof value !== 'object') continue
    if (depth > limits.maxDepth) throw new Error('workspace import exceeds maxDepth')
    if (Array.isArray(value)) {
      for (const child of value) pending.push({ value: child, depth: depth + 1 })
    } else {
      for (const [key, child] of Object.entries(value)) {
        assertString(key, limits.maxStringBytes)
        if (key === '__proto__') throw new Error('invalid workspace import object key')
        pending.push({ value: child, depth: depth + 1 })
      }
    }
  }
}

function assertString(value: string, maxBytes: number): void {
  if (Buffer.byteLength(value, 'utf8') > maxBytes) throw new Error('workspace import exceeds maxStringBytes')
  if (!isWorkspaceUnicodeValid(value)) throw new Error('workspace import contains invalid Unicode')
}

/**
 * Check a string or object key for isolated surrogates forbidden by RFC 8785.
 * @param value Original string, without normalization or replacement.
 * @returns Whether all surrogate code units belong to valid Unicode pairs.
 */
export function isWorkspaceUnicodeValid(value: string): boolean {
  return !/[\ud800-\udfff]/u.test(value)
}

function assertUniqueObjectKeys(json: string, maxDepth: number): void {
  type Container = { readonly type: 'array' } | { readonly type: 'object'; readonly keys: Set<string>; expectingKey: boolean }
  const containers: Container[] = []
  // JSON.parse has validated syntax. This scan retains object keys that parsing would overwrite.
  for (const match of json.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\],:]/gu)) {
    const token = match[0]
    const current = containers.at(-1)
    switch (token) {
      case '{':
      case '[':
        if (containers.length >= maxDepth) throw new Error('workspace import exceeds maxDepth')
        containers.push(token === '{' ? { type: 'object', keys: new Set(), expectingKey: true } : { type: 'array' })
        break
      case '}':
      case ']':
        containers.pop()
        break
      case ':':
        if (current?.type === 'object') current.expectingKey = false
        break
      case ',':
        if (current?.type === 'object') current.expectingKey = true
        break
      default:
        if (current?.type === 'object' && current.expectingKey) {
          const key: string = JSON.parse(token)
          if (current.keys.has(key)) throw new Error('workspace import contains duplicate object keys')
          current.keys.add(key)
        }
    }
  }
}

function assertCollectionLimits(input: unknown, limits: WorkspaceImportLimits): void {
  const workspace = requireRecord(requireRecord(input).workspace)
  const aggregate = requireRecord(workspace.aggregate)
  if (!Array.isArray(aggregate.events) || !Array.isArray(aggregate.memoryEntries)) throw new Error('invalid workspace import document')
  if (aggregate.events.length > limits.maxEvents) throw new Error('workspace import exceeds maxEvents')
  let entities = aggregate.memoryEntries.length
  if (entities > limits.maxEntities) throw new Error('workspace import exceeds maxEntities')
  for (const field of entityFields) {
    entities += Object.keys(requireRecord(aggregate[field])).length
    if (entities > limits.maxEntities) throw new Error('workspace import exceeds maxEntities')
  }
  if (Object.hasOwn(workspace, 'workflow')) {
    const workflow = requireRecord(workspace.workflow)
    if (!Array.isArray(workflow.facts)) throw new Error('invalid workspace import document')
    if (aggregate.events.length + workflow.facts.length > limits.maxEvents) throw new Error('workspace import exceeds maxEvents')
    for (const field of ['drafts', 'taskTemplates', 'taskTemplateRevisions', 'companyTemplates', 'companyTemplateRevisions', 'taskBriefs', 'artifacts', 'reviews', 'operations']) {
      entities += Object.keys(requireRecord(workflow[field])).length
      if (entities > limits.maxEntities) throw new Error('workspace import exceeds maxEntities')
    }
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid workspace import document')
  return value as Record<string, unknown>
}
