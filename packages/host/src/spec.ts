/** Zod schema and storage-domain declaration for the Workspace aggregate. */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { MessageId } from '@deepseek-ai/dsh-llm'
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
  TaskDeliveryAttemptId,
  TaskAssignmentId,
  TaskId,
  WorkspaceEventId,
  WorkspaceId,
} from './ids.ts'
import { WORKSPACE_EVENT_TYPES } from './types.ts'
import type { WorkspaceState } from './types.ts'
import { SessionId } from '@deepseek-ai/dsh-session'

const workspaceId = z.string().min(1).transform(WorkspaceId)
const definitionId = z.string().min(1).transform(AgentDefinitionId)
const definitionRevisionId = z.string().min(1).transform(DefinitionRevisionId)
const agentId = z.string().min(1).transform(AgentId)
const sessionId = z.string().min(1).transform(SessionId)
const employmentPeriodId = z.string().min(1).transform(EmploymentPeriodId)
const roomId = z.string().min(1).transform(RoomId)
const membershipId = z.string().min(1).transform(MembershipId)
const eventId = z.string().min(1).transform(WorkspaceEventId)
const memoryEntryId = z.string().min(1).transform(AgentMemoryEntryId)
const taskId = z.string().min(1).transform(TaskId)
const taskDeliveryAttemptId = z.string().min(1).transform(TaskDeliveryAttemptId)
const messageId = z.string().min(1).transform(MessageId)
const taskAssignmentId = z.string().min(1).transform(TaskAssignmentId)
const delegationGrantId = z.string().min(1).transform(DelegationGrantId)
const childRunId = z.string().min(1).transform(ChildRunId)
const humanId = z.string().min(1).transform(HumanId)
const childRunTerminalStatus = z.enum(['completed', 'failed', 'cancelled'])
const workspaceEventType = z.enum(WORKSPACE_EVENT_TYPES)

const membershipMemoryStart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('new-events') }).strict(),
  z.object({ type: z.literal('event-range'), startSequence: z.number().int().positive(), endSequence: z.number().int().positive() }).strict(),
])

