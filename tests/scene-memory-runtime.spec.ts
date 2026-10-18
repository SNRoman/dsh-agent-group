import { expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { AgentId, AgentMemoryEntryId, WorkspaceEventId, WorkspaceId } from '../packages/host/src/ids.ts'
import type { CommunicationInputId, ContextResetId } from '../packages/host/src/communication-contract.ts'
import { readMemoryCoverage } from '../packages/host/src/memory-session.ts'
import { EmployeeAgentPool } from '../packages/host/src/runtime.ts'
import { mutateWorkspace } from '../packages/host/src/state.ts'
import { workflowRuntime } from './workflow-test-support.ts'
import { WEB_WORKSPACE_HUMAN_ID } from '../packages/host/src/rpc.ts'
import { registerWorkspaceMemoryTools } from '../packages/host/src/memory-tools.ts'
import type { WorkspaceToolRegistry } from '../packages/host/src/task-tools.ts'
import type { MessageSourceMap, UserMessage } from '@deepseek-ai/dsh-llm'
import { prepareMessageRecall, completeMessageRecall } from '../packages/host/src/message-recall.ts'
import { getCommunicationInvalidation } from '../packages/host/src/communication.ts'

test('restores only same-workspace, same-generation coverage from logged model inputs', () => {
  const session = Session.create(SessionId('memory-receipts'))
  const eventId = WorkspaceEventId('event-one')
  const source = { kind: 'agent-workspace-context' as const, id: 'input-one' as CommunicationInputId,
    target: { kind: 'room-input' as const, eventId }, agentId: AgentId('alice'), contextGeneration: 2,
    recordedAtSequence: 1, directEventIds: [eventId], recalledEventIds: [], sessionEventIds: [],
    memoryReceipt: { version: 1 as const,
    workspaceId: WorkspaceId('local'), agentId: AgentId('alice'), contextGeneration: 2,
    coverage: [{ entryId: AgentMemoryEntryId('entry-one'), contextGeneration: 2, kind: 'original' as const, start: 0, end: 8 }] } } satisfies MessageSourceMap['agent-workspace-context']
  expect(readMemoryCoverage(session, WorkspaceId('local'), AgentId('alice'), 2)).toEqual([])
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'source excerpt' }], source }), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'foreign' }], source: { ...source, memoryReceipt: { ...source.memoryReceipt, workspaceId: WorkspaceId('other') } } }), { surfaceOp: 'append' })
  const legacySource: MessageSourceMap['agent-workspace-context'] = { kind: source.kind, id: source.id,
    target: source.target, agentId: source.agentId, contextGeneration: source.contextGeneration,
    recordedAtSequence: source.recordedAtSequence, directEventIds: source.directEventIds,
    recalledEventIds: [], sessionEventIds: [] }
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'legacy' }], source: legacySource }), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'malformed' }], source: { ...source, memoryReceipt: null } as never }), { surfaceOp: 'append' })
  expect(readMemoryCoverage(session, WorkspaceId('local'), AgentId('alice'), 2)).toEqual(source.memoryReceipt.coverage)
  expect(readMemoryCoverage(session, WorkspaceId('local'), AgentId('alice'), 3)).toEqual([])
  expect(readMemoryCoverage(session, WorkspaceId('other'), AgentId('alice'), 2)).toEqual([{ ...source.memoryReceipt.coverage[0] }])
})

