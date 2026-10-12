/** Pure portable organization version two/three producers and version one/two/three reader. */

import { createHash } from 'node:crypto'
import canonicalize from 'canonicalize'
import { z } from 'zod'
import type { WorkspaceRecordV1, WorkspaceRecordV2, WorkspaceDescriptor } from './workspace-record.ts'
import { workspaceDescriptorSchema, workspaceRecordSchema, workspaceRecordV2Schema, assertWorkflowOperationDigests } from './workspace-record.ts'
import type { WorkflowState } from './workflow-contract.ts'
import { workflowStateSchema } from './workflow-schema.ts'
import { assertWorkflowInvariants, createInitialWorkflowState } from './workflow.ts'
import type { WorkspaceId } from './ids.ts'
import type { WorkspaceImportLimits, PreparedWorkspaceImportV1 } from './workspace-import.ts'
import { isWorkspaceUnicodeValid, prepareWorkspaceImportWithSchema, workspaceImportDocumentV1Schema } from './workspace-import.ts'
import { AGENT_WORKSPACE_PLUGIN_VERSION, WORKSPACE_EXPORT_FORMAT } from './forward-export.ts'
import type { ForwardWorkspaceAggregateV1 } from './forward-export.ts'
import { workspaceStateSchema } from './workspace-state-schema.ts'
import { assertWorkspaceInvariants } from './invariant.ts'

/** Current portable format supports arbitrary organization identities. */
export const WORKSPACE_EXPORT_FORMAT_VERSION_V2 = 2 as const
/** Portable successor includes complete workflow facts and operation receipts. */
export const WORKSPACE_EXPORT_FORMAT_VERSION_V3 = 3 as const

/** Identity and user metadata portable without creation-operation metadata. */
export type PortableWorkspaceDescriptor = Omit<WorkspaceDescriptor, 'creation'>

/** Digest-free portable version two fields. Compatibility ranges are descriptive metadata. */
export interface WorkspaceExportEnvelopeV2 {
  readonly format: typeof WORKSPACE_EXPORT_FORMAT
  readonly formatVersion: typeof WORKSPACE_EXPORT_FORMAT_VERSION_V2
  readonly pluginVersion: string
  readonly compatibleImportRange: string
  readonly exportedAt: string
  readonly workspace: {
    readonly descriptor: PortableWorkspaceDescriptor
    readonly aggregate: ForwardWorkspaceAggregateV1
  }
  readonly diagnostics?: { readonly sessionBindingCount: number }
}

/** Complete version two portable document hashed over its original envelope. */
export interface WorkspaceExportDocumentV2 extends WorkspaceExportEnvelopeV2 {
  readonly digest: { readonly algorithm: 'sha-256'; readonly canonicalization: 'RFC8785'; readonly hex: string }
}

/** Successor envelope preserves business metadata without local Session or creation bindings. */
export interface WorkspaceExportEnvelopeV3 extends Omit<WorkspaceExportEnvelopeV2, 'formatVersion' | 'workspace'> {
  readonly formatVersion: typeof WORKSPACE_EXPORT_FORMAT_VERSION_V3
  readonly workspace: WorkspaceExportEnvelopeV2['workspace'] & { readonly workflow: WorkflowState }
}
/** Complete successor document uses the raw envelope RFC8785 digest. */
export interface WorkspaceExportDocumentV3 extends WorkspaceExportEnvelopeV3 {
  readonly digest: WorkspaceExportDocumentV2['digest']
}

/** Source metadata, aggregate and workflow prepared by the version one/two/three reader. */
export interface PreparedWorkspaceImport extends PreparedWorkspaceImportV1 {
  readonly descriptor: PortableWorkspaceDescriptor
  readonly workflow: WorkflowState
}

