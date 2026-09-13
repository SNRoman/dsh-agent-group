/** Strict JSON-only Browser mirror of the Agent Workspace Host contracts. */

export type WorkspaceId = string
export type AgentDefinitionId = string
export type DefinitionRevisionId = string
export type AgentId = string
export type RoomId = string
export type MembershipId = string
export type WorkspaceEventId = string
export type AgentMemoryEntryId = string
export type TaskId = string
export type TaskAssignmentId = string
export type DelegationGrantId = string
export type ChildRunId = string
export type WorkspaceActivityId = string
export type TaskDeliveryAttemptId = string
export type SessionId = string
export type MessageId = string
export type HumanId = string

export type WorkspaceErrorJson = null | boolean | number | string | readonly WorkspaceErrorJson[] | {
  readonly [key: string]: WorkspaceErrorJson
}

export type WorkspaceBusinessErrorDetailsMap = {
  readonly 'reserved-direct-routing': { readonly roomId: string; readonly token: '@all' }
  readonly 'agent-missing': { readonly agentId: string }
  readonly 'agent-departed': { readonly agentId: string }
  readonly 'duplicate-membership': { readonly roomId: string; readonly agentId: string }
  readonly 'stale-revision': { readonly definitionId: string; readonly revisionId: string } | { readonly expectedRevision: number; readonly actualRevision: number }
  readonly 'invalid-task-authority': { readonly taskId: string; readonly agentId: string }
  readonly 'task-not-open': { readonly taskId: string; readonly status: 'completed' | 'cancelled' }
  readonly 'task-not-assigned': { readonly taskId: string; readonly agentId: string }
  readonly 'delegation-grant-missing': { readonly lookup: 'id'; readonly delegationGrantId: string } | { readonly lookup: 'root-agent'; readonly rootTaskId: string; readonly agentId: string }
  readonly 'delegation-grant-inactive': { readonly delegationGrantId: string }
}
export type WorkspaceBusinessErrorCode = keyof WorkspaceBusinessErrorDetailsMap
type WorkspaceRpcBusinessError = { readonly [Code in WorkspaceBusinessErrorCode]: { readonly kind: 'business'; readonly code: Code; readonly message: string; readonly details: WorkspaceBusinessErrorDetailsMap[Code] } }[WorkspaceBusinessErrorCode]
export type WorkspaceRpcError = WorkspaceRpcBusinessError
  | { readonly kind: 'bad-request'; readonly code: 'bad-request'; readonly message: string; readonly details: { readonly issues: readonly unknown[] } }
  | { readonly kind: 'cancelled'; readonly code: 'cancelled'; readonly message: string; readonly details: Record<string, never> }
  | { readonly kind: 'internal'; readonly code: 'internal'; readonly message: string; readonly details: Record<string, never> }

export interface AgentDefinitionView { readonly id: AgentDefinitionId; readonly name: string; readonly revisionIds: readonly DefinitionRevisionId[]; readonly currentRevisionId: DefinitionRevisionId }
export interface DefinitionRevisionView { readonly id: DefinitionRevisionId; readonly definitionId: AgentDefinitionId; readonly number: number; readonly description: string; readonly instructions: string }
export interface EmploymentPeriodView { readonly id: string; readonly startedEventId: WorkspaceEventId; readonly endedEventId?: WorkspaceEventId | undefined }
export interface AgentInstanceView { readonly id: AgentId; readonly name: string; readonly definitionId: AgentDefinitionId; readonly definitionRevisionId: DefinitionRevisionId; readonly employmentStatus: 'employed' | 'departed'; readonly employmentPeriods: readonly EmploymentPeriodView[] }
export interface RoomView { readonly id: RoomId; readonly kind: 'group' | 'direct'; readonly name?: string | undefined }
export type MembershipMemoryStart = { readonly type: 'new-events' } | { readonly type: 'event-range'; readonly startSequence: number; readonly endSequence: number }
export interface RoomMembershipView { readonly id: MembershipId; readonly roomId: RoomId; readonly agentId: AgentId; readonly memoryStart: MembershipMemoryStart; readonly joinedEventId: WorkspaceEventId; readonly leftEventId?: WorkspaceEventId | undefined }
export type WorkspaceActorView = { readonly type: 'human'; readonly id: HumanId } | { readonly type: 'agent'; readonly id: AgentId }

