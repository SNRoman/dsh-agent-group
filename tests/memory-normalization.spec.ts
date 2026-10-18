import { expect, test } from 'vitest'
import { AgentId, AgentMemoryEntryId, HumanId, RoomId, TaskDeliveryAttemptId, TaskId, WorkspaceEventId, WorkspaceId } from '../packages/host/src/ids.ts'
import { parseMemoryFacts, parseMemoryFactsIndividually } from '../packages/host/src/memory-projection.ts'
import type { MemoryExtractionInput } from '../packages/host/src/memory-projection.ts'
import { projectMemoryFacts } from '../packages/host/src/memory-facts.ts'
import { createInitialState } from '../packages/host/src/state.ts'
import type { WorkspaceState } from '../packages/host/src/types.ts'
import type { MemoryScene } from '../packages/host/src/scene-memory-contract.ts'
import { prepareSceneMemory } from '../packages/host/src/scene-memory.ts'

const addressA = '从现在起，在公司所有群聊和工作交流中请称呼我为林老师。'
const addressB = '公司所有群聊和工作交流中的称呼改为方老师；先前约定的林老师称呼是旧称呼。'

function input(text: string, sequence: number): MemoryExtractionInput {
  return { workspaceId: WorkspaceId('local'), eventId: WorkspaceEventId(`event-${sequence}`), sequence,
    actor: { type: 'human', id: HumanId('web-user') }, scope: { organizationId: WorkspaceId('local'), roomId: RoomId('room-5') },
    start: 0, end: text.length, totalCharacters: text.length, text, sourceDigest: `digest-${sequence}` }
}

function controlled(text: string, sequence: number, value: string, operation: 'set' | 'remove' | 'clear' = 'set',
  temporal: 'current' | 'historical' = 'current', application: 'organization' | 'source-room' = 'organization') {
  return parseMemoryFacts(JSON.stringify({ facts: [{ kind: 'controlled', property: 'person.address', subject: 'source-actor',
    temporal, operation, ...(operation === 'clear' ? {} : { value }), application: { kind: application,
      evidence: application === 'organization' ? '公司所有群聊和工作交流中' : '本群' }, sourceQuote: text, assertionKind: 'human-explicit' }] }),
  input(text, sequence), `audit-${sequence}-${operation}-${temporal}-${value}`)
}

function extracted(text: string, sequence: number, facts: readonly Record<string, unknown>[], source = input(text, sequence)) {
  return parseMemoryFacts(JSON.stringify({ facts }), source, `audit-${sequence}`)
}

function stateFor(rows: readonly { text: string; sequence: number }[], owned: readonly number[] = rows.map(row => row.sequence)): WorkspaceState {
  return { ...createInitialState(WorkspaceId('local')), nextSequence: Math.max(...rows.map(row => row.sequence)) + 1,
    events: rows.map(row => ({ id: WorkspaceEventId(`event-${row.sequence}`), type: 'room/message' as const,
      sequence: row.sequence, subjectId: RoomId('room-5'), actor: { type: 'human' as const, id: HumanId('web-user') }, text: row.text })),
    memoryEntries: owned.map(sequence => ({ id: AgentMemoryEntryId(`entry-${sequence}`), agentId: AgentId('alice'),
      eventId: WorkspaceEventId(`event-${sequence}`), acquiredBy: 'room-membership' as const })) }
}

function state(owned: readonly number[]): WorkspaceState {
  const sources = [{ text: addressA, sequence: 7 }, { text: addressB, sequence: 11 }]
  return { ...createInitialState(WorkspaceId('local')), nextSequence: 12,
    events: sources.map(source => ({ id: WorkspaceEventId(`event-${source.sequence}`), type: 'room/message' as const,
      sequence: source.sequence, subjectId: RoomId('room-5'), actor: { type: 'human' as const, id: HumanId('web-user') }, text: source.text })),
    memoryEntries: owned.map(sequence => ({ id: AgentMemoryEntryId(`entry-${sequence}`), agentId: AgentId('alice'),
      eventId: WorkspaceEventId(`event-${sequence}`), acquiredBy: 'room-membership' as const })) }
}