const timestampSchema = z.string().refine(value => {
  const date = new Date(value)
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value
})
const portableDescriptorSchema = workspaceDescriptorSchema.omit({ creation: true })
const envelopeFields = {
  format: z.literal(WORKSPACE_EXPORT_FORMAT),
  pluginVersion: z.string(),
  compatibleImportRange: z.string(),
  exportedAt: timestampSchema,
  workspace: z.object({
    descriptor: portableDescriptorSchema,
    aggregate: workspaceStateSchema.omit({ workspaceId: true, sessionBindings: true }),
  }).strict(),
  diagnostics: z.object({ sessionBindingCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict().optional(),
  digest: z.object({
    algorithm: z.literal('sha-256'),
    canonicalization: z.literal('RFC8785'),
    hex: z.string().regex(/^[0-9a-f]{64}$/u),
  }).strict(),
}
const documentSchema = z.discriminatedUnion('formatVersion', [
  workspaceImportDocumentV1Schema,
  z.object({ ...envelopeFields, formatVersion: z.literal(2) }).strict(),
  z.object({ ...envelopeFields, formatVersion: z.literal(3), workspace: envelopeFields.workspace.extend({ workflow: workflowStateSchema }).strict() }).strict(),
])

/**
 * Validate and export a version-one record without sessions or creation-operation metadata.
 * This frozen producer omits all third-stage workflow metadata; live successor records use V3.
 * Rejects isolated Unicode surrogates in source strings and object keys without changing the source.
 * @param record Source record; the function never mutates it.
 * @param metadata Canonical UTC export timestamp.
 * @returns Detached version two document and canonical JSON.
 */
export function createWorkspaceExportV2(
  record: WorkspaceRecordV1,
  metadata: { readonly exportedAt: string },
): { readonly document: WorkspaceExportDocumentV2; readonly json: string } {
  if (!timestampSchema.safeParse(metadata.exportedAt).success) throw new Error('exportedAt must be a canonical UTC timestamp')
  assertExportUnicode(record)
  const parsed = workspaceRecordSchema.parse(structuredClone(record))
  assertWorkspaceInvariants(parsed.aggregate, parsed.descriptor.id)
  const { workspaceId: _workspaceId, sessionBindings: _sessions, ...aggregate } = parsed.aggregate
  const { id, label, lifecycle } = parsed.descriptor
  const envelope: WorkspaceExportEnvelopeV2 = {
    format: WORKSPACE_EXPORT_FORMAT,
    formatVersion: WORKSPACE_EXPORT_FORMAT_VERSION_V2,
    pluginVersion: AGENT_WORKSPACE_PLUGIN_VERSION,
    compatibleImportRange: '>=0.4.0 <0.5.0',
    exportedAt: metadata.exportedAt,
    workspace: { descriptor: { id, label, lifecycle }, aggregate },
  }
  const document: WorkspaceExportDocumentV2 = {
    ...envelope,
    digest: { algorithm: 'sha-256', canonicalization: 'RFC8785', hex: createHash('sha256').update(canonicalJson(envelope)).digest('hex') },
  }
  return { document, json: canonicalJson(document) }
}

/**
 * Export the complete successor record without sessions or creation-operation metadata.
 * @param record Source record; immutable workflow identities and history remain intact.
 * @param metadata Canonical UTC export timestamp.
 * @returns Detached version-three document and canonical JSON.
 */
export function createWorkspaceExportV3(record: WorkspaceRecordV2, metadata: { readonly exportedAt: string }): { readonly document: WorkspaceExportDocumentV3; readonly json: string } {
  if (!timestampSchema.safeParse(metadata.exportedAt).success) throw new Error('exportedAt must be a canonical UTC timestamp')
  assertExportUnicode(record)
  const parsed = workspaceRecordV2Schema.parse(structuredClone(record))
  assertWorkspaceInvariants(parsed.aggregate, parsed.descriptor.id)
  assertWorkflowInvariants(parsed.aggregate, parsed.workflow)
  assertWorkflowOperationDigests(parsed.workflow)
  const { workspaceId: _workspaceId, sessionBindings: _sessions, ...aggregate } = parsed.aggregate
  const { id, label, lifecycle } = parsed.descriptor
  const envelope: WorkspaceExportEnvelopeV3 = { format: WORKSPACE_EXPORT_FORMAT, formatVersion: 3, pluginVersion: AGENT_WORKSPACE_PLUGIN_VERSION, compatibleImportRange: '>=0.4.0 <0.5.0', exportedAt: metadata.exportedAt, workspace: { descriptor: { id, label, lifecycle }, aggregate, workflow: structuredClone(parsed.workflow) } }
  const document: WorkspaceExportDocumentV3 = { ...envelope, digest: { algorithm: 'sha-256', canonicalization: 'RFC8785', hex: createHash('sha256').update(canonicalJson(envelope)).digest('hex') } }
  return { document, json: canonicalJson(document) }
}

/**
 * Read strict portable v1, v2 or v3 JSON and prepare an independent organization.
 * Budgets, duplicate keys, Unicode, digests and both aggregate identities are checked before returning.
 * Running child runs and unfinished task delivery attempts reject the document.
 * @param json Untrusted source JSON.
 * @param options Target identity and explicit resource budgets.
 * @returns Detached source metadata and aggregate; no persistence or Host loading occurs.
 */
export function prepareWorkspaceImport(
  json: string,
  options: { readonly workspaceId: WorkspaceId; readonly limits: WorkspaceImportLimits },
): PreparedWorkspaceImport {
  return prepareWorkspaceImportWithSchema(json, options, documentSchema, (document, source, target, prepared) => {
    const workflow = document.formatVersion === 3 ? structuredClone(document.workspace.workflow) : createInitialWorkflowState()
    try {
      assertWorkflowInvariants(source, workflow)
      assertWorkflowInvariants(target, workflow)
      assertWorkflowOperationDigests(workflow)
    } catch (_error) {
      // Imported bodies and identifiers are not exposed in diagnostics.
      throw new Error('invalid workspace import workflow relationships or counters')
    }
    return { ...prepared, workflow }
  })
}

function canonicalJson(value: unknown): string {
  const json = canonicalize(value)
  if (json === undefined) throw new Error('value cannot be represented as canonical JSON')
  return json
}

function assertExportUnicode(input: unknown): void {
  const pending: unknown[] = [input]
  const seen = new Set<object>()
  while (pending.length > 0) {
    const value = pending.pop()
    if (typeof value === 'string' && !isWorkspaceUnicodeValid(value)) throw new Error('workspace export contains invalid Unicode')
    if (value === null || typeof value !== 'object' || seen.has(value)) continue
    seen.add(value)
    for (const [key, child] of Object.entries(value)) {
      if (!isWorkspaceUnicodeValid(key)) throw new Error('workspace export contains invalid Unicode')
      pending.push(child)
    }
  }
}