const workspaceActor = z.discriminatedUnion('type', [
  z.object({ type: z.literal('human'), id: humanId }).strict(),
  z.object({ type: z.literal('agent'), id: agentId }).strict(),
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

const workspaceEventBase = {
  id: eventId,
  sequence: z.number().int().positive(),
  subjectId: workspaceSubjectId.optional(),
  definitionRevisionId: definitionRevisionId.optional(),
  actor: workspaceActor.optional(),
  text: z.string().min(1).optional(),
  mentions: z.array(agentId).optional(),
}

const workspaceEvent = z.discriminatedUnion('type', [
  z.object({
    ...workspaceEventBase,
    type: z.literal('child/run-finished'),
    childRunStatus: childRunTerminalStatus,
  }).strict(),
  z.object({
    ...workspaceEventBase,
    type: z.enum(['task/delivery-started', 'task/delivery-accepted']),
    taskId,
    taskDeliveryAttemptId,
    messageId,
    failureCode: z.never().optional(),
    failureSummary: z.never().optional(),
  }).strict(),
  z.object({
    ...workspaceEventBase,
    type: z.literal('task/delivery-failed'),
    taskId,
    taskDeliveryAttemptId,
    messageId,
    failureCode: z.string().refine(value => value.trim() !== '', 'failure code must not be blank'),
    failureSummary: z.string().refine(value => value.trim() !== '', 'failure summary must not be blank'),
  }).strict(),
  z.object({
    ...workspaceEventBase,
    type: z.enum(['task/result', 'task/result-after-cancel']),
    taskId,
    taskDeliveryAttemptId,
    definitionRevisionId,
    text: z.string().refine(value => value.trim() !== '', 'task result must not be blank'),
  }).strict(),
  z.object({
    ...workspaceEventBase,
    type: z.literal('task/cancelled'),
    subjectId: taskId,
    cancellationScope: z.enum(['root-cascade', 'derived-only']).optional(),
  }).strict(),
  z.object({
    ...workspaceEventBase,
    type: z.literal('task/delegation-revoked'),
    subjectId: delegationGrantId,
  }).strict(),
  z.object({
    ...workspaceEventBase,
    type: workspaceEventType.exclude([
      'child/run-finished',
      'task/delivery-started',
      'task/delivery-accepted',
      'task/delivery-failed',
      'task/result',
      'task/result-after-cancel',
      'task/cancelled',
      'task/delegation-revoked',
    ]),
    childRunStatus: z.never().optional(),
  }).strict(),
])

const agentDefinition = z.object({
  id: definitionId,
  name: z.string().min(1),
  revisionIds: z.array(definitionRevisionId),
  currentRevisionId: definitionRevisionId,
}).strict()

const definitionRevision = z.object({
  id: definitionRevisionId,
  definitionId,
  number: z.number().int().positive(),
  description: z.string(),
  instructions: z.string(),
}).strict()

const employmentPeriod = z.object({
  id: employmentPeriodId,
  startedEventId: eventId,
  endedEventId: eventId.optional(),
}).strict()

const agentInstance = z.object({
  id: agentId,
  name: z.string().min(1),
  definitionId,
  definitionRevisionId,
  employmentStatus: z.enum(['employed', 'departed']),
  employmentPeriods: z.array(employmentPeriod),
}).strict()

const room = z.object({ id: roomId, kind: z.enum(['group', 'direct']), name: z.string().min(1).optional() }).strict()

const roomMembership = z.object({
  id: membershipId,
  roomId,
  agentId,
  memoryStart: membershipMemoryStart,
  joinedEventId: eventId,
  leftEventId: eventId.optional(),
}).strict()

const memoryEntry = z.object({
  id: memoryEntryId,
  agentId,
  eventId,
  acquiredBy: z.enum(['room-membership', 'history-sync', 'task', 'child-result']),
}).strict()

const workspaceTask = z.object({ id: taskId, rootTaskId: taskId, title: z.string(), status: z.enum(['open', 'completed', 'cancelled']) }).strict()
const taskAssignment = z.object({ id: taskAssignmentId, taskId, rootTaskId: taskId, assigneeAgentId: agentId, grantId: delegationGrantId.optional() }).strict()
const delegationGrant = z.object({ id: delegationGrantId, rootTaskId: taskId, granteeAgentId: agentId, grantedByHumanId: humanId, status: z.enum(['active', 'expired']) }).strict()
const childRun = z.discriminatedUnion('status', [
  z.object({ id: childRunId, parentAgentId: agentId, taskId, status: z.literal('running') }).strict(),
  z.object({ id: childRunId, parentAgentId: agentId, taskId, status: childRunTerminalStatus, result: z.string().refine(value => value.trim() !== '', 'child run result must not be blank') }).strict(),
])

/** Validates the complete one-record durable workspace aggregate. */
export const workspaceStateSchema = z.object({
  workspaceId,
  revision: z.number().int().nonnegative(),
  nextId: z.number().int().positive(),
  nextSequence: z.number().int().positive(),
  definitions: z.record(z.string(), agentDefinition),
  definitionRevisions: z.record(z.string(), definitionRevision),
  agents: z.record(z.string(), agentInstance),
  rooms: z.record(z.string(), room),
  memberships: z.record(z.string(), roomMembership),
  events: z.array(workspaceEvent),
  memoryEntries: z.array(memoryEntry),
  tasks: z.record(z.string(), workspaceTask),
  taskAssignments: z.record(z.string(), taskAssignment),
  delegationGrants: z.record(z.string(), delegationGrant),
  childRuns: z.record(z.string(), childRun),
  sessionBindings: z.record(z.string(), sessionId),
}).strict() satisfies z.ZodType<WorkspaceState>

/** One-table storage declaration: every workspace mutation replaces its aggregate atomically. */
export const agentWorkspaceSpec = defineDomain({
  name: 'agent_workspace',
  version: 0,
  tables: { workspaces: domainTable<WorkspaceId, WorkspaceState>(workspaceStateSchema) },
})