function scene(): MemoryScene {
  return { source: { kind: 'room', roomId: RoomId('room-6') }, actor: { type: 'human', id: HumanId('web-user') },
    triggerEventId: WorkspaceEventId('event-11'), admissionSequence: 11, query: '现在知道了吗？',
    organization: { id: WorkspaceId('local'), name: 'Org' }, colleagues: [] }
}

test('v2 binds company-wide address updates to one controlled organization property', () => {
  const first = parseMemoryFacts(JSON.stringify({ facts: [{ kind: 'controlled', property: 'person.address', subject: 'source-actor',
    temporal: 'current', operation: 'set', value: '林老师', application: { kind: 'organization', evidence: '公司所有群聊和工作交流中' },
    sourceQuote: addressA, assertionKind: 'human-explicit' }] }), input(addressA, 7), 'audit-a')
  const second = parseMemoryFacts(JSON.stringify({ facts: [
    { kind: 'controlled', property: 'person.address', subject: 'source-actor', temporal: 'current', operation: 'set', value: '方老师',
      application: { kind: 'organization', evidence: '公司所有群聊和工作交流中' }, sourceQuote: addressB, assertionKind: 'human-explicit' },
    { kind: 'controlled', property: 'person.address', subject: 'source-actor', temporal: 'historical', operation: 'set', value: '林老师',
      application: { kind: 'organization', evidence: '公司所有群聊和工作交流中' }, sourceQuote: addressB, assertionKind: 'human-explicit' },
  ] }), input(addressB, 11), 'audit-b')
  expect(first[0]).toMatchObject({ kind: 'controlled', property: 'person.address', key: 'person.address', category: 'address',
    subject: 'human:web-user', scope: { organizationId: 'local' }, value: '林老师', temporal: 'current', operation: 'set' })
  expect(second.map(fact => [fact.key, fact.value, fact.temporal, fact.scope.roomId])).toEqual([
    ['person.address', '方老师', 'current', undefined], ['person.address', '林老师', 'historical', undefined],
  ])
})

test('captured provider output retains valid B while rejecting its unsupported historical sibling', () => {
  const captured = '{"facts":[{"kind":"controlled","property":"person.address","subject":"source-actor","temporal":"current","operation":"set","value":"方老师","application":{"kind":"organization","evidence":"公司所有群聊和工作交流"},"sourceQuote":"公司所有群聊和工作交流中的称呼改为方老师","assertionKind":"human-explicit"},{"kind":"controlled","property":"person.address","subject":"source-actor","temporal":"historical","operation":"set","value":"林老师","application":{"kind":"organization","evidence":"公司所有群聊和工作交流"},"sourceQuote":"先前约定的林老师称呼是旧称呼","assertionKind":"human-explicit"}]}'
  const a = controlled(addressA, 7, '林老师')[0]!
  const parsed = parseMemoryFactsIndividually(captured, input(addressB, 11), 'captured-b')
  const projected = projectMemoryFacts(state([7, 11]), AgentId('alice'), scene(), [a, ...parsed.facts])
  expect(parsed.errors).toEqual(['Fact application evidence is outside its quotation'])
  expect(parsed.facts.map(fact => fact.value)).toEqual(['方老师'])
  expect(projected.map(fact => [fact.value, fact.status])).toEqual([['方老师', 'current']])
  expect(projected[0]?.supersedesFactIds).toEqual([a.id])
})

test('v2 rejects free controlled keys and unsupported source/application evidence', () => {
  const source = input(addressA, 7)
  const valid = { kind: 'controlled', property: 'person.address', subject: 'source-actor', temporal: 'current', operation: 'set',
    value: '林老师', application: { kind: 'organization', evidence: '公司所有群聊和工作交流中' }, sourceQuote: addressA, assertionKind: 'human-explicit' }
  for (const candidate of [
    { ...valid, key: 'preferred-address' },
    { ...valid, property: 'preferred-address' },
    { ...valid, application: { kind: 'source-task', evidence: '公司所有群聊和工作交流中' } },
    { ...valid, application: { kind: 'organization', evidence: 'all rooms' } },
    { ...valid, sourceQuote: 'not in the original' },
  ]) expect(() => parseMemoryFacts(JSON.stringify({ facts: [candidate] }), source, 'audit')).toThrow()
})

