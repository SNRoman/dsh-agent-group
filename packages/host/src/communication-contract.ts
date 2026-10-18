/** Successor communication records; released workspace and workflow records remain unchanged. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AgentId, ChildRunId, HumanId, MembershipId, RoomId, TaskDeliveryAttemptId, TaskId, WorkspaceEventId, WorkspaceId } from './ids.ts'
import type { MemoryCoverage } from './scene-memory-contract.ts'
import type { TaskArtifactId, TaskDraftId, TaskTemplateRevisionId } from './workflow-contract.ts'
import type { WorkflowOperationId } from './workflow-contract.ts'
import type { ChatWorkOperation } from './chat-work-contract.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Persisted attribution for the exact direct, recalled and cumulative inputs of a managed turn. */
    'agent-workspace-context': CommunicationInput & { readonly kind: 'agent-workspace-context'; readonly memoryReceipt?: MemorySourceReceipt }
  }
}

/** Identifies one recorded model input and the content generated from it. */
export type CommunicationInputId = Branded<'AgentWorkspaceCommunicationInputId'>
/** Versioned coverage carried only by a logged model input Source. */
export interface MemorySourceReceipt {
  readonly version: 1
  readonly workspaceId: WorkspaceId
  readonly agentId: AgentId
  readonly contextGeneration: number
  readonly coverage: readonly MemoryCoverage[]
}
/** Identifies one retryable withdrawal or personal-memory context rebuild. */
export type ContextResetId = Branded<'AgentWorkspaceContextResetId'>
/** Identifies one managed file mutation checkpoint. */
export type FileCheckpointId = Branded<'AgentWorkspaceFileCheckpointId'>
/** Identifies raw bytes in the checkpoint owner's content-addressed storage. */
export type FileBlobId = Branded<'AgentWorkspaceFileBlobId'>

/** A real message in the aggregate, never a synthetic historical source. */
export interface ChatSource { readonly roomId: RoomId; readonly eventId: WorkspaceEventId }

/** Additional meaning of one persisted room/message, without changing the event. */
export interface CommunicationMessage {
  readonly eventId: WorkspaceEventId
  readonly intent: 'message' | 'assignment' | 'proposal' | 'delegation'
  /** Present only for agent-authored messages generated in a recorded context. */
  readonly contextGeneration?: number | undefined
  readonly withdrawnBy?: ContextResetId | undefined
}

/** Room input identifies an admitted source; event identifies generated content owned by its author. Other targets identify work whose sources must remain usable. */
export type CommunicationInputTarget =
  | { readonly kind: 'room-input'; readonly eventId: WorkspaceEventId }
  | { readonly kind: 'event'; readonly eventId: WorkspaceEventId }
  | { readonly kind: 'task'; readonly taskId: TaskId }
  | { readonly kind: 'draft'; readonly draftId: TaskDraftId }
  | { readonly kind: 'template'; readonly templateRevisionId: TaskTemplateRevisionId }
  | { readonly kind: 'artifact'; readonly artifactId: TaskArtifactId }

/** Sources actually admitted to the generating agent, including its cumulative session inputs. */
export interface CommunicationInput {
  readonly id: CommunicationInputId
  readonly target: CommunicationInputTarget
  /** Exact managed inbox message; absent from records written before delivery attribution. */
  readonly deliveryMessageId?: MessageId | undefined
  /** Exact task attempt for an attributed task input; legacy inputs can omit it. */
  readonly taskDeliveryAttemptId?: TaskDeliveryAttemptId | undefined
  readonly agentId: AgentId
  readonly contextGeneration: number
  readonly recordedAtSequence: number
  readonly directEventIds: readonly WorkspaceEventId[]
  readonly recalledEventIds: readonly WorkspaceEventId[]
  readonly sessionEventIds: readonly WorkspaceEventId[]
}

/** Current admission generation; a failed rebuild keeps its blockedBy operation. */
export interface CommunicationContext {
  /** Historical contexts start at zero; each persisted reset advances exactly once. */
  readonly generation: number
  readonly blockedBy?: ContextResetId | undefined
  /** A newly created local session; omit this local binding from portable records. */
  readonly sessionId?: SessionId | undefined
}

interface ContextResetBase {
  readonly id: ContextResetId
  readonly source: ChatSource
  readonly requestedByHumanId: HumanId
  /** Inclusive conservative isolation window, fixed when old generations are fenced. */
  readonly fromSequence: number
  readonly throughSequence: number
  readonly affectedAgentIds: readonly AgentId[]
  /** All generations that lost admission at this operation. */
  readonly previousGenerations: Readonly<Record<AgentId, number>>
  readonly invalidatedEventIds: readonly WorkspaceEventId[]
  readonly invalidatedTaskIds: readonly TaskId[]
  readonly invalidatedDraftIds: readonly TaskDraftId[]
  readonly invalidatedTemplateRevisionIds: readonly TaskTemplateRevisionId[]
  readonly invalidatedArtifactIds: readonly TaskArtifactId[]
  readonly requestedAt: string
  readonly fileRestoreRequested: boolean
}

