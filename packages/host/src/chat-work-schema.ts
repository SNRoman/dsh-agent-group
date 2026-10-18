/** Strict chat work input and semantic operation readers. */
import { z } from 'zod'
import { AgentId, HumanId, RoomId, TaskAssignmentId, TaskId, WorkspaceEventId } from './ids.ts'
import type { ChatWorkCommand, ChatWorkOperation } from './chat-work-contract.ts'
import { TaskDraftId, WorkflowOperationId } from './workflow.ts'
import { taskBriefSchema } from './workflow-schema.ts'

const id = z.string().trim().min(1).refine(value => !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value))
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const common = { roomId: id.transform(RoomId), assigneeAgentId: id.transform(AgentId), allowDelegation: z.boolean().default(false) }
/** Missing delegation permission is explicitly resolved to false before hashing. */
export const chatAssignmentSchema = z.object({ ...common, brief: taskBriefSchema }).strict()
/** Confirmation records a new real human message in the selected room. */
export const chatConfirmationSchema = z.object({ ...common, draftId: id.transform(TaskDraftId), expectedDraftRevision: count }).strict()
/** Stable operation identity and displayed revision checkpoints. */
export const chatExpectedFields = { operationId: id.refine(value => value !== '__proto__').transform(WorkflowOperationId), expectedAggregateRevision: count, expectedWorkflowRevision: count }
/** Human assignment JSON parser used by runtime and RPC. */
export const chatAssignmentRequestSchema = chatAssignmentSchema.extend(chatExpectedFields).strict()
/** Human confirmation JSON parser used by runtime and RPC. */
export const chatConfirmationRequestSchema = chatConfirmationSchema.extend(chatExpectedFields).strict()
/** Semantic fields hashed independently of caller revision checkpoints. */
export const chatWorkCommandSchema = z.discriminatedUnion('type', [chatAssignmentSchema.extend({ type: z.literal('communication/assign') }), chatConfirmationSchema.extend({ type: z.literal('communication/confirm') })]) satisfies z.ZodType<ChatWorkCommand>
/** Strict persisted operation with relationship and digest validation owned by the record reader. */
export const chatWorkOperationSchema = z.object({ id: id.transform(WorkflowOperationId), humanId: id.transform(HumanId), command: chatWorkCommandSchema, requestDigest: z.string().regex(/^[0-9a-f]{64}$/u), receipt: z.object({ source: z.object({ roomId: id.transform(RoomId), eventId: id.transform(WorkspaceEventId) }).strict(), draftId: id.transform(TaskDraftId), taskId: id.transform(TaskId), taskAssignmentId: id.transform(TaskAssignmentId) }).strict(), aggregateRevision: count, workflowRevision: count }).strict() satisfies z.ZodType<ChatWorkOperation>
