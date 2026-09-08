import { describe, expect, test } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  AgentId,
  DefinitionRevisionId,
  DelegationGrantId,
  HumanId,
  MembershipId,
  RoomId,
  TaskId,
  WorkspaceEventId,
  WorkspaceId,
} from '../packages/host/src/ids.ts'
import { assertWorkspaceInvariants } from '../packages/host/src/invariant.ts'
import { workspaceStateSchema } from '../packages/host/src/spec.ts'
import { appendTaskCancelledEvent, appendTaskDelegationRevokedEvent, appendWorkspaceEvent, createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import {
  assignDelegatedTask,
  assignHumanTask,
  grantTaskDelegation,
  recordChildRunFinished,
  recordChildRunStarted,
} from '../packages/host/src/tasks.ts'
import type { WorkspaceState } from '../packages/host/src/types.ts'

function buildState(): WorkspaceState {
  let state = createInitialState(WorkspaceId('local'))
  const definition = mutateWorkspace(state, { type: 'definition/create', name: 'Worker', description: 'd', instructions: 'i' })
  state = definition.state
  const revised = mutateWorkspace(state, {
    type: 'definition/revise',
    definitionId: definition.definitionId,
    description: 'd2',
    instructions: 'i2',
  })
  state = revised.state
  const agent = mutateWorkspace(state, { type: 'agent/create', definitionId: definition.definitionId, name: 'Alice' })
  state = agent.state
  const room = mutateWorkspace(state, { type: 'room/create', kind: 'group', name: 'Engineering' })
  state = room.state
  state = mutateWorkspace(state, {
    type: 'room/join', roomId: room.roomId, agentId: agent.agentId, memoryStart: { type: 'new-events' },
  }).state
  const assigned = assignHumanTask(state, { humanId: HumanId('owner'), assigneeAgentId: agent.agentId, title: 'root task' })
  const granted = grantTaskDelegation(assigned.state, {
    humanId: HumanId('owner'), granteeAgentId: agent.agentId, rootTaskId: assigned.taskId,
  })
  const delegated = assignDelegatedTask(granted.state, {
    actorAgentId: agent.agentId, assigneeAgentId: agent.agentId, rootTaskId: assigned.taskId, title: 'derived task',
  })
  const started = recordChildRunStarted(delegated.state, { parentAgentId: agent.agentId, taskId: delegated.taskId })
  const finished = recordChildRunFinished(started.state, {
    childRunId: started.childRunId, status: 'completed', result: 'done',
  })
  return mutateWorkspace(finished.state, {
    type: 'runtime/session-bound', agentId: agent.agentId, sessionId: SessionId('session-1'),
  }).state
}

type Corruption = readonly [string, (state: WorkspaceState) => WorkspaceState, RegExp]

function withRawEvent(state: WorkspaceState, event: Readonly<Record<string, unknown>>): unknown {
  return {
    ...state,
    nextSequence: state.nextSequence + 1,
    events: [...state.events, { id: `event-${state.nextSequence}`, sequence: state.nextSequence, ...event }],
  }
}

function acceptsRawEvent(state: WorkspaceState, event: Readonly<Record<string, unknown>>): boolean {
  const parsed = workspaceStateSchema.safeParse(withRawEvent(state, event))
  if (!parsed.success) return false
  try {
    assertWorkspaceInvariants(parsed.data, state.workspaceId)
    return true
  } catch {
    return false
  }
}

function buildEmploymentHistory(departureCount: number): WorkspaceState {
  let state = createInitialState(WorkspaceId('local'))
  const definition = mutateWorkspace(state, { type: 'definition/create', name: 'Worker', description: 'd', instructions: 'i' })
  const agent = mutateWorkspace(definition.state, {
    type: 'agent/create', definitionId: definition.definitionId, name: 'Alice',
  })
  state = agent.state
  for (let index = 0; index < departureCount; index++) {
    state = mutateWorkspace(state, { type: 'agent/depart', agentId: agent.agentId }).state
    if (index + 1 < departureCount) {
      state = mutateWorkspace(state, { type: 'agent/employ', agentId: agent.agentId }).state
    }
  }
  return state
}

const relationshipCorruptions: readonly Corruption[] = [
  ['definition map key', state => {
    const value = Object.values(state.definitions)[0]!
    return { ...state, definitions: { wrong: value } } as WorkspaceState
  }, /definition map key/],
  ['definition revision map key', state => {
    const value = Object.values(state.definitionRevisions)[0]!
    return { ...state, definitionRevisions: { ...state.definitionRevisions, wrong: value } } as WorkspaceState
  }, /definition revision map key/],
  ['agent map key', state => {
    const value = Object.values(state.agents)[0]!
    return { ...state, agents: { wrong: value } } as WorkspaceState
  }, /agent map key/],
  ['room map key', state => {
    const value = Object.values(state.rooms)[0]!
    return { ...state, rooms: { wrong: value } } as WorkspaceState
  }, /room map key/],
  ['membership map key', state => {
    const value = Object.values(state.memberships)[0]!
    return { ...state, memberships: { wrong: value } } as WorkspaceState
  }, /membership map key/],
  ['task map key', state => {
    const value = Object.values(state.tasks)[0]!
    return { ...state, tasks: { ...state.tasks, wrong: value } } as WorkspaceState
  }, /task map key/],
  ['assignment map key', state => {
    const value = Object.values(state.taskAssignments)[0]!
    return { ...state, taskAssignments: { ...state.taskAssignments, wrong: value } } as WorkspaceState
  }, /task assignment map key/],
  ['grant map key', state => {
    const value = Object.values(state.delegationGrants)[0]!
    return { ...state, delegationGrants: { wrong: value } } as WorkspaceState
  }, /delegation grant map key/],
  ['child-run map key', state => {
    const value = Object.values(state.childRuns)[0]!
    return { ...state, childRuns: { wrong: value } } as WorkspaceState
  }, /child run map key/],
  ['definition revision ownership', state => {
    const revision = Object.values(state.definitionRevisions)[0]!
    return { ...state, definitionRevisions: { ...state.definitionRevisions, [revision.id]: { ...revision, definitionId: 'missing' } } } as WorkspaceState
  }, /belongs to definition/],
  ['definition current revision', state => {
    const definition = Object.values(state.definitions)[0]!
    return { ...state, definitions: { ...state.definitions, [definition.id]: { ...definition, currentRevisionId: DefinitionRevisionId('missing') } } }
  }, /current revision/],
  ['definition revision ordering', state => {
    const definition = Object.values(state.definitions)[0]!
    return { ...state, definitions: { ...state.definitions, [definition.id]: { ...definition, revisionIds: [...definition.revisionIds].reverse() } } }
  }, /revision number/],
  ['agent definition', state => {
    const agent = Object.values(state.agents)[0]!
    return { ...state, agents: { ...state.agents, [agent.id]: { ...agent, definitionId: 'missing' } } } as WorkspaceState
  }, /missing definition/],
  ['agent revision ownership', state => {
    const agent = Object.values(state.agents)[0]!
    return { ...state, agents: { ...state.agents, [agent.id]: { ...agent, definitionRevisionId: DefinitionRevisionId('missing') } } }
  }, /missing definition revision/],
  ['employment start event', state => {
    const agent = Object.values(state.agents)[0]!
    const period = agent.employmentPeriods[0]!
    return { ...state, agents: { ...state.agents, [agent.id]: { ...agent, employmentPeriods: [{ ...period, startedEventId: WorkspaceEventId('missing') }] } } }
  }, /employment period.*start event/],
  ['employment status', state => {
    const agent = Object.values(state.agents)[0]!
    return { ...state, agents: { ...state.agents, [agent.id]: { ...agent, employmentStatus: 'departed' } } }
  }, /employment status/],
  ['membership room', state => {
    const membership = Object.values(state.memberships)[0]!
    return { ...state, memberships: { ...state.memberships, [membership.id]: { ...membership, roomId: RoomId('missing') } } }
  }, /missing room/],
  ['membership agent', state => {
    const membership = Object.values(state.memberships)[0]!
    return { ...state, memberships: { ...state.memberships, [membership.id]: { ...membership, agentId: AgentId('missing') } } }
  }, /missing agent/],
  ['membership join event', state => {
    const membership = Object.values(state.memberships)[0]!
    return { ...state, memberships: { ...state.memberships, [membership.id]: { ...membership, joinedEventId: WorkspaceEventId('missing') } } }
  }, /membership.*join event/],
  ['event id uniqueness', state => ({ ...state, events: [...state.events, state.events[0]!] }), /duplicate event id/],
  ['event sequence uniqueness', state => ({ ...state, events: state.events.map((event, index) => index === 0 ? { ...event, sequence: 2 } : event) }), /event id|event sequence/],
  ['memory id uniqueness', state => ({ ...state, memoryEntries: [...state.memoryEntries, state.memoryEntries[0]!] }), /duplicate memory entry id/],
  ['memory association uniqueness', state => {
    const entry = state.memoryEntries[0]!
    return { ...state, memoryEntries: [...state.memoryEntries, { ...entry, id: 'memory-999' }] } as WorkspaceState
  }, /duplicate memory association/],
  ['task root', state => {
    const task = Object.values(state.tasks).find(candidate => candidate.id !== candidate.rootTaskId)!
    return { ...state, tasks: { ...state.tasks, [task.id]: { ...task, rootTaskId: TaskId('missing') } } }
  }, /missing root task/],
  ['assignment root', state => {
    const assignment = Object.values(state.taskAssignments).find(candidate => candidate.grantId !== undefined)!
    return { ...state, taskAssignments: { ...state.taskAssignments, [assignment.id]: { ...assignment, rootTaskId: assignment.taskId } } }
  }, /root task.*does not match/],
  ['assignment grant', state => {
    const assignment = Object.values(state.taskAssignments).find(candidate => candidate.grantId !== undefined)!
    return { ...state, taskAssignments: { ...state.taskAssignments, [assignment.id]: { ...assignment, grantId: 'missing' } } } as WorkspaceState
  }, /missing delegation grant/],
  ['grant grantee', state => {
    const grant = Object.values(state.delegationGrants)[0]!
    return { ...state, delegationGrants: { ...state.delegationGrants, [grant.id]: { ...grant, granteeAgentId: AgentId('missing') } } }
  }, /missing grantee/],
  ['child parent', state => {
    const run = Object.values(state.childRuns)[0]!
    return { ...state, childRuns: { ...state.childRuns, [run.id]: { ...run, parentAgentId: AgentId('missing') } } }
  }, /missing parent/],
  ['child finish event', state => {
    const run = Object.values(state.childRuns)[0]!
    return { ...state, events: state.events.filter(event => event.type !== 'child/run-finished' || event.subjectId !== run.id) }
  }, /terminal child run.*finish event/],
  ['session binding agent', state => ({ ...state, sessionBindings: { missing: SessionId('session-1') } }) as WorkspaceState, /session binding.*missing agent/],
  ['next id counter', state => ({ ...state, nextId: state.nextId - 1 }), /nextId/],
  ['next sequence counter', state => ({ ...state, nextSequence: state.nextSequence - 1 }), /nextSequence/],
]

describe('assertWorkspaceInvariants', () => {
  test('parses every strict v0.2 task event variant', () => {
    const initial = buildState()
    const state = { ...initial, nextId: initial.nextId + 1 }
    const task = Object.values(state.tasks)[0]!
    const grant = Object.values(state.delegationGrants)[0]!
    const revision = Object.values(state.definitionRevisions)[0]!
    const delivery = {
      taskId: task.id,
      taskDeliveryAttemptId: `task-delivery-attempt-${initial.nextId}`,
      messageId: 'message-900',
    }
    const events = [
      { type: 'task/delivery-started', ...delivery },
      { type: 'task/delivery-accepted', ...delivery },
      { type: 'task/delivery-failed', ...delivery, failureCode: 'delivery-rejected', failureSummary: 'Inbox rejected the message.' },
      { type: 'task/result', taskId: task.id, taskDeliveryAttemptId: delivery.taskDeliveryAttemptId, definitionRevisionId: revision.id, text: 'done' },
      { type: 'task/result-after-cancel', taskId: task.id, taskDeliveryAttemptId: delivery.taskDeliveryAttemptId, definitionRevisionId: revision.id, text: 'late result' },
    ]
    for (const event of events) {
      expect(acceptsRawEvent(state, event), event.type).toBe(true)
    }
    const expiredGrant = {
      ...state,
      delegationGrants: { ...state.delegationGrants, [grant.id]: { ...grant, status: 'expired' as const } },
    }
    expect(acceptsRawEvent(expiredGrant, {
      type: 'task/delegation-revoked', subjectId: grant.id, actor: { type: 'human', id: HumanId('owner') },
    })).toBe(true)
    const derived = Object.values(state.tasks).find(candidate => candidate.id !== candidate.rootTaskId)!
    const cancelledTask = {
      ...state,
      tasks: { ...state.tasks, [derived.id]: { ...derived, status: 'cancelled' as const } },
    }
    expect(acceptsRawEvent(cancelledTask, {
      type: 'task/cancelled', subjectId: derived.id, actor: { type: 'human', id: HumanId('owner') },
    })).toBe(true)
  })

  test.each([
    ['delivery without message id', { type: 'task/delivery-started', taskId: 'task-1', taskDeliveryAttemptId: 'attempt-1' }],
    ['failure without safe fields', { type: 'task/delivery-failed', taskId: 'task-1', taskDeliveryAttemptId: 'attempt-1', messageId: 'message-1' }],
    ['failure with a blank code', { type: 'task/delivery-failed', taskId: 'task-1', taskDeliveryAttemptId: 'attempt-1', messageId: 'message-1', failureCode: '  ', failureSummary: 'safe' }],
    ['failure with a blank summary', { type: 'task/delivery-failed', taskId: 'task-1', taskDeliveryAttemptId: 'attempt-1', messageId: 'message-1', failureCode: 'safe', failureSummary: '\t' }],
    ['accepted delivery with failure fields', { type: 'task/delivery-accepted', taskId: 'task-1', taskDeliveryAttemptId: 'attempt-1', messageId: 'message-1', failureCode: 'unexpected', failureSummary: 'unexpected' }],
    ['result without definition revision', { type: 'task/result', taskId: 'task-1', taskDeliveryAttemptId: 'attempt-1', text: 'done' }],
    ['cancellation with a grant subject', { type: 'task/cancelled', subjectId: 'grant-1' }],
    ['revocation with a task subject', { type: 'task/delegation-revoked', subjectId: 'task-1' }],
  ])('rejects %s', (_name, event) => {
    expect(acceptsRawEvent(buildState(), event)).toBe(false)
  })

  test('rejects nextId that can reuse a durable task delivery attempt id', () => {
    const state = buildState()
    const task = Object.values(state.tasks)[0]!
    const raw = withRawEvent(state, {
      type: 'task/delivery-started',
      taskId: task.id,
      taskDeliveryAttemptId: `task-delivery-attempt-${state.nextId}`,
      messageId: 'message-next-id',
    })
    const parsed = workspaceStateSchema.parse(raw)
    expect(() => assertWorkspaceInvariants(parsed, state.workspaceId)).toThrow(/nextId/)
  })

  test('rejects a task result attributed to another definition', () => {
    const state = buildState()
    const task = Object.values(state.tasks)[0]!
    const other = mutateWorkspace(state, {
      type: 'definition/create', name: 'Other role', description: 'other', instructions: 'other',
    })
    const raw = withRawEvent(other.state, {
      type: 'task/result',
      taskId: task.id,
      taskDeliveryAttemptId: 'task-delivery-attempt-1',
      definitionRevisionId: other.definitionRevisionId,
      text: 'misattributed result',
    })
    const parsed = workspaceStateSchema.parse(raw)
    expect(() => assertWorkspaceInvariants(parsed, state.workspaceId)).toThrow(/does not belong to its task assignee/)
  })

  test('accepts version-0 grants held by an agent other than the root assignee', () => {
    const state = buildState()
    const definition = Object.values(state.definitions)[0]!
    const bob = mutateWorkspace(state, { type: 'agent/create', definitionId: definition.id, name: 'Bob' })
    const grant = Object.values(bob.state.delegationGrants)[0]!
    const delegated = Object.values(bob.state.taskAssignments).find(assignment => assignment.grantId === grant.id)!
    const delegatedEvent = bob.state.events.find(event => event.type === 'task/delegated' && event.subjectId === delegated.id)!
    const legacy = {
      ...bob.state,
      delegationGrants: { ...bob.state.delegationGrants, [grant.id]: { ...grant, granteeAgentId: bob.agentId } },
      events: bob.state.events.map(event => event.id === delegatedEvent.id
        ? { ...event, actor: { type: 'agent' as const, id: bob.agentId } }
        : event),
    }
    expect(() => assertWorkspaceInvariants(legacy, WorkspaceId('local'))).not.toThrow()
  })

  test('accepts version-0 duplicate active grants for one root assignee', () => {
    const state = buildState()
    const grant = Object.values(state.delegationGrants)[0]!
    const duplicateId = DelegationGrantId(`delegation-grant-${state.nextId}`)
    const legacy = {
      ...state,
      nextId: state.nextId + 1,
      delegationGrants: { ...state.delegationGrants, [duplicateId]: { ...grant, id: duplicateId } },
    }
    expect(() => assertWorkspaceInvariants(legacy, WorkspaceId('local'))).not.toThrow()
  })

  test('accepts version-0 child runs whose parent is not the task assignee', () => {
    const state = buildState()
    const definition = Object.values(state.definitions)[0]!
    const bob = mutateWorkspace(state, { type: 'agent/create', definitionId: definition.id, name: 'Bob' })
    const child = Object.values(bob.state.childRuns)[0]!
    const legacy = {
      ...bob.state,
      childRuns: { ...bob.state.childRuns, [child.id]: { ...child, parentAgentId: bob.agentId } },
    }
    expect(() => assertWorkspaceInvariants(legacy, WorkspaceId('local'))).not.toThrow()
  })

  test('accepts version-0 cancelled tasks without cancellation events', () => {
    const state = buildState()
    const task = Object.values(state.tasks).find(candidate => candidate.id !== candidate.rootTaskId)!
    const legacy = {
      ...state,
      tasks: { ...state.tasks, [task.id]: { ...task, status: 'cancelled' as const } },
    }
    expect(() => assertWorkspaceInvariants(legacy, WorkspaceId('local'))).not.toThrow()
  })

  test('rejects revocation events with a non-human actor, active record, or duplicate subject', () => {
    const state = buildState()
    const grant = Object.values(state.delegationGrants)[0]!
    const agent = Object.values(state.agents)[0]!
    const expired = {
      ...state,
      delegationGrants: { ...state.delegationGrants, [grant.id]: { ...grant, status: 'expired' as const } },
    }
    expect(acceptsRawEvent(expired, {
      type: 'task/delegation-revoked', subjectId: grant.id, actor: { type: 'agent', id: agent.id },
    })).toBe(false)
    expect(acceptsRawEvent(state, {
      type: 'task/delegation-revoked', subjectId: grant.id, actor: { type: 'human', id: HumanId('owner') },
    })).toBe(false)
    let revoked = expired
    ;[revoked] = appendTaskDelegationRevokedEvent(revoked, grant.id, HumanId('owner'))
    expect(acceptsRawEvent(revoked, {
      type: 'task/delegation-revoked', subjectId: grant.id, actor: { type: 'human', id: HumanId('owner') },
    })).toBe(false)
  })

  test('rejects cancellation events with a non-human actor, open record, or duplicate subject', () => {
    const state = buildState()
    const task = Object.values(state.tasks).find(candidate => candidate.id !== candidate.rootTaskId)!
    const agent = Object.values(state.agents)[0]!
    const cancelled = {
      ...state,
      tasks: { ...state.tasks, [task.id]: { ...task, status: 'cancelled' as const } },
    }
    expect(acceptsRawEvent(cancelled, {
      type: 'task/cancelled', subjectId: task.id, actor: { type: 'agent', id: agent.id },
    })).toBe(false)
    expect(acceptsRawEvent(state, {
      type: 'task/cancelled', subjectId: task.id, actor: { type: 'human', id: HumanId('owner') },
    })).toBe(false)
    let withCancellation = cancelled
    ;[withCancellation] = appendTaskCancelledEvent(withCancellation, task.id, HumanId('owner'))
    expect(acceptsRawEvent(withCancellation, {
      type: 'task/cancelled', subjectId: task.id, actor: { type: 'human', id: HumanId('owner') },
    })).toBe(false)
  })

  test('accepts a valid complete aggregate for its table key', () => {
    expect(() => assertWorkspaceInvariants(buildState(), WorkspaceId('local'))).not.toThrow()
  })

  test('rejects an aggregate stored under another workspace id', () => {
    expect(() => assertWorkspaceInvariants(buildState(), WorkspaceId('other'))).toThrow(/workspace id.*table key/)
  })

  test.each(relationshipCorruptions)('rejects broken %s ownership', (_name, corrupt, expected) => {
    expect(() => assertWorkspaceInvariants(corrupt(buildState()), WorkspaceId('local'))).toThrow(expected)
  })

  test('accepts strictly ordered consecutive employment periods', () => {
    expect(() => assertWorkspaceInvariants(buildEmploymentHistory(3), WorkspaceId('local'))).not.toThrow()
  })

  test('rejects employment periods that reuse one departure event', () => {
    const state = buildEmploymentHistory(3)
    const agent = Object.values(state.agents)[0]!
    const [first, second, third] = agent.employmentPeriods
    const corrupt: WorkspaceState = {
      ...state,
      agents: {
        ...state.agents,
        [agent.id]: {
          ...agent,
          employmentPeriods: [
            { ...first!, endedEventId: second!.endedEventId },
            second!,
            third!,
          ],
        },
      },
    }
    expect(() => assertWorkspaceInvariants(corrupt, WorkspaceId('local'))).toThrow(/departure event.*more than one employment period/)
  })

  test('rejects employment periods stored out of chronological order', () => {
    const state = buildEmploymentHistory(3)
    const agent = Object.values(state.agents)[0]!
    const [first, second, third] = agent.employmentPeriods
    const corrupt: WorkspaceState = {
      ...state,
      agents: {
        ...state.agents,
        [agent.id]: { ...agent, employmentPeriods: [first!, third!, second!] },
      },
    }
    expect(() => assertWorkspaceInvariants(corrupt, WorkspaceId('local'))).toThrow(/employment periods.*chronological order/)
  })

  test('rejects employment periods that overlap', () => {
    const state = buildEmploymentHistory(2)
    const agent = Object.values(state.agents)[0]!
    const [withExtraDeparture, extraDeparture] = appendWorkspaceEvent(state, 'agent/departed', agent.id)
    const [first, second] = agent.employmentPeriods
    const corrupt: WorkspaceState = {
      ...withExtraDeparture,
      agents: {
        ...withExtraDeparture.agents,
        [agent.id]: {
          ...agent,
          employmentPeriods: [{ ...first!, endedEventId: extraDeparture.id }, second!],
        },
      },
    }
    expect(() => assertWorkspaceInvariants(corrupt, WorkspaceId('local'))).toThrow(/employment periods.*overlap/)
  })

  test('rejects a departure event from another agent as a membership leave event', () => {
    let state = createInitialState(WorkspaceId('local'))
    const definition = mutateWorkspace(state, { type: 'definition/create', name: 'Worker', description: 'd', instructions: 'i' })
    const alice = mutateWorkspace(definition.state, { type: 'agent/create', definitionId: definition.definitionId, name: 'Alice' })
    const bob = mutateWorkspace(alice.state, { type: 'agent/create', definitionId: definition.definitionId, name: 'Bob' })
    const room = mutateWorkspace(bob.state, { type: 'room/create', kind: 'group', name: 'room' })
    const joinedAlice = mutateWorkspace(room.state, {
      type: 'room/join', roomId: room.roomId, agentId: alice.agentId, memoryStart: { type: 'new-events' },
    })
    const joinedBob = mutateWorkspace(joinedAlice.state, {
      type: 'room/join', roomId: room.roomId, agentId: bob.agentId, memoryStart: { type: 'new-events' },
    })
    const departedAlice = mutateWorkspace(joinedBob.state, { type: 'agent/depart', agentId: alice.agentId })
    const departedBob = mutateWorkspace(departedAlice.state, { type: 'agent/depart', agentId: bob.agentId })
    const aliceMembership = Object.values(departedBob.state.memberships)
      .find(membership => membership.agentId === alice.agentId)!
    const bobMembership = Object.values(departedBob.state.memberships)
      .find(membership => membership.agentId === bob.agentId)!
    const corrupt: WorkspaceState = {
      ...departedBob.state,
      memberships: {
        ...departedBob.state.memberships,
        [aliceMembership.id]: { ...aliceMembership, leftEventId: bobMembership.leftEventId },
      },
    }
    expect(() => assertWorkspaceInvariants(corrupt, WorkspaceId('local'))).toThrow(/departure event.*another agent/)
  })

  test('accepts a membership closed by a room leave event', () => {
    const state = buildState()
    const membership = Object.values(state.memberships)[0]!
    const left = mutateWorkspace(state, { type: 'room/leave', membershipId: membership.id })
    expect(() => assertWorkspaceInvariants(left.state, WorkspaceId('local'))).not.toThrow()
  })

  test('rejects a membership closed by a later employment period departure', () => {
    let state = createInitialState(WorkspaceId('local'))
    const definition = mutateWorkspace(state, { type: 'definition/create', name: 'Worker', description: 'd', instructions: 'i' })
    const agent = mutateWorkspace(definition.state, {
      type: 'agent/create', definitionId: definition.definitionId, name: 'Alice',
    })
    const room = mutateWorkspace(agent.state, { type: 'room/create', kind: 'group', name: 'room' })
    const firstJoin = mutateWorkspace(room.state, {
      type: 'room/join', roomId: room.roomId, agentId: agent.agentId, memoryStart: { type: 'new-events' },
    })
    const firstMembership = Object.values(firstJoin.state.memberships)[0]!
    const firstDeparture = mutateWorkspace(firstJoin.state, { type: 'agent/depart', agentId: agent.agentId })
    const reemployed = mutateWorkspace(firstDeparture.state, { type: 'agent/employ', agentId: agent.agentId })
    const secondJoin = mutateWorkspace(reemployed.state, {
      type: 'room/join', roomId: room.roomId, agentId: agent.agentId, memoryStart: { type: 'new-events' },
    })
    const secondDeparture = mutateWorkspace(secondJoin.state, { type: 'agent/depart', agentId: agent.agentId })
    assertWorkspaceInvariants(secondDeparture.state, WorkspaceId('local'))
    const memberships = Object.values(secondDeparture.state.memberships)
    const secondMembership = memberships.find(membership => membership.id !== firstMembership.id)!
    const corrupt: WorkspaceState = {
      ...secondDeparture.state,
      memberships: {
        ...secondDeparture.state.memberships,
        [firstMembership.id]: { ...firstMembership, leftEventId: secondMembership.leftEventId },
      },
    }
    expect(() => assertWorkspaceInvariants(corrupt, WorkspaceId('local'))).toThrow(/membership.*employment period.*departure/)
  })

  test('rejects an event id whose suffix does not equal its sequence', () => {
    const state = buildState()
    const event = state.events[0]!
    const corrupt: WorkspaceState = {
      ...state,
      events: [{ ...event, id: WorkspaceEventId('event-999') }, ...state.events.slice(1)],
    }
    expect(() => assertWorkspaceInvariants(corrupt, WorkspaceId('local'))).toThrow(/event id.*sequence/)
  })

  test('rejects a delegated-task event whose actor does not own its grant', () => {
    const state = buildState()
    const definition = Object.values(state.definitions)[0]!
    const bob = mutateWorkspace(state, { type: 'agent/create', definitionId: definition.id, name: 'Bob' })
    const index = bob.state.events.findIndex(event => event.type === 'task/delegated')
    const event = bob.state.events[index]!
    const corrupt: WorkspaceState = {
      ...bob.state,
      events: bob.state.events.with(index, { ...event, actor: { type: 'agent', id: bob.agentId } }),
    }
    expect(() => assertWorkspaceInvariants(corrupt, WorkspaceId('local'))).toThrow(/delegated task.*grant grantee/)
  })

  test('rejects a child finish event ordered before its start event', () => {
    const state = buildState()
    const startIndex = state.events.findIndex(event => event.type === 'child/run-started')
    const finishIndex = state.events.findIndex(event => event.type === 'child/run-finished')
    const start = state.events[startIndex]!
    const finish = state.events[finishIndex]!
    const corrupt: WorkspaceState = {
      ...state,
      events: state.events
        .with(startIndex, { ...finish, id: start.id, sequence: start.sequence })
        .with(finishIndex, { ...start, id: finish.id, sequence: finish.sequence }),
    }
    expect(() => assertWorkspaceInvariants(corrupt, WorkspaceId('local'))).toThrow(/finish event.*after.*start event/)
  })

  test('rejects more than one active membership in a direct room', () => {
    const state = buildState()
    const room = Object.values(state.rooms)[0]!
    const membership = Object.values(state.memberships)[0]!
    const duplicate = { ...membership, id: MembershipId('membership-999') }
    const corrupt: WorkspaceState = {
      ...state,
      rooms: { ...state.rooms, [room.id]: { ...room, kind: 'direct' } },
      memberships: { ...state.memberships, [duplicate.id]: duplicate },
      nextId: 1000,
    }
    expect(() => assertWorkspaceInvariants(corrupt, WorkspaceId('local'))).toThrow(/direct room.*active member/)
  })

  test('rejects a memory entry referencing a missing event independently of its agent', () => {
    const state = buildState()
    const entry = state.memoryEntries[0]!
    const corrupt = { ...state, memoryEntries: [{ ...entry, eventId: WorkspaceEventId('missing') }, ...state.memoryEntries.slice(1)] }
    expect(() => assertWorkspaceInvariants(corrupt, WorkspaceId('local'))).toThrow(/memory entry.*missing event/)
  })

  test('rejects an active grant referencing a non-open root task', () => {
    const state = buildState()
    const grant = Object.values(state.delegationGrants)[0]!
    const task = state.tasks[grant.rootTaskId]!
    const corrupt = { ...state, tasks: { ...state.tasks, [task.id]: { ...task, status: 'completed' as const } } }
    expect(() => assertWorkspaceInvariants(corrupt, WorkspaceId('local'))).toThrow(/non-open root task/)
  })

  test('rejects a child run referencing a missing task independently of its parent', () => {
    const state = buildState()
    const run = Object.values(state.childRuns)[0]!
    const corrupt: WorkspaceState = { ...state, childRuns: { [run.id]: { ...run, taskId: TaskId('missing') } } }
    expect(() => assertWorkspaceInvariants(corrupt, WorkspaceId('local'))).toThrow(/child run.*missing task/)
  })

  test('rejects an event subject that does not exist for its event type', () => {
    const state = buildState()
    const index = state.events.findIndex(event => event.type === 'room/created')
    const corrupt = { ...state, events: state.events.with(index, { ...state.events[index]!, subjectId: RoomId('missing') }) }
    expect(() => assertWorkspaceInvariants(corrupt, WorkspaceId('local'))).toThrow(/room\/created.*missing room/)
  })

  test('rejects an active membership owned by a departed agent', () => {
    const state = buildState()
    const agent = Object.values(state.agents)[0]!
    const corrupt = { ...state, agents: { ...state.agents, [agent.id]: { ...agent, employmentStatus: 'departed' as const } } }
    expect(() => assertWorkspaceInvariants(corrupt, WorkspaceId('local'))).toThrow(/employment status|active membership/)
  })

  test('rejects a child run whose terminal status disagrees with its finish event', () => {
    const state = buildState()
    const index = state.events.findIndex(event => event.type === 'child/run-finished')
    const event = state.events[index]!
    const corrupt: WorkspaceState = {
      ...state,
      events: state.events.with(index, { ...event, type: 'child/run-finished', childRunStatus: 'failed' }),
    }
    expect(() => assertWorkspaceInvariants(corrupt, WorkspaceId('local'))).toThrow(/terminal status/)
  })
})
