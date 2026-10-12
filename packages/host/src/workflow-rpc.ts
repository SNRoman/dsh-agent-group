/** Human-only workflow endpoints on the existing organization-scoped transport. */
import { z } from 'zod'
import type { WorkspaceRpcResult, WorkspaceRpcService } from './rpc.ts'
import { WorkspaceBusinessError } from './errors.ts'
import type { WorkflowBusinessErrorDetailsMap } from './workflow-contract.ts'
import { CompanyTemplateRevisionId, WorkflowBusinessError, WorkflowOperationId } from './workflow.ts'
import { workflowCommandPayloadSchemas, workflowCommandSchema } from './workflow-schema.ts'

type WorkflowRpcBusinessError = { readonly [K in keyof WorkflowBusinessErrorDetailsMap]: { readonly kind: 'business'; readonly code: K; readonly message: string; readonly details: WorkflowBusinessErrorDetailsMap[K] } }[keyof WorkflowBusinessErrorDetailsMap]
/** Workflow values and existing safe failure envelopes, extended with workflow policy failures. */
export type WorkspaceWorkflowRpcResult = { readonly ok: true; readonly value: unknown } | Extract<WorkspaceRpcResult, { ok: false }> | { readonly ok: false; readonly error: WorkflowRpcBusinessError }
/** @param endpoint Known workflow route. @param payload Organization scope is removed only by the organization router. @param signal Caller cancellation. @returns Existing Connection envelope. */
export type WorkspaceWorkflowRpcHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<WorkspaceWorkflowRpcResult>
const revision = z.number().int().nonnegative()
const expected = { expectedAggregateRevision: revision, expectedWorkflowRevision: revision }
const snapshot = z.object({}).strict()
const preview = z.object({ ...expected, templateRevisionId: z.string().trim().min(1).transform(CompanyTemplateRevisionId) }).strict()
const write = z.object({ ...expected, operationId: z.string().trim().min(1).transform(WorkflowOperationId) }).passthrough()

/** @param service Fixed organization runtime. @returns Strict dispatcher; employee proposal has no Browser endpoint. */
export function createWorkflowRpcHandler(service: WorkspaceRpcService): WorkspaceWorkflowRpcHandler {
  return async (endpoint, payload, signal) => {
    if (signal.aborted) return cancelled()
    try {
      if (endpoint === 'workflow/snapshot') {
        const parsed = snapshot.safeParse(payload)
        if (!parsed.success) return invalid(parsed.error.issues)
        return { ok: true, value: structuredClone(service.workflowSnapshot()) }
      }
      if (endpoint === 'workflow/company-template/preview') {
        const parsed = preview.safeParse(payload)
        if (!parsed.success) return invalid(parsed.error.issues)
        return { ok: true, value: structuredClone(service.previewCompanyTemplate(parsed.data, parsed.data.templateRevisionId)) }
      }
      if (!Object.hasOwn(workflowCommandPayloadSchemas, endpoint)) return invalid([])
      const parsed = write.safeParse(payload)
      if (!parsed.success) return invalid(parsed.error.issues)
      const { operationId, expectedAggregateRevision, expectedWorkflowRevision, ...body } = parsed.data
      if (Object.hasOwn(body, 'type')) return invalid([])
      const command = workflowCommandSchema.safeParse({ ...body, type: endpoint })
      if (!command.success) return invalid(command.error.issues)
      return { ok: true, value: structuredClone(await service.executeWorkflow({ operationId, expectedAggregateRevision, expectedWorkflowRevision }, command.data, signal)) }
    } catch (error) {
      // A committed write remains a success even if its request signal changes afterward.
      if (error instanceof WorkflowBusinessError) return { ok: false, error: { kind: 'business', code: error.code, message: error.message, details: structuredClone(error.details) } as WorkflowRpcBusinessError }
      if (error instanceof WorkspaceBusinessError) return { ok: false, error: { kind: 'business', code: error.code, message: error.message, details: structuredClone(error.details) } } as Extract<WorkspaceRpcResult, { ok: false }>
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) return cancelled()
      return { ok: false, error: { kind: 'internal', code: 'internal', message: 'agent workspace request failed', details: {} } }
    }
  }
}
function invalid(issues: readonly unknown[]): WorkspaceWorkflowRpcResult { return { ok: false, error: { kind: 'bad-request', code: 'bad-request', message: 'invalid agent workspace workflow request', details: { issues } } } }
function cancelled(): WorkspaceWorkflowRpcResult { return { ok: false, error: { kind: 'cancelled', code: 'cancelled', message: 'agent workspace request cancelled', details: {} } } }
