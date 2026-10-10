/** Pure portable organization version two producer and version one/two reader. */

import { createHash } from 'node:crypto'
import canonicalize from 'canonicalize'
import { z } from 'zod'
import type { WorkspaceRecordV1, WorkspaceDescriptor } from './workspace-record.ts'
import { workspaceDescriptorSchema, workspaceRecordSchema } from './workspace-record.ts'
import type { WorkspaceId } from './ids.ts'
import type { WorkspaceImportLimits, PreparedWorkspaceImportV1 } from './workspace-import.ts'
import { isWorkspaceUnicodeValid, prepareWorkspaceImportWithSchema, workspaceImportDocumentV1Schema } from './workspace-import.ts'
import { AGENT_WORKSPACE_PLUGIN_VERSION, WORKSPACE_EXPORT_FORMAT } from './forward-export.ts'
import type { ForwardWorkspaceAggregateV1 } from './forward-export.ts'
import { workspaceStateSchema } from './workspace-state-schema.ts'
import { assertWorkspaceInvariants } from './invariant.ts'

/** Current portable format supports arbitrary organization identities. */
export const WORKSPACE_EXPORT_FORMAT_VERSION_V2 = 2 as const

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

/** Source metadata and aggregate prepared by the version one/two reader. */
export interface PreparedWorkspaceImport extends PreparedWorkspaceImportV1 {
  readonly descriptor: PortableWorkspaceDescriptor
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
])

/**
 * Validate and export an organization without sessions or creation-operation metadata.
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
 * Read strict portable v1 or v2 JSON and prepare an independent organization.
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
  return prepareWorkspaceImportWithSchema(json, options, documentSchema)
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