export const WORKSPACE_EVENT_TYPES = [
  'definition/created', 'definition/revised', 'agent/definition-revision-assigned', 'agent/created', 'agent/departed', 'agent/employed',
  'room/created', 'room/member-joined', 'room/member-left', 'room/message', 'runtime/session-bound', 'conversation/stopped',
  'task/assigned', 'task/delegation-granted', 'task/delegation-revoked', 'task/delegated', 'task/completed', 'task/cancelled',
  'task/delivery-started', 'task/delivery-accepted', 'task/delivery-failed', 'task/result', 'task/result-after-cancel',
  'child/run-started', 'child/run-finished',
] as const
export type WorkspaceEventType = typeof WORKSPACE_EVENT_TYPES[number]
interface WorkspaceEventBase { readonly id: WorkspaceEventId; readonly sequence: number; readonly subjectId?: string | undefined; readonly definitionRevisionId?: DefinitionRevisionId | undefined; readonly actor?: WorkspaceActorView | undefined; readonly text?: string | undefined; readonly mentions?: readonly AgentId[] | undefined }
export interface ChildRunFinishedEventView extends WorkspaceEventBase { readonly type: 'child/run-finished'; readonly childRunStatus: ChildRunTerminalStatus }
export interface TaskDeliveryProgressEventView extends WorkspaceEventBase { readonly type: 'task/delivery-started' | 'task/delivery-accepted'; readonly taskId: TaskId; readonly taskDeliveryAttemptId: TaskDeliveryAttemptId; readonly messageId: MessageId; readonly failureCode?: never | undefined; readonly failureSummary?: never | undefined }
export interface TaskDeliveryFailedEventView extends WorkspaceEventBase { readonly type: 'task/delivery-failed'; readonly taskId: TaskId; readonly taskDeliveryAttemptId: TaskDeliveryAttemptId; readonly messageId: MessageId; readonly failureCode: string; readonly failureSummary: string }
export interface TaskResultEventView extends WorkspaceEventBase { readonly type: 'task/result' | 'task/result-after-cancel'; readonly taskId: TaskId; readonly taskDeliveryAttemptId: TaskDeliveryAttemptId; readonly definitionRevisionId: DefinitionRevisionId; readonly text: string }
export interface TaskCancelledEventView extends WorkspaceEventBase { readonly type: 'task/cancelled'; readonly subjectId: TaskId; readonly cancellationScope?: 'root-cascade' | 'derived-only' | undefined }
export interface TaskDelegationRevokedEventView extends WorkspaceEventBase { readonly type: 'task/delegation-revoked'; readonly subjectId: DelegationGrantId }
export interface OtherWorkspaceEventView extends WorkspaceEventBase { readonly type: Exclude<WorkspaceEventType, 'child/run-finished' | 'task/delivery-started' | 'task/delivery-accepted' | 'task/delivery-failed' | 'task/result' | 'task/result-after-cancel' | 'task/cancelled' | 'task/delegation-revoked'>; readonly childRunStatus?: never | undefined }
export type WorkspaceEventView = ChildRunFinishedEventView | TaskDeliveryProgressEventView | TaskDeliveryFailedEventView | TaskResultEventView | TaskCancelledEventView | TaskDelegationRevokedEventView | OtherWorkspaceEventView

