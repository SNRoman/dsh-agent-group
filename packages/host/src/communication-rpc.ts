/** Human-only chat assignment routes on the existing organization Connection transport. */
import { z } from 'zod'
import type { WorkspaceRpcService } from './rpc.ts'
import { WorkspaceBusinessError } from './errors.ts'
import { WorkflowBusinessError } from './workflow.ts'
import { chatAssignmentRequestSchema, chatConfirmationRequestSchema } from './chat-work-schema.ts'
import type { WorkspaceWorkflowRpcHandler, WorkspaceWorkflowRpcResult } from './workflow-rpc.ts'
import { RoomId, WorkspaceEventId } from './ids.ts'
import type { ContextResetId } from './communication-contract.ts'

const recallSource = z.object({ roomId: z.string().trim().min(1).transform(RoomId), eventId: z.string().trim().min(1).transform(WorkspaceEventId) }).strict()
const recallRequest = recallSource.extend({ operationId: z.string().trim().min(1).transform(value => value as ContextResetId), expectedRevision: z.number().int().nonnegative(), restoreFiles: z.boolean() }).strict()

/** @param service Selected organization runtime. @returns Strict chat work dispatcher with existing safe failure envelopes. */
export function createCommunicationRpcHandler(service: WorkspaceRpcService): WorkspaceWorkflowRpcHandler {
  return async (endpoint, payload, signal): Promise<WorkspaceWorkflowRpcResult> => {
    if (signal.aborted) return cancelled()
    try {
      if (endpoint === 'communication/recall-preview') {
        const parsed = recallSource.safeParse(payload)
        if (!parsed.success) return invalid()
        return { ok: true, value: structuredClone(await service.previewRecall(parsed.data.roomId, parsed.data.eventId)) }
      }
      if (endpoint === 'communication/recall') {
        const parsed = recallRequest.safeParse(payload)
        if (!parsed.success) return invalid()
        return { ok: true, value: structuredClone(await service.recallMessage(parsed.data, signal)) }
      }
      if (endpoint === 'communication/recall-files') {
        const parsed = z.object({ operationId: z.string().trim().min(1).transform(value => value as ContextResetId) }).strict().safeParse(payload)
        if (!parsed.success) return invalid()
        return { ok: true, value: structuredClone(await service.retryRecallFiles(parsed.data.operationId)) }
      }
      if (endpoint === 'communication/snapshot') {
        if (!z.object({}).strict().safeParse(payload).success) return invalid()
        return { ok: true, value: structuredClone(service.communicationSnapshot()) }
      }
      if (endpoint === 'communication/assign') {
        const parsed = chatAssignmentRequestSchema.safeParse(payload)
        if (!parsed.success) return invalid()
        return { ok: true, value: structuredClone(await service.assignChatWork(parsed.data, signal)) }
      }
      if (endpoint === 'communication/confirm') {
        const parsed = chatConfirmationRequestSchema.safeParse(payload)
        if (!parsed.success) return invalid()
        return { ok: true, value: structuredClone(await service.confirmChatWork(parsed.data, signal)) }
      }
      return invalid()
    } catch (error) {
      if (error instanceof WorkflowBusinessError || error instanceof WorkspaceBusinessError) return { ok: false, error: { kind: 'business', code: error.code, message: error.message, details: structuredClone(error.details) } } as WorkspaceWorkflowRpcResult
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) return cancelled()
      return { ok: false, error: { kind: 'internal', code: 'internal', message: 'agent workspace chat work request failed', details: {} } }
    }
  }
}
function invalid(): WorkspaceWorkflowRpcResult { return { ok: false, error: { kind: 'bad-request', code: 'bad-request', message: 'invalid agent workspace chat work request', details: { issues: [] } } } }
function cancelled(): WorkspaceWorkflowRpcResult { return { ok: false, error: { kind: 'cancelled', code: 'cancelled', message: 'agent workspace request cancelled', details: {} } } }
