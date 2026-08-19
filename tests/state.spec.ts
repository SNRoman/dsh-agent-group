import { describe, expect, test } from 'vitest'
import { DefinitionRevisionId, HumanId, WorkspaceId } from '../packages/host/src/ids.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'

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

describe('WorkspaceState mutations', () => {
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
