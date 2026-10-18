import { expect, test } from 'vitest'
import { MemoryProcessor, sourceDigest } from '../packages/host/src/memory-processor.ts'
import type { MemoryAudit, MemoryProjection, MemoryTable } from '../packages/host/src/memory-projection.ts'
import { memoryAuditSpec } from '../packages/host/src/memory-projection.ts'
import { AgentId, AgentMemoryEntryId, HumanId, RoomId, WorkspaceEventId, WorkspaceId } from '../packages/host/src/ids.ts'
import { createInitialState } from '../packages/host/src/state.ts'
import type { WorkspaceState } from '../packages/host/src/types.ts'
import { prepareSceneMemory } from '../packages/host/src/scene-memory.ts'

function table<T>(): MemoryTable<T> {
  const values = new Map<string, T>()
  return { get: key => values.get(key), entries: () => values.entries(), put: async (key, value) => { values.set(key, value) } }
}
const agentId = AgentId('alice')
function fixture() {
  const event = { id: WorkspaceEventId('source'), type: 'room/message' as const, sequence: 1,
    subjectId: RoomId('team'), actor: { type: 'human' as const, id: HumanId('owner') }, text: '在本群请叫我邵老师。后面是未读的长文。' }
  let state: WorkspaceState = { ...createInitialState(WorkspaceId('org')), nextSequence: 2, events: [event],
    memoryEntries: [{ id: AgentMemoryEntryId('entry'), agentId, eventId: event.id, acquiredBy: 'room-membership' }] }
  const audit = table<MemoryAudit>(), projection = table<MemoryProjection>()
  const source = { workspaceId: state.workspaceId, event, start: 0, end: 11, text: event.text.slice(0, 11) }
  const output = JSON.stringify({ facts: [{ kind: 'controlled', property: 'person.address', subject: 'owner', temporal: 'current',
    operation: 'set', value: '邵老师', application: { kind: 'source-room', evidence: '本群' },
    sourceQuote: '在本群请叫我邵老师。', assertionKind: 'human-explicit' }] })
  return { event, source, audit, projection, output, snapshot: () => state,
    reviseText: (text: string) => { const revised = { ...event, text }; state = { ...state, events: [revised] }; return revised },
    revise: () => { state = { ...state, revision: state.revision + 1 } }, revoke: () => { state = { ...state, events: [], memoryEntries: [] } } }
}
const route = { provider: 'configured', model: 'selected' }

test('v1 raw audit remains untouched while only on-use v2 extraction rebuilds current core', async () => {
  const f = fixture()
  const input = { workspaceId: f.source.workspaceId, eventId: f.event.id, sequence: f.event.sequence,
    actor: f.event.actor, scope: { organizationId: f.source.workspaceId, roomId: f.event.subjectId },
    start: f.source.start, end: f.source.end, totalCharacters: f.event.text.length, text: f.source.text, sourceDigest: sourceDigest(f.event) }
  const oldOutput = JSON.stringify({ facts: [{ category: 'preference', subject: 'owner', key: 'preferred-address', value: '邵老师',
    scope: { organizationId: 'org', roomId: 'team' }, sourceQuote: '请叫我邵老师', assertionKind: 'human-explicit' }] })
  const legacy: MemoryAudit = { version: 1, extractionVersion: 1, id: 'legacy-audit', input, provider: route.provider, model: route.model,
    parameters: '{}', system: 'Agent Workspace source fact extraction v1. Return only the requested JSON.', prompt: 'legacy prompt',
    status: 'completed', output: oldOutput, stream: '["old stream"]' }
  const oldBytes = JSON.stringify(legacy)
  await f.audit.put(legacy.id, legacy)
  await f.projection.put('legacy-cache', { version: 1, auditId: legacy.id, input, output: oldOutput })
  let calls = 0
  const processor = new MemoryProcessor({ snapshot: f.snapshot, audit: f.audit, projection: f.projection,
    extract: async () => { calls++; return { text: f.output, stream: '[]' } } })
  expect(processor.facts(f.snapshot(), agentId)).toEqual([])
  expect(processor.progress(f.snapshot(), agentId)[0]?.status).toBe('unprocessed')
  await processor.process(f.source, route)
  expect(calls).toBe(1)
  expect(JSON.stringify(f.audit.get(legacy.id))).toBe(oldBytes)
  expect([...f.audit.entries()].map(([, audit]) => audit.extractionVersion)).toEqual([1, 2])
  expect([...f.projection.entries()].map(([, projection]) => projection.version)).toEqual([1, 2])
  expect(processor.facts(f.snapshot(), agentId).map(fact => fact.value)).toEqual(['邵老师'])
})

