/** Frozen read-only workspace export producer for the v0.3 compatibility handoff. */

import { createHash } from 'node:crypto'
import canonicalize from 'canonicalize'
import { WorkspaceId } from './ids.ts'
import type { WorkspaceId as WorkspaceIdType } from './ids.ts'
import { assertWorkspaceInvariants } from './invariant.ts'
import { workspaceStateSchema } from './workspace-state-schema.ts'
import type { WorkspaceState } from './types.ts'

/** Stable portable document family. */
export const WORKSPACE_EXPORT_FORMAT = 'dsh-agent-workspace' as const
/** Frozen first portable document version. */
export const WORKSPACE_EXPORT_FORMAT_VERSION = 1 as const
/** Candidate versions allowed to consume this handoff. */
export const WORKSPACE_EXPORT_COMPATIBLE_IMPORT_RANGE = '>=0.3.0 <0.4.0' as const
/** Package version that owns this frozen producer. */
export const AGENT_WORKSPACE_PLUGIN_VERSION = '0.3.0' as const

/** Durable aggregate fields that can cross the forward-compatibility handoff. */
export type ForwardWorkspaceAggregateV1 = Omit<WorkspaceState, 'workspaceId' | 'sessionBindings'>

/** Portable identity and lifecycle for one exported workspace. */
export interface ForwardWorkspaceDescriptorV1 {
  readonly id: WorkspaceIdType
  readonly label: string
  readonly lifecycle: 'active' | 'archived'
}

/** Digest-free payload hashed by the v1 producer. */
export interface ForwardWorkspaceExportEnvelopeV1 {
  readonly format: typeof WORKSPACE_EXPORT_FORMAT
  readonly formatVersion: typeof WORKSPACE_EXPORT_FORMAT_VERSION
  readonly pluginVersion: string
  readonly compatibleImportRange: typeof WORKSPACE_EXPORT_COMPATIBLE_IMPORT_RANGE
  readonly exportedAt: string
  readonly workspace: {
    readonly descriptor: ForwardWorkspaceDescriptorV1
    readonly aggregate: ForwardWorkspaceAggregateV1
  }
  readonly diagnostics?: { readonly sessionBindingCount: number }
}

/** Complete canonical v1 document, including its envelope digest. */
export interface ForwardWorkspaceExportDocumentV1 extends ForwardWorkspaceExportEnvelopeV1 {
  readonly digest: {
    readonly algorithm: 'sha-256'
    readonly canonicalization: 'RFC8785'
    readonly hex: string
  }
}

/**
 * Validate and serialize one local workspace without retaining session bindings.
 *
 * @param state Durable source aggregate. The function never mutates it.
 * @param metadata Deterministic export metadata.
 * @returns The detached document and its canonical JSON bytes as text.
 */
export function createForwardWorkspaceExportV1(
  state: WorkspaceState,
  metadata: { readonly exportedAt: string },
): { readonly document: ForwardWorkspaceExportDocumentV1; readonly json: string } {
  assertCanonicalTimestamp(metadata.exportedAt)
  const parsed = workspaceStateSchema.parse(structuredClone(state))
  const localId = WorkspaceId('local')
  assertWorkspaceInvariants(parsed, localId)
  const { workspaceId, sessionBindings: _sessionBindings, ...aggregate } = parsed
  if (workspaceId !== localId) throw new Error("forward export v1 accepts only the 'local' workspace")

  const envelope: ForwardWorkspaceExportEnvelopeV1 = {
    format: WORKSPACE_EXPORT_FORMAT,
    formatVersion: WORKSPACE_EXPORT_FORMAT_VERSION,
    pluginVersion: AGENT_WORKSPACE_PLUGIN_VERSION,
    compatibleImportRange: WORKSPACE_EXPORT_COMPATIBLE_IMPORT_RANGE,
    exportedAt: metadata.exportedAt,
    workspace: {
      descriptor: { id: localId, label: 'Local workspace', lifecycle: 'active' },
      aggregate,
    },
  }
  const digest = createHash('sha256').update(canonicalJson(envelope)).digest('hex')
  const document: ForwardWorkspaceExportDocumentV1 = {
    ...envelope,
    digest: { algorithm: 'sha-256', canonicalization: 'RFC8785', hex: digest },
  }
  return { document, json: canonicalJson(document) }
}

function canonicalJson(value: unknown): string {
  const json = canonicalize(value)
  if (json === undefined) throw new Error('value cannot be represented as canonical JSON')
  return json
}

function assertCanonicalTimestamp(value: string): void {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error('exportedAt must be a canonical UTC timestamp')
  }
}
