/** Durable Agent Workspace aggregate records and pure mutation commands. */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  AgentDefinitionId,
  AgentId,
  AgentMemoryEntryId,
  ChildRunId,
  DefinitionRevisionId,
  DelegationGrantId,
  EmploymentPeriodId,
  HumanId,
  MembershipId,
  RoomId,
  TaskAssignmentId,
  TaskId,
  WorkspaceEventId,
  WorkspaceId,
} from './ids.ts'

/** A reusable role and its ordered immutable revisions. */
export interface AgentDefinition {
  readonly id: AgentDefinitionId
  readonly name: string
  readonly revisionIds: readonly DefinitionRevisionId[]
  readonly currentRevisionId: DefinitionRevisionId
}

/** One immutable definition revision. */
export interface DefinitionRevision {
  readonly id: DefinitionRevisionId
  readonly definitionId: AgentDefinitionId
  readonly number: number
  readonly description: string
  readonly instructions: string
}

/** A contiguous interval during which an agent is employed. */
export interface EmploymentPeriod {
  readonly id: EmploymentPeriodId
  readonly startedEventId: WorkspaceEventId
  readonly endedEventId?: WorkspaceEventId | undefined
}

/** One named top-level colleague. */
export interface AgentInstance {
  readonly id: AgentId
  readonly name: string
  readonly definitionId: AgentDefinitionId
  readonly definitionRevisionId: DefinitionRevisionId
  readonly employmentStatus: 'employed' | 'departed'
  readonly employmentPeriods: readonly EmploymentPeriod[]
}

/** A group discussion or direct-message conversation. */
export interface Room {
  readonly id: RoomId
  readonly kind: 'group' | 'direct'
  readonly name?: string | undefined
}

/** The memory admission requested at the beginning of a membership period. */
export type MembershipMemoryStart =
  | { readonly type: 'new-events' }
  | { readonly type: 'event-range'; readonly startSequence: number; readonly endSequence: number }

/** A contiguous room membership period. */
export interface RoomMembership {
  readonly id: MembershipId
  readonly roomId: RoomId
  readonly agentId: AgentId
  readonly memoryStart: MembershipMemoryStart
  readonly joinedEventId: WorkspaceEventId
  readonly leftEventId?: WorkspaceEventId | undefined
}

/** A human or employed top-level agent acting in a room event. */
export type WorkspaceActor =
  | { readonly type: 'human'; readonly id: HumanId }
  | { readonly type: 'agent'; readonly id: AgentId }

/** An identifier owned by the Workspace aggregate and referenced by an event. */
export type WorkspaceSubjectId =
  | AgentDefinitionId
  | DefinitionRevisionId
  | AgentId
  | EmploymentPeriodId
  | RoomId
  | MembershipId
  | AgentMemoryEntryId
  | TaskId
  | TaskAssignmentId
  | DelegationGrantId
  | ChildRunId

/** Fields shared by all immutable, sequence-ordered workspace facts. */
export interface WorkspaceEventBase {
  readonly id: WorkspaceEventId
  readonly sequence: number
  readonly type: string
  readonly subjectId?: WorkspaceSubjectId | undefined
  readonly definitionRevisionId?: DefinitionRevisionId | undefined
  readonly actor?: WorkspaceActor | undefined
  readonly text?: string | undefined
  readonly mentions?: readonly AgentId[] | undefined
}

/** A terminal child result fact with its required terminal status. */
export interface ChildRunFinishedEvent extends WorkspaceEventBase {
  readonly type: 'child/run-finished'
  readonly childRunStatus: ChildRunTerminalStatus
}

/** A workspace fact that is not a terminal child result. */
export interface OtherWorkspaceEvent extends WorkspaceEventBase {
  readonly childRunStatus?: never | undefined
}

/** One immutable, sequence-ordered workspace fact. */
export type WorkspaceEvent = ChildRunFinishedEvent | OtherWorkspaceEvent

/** A durable association between an agent and an event it can recall. */
export interface AgentMemoryEntry {
  readonly id: AgentMemoryEntryId
  readonly agentId: AgentId
  readonly eventId: WorkspaceEventId
  readonly acquiredBy: 'room-membership' | 'history-sync' | 'task' | 'child-result'
}

/** The data required to associate one agent with an existing workspace event. */
export interface AgentMemoryAcquisition {
  readonly agentId: AgentId
  readonly eventId: WorkspaceEventId
  readonly acquiredBy: AgentMemoryEntry['acquiredBy']
}

/** The request used to select personal memory for an awakened agent. */
export interface RecallAgentEventsRequest {
  readonly agentId: AgentId
  readonly roomId: RoomId
  readonly query: string
  readonly characterBudget: number
}

/** One event selected for a DSH memory input. */
export interface RecalledAgentEvent {
  readonly eventId: WorkspaceEventId
  readonly provenance: AgentMemoryEntry['acquiredBy']
  readonly rendered: string
}

/** The selected personal-memory events and their rendered DSH input. */
export interface AgentEventRecall {
  readonly eventIds: readonly WorkspaceEventId[]
  readonly entries: readonly RecalledAgentEvent[]
  readonly rendered: string
}

/** A formal root or derived task. */
export interface WorkspaceTask {
  readonly id: TaskId
  readonly rootTaskId: TaskId
  readonly title: string
  readonly status: 'open' | 'completed' | 'cancelled'
}

/** A durable task assignment. */
export interface TaskAssignment {
  readonly id: TaskAssignmentId
  readonly taskId: TaskId
  readonly rootTaskId: TaskId
  readonly assigneeAgentId: AgentId
  readonly grantId?: DelegationGrantId | undefined
}