async function settlesWithin(promise: Promise<void>): Promise<boolean> {
  let guard: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise.then(() => true), new Promise<boolean>(resolve => { guard = setTimeout(() => resolve(false), 2000) })])
  } finally { if (guard !== undefined) clearTimeout(guard) }
}

test('shares extraction across colleagues and persists settlement before publishing a partial fact', async () => {
  const f = fixture()
  let calls = 0
  const processor = new MemoryProcessor({ snapshot: f.snapshot, audit: f.audit, projection: f.projection,
    extract: async request => { calls++; expect([...f.audit.entries()][0]?.[1].status).toBe('pending'); expect(request.provider).toBe('configured'); return { text: f.output, stream: '[]' } } })
  await Promise.all([processor.process(f.source, route), processor.process(f.source, route)])
  expect(calls).toBe(1)
  expect([...f.audit.entries()][0]?.[1].status).toBe('completed')
  expect(processor.facts(f.snapshot(), agentId)[0]?.value).toBe('邵老师')
  expect(processor.progress(f.snapshot(), agentId)[0]?.status).toBe('partial')
  expect(processor.facts(f.snapshot(), AgentId('stranger'))).toEqual([])
})

test('a failed pre-extraction audit read settles without rejecting an ignored observer flight', async () => {
  const f = fixture()
  const audit: MemoryTable<MemoryAudit> = { ...f.audit, entries: () => { throw new Error('audit read unavailable') } }
  const processor = new MemoryProcessor({ snapshot: f.snapshot, audit, projection: f.projection,
    extract: async () => ({ text: f.output, stream: '[]' }) })
  await expect(processor.process(f.source, route)).resolves.toBeUndefined()
  expect([...f.audit.entries()].at(-1)?.[1]).toMatchObject({ status: 'failed', error: 'audit read unavailable' })
})

test('metadata lookup failure is saved as a failed audit without dispatching extraction', async () => {
  const f = fixture()
  let dispatched = false
  const processor = new MemoryProcessor({ snapshot: f.snapshot, audit: f.audit, projection: f.projection,
    resolveParameters: async () => { throw new Error('model metadata unavailable') },
    extract: async () => { dispatched = true; return { text: f.output, stream: '[]' } } })
  await expect(processor.process(f.source, { ...route, parameters: '{"maxTokens":2048}' })).resolves.toBeUndefined()
  expect(dispatched).toBe(false)
  expect([...f.audit.entries()][0]?.[1]).toMatchObject({ status: 'failed', error: 'model metadata unavailable', parameters: '{"maxTokens":2048}' })
})

