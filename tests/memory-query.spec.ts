import { describe, expect, test } from 'vitest'
import { WorkspaceBusinessError } from '../packages/host/src/errors.ts'
import {
  AgentDefinitionId,
  AgentId,
  AgentMemoryEntryId,
  ChildRunId,
  DefinitionRevisionId,
  HumanId,
  RoomId,
  TaskId,
  WorkspaceEventId,
  WorkspaceId,
} from '../packages/host/src/ids.ts'
import { queryAgentMemory } from '../packages/host/src/memory-query.ts'
import { appendMemoryEntries, createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import {
  assignHumanTask,
  grantTaskDelegation,
  recordChildRunFinished,
  recordChildRunStarted,
} from '../packages/host/src/tasks.ts'
import type { WorkspaceEventType, WorkspaceState } from '../packages/host/src/types.ts'

const aliceId = AgentId('agent-alice')
const bobId = AgentId('agent-bob')
const roomId = RoomId('room-engineering')
const taskId = TaskId('task-release')
const childId = ChildRunId('child-review')
const revisionId = DefinitionRevisionId('revision-java-2')

function state(): WorkspaceState {
  const definitionId = AgentDefinitionId('definition-java')
  return {
    workspaceId: WorkspaceId('local'),
    revision: 17,
    nextId: 100,
    nextSequence: 7,
    definitions: {
      [definitionId]: { id: definitionId, name: 'Java engineer', revisionIds: [revisionId], currentRevisionId: revisionId },
    },
    definitionRevisions: {
      [revisionId]: { id: revisionId, definitionId, number: 2, description: 'Build services', instructions: 'Ship safely' },
    },
    agents: {
      [aliceId]: { id: aliceId, name: 'Alice', definitionId, definitionRevisionId: revisionId, employmentStatus: 'departed', employmentPeriods: [] },
      [bobId]: { id: bobId, name: 'Bob', definitionId, definitionRevisionId: revisionId, employmentStatus: 'employed', employmentPeriods: [] },
    },
    rooms: { [roomId]: { id: roomId, kind: 'group', name: 'Engineering' } },
    memberships: {},
    events: [
      { id: WorkspaceEventId('event-room'), sequence: 1, type: 'room/message', subjectId: roomId, actor: { type: 'human', id: HumanId('owner') }, text: 'Release İSTANBUL Friday', mentions: [aliceId] },
      { id: WorkspaceEventId('event-task'), sequence: 2, type: 'task/completed', subjectId: taskId, actor: { type: 'agent', id: aliceId }, text: 'Compile release', definitionRevisionId: revisionId },
      { id: WorkspaceEventId('event-child-start'), sequence: 3, type: 'child/run-started', subjectId: childId, actor: { type: 'agent', id: aliceId } },
      { id: WorkspaceEventId('event-child'), sequence: 4, type: 'child/run-finished', subjectId: childId, actor: { type: 'agent', id: bobId }, text: 'Review complete', childRunStatus: 'completed', definitionRevisionId: revisionId },
      { id: WorkspaceEventId('event-legacy'), sequence: 5, type: 'room/message', subjectId: roomId, actor: { type: 'agent', id: aliceId }, text: 'Legacy response' },
      { id: WorkspaceEventId('event-task-result'), sequence: 6, type: 'task/result', taskId, taskDeliveryAttemptId: 'attempt-1' as never, definitionRevisionId: revisionId, text: 'Final release result' },
    ],
    memoryEntries: [
      { id: AgentMemoryEntryId('memory-1'), agentId: aliceId, eventId: WorkspaceEventId('event-room'), acquiredBy: 'room-membership' },
      { id: AgentMemoryEntryId('memory-2'), agentId: aliceId, eventId: WorkspaceEventId('event-task'), acquiredBy: 'task' },
      { id: AgentMemoryEntryId('memory-3'), agentId: aliceId, eventId: WorkspaceEventId('event-child-start'), acquiredBy: 'task' },
      { id: AgentMemoryEntryId('memory-4'), agentId: aliceId, eventId: WorkspaceEventId('event-child'), acquiredBy: 'child-result' },
      { id: AgentMemoryEntryId('memory-5'), agentId: aliceId, eventId: WorkspaceEventId('event-legacy'), acquiredBy: 'history-sync' },
      { id: AgentMemoryEntryId('memory-6'), agentId: aliceId, eventId: WorkspaceEventId('event-task-result'), acquiredBy: 'task' },
      { id: AgentMemoryEntryId('memory-duplicate'), agentId: aliceId, eventId: WorkspaceEventId('event-room'), acquiredBy: 'history-sync' },
    ],
    tasks: { [taskId]: { id: taskId, rootTaskId: taskId, title: 'Release service', status: 'completed' } },
    taskAssignments: {},
    delegationGrants: {},
    childRuns: { [childId]: { id: childId, parentAgentId: aliceId, taskId, status: 'completed', result: 'Review complete' } },
    sessionBindings: {},
  }
}

describe('unified personal memory query', () => {
  test('returns a pure newest-first projection with resolved sources, labels, status, revision, and first provenance', () => {
    const snapshot = state()
    const before = structuredClone(snapshot)

    const page = queryAgentMemory(snapshot, { agentId: aliceId, snapshotRevision: 17, limit: 20 })

    expect(page.snapshotRevision).toBe(17)
    expect(page.items.map(item => item.sequence)).toEqual([6, 5, 4, 3, 2, 1])
    expect(page.items.at(-1)).toMatchObject({
      eventId: 'event-room', provenance: 'room-membership',
      source: { kind: 'room', id: roomId, label: 'Engineering' },
      actor: { type: 'human', id: 'owner', label: 'owner' },
      subject: { id: roomId, label: 'Engineering' },
    })
    expect(page.items.find(item => item.eventId === 'event-task')).toMatchObject({
      source: { kind: 'task', id: taskId, label: 'Release service' },
      actor: { type: 'agent', id: aliceId, label: 'Alice' },
      definitionRevision: { status: 'active', id: revisionId, number: 2 },
    })
    expect(page.items.find(item => item.eventId === 'event-child')).toMatchObject({
      source: { kind: 'child', id: childId, label: 'Review complete' }, childStatus: 'completed',
    })
    expect(page.items.find(item => item.eventId === 'event-legacy')?.definitionRevision).toEqual({ status: 'unresolved' })
    expect(page.items.find(item => item.eventId === 'event-room')?.text).toContain('Release İSTANBUL Friday')
    expect(snapshot).toEqual(before)
  })

  test('paginates strictly below the cursor sequence and rejects stale or invalid cursors without mutation', () => {
    const snapshot = state()
    const first = queryAgentMemory(snapshot, { agentId: aliceId, snapshotRevision: 17, limit: 2 })
    expect(first.items.map(item => item.sequence)).toEqual([6, 5])
    expect(first.nextCursor).toBeTypeOf('string')
    const second = queryAgentMemory(snapshot, { agentId: aliceId, snapshotRevision: 17, limit: 2, cursor: first.nextCursor })
    expect(second.items.map(item => item.sequence)).toEqual([4, 3])

    const rejected = [
      () => queryAgentMemory(snapshot, { agentId: aliceId, snapshotRevision: 17, limit: 2, cursor: 'not-json' }),
      () => queryAgentMemory(snapshot, { agentId: aliceId, snapshotRevision: 17, limit: 2, cursor: Buffer.from(JSON.stringify({ version: 2, agentId: aliceId, beforeSequence: 5, snapshotRevision: 17 })).toString('base64url') }),
      () => queryAgentMemory(snapshot, { agentId: bobId, snapshotRevision: 17, limit: 2, cursor: first.nextCursor }),
      () => queryAgentMemory(snapshot, { agentId: aliceId, snapshotRevision: 16, limit: 2 }),
      () => queryAgentMemory({ ...snapshot, revision: 18 }, { agentId: aliceId, snapshotRevision: 17, limit: 2, cursor: first.nextCursor }),
    ]
    for (const reject of rejected) expect(reject).toThrow()
    expect(() => rejected[3]!()).toThrow(expect.objectContaining({
      code: 'stale-revision', details: { expectedRevision: 16, actualRevision: 17 },
    }))
    expect(snapshot).toEqual(state())
  })

  test('supports every filter independently, inclusive ranges, Unicode case folding, and combinations', () => {
    const snapshot = state()
    const sequences = (query: Parameters<typeof queryAgentMemory>[1]) => queryAgentMemory(snapshot, query).items.map(item => item.sequence)
    const base = { agentId: aliceId, snapshotRevision: 17, limit: 20 } as const

    expect(sequences({ ...base, sourceKind: 'room' })).toEqual([5, 1])
    expect(sequences({ ...base, sourceId: roomId })).toEqual([5, 1])
    expect(sequences({ ...base, provenance: 'child-result' })).toEqual([4])
    expect(sequences({ ...base, eventTypes: ['task/completed'] })).toEqual([2])
    expect(sequences({ ...base, minimumSequence: 2, maximumSequence: 4 })).toEqual([4, 3, 2])
    expect(sequences({ ...base, text: 'i̇stanbul' })).toEqual([1])
    expect(sequences({ ...base, sourceKind: 'task', provenance: 'task', eventTypes: ['task/completed'] as readonly WorkspaceEventType[], minimumSequence: 2, maximumSequence: 2, text: 'alice' })).toEqual([2])
  })

  test('rejects missing agents and invalid query bounds', () => {
    const snapshot = state()
    expect(() => queryAgentMemory(snapshot, { agentId: AgentId('missing'), snapshotRevision: 17, limit: 1 })).toThrow(WorkspaceBusinessError)
    expect(() => queryAgentMemory(snapshot, { agentId: aliceId, snapshotRevision: 17, limit: 0 })).toThrow()
    expect(() => queryAgentMemory(snapshot, { agentId: aliceId, snapshotRevision: 17, limit: 1, minimumSequence: 3, maximumSequence: 2 })).toThrow()
  })

  test('resolves canonical assignment, grant, and child records without inventing historical revision attribution', () => {
    const initial = createInitialState(WorkspaceId('canonical'))
    const definition = mutateWorkspace(initial, { type: 'definition/create', name: 'Worker', description: 'work', instructions: 'ship' })
    const agent = mutateWorkspace(definition.state, { type: 'agent/create', definitionId: definition.definitionId, name: 'Alice' })
    const assignment = assignHumanTask(agent.state, {
      humanId: HumanId('owner'), assigneeAgentId: agent.agentId, title: 'Canonical task',
    })
    const grant = grantTaskDelegation(assignment.state, {
      humanId: HumanId('owner'), granteeAgentId: agent.agentId, rootTaskId: assignment.taskId,
    })
    const grantEvent = grant.state.events.at(-1)!
    const withGrantMemory = appendMemoryEntries(grant.state, [{
      agentId: agent.agentId, eventId: grantEvent.id, acquiredBy: 'task',
    }])
    const child = recordChildRunStarted(withGrantMemory, { parentAgentId: agent.agentId, taskId: assignment.taskId })
    const finished = recordChildRunFinished(child.state, {
      childRunId: child.childRunId, status: 'completed', result: 'Canonical child result',
    }).state

    const items = queryAgentMemory(finished, {
      agentId: agent.agentId, snapshotRevision: finished.revision, limit: 20,
    }).items
    expect(items.find(item => item.type === 'task/assigned')).toMatchObject({
      source: { kind: 'task', id: assignment.taskId, label: 'Canonical task' },
      subject: { id: assignment.taskAssignmentId, label: 'Canonical task' },
      definitionRevision: { status: 'unresolved' },
    })
    expect(items.find(item => item.type === 'task/delegation-granted')).toMatchObject({
      source: { kind: 'task', id: assignment.taskId, label: 'Canonical task' },
      subject: { id: grant.delegationGrantId, label: 'Canonical task' },
    })
    expect(items.find(item => item.type === 'child/run-finished')).toMatchObject({
      source: {
        kind: 'child', id: child.childRunId, label: 'Canonical child result',
        taskId: assignment.taskId, taskLabel: 'Canonical task',
      },
    })
  })
})