export type MemoryProvenance = 'room-membership' | 'history-sync' | 'task' | 'child-result'
export interface AgentMemoryEntryView { readonly id: AgentMemoryEntryId; readonly agentId: AgentId; readonly eventId: WorkspaceEventId; readonly acquiredBy: MemoryProvenance }
export interface WorkspaceTaskView { readonly id: TaskId; readonly rootTaskId: TaskId; readonly title: string; readonly status: 'open' | 'completed' | 'cancelled' }
export interface TaskAssignmentView { readonly id: TaskAssignmentId; readonly taskId: TaskId; readonly rootTaskId: TaskId; readonly assigneeAgentId: AgentId; readonly grantId?: DelegationGrantId | undefined }
export interface DelegationGrantView { readonly id: DelegationGrantId; readonly rootTaskId: TaskId; readonly granteeAgentId: AgentId; readonly grantedByHumanId: HumanId; readonly status: 'active' | 'expired' }
export type ChildRunTerminalStatus = 'completed' | 'failed' | 'cancelled'
export type ChildRunView = { readonly id: ChildRunId; readonly parentAgentId: AgentId; readonly taskId: TaskId; readonly status: 'running'; readonly result?: never } | { readonly id: ChildRunId; readonly parentAgentId: AgentId; readonly taskId: TaskId; readonly status: ChildRunTerminalStatus; readonly result: string }

export interface WorkspaceSnapshot {
  readonly workspaceId: WorkspaceId; readonly revision: number; readonly nextId: number; readonly nextSequence: number
  readonly definitions: Readonly<Record<string, AgentDefinitionView>>; readonly definitionRevisions: Readonly<Record<string, DefinitionRevisionView>>
  readonly agents: Readonly<Record<string, AgentInstanceView>>; readonly rooms: Readonly<Record<string, RoomView>>
  readonly memberships: Readonly<Record<string, RoomMembershipView>>; readonly events: readonly WorkspaceEventView[]
  readonly memoryEntries: readonly AgentMemoryEntryView[]; readonly tasks: Readonly<Record<string, WorkspaceTaskView>>
  readonly taskAssignments: Readonly<Record<string, TaskAssignmentView>>; readonly delegationGrants: Readonly<Record<string, DelegationGrantView>>
  readonly childRuns: Readonly<Record<string, ChildRunView>>; readonly sessionBindings: Readonly<Record<string, SessionId>>
}

export interface WorkspaceMutationResult<Value> { readonly revision: number; readonly value: Value }
export interface WorkspaceDirectRoomValue { readonly state: WorkspaceSnapshot; readonly roomId: RoomId }
export interface WorkspaceDirectRoomResult { readonly snapshot: WorkspaceSnapshot; readonly roomId: RoomId }
export interface AssignHumanTaskResultView { readonly state: WorkspaceSnapshot; readonly taskId: TaskId; readonly taskAssignmentId: TaskAssignmentId }
export interface GrantTaskDelegationResultView { readonly state: WorkspaceSnapshot; readonly delegationGrantId: DelegationGrantId }

export type MemorySource = { readonly kind: 'room'; readonly id: RoomId; readonly label: string } | { readonly kind: 'task'; readonly id: TaskId; readonly label: string } | { readonly kind: 'child'; readonly id: ChildRunId; readonly label: string; readonly taskId: TaskId; readonly taskLabel: string }
export type MemoryDefinitionRevision = { readonly status: 'active'; readonly id: DefinitionRevisionId; readonly number: number } | { readonly status: 'unresolved' }
export interface MemoryItem { readonly eventId: WorkspaceEventId; readonly sequence: number; readonly type: WorkspaceEventType; readonly provenance: MemoryProvenance; readonly source?: MemorySource | undefined; readonly actor?: (WorkspaceActorView & { readonly label: string }) | undefined; readonly subject?: { readonly id: string; readonly label: string } | undefined; readonly text?: string | undefined; readonly childStatus?: ChildRunTerminalStatus | undefined; readonly definitionRevision: MemoryDefinitionRevision }
export interface MemoryQuery { readonly agentId: AgentId; readonly sourceKind?: MemorySource['kind'] | undefined; readonly sourceId?: string | undefined; readonly provenance?: MemoryProvenance | undefined; readonly eventTypes?: readonly WorkspaceEventType[] | undefined; readonly minimumSequence?: number | undefined; readonly maximumSequence?: number | undefined; readonly text?: string | undefined; readonly limit: number; readonly cursor?: string | undefined; readonly snapshotRevision: number }
export interface MemoryPage { readonly snapshotRevision: number; readonly items: readonly MemoryItem[]; readonly nextCursor?: string | undefined }
export type DefinitionRevisionCreationEvent = { readonly status: 'exact' | 'derived'; readonly sequence: number } | { readonly status: 'unresolved' }
export interface DefinitionHistoryItem extends DefinitionRevisionView { readonly creationEvent: DefinitionRevisionCreationEvent; readonly status: 'current' | 'previous'; readonly agentIds: readonly AgentId[] }