test('stop during asynchronous metadata lookup discards the attempt before any model dispatch', async () => {
  const f = fixture(), lookup = Promise.withResolvers<string>()
  let metadataSignal: AbortSignal | undefined
  let dispatched = false
  const processor = new MemoryProcessor({ snapshot: f.snapshot, audit: f.audit, projection: f.projection,
    resolveParameters: async (_route, signal) => { metadataSignal = signal; return await lookup.promise },
    extract: async () => { dispatched = true; return { text: f.output, stream: '[]' } } })
  const running = processor.process(f.source, route)
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(metadataSignal).toBeDefined()
    const stopping = processor.stop()
    expect(metadataSignal?.aborted).toBe(true)
    lookup.resolve('{"maxTokens":2048,"reasoningEffort":"off"}')
    await Promise.all([running, stopping])
    expect(dispatched).toBe(false)
    expect([...f.audit.entries()][0]?.[1].status).toBe('discarded')
    expect([...f.projection.entries()]).toHaveLength(0)
  } finally { lookup.resolve('{"maxTokens":2048,"reasoningEffort":"off"}'); await running }
})

test.each(['resolve', 'reject'] as const)('stop settles while metadata lookup ignores abort and later %ss', async late => {
  const f = fixture(), lookup = Promise.withResolvers<string>(), started = Promise.withResolvers<void>()
  let lookupCalls = 0, dispatched = 0
  const processor = new MemoryProcessor({ snapshot: f.snapshot, audit: f.audit, projection: f.projection,
    resolveParameters: async () => { lookupCalls++; if (lookupCalls === 1) { started.resolve(); return await lookup.promise } return '{"maxTokens":2048}' },
    extract: async () => { dispatched++; return { text: f.output, stream: '[]' } } })
  const running = processor.process(f.source, route)
  await started.promise
  try {
    const stopping = processor.stop()
    expect(await settlesWithin(stopping)).toBe(true)
    await Promise.all([running, stopping])
    expect([...f.audit.entries()].map(([, audit]) => audit.status)).toEqual(['discarded'])
    expect(dispatched).toBe(0)
    processor.reopen()
    if (late === 'resolve') lookup.resolve('{"maxTokens":2048,"reasoningEffort":"off"}')
    else lookup.reject(new Error('late metadata failure'))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect([...f.audit.entries()].map(([, audit]) => audit.status)).toEqual(['discarded'])
    expect([...f.projection.entries()]).toHaveLength(0)
    await processor.process(f.source, route)
    expect(dispatched).toBe(1)
    expect(lookupCalls).toBe(2)
  } finally { lookup.resolve('{"maxTokens":2048}'); await running }
})

test('configured extraction timeout bounds a metadata lookup that never resolves', async () => {
  const f = fixture(), started = Promise.withResolvers<void>()
  let dispatched = false
  const processor = new MemoryProcessor({ snapshot: f.snapshot, audit: f.audit, projection: f.projection,
    metadataTimeoutMs: 20,
    resolveParameters: async () => { started.resolve(); return await new Promise<string>(() => {}) },
    extract: async () => { dispatched = true; return { text: f.output, stream: '[]' } } })
  const running = processor.process(f.source, route)
  await started.promise
  expect(await settlesWithin(running)).toBe(true)
  expect(dispatched).toBe(false)
  expect([...f.audit.entries()][0]?.[1]).toMatchObject({ status: 'failed', error: 'Memory extraction timed out' })
})

test('rejects quotations outside the exact fragment and never upgrades an agent assertion', async () => {
  const f = fixture()
  const processor = new MemoryProcessor({ snapshot: f.snapshot, audit: f.audit, projection: f.projection,
    extract: async () => ({ text: f.output.replace('请叫我邵老师', '未读的长文'), stream: '[]' }) })
  await processor.process(f.source, route)
  expect(processor.facts(f.snapshot(), agentId)).toEqual([])
  expect(processor.progress(f.snapshot(), agentId)[0]?.status).toBe('failed')
  const actorSource = { ...f.source, event: { ...f.event, actor: { type: 'agent' as const, id: agentId } } }
  const state = { ...f.snapshot(), events: [actorSource.event] }
  const other = new MemoryProcessor({ snapshot: () => state, audit: table(), projection: table(), extract: async () => ({ text: f.output.replace('"owner"', '"source-actor"'), stream: '[]' }) })
  await other.process(actorSource, route)
  expect(other.facts(state, agentId)[0]?.assertionKind).toBe('inferred')
})

