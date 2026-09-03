import { describe, expect, test } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  AgentId,
  DefinitionRevisionId,
  HumanId,
  MembershipId,
  RoomId,
  TaskId,
  WorkspaceEventId,
  WorkspaceId,
} from '../packages/host/src/ids.ts'
import { assertWorkspaceInvariants } from '../packages/host/src/invariant.ts'
import { appendWorkspaceEvent, createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
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
