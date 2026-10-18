/** Chat-only work requests and durable retry receipts, without runtime dependencies. */
import type { AgentId, HumanId, RoomId, TaskAssignmentId, TaskId, WorkspaceId } from './ids.ts'
import type { ChatSource, CommunicationState } from './communication-contract.ts'
import type { TaskBrief, TaskDraftId, WorkflowExpectedRevisions, WorkflowOperationId } from './workflow-contract.ts'
import type { WorkflowProposalRequest } from './workflow-contract.ts'
/** Employee proposal writes a real message in this selected chat without assigning work. */
export interface ChatProposalRequest extends WorkflowProposalRequest { readonly roomId: RoomId }

/** Full instruction or confirmation authored in a selected chat before task delivery. */
export type ChatWorkCommand =
  | { readonly type: 'communication/assign'; readonly roomId: RoomId; readonly brief: TaskBrief; readonly assigneeAgentId: AgentId; readonly allowDelegation: boolean }
  | { readonly type: 'communication/confirm'; readonly roomId: RoomId; readonly draftId: TaskDraftId; readonly expectedDraftRevision: number; readonly assigneeAgentId: AgentId; readonly allowDelegation: boolean }
/** Caller revisions do not form part of semantic retry identity. */
export type ChatWorkRequest<Command extends ChatWorkCommand> = Omit<Command, 'type' | 'allowDelegation'> & WorkflowExpectedRevisions & { readonly operationId: WorkflowOperationId; readonly allowDelegation?: boolean }
/** The actual persisted message and confirmed work identifiers. */
export interface ChatWorkReceipt { readonly source: ChatSource; readonly draftId: TaskDraftId; readonly taskId: TaskId; readonly taskAssignmentId: TaskAssignmentId }
/** Durable semantic command and receipt; an identical replay performs no delivery. */
export interface ChatWorkOperation { readonly id: WorkflowOperationId; readonly humanId: HumanId; readonly command: ChatWorkCommand; readonly requestDigest: string; readonly receipt: ChatWorkReceipt; readonly aggregateRevision: number; readonly workflowRevision: number }
/** Current committed counters accompany the stable semantic receipt on retries. */
export interface ChatWorkResult { readonly workspaceId: WorkspaceId; readonly aggregateRevision: number; readonly workflowRevision: number; readonly communicationRevision: number; readonly value: ChatWorkReceipt; readonly replayed: boolean }
/** Raw audit metadata for chat sources and context status; no local Session contents. */
export interface CommunicationSnapshot { readonly workspaceId: WorkspaceId; readonly aggregateRevision: number; readonly workflowRevision: number; readonly communication: CommunicationState }
