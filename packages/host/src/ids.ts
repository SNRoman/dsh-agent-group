/** Opaque identifier constructors owned by the Agent Workspace domain. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identifies one durable workspace aggregate. */
export type WorkspaceId = Branded<'AgentWorkspaceId'>
/** Identifies one reusable agent definition. */
export type AgentDefinitionId = Branded<'AgentDefinitionId'>
/** Identifies one immutable definition revision. */
export type DefinitionRevisionId = Branded<'DefinitionRevisionId'>
/** Identifies one named top-level agent. */
export type AgentId = Branded<'AgentWorkspaceAgentId'>
/** Identifies one continuous employed period for an agent. */
export type EmploymentPeriodId = Branded<'EmploymentPeriodId'>
/** Identifies one conversation room. */
export type RoomId = Branded<'AgentWorkspaceRoomId'>
/** Identifies one continuous room membership period. */
export type MembershipId = Branded<'AgentWorkspaceMembershipId'>
/** Identifies one append-only workspace event. */
export type WorkspaceEventId = Branded<'AgentWorkspaceEventId'>
/** Identifies one agent-to-event memory association. */
export type AgentMemoryEntryId = Branded<'AgentWorkspaceMemoryEntryId'>
/** Identifies one root or derived task. */
export type TaskId = Branded<'AgentWorkspaceTaskId'>
/** Identifies one task assignment. */
export type TaskAssignmentId = Branded<'AgentWorkspaceTaskAssignmentId'>
/** Identifies one human-authorized delegation grant. */
export type DelegationGrantId = Branded<'AgentWorkspaceDelegationGrantId'>
/** Identifies one terminal child-agent run. */
export type ChildRunId = Branded<'AgentWorkspaceChildRunId'>
/** Identifies the human operating a local workspace. */
export type HumanId = Branded<'AgentWorkspaceHumanId'>

/** Brand a durable workspace identifier. */
export function WorkspaceId(value: string): WorkspaceId { return value as WorkspaceId }
/** Brand a durable definition identifier. */
export function AgentDefinitionId(value: string): AgentDefinitionId { return value as AgentDefinitionId }
/** Brand a durable definition-revision identifier. */
export function DefinitionRevisionId(value: string): DefinitionRevisionId { return value as DefinitionRevisionId }
/** Brand a durable agent identifier. */
export function AgentId(value: string): AgentId { return value as AgentId }
/** Brand a durable employment-period identifier. */
export function EmploymentPeriodId(value: string): EmploymentPeriodId { return value as EmploymentPeriodId }
/** Brand a durable room identifier. */
export function RoomId(value: string): RoomId { return value as RoomId }
/** Brand a durable membership identifier. */
export function MembershipId(value: string): MembershipId { return value as MembershipId }
/** Brand a durable workspace-event identifier. */
export function WorkspaceEventId(value: string): WorkspaceEventId { return value as WorkspaceEventId }
/** Brand a durable agent-memory-entry identifier. */
export function AgentMemoryEntryId(value: string): AgentMemoryEntryId { return value as AgentMemoryEntryId }
/** Brand a durable task identifier. */
export function TaskId(value: string): TaskId { return value as TaskId }
/** Brand a durable task-assignment identifier. */
export function TaskAssignmentId(value: string): TaskAssignmentId { return value as TaskAssignmentId }
/** Brand a durable delegation-grant identifier. */
export function DelegationGrantId(value: string): DelegationGrantId { return value as DelegationGrantId }
/** Brand a durable child-run identifier. */
export function ChildRunId(value: string): ChildRunId { return value as ChildRunId }
/** Brand a durable human identifier. */
export function HumanId(value: string): HumanId { return value as HumanId }
