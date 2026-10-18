import { describe, expect, test } from 'vitest'
import { AgentId, AgentMemoryEntryId, HumanId, RoomId, TaskId, WorkspaceEventId, WorkspaceId } from '../packages/host/src/ids.ts'
import { createInitialState } from '../packages/host/src/state.ts'
import type { WorkspaceState } from '../packages/host/src/types.ts'
import { prepareSceneMemory } from '../packages/host/src/scene-memory.ts'
import { prepareDeliveryMemory } from '../packages/host/src/delivery-memory.ts'
import { mutateWorkspace } from '../packages/host/src/state.ts'
import { workflowRuntime } from './workflow-test-support.ts'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { MemoryFactId } from '../packages/host/src/scene-memory-contract.ts'
import type { ControlledMemoryFact, MemoryCoverage, MemoryLimits, MemoryScene } from '../packages/host/src/scene-memory-contract.ts'

const alice = AgentId('alice')
const bob = AgentId('bob')
const room = RoomId('team')
const limits: MemoryLimits = {
  sceneCharacters: 220, newCharacters: 180, coreCharacters: 160, historyCharacters: 160,
  itemCharacters: 100, recentConversationLimit: 3, factLimit: 3, historyLimit: 3,
}

function stateWithEvents(rows: readonly { id: string; text: string; owner?: typeof alice; sequence: number; acquiredBy?: 'room-membership' | 'history-sync' }[]): WorkspaceState {
  const base = createInitialState(WorkspaceId('org'))
  const triggerSequence = Math.max(0, ...rows.map(row => row.sequence)) + 1
  return {
    ...base,
    nextSequence: triggerSequence + 1,
    events: [...rows.map(row => ({ id: WorkspaceEventId(row.id), sequence: row.sequence, type: 'room/message' as const, subjectId: room, text: row.text })),
      { id: WorkspaceEventId('trigger'), sequence: triggerSequence, type: 'room/message', subjectId: room, text: 'current input' }],
    memoryEntries: rows.map(row => ({
      id: AgentMemoryEntryId(`entry-${row.id}`), agentId: row.owner ?? alice,
      eventId: WorkspaceEventId(row.id), acquiredBy: row.acquiredBy ?? 'room-membership',
    })),
  }
}

function scene(state: WorkspaceState, sourceRoom = room): MemoryScene {
  return {
    source: { kind: 'room', roomId: sourceRoom }, actor: { type: 'human', id: HumanId('owner') },
    triggerEventId: WorkspaceEventId('trigger'), admissionSequence: state.nextSequence - 1, query: 'status',
    organization: { id: WorkspaceId('org'), name: 'Acme' }, colleagues: [{ id: alice, name: 'Alice' }],
  }
}

function addressFact(state: WorkspaceState, sourceId: string, value: string, quote: string): ControlledMemoryFact {
  return { id: MemoryFactId(`address-${sourceId}`), kind: 'controlled', property: 'person.address', category: 'address',
    subject: 'human:owner', key: 'person.address', value, scope: { organizationId: state.workspaceId },
    application: 'organization', temporal: 'current', operation: 'set', sourceEventIds: [WorkspaceEventId(sourceId)],
    sourceQuote: quote, assertionKind: 'human-explicit', validFromSequence: 1, status: 'candidate', supersedesFactIds: [] }
}

