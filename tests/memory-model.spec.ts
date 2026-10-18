import { expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { extractMemoryWithModel, MEMORY_EXTRACTION_SYSTEM, requestMemoryFragments } from '../packages/host/src/memory-model.ts'
import { AgentId, AgentMemoryEntryId, HumanId, RoomId, WorkspaceEventId, WorkspaceId } from '../packages/host/src/ids.ts'
import { createInitialState } from '../packages/host/src/state.ts'
import type { CommunicationInputId } from '../packages/host/src/communication-contract.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceRuntime } from '../packages/host/src/workspace-runtime.ts'
import AgentWorkspaceDomainService from '../packages/host/src/index.ts'
import type { ResolvedConfig } from '../packages/host/src/index.ts'
import { workflowRuntime } from './workflow-test-support.ts'
import { mutateWorkspace } from '../packages/host/src/state.ts'
import type { MemoryAudit, MemoryProjection, MemoryTable } from '../packages/host/src/memory-projection.ts'
import { latestSceneMarker, sceneMarkerFromContext } from './fixtures/browser/scene-memory-llm.ts'

test('scripted scene dispatch follows the current query rather than recalled history', () => {
  const text = 'Current scene (caller context): {"query":"SCENE_LANGUAGE_SWITCH 请用中文回复"}\nRelevant earlier sources: SCENE_CROSS_ALICE'
  expect(sceneMarkerFromContext(text)).toBe('SCENE_LANGUAGE_SWITCH')
  expect(sceneMarkerFromContext('Current scene (caller context): {"query":"现在知道了吗？"}\nRelevant earlier sources: SCENE_CROSS_ALICE')).toBe('SCENE_GENERIC')
  expect(latestSceneMarker(['Current scene (caller context): {"query":"SCENE_TOOL_ONLY 查原文"}', 'Memory tool sources: event-36'])).toBe('SCENE_TOOL_ONLY')
  expect(sceneMarkerFromContext('Current scene (caller context): {"query":"上次项目怎样了？"}')).toBe('SCENE_FORMAL_STATUS')
})

test('request exposure excludes dormant, unowned and summarized source text', () => {
  const agentId = AgentId('alice'), eventId = WorkspaceEventId('event'), entryId = AgentMemoryEntryId('entry')
  const state = { ...createInitialState(WorkspaceId('org')), nextSequence: 2,
    events: [{ id: eventId, type: 'room/message' as const, sequence: 1, subjectId: RoomId('room'), actor: { type: 'human' as const, id: HumanId('owner') }, text: '可见片段，隐藏内容' }],
    memoryEntries: [{ id: entryId, eventId, agentId, acquiredBy: 'room-membership' as const }] }
  const message = createUserMessage({ content: [{ type: 'text', text: '来源：可见片段' }], source: {
    kind: 'agent-workspace-context', id: 'input' as CommunicationInputId, agentId, contextGeneration: 0, recordedAtSequence: 1,
    target: { kind: 'room-input', eventId }, directEventIds: [eventId], recalledEventIds: [], sessionEventIds: [],
    memoryReceipt: { version: 1, workspaceId: state.workspaceId, agentId, contextGeneration: 0,
      coverage: [{ kind: 'original', entryId, contextGeneration: 0, start: 0, end: 4 }] },
  } })
  const request = { provider: 'route', model: 'chosen', messages: [message] }
  expect(requestMemoryFragments(state, agentId, 0, request, 100).map(source => source.text)).toEqual(['可见片段'])
  expect(requestMemoryFragments(state, AgentId('stranger'), 0, request, 100)).toEqual([])
  expect(requestMemoryFragments(state, agentId, 1, request, 100)).toEqual([])
  expect(requestMemoryFragments(state, agentId, 0, { ...request, system: MEMORY_EXTRACTION_SYSTEM }, 100)).toEqual([])
  expect(requestMemoryFragments(state, agentId, 0, { ...request, messages: [{ ...message, content: [{ type: 'text', text: '摘要' }] }] }, 100)).toEqual([])
})

class ExtractAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(readonly reasoning?: LlmResolvedModelInfo['reasoning'], readonly onRequest?: (request: GenerateOptions) => void) { super() }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, ...(this.reasoning === undefined ? {} : { reasoning: this.reasoning }) }
  }
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    this.onRequest?.(request)
    const text = '{"facts":[]}'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function memoryTable<T>(): MemoryTable<T> {
  const rows = new Map<string, T>()
  return { get: id => rows.get(id), entries: () => rows.entries(), put: async (id, value) => { rows.set(id, value) } }
}

