/** Zod schema and storage-domain declaration for the Workspace aggregate. */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import {
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
import type { WorkspaceState } from './types.ts'

const workspaceId = z.string().min(1).transform(WorkspaceId)
const definitionId = z.string().min(1).transform(AgentDefinitionId)
const definitionRevisionId = z.string().min(1).transform(DefinitionRevisionId)
const agentId = z.string().min(1).transform(AgentId)
const employmentPeriodId = z.string().min(1).transform(EmploymentPeriodId)
const roomId = z.string().min(1).transform(RoomId)
const membershipId = z.string().min(1).transform(MembershipId)
const eventId = z.string().min(1).transform(WorkspaceEventId)
const memoryEntryId = z.string().min(1).transform(AgentMemoryEntryId)
const taskId = z.string().min(1).transform(TaskId)
const taskAssignmentId = z.string().min(1).transform(TaskAssignmentId)
const delegationGrantId = z.string().min(1).transform(DelegationGrantId)
const childRunId = z.string().min(1).transform(ChildRunId)
const humanId = z.string().min(1).transform(HumanId)

const membershipMemoryStart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('new-events') }),
  z.object({ type: z.literal('event-range'), startSequence: z.number().int().positive(), endSequence: z.number().int().positive() }),
])

const workspaceActor = z.discriminatedUnion('type', [
  z.object({ type: z.literal('human'), id: humanId }),
  z.object({ type: z.literal('agent'), id: agentId }),
])

const workspaceSubjectId = z.union([
  definitionId,
  definitionRevisionId,
  agentId,
  employmentPeriodId,
  roomId,
  membershipId,
  memoryEntryId,
  taskId,
  taskAssignmentId,
  delegationGrantId,
  childRunId,
])

/** Validates the complete one-record durable workspace aggregate. */
export const workspaceStateSchema = z.object({
  workspaceId,
  revision: z.number().int().nonnegative(),
  nextId: z.number().int().positive(),
  nextSequence: z.number().int().positive(),
  definitions: z.record(z.string(), z.object({
    id: definitionId,
    name: z.string().min(1),
    revisionIds: z.array(definitionRevisionId),
    currentRevisionId: definitionRevisionId,
  })),
  definitionRevisions: z.record(z.string(), z.object({
    id: definitionRevisionId,
    definitionId,
    number: z.number().int().positive(),
    description: z.string(),
    instructions: z.string(),
  })),
  agents: z.record(z.string(), z.object({
    id: agentId,
    name: z.string().min(1),
    definitionId,
    definitionRevisionId,
    employmentStatus: z.enum(['employed', 'departed']),
    employmentPeriods: z.array(z.object({ id: employmentPeriodId, startedEventId: eventId, endedEventId: eventId.optional() })),
  })),
  rooms: z.record(z.string(), z.object({ id: roomId, kind: z.enum(['group', 'direct']), name: z.string().min(1).optional() })),
  memberships: z.record(z.string(), z.object({
    id: membershipId,
    roomId,
    agentId,
    memoryStart: membershipMemoryStart,
    joinedEventId: eventId,
    leftEventId: eventId.optional(),
  })),
  events: z.array(z.object({
    id: eventId,
    sequence: z.number().int().positive(),
    type: z.string().min(1),
    subjectId: workspaceSubjectId.optional(),
    definitionRevisionId: definitionRevisionId.optional(),
    actor: workspaceActor.optional(),
    text: z.string().min(1).optional(),
    mentions: z.array(agentId).optional(),
  })),
  memoryEntries: z.array(z.object({ id: memoryEntryId, agentId, eventId, acquiredBy: z.enum(['room-membership', 'history-sync', 'task', 'child-result']) })),
  tasks: z.record(z.string(), z.object({ id: taskId, rootTaskId: taskId, title: z.string(), status: z.enum(['open', 'completed', 'cancelled']) })),
  taskAssignments: z.record(z.string(), z.object({ id: taskAssignmentId, taskId, rootTaskId: taskId, assigneeAgentId: agentId, grantId: delegationGrantId.optional() })),
  delegationGrants: z.record(z.string(), z.object({ id: delegationGrantId, rootTaskId: taskId, granteeAgentId: agentId, grantedByHumanId: humanId, status: z.enum(['active', 'expired']) })),
  childRuns: z.record(z.string(), z.object({ id: childRunId, parentAgentId: agentId, taskId, status: z.enum(['running', 'completed', 'failed', 'cancelled']), result: z.string().optional() })),
}) satisfies z.ZodType<WorkspaceState>

/** One-table storage declaration: every workspace mutation replaces its aggregate atomically. */
export const agentWorkspaceSpec = defineDomain({
  name: 'agent-workspace',
  version: 0,
  tables: { workspaces: domainTable<WorkspaceId, WorkspaceState>(workspaceStateSchema) },
})