test.each(['withdrawal', 'closure'] as const)('fences late settlement after %s', async mode => {
  const f = fixture()
  const started = Promise.withResolvers<void>(), result = Promise.withResolvers<{ text: string; stream: string }>()
  const processor = new MemoryProcessor({ snapshot: f.snapshot, audit: f.audit, projection: f.projection,
    extract: async () => { started.resolve(); return result.promise } })
  const running = processor.process(f.source, route)
  await started.promise
  if (mode === 'withdrawal') f.revoke(); else processor.close()
  result.resolve({ text: f.output, stream: '[]' })
  await running
  expect(processor.facts(f.snapshot(), agentId)).toEqual([])
  expect([...f.projection.entries()]).toHaveLength(0)
})

test('restored projection refuses withdrawn source and extraction failure stays isolated', async () => {
  const f = fixture()
  const processor = new MemoryProcessor({ snapshot: f.snapshot, audit: f.audit, projection: f.projection,
    extract: async () => ({ text: f.output, stream: '[]' }) })
  await processor.process(f.source, route)
  f.revoke()
  const restored = new MemoryProcessor({ snapshot: f.snapshot, audit: f.audit, projection: f.projection, extract: async () => { throw new Error('offline') } })
  expect(restored.facts(f.snapshot(), agentId)).toEqual([])
  await expect(restored.process(f.source, route)).resolves.toBeUndefined()
})

test('raw settlement is durable before exposure and an unrelated revision does not discard it', async () => {
  const f = fixture(), writing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const audit: MemoryTable<MemoryAudit> = { ...f.audit, put: async (id, value) => {
    if (value.status === 'completed') { writing.resolve(); await release.promise }
    await f.audit.put(id, value)
  } }
  const processor = new MemoryProcessor({ snapshot: f.snapshot, audit, projection: f.projection, extract: async () => ({ text: f.output, stream: '["raw"]' }) })
  const pending = processor.process(f.source, route)
  await writing.promise
  expect(processor.facts(f.snapshot(), agentId)).toEqual([])
  f.revise(); release.resolve(); await pending
  expect(processor.facts(f.snapshot(), agentId)[0]?.value).toBe('邵老师')
  expect([...f.audit.entries()][0]?.[1].stream).toBe('["raw"]')
})

test('failed extraction leaves the new original usable and marks failure without fabricated facts', async () => {
  const f = fixture()
  const processor = new MemoryProcessor({ snapshot: f.snapshot, audit: f.audit, projection: f.projection, extract: async () => { throw new Error('offline') } })
  await processor.process(f.source, route)
  expect(processor.progress(f.snapshot(), agentId)[0]?.status).toBe('failed')
  const prepared = prepareSceneMemory(f.snapshot(), { agentId, contextGeneration: 0, coverage: [], facts: processor.facts(f.snapshot(), agentId),
    scene: { source: { kind: 'room', roomId: RoomId('team') }, actor: f.event.actor, triggerEventId: f.event.id, admissionSequence: 1, query: '现在呢', organization: { id: f.source.workspaceId, name: 'Org' }, colleagues: [] },
    limits: { sceneCharacters: 1000, newCharacters: 500, coreCharacters: 500, historyCharacters: 500, itemCharacters: 500, recentConversationLimit: 3, factLimit: 3, historyLimit: 3 } })
  expect(prepared.layers.new.rendered).toContain('请叫我邵老师')
  expect(prepared.layers.core.eventIds).toEqual([])
})

