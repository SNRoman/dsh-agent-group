/** Explicit organization routing for the authenticated Browser transport. */
import { z } from 'zod'
import type { WorkspaceId } from './ids.ts'
import { createWorkspaceRpcHandler } from './rpc.ts'
import type { WorkspaceRpcService, WorkspaceRpcResult } from './rpc.ts'
import { createWorkflowRpcHandler } from './workflow-rpc.ts'
import type { WorkspaceWorkflowRpcResult } from './workflow-rpc.ts'
import { WorkspaceOperationId, workspaceIdentitySchema } from './workspace-record.ts'
import type { WorkspaceDirectoryEntry, WorkspaceRecordV2 } from './workspace-record.ts'

/** Read-only import facts shown before human confirmation; no candidate is persisted. */
export interface OrganizationImportPreview {
  readonly operationId: WorkspaceOperationId
  readonly sourceWorkspaceId: WorkspaceId
  readonly sourcePluginVersion: string
  readonly exportedAt: string
  readonly label: string
  readonly lifecycle: 'active' | 'archived'
  readonly eventCount: number
  readonly agentCount: number
  readonly taskCount: number
  readonly sessionBindingsExcluded: true
}

/** Portable document captured from one idle organization revision. */
export interface OrganizationExport {
  readonly json: string
  readonly document: unknown
}

/** Directory operations and an immutable organization-scoped runtime selector. */
export interface OrganizationRpcService {
  /** @param id Explicit organization identity. @returns Its immutable scoped runtime. */
  forWorkspace(id: WorkspaceId): WorkspaceRpcService
  /** @returns Detached organization directory, including archived records. */
  listOrganizations(): readonly WorkspaceDirectoryEntry[]
  /** @param operationId Retry identity. @param label Display name. @returns The new or previously created record. */
  createOrganization(operationId: WorkspaceOperationId, label: string, signal?: AbortSignal): Promise<WorkspaceRecordV2>
  /** @param json Untrusted document. @returns Validated preview without writing. */
  previewImport(json: string): OrganizationImportPreview
  /** @param operationId Retry identity. @param json Source document. @param label Confirmed display name. @returns A new or already restored record. */
  importOrganization(operationId: WorkspaceOperationId, json: string, label: string, signal?: AbortSignal): Promise<WorkspaceRecordV2>
  /** @param id Selected organization. @param label New display name. @returns Committed record. */
  renameOrganization(id: WorkspaceId, label: string, signal?: AbortSignal): Promise<WorkspaceRecordV2>
  /** @param id Selected organization. @param mode Explicit stop-or-drain choice. @returns Archived record after quiescence. */
  archiveOrganization(id: WorkspaceId, mode: 'stop' | 'wait', signal?: AbortSignal): Promise<WorkspaceRecordV2>
  /** @param id Quiescent archived organization. @returns Committed active record. */
  reopenOrganization(id: WorkspaceId, signal?: AbortSignal): Promise<WorkspaceRecordV2>
  /** @param id Selected idle organization. @returns Canonical portable document without Session bindings. */
  exportOrganization(id: WorkspaceId, signal?: AbortSignal): Promise<OrganizationExport>
}

/** Directory results are decoded by their Browser owner; scoped failures retain the existing protocol. */
export type OrganizationRpcResult = { readonly ok: true; readonly value: unknown } | Extract<WorkspaceRpcResult | WorkspaceWorkflowRpcResult, { ok: false }>

const identity = z.string().min(1).refine(value => !/[\s:\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value))
const workspaceId = workspaceIdentitySchema
const label = z.string().trim().min(1).refine(value => !/[\ud800-\udfff]/u.test(value))
const empty = z.object({}).strict()
const operationId = identity.transform(WorkspaceOperationId)
const create = z.object({ operationId, label }).strict()
const preview = z.object({ json: z.string() }).strict()
const restore = z.object({ operationId, json: z.string(), label, confirmed: z.literal(true) }).strict()
const rename = z.object({ workspaceId, label }).strict()
const archive = z.object({ workspaceId, mode: z.enum(['stop', 'wait']) }).strict()
const reopen = z.object({ workspaceId }).strict()
const exporting = z.object({ workspaceId, confirmed: z.literal(true) }).strict()
const scoped = z.object({ workspaceId }).passthrough()

/**
 * Route directory actions and explicit organization-scoped requests.
 * @param service Human-authorized directory owner and scoped runtime factory.
 * @returns Cancellation-aware handler with no implicit local organization fallback.
 */
export function createOrganizationRpcHandler(service: OrganizationRpcService) {
  return async (endpoint: string, payload: unknown, signal: AbortSignal): Promise<OrganizationRpcResult> => {
    if (signal.aborted) return cancelled()
    try {
      switch (endpoint) {
        case 'organization/list': return await checked(empty, payload, () => service.listOrganizations())
        case 'organization/create': return await checked(create, payload, async input => (await service.createOrganization(input.operationId, input.label, signal)).descriptor)
        case 'organization/import-preview': return await checked(preview, payload, input => service.previewImport(input.json))
        case 'organization/import-confirm': return await checked(restore, payload, async input => (await service.importOrganization(input.operationId, input.json, input.label, signal)).descriptor)
        case 'organization/rename': return await checked(rename, payload, async input => (await service.renameOrganization(input.workspaceId, input.label, signal)).descriptor)
        case 'organization/archive': return await checked(archive, payload, async input => (await service.archiveOrganization(input.workspaceId, input.mode, signal)).descriptor)
        case 'organization/reopen': return await checked(reopen, payload, async input => (await service.reopenOrganization(input.workspaceId, signal)).descriptor)
        case 'organization/export': return await checked(exporting, payload, input => service.exportOrganization(input.workspaceId, signal))
        default: {
          const parsed = scoped.safeParse(payload)
          if (!parsed.success) return invalid()
          const { workspaceId: selected, ...body } = parsed.data
          if (endpoint.startsWith('workflow/')) return await createWorkflowRpcHandler(service.forWorkspace(selected))(endpoint, body, signal)
          return await createWorkspaceRpcHandler(service.forWorkspace(selected))(endpoint, body, signal)
        }
      }
    } catch (_error) {
      // Directory/decoder diagnostics may contain imported identifiers or text.
      return signal.aborted ? cancelled() : invalid()
    }
  }
}

async function checked<Value>(schema: z.ZodType<Value>, payload: unknown, operation: (value: Value) => unknown | Promise<unknown>): Promise<OrganizationRpcResult> {
  const parsed = schema.safeParse(payload)
  if (!parsed.success) return invalid()
  return { ok: true, value: structuredClone(await operation(parsed.data)) }
}

function invalid(): OrganizationRpcResult {
  return { ok: false, error: { kind: 'bad-request', code: 'bad-request', message: 'invalid organization request', details: { issues: [] } } }
}

function cancelled(): OrganizationRpcResult {
  return { ok: false, error: { kind: 'cancelled', code: 'cancelled', message: 'organization request cancelled', details: {} } }
}
