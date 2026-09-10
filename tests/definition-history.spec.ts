import { describe, expect, test } from 'vitest'
import { AgentId, WorkspaceId } from '../packages/host/src/ids.ts'
import { projectDefinitionHistory } from '../packages/host/src/definition-history.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'

describe('definition revision history', () => {
  test('projects exact creation events, revision order, status, and current pins without mutating input', () => {
    const initial = createInitialState(WorkspaceId('local'))
    const created = mutateWorkspace(initial, {
      type: 'definition/create', name: 'Engineer', description: 'v1', instructions: 'one',
    })
    const alice = mutateWorkspace(created.state, {
      type: 'agent/create', definitionId: created.definitionId, name: 'Alice',
    })
    const revised = mutateWorkspace(alice.state, {
      type: 'definition/revise', definitionId: created.definitionId, description: 'v2', instructions: 'two',
      synchronizeAgentIds: [alice.agentId],
    })
    const frozen = structuredClone(revised.state)

    expect(projectDefinitionHistory(revised.state, created.definitionId)).toEqual([
      expect.objectContaining({
        id: created.definitionRevisionId,
        number: 1,
        status: 'previous',
        creationEvent: { status: 'exact', sequence: 1 },
        agentIds: [],
      }),
      expect.objectContaining({
        id: revised.definitionRevisionId,
        number: 2,
        status: 'current',
        creationEvent: { status: 'exact', sequence: 3 },
        agentIds: [alice.agentId],
      }),
    ])
    expect(revised.state).toEqual(frozen)
  })

  test('derives authentic 0.1.x event associations by position and leaves an unprovable association unresolved', () => {
    const created = mutateWorkspace(createInitialState(WorkspaceId('local')), {
      type: 'definition/create', name: 'Engineer', description: 'v1', instructions: 'one',
    })
    const revised = mutateWorkspace(created.state, {
      type: 'definition/revise', definitionId: created.definitionId, description: 'v2', instructions: 'two',
    })
    const legacy = {
      ...revised.state,
      events: revised.state.events.map(event => (
        event.type === 'definition/created' || event.type === 'definition/revised'
          ? { ...event, definitionRevisionId: undefined }
          : event
      )),
    }
    expect(projectDefinitionHistory(legacy, created.definitionId).map(item => item.creationEvent)).toEqual([
      { status: 'derived', sequence: 1 },
      { status: 'derived', sequence: 2 },
    ])

    const ambiguous = { ...legacy, events: legacy.events.slice(1) }
    expect(projectDefinitionHistory(ambiguous, created.definitionId).map(item => item.creationEvent)).toEqual([
      { status: 'unresolved' },
      { status: 'unresolved' },
    ])
  })

  test('sorts pins deterministically even when the aggregate record order differs', () => {
    const created = mutateWorkspace(createInitialState(WorkspaceId('local')), {
      type: 'definition/create', name: 'Engineer', description: 'v1', instructions: 'one',
    })
    const bob = mutateWorkspace(created.state, { type: 'agent/create', definitionId: created.definitionId, name: 'Bob' })
    const alice = mutateWorkspace(bob.state, { type: 'agent/create', definitionId: created.definitionId, name: 'Alice' })
    expect(projectDefinitionHistory(alice.state, created.definitionId)[0]?.agentIds).toEqual([
      AgentId(String(bob.agentId)), AgentId(String(alice.agentId)),
    ])
  })
})