test('v2 retains source-anchored standing agreements without inventing a free property key', () => {
  const text = '周报的发送时间改为周二；内容格式保持表格。'
  const facts = parseMemoryFacts(JSON.stringify({ facts: [{ kind: 'anchored', anchoredKind: 'standing-agreement',
    subject: 'source-actor', topicQuote: '周报', facetQuote: '发送时间', conditionQuotes: [], temporal: 'current', operation: 'set',
    value: '周二', application: { kind: 'organization', evidence: '周报的发送时间改为周二' },
    sourceQuote: text, assertionKind: 'human-explicit' }] }), input(text, 3), 'audit')
  expect(facts[0]).toMatchObject({ kind: 'anchored', category: 'agreement', topic: '周报', facet: '发送时间', value: '周二',
    scope: { organizationId: 'local' }, status: 'candidate' })
})

test('v2 chooses later organization address by source sequence and withdrawal recomputes prior value', () => {
  const a = controlled(addressA, 7, '林老师')[0]!
  const b = controlled(addressB, 11, '方老师')[0]!
  const historical = controlled(addressB, 11, '林老师', 'set', 'historical')[0]!
  const current = projectMemoryFacts(state([7, 11]), AgentId('alice'), scene(), [historical, b, a])
  expect(current.map(fact => [fact.value, fact.status, fact.scope.roomId])).toEqual([['方老师', 'current', undefined]])
  expect(current[0]?.supersedesFactIds).toEqual([a.id])
  expect(projectMemoryFacts(state([7]), AgentId('alice'), scene(), [a, b, historical]).map(fact => fact.value)).toEqual(['林老师'])
  expect(projectMemoryFacts(state([11]), AgentId('alice'), scene(), [a, b, historical]).map(fact => fact.value)).toEqual(['方老师'])
})

test('a newer removal of old A does not clear current B, while clear blocks A fallback', () => {
  const a = controlled(addressA, 7, '林老师')[0]!
  const b = controlled(addressB, 11, '方老师')[0]!
  const removeA = controlled(addressB, 11, '林老师', 'remove')[0]!
  expect(projectMemoryFacts(state([7, 11]), AgentId('alice'), scene(), [a, b, removeA]).map(fact => [fact.value, fact.status]))
    .toEqual([['方老师', 'current'], ['林老师', 'removed']])
  const cleared = controlled(addressB, 11, '', 'clear')[0]!
  const afterClear = projectMemoryFacts(state([7, 11]), AgentId('alice'), scene(), [a, cleared])
  expect(afterClear.map(fact => [fact.status, fact.value])).toEqual([['removed', '']])
  expect(afterClear[0]?.sourceEventIds).toEqual([WorkspaceEventId('event-11')])
})

test('inconsistent same-source operations stay unresolved rather than letting array order win', () => {
  const a = controlled(addressA, 7, '林老师')[0]!
  const b = controlled(addressB, 11, '方老师')[0]!
  const contradictory = controlled(addressB, 11, '另一称呼')[0]!
  for (const candidates of [[a, b, contradictory], [contradictory, a, b]]) {
    const projected = projectMemoryFacts(state([7, 11]), AgentId('alice'), scene(), candidates)
    expect(projected.map(fact => fact.status)).toEqual(['unresolved'])
    expect(projected[0]?.sourceEventIds).toContain(WorkspaceEventId('event-11'))
  }
})

