/** Strict Browser reads and chat work requests on one fixed organization Connection. */
import { z } from 'zod'
import type { WorkspaceApiClient } from './api.ts'
import { WorkflowApiError, WorkflowInputError } from './workflow-api.ts'

const id = z.string().trim().min(1)
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positive = count.min(1)
const source = z.object({ roomId: id, eventId: id }).strict()
const brief = z.object({ title: id, instructions: id, expectedArtifacts: z.array(id), acceptanceCriteria: z.array(id) }).strict()
const common = { roomId: id, assigneeAgentId: id, allowDelegation: z.boolean().default(false) }
const assign = z.object({ ...common, brief }).strict()
const confirm = z.object({ ...common, draftId: id, expectedDraftRevision: count }).strict()
const expected = { operationId: id, expectedAggregateRevision: count, expectedWorkflowRevision: count }
const assignRequest = assign.extend(expected).strict()
const confirmRequest = confirm.extend(expected).strict()
const receipt = z.object({ source, draftId: id, taskId: id, taskAssignmentId: id }).strict()
const command = z.discriminatedUnion('type', [assign.extend({ type: z.literal('communication/assign') }), confirm.extend({ type: z.literal('communication/confirm') })])
const operation = z.object({ id, humanId: id, command, requestDigest: z.string().regex(/^[0-9a-f]{64}$/u), receipt, aggregateRevision: count, workflowRevision: count }).strict()
const target = z.discriminatedUnion('kind', [z.object({ kind: z.literal('room-input'), eventId: id }).strict(), z.object({ kind: z.literal('event'), eventId: id }).strict(), z.object({ kind: z.literal('task'), taskId: id }).strict(), z.object({ kind: z.literal('draft'), draftId: id }).strict(), z.object({ kind: z.literal('template'), templateRevisionId: id }).strict(), z.object({ kind: z.literal('artifact'), artifactId: id }).strict()])
const resetFields = { id, source, requestedByHumanId: id, fromSequence: positive, throughSequence: positive, affectedAgentIds: z.array(id), previousGenerations: z.record(id, count), invalidatedEventIds: z.array(id), invalidatedTaskIds: z.array(id), invalidatedDraftIds: z.array(id), invalidatedTemplateRevisionIds: z.array(id), invalidatedArtifactIds: z.array(id), requestedAt: z.iso.datetime(), fileRestoreRequested: z.boolean() }
const messageResetFields = { ...resetFields, kind: z.undefined().optional() }
const messageReset = z.discriminatedUnion('status', [z.object({ ...messageResetFields, status: z.enum(['pending', 'completed']), error: z.never().optional() }).strict(), z.object({ ...messageResetFields, status: z.literal('failed'), error: id }).strict()])
const roomForgetFields = { ...resetFields, kind: z.literal('room-memory-forget'), membershipId: id, forgottenEventIds: z.array(id), fileRestoreRequested: z.literal(false) }
const roomForgetReset = z.discriminatedUnion('status', [z.object({ ...roomForgetFields, status: z.enum(['pending', 'completed']), error: z.never().optional() }).strict(), z.object({ ...roomForgetFields, status: z.literal('failed'), error: id }).strict()])
const reset = z.union([messageReset, roomForgetReset])
const bytes = z.discriminatedUnion('existed', [z.object({ existed: z.literal(false) }).strict(), z.object({ existed: z.literal(true), blobId: id, sha256: z.string().regex(/^[0-9a-f]{64}$/u), size: count }).strict()])
const restore = z.discriminatedUnion('status', [z.object({ status: z.enum(['pending', 'skipped']) }).strict(), z.object({ status: z.literal('restored'), recovery: bytes }).strict(), z.object({ status: z.enum(['conflict', 'failed', 'unavailable']), reason: id }).strict()])
const communication = z.object({ revision: count, nextCheckpointOrder: positive,
  messages: z.record(id, z.object({ eventId: id, intent: z.enum(['message', 'assignment', 'proposal', 'delegation']), contextGeneration: count.optional(), withdrawnBy: id.optional() }).strict()),
  taskSources: z.record(id, source), draftSources: z.record(id, source),
  inputs: z.record(id, z.object({ id, target, deliveryMessageId: id.optional(), taskDeliveryAttemptId: id.optional(), agentId: id, contextGeneration: count, recordedAtSequence: positive, directEventIds: z.array(id), recalledEventIds: z.array(id), sessionEventIds: z.array(id) }).strict()),
  contexts: z.record(id, z.object({ generation: count, blockedBy: id.optional(), sessionId: id.optional() }).strict()), resets: z.record(id, reset),
  fileCheckpoints: z.record(id, z.object({ id, order: positive, inputId: id, agentId: id, contextGeneration: count, callId: id, path: id, before: bytes, after: bytes, restore }).strict()), operations: z.record(id, operation),
}).strict()
const snapshot = z.object({ workspaceId: id, aggregateRevision: count, workflowRevision: count, communication }).strict()
const recallPreview = z.object({ affectedAgentIds: z.array(id), invalidatedEventIds: z.array(id), invalidatedTaskIds: z.array(id), fileCheckpointIds: z.array(id), conservative: z.literal(true), files: z.array(z.object({ id, path: id, status: z.enum(['restorable', 'restored', 'conflict', 'unavailable']), reason: id.optional(), before: bytes, after: bytes, text: z.object({ before: z.string(), after: z.string() }).strict().optional() }).strict()).optional() }).strict()
const recallRequest = source.extend({ operationId: id, expectedRevision: count, restoreFiles: z.boolean() }).strict()
const result = z.object({ workspaceId: id, aggregateRevision: count, workflowRevision: count, communicationRevision: count, value: receipt, replayed: z.boolean() }).strict()