test('a queued room turn prepares newly acquired memory at its own serial admission', async () => {
  const f = await workflowRuntime()
  const room = mutateWorkspace(f.runtime.snapshot(), { type: 'room/create', kind: 'group', name: 'Team' })
  const joined = mutateWorkspace(room.state, { type: 'room/join', roomId: room.roomId, agentId: f.agentId, memoryStart: { type: 'new-events' } })
  const outsider = mutateWorkspace(joined.state, { type: 'agent/create', definitionId: joined.state.agents[f.agentId]!.definitionId, name: 'Bob outside room' })
  const first = mutateWorkspace(outsider.state, { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: WEB_WORKSPACE_HUMAN_ID }, text: 'First turn', mentions: [f.agentId] })
  const second = mutateWorkspace(first.state, { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: WEB_WORKSPACE_HUMAN_ID }, text: 'What is our preferred review time?', mentions: [f.agentId] })
  await f.directory.updateAggregate(f.runtime.workspaceId, () => second.state)
  const session = Session.create(SessionId('queued-memory-session'))
  const agent = { id: session.id, ctx: new Context(), session, whenIdle: async () => {} } as Agent
  const pool = new EmployeeAgentPool({ create: async () => ({ agent, dispose: async () => {} }), resume: async () => { throw new Error('unexpected resume') } }, f.runtime)
  Object.assign(f.runtime, { pool })
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const claimed = new Promise<void>(resolve => { entered = resolve })
  const recalls: string[] = []
  Object.assign(f.runtime, { trackers: new Map([[f.agentId, { deliver: async (_agent: Agent, _delivery: unknown, recall: { content: readonly { type: string; text: string }[] }) => {
    recalls.push(recall.content.map(block => block.text).join('\n'))
    if (recalls.length === 1) { entered(); await held }
    return { output: [], stopReason: { kind: 'completed' }, interrupted: false }
  } }]]) })
  const delivery = (eventId: typeof first.eventId, text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'agent-workspace-delivery', workspaceId: f.runtime.workspaceId, source: { kind: 'room', roomId: room.roomId }, sourceEventId: eventId } })
  try {
    const one = f.runtime.deliver(f.agentId, delivery(first.eventId, 'First turn'), undefined, { kind: 'room', roomId: room.roomId })
    await claimed
    const two = f.runtime.deliver(f.agentId, delivery(second.eventId, 'What is our preferred review time?'), undefined, { kind: 'room', roomId: room.roomId })
    const newer = mutateWorkspace(f.runtime.snapshot(), { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: WEB_WORKSPACE_HUMAN_ID }, text: 'Our preferred review time is Friday 16:00.', mentions: [] })
    await f.directory.updateAggregate(f.runtime.workspaceId, () => newer.state)
    release()
    await Promise.all([one, two])
    expect(recalls[1]).toContain('Our preferred review time is Friday 16:00.')
    expect(recalls[1]).toContain('What is our preferred review time?')
    expect(recalls[1]).not.toContain('Bob outside room')
  } finally { release(); await pool.disposeAll() }
})

