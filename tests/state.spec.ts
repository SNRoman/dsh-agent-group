import { describe, expect, test } from 'vitest'
import { DefinitionRevisionId, HumanId, WorkspaceId } from '../packages/host/src/ids.ts'
import { workspaceStateSchema } from '../packages/host/src/spec.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import { assignHumanTask, grantTaskDelegation, recordChildRunStarted } from '../packages/host/src/tasks.ts'
import type { WorkspaceState } from '../packages/host/src/types.ts'

const javaEngineer = {
  name: 'Java engineer',
  description: 'Build Java services',
  instructions: 'Act as a Java engineer.',
}

function createDefinitionAndAgent(name = 'Alice') {
  const state = createInitialState(WorkspaceId('local'))
  const definition = mutateWorkspace(state, { type: 'definition/create', ...javaEngineer })
  return mutateWorkspace(definition.state, {
    type: 'agent/create',
    definitionId: definition.definitionId,
    name,
  })
}

function durableStateWithEveryRecord(): WorkspaceState {
  const alice = createDefinitionAndAgent()
  const room = mutateWorkspace(alice.state, { type: 'room/create', kind: 'group', name: 'Engineering' })
  const joined = mutateWorkspace(room.state, {
    type: 'room/join',
    roomId: room.roomId,
    agentId: alice.agentId,
    memoryStart: { type: 'new-events' },
  })
  const messaged = mutateWorkspace(joined.state, {
    type: 'room/message',
    roomId: room.roomId,
    actor: { type: 'human', id: HumanId('owner') },
    text: 'hello',
    mentions: [alice.agentId],
  })
  const assigned = assignHumanTask(messaged.state, {
    humanId: HumanId('owner'),
    assigneeAgentId: alice.agentId,
    title: 'task',
  })
  const granted = grantTaskDelegation(assigned.state, {
    humanId: HumanId('owner'),
    granteeAgentId: alice.agentId,
    rootTaskId: assigned.taskId,
  })
  return recordChildRunStarted(granted.state, {
    parentAgentId: alice.agentId,
    taskId: assigned.taskId,
  }).state
}