test('logged scene core labels current B and source dependencies without claiming historical A is current', () => {
  const a = controlled(addressA, 7, '林老师')[0]!
  const b = controlled(addressB, 11, '方老师')[0]!
  const historical = controlled(addressB, 11, '林老师', 'set', 'historical')[0]!
  const snapshot = state([7, 11])
  const prepared = prepareSceneMemory(snapshot, { agentId: AgentId('alice'), contextGeneration: 0, scene: scene(), coverage: [],
    facts: [a, b, historical], limits: { sceneCharacters: 800, newCharacters: 0, coreCharacters: 600, historyCharacters: 0,
      itemCharacters: 500, recentConversationLimit: 0, factLimit: 4, historyLimit: 0 } })
  expect(prepared.layers.core.rendered).toContain('status:current')
  expect(prepared.layers.core.rendered).toContain('方老师')
  expect(prepared.layers.core.rendered).not.toContain('person.address="林老师"')
  expect(prepared.layers.core.eventIds).toContain(WorkspaceEventId('event-11'))
  expect(prepared.rendered).toContain('source events:2 omitted')
  expect(prepared.rendered).toContain('workspace_read_memory')
})

test('explicit use-language qualifiers stay separate from each other and from communication language', () => {
  const address = '在公司所有群聊，中文交流时请叫我云姐，英文交流时请叫我 Captain Nebula。'
  const language = '在公司所有群聊，邮件请用英语。'
  const names = extracted(address, 1, [
    { kind: 'controlled', property: 'person.address', subject: 'source-actor', temporal: 'current', operation: 'set',
      value: '云姐', application: { kind: 'organization', evidence: '公司所有群聊' }, sourceQuote: address,
      qualifier: { kind: 'use-language', tag: 'zh', sourceQuote: '中文交流时' }, assertionKind: 'human-explicit' },
    { kind: 'controlled', property: 'person.address', subject: 'source-actor', temporal: 'current', operation: 'set',
      value: 'Captain Nebula', application: { kind: 'organization', evidence: '公司所有群聊' }, sourceQuote: address,
      qualifier: { kind: 'use-language', tag: 'en', sourceQuote: '英文交流时' }, assertionKind: 'human-explicit' },
  ])
  const languageFact = extracted(language, 2, [{ kind: 'controlled', property: 'communication.language', subject: 'source-actor',
    temporal: 'current', operation: 'set', value: 'English', application: { kind: 'organization', evidence: '公司所有群聊' },
    sourceQuote: language, assertionKind: 'human-explicit' }])
  const snapshot = stateFor([{ text: address, sequence: 1 }, { text: language, sequence: 2 }])
  const current = projectMemoryFacts(snapshot, AgentId('alice'), { ...scene(), triggerEventId: WorkspaceEventId('event-2'),
    admissionSequence: 2 }, [...names, ...languageFact])
  expect(current.map(fact => [fact.value, fact.status])).toEqual([
    ['English', 'current'], ['云姐', 'conditional'], ['Captain Nebula', 'conditional'],
  ])
  expect(current.filter(fact => fact.kind === 'controlled').map(fact => fact.property)).toEqual([
    'communication.language', 'person.address', 'person.address',
  ])
})