test('a tool preview read during a managed turn becomes a durable and deferred source dependency', async () => {
  const f = await workflowRuntime()
  const room = mutateWorkspace(f.runtime.snapshot(), { type: 'room/create', kind: 'group', name: 'Team' })
  const joined = mutateWorkspace(room.state, { type: 'room/join', roomId: room.roomId, agentId: f.agentId, memoryStart: { type: 'new-events' } })
  const trigger = mutateWorkspace(joined.state, { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: WEB_WORKSPACE_HUMAN_ID }, text: 'Find the later note', mentions: [f.agentId] })
  await f.directory.updateAggregate(f.runtime.workspaceId, () => trigger.state)
  const session = Session.create(SessionId('tool-memory-session'))
  const agent = { id: session.id, ctx: new Context(), session, whenIdle: async () => {} } as Agent
  const pool = new EmployeeAgentPool({ create: async () => ({ agent, dispose: async () => {} }), resume: async () => { throw new Error('unexpected resume') } }, f.runtime)
  Object.assign(f.runtime, { pool })
  const definitions: Parameters<WorkspaceToolRegistry['register']>[0][] = []
  const unregister = registerWorkspaceMemoryTools({ register: definition => { definitions.push(definition); return () => {} } }, f.runtime, { characterBudget: 1000, resultLimit: 10 })
  const deferred: UserMessage[] = []
  let laterId: typeof trigger.eventId | undefined
  Object.assign(f.runtime, { trackers: new Map([[f.agentId, { deliver: async () => {
    const later = mutateWorkspace(f.runtime.snapshot(), { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: WEB_WORKSPACE_HUMAN_ID }, text: 'Later note: review at 16:00', mentions: [] })
    laterId = later.eventId
    await f.directory.updateAggregate(f.runtime.workspaceId, () => later.state)
    const search = definitions.find(definition => definition.name === 'workspace_search_memory')!
    await search.execute({ query: 'Later note' }, { agent, signal: new AbortController().signal, deferContext: (context: UserMessage) => { deferred.push(context) }, concludeTurn: () => {} } as never)
    return { output: [], stopReason: { kind: 'completed' }, interrupted: false }
  } }]]) })
  try {
    const delivery = createUserMessage({ content: [{ type: 'text', text: 'Find the later note' }], source: { kind: 'agent-workspace-delivery', workspaceId: f.runtime.workspaceId, source: { kind: 'room', roomId: room.roomId }, sourceEventId: trigger.eventId } })
    await f.runtime.deliver(f.agentId, delivery, undefined, { kind: 'room', roomId: room.roomId })
    const input = Object.values(f.directory.record(f.runtime.workspaceId).communication.inputs).find(item => item.target.kind === 'room-input')!
    expect(input.recalledEventIds).toContain(laterId)
    expect(deferred.at(-1)?.source).toMatchObject({ kind: 'agent-workspace-context', id: input.id, recalledEventIds: expect.arrayContaining([laterId]) })
    const record = f.directory.record(f.runtime.workspaceId)
    const recalled = prepareMessageRecall(record, { operationId: 'tool-withdrawal' as ContextResetId,
      roomId: room.roomId, eventId: laterId!, humanId: WEB_WORKSPACE_HUMAN_ID,
      requestedAt: '2026-10-14T00:00:00.000Z', restoreFiles: false })
    expect(getCommunicationInvalidation(recalled.aggregate, recalled.communication).inputIds.has(input.id)).toBe(true)
  } finally { unregister(); await pool.disposeAll() }
})

test('a long incoming instruction reaches the employee in full', async () => {
  const f = await workflowRuntime()
  const room = mutateWorkspace(f.runtime.snapshot(), { type: 'room/create', kind: 'group', name: 'Team' })
  const joined = mutateWorkspace(room.state, { type: 'room/join', roomId: room.roomId, agentId: f.agentId, memoryStart: { type: 'new-events' } })
  const longText = `Review this complete instruction: ${'A'.repeat(3000)}`
  const trigger = mutateWorkspace(joined.state, { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: WEB_WORKSPACE_HUMAN_ID }, text: longText, mentions: [f.agentId] })
  await f.directory.updateAggregate(f.runtime.workspaceId, () => trigger.state)
  const session = Session.create(SessionId('long-delivery-session'))
  const agent = { id: session.id, ctx: new Context(), session, whenIdle: async () => {} } as Agent
  const pool = new EmployeeAgentPool({ create: async () => ({ agent, dispose: async () => {} }), resume: async () => { throw new Error('unexpected resume') } }, f.runtime)
  let observed: UserMessage | undefined
  Object.assign(f.runtime, { pool, trackers: new Map([[f.agentId, { deliver: async (_agent: Agent, message: UserMessage) => {
    observed = message
    return { output: [], stopReason: { kind: 'completed' }, interrupted: false }
  } }]]) })
  try {
    const delivery = createUserMessage({ content: [{ type: 'text', text: longText }], source: { kind: 'agent-workspace-delivery', workspaceId: f.runtime.workspaceId, source: { kind: 'room', roomId: room.roomId }, sourceEventId: trigger.eventId } })
    await f.runtime.deliver(f.agentId, delivery, undefined, { kind: 'room', roomId: room.roomId })
    expect(observed).toBe(delivery)
    expect(observed?.content).toEqual([{ type: 'text', text: longText }])
  } finally { await pool.disposeAll() }
})