describe('WorkspaceState mutations', () => {
  test.each([
    ['workspace', (state: WorkspaceState) => ({ ...state, unknown: true })],
    ['definition', (state: WorkspaceState) => {
      const value = Object.values(state.definitions)[0]!
      return { ...state, definitions: { ...state.definitions, [value.id]: { ...value, unknown: true } } }
    }],
    ['definition revision', (state: WorkspaceState) => {
      const value = Object.values(state.definitionRevisions)[0]!
      return { ...state, definitionRevisions: { ...state.definitionRevisions, [value.id]: { ...value, unknown: true } } }
    }],
    ['agent', (state: WorkspaceState) => {
      const value = Object.values(state.agents)[0]!
      return { ...state, agents: { ...state.agents, [value.id]: { ...value, unknown: true } } }
    }],
    ['employment period', (state: WorkspaceState) => {
      const agent = Object.values(state.agents)[0]!
      const period = agent.employmentPeriods[0]!
      return { ...state, agents: { ...state.agents, [agent.id]: { ...agent, employmentPeriods: [{ ...period, unknown: true }] } } }
    }],
    ['room', (state: WorkspaceState) => {
      const value = Object.values(state.rooms)[0]!
      return { ...state, rooms: { ...state.rooms, [value.id]: { ...value, unknown: true } } }
    }],
    ['membership', (state: WorkspaceState) => {
      const value = Object.values(state.memberships)[0]!
      return { ...state, memberships: { ...state.memberships, [value.id]: { ...value, unknown: true } } }
    }],
    ['membership memory start', (state: WorkspaceState) => {
      const value = Object.values(state.memberships)[0]!
      return { ...state, memberships: { ...state.memberships, [value.id]: { ...value, memoryStart: { ...value.memoryStart, unknown: true } } } }
    }],
    ['event', (state: WorkspaceState) => ({ ...state, events: [{ ...state.events[0]!, unknown: true }, ...state.events.slice(1)] })],
    ['event actor', (state: WorkspaceState) => {
      const index = state.events.findIndex(event => event.actor !== undefined)
      const event = state.events[index]!
      return { ...state, events: state.events.with(index, { ...event, actor: { ...event.actor!, unknown: true } }) }
    }],
    ['memory entry', (state: WorkspaceState) => ({ ...state, memoryEntries: [{ ...state.memoryEntries[0]!, unknown: true }, ...state.memoryEntries.slice(1)] })],
    ['task', (state: WorkspaceState) => {
      const value = Object.values(state.tasks)[0]!
      return { ...state, tasks: { ...state.tasks, [value.id]: { ...value, unknown: true } } }
    }],
    ['task assignment', (state: WorkspaceState) => {
      const value = Object.values(state.taskAssignments)[0]!
      return { ...state, taskAssignments: { ...state.taskAssignments, [value.id]: { ...value, unknown: true } } }
    }],
    ['delegation grant', (state: WorkspaceState) => {
      const value = Object.values(state.delegationGrants)[0]!
      return { ...state, delegationGrants: { ...state.delegationGrants, [value.id]: { ...value, unknown: true } } }
    }],
    ['child run', (state: WorkspaceState) => {
      const value = Object.values(state.childRuns)[0]!
      return { ...state, childRuns: { ...state.childRuns, [value.id]: { ...value, unknown: true } } }
    }],
  ])('rejects an unknown field on the durable %s object', (_name, corrupt) => {
    expect(workspaceStateSchema.safeParse(corrupt(durableStateWithEveryRecord())).success).toBe(false)
  })

  test('rejects an event type the Host never appends', () => {
    const state = durableStateWithEveryRecord()
    expect(workspaceStateSchema.safeParse({
      ...state,
      events: [{ ...state.events[0], type: 'workspace/unknown' }, ...state.events.slice(1)],
    }).success).toBe(false)
  })

  test('re-employs the same departed agent without replacing its earlier events', () => {
    const alice = createDefinitionAndAgent()
    const priorEventIds = alice.state.events.map(event => event.id)

    const departed = mutateWorkspace(alice.state, { type: 'agent/depart', agentId: alice.agentId })
    const rehired = mutateWorkspace(departed.state, { type: 'agent/employ', agentId: alice.agentId })

    expect(rehired.state.agents[alice.agentId]?.employmentStatus).toBe('employed')
    expect(rehired.state.events.map(event => event.type)).toContain('agent/employed')
    expect(rehired.state.events.map(event => event.id)).toEqual(expect.arrayContaining(priorEventIds))
    expect(rehired.state.events.map(event => event.sequence)).toEqual([1, 2, 3, 4])
    expect(rehired.state.revision).toBe(4)
    expect(rehired.state.agents[alice.agentId]?.employmentPeriods).toHaveLength(2)
  })

  test('assigns a selected agent to a new definition revision without changing its memories', () => {
    const state = createInitialState(WorkspaceId('local'))
    const definition = mutateWorkspace(state, { type: 'definition/create', ...javaEngineer })
    const alice = mutateWorkspace(definition.state, {
      type: 'agent/create',
      definitionId: definition.definitionId,
      name: 'Alice',
    })
    const memoriesBeforeRevision = alice.state.memoryEntries

    const revised = mutateWorkspace(alice.state, {
      type: 'definition/revise',
      definitionId: definition.definitionId,
      description: 'Build Java services and libraries',
      instructions: 'Act as a senior Java engineer.',
      synchronizeAgentIds: [alice.agentId],
    })

    expect(revised.state.agents[alice.agentId]?.definitionRevisionId).toBe(revised.definitionRevisionId)
    expect(revised.state.memoryEntries).toEqual(memoriesBeforeRevision)
    expect(revised.state.events.at(-1)?.type).toBe('agent/definition-revision-assigned')
    expect(revised.state.events.at(-1)?.definitionRevisionId).toBe(revised.definitionRevisionId)

    const restored = mutateWorkspace(revised.state, {
      type: 'definition/synchronize',
      definitionId: definition.definitionId,
      definitionRevisionId: definition.definitionRevisionId,
      agentIds: [alice.agentId],
    })

    expect(restored.state.agents[alice.agentId]?.definitionRevisionId).toBe(definition.definitionRevisionId)
    expect(restored.state.events.at(-1)?.definitionRevisionId).toBe(definition.definitionRevisionId)
  })

  test('rejects agent names that collide case-insensitively within a workspace', () => {
    const alice = createDefinitionAndAgent('Alice')
    const definitionId = alice.state.agents[alice.agentId]?.definitionId
    if (definitionId === undefined) throw new Error('expected Alice to exist')

    expect(() => mutateWorkspace(alice.state, {
      type: 'agent/create',
      definitionId,
      name: 'alice',
    })).toThrow("agent name 'alice' is already used in workspace 'local'")
  })

  test('rejects room membership for a departed agent', () => {
    const alice = createDefinitionAndAgent()
    const room = mutateWorkspace(alice.state, { type: 'room/create', kind: 'group', name: 'Engineering' })
    const departed = mutateWorkspace(room.state, { type: 'agent/depart', agentId: alice.agentId })

    expect(() => mutateWorkspace(departed.state, {
      type: 'room/join',
      roomId: room.roomId,
      agentId: alice.agentId,
      memoryStart: { type: 'new-events' },
    })).toThrow(`agent '${alice.agentId}' is departed and cannot join room '${room.roomId}'`)
  })

  test('rejects overlapping memberships for one agent and room', () => {
    const alice = createDefinitionAndAgent()
    const room = mutateWorkspace(alice.state, { type: 'room/create', kind: 'group', name: 'Engineering' })
    const joined = mutateWorkspace(room.state, {
      type: 'room/join',
      roomId: room.roomId,
      agentId: alice.agentId,
      memoryStart: { type: 'new-events' },
    })

    expect(() => mutateWorkspace(joined.state, {
      type: 'room/join',
      roomId: room.roomId,
      agentId: alice.agentId,
      memoryStart: { type: 'new-events' },
    })).toThrow(`agent '${alice.agentId}' already has an active membership in room '${room.roomId}'`)
  })

  test('rejects messages that mention a departed agent', () => {
    const alice = createDefinitionAndAgent()
    const room = mutateWorkspace(alice.state, { type: 'room/create', kind: 'group', name: 'Engineering' })
    const departed = mutateWorkspace(room.state, { type: 'agent/depart', agentId: alice.agentId })

    expect(() => mutateWorkspace(departed.state, {
      type: 'room/message',
      roomId: room.roomId,
      actor: { type: 'human', id: HumanId('owner') },
      text: 'Please review this.',
      mentions: [alice.agentId],
    })).toThrow(`mentioned agent '${alice.agentId}' is departed`)
  })

  test('rejects synchronization to a revision outside the selected definition', () => {
    const alice = createDefinitionAndAgent()
    const definitionId = alice.state.agents[alice.agentId]?.definitionId
    if (definitionId === undefined) throw new Error('expected Alice to exist')

    expect(() => mutateWorkspace(alice.state, {
      type: 'definition/synchronize',
      definitionId,
      definitionRevisionId: DefinitionRevisionId('definition-revision-missing'),
      agentIds: [alice.agentId],
    })).toThrow(`definition revision 'definition-revision-missing' does not exist for definition '${definitionId}'`)
  })
})