export interface WorkspaceActivityError { readonly code: string; readonly summary: string }
export type WorkspaceActivitySource = { readonly kind: 'room'; readonly roomId: RoomId } | { readonly kind: 'task'; readonly taskId: TaskId; readonly attemptId: TaskDeliveryAttemptId }
export interface WorkspaceActivityTextBlock { readonly kind: 'text'; readonly index: number; readonly text: string }
export interface WorkspaceActivityReasoningBlock { readonly kind: 'reasoning'; readonly index: number; readonly text: string }
export interface WorkspaceActivityToolBlock { readonly kind: 'tool'; readonly index: number; readonly callId: string; readonly name: string; readonly arguments: string; readonly status: 'running' | 'completed' | 'failed'; readonly resultText?: string | undefined; readonly error?: WorkspaceActivityError | undefined }
export interface WorkspaceActivityUnknownBlock { readonly kind: 'unknown'; readonly index: number; readonly label: string; readonly value: WorkspaceErrorJson }
export type WorkspaceActivityBlock = WorkspaceActivityTextBlock | WorkspaceActivityReasoningBlock | WorkspaceActivityToolBlock | WorkspaceActivityUnknownBlock
export interface WorkspaceActivity { readonly activityId: WorkspaceActivityId; readonly agentId: AgentId; readonly source: WorkspaceActivitySource; readonly messageId: MessageId; readonly startOrder: number; readonly status: 'queued' | 'responding' | 'stopping' | 'settled'; readonly claimed?: { readonly sessionId: SessionId; readonly turn: number } | undefined; readonly blocks: readonly WorkspaceActivityBlock[]; readonly terminalReason?: string | undefined; readonly error?: WorkspaceActivityError | undefined }
export interface WorkspaceAgentActivitySummary { readonly agentId: AgentId; readonly status: 'idle' | 'active' | 'failed'; readonly usingTool: boolean; readonly error?: WorkspaceActivityError | undefined }
export interface WorkspaceActivitySnapshot { readonly version: number; readonly workspaceRevision: number; readonly activities: readonly WorkspaceActivity[]; readonly agents: readonly WorkspaceAgentActivitySummary[] }
export interface WorkspaceActivityIdentity { readonly activityId: WorkspaceActivityId; readonly agentId: AgentId; readonly messageId: MessageId; readonly sessionId: SessionId; readonly turn: number }
export interface WorkspaceStopResult { readonly status: 'stopping' | 'already-stopping' | 'not-active' }
export interface WorkspaceRoomRuntimeStatus { readonly pending: number; readonly error?: string | undefined }
export interface WorkspaceRuntimeStatus { readonly rooms: Readonly<Record<string, WorkspaceRoomRuntimeStatus>> }

/** Conversation renderer input derived from Task 10 activity records. */
export interface WorkspaceTurnProjection { readonly activityId: WorkspaceActivityId; readonly roomId: RoomId; readonly agentId: AgentId; readonly sessionId: SessionId; readonly turn: number; readonly status: 'running' | 'settled'; readonly blocks: readonly WorkspaceTurnBlock[]; readonly stopReason?: string | undefined; readonly error?: string | undefined }
export interface WorkspaceTurnStreamSnapshot { readonly version: number; readonly workspaceRevision: number; readonly turns: readonly WorkspaceTurnProjection[] }
export type WorkspaceTurnTextBlock = WorkspaceActivityTextBlock
export type WorkspaceTurnReasoningBlock = WorkspaceActivityReasoningBlock
export interface WorkspaceTurnToolBlock extends Omit<WorkspaceActivityToolBlock, 'error'> { readonly error?: string }
export type WorkspaceTurnUnknownBlock = WorkspaceActivityUnknownBlock
export type WorkspaceTurnBlock = WorkspaceTurnTextBlock | WorkspaceTurnReasoningBlock | WorkspaceTurnToolBlock | WorkspaceTurnUnknownBlock