test('an old operation cannot admit a fresh scene after its context generation changed', async () => {
  const f = await workflowRuntime()
  const room = mutateWorkspace(f.runtime.snapshot(), { type: 'room/create', kind: 'group', name: 'Team' })
  const joined = mutateWorkspace(room.state, { type: 'room/join', roomId: room.roomId, agentId: f.agentId, memoryStart: { type: 'new-events' } })
  const earlier = mutateWorkspace(joined.state, { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: WEB_WORKSPACE_HUMAN_ID }, text: 'Earlier withdrawn text', mentions: [] })
  const trigger = mutateWorkspace(earlier.state, { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: WEB_WORKSPACE_HUMAN_ID }, text: 'Old request', mentions: [f.agentId] })
  await f.directory.updateAggregate(f.runtime.workspaceId, () => trigger.state)
  const session = Session.create(SessionId('old-operation-session'))
  const agent = { id: session.id, ctx: new Context(), session, whenIdle: async () => {} } as Agent
  const pool = new EmployeeAgentPool({ create: async () => ({ agent, dispose: async () => {} }), resume: async () => ({ agent, dispose: async () => {} }) }, f.runtime)
  Object.assign(f.runtime, { pool, trackers: new Map([[f.agentId, { deliver: async () => ({ output: [], stopReason: { kind: 'completed' }, interrupted: false }) }]]) })
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const delivery = createUserMessage({ content: [{ type: 'text', text: 'Old request' }], source: { kind: 'agent-workspace-delivery', workspaceId: f.runtime.workspaceId, source: { kind: 'room', roomId: room.roomId }, sourceEventId: trigger.eventId } })
  try {
    const pending = f.runtime.runNewOperation(async () => {
      entered()
      await held
      return await f.runtime.deliver(f.agentId, delivery, undefined, { kind: 'room', roomId: room.roomId })
    })
    const rejection = expect(pending).rejects.toThrow('Old colleague context')
    await started
    const resetId = 'generation-shift' as ContextResetId
    await f.directory.updateRecord(f.runtime.workspaceId, record => {
      const prepared = prepareMessageRecall(record, { operationId: resetId, roomId: room.roomId, eventId: earlier.eventId,
        humanId: WEB_WORKSPACE_HUMAN_ID, requestedAt: '2026-10-14T00:00:00.000Z', restoreFiles: false })
      return { record: completeMessageRecall(prepared, resetId, { [f.agentId]: SessionId('replacement-session') }), value: undefined }
    })
    release()
    await rejection
  } finally { release(); await pool.disposeAll() }
})

test('closing during a memory-tool record leaves no late source mutation', async () => {
  const f = await workflowRuntime()
  const room = mutateWorkspace(f.runtime.snapshot(), { type: 'room/create', kind: 'group', name: 'Team' })
  const joined = mutateWorkspace(room.state, { type: 'room/join', roomId: room.roomId, agentId: f.agentId, memoryStart: { type: 'new-events' } })
  const trigger = mutateWorkspace(joined.state, { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: WEB_WORKSPACE_HUMAN_ID }, text: 'Find source', mentions: [f.agentId] })
  await f.directory.updateAggregate(f.runtime.workspaceId, () => trigger.state)
  const session = Session.create(SessionId('closing-tool-session'))
  const agent = { id: session.id, ctx: new Context(), session, whenIdle: async () => {} } as Agent
  const pool = new EmployeeAgentPool({ create: async () => ({ agent, dispose: async () => {} }), resume: async () => { throw new Error('unexpected resume') } }, f.runtime)
  Object.assign(f.runtime, { pool })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let laterId: typeof trigger.eventId | undefined
  Object.assign(f.runtime, { trackers: new Map([[f.agentId, { deliver: async () => {
    const later = mutateWorkspace(f.runtime.snapshot(), { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: WEB_WORKSPACE_HUMAN_ID }, text: 'Late source', mentions: [] })
    laterId = later.eventId
    await f.directory.updateAggregate(f.runtime.workspaceId, () => later.state)
    f.beforeUpdate(async () => { entered.resolve(); await release.promise })
    await f.runtime.recordMemoryToolRead(agent, [later.eventId], 'Late source')
    return { output: [], stopReason: { kind: 'completed' }, interrupted: false }
  } }]]) })
  const delivery = createUserMessage({ content: [{ type: 'text', text: 'Find source' }], source: { kind: 'agent-workspace-delivery', workspaceId: f.runtime.workspaceId, source: { kind: 'room', roomId: room.roomId }, sourceEventId: trigger.eventId } })
  try {
    const pending = f.runtime.deliver(f.agentId, delivery, undefined, { kind: 'room', roomId: room.roomId })
    const rejected = expect(pending).rejects.toThrow('after turn closure')
    await entered.promise
    f.runtime.closeAdmission()
    release.resolve()
    await rejected
    const input = Object.values(f.directory.record(f.runtime.workspaceId).communication.inputs).find(item => item.target.kind === 'room-input')!
    expect(input.recalledEventIds).not.toContain(laterId)
  } finally { f.beforeUpdate(); release.resolve(); await pool.disposeAll() }
})