describe('prepareSceneMemory', () => {
  test('the current colleague directory includes bounded role labels', async () => {
    const f = await workflowRuntime()
    const room = mutateWorkspace(f.runtime.snapshot(), { type: 'room/create', kind: 'group', name: 'Team' })
    const joined = mutateWorkspace(room.state, { type: 'room/join', roomId: room.roomId, agentId: f.agentId, memoryStart: { type: 'new-events' } })
    const trigger = mutateWorkspace(joined.state, { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: HumanId('owner') }, text: 'Who writes?', mentions: [f.agentId] })
    const delivery = createUserMessage({ content: [{ type: 'text', text: 'Who writes?' }], source: { kind: 'user' } })
    const result = prepareDeliveryMemory(trigger.state, { session: Session.create(SessionId('role-directory')), agentId: f.agentId, contextGeneration: 0,
      source: { kind: 'room', roomId: room.roomId }, triggerEventId: trigger.eventId, delivery,
      organization: { id: trigger.state.workspaceId, name: 'Org' }, facts: [], limits: { ...limits, sceneCharacters: 600 } })
    expect(result.layers.scene.rendered).toContain('"role":"Writer"')
    expect(result.layers.scene.rendered).toContain('"currentTimeLocal":')
    expect(result.layers.scene.rendered.length).toBeLessThanOrEqual(600)
  })
  test('renders the current delivery clock without assigning a date to source events', () => {
    const state = stateWithEvents([{ id: 'old', sequence: 1, text: 'undated source' }])
    const result = prepareSceneMemory(state, { agentId: alice, contextGeneration: 0,
      scene: { ...scene(state), currentTimeUtc: '2026-10-16T00:00:00.000Z', currentTimeLocal: { timeZone: 'Asia/Shanghai', dateTime: '2026-10-16T08:00:00.000+08:00' } }, coverage: [], facts: [],
      limits: { ...limits, sceneCharacters: 500 } })
    expect(result.layers.scene.rendered).toContain('"currentTimeUtc":"2026-10-16T00:00:00.000Z"')
    expect(result.layers.scene.rendered).toContain('"currentTimeLocal":{"timeZone":"Asia/Shanghai","dateTime":"2026-10-16T08:00:00.000+08:00"}')
    expect(result.layers.new.rendered).not.toContain('2026-10-16')
  })
  test('renders the assigned project status separately from remembered source text', () => {
    const state = stateWithEvents([])
    const result = prepareSceneMemory(state, { agentId: alice, contextGeneration: 0,
      scene: { ...scene(state), work: [{ taskId: TaskId('task-old'), title: '旧项目', status: 'cancelled' }] },
      coverage: [], facts: [], limits: { ...limits, sceneCharacters: 500 } })
    expect(result.layers.scene.rendered).toContain('"status":"cancelled"')
    expect(result.layers.scene.rendered).toContain('旧项目')
  })
  test('renders actual source location and gives current actor narrow facts the first bounded slot', () => {
    const state = stateWithEvents([{ id: 'preference', sequence: 1, text: '在本群称呼邵老师' }])
    const fact = { ...addressFact(state, 'preference', '邵老师', '称呼邵老师'), id: MemoryFactId('current'),
      scope: { organizationId: state.workspaceId, roomId: room }, application: 'source-room' as const }
    const result = prepareSceneMemory(state, { agentId: alice, contextGeneration: 1, scene: scene(state), coverage: [],
      facts: [{ ...fact, id: MemoryFactId('other'), subject: 'old-colleague' }, { ...fact, id: MemoryFactId('general'), value: '邵总', scope: { organizationId: state.workspaceId } }, fact],
      limits: { ...limits, coreCharacters: 1000, itemCharacters: 700, factLimit: 1, newCharacters: 700 } })
    expect(result.layers.new.rendered).toContain('room:team')
    expect(result.layers.new.rendered).toContain('sequence:1')
    expect(result.layers.core.rendered).toContain('邵老师')
    expect(result.layers.core.rendered).toContain('scope:org/room:team')
    expect(result.layers.core.rendered).not.toContain('old-colleague')
  })
  test('reserves the new layer for an acquired message without a mention when older matching text is huge', () => {
    const state = stateWithEvents([
      { id: 'old', sequence: 1, text: `status ${'document '.repeat(300)}` },
      { id: 'new', sequence: 2, text: '请叫我小鹿，今天继续处理。' },
    ])
    const result = prepareSceneMemory(state, { agentId: alice, contextGeneration: 2, scene: scene(state), coverage: [], facts: [], limits })
    expect(result.layers.new.rendered).toContain('请叫我小鹿')
    expect(result.layers.new.eventIds).toContain(WorkspaceEventId('new'))
    expect(result.rendered).toContain('请叫我小鹿')
    expect(result.layers.new.rendered.length).toBeLessThanOrEqual(limits.newCharacters)
    expect(result.layers.history.rendered.length).toBeLessThanOrEqual(limits.historyCharacters)
  })

  test('never exposes another colleague\'s acquired message', () => {
    const state = stateWithEvents([{ id: 'private', sequence: 1, text: '叫我小鹿', owner: bob }])
    const result = prepareSceneMemory(state, { agentId: alice, contextGeneration: 0, scene: scene(state), coverage: [], facts: [], limits })
    expect(result.rendered).not.toContain('小鹿')
    expect(result.eventIds).toEqual([])
  })

  test('partial original text and summary coverage do not mark the entry fully read', () => {
    const state = stateWithEvents([{ id: 'note', sequence: 1, text: 'first section; second section' }])
    const coverage: MemoryCoverage[] = [
      { entryId: AgentMemoryEntryId('entry-note'), contextGeneration: 4, kind: 'original', start: 0, end: 5 },
      { entryId: AgentMemoryEntryId('entry-note'), contextGeneration: 4, kind: 'summary', category: 'overview' },
    ]
    const result = prepareSceneMemory(state, { agentId: alice, contextGeneration: 4, scene: scene(state), coverage, facts: [], limits })
    expect(result.layers.new.eventIds).toContain(WorkspaceEventId('note'))
    expect(result.coverage.some(receipt => receipt.kind === 'original' && receipt.start === 5 && receipt.end === 29)).toBe(true)
  })

  test('old event acquired by history sync is new in this context', () => {
    const state = stateWithEvents([{ id: 'old', sequence: 1, text: 'historical note', acquiredBy: 'history-sync' }])
    const result = prepareSceneMemory(state, { agentId: alice, contextGeneration: 3, scene: scene(state), coverage: [], facts: [], limits })
    expect(result.layers.new.eventIds).toEqual([WorkspaceEventId('old')])
  })

  test('scene and actor come from this invocation, not the previous group', () => {
    const state = stateWithEvents([])
    const first = prepareSceneMemory(state, { agentId: alice, contextGeneration: 0, scene: scene(state, RoomId('first')), coverage: [], facts: [], limits })
    const second = prepareSceneMemory(state, { agentId: alice, contextGeneration: 0, scene: {
      ...scene(state, RoomId('second')), actor: { type: 'agent', id: bob },
    }, coverage: [], facts: [], limits })
    expect(first.layers.scene.rendered).toContain('first')
    expect(second.layers.scene.rendered).toContain('second')
    expect(second.layers.scene.rendered).toContain('bob')
    expect(second.layers.scene.rendered).not.toContain('first')
    expect(second.layers.scene.rendered).not.toContain('owner')
  })

  test('separate budgets and count limits apply to every layer', () => {
    const state = stateWithEvents([
      { id: 'one', sequence: 1, text: 'status one' },
      { id: 'two', sequence: 2, text: 'status two' },
      { id: 'three', sequence: 3, text: 'status three' },
    ])
    const tight: MemoryLimits = { sceneCharacters: 220, newCharacters: 100, coreCharacters: 20, historyCharacters: 100,
      itemCharacters: 90, recentConversationLimit: 1, factLimit: 1, historyLimit: 1 }
    const result = prepareSceneMemory(state, { agentId: alice, contextGeneration: 0, scene: scene(state), coverage: [], facts: [], limits: tight })
    expect(result.layers.scene.rendered.length).toBeLessThanOrEqual(220)
    expect(result.layers.new.rendered.length).toBeLessThanOrEqual(100)
    expect(result.layers.new.eventIds).toHaveLength(1)
    expect(result.layers.core.rendered.length).toBeLessThanOrEqual(20)
    expect(result.layers.history.rendered.length).toBeLessThanOrEqual(100)
    expect(result.layers.history.eventIds).toHaveLength(1)
    expect(result.layers.new.omitted).toBe(2)
    expect(result.omitted).toBe(2)
    expect(result.rendered).toContain('Partial memory coverage')
    expect(result.rendered).toContain('new:2 omitted')
    expect(result.rendered).toContain('workspace_search_memory')
    expect(result.rendered).toContain('workspace_read_memory')
  })

  test('a truncated original is disclosed as partial even when no source event is omitted', () => {
    const state = stateWithEvents([{ id: 'long', sequence: 1, text: 'content '.repeat(40) }])
    const result = prepareSceneMemory(state, { agentId: alice, contextGeneration: 0, scene: { ...scene(state), colleagues: [] }, coverage: [], facts: [], limits })
    expect(result.omitted).toBe(0)
    expect(result.rendered).toContain('Partial memory coverage')
    expect(result.rendered).toContain('partial original excerpts:')
  })

  test('a core fact reference does not count its undisplayed original as covered', () => {
    const state = stateWithEvents([{ id: 'fact-only', sequence: 1, text: '请叫我小鹿' }])
    const result = prepareSceneMemory(state, { agentId: alice, contextGeneration: 0, scene: { ...scene(state), colleagues: [] }, coverage: [],
      facts: [addressFact(state, 'fact-only', '小鹿', '请叫我小鹿')],
      limits: { ...limits, newCharacters: 0, historyCharacters: 0, coreCharacters: 400, itemCharacters: 300 } })
    expect(result.layers.new.eventIds).toEqual([])
    expect(result.layers.history.eventIds).toEqual([])
    expect(result.layers.core.eventIds).toEqual([WorkspaceEventId('fact-only')])
    expect(result.eventIds).toEqual([WorkspaceEventId('fact-only')])
    expect(result.coverage).toEqual([])
    expect(result.omitted).toBe(1)
    expect(result.rendered).toContain('Partial memory coverage')
    expect(result.rendered).toContain('source events:1 omitted; fact-only source references:1')
  })

  test('a fully covered original can be retrieved in history with text', () => {
    const state = stateWithEvents([{ id: 'covered', sequence: 1, text: 'approved status' }])
    const coverage: MemoryCoverage[] = [{ entryId: AgentMemoryEntryId('entry-covered'), contextGeneration: 1,
      kind: 'original', start: 0, end: 15 }]
    const result = prepareSceneMemory(state, { agentId: alice, contextGeneration: 1, scene: scene(state), coverage, facts: [], limits })
    expect(result.layers.new.eventIds).toEqual([])
    expect(result.layers.history.rendered).toContain('approved status')
  })

  test('core renders a sourced human preference as data within its own budget', () => {
    const state = stateWithEvents([{ id: 'preference', sequence: 1, text: '请叫我小鹿' }])
    const result = prepareSceneMemory(state, { agentId: alice, contextGeneration: 1,
      scene: { ...scene(state), triggerEventId: WorkspaceEventId('preference') }, coverage: [],
      facts: [addressFact(state, 'preference', '小鹿', '请叫我小鹿')], limits: { ...limits, coreCharacters: 400, itemCharacters: 300 } })
    expect(result.layers.core.rendered).toContain('小鹿')
    expect(result.layers.core.rendered).toContain('source:preference')
    expect(result.layers.core.rendered).toContain('assertionKind:human-explicit')
    expect(result.layers.core.rendered.length).toBeLessThanOrEqual(400)
  })

  test('essential current scene survives an oversized colleague list', () => {
    const state = stateWithEvents([])
    const current = { ...scene(state), colleagues: Array.from({ length: 50 }, (_, index) => ({ id: AgentId(`colleague-${index}`), name: '很长的同事姓名'.repeat(20) })) }
    const result = prepareSceneMemory(state, { agentId: alice, contextGeneration: 0, scene: current, coverage: [], facts: [], limits })
    expect(result.layers.scene.rendered).toContain('roomId')
    expect(result.layers.scene.rendered).toContain('owner')
    expect(result.layers.scene.rendered).toContain('trigger')
    expect(result.layers.scene.rendered).toContain('status')
    expect(result.layers.scene.rendered.length).toBeLessThanOrEqual(limits.sceneCharacters)
    expect(result.layers.scene.omitted).toBe(50)
  })

  test('rejects a scene budget too small to contain the actual source, actor, trigger, and query', () => {
    const state = stateWithEvents([])
    expect(() => prepareSceneMemory(state, { agentId: alice, contextGeneration: 0, scene: scene(state), coverage: [], facts: [],
      limits: { ...limits, sceneCharacters: 30 } })).toThrow('scene character budget')
  })

  test('rejects an absent triggering event', () => {
    const state = stateWithEvents([])
    expect(() => prepareSceneMemory(state, { agentId: alice, contextGeneration: 0,
      scene: { ...scene(state), triggerEventId: WorkspaceEventId('absent') }, coverage: [], facts: [], limits })).toThrow('trigger event')
  })
})