test.each(['', '{"facts":['])('provider failure with %j output remains retryable on the next exposure', async partial => {
  const f = fixture()
  let calls = 0
  const processor = new MemoryProcessor({ snapshot: f.snapshot, audit: f.audit, projection: f.projection,
    extract: async () => ++calls === 1 ? { text: partial, stream: '["interrupted"]', error: 'temporary network failure' }
      : { text: f.output, stream: '["completed"]' } })
  await processor.process(f.source, route)
  expect(processor.has(f.source)).toBe(false)
  expect(processor.progress(f.snapshot(), agentId)[0]?.status).toBe('failed')
  await processor.process(f.source, route)
  expect(processor.facts(f.snapshot(), agentId).map(fact => fact.value)).toEqual(['邵老师'])
  expect([...f.audit.entries()].map(([, audit]) => audit.status)).toEqual(['failed', 'completed'])
})

test('unclassified retained v2 failure is retried without changing its saved raw output', async () => {
  const f = fixture()
  const seed = new MemoryProcessor({ snapshot: f.snapshot, audit: f.audit, projection: f.projection,
    extract: async () => ({ text: f.output, stream: '[]' }) })
  await seed.process(f.source, route)
  const [, successful] = [...f.audit.entries()][0]!
  const retained: MemoryAudit = { ...successful, id: 'old-v2-failure', status: 'failed', output: '{', error: 'old unclassified failure' }
  const audit = table<MemoryAudit>()
  await audit.put(retained.id, retained)
  const saved = JSON.stringify(retained)
  const restored = new MemoryProcessor({ snapshot: f.snapshot, audit, projection: table(),
    extract: async () => ({ text: f.output, stream: '[]' }) })
  await restored.process(f.source, route)
  expect(restored.facts(f.snapshot(), agentId).map(fact => fact.value)).toEqual(['邵老师'])
  expect(JSON.stringify(audit.get(retained.id))).toBe(saved)
})

test('restored deterministic rejection is already handled but remains a failed personal diagnostic', async () => {
  const f = fixture()
  const processor = new MemoryProcessor({ snapshot: f.snapshot, audit: f.audit, projection: f.projection,
    extract: async () => ({ text: '{', stream: '["completed"]' }) })
  await processor.process(f.source, route)
  const restored = new MemoryProcessor({ snapshot: f.snapshot, audit: f.audit, projection: table(),
    extract: async () => ({ text: f.output, stream: '[]' }) })
  expect(restored.has(f.source)).toBe(true)
  await restored.process(f.source, route)
  expect([...f.audit.entries()]).toHaveLength(1)
  expect(restored.progress(f.snapshot(), agentId)[0]?.status).toBe('failed')
  expect(restored.facts(f.snapshot(), agentId)).toEqual([])
})

test('audit decoding retains old protocol records and explicitly classified v2 failures', async () => {
  const f = fixture()
  const processor = new MemoryProcessor({ snapshot: f.snapshot, audit: f.audit, projection: f.projection,
    extract: async () => ({ text: f.output, stream: '[]' }) })
  await processor.process(f.source, route)
  const [, record] = [...f.audit.entries()][0]!
  const schema = memoryAuditSpec.tables.requests.valueSchema
  for (const extractionVersion of [1, 2]) {
    const retained = { ...record, extractionVersion, status: 'failed', output: '{', error: 'old failure' }
    expect(schema.parse(JSON.parse(JSON.stringify(retained)))).toEqual(retained)
  }
  for (const failureKind of ['retryable', 'validation']) {
    const classified = { ...record, status: 'failed', failureKind, output: '{', error: 'classified failure' }
    expect(schema.parse(JSON.parse(JSON.stringify(classified)))).toEqual(classified)
  }
  expect(schema.safeParse({ ...record, status: 'failed', failureKind: 'unrecognized' }).success).toBe(false)
})