test('stopping while admission waits cannot persist input or call the tracker', async () => {
  const f = await workflowRuntime()
  const room = mutateWorkspace(f.runtime.snapshot(), { type: 'room/create', kind: 'group', name: 'Team' })
  const joined = mutateWorkspace(room.state, { type: 'room/join', roomId: room.roomId, agentId: f.agentId, memoryStart: { type: 'new-events' } })
  const trigger = mutateWorkspace(joined.state, { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: WEB_WORKSPACE_HUMAN_ID }, text: 'Do not admit after stop', mentions: [f.agentId] })
  await f.directory.updateAggregate(f.runtime.workspaceId, () => trigger.state)
  const session = Session.create(SessionId('stopped-admission-session'))
  const agent = { id: session.id, ctx: new Context(), session, inbox: createInboxStub(), whenIdle: async () => {} } as Agent
  const pool = new EmployeeAgentPool({ create: async () => ({ agent, dispose: async () => {} }), resume: async () => { throw new Error('unexpected resume') } }, f.runtime)
  let trackerCalls = 0
  Object.assign(f.runtime, { pool, trackers: new Map([[f.agentId, { deliver: async () => {
    trackerCalls += 1
    return { output: [], stopReason: { kind: 'completed' }, interrupted: false }
  } }]]) })
  await pool.ensure(f.agentId)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  f.beforeUpdate(async () => { entered.resolve(); await release.promise })
  const delivery = createUserMessage({ content: [{ type: 'text', text: 'Do not admit after stop' }], source: { kind: 'agent-workspace-delivery', workspaceId: f.runtime.workspaceId, source: { kind: 'room', roomId: room.roomId }, sourceEventId: trigger.eventId } })
  try {
    const pending = f.runtime.deliver(f.agentId, delivery, undefined, { kind: 'room', roomId: room.roomId })
    const rejected = expect(pending).rejects.toThrow('organization work is stopping')
    await entered.promise
    await f.runtime.stopAdmittedWork()
    release.resolve()
    await rejected
    expect(f.directory.record(f.runtime.workspaceId).communication.inputs).toEqual({})
    expect(trackerCalls).toBe(0)
    expect(session.deriveMessages()).toEqual([])
  } finally { f.beforeUpdate(); release.resolve(); await pool.disposeAll() }
})

