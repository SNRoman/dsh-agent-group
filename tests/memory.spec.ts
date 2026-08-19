import { describe, expect, test } from 'vitest'
import {
  AgentId,
  AgentMemoryEntryId,
  HumanId,
  RoomId,
  WorkspaceEventId,
  WorkspaceId,
} from '../packages/host/src/ids.ts'
import {
  MemoryReader,
  appendRoomMessage,
  joinRoomWithMemory,
  recallAgentEvents,
} from '../packages/host/src/memory.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import type { WorkspaceState } from '../packages/host/src/types.ts'

const javaEngineer = {
  name: 'Java engineer',
  description: 'Build Java services',
  instructions: 'Act as a Java engineer.',
}

function createWorkspace(): { readonly state: WorkspaceState; readonly aliceId: AgentId; readonly bobId: AgentId } {
  const initial = createInitialState(WorkspaceId('local'))
  const definition = mutateWorkspace(initial, { type: 'definition/create', ...javaEngineer })
  const alice = mutateWorkspace(definition.state, {
    type: 'agent/create',
    definitionId: definition.definitionId,
    name: 'Alice',
  })
  const bob = mutateWorkspace(alice.state, {
    type: 'agent/create',
    definitionId: definition.definitionId,
    name: 'Bob',
  })
  return { state: bob.state, aliceId: alice.agentId, bobId: bob.agentId }
}

function join(state: WorkspaceState, roomId: RoomId, agentId: AgentId): WorkspaceState {
  return joinRoomWithMemory(state, { type: 'room/join', roomId, agentId, memoryStart: { type: 'new-events' } }).state
}

function memoryEventIds(state: WorkspaceState, agentId: AgentId): readonly WorkspaceEventId[] {
  return state.memoryEntries.filter(entry => entry.agentId === agentId).map(entry => entry.eventId)
}

