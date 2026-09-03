/** JSON-only Browser view of the Agent Workspace aggregate. */

export type AgentDefinitionId = string
export type DefinitionRevisionId = string
export type AgentId = string
export type RoomId = string
export type MembershipId = string

/** JSON values accepted in browser-visible business-error details. */
export type WorkspaceErrorJson = null | boolean | number | string | readonly WorkspaceErrorJson[] | {
  readonly [key: string]: WorkspaceErrorJson
}

/** Closed Browser map from stable Host policy codes to locale-formatting details. */
export type WorkspaceBusinessErrorDetailsMap = {
  readonly 'reserved-direct-routing': { readonly roomId: string; readonly token: '@all' }
  readonly 'agent-missing': { readonly agentId: string }
  readonly 'agent-departed': { readonly agentId: string }
  readonly 'duplicate-membership': { readonly roomId: string; readonly agentId: string }
  readonly 'stale-revision': { readonly definitionId: string; readonly revisionId: string }
  readonly 'invalid-task-authority': { readonly taskId: string; readonly agentId: string }
}

/** Stable Host policy codes available for locale mapping. */
export type WorkspaceBusinessErrorCode = keyof WorkspaceBusinessErrorDetailsMap

type WorkspaceRpcBusinessError = {
  readonly [Code in WorkspaceBusinessErrorCode]: {
    readonly kind: 'business'
    readonly code: Code
    readonly message: string
    readonly details: WorkspaceBusinessErrorDetailsMap[Code]
  }
}[WorkspaceBusinessErrorCode]

/** Browser-visible failure returned by the Agent Workspace RPC channel. */
export type WorkspaceRpcError =
  | WorkspaceRpcBusinessError
  | {
    readonly kind: 'bad-request'
    readonly code: 'bad-request'
    readonly message: string
    readonly details: { readonly issues: readonly unknown[] }
  }
  | {
    readonly kind: 'cancelled'
    readonly code: 'cancelled'
    readonly message: string
    readonly details: Record<string, never>
  }
  | {
    readonly kind: 'internal'
    readonly code: 'internal'
    readonly message: string
    readonly details: Record<string, never>
  }

export interface AgentDefinitionView {
  readonly id: AgentDefinitionId
  readonly name: string
  readonly revisionIds: readonly DefinitionRevisionId[]
  readonly currentRevisionId: DefinitionRevisionId
}

export interface DefinitionRevisionView {
  readonly id: DefinitionRevisionId
  readonly definitionId: AgentDefinitionId
  readonly number: number
  readonly description: string
  readonly instructions: string
}

export interface AgentInstanceView {
  readonly id: AgentId
  readonly name: string
  readonly definitionId: AgentDefinitionId
  readonly definitionRevisionId: DefinitionRevisionId
  readonly employmentStatus: 'employed' | 'departed'
}

export interface RoomView {
  readonly id: RoomId
  readonly kind: 'group' | 'direct'
  readonly name?: string
}

export interface RoomMembershipView {
  readonly id: MembershipId
  readonly roomId: RoomId
  readonly agentId: AgentId
  readonly leftEventId?: string
}

export type WorkspaceActorView =
  | { readonly type: 'human'; readonly id: string }
  | { readonly type: 'agent'; readonly id: AgentId }

export interface WorkspaceEventView {
  readonly id: string
  readonly sequence: number
  readonly type: string
  readonly subjectId?: string
  readonly actor?: WorkspaceActorView
  readonly text?: string
  readonly mentions?: readonly AgentId[]
}

/** Stable subset consumed by the Browser UI; Host may carry additional fields. */
export interface WorkspaceSnapshot {
  readonly workspaceId: string
  readonly revision: number
  readonly definitions: Readonly<Record<string, AgentDefinitionView>>
  readonly definitionRevisions: Readonly<Record<string, DefinitionRevisionView>>
  readonly agents: Readonly<Record<string, AgentInstanceView>>
  readonly rooms: Readonly<Record<string, RoomView>>
  readonly memberships: Readonly<Record<string, RoomMembershipView>>
  readonly events: readonly WorkspaceEventView[]
}

/** Ephemeral per-room execution state reported by the Host. */
export interface WorkspaceRoomRuntimeStatus {
  readonly pending: number
  readonly error?: string
}

/** Ephemeral execution status is deliberately separate from durable WorkspaceSnapshot. */
export interface WorkspaceRuntimeStatus {
  readonly rooms: Readonly<Record<string, WorkspaceRoomRuntimeStatus>>
}

export interface WorkspaceTurnTextBlock {
  readonly kind: 'text'
  readonly index: number
  readonly text: string
}

export interface WorkspaceTurnReasoningBlock {
  readonly kind: 'reasoning'
  readonly index: number
  readonly text: string
}

export interface WorkspaceTurnToolBlock {
  readonly kind: 'tool'
  readonly index: number
  readonly callId: string
  readonly name: string
  readonly arguments: string
  readonly status: 'running' | 'completed' | 'failed'
  readonly resultText?: string
  readonly error?: string
}

export interface WorkspaceTurnUnknownBlock {
  readonly kind: 'unknown'
  readonly index: number
  readonly label: string
  readonly value: unknown
}

export type WorkspaceTurnBlock =
  | WorkspaceTurnTextBlock
  | WorkspaceTurnReasoningBlock
  | WorkspaceTurnToolBlock
  | WorkspaceTurnUnknownBlock

/** Transient projection of one real DSH employee turn. */
export interface WorkspaceTurnProjection {
  readonly roomId: RoomId
  readonly agentId: AgentId
  readonly sessionId: string
  readonly turn: number
  readonly status: 'running' | 'settled'
  readonly blocks: readonly WorkspaceTurnBlock[]
  readonly stopReason?: string
  readonly error?: string
}

/** Versioned long-poll snapshot of all currently visible transient turns. */
export interface WorkspaceTurnStreamSnapshot {
  readonly version: number
  readonly workspaceRevision: number
  readonly turns: readonly WorkspaceTurnProjection[]
}

/** Browser-normalized result of opening/reusing a stable direct room. */
export interface WorkspaceDirectRoomResult {
  readonly snapshot: WorkspaceSnapshot
  readonly roomId: RoomId
}

export interface CreateDefinitionInput {
  readonly name: string
  readonly description: string
  readonly instructions: string
}

export interface ReviseDefinitionInput {
  readonly definitionId: AgentDefinitionId
  readonly description: string
  readonly instructions: string
  readonly synchronizeAgentIds?: readonly AgentId[]
}