test('stopping after input persistence prevents tracker and receipt logging', async () => {
  const f = await workflowRuntime()
  const room = mutateWorkspace(f.runtime.snapshot(), { type: 'room/create', kind: 'group', name: 'Team' })
  const joined = mutateWorkspace(room.state, { type: 'room/join', roomId: room.roomId, agentId: f.agentId, memoryStart: { type: 'new-events' } })
  const trigger = mutateWorkspace(joined.state, { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: WEB_WORKSPACE_HUMAN_ID }, text: 'Stop before model', mentions: [f.agentId] })
  await f.directory.updateAggregate(f.runtime.workspaceId, () => trigger.state)
  const session = Session.create(SessionId('stop-after-persist-session'))
  const agent = { id: session.id, ctx: new Context(), session, inbox: createInboxStub(), whenIdle: async () => {} } as Agent
  const pool = new EmployeeAgentPool({ create: async () => ({ agent, dispose: async () => {} }), resume: async () => { throw new Error('unexpected resume') } }, f.runtime)
  let trackerCalls = 0
  Object.assign(f.runtime, { pool, trackers: new Map([[f.agentId, { deliver: async () => {
    trackerCalls += 1
    return { output: [], stopReason: { kind: 'completed' }, interrupted: false }
  } }]]) })
  await pool.ensure(f.agentId)
  let stopped: Promise<void> | undefined
  f.afterTransform(() => { stopped = f.runtime.stopAdmittedWork() })
  const delivery = createUserMessage({ content: [{ type: 'text', text: 'Stop before model' }], source: { kind: 'agent-workspace-delivery', workspaceId: f.runtime.workspaceId, source: { kind: 'room', roomId: room.roomId }, sourceEventId: trigger.eventId } })
  try {
    await expect(f.runtime.deliver(f.agentId, delivery, undefined, { kind: 'room', roomId: room.roomId })).rejects.toThrow('organization work is stopping')
    await stopped
    expect(Object.values(f.directory.record(f.runtime.workspaceId).communication.inputs)).toHaveLength(1)
    expect(trackerCalls).toBe(0)
    expect(session.deriveMessages()).toEqual([])
  } finally { f.afterTransform(); await pool.disposeAll() }
})

test('stopping after prepared admission cannot cross the await into tracker delivery', async () => {
  const f = await workflowRuntime()
  const room = mutateWorkspace(f.runtime.snapshot(), { type: 'room/create', kind: 'group', name: 'Team' })
  const joined = mutateWorkspace(room.state, { type: 'room/join', roomId: room.roomId, agentId: f.agentId, memoryStart: { type: 'new-events' } })
  const trigger = mutateWorkspace(joined.state, { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: WEB_WORKSPACE_HUMAN_ID }, text: 'Stop before followup', mentions: [f.agentId] })
  await f.directory.updateAggregate(f.runtime.workspaceId, () => trigger.state)
  const session = Session.create(SessionId('stop-before-followup-session'))
  const agent = { id: session.id, ctx: new Context(), session, inbox: createInboxStub(), whenIdle: async () => {} } as Agent
  const pool = new EmployeeAgentPool({ create: async () => ({ agent, dispose: async () => {} }), resume: async () => { throw new Error('unexpected resume') } }, f.runtime)
  let trackerCalls = 0
  Object.assign(f.runtime, { pool, trackers: new Map([[f.agentId, { deliver: async () => {
    trackerCalls += 1
    return { output: [], stopReason: { kind: 'completed' }, interrupted: false }
  } }]]) })
  await pool.ensure(f.agentId)
  const original = Reflect.get(f.runtime, 'admitManagedInput') as (...args: never[]) => Promise<UserMessage | undefined>
  Object.assign(f.runtime, { admitManagedInput: async (...args: never[]) => {
    const prepared = await original.apply(f.runtime, args)
    await f.runtime.stopAdmittedWork()
    return prepared
  } })
  const delivery = createUserMessage({ content: [{ type: 'text', text: 'Stop before followup' }], source: { kind: 'agent-workspace-delivery', workspaceId: f.runtime.workspaceId, source: { kind: 'room', roomId: room.roomId }, sourceEventId: trigger.eventId } })
  try {
    await expect(f.runtime.deliver(f.agentId, delivery, undefined, { kind: 'room', roomId: room.roomId })).rejects.toThrow('organization work is stopping')
    expect(trackerCalls).toBe(0)
    expect(session.deriveMessages()).toEqual([])
    await expect(f.runtime.recordMemoryToolRead(agent, [trigger.eventId], 'Unclaimed input')).rejects.toThrow('Memory tool source has no managed input')
  } finally { Object.assign(f.runtime, { admitManagedInput: original }); await pool.disposeAll() }
})
