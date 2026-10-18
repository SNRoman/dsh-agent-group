import { expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { EmployeeAgentPool } from '../packages/host/src/runtime.ts'
import { WorkspaceTurnTracker } from '../packages/host/src/turn-tracker.ts'
import { registerWorkspaceMemoryTools } from '../packages/host/src/memory-tools.ts'
import { readMemoryCoverage } from '../packages/host/src/memory-session.ts'
import { getCommunicationInvalidation } from '../packages/host/src/communication.ts'
import { prepareMessageRecall } from '../packages/host/src/message-recall.ts'
import type { ContextResetId } from '../packages/host/src/communication-contract.ts'
import { WorkspaceEventId } from '../packages/host/src/ids.ts'
import { mutateWorkspace } from '../packages/host/src/state.ts'
import { workflowRuntime } from './workflow-test-support.ts'
import { WEB_WORKSPACE_HUMAN_ID } from '../packages/host/src/rpc.ts'

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolResponse(rawId: string, name: string, argumentsValue: object): StreamChunk[] {
  const id = ToolCallId(rawId)
  const args = JSON.stringify(argumentsValue)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

class SceneAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  beforeFirstRequest?: () => Promise<void>
  readEventId?: () => string | undefined

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      await this.beforeFirstRequest?.()
      yield* toolResponse('native-memory-search', 'workspace_search_memory', { query: 'later needle' })
    } else if (this.requests.length === 2) {
      const eventId = this.readEventId?.()
      if (eventId === undefined) throw new Error('search source was not established')
      yield* toolResponse('native-memory-read', 'workspace_read_memory', { eventId, offset: 0 })
    } else {
      yield* textResponse('I found the later needle.')
    }
  }
}