test('employee setup observes real dispatch without extracting dormant history or recursing', async () => {
  const fixture = await workflowRuntime()
  const room = mutateWorkspace(fixture.runtime.snapshot(), { type: 'room/create', kind: 'group', name: 'Memory room' })
  const joined = mutateWorkspace(room.state, { type: 'room/join', roomId: room.roomId, agentId: fixture.agentId, memoryStart: { type: 'new-events' } })
  const dormant = mutateWorkspace(joined.state, { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: HumanId('owner') }, text: '沉睡历史不得上传', mentions: [] })
  const exposed = mutateWorkspace(dormant.state, { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: HumanId('owner') }, text: '本群请叫我邵老师', mentions: [] })
  await fixture.directory.updateAggregate(fixture.runtime.workspaceId, () => exposed.state)
  const ctx = new Context(), audit = memoryTable<MemoryAudit>(), adapter = new ExtractAdapter({
    efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }, { id: ReasoningEffortId('high'), name: 'High' }],
    defaultEffort: ReasoningEffortId('high'),
  }, request => {
    if (request.system !== MEMORY_EXTRACTION_SYSTEM) return
    expect([...audit.entries()][0]?.[1].status).toBe('pending')
    expect(JSON.parse([...audit.entries()][0]![1].parameters)).toEqual({ maxTokens: 2048, reasoningEffort: 'off' })
  })
  let runtime!: WorkspaceRuntime
  let runtimeFiber: Awaited<ReturnType<Context['plugin']>> | undefined
  try {
    await mountAgentLoopTestDependencies(ctx)
    ctx.effect(() => ctx.llm.registerAdapter(['chosen-route'], adapter))
    await ctx.plugin(modelCtx => modelCtx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'chosen-route', model: 'chosen-model' }) }))
    runtimeFiber = await ctx.plugin(restrictedCtx => {
      runtime = new WorkspaceRuntime(restrictedCtx, AgentWorkspaceDomainService.Config({}) as ResolvedConfig, fixture.directory, fixture.runtime.workspaceId)
      runtime.configureMemoryProcessing({ audit, projection: memoryTable<MemoryProjection>() })
    })
    const harness = await mountAgentLoopTestHarness(ctx)
    const options = await runtime['employeeMaterializationOptions'](fixture.agentId, 'create')
    const agent = await harness.create(SessionId('memory-dispatch'), options.agentOptions)
    await options.setup?.(agent.ctx, agent)
    expect(adapter.requests).toHaveLength(0)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '本群请叫我邵老师' }], source: {
      kind: 'agent-workspace-delivery', workspaceId: runtime.workspaceId, source: { kind: 'room', roomId: room.roomId }, sourceEventId: exposed.eventId,
    } }))
    await agent.whenIdle()
    await runtime.waitForMemoryProcessing()
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[0]?.reasoningEffort).toBe('high')
    expect(adapter.requests[1]?.reasoningEffort).toBe('off')
    expect(JSON.parse([...audit.entries()][0]![1].parameters)).toEqual({ maxTokens: 2048, reasoningEffort: 'off' })
    expect(adapter.requests[1]?.system).toBe(MEMORY_EXTRACTION_SYSTEM)
    expect(JSON.stringify(adapter.requests[1]?.messages)).not.toContain('沉睡历史')
    expect([...audit.entries()]).toHaveLength(1)
    expect(runtime.memoryProcessingStatus(fixture.agentId).sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventId: dormant.eventId, status: 'unprocessed' }),
      expect.objectContaining({ eventId: exposed.eventId, status: 'complete' }),
    ]))
    const page = runtime.queryMemory({ agentId: fixture.agentId, snapshotRevision: runtime.snapshot().revision, limit: 20 })
    expect(page.items.find(item => item.eventId === exposed.eventId)?.processing).toMatchObject({ status: 'complete', facts: [] })
    expect(page.items.find(item => item.eventId === dormant.eventId)?.processing).toMatchObject({ status: 'unprocessed', facts: [] })
    expect(agent.session.deriveMessages().filter(message => message.role === 'user')).toHaveLength(1)
  } finally { runtime.closeAdmission(); await runtime.waitForMemoryProcessing(); await runtimeFiber?.dispose(); await ctx.fiber.dispose() }
})

async function runAuxiliaryCase(reasoning: LlmResolvedModelInfo['reasoning'], selection: string): Promise<{ requests: GenerateOptions[]; audits: MemoryAudit[] }> {
  const fixture = await workflowRuntime()
  const room = mutateWorkspace(fixture.runtime.snapshot(), { type: 'room/create', kind: 'group', name: 'Memory room' })
  const joined = mutateWorkspace(room.state, { type: 'room/join', roomId: room.roomId, agentId: fixture.agentId, memoryStart: { type: 'new-events' } })
  const exposed = mutateWorkspace(joined.state, { type: 'room/message', roomId: room.roomId,
    actor: { type: 'human', id: HumanId('owner') }, text: '公司所有群聊请叫我邵老师', mentions: [] })
  await fixture.directory.updateAggregate(fixture.runtime.workspaceId, () => exposed.state)
  const ctx = new Context(), adapter = new ExtractAdapter(reasoning), audit = memoryTable<MemoryAudit>()
  let runtime!: WorkspaceRuntime
  let runtimeFiber: Awaited<ReturnType<Context['plugin']>> | undefined
  try {
    await mountAgentLoopTestDependencies(ctx)
    ctx.effect(() => ctx.llm.registerAdapter(['chosen-route'], adapter))
    await ctx.plugin(modelCtx => modelCtx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'chosen-route', model: 'chosen-model' }) }))
    runtimeFiber = await ctx.plugin(restrictedCtx => {
      runtime = new WorkspaceRuntime(restrictedCtx, AgentWorkspaceDomainService.Config({ memoryExtractionReasoningEffort: selection }) as ResolvedConfig,
        fixture.directory, fixture.runtime.workspaceId)
      runtime.configureMemoryProcessing({ audit, projection: memoryTable<MemoryProjection>() })
    })
    const harness = await mountAgentLoopTestHarness(ctx)
    const options = await runtime['employeeMaterializationOptions'](fixture.agentId, 'create')
    const agent = await harness.create(SessionId(`memory-effort-${selection}`), options.agentOptions)
    await options.setup?.(agent.ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '公司所有群聊请叫我邵老师' }], source: {
      kind: 'agent-workspace-delivery', workspaceId: runtime.workspaceId, source: { kind: 'room', roomId: room.roomId }, sourceEventId: exposed.eventId,
    } }))
    await agent.whenIdle()
    await runtime.waitForMemoryProcessing()
    return { requests: [...adapter.requests], audits: [...audit.entries()].map(([, value]) => value) }
  } finally { runtime.closeAdmission(); await runtime.waitForMemoryProcessing(); await runtimeFiber?.dispose(); await ctx.fiber.dispose() }
}