type ContextResetStatus =
  | { readonly status: 'pending' | 'completed'; readonly error?: never | undefined }
  | { readonly status: 'failed'; readonly error: string }

/** Legacy withdrawals have no kind and invalidate shared sources across the organization. */
export type MessageRecallOperation = ContextResetBase & ContextResetStatus & { readonly kind?: undefined }

/** Personal acquisitions are removed while the preserved room history remains available to its other members. */
export type RoomMemoryForgetOperation = ContextResetBase & ContextResetStatus & {
  readonly kind: 'room-memory-forget'
  /** Ended membership whose room/member-left event is recorded in source. */
  readonly membershipId: MembershipId
  /** Removed room sources and personally generated room replies with recorded dependencies on them; later explicit history synchronization may acquire them again. */
  readonly forgottenEventIds: readonly WorkspaceEventId[]
  readonly fileRestoreRequested: false
}

/** Failed or incomplete rebuilds never authorize reuse of the old context. */
export type ContextResetOperation = MessageRecallOperation | RoomMemoryForgetOperation

/** Exact raw bytes, including absence, captured by the managed file journal. */
export type FileByteSnapshot =
  | { readonly existed: false }
  | { readonly existed: true; readonly blobId: FileBlobId; readonly sha256: string; readonly size: number }

/** File restoration is independent of whether the context rebuild completed. */
export type FileCheckpointRestore =
  | { readonly status: 'pending' | 'skipped' }
  | { readonly status: 'restored'; readonly recovery: FileByteSnapshot }
  | { readonly status: 'conflict' | 'failed' | 'unavailable'; readonly reason: string }

/** Metadata for a confirmed local regular file relative to its managed run's working directory. */
export interface FileCheckpointMetadata {
  readonly id: FileCheckpointId
  /** Organization-wide write order; restore affected checkpoints in descending order. */
  readonly order: number
  readonly inputId: CommunicationInputId
  readonly agentId: AgentId
  readonly contextGeneration: number
  readonly callId: ToolCallId
  /** Normalized slash-separated relative path; filesystem checks remain the journal owner's job. */
  readonly path: string
  readonly before: FileByteSnapshot
  readonly after: FileByteSnapshot
  readonly restore: FileCheckpointRestore
}

/** Metadata stored atomically beside the unchanged aggregate and workflow records. */
export interface CommunicationState {
  readonly revision: number
  /** Starts at one and advances atomically whenever a managed write checkpoint is appended. */
  readonly nextCheckpointOrder: number
  readonly messages: Readonly<Record<WorkspaceEventId, CommunicationMessage>>
  readonly taskSources: Readonly<Record<TaskId, ChatSource>>
  readonly draftSources: Readonly<Record<TaskDraftId, ChatSource>>
  readonly inputs: Readonly<Record<CommunicationInputId, CommunicationInput>>
  readonly contexts: Readonly<Record<AgentId, CommunicationContext>>
  readonly resets: Readonly<Record<ContextResetId, ContextResetOperation>>
  readonly fileCheckpoints: Readonly<Record<FileCheckpointId, FileCheckpointMetadata>>
  readonly operations: Readonly<Record<WorkflowOperationId, ChatWorkOperation>>
}

/** Minimal workflow references accepted by communication validation without runtime dependencies. */
export interface CommunicationWorkflowReferences {
  readonly drafts: Readonly<Record<TaskDraftId, { readonly id: TaskDraftId }>>
  readonly taskTemplateRevisions: Readonly<Record<TaskTemplateRevisionId, { readonly id: TaskTemplateRevisionId }>>
  readonly artifacts: Readonly<Record<TaskArtifactId, { readonly id: TaskArtifactId }>>
}

/** Content excluded from every plugin-controlled model input or work application. */
export interface CommunicationInvalidation {
  readonly inputIds: ReadonlySet<CommunicationInputId>
  readonly eventIds: ReadonlySet<WorkspaceEventId>
  readonly taskIds: ReadonlySet<TaskId>
  readonly draftIds: ReadonlySet<TaskDraftId>
  readonly templateRevisionIds: ReadonlySet<TaskTemplateRevisionId>
  readonly artifactIds: ReadonlySet<TaskArtifactId>
  readonly childRunIds: ReadonlySet<ChildRunId>
}