/** Real persisted message for a work card source; Browser never fabricates it. */
export type ChatSource = z.output<typeof source>
/** Explicit complete brief and named assignee; delegation resolves to false when absent. */
export type ChatAssignmentRequest = z.input<typeof assignRequest>
/** Pending draft and room selected for the human confirmation message. */
export type ChatConfirmationRequest = z.input<typeof confirmRequest>
/** Validated raw communication metadata; effective model filtering remains Host-owned. */
export type CommunicationState = z.output<typeof communication>
/** Communication metadata paired with aggregate/workflow revision checkpoints. */
export type CommunicationSnapshot = z.output<typeof snapshot>
/** Stable actual-source and confirmed-work receipt with current revision checkpoints. */
export type ChatWorkResult = z.output<typeof result>
/** Current withdrawal impact; byte conflict checks are repeated before any restore. */
export type RecallPreview = z.output<typeof recallPreview>
/** Stable author-owned withdrawal, with separately opted-in file recovery. */
export type RecallRequest = z.output<typeof recallRequest>
/** Persisted reset status used to resume incomplete withdrawals. */
export type RecallReset = z.output<typeof reset>

/** Chat-only work operations on one immutable organization API. */
export class WorkspaceCommunicationApi {
  constructor(private readonly api: WorkspaceApiClient) {}
  private scope<Value extends { readonly workspaceId: string }>(value: Value): Value {
    if (value.workspaceId !== this.api.workspaceId) throw new Error('Agent Workspace communication organization scope mismatch')
    return value
  }
  /** @param signal Cancellation. @returns Validated communication metadata for this organization. */
  async snapshot(signal?: AbortSignal): Promise<CommunicationSnapshot> {
    return this.scope(snapshot.parse(await this.api.callCommunication('communication/snapshot', {}, signal)))
  }
  /** @param request Real chat source. @param signal Cancellation. @returns Named subjects and current file recovery classifications. */
  async previewRecall(request: ChatSource, signal?: AbortSignal): Promise<RecallPreview> {
    return recallPreview.parse(await this.api.callCommunication('communication/recall-preview', source.parse(request), signal))
  }
  /** @param request Stable retry and optional file consent. @param signal Precommit cancellation. @returns Persisted reset status. */
  async recall(request: RecallRequest, signal?: AbortSignal): Promise<CommunicationSnapshot> {
    if (this.api.readOnly) throw new WorkflowInputError()
    return this.scope(snapshot.parse(await this.api.callCommunication('communication/recall', recallRequest.parse(request), signal)))
  }
  /** @param operationId Completed author-owned reset with prior file consent. @returns Per-file retry metadata without resetting memory again. */
  async retryFiles(operationId: string): Promise<CommunicationSnapshot> {
    if (this.api.readOnly) throw new WorkflowInputError()
    return this.scope(snapshot.parse(await this.api.callCommunication('communication/recall-files', { operationId: id.parse(operationId) })))
  }
  /** @param request Complete chat instruction and stable retry identity. @param signal Cancellation. @returns Confirmed work with the actual persisted source. */
  assign(request: ChatAssignmentRequest, signal?: AbortSignal): Promise<ChatWorkResult> {
    return this.mutate('communication/assign', assignRequest, request, signal)
  }
  /** @param request Selected proposed draft and chat. @param signal Cancellation. @returns Confirmed work with a new real human source. */
  confirm(request: ChatConfirmationRequest, signal?: AbortSignal): Promise<ChatWorkResult> {
    return this.mutate('communication/confirm', confirmRequest, request, signal)
  }
  private async mutate(endpoint: 'communication/assign' | 'communication/confirm', schema: z.ZodType, request: unknown, signal?: AbortSignal): Promise<ChatWorkResult> {
    if (this.api.readOnly) throw new WorkflowApiError({ kind: 'business', code: 'workflow-read-only', message: 'Read-only', details: { workspaceId: this.api.workspaceId ?? '' } })
    const parsed = schema.safeParse(request)
    if (!parsed.success) throw new WorkflowInputError()
    const response = result.parse(await this.api.callCommunication(endpoint, parsed.data as Record<string, unknown>, signal))
    return this.scope(response)
  }
}