test('anchored agreement updates an exact facet without erasing other facets, while unmatched topics remain unresolved core', () => {
  const first = '公司所有群聊的周报发送时间定为周一，内容格式用表格。'
  const update = '公司所有群聊的周报发送时间改为周二。'
  const short = '公司所有群聊的回复长度保持简短。'
  const long = '公司所有群聊的答复篇幅以后换成详细一些。'
  const ellipsis = '公司所有群聊以后换成周三。'
  const anchored = (text: string, sequence: number, topicQuote: string | undefined, facetQuote: string | undefined,
    value: string, anchoredKind: 'preference' | 'standing-agreement' = 'standing-agreement') => extracted(text, sequence, [{
    kind: 'anchored', anchoredKind, subject: 'source-actor', ...(topicQuote === undefined ? {} : { topicQuote }),
    ...(facetQuote === undefined ? {} : { facetQuote }), conditionQuotes: [], temporal: 'current', operation: 'set', value,
    application: { kind: 'organization', evidence: '公司所有群聊' }, sourceQuote: text, assertionKind: 'human-explicit',
  }])[0]!
  const sendA = anchored(first, 1, '周报', '发送时间', '周一')
  const format = anchored(first, 1, '周报', '内容格式', '表格')
  const sendB = anchored(update, 2, '周报', '发送时间', '周二')
  const shortFact = anchored(short, 3, '回复长度', undefined, '简短', 'preference')
  const longFact = anchored(long, 4, '答复篇幅', undefined, '详细一些', 'preference')
  const unknown = anchored(ellipsis, 5, undefined, undefined, '周三')
  const rows = [first, update, short, long, ellipsis].map((text, index) => ({ text, sequence: index + 1 }))
  const snapshot = stateFor(rows)
  const current = projectMemoryFacts(snapshot, AgentId('alice'), { ...scene(), triggerEventId: WorkspaceEventId('event-5'),
    admissionSequence: 5 }, [longFact, sendB, format, unknown, sendA, shortFact])
  expect(current.filter(fact => fact.status === 'current').map(fact => fact.value)).toEqual(['周二', '表格'])
  expect(current.filter(fact => fact.status === 'unresolved').map(fact => fact.value).sort()).toEqual(['', '简短', '详细一些'].sort())
  expect(current.find(fact => fact.value === '周二')?.supersedesFactIds).toEqual([sendA.id])
  expect(projectMemoryFacts(stateFor(rows, [1, 3, 4, 5]), AgentId('alice'), { ...scene(),
    triggerEventId: WorkspaceEventId('event-5'), admissionSequence: 5 }, [sendA, sendB, format, shortFact, longFact, unknown])
    .map(fact => fact.value)).toContain('周一')
})

test('a local clear blocks the general address without deleting it, and an ended task exception is inapplicable', () => {
  const generalText = '在公司所有群聊请叫我云姐。'
  const roomText = '在本群取消称呼约定。'
  const taskText = '在此任务中请叫我项目负责人。'
  const general = extracted(generalText, 1, [{ kind: 'controlled', property: 'person.address', subject: 'source-actor',
    temporal: 'current', operation: 'set', value: '云姐', application: { kind: 'organization', evidence: '公司所有群聊' },
    sourceQuote: generalText, assertionKind: 'human-explicit' }])[0]!
  const cleared = extracted(roomText, 2, [{ kind: 'controlled', property: 'person.address', subject: 'source-actor',
    temporal: 'current', operation: 'clear', application: { kind: 'source-room', evidence: '本群' },
    sourceQuote: roomText, assertionKind: 'human-explicit' }])[0]!
  const taskScope = { organizationId: WorkspaceId('local'), taskId: TaskId('task-1') }
  const task = extracted(taskText, 3, [{ kind: 'controlled', property: 'person.address', subject: 'source-actor',
    temporal: 'current', operation: 'set', value: '项目负责人', application: { kind: 'source-task', evidence: '此任务中' },
    sourceQuote: taskText, assertionKind: 'human-explicit' }], { ...input(taskText, 3), scope: taskScope })[0]!
  const rows = [generalText, roomText, taskText].map((text, index) => ({ text, sequence: index + 1 }))
  const snapshot = { ...stateFor(rows), tasks: { [TaskId('task-1')]: { id: TaskId('task-1'), rootTaskId: TaskId('task-1'),
    title: 'Former project', status: 'cancelled' as const } } }
  const roomScene = { ...scene(), source: { kind: 'room' as const, roomId: RoomId('room-5') },
    triggerEventId: WorkspaceEventId('event-3'), admissionSequence: 3 }
  expect(projectMemoryFacts(snapshot, AgentId('alice'), roomScene, [general, cleared, task]).map(fact => [fact.value, fact.status]))
    .toEqual([['云姐', 'default'], ['', 'removed']])
  const taskScene = { ...scene(), source: { kind: 'task' as const, taskId: TaskId('task-1'),
    attemptId: TaskDeliveryAttemptId('attempt-1') }, triggerEventId: WorkspaceEventId('event-3'), admissionSequence: 3 }
  expect(projectMemoryFacts(snapshot, AgentId('alice'), taskScene, [general, cleared, task]).map(fact => fact.value)).toEqual(['云姐'])
})