test('the captured provider omission remains visible and is not dispatched again for the same source version', async () => {
  const f = fixture()
  let calls = 0
  // Exact candidate recorded for synthetic event-7 in the 2026-10-17 provider evaluation.
  const invalid = '{"facts":[{"kind":"anchored","subject":"source-actor","temporal":"current","operation":"set","anchoredKind":"preference","topicQuote":"请称呼我为林老师","facetQuote":"称呼我","assertionKind":"human-explicit","application":{"kind":"organization","evidence":"在公司所有群聊和工作交流中"}}]}'
  const processor = new MemoryProcessor({ snapshot: f.snapshot, audit: f.audit, projection: f.projection,
    extract: async () => { calls++; return { text: invalid, stream: '[]' } } })
  await processor.process(f.source, route)
  await processor.process(f.source, route)
  expect(calls).toBe(1)
  expect([...f.audit.entries()][0]?.[1].error).toContain('sourceQuote')
  expect([...f.audit.entries()][0]?.[1].error).toContain('conditionQuotes')
  expect(processor.progress(f.snapshot(), agentId)[0]?.status).toBe('failed')
  expect(processor.facts(f.snapshot(), agentId)).toEqual([])
})

test('a captured output keeps independently valid facts while rejecting unsupported organization evidence', async () => {
  const f = fixture()
  const text = '公司所有群聊和工作交流中的称呼改为方老师；先前约定的林老师称呼是旧称呼。'
  const event = f.reviseText(text)
  const source = { ...f.source, event, end: text.length, text }
  const captured = '{"facts":[{"kind":"controlled","property":"person.address","subject":"source-actor","temporal":"current","operation":"set","value":"方老师","application":{"kind":"organization","evidence":"公司所有群聊和工作交流"},"sourceQuote":"公司所有群聊和工作交流中的称呼改为方老师","assertionKind":"human-explicit"},{"kind":"controlled","property":"person.address","subject":"source-actor","temporal":"historical","operation":"set","value":"林老师","application":{"kind":"organization","evidence":"公司所有群聊和工作交流"},"sourceQuote":"先前约定的林老师称呼是旧称呼","assertionKind":"human-explicit"}]}'
  let calls = 0
  const processor = new MemoryProcessor({ snapshot: f.snapshot, audit: f.audit, projection: f.projection,
    extract: async () => { calls++; return { text: captured, stream: '[]' } } })
  await processor.process(source, route)
  await processor.process(source, route)
  expect(calls).toBe(1)
  expect([...f.audit.entries()][0]?.[1].error).toBe('Fact application evidence is outside its quotation')
  expect(processor.progress(f.snapshot(), agentId)[0]?.status).toBe('failed')
  expect(processor.facts(f.snapshot(), agentId).map(fact => fact.value)).toEqual(['方老师'])
  const restored = new MemoryProcessor({ snapshot: f.snapshot, audit: f.audit, projection: table<MemoryProjection>(),
    extract: async () => { calls++; return { text: captured, stream: '[]' } } })
  await restored.process(source, route)
  expect(calls).toBe(1)
  expect(restored.facts(f.snapshot(), agentId).map(fact => fact.value)).toEqual(['方老师'])
  expect(restored.progress(f.snapshot(), agentId)[0]?.status).toBe('failed')
})

test('a rejected source does not suppress a changed source or another exposed fragment', async () => {
  const f = fixture()
  let calls = 0
  const invalid = JSON.stringify({ facts: [{ kind: 'controlled', property: 'person.address', subject: 'source-actor',
    temporal: 'current', operation: 'set', value: '邵老师', application: { kind: 'source-room', evidence: '本群' },
    assertionKind: 'human-explicit' }] })
  const processor = new MemoryProcessor({ snapshot: f.snapshot, audit: f.audit, projection: f.projection,
    extract: async () => { calls++; return { text: calls === 1 ? invalid : f.output, stream: '[]' } } })
  await processor.process(f.source, route)
  const revisedEvent = f.reviseText('在本群请叫我邵老师。内容保持简短。')
  const revised = { ...f.source, event: revisedEvent, end: revisedEvent.text.length, text: revisedEvent.text }
  await processor.process(revised, route)
  expect(calls).toBe(2)
  expect(processor.facts(f.snapshot(), agentId)[0]?.value).toBe('邵老师')
})