test('native Agent logs scene receipt and tool-only source before its second request', async () => {
  const f = await workflowRuntime()
  const room = mutateWorkspace(f.runtime.snapshot(), { type: 'room/create', kind: 'group', name: 'Team' })
  const joined = mutateWorkspace(room.state, { type: 'room/join', roomId: room.roomId, agentId: f.agentId, memoryStart: { type: 'new-events' } })
  const earlier = mutateWorkspace(joined.state, { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: WEB_WORKSPACE_HUMAN_ID }, text: 'Earlier context about reviews', mentions: [] })
  const trigger = mutateWorkspace(earlier.state, { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: WEB_WORKSPACE_HUMAN_ID }, text: 'Please find a later needle and report it', mentions: [f.agentId] })
  await f.directory.updateAggregate(f.runtime.workspaceId, () => trigger.state)

  const ctx = new Context()
  const adapter = new SceneAdapter()
  let laterId: typeof trigger.eventId | undefined
  adapter.readEventId = () => laterId
  adapter.beforeFirstRequest = async () => {
    const later = mutateWorkspace(f.runtime.snapshot(), { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: WEB_WORKSPACE_HUMAN_ID }, text: 'The later needle is Friday 16:00.', mentions: [] })
    laterId = later.eventId
    await f.directory.updateAggregate(f.runtime.workspaceId, () => later.state)
  }
  let pool: EmployeeAgentPool | undefined
  let unregister: (() => void) | undefined
  try {
    await mountAgentLoopTestDependencies(ctx)
    ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
    const loggedEvents: SessionEvent[] = []
    ctx.on('session/event', (session, event) => {
      if (session.id === SessionId('native-scene-memory')) loggedEvents.push(event)
    })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('native-scene-memory'), { provider: 'mock', model: 'mock' })
    const tracker = new WorkspaceTurnTracker()
    tracker.install(agent.ctx)
    pool = new EmployeeAgentPool({ create: async () => ({ agent, dispose: async () => {} }), resume: async () => { throw new Error('unexpected resume') } }, f.runtime)
    Object.assign(f.runtime, { pool, trackers: new Map([[f.agentId, tracker]]) })
    await pool.ensure(f.agentId)
    unregister = registerWorkspaceMemoryTools(ctx.tools, f.runtime, { characterBudget: 1000, resultLimit: 10 })

    const delivery = createUserMessage({ content: [{ type: 'text', text: 'Please find a later needle and report it' }], source: { kind: 'agent-workspace-delivery', workspaceId: f.runtime.workspaceId, source: { kind: 'room', roomId: room.roomId }, sourceEventId: trigger.eventId } })
    const outcome = await f.runtime.deliver(f.agentId, delivery, undefined, { kind: 'room', roomId: room.roomId })
    expect(outcome.output).toEqual([{ type: 'text', text: 'I found the later needle.' }])
    expect(adapter.requests).toHaveLength(3)
    const first = adapter.requests[0]!.messages
    expect(first.findIndex(message => message.id === delivery.id)).toBeGreaterThanOrEqual(0)
    const sceneIndex = first.findIndex(message => message.source?.kind === 'agent-workspace-context')
    expect(sceneIndex).toBe(first.findIndex(message => message.id === delivery.id) + 1)
    expect(JSON.stringify(first[sceneIndex])).toContain('Earlier context about reviews')
    expect(JSON.stringify(first[sceneIndex])).toContain('currentTimeLocal')
    expect(JSON.stringify(first[sceneIndex])).toContain(new Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(JSON.stringify(first)).not.toContain('The later needle is Friday 16:00.')

    const userEvents = loggedEvents.filter(event => event.type === 'user/message')
    expect(userEvents[0]?.data.id).toBe(delivery.id)
    expect(userEvents[1]?.data.source.kind).toBe('agent-workspace-context')
    expect(userEvents[1]?.data).toEqual(first[sceneIndex])
    const coverage = readMemoryCoverage(agent.session, f.runtime.workspaceId, f.agentId, 0)
    expect(coverage.length).toBeGreaterThan(0)
    const restored = Session.fromRestore(agent.session.id, structuredClone(loggedEvents), structuredClone(agent.session.header), SessionLogOffset(0), 'detached')
    expect(readMemoryCoverage(restored, f.runtime.workspaceId, f.agentId, 0)).toEqual(coverage)

    const resultIndexes = loggedEvents.flatMap((event, index) => event.type === 'tool/result' ? [index] : [])
    expect(resultIndexes).toHaveLength(2)
    for (const resultIndex of resultIndexes) {
      const deferredIndex = loggedEvents.findIndex((event, index) => index > resultIndex && event.type === 'user/message' && event.data.source.kind === 'agent-workspace-context' && !('memoryReceipt' in event.data.source))
      expect(deferredIndex).toBeGreaterThan(resultIndex)
    }
    const second = adapter.requests[1]!.messages
    expect(JSON.stringify(second)).toContain('The later needle is Friday 16:00.')
    expect(second.some(message => message.source?.kind === 'agent-workspace-context' && 'recalledEventIds' in message.source && message.source.recalledEventIds.includes(laterId!))).toBe(true)
    const third = adapter.requests[2]!.messages
    expect(third.some(message => message.source?.kind === 'agent-workspace-context' && 'recalledEventIds' in message.source && message.source.recalledEventIds.includes(laterId!))).toBe(true)
    const input = Object.values(f.directory.record(f.runtime.workspaceId).communication.inputs).find(item => item.target.kind === 'room-input')!
    expect(input.recalledEventIds).toContain(laterId)

    await f.runtime.apply(state => mutateWorkspace(state, { type: 'room/message', roomId: room.roomId, actor: { type: 'agent', id: f.agentId }, text: 'I found the later needle.', mentions: [] }).state)
    const output = f.runtime.snapshot().events.at(-1)!
    const record = f.directory.record(f.runtime.workspaceId)
    const recalled = prepareMessageRecall(record, { operationId: 'native-tool-withdrawal' as ContextResetId, roomId: room.roomId, eventId: laterId!, humanId: WEB_WORKSPACE_HUMAN_ID, requestedAt: '2026-10-14T00:00:00.000Z', restoreFiles: false })
    const invalid = getCommunicationInvalidation(recalled.aggregate, recalled.communication)
    expect(invalid.inputIds.has(input.id)).toBe(true)
    expect(invalid.eventIds.has(output.id)).toBe(true)

    const rejected = createUserMessage({ content: [{ type: 'text', text: 'Missing source' }], source: { kind: 'agent-workspace-delivery', workspaceId: f.runtime.workspaceId, source: { kind: 'room', roomId: room.roomId }, sourceEventId: WorkspaceEventId('missing-native-source') } })
    const before = loggedEvents.length
    await expect(f.runtime.deliver(f.agentId, rejected, undefined, { kind: 'room', roomId: room.roomId })).rejects.toThrow('Withdrawn or missing room input')
    expect(loggedEvents).toHaveLength(before)
    expect(adapter.requests).toHaveLength(3)
  } finally {
    unregister?.()
    await pool?.disposeAll()
    await ctx.fiber.dispose()
  }
})