export interface CreateDefinitionInput { readonly name: string; readonly description: string; readonly instructions: string }
export interface ReviseDefinitionInput { readonly definitionId: AgentDefinitionId; readonly description: string; readonly instructions: string; readonly synchronizeAgentIds?: readonly AgentId[] | undefined }

/** Exact Browser-owned request fields for every revisioned Host mutation. */
export interface WorkspaceMutationRequestMap {
  readonly 'definition/create': CreateDefinitionInput
  readonly 'definition/revise': ReviseDefinitionInput
  readonly 'definition/synchronize': { readonly definitionId: AgentDefinitionId; readonly definitionRevisionId: DefinitionRevisionId; readonly agentIds: readonly AgentId[] }
  readonly 'agent/create': { readonly definitionId: AgentDefinitionId; readonly name: string }
  readonly 'agent/depart': { readonly agentId: AgentId }
  readonly 'agent/employ': { readonly agentId: AgentId }
  readonly 'room/create': { readonly kind: 'group' | 'direct'; readonly name?: string | undefined }
  readonly 'room/direct/open': { readonly agentId: AgentId }
  readonly 'room/join': { readonly roomId: RoomId; readonly agentId: AgentId; readonly memoryStart: MembershipMemoryStart }
  readonly 'room/leave': { readonly membershipId: MembershipId }
  readonly 'room/post': { readonly roomId: RoomId; readonly text: string; readonly mentions: readonly AgentId[] }
  readonly 'task/assign': { readonly assigneeAgentId: AgentId; readonly title: string }
  readonly 'task/grant': { readonly granteeAgentId: AgentId; readonly rootTaskId: TaskId }
  readonly 'task/revoke': { readonly delegationGrantId: DelegationGrantId }
  readonly 'task/cancel': { readonly taskId: TaskId }
  readonly 'task/retry-delivery': { readonly taskId: TaskId }
  readonly 'runtime/activity/stop': WorkspaceActivityIdentity
  readonly 'runtime/child/stop': { readonly childRunId: ChildRunId }
  readonly 'runtime/failure/acknowledge': { readonly agentId: AgentId }
}

/** Exact committed value returned by each revisioned Host mutation. */
export interface WorkspaceMutationValueMap {
  readonly 'definition/create': WorkspaceSnapshot
  readonly 'definition/revise': WorkspaceSnapshot
  readonly 'definition/synchronize': WorkspaceSnapshot
  readonly 'agent/create': WorkspaceSnapshot
  readonly 'agent/depart': WorkspaceSnapshot
  readonly 'agent/employ': WorkspaceSnapshot
  readonly 'room/create': WorkspaceSnapshot
  readonly 'room/direct/open': WorkspaceDirectRoomValue
  readonly 'room/join': WorkspaceSnapshot
  readonly 'room/leave': WorkspaceSnapshot
  readonly 'room/post': WorkspaceSnapshot
  readonly 'task/assign': AssignHumanTaskResultView
  readonly 'task/grant': GrantTaskDelegationResultView
  readonly 'task/revoke': WorkspaceSnapshot
  readonly 'task/cancel': WorkspaceSnapshot
  readonly 'task/retry-delivery': string
  readonly 'runtime/activity/stop': WorkspaceStopResult
  readonly 'runtime/child/stop': WorkspaceStopResult
  readonly 'runtime/failure/acknowledge': void
}
export type WorkspaceMutationEndpoint = keyof WorkspaceMutationRequestMap