/** Human-created authority for a top-level task delegation. */
export interface DelegationGrant {
  readonly id: DelegationGrantId
  readonly rootTaskId: TaskId
  readonly granteeAgentId: AgentId
  readonly grantedByHumanId: HumanId
  readonly status: 'active' | 'expired'
}

/** A terminal outcome for a one-shot child-agent execution. */
export type ChildRunTerminalStatus = 'completed' | 'failed' | 'cancelled'

/** A one-shot child-agent execution that has not returned a result. */
export interface RunningChildRun {
  readonly id: ChildRunId
  readonly parentAgentId: AgentId
  readonly taskId: TaskId
  readonly status: 'running'
  readonly result?: never
}

/** A one-shot child-agent execution with its terminal result. */
export interface TerminalChildRun {
  readonly id: ChildRunId
  readonly parentAgentId: AgentId
  readonly taskId: TaskId
  readonly status: ChildRunTerminalStatus
  readonly result: string
}

/** A one-shot child-agent execution owned by a top-level agent. */
export type ChildRun = RunningChildRun | TerminalChildRun

/** The one-record durable aggregate for a workspace. */
export interface WorkspaceState {
  readonly workspaceId: WorkspaceId
  readonly revision: number
  readonly nextId: number
  readonly nextSequence: number
  readonly definitions: Readonly<Record<AgentDefinitionId, AgentDefinition>>
  readonly definitionRevisions: Readonly<Record<DefinitionRevisionId, DefinitionRevision>>
  readonly agents: Readonly<Record<AgentId, AgentInstance>>
  readonly rooms: Readonly<Record<RoomId, Room>>
  readonly memberships: Readonly<Record<MembershipId, RoomMembership>>
  readonly events: readonly WorkspaceEvent[]
  readonly memoryEntries: readonly AgentMemoryEntry[]
  readonly tasks: Readonly<Record<TaskId, WorkspaceTask>>
  readonly taskAssignments: Readonly<Record<TaskAssignmentId, TaskAssignment>>
  readonly delegationGrants: Readonly<Record<DelegationGrantId, DelegationGrant>>
  readonly childRuns: Readonly<Record<ChildRunId, ChildRun>>
  readonly sessionBindings: Readonly<Record<AgentId, SessionId>>
}

/** Create a reusable agent role. */
export interface CreateDefinitionCommand {
  readonly type: 'definition/create'
  readonly name: string
  readonly description: string
  readonly instructions: string
}

/** Save the next immutable revision and optionally assign it to existing agents. */
export interface ReviseDefinitionCommand {
  readonly type: 'definition/revise'
  readonly definitionId: AgentDefinitionId
  readonly description: string
  readonly instructions: string
  readonly synchronizeAgentIds?: readonly AgentId[]
}

/** Assign an existing immutable definition revision to selected agents. */
export interface SynchronizeDefinitionCommand {
  readonly type: 'definition/synchronize'
  readonly definitionId: AgentDefinitionId
  readonly definitionRevisionId: DefinitionRevisionId
  readonly agentIds: readonly AgentId[]
}

/** Create an employed named top-level agent from a definition. */
export interface CreateAgentCommand {
  readonly type: 'agent/create'
  readonly definitionId: AgentDefinitionId
  readonly name: string
}

/** End an agent's current employment period and all active room memberships. */
export interface DepartAgentCommand { readonly type: 'agent/depart'; readonly agentId: AgentId }
/** Begin a new employment period for a departed agent. */
export interface EmployAgentCommand { readonly type: 'agent/employ'; readonly agentId: AgentId }
/** Create a group or direct-message room. */
export interface CreateRoomCommand { readonly type: 'room/create'; readonly kind: Room['kind']; readonly name?: string | undefined }
/** Begin an agent's room membership period. */
export interface JoinRoomCommand {
  readonly type: 'room/join'
  readonly roomId: RoomId
  readonly agentId: AgentId
  readonly memoryStart: MembershipMemoryStart
}
/** End an active room membership period. */
export interface LeaveRoomCommand { readonly type: 'room/leave'; readonly membershipId: MembershipId }
/** Record the durable DSH session id bound to one materialized top-level agent. */
export interface RecordSessionBindingCommand {
  readonly type: 'runtime/session-bound'
  readonly agentId: AgentId
  readonly sessionId: SessionId
}

/** Append a room message fact without projecting it into agent memory. */
export interface RoomMessageCommand {
  readonly type: 'room/message'
  readonly roomId: RoomId
  readonly actor: WorkspaceActor
  readonly text: string
  readonly mentions: readonly AgentId[]
}

/** Every mutation accepted by the aggregate. */
export type WorkspaceCommand =
  | CreateDefinitionCommand
  | ReviseDefinitionCommand
  | SynchronizeDefinitionCommand
  | CreateAgentCommand
  | DepartAgentCommand
  | EmployAgentCommand
  | CreateRoomCommand
  | JoinRoomCommand
  | LeaveRoomCommand
  | RoomMessageCommand
  | RecordSessionBindingCommand

/** Common result returned by a successful aggregate mutation. */
export interface MutationResult { readonly state: WorkspaceState }
/** Result that exposes a newly created definition id. */
export interface CreateDefinitionResult extends MutationResult { readonly definitionId: AgentDefinitionId; readonly definitionRevisionId: DefinitionRevisionId }
/** Result that exposes a newly created revision id. */
export interface ReviseDefinitionResult extends MutationResult { readonly definitionRevisionId: DefinitionRevisionId }
/** Result that exposes a newly created agent id. */
export interface CreateAgentResult extends MutationResult { readonly agentId: AgentId }
/** Result that exposes a newly created room id. */
export interface CreateRoomResult extends MutationResult { readonly roomId: RoomId }
/** Result that exposes one appended event id. */
export interface RoomMessageResult extends MutationResult { readonly eventId: WorkspaceEventId }