describe('unified event memory', () => {
  test('records one room event for every current member but wakes only explicit mentions', () => {
    const workspace = createWorkspace()
    const room = mutateWorkspace(workspace.state, { type: 'room/create', kind: 'group', name: 'Engineering' })
    const joinedAlice = join(room.state, room.roomId, workspace.aliceId)
    const joinedBoth = join(joinedAlice, room.roomId, workspace.bobId)

    const result = appendRoomMessage(joinedBoth, {
      roomId: room.roomId,
      actor: { type: 'human', id: HumanId('owner') },
      text: 'Release on Friday',
      mentions: [workspace.aliceId],
    })

    expect(result.state.events.filter(event => event.id === result.eventId)).toHaveLength(1)
    expect(memoryEventIds(result.state, workspace.aliceId)).toContain(result.eventId)
    expect(memoryEventIds(result.state, workspace.bobId)).toContain(result.eventId)
    expect(result.wakeAgentIds).toEqual([workspace.aliceId])
  })

  test('keeps a new-events-only join empty and synchronizes only the selected inclusive room history', () => {
    const workspace = createWorkspace()
    const room = mutateWorkspace(workspace.state, { type: 'room/create', kind: 'group', name: 'Engineering' })
    const earlier = appendRoomMessage(room.state, {
      roomId: room.roomId,
      actor: { type: 'human', id: HumanId('owner') },
      text: 'Earlier planning note',
      mentions: [],
    })
    const later = appendRoomMessage(earlier.state, {
      roomId: room.roomId,
      actor: { type: 'human', id: HumanId('owner') },
      text: 'Later planning note',
      mentions: [],
    })
    const earlierEvent = earlier.state.events.find(event => event.id === earlier.eventId)
    if (earlierEvent === undefined) throw new Error('expected earlier room event')

    const newEventsOnly = joinRoomWithMemory(later.state, {
      type: 'room/join',
      roomId: room.roomId,
      agentId: workspace.aliceId,
      memoryStart: { type: 'new-events' },
    })
    expect(memoryEventIds(newEventsOnly.state, workspace.aliceId)).toEqual([])

    const historical = joinRoomWithMemory(later.state, {
      type: 'room/join',
      roomId: room.roomId,
      agentId: workspace.bobId,
      memoryStart: { type: 'event-range', startSequence: earlierEvent.sequence, endSequence: earlierEvent.sequence },
    })

    expect(memoryEventIds(historical.state, workspace.bobId)).toEqual([earlier.eventId])
    expect(historical.state.memoryEntries[0]?.acquiredBy).toBe('history-sync')
    expect(historical.state.events.find(event => event.id === earlier.eventId)).toBe(earlierEvent)
  })

  test('recalls current-room events before case-insensitive matches and other personal events across every acquisition source', () => {
    const workspace = createWorkspace()
    const group = mutateWorkspace(workspace.state, { type: 'room/create', kind: 'group', name: 'Engineering' })
    const groupJoined = join(group.state, group.roomId, workspace.aliceId)
    const current = appendRoomMessage(groupJoined, {
      roomId: group.roomId,
      actor: { type: 'human', id: HumanId('owner') },
      text: 'Current room status',
      mentions: [],
    })
    const direct = mutateWorkspace(current.state, { type: 'room/create', kind: 'direct' })
    const directJoined = join(direct.state, direct.roomId, workspace.aliceId)
    const directMessage = appendRoomMessage(directJoined, {
      roomId: direct.roomId,
      actor: { type: 'human', id: HumanId('owner') },
      text: 'BUDGET approved in direct message',
      mentions: [],
    })
    const taskEventId = WorkspaceEventId('event-task-result')
    const childEventId = WorkspaceEventId('event-child-result')
    const state: WorkspaceState = {
      ...directMessage.state,
      events: [
        ...directMessage.state.events,
        { id: taskEventId, sequence: 100, type: 'task/completed', text: 'Budget checklist completed' },
        { id: childEventId, sequence: 101, type: 'child/completed', text: 'Child implementation result' },
      ],
      memoryEntries: [
        ...directMessage.state.memoryEntries,
        { id: AgentMemoryEntryId('memory-task'), agentId: workspace.aliceId, eventId: taskEventId, acquiredBy: 'task' },
        { id: AgentMemoryEntryId('memory-child'), agentId: workspace.aliceId, eventId: childEventId, acquiredBy: 'child-result' },
      ],
    }
    const request = { agentId: workspace.aliceId, roomId: group.roomId, query: 'budget', characterBudget: 1_000 }

    const recalled = recallAgentEvents(state, request)

    expect(recalled.eventIds).toEqual([current.eventId, taskEventId, directMessage.eventId, childEventId])
    expect(recalled.entries.map(entry => entry.provenance)).toEqual([
      'room-membership',
      'task',
      'room-membership',
      'child-result',
    ])
    expect(recalled.rendered).toContain(`event:${taskEventId}`)
    expect(new MemoryReader(state).recall(request)).toEqual(recalled)
  })

  test('does not exceed the configured recall character budget', () => {
    const workspace = createWorkspace()
    const room = mutateWorkspace(workspace.state, { type: 'room/create', kind: 'group', name: 'Engineering' })
    const joined = join(room.state, room.roomId, workspace.aliceId)
    const first = appendRoomMessage(joined, {
      roomId: room.roomId,
      actor: { type: 'human', id: HumanId('owner') },
      text: 'A short current event',
      mentions: [],
    })
    const second = appendRoomMessage(first.state, {
      roomId: room.roomId,
      actor: { type: 'human', id: HumanId('owner') },
      text: 'A second current event that must not fit in the small recall budget',
      mentions: [],
    })

    const recalled = recallAgentEvents(second.state, {
      agentId: workspace.aliceId,
      roomId: room.roomId,
      query: '',
      characterBudget: 100,
    })

    expect(recalled.rendered.length).toBeLessThanOrEqual(100)
    expect(recalled.eventIds).toEqual([])
  })
})
