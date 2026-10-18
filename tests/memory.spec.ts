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
import { appendMemoryEntries, createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import { acceptTaskDelivery, startTaskDelivery, terminalizeTask } from '../packages/host/src/task-delivery.ts'
import { assignHumanTask } from '../packages/host/src/tasks.ts'
import type { WorkspaceEvent, WorkspaceState } from '../packages/host/src/types.ts'

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

function rememberEvents(state: WorkspaceState, agentId: AgentId, events: readonly WorkspaceEvent[]): WorkspaceState {
  return {
    ...state,
    events: [...state.events, ...events],
    memoryEntries: [...state.memoryEntries, ...events.map((event, index) => ({
      id: AgentMemoryEntryId(`memory-fixture-${index}`), agentId, eventId: event.id, acquiredBy: 'room-membership' as const,
    }))],
  }
}

describe('unified event memory', () => {
  test('admits one agent-event association and retains its first provenance', () => {
    const workspace = createWorkspace()
    const eventId = WorkspaceEventId('event-shared')
    const seeded: WorkspaceState = {
      ...workspace.state,
      events: [...workspace.state.events, { id: eventId, sequence: 100, type: 'task/completed', text: 'shared' }],
    }
    const first = appendMemoryEntries(seeded, [
      { agentId: workspace.aliceId, eventId, acquiredBy: 'task' },
      { agentId: workspace.aliceId, eventId, acquiredBy: 'history-sync' },
    ])
    const repeated = appendMemoryEntries(first, [
      { agentId: workspace.aliceId, eventId, acquiredBy: 'child-result' },
    ])

    expect(repeated.memoryEntries.filter(entry => entry.agentId === workspace.aliceId && entry.eventId === eventId)).toEqual([
      expect.objectContaining({ acquiredBy: 'task' }),
    ])
    expect(repeated.nextId).toBe(first.nextId)
  })

  test('recalls a terminal task result acquired by the assigned agent', () => {
    const workspace = createWorkspace()
    const assigned = assignHumanTask(workspace.state, {
      humanId: HumanId('owner'), assigneeAgentId: workspace.aliceId, title: 'Remember this task result',
    })
    const started = startTaskDelivery(assigned.state, { taskId: assigned.taskId })
    const accepted = acceptTaskDelivery(started.state, { taskId: assigned.taskId, attemptId: started.attemptId, messageId: started.message.id })
    const terminal = terminalizeTask(accepted.state, {
      actorAgentId: workspace.aliceId, taskId: assigned.taskId, attemptId: started.attemptId,
      result: 'The persisted task result is ready.', definitionRevisionId: Object.values(assigned.state.definitionRevisions)[0]!.id,
    })
    const room = mutateWorkspace(terminal.state, { type: 'room/create', kind: 'direct' })
    const recalled = recallAgentEvents(room.state, {
      agentId: workspace.aliceId, roomId: room.roomId, query: 'persisted', characterBudget: 1_000,
    })

    expect(recalled.entries.some(entry => entry.provenance === 'task' && entry.rendered.includes('task/result'))).toBe(true)
  })

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

  test('projects a room message appended through the public workspace mutation path into every active member memory', () => {
    const workspace = createWorkspace()
    const room = mutateWorkspace(workspace.state, { type: 'room/create', kind: 'group', name: 'Engineering' })
    const joinedAlice = join(room.state, room.roomId, workspace.aliceId)
    const joinedBoth = join(joinedAlice, room.roomId, workspace.bobId)

    const result = mutateWorkspace(joinedBoth, {
      type: 'room/message',
      roomId: room.roomId,
      actor: { type: 'human', id: HumanId('owner') },
      text: 'Record this through the aggregate',
      mentions: [],
    })

    expect(memoryEventIds(result.state, workspace.aliceId)).toContain(result.eventId)
    expect(memoryEventIds(result.state, workspace.bobId)).toContain(result.eventId)
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

  test('does not duplicate an event when a re-employed member synchronizes an overlapping history range', () => {
    const workspace = createWorkspace()
    const room = mutateWorkspace(workspace.state, { type: 'room/create', kind: 'group', name: 'Engineering' })
    const earlier = appendRoomMessage(room.state, {
      roomId: room.roomId,
      actor: { type: 'human', id: HumanId('owner') },
      text: 'Earlier planning note',
      mentions: [],
    })
    const earlierEvent = earlier.state.events.find(event => event.id === earlier.eventId)
    if (earlierEvent === undefined) throw new Error('expected earlier room event')
    const firstJoin = joinRoomWithMemory(earlier.state, {
      type: 'room/join',
      roomId: room.roomId,
      agentId: workspace.aliceId,
      memoryStart: { type: 'event-range', startSequence: earlierEvent.sequence, endSequence: earlierEvent.sequence },
    })
    const departed = mutateWorkspace(firstJoin.state, { type: 'agent/depart', agentId: workspace.aliceId })
    const reemployed = mutateWorkspace(departed.state, { type: 'agent/employ', agentId: workspace.aliceId })

    const rejoined = joinRoomWithMemory(reemployed.state, {
      type: 'room/join',
      roomId: room.roomId,
      agentId: workspace.aliceId,
      memoryStart: { type: 'event-range', startSequence: earlierEvent.sequence, endSequence: earlierEvent.sequence },
    })

    expect(memoryEventIds(rejoined.state, workspace.aliceId)).toEqual([earlier.eventId])
  })

  test('synchronizes complete group history without acquiring unknown events from another group', () => {
    const workspace = createWorkspace()
    const other = mutateWorkspace(workspace.state, { type: 'room/create', kind: 'group', name: 'Other team' })
    const otherJoined = join(other.state, other.roomId, workspace.aliceId)
    const known = appendRoomMessage(otherJoined, {
      roomId: other.roomId, actor: { type: 'human', id: HumanId('owner') }, text: 'Previously acquired personal memory', mentions: [],
    })
    const leftOther = mutateWorkspace(known.state, { type: 'room/leave', membershipId: Object.values(otherJoined.memberships)[0]!.id })
    const unknown = appendRoomMessage(leftOther.state, {
      roomId: other.roomId, actor: { type: 'human', id: HumanId('owner') }, text: 'Not acquired after leaving the other team', mentions: [],
    })
    const room = mutateWorkspace(unknown.state, { type: 'room/create', kind: 'group', name: 'Engineering' })
    const createdEventId = room.state.events.at(-1)!.id
    const earlier = appendRoomMessage(room.state, {
      roomId: room.roomId, actor: { type: 'human', id: HumanId('owner') }, text: 'Earlier group planning', mentions: [],
    })
    const later = appendRoomMessage(earlier.state, {
      roomId: room.roomId, actor: { type: 'human', id: HumanId('owner') }, text: 'Latest group planning', mentions: [],
    })
    const latestOther = appendRoomMessage(later.state, {
      roomId: other.roomId, actor: { type: 'human', id: HumanId('owner') }, text: 'The latest workspace event belongs to another group', mentions: [],
    })

    const joined = joinRoomWithMemory(latestOther.state, {
      type: 'room/join', roomId: room.roomId, agentId: workspace.aliceId,
      memoryStart: { type: 'event-range', startSequence: 1, endSequence: latestOther.state.events.at(-1)!.sequence },
    })

    expect(memoryEventIds(joined.state, workspace.aliceId)).toEqual([known.eventId, createdEventId, earlier.eventId, later.eventId])
    expect(joined.state.memoryEntries.map(entry => entry.acquiredBy)).toEqual([
      'room-membership', 'history-sync', 'history-sync', 'history-sync',
    ])
    expect(recallAgentEvents(joined.state, {
      agentId: workspace.aliceId, query: 'personal', matchingOnly: true, characterBudget: 2_000,
    }).eventIds).toEqual([known.eventId])
  })

  test('joins a group with no messages and acquires messages arriving after admission', () => {
    const workspace = createWorkspace()
    const room = mutateWorkspace(workspace.state, { type: 'room/create', kind: 'group', name: 'Engineering' })
    const createdEventId = room.state.events.at(-1)!.id
    const joined = joinRoomWithMemory(room.state, {
      type: 'room/join', roomId: room.roomId, agentId: workspace.aliceId,
      memoryStart: { type: 'event-range', startSequence: 1, endSequence: room.state.events.at(-1)!.sequence },
    })

    expect(memoryEventIds(joined.state, workspace.aliceId)).toEqual([createdEventId])

    const future = appendRoomMessage(joined.state, {
      roomId: room.roomId, actor: { type: 'human', id: HumanId('owner') }, text: 'First message after admission', mentions: [],
    })
    expect(memoryEventIds(future.state, workspace.aliceId)).toEqual([createdEventId, future.eventId])
    expect(future.state.memoryEntries.at(-1)?.acquiredBy).toBe('room-membership')
  })

  test('a full-history rejoin fills the membership gap without duplicating earlier memory', () => {
    const workspace = createWorkspace()
    const room = mutateWorkspace(workspace.state, { type: 'room/create', kind: 'group', name: 'Engineering' })
    const createdEventId = room.state.events.at(-1)!.id
    const earlier = appendRoomMessage(room.state, {
      roomId: room.roomId, actor: { type: 'human', id: HumanId('owner') }, text: 'Planning before the first join', mentions: [],
    })
    const firstJoin = joinRoomWithMemory(earlier.state, {
      type: 'room/join', roomId: room.roomId, agentId: workspace.aliceId,
      memoryStart: { type: 'event-range', startSequence: 1, endSequence: earlier.state.events.at(-1)!.sequence },
    })
    const present = appendRoomMessage(firstJoin.state, {
      roomId: room.roomId, actor: { type: 'human', id: HumanId('owner') }, text: 'Planning during the first membership', mentions: [],
    })
    const left = mutateWorkspace(present.state, { type: 'room/leave', membershipId: Object.values(firstJoin.state.memberships)[0]!.id })
    const missed = appendRoomMessage(left.state, {
      roomId: room.roomId, actor: { type: 'human', id: HumanId('owner') }, text: 'Planning while the colleague is absent', mentions: [],
    })
    expect(memoryEventIds(missed.state, workspace.aliceId)).toEqual([createdEventId, earlier.eventId, present.eventId])

    const rejoined = joinRoomWithMemory(missed.state, {
      type: 'room/join', roomId: room.roomId, agentId: workspace.aliceId,
      memoryStart: { type: 'event-range', startSequence: 1, endSequence: missed.state.events.at(-1)!.sequence },
    })

    expect(rejoined.state.memoryEntries.map(entry => ({ eventId: entry.eventId, acquiredBy: entry.acquiredBy }))).toEqual([
      { eventId: createdEventId, acquiredBy: 'history-sync' },
      { eventId: earlier.eventId, acquiredBy: 'history-sync' },
      { eventId: present.eventId, acquiredBy: 'room-membership' },
      { eventId: missed.eventId, acquiredBy: 'history-sync' },
    ])
    const future = appendRoomMessage(rejoined.state, {
      roomId: room.roomId, actor: { type: 'human', id: HumanId('owner') }, text: 'Planning after rejoining', mentions: [],
    })
    expect(memoryEventIds(future.state, workspace.aliceId)).toEqual([
      createdEventId, earlier.eventId, present.eventId, missed.eventId, future.eventId,
    ])
  })

  test('recalls relevant personal events before unrelated current-room events across every acquisition source', () => {
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

    expect(recalled.eventIds).toEqual([taskEventId, directMessage.eventId, childEventId, current.eventId])
    expect(recalled.entries.map(entry => entry.provenance)).toEqual([
      'task',
      'room-membership',
      'child-result',
      'room-membership',
    ])
    expect(recalled.rendered).toContain(`event:${taskEventId}`)
    expect(new MemoryReader(state).recall(request)).toEqual(recalled)
  })

  test('finds Chinese keywords across rooms and orders equally relevant corrections newest first without a room', () => {
    const workspace = createWorkspace()
    const state = rememberEvents(workspace.state, workspace.aliceId, [
      { id: WorkspaceEventId('event-original'), sequence: 100, type: 'room/message', subjectId: RoomId('meeting'), text: '支付接口提交前须完成上线审核，周五发布。' },
      { id: WorkspaceEventId('event-correction'), sequence: 101, type: 'room/message', subjectId: RoomId('review'), text: '支付接口上线审核已调整，改为周六发布。' },
      { id: WorkspaceEventId('event-partial'), sequence: 102, type: 'room/message', subjectId: RoomId('coding'), text: '支付接口正在开发。' },
      { id: WorkspaceEventId('event-unrelated'), sequence: 103, type: 'room/message', subjectId: RoomId('coding'), text: '今天午餐吃面条。' },
    ])

    const recalled = recallAgentEvents(state, { agentId: workspace.aliceId, query: '支付接口 上线审核', characterBudget: 2_000 })

    expect(recalled.eventIds).toEqual([
      WorkspaceEventId('event-correction'), WorkspaceEventId('event-original'), WorkspaceEventId('event-partial'), WorkspaceEventId('event-unrelated'),
    ])
    expect(recalled.entries[0]?.rendered).toContain('改为周六发布')
    expect(recalled.entries[1]?.rendered).toContain('周五发布')
  })

  test('matches independent case-insensitive English keywords ahead of recent unrelated room traffic', () => {
    const workspace = createWorkspace()
    const roomId = RoomId('coding')
    const state = rememberEvents(workspace.state, workspace.aliceId, [
      { id: WorkspaceEventId('event-approved'), sequence: 100, type: 'room/message', subjectId: RoomId('meeting'), text: 'The RELEASE is approved within the BUDGET.' },
      { id: WorkspaceEventId('event-lunch'), sequence: 101, type: 'room/message', subjectId: roomId, text: 'Lunch is ready.' },
    ])

    const recalled = recallAgentEvents(state, { agentId: workspace.aliceId, roomId, query: 'release budget', characterBudget: 2_000 })

    expect(recalled.eventIds[0]).toBe(WorkspaceEventId('event-approved'))
  })

  test('keeps empty-query memories newest first and excludes another agent\'s matching event', () => {
    const workspace = createWorkspace()
    const state = rememberEvents(workspace.state, workspace.aliceId, [
      { id: WorkspaceEventId('event-earlier'), sequence: 100, type: 'room/message', text: 'Release planning.' },
      { id: WorkspaceEventId('event-later'), sequence: 101, type: 'room/message', text: 'Later update.' },
    ])
    const privateEventId = WorkspaceEventId('event-private')
    const privateState = rememberEvents(state, workspace.bobId, [{ id: privateEventId, sequence: 102, type: 'room/message', text: 'Release budget secret.' }])

    expect(recallAgentEvents(privateState, { agentId: workspace.aliceId, query: '', characterBudget: 2_000 }).eventIds).toEqual([
      WorkspaceEventId('event-later'), WorkspaceEventId('event-earlier'),
    ])
    expect(recallAgentEvents(privateState, { agentId: workspace.aliceId, query: 'release budget', characterBudget: 2_000 }).eventIds).not.toContain(privateEventId)
  })

  test('skips an oversized unrelated recent event so a later candidate can fit', () => {
    const workspace = createWorkspace()
    const state = rememberEvents(workspace.state, workspace.aliceId, [
      { id: WorkspaceEventId('event-short'), sequence: 100, type: 'room/message', text: 'Release on Friday.' },
      { id: WorkspaceEventId('event-huge'), sequence: 101, type: 'room/message', text: 'unrelated '.repeat(1_000) },
    ])

    const recalled = recallAgentEvents(state, { agentId: workspace.aliceId, query: '', characterBudget: 200 })

    expect(recalled.eventIds).toEqual([WorkspaceEventId('event-short')])
    expect(recalled.rendered.length).toBeLessThanOrEqual(200)
  })

  test('returns a bounded marked excerpt around a long event\'s matching text with its stable event id', () => {
    const workspace = createWorkspace()
    const eventId = WorkspaceEventId('event-long-decision')
    const state = rememberEvents(workspace.state, workspace.aliceId, [{
      id: eventId, sequence: 100, type: 'room/message', text: `${'noise '.repeat(1_000)}release approved on Friday.`,
    }])

    const recalled = recallAgentEvents(state, { agentId: workspace.aliceId, query: 'release', characterBudget: 220 })

    expect(recalled.eventIds).toEqual([eventId])
    expect(recalled.rendered).toContain('release approved on Friday')
    expect(recalled.rendered).toContain('[truncated]')
    expect(recalled.rendered).toContain(`event:${eventId}`)
    expect(recalled.rendered.length).toBeLessThanOrEqual(220)
    expect(recallAgentEvents(state, { agentId: workspace.aliceId, query: 'release', characterBudget: 20 }).eventIds).toEqual([])
  })

  test('restricts explicit search to matching memories and reports results omitted by its count limit', () => {
    const workspace = createWorkspace()
    const state = rememberEvents(workspace.state, workspace.aliceId, [
      { id: WorkspaceEventId('event-first'), sequence: 100, type: 'room/message', text: 'Release first decision.' },
      { id: WorkspaceEventId('event-second'), sequence: 101, type: 'room/message', text: 'Release corrected decision.' },
      { id: WorkspaceEventId('event-chat'), sequence: 102, type: 'room/message', text: 'Lunch is ready.' },
    ])

    const recalled = recallAgentEvents(state, { agentId: workspace.aliceId, query: 'release', matchingOnly: true, resultLimit: 1, characterBudget: 1_000 })

    expect(recalled.eventIds).toEqual([WorkspaceEventId('event-second')])
    expect(recalled.hasMore).toBe(true)
    expect(recallAgentEvents(state, { agentId: workspace.aliceId, query: 'absent', matchingOnly: true, characterBudget: 1_000 })).toMatchObject({ eventIds: [], hasMore: false })
    expect(recallAgentEvents(state, { agentId: workspace.aliceId, query: 'release', matchingOnly: true, characterBudget: 1_000 })).toMatchObject({
      eventIds: [WorkspaceEventId('event-second'), WorkspaceEventId('event-first')], hasMore: false,
    })
  })

  test('reports matching memories omitted by budget while an excerpt alone does not imply more results', () => {
    const workspace = createWorkspace()
    const state = rememberEvents(workspace.state, workspace.aliceId, [
      { id: WorkspaceEventId('event-first'), sequence: 100, type: 'room/message', text: 'Release first decision.' },
      { id: WorkspaceEventId('event-second'), sequence: 101, type: 'room/message', text: 'Release corrected decision.' },
    ])

    const recalled = recallAgentEvents(state, { agentId: workspace.aliceId, query: 'release', matchingOnly: true, characterBudget: 160 })

    expect(recalled.eventIds).toEqual([WorkspaceEventId('event-second')])
    expect(recalled.hasMore).toBe(true)
    const longOnly = rememberEvents(workspace.state, workspace.aliceId, [{
      id: WorkspaceEventId('event-long'), sequence: 100, type: 'room/message', text: `${'noise '.repeat(1_000)}release approved.`,
    }])
    const excerpt = recallAgentEvents(longOnly, { agentId: workspace.aliceId, query: 'release', matchingOnly: true, characterBudget: 220 })
    expect(excerpt.rendered).toContain('[truncated]')
    expect(excerpt.hasMore).toBe(false)
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
    expect(recalled.eventIds).toEqual([first.eventId])
  })
})