test('auto omits an unadvertised off effort and records a known route default', async () => {
  const result = await runAuxiliaryCase({ efforts: [{ id: ReasoningEffortId('high'), name: 'High' }],
    defaultEffort: ReasoningEffortId('high') }, 'auto')
  expect(result.requests).toHaveLength(2)
  expect(result.requests[0]?.reasoningEffort).toBe('high')
  expect(result.requests[1]?.reasoningEffort).toBe('high')
  expect(JSON.parse(result.audits[0]!.parameters)).toEqual({ maxTokens: 2048, effectiveReasoningEffort: 'high' })
})

test('auto preserves an unannotated adapter default without inventing an off effort', async () => {
  const result = await runAuxiliaryCase(undefined, 'auto')
  expect(result.requests).toHaveLength(2)
  expect(result.requests[1]?.reasoningEffort).toBeUndefined()
  expect(JSON.parse(result.audits[0]!.parameters)).toEqual({ maxTokens: 2048 })
})

test('unsupported explicit auxiliary effort fails durably before model dispatch', async () => {
  const result = await runAuxiliaryCase({ efforts: [{ id: ReasoningEffortId('high'), name: 'High' }],
    defaultEffort: ReasoningEffortId('high') }, 'off')
  expect(result.requests).toHaveLength(1)
  expect(result.audits).toHaveLength(1)
  expect(result.audits[0]).toMatchObject({ status: 'failed', provider: 'chosen-route', model: 'chosen-model', parameters: '{"maxTokens":2048}' })
  expect(result.audits[0]?.error).toContain('does not support reasoning effort "off"')
})

test('an advertised explicit auxiliary effort is independent of the employee default', async () => {
  const result = await runAuxiliaryCase({ efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }, { id: ReasoningEffortId('high'), name: 'High' }],
    defaultEffort: ReasoningEffortId('high') }, 'low')
  expect(result.requests.map(request => request.reasoningEffort)).toEqual(['high', 'low'])
  expect(JSON.parse(result.audits[0]!.parameters)).toEqual({ maxTokens: 2048, reasoningEffort: 'low' })
})

test('auxiliary effort configuration rejects an empty selection', () => {
  expect(AgentWorkspaceDomainService.Config({}).memoryExtractionReasoningEffort).toBe('auto')
  expect(() => AgentWorkspaceDomainService.Config({ memoryExtractionReasoningEffort: '' })).toThrow()
})

test('native auxiliary stream preserves chosen route and raw output without a visible Session or tools', async () => {
  const ctx = new Context(), adapter = new ExtractAdapter()
  try {
    await mountAgentLoopTestDependencies(ctx)
    ctx.effect(() => ctx.llm.registerAdapter(['chosen-route'], adapter))
    const result = await extractMemoryWithModel(ctx.llm, { provider: 'chosen-route', model: 'chosen-model', parameters: '{"maxTokens":200}',
      prompt: 'Only this source', signal: new AbortController().signal,
      input: { workspaceId: WorkspaceId('org'), eventId: WorkspaceEventId('event'), sequence: 1, scope: { organizationId: WorkspaceId('org') }, start: 0, end: 4, text: 'text', totalCharacters: 4, sourceDigest: 'digest' } }, 10000)
    expect(result.text).toBe('{"facts":[]}')
    expect(result.error).toBeUndefined()
    expect(JSON.parse(result.stream)).not.toHaveLength(0)
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ provider: 'chosen-route', model: 'chosen-model', maxTokens: 200, system: MEMORY_EXTRACTION_SYSTEM })
    expect(adapter.requests[0]?.sessionId).toBeUndefined()
    expect(adapter.requests[0]?.purpose).toBeUndefined()
    expect(adapter.requests[0]?.tools).toBeUndefined()
  } finally { await ctx.fiber.dispose() }
})
