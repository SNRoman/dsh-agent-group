import { expect, test } from 'vitest'
import { rankMemoryCandidates } from '../packages/host/src/memory-retrieval.ts'
import { AgentId, AgentMemoryEntryId, RoomId, WorkspaceEventId } from '../packages/host/src/ids.ts'
import { WorkspaceId, HumanId } from '../packages/host/src/ids.ts'
import { createInitialState } from '../packages/host/src/state.ts'
import { prepareSceneMemory } from '../packages/host/src/scene-memory.ts'
import { recallAgentEvents } from '../packages/host/src/memory.ts'

test('Chinese substring candidates rank after personal selection, with mention ids removed', () => {
  const sources = ['这是很长的文档。'.repeat(300) + '以后称呼虞总', '本群以后称呼邵老师'].map((text, index) => ({
    event: { id: WorkspaceEventId(`event-${index}`), type: 'room/message' as const, sequence: index + 1, subjectId: RoomId('team'), text },
    entry: { id: AgentMemoryEntryId(`entry-${index}`), eventId: WorkspaceEventId(`event-${index}`), agentId: AgentId('alice'), acquiredBy: 'room-membership' as const },
  }))
  expect(rankMemoryCandidates(sources, '@[小陈](agent:abc) 邵老师', true)[0]?.event.id).toBe('event-1')
  expect(rankMemoryCandidates(sources, '虞总', true)[0]?.event.id).toBe('event-0')
  expect(rankMemoryCandidates(sources, '不存在的短语', true)).toEqual([])
})

test('history excerpts contain a Chinese keyword at the end of a large source', () => {
  const eventId = WorkspaceEventId('long'), entryId = AgentMemoryEntryId('long-entry'), agentId = AgentId('alice'), roomId = RoomId('team')
  const text = '旧文档内容。'.repeat(800) + '最终称呼虞总'
  const state = { ...createInitialState(WorkspaceId('org')), nextSequence: 3,
    events: [{ id: eventId, sequence: 1, type: 'room/message' as const, subjectId: roomId, text },
      { id: WorkspaceEventId('trigger'), sequence: 2, type: 'room/message' as const, subjectId: roomId, text: '虞总' }],
    memoryEntries: [{ id: entryId, agentId, eventId, acquiredBy: 'room-membership' as const }] }
  const prepared = prepareSceneMemory(state, { agentId, contextGeneration: 0, facts: [],
    coverage: [{ entryId, contextGeneration: 0, kind: 'original', start: 0, end: text.length }],
    scene: { source: { kind: 'room', roomId }, actor: { type: 'human', id: HumanId('owner') }, triggerEventId: WorkspaceEventId('trigger'), admissionSequence: 2, query: '虞总', organization: { id: state.workspaceId, name: 'Org' }, colleagues: [] },
    limits: { sceneCharacters: 1000, newCharacters: 500, coreCharacters: 500, historyCharacters: 500, itemCharacters: 200, recentConversationLimit: 3, factLimit: 3, historyLimit: 3 } })
  expect(prepared.layers.history.rendered).toContain('虞总')
  expect(prepared.coverage[0]).toMatchObject({ kind: 'original', end: text.length })
})

test('duplicate legacy acquisitions search once but retain separate original coverage on later admission', () => {
  const eventId = WorkspaceEventId('legacy'), agentId = AgentId('alice'), roomId = RoomId('team')
  const firstId = AgentMemoryEntryId('first'), secondId = AgentMemoryEntryId('second')
  const text = '旧约定称呼虞总'
  const state = { ...createInitialState(WorkspaceId('org')), nextSequence: 3,
    events: [{ id: eventId, sequence: 1, type: 'room/message' as const, subjectId: roomId, text },
      { id: WorkspaceEventId('trigger'), sequence: 2, type: 'room/message' as const, subjectId: roomId, text: '现在知道了吗' }],
    memoryEntries: [
      { id: firstId, agentId, eventId, acquiredBy: 'room-membership' as const },
      { id: secondId, agentId, eventId, acquiredBy: 'history-sync' as const },
    ] }
  const searched = recallAgentEvents(state, { agentId, query: '虞总', characterBudget: 1000, matchingOnly: true })
  expect(searched.entries.map(entry => entry.eventId)).toEqual([eventId])
  const request = { agentId, contextGeneration: 0, facts: [], scene: { source: { kind: 'room' as const, roomId }, actor: { type: 'human' as const, id: HumanId('owner') }, triggerEventId: WorkspaceEventId('trigger'), admissionSequence: 2, query: '虞总', organization: { id: state.workspaceId, name: 'Org' }, colleagues: [] },
    limits: { sceneCharacters: 1000, newCharacters: 500, coreCharacters: 500, historyCharacters: 500, itemCharacters: 200, recentConversationLimit: 3, factLimit: 3, historyLimit: 3 } }
  const oneCovered = prepareSceneMemory(state, { ...request, coverage: [{ entryId: firstId, contextGeneration: 0, kind: 'original' as const, start: 0, end: text.length }] })
  expect(oneCovered.coverage.some(receipt => receipt.entryId === secondId && receipt.kind === 'original')).toBe(true)
  const bothCovered = prepareSceneMemory(state, { ...request, coverage: [
    { entryId: firstId, contextGeneration: 0, kind: 'original' as const, start: 0, end: text.length },
    { entryId: secondId, contextGeneration: 0, kind: 'original' as const, start: 0, end: text.length },
  ] })
  expect(bothCovered.layers.new.rendered).toBe('')
  expect(bothCovered.layers.history.rendered).toContain('虞总')
})