test('the extraction prompt demonstrates complete evidence fields and set remove clear values', async () => {
  const f = fixture()
  const processor = new MemoryProcessor({ snapshot: f.snapshot, audit: f.audit, projection: f.projection,
    extract: async () => ({ text: f.output, stream: '[]' }) })
  await processor.process(f.source, route)
  const prompt = [...f.audit.entries()][0]?.[1].prompt ?? ''
  expect(prompt).toContain('Return exactly the schema keys')
  const exampleLine = prompt.split('\n').find(line => line.startsWith('{"facts":'))
  const example = JSON.parse(exampleLine ?? '{}') as { facts: Array<Record<string, unknown>> }
  expect(example.facts).toHaveLength(3)
  expect(example.facts[0]).toMatchObject({ kind: 'controlled', operation: 'set', sourceQuote: expect.any(String),
    application: { evidence: expect.any(String) } })
  expect(example.facts[1]).toMatchObject({ kind: 'anchored', operation: 'remove', conditionQuotes: [], value: expect.any(String) })
  expect(example.facts[2]).toMatchObject({ kind: 'controlled', operation: 'clear' })
  expect(example.facts[2]).not.toHaveProperty('value')
})

test('strict extraction cannot claim an unprovided second source or a missing source task', async () => {
  const f = fixture()
  for (const output of [f.output.replace('"sourceQuote"', '"sourceEventIds":["foreign"],"sourceQuote"'),
    f.output.replace('"source-room"', '"source-task"')]) {
    const processor = new MemoryProcessor({ snapshot: f.snapshot, audit: table(), projection: table(), extract: async () => ({ text: output, stream: '[]' }) })
    await processor.process(f.source, route)
    expect(processor.facts(f.snapshot(), agentId)).toEqual([])
  }
})

test('personal facts use distinct source actor identities even when the model uses the same self-reference', async () => {
  const f = fixture()
  const events = ['human-a', 'human-b'].map((id, index) => ({ ...f.event, id: WorkspaceEventId(`source-${index}`), sequence: index + 1,
    actor: { type: 'human' as const, id: HumanId(id) } }))
  const state = { ...f.snapshot(), nextSequence: 3, events, memoryEntries: events.map((event, index) => ({ id: AgentMemoryEntryId(`entry-${index}`), eventId: event.id, agentId, acquiredBy: 'room-membership' as const })) }
  const processor = new MemoryProcessor({ snapshot: () => state, audit: table(), projection: table(), extract: async () => ({ text: f.output.replace('"owner"', '"source-actor"'), stream: '[]' }) })
  for (const event of events) await processor.process({ ...f.source, event }, route)
  expect(processor.facts(state, agentId).map(fact => fact.subject)).toEqual(['human:human-a', 'human:human-b'])
  const bad = new MemoryProcessor({ snapshot: () => state, audit: table(), projection: table(), extract: async () => ({ text: f.output, stream: '[]' }) })
  await bad.process({ ...f.source, event: events[0]! }, route)
  expect(bad.facts(state, agentId)).toEqual([])
})

test('a corrupted disposable projection rebuilds from the durable settlement without another model call', async () => {
  const f = fixture()
  let calls = 0
  const processor = new MemoryProcessor({ snapshot: f.snapshot, audit: f.audit, projection: f.projection,
    extract: async () => { calls++; return { text: f.output, stream: '[]' } } })
  await processor.process(f.source, route)
  const [key, projection] = [...f.projection.entries()][0]!
  await f.projection.put(key, { ...projection, output: 'corrupt' })
  expect(processor.facts(f.snapshot(), agentId)).toEqual([])
  expect(processor.has(f.source)).toBe(false)
  await processor.process(f.source, route)
  expect(processor.facts(f.snapshot(), agentId)[0]?.value).toBe('邵老师')
  expect(calls).toBe(1)
})
