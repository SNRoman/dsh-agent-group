import { expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { HumanId } from '../packages/host/src/ids.ts'
import { mutateWorkspace } from '../packages/host/src/state.ts'
import { WorkspaceRuntime } from '../packages/host/src/workspace-runtime.ts'
import AgentWorkspaceDomainService from '../packages/host/src/index.ts'
import type { ResolvedConfig } from '../packages/host/src/index.ts'
import { MemoryProcessor } from '../packages/host/src/memory-processor.ts'
import type { MemoryAudit, MemoryProjection, MemoryTable } from '../packages/host/src/memory-projection.ts'
import { workflowRuntime } from './workflow-test-support.ts'

function table<T>(): MemoryTable<T> {
  const rows = new Map<string, T>()
  return { get: id => rows.get(id), entries: () => rows.entries(), put: async (id, value) => { rows.set(id, value) } }
}

class FactAdapter extends LlmAdapter {
  beforeResponse?: (request: GenerateOptions) => Promise<void>
  beforeResolve?: () => Promise<void>
  responseText?: (sourceText: string) => string
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    await this.beforeResolve?.()
    return { provider, id: model, name: model }
  }
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    await this.beforeResponse?.(request)
    const body = request.messages[0]!.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    const input = JSON.parse(body.slice(body.lastIndexOf('\n') + 1))
    const text = this.responseText?.(input.text) ?? JSON.stringify({ facts: [{ kind: 'controlled', property: 'person.address', subject: 'source-actor',
      temporal: 'current', operation: 'set', value: '邵老师', application: { kind: 'source-room', evidence: '本群' },
      sourceQuote: input.text, assertionKind: 'human-explicit' }] })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function fixture(projection = table<MemoryProjection>(), audit = table<MemoryAudit>(), config: { memoryExtractionTimeoutMs?: number; memoryExtractionSourcesPerRequest?: number } = {}) {
  const f = await workflowRuntime()
  const room = mutateWorkspace(f.runtime.snapshot(), { type: 'room/create', kind: 'group', name: 'Memory' })
  const joined = mutateWorkspace(room.state, { type: 'room/join', roomId: room.roomId, agentId: f.agentId, memoryStart: { type: 'new-events' } })
  const source = mutateWorkspace(joined.state, { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: HumanId('person') }, text: '本群请叫我邵老师', mentions: [] })
  await f.directory.updateAggregate(f.runtime.workspaceId, () => source.state)
  const ctx = new Context(), adapter = new FactAdapter()
  const runtime = new WorkspaceRuntime(ctx, AgentWorkspaceDomainService.Config(config) as ResolvedConfig, f.directory, f.runtime.workspaceId)
  runtime.configureMemoryProcessing({ audit, projection })
  await mountAgentLoopTestDependencies(ctx)
  ctx.effect(() => ctx.llm.registerAdapter(['facts'], adapter))
  const request: GenerateOptions = { provider: 'facts', model: 'selected', messages: [createUserMessage({
    content: [{ type: 'text', text: '本群请叫我邵老师' }], source: { kind: 'agent-workspace-delivery', workspaceId: runtime.workspaceId,
      source: { kind: 'room', roomId: room.roomId }, sourceEventId: source.eventId },
  })] }
  return { ...f, runtime, adapter, audit, projection, request, roomId: room.roomId, close: async () => {
    runtime.closeAdmission()
    try { await runtime.waitForMemoryProcessing() } finally { await ctx.fiber.dispose() }
  } }
}

test('runtime allowance one skips a rejected source and admits the next exposed memory', async () => {
  const f = await fixture(table(), table(), { memoryExtractionSourcesPerRequest: 1 })
  f.adapter.responseText = sourceText => sourceText === '本群请叫我邵老师' ? '{' : '{"facts":[]}'
  try {
    f.runtime.observeMemoryRequest(f.agentId, f.request)
    await f.runtime.waitForMemoryProcessing()
    expect(f.runtime.memoryProcessingStatus(f.agentId).sources[0]?.status).toBe('failed')
    const later = mutateWorkspace(f.runtime.snapshot(), { type: 'room/message', roomId: f.roomId,
      actor: { type: 'human', id: HumanId('person') }, text: '本群会议安排在下午', mentions: [] })
    await f.directory.updateAggregate(f.runtime.workspaceId, () => later.state)
    const request: GenerateOptions = { ...f.request, messages: [...f.request.messages, createUserMessage({
      content: [{ type: 'text', text: '本群会议安排在下午' }], source: { kind: 'agent-workspace-delivery', workspaceId: f.runtime.workspaceId,
        source: { kind: 'room', roomId: f.roomId }, sourceEventId: later.eventId },
    })] }
    f.runtime.observeMemoryRequest(f.agentId, request)
    await f.runtime.waitForMemoryProcessing()
    expect([...f.audit.entries()].map(([, audit]) => [audit.input.text, audit.status])).toEqual([
      ['本群请叫我邵老师', 'failed'], ['本群会议安排在下午', 'completed'],
    ])
    expect([...f.projection.entries()].map(([, projection]) => projection.input.eventId)).toEqual([later.eventId])
    expect(f.runtime.memoryProcessingStatus(f.agentId).sources.find(source => source.eventId === later.eventId)?.status).toBe('complete')
  } finally { await f.close() }
})

test('runtime configured extraction timeout settles a metadata lookup before transport returns', async () => {
  const lookup = Promise.withResolvers<void>(), started = Promise.withResolvers<void>()
  const f = await fixture(table<MemoryProjection>(), table<MemoryAudit>(), { memoryExtractionTimeoutMs: 20 })
  f.adapter.beforeResolve = async () => { started.resolve(); await lookup.promise }
  let guard: ReturnType<typeof setTimeout> | undefined
  try {
    f.runtime.observeMemoryRequest(f.agentId, f.request)
    await started.promise
    const settled = await Promise.race([f.runtime.waitForMemoryProcessing().then(() => true),
      new Promise<boolean>(resolve => { guard = setTimeout(() => resolve(false), 2000) })])
    expect(settled).toBe(true)
    expect([...f.audit.entries()].map(([, audit]) => audit.status)).toEqual(['failed'])
    expect([...f.audit.entries()][0]?.[1].error).toBe('Memory extraction timed out')
    expect(f.runtime.memoryProcessingStatus(f.agentId).facts).toEqual([])
  } finally {
    if (guard !== undefined) clearTimeout(guard)
    lookup.resolve()
    await f.close()
  }
})

test('runtime stop permanently cancels old extraction across reopen and accepts a fresh retry', async () => {
  const f = await fixture(), started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let signal: AbortSignal | undefined
  f.adapter.beforeResponse = async request => { signal = request.signal; started.resolve(); await release.promise }
  try {
    f.runtime.observeMemoryRequest(f.agentId, f.request)
    await started.promise
    await f.runtime.stopAdmittedWork()
    f.runtime.prepareReopen()
    release.resolve()
    await f.runtime.waitForMemoryProcessing()
    expect(f.runtime.memoryProcessingStatus(f.agentId).facts).toEqual([])
    expect(signal?.aborted).toBe(true)
    f.adapter.beforeResponse = undefined
    f.runtime.observeMemoryRequest(f.agentId, f.request)
    await f.runtime.waitForMemoryProcessing()
    expect(f.runtime.memoryProcessingStatus(f.agentId).facts).toHaveLength(1)
    await f.runtime.stopAdmittedWork()
    f.runtime.prepareReopen()
    expect(f.runtime.memoryProcessingStatus(f.agentId).facts).toHaveLength(1)
  } finally { release.resolve(); await f.close() }
})

test('failed durable discard rejects stop and reopening while keeping the late projection unavailable', async () => {
  const rows = table<MemoryProjection>(), audits = table<MemoryAudit>()
  const writing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const projection: MemoryTable<MemoryProjection> = { ...rows, put: async (id, value) => {
    writing.resolve(); await release.promise; await rows.put(id, value)
  } }
  const audit: MemoryTable<MemoryAudit> = { ...audits, put: async (id, value) => {
    if (value.status === 'discarded') throw new Error('audit disk unavailable')
    await audits.put(id, value)
  } }
  const f = await fixture(projection, audit)
  try {
    f.runtime.observeMemoryRequest(f.agentId, f.request)
    await writing.promise
    const stopped = expect(f.runtime.stopAdmittedWork()).rejects.toThrow('Organization work could not be stopped')
    release.resolve()
    await stopped
    expect(f.runtime.memoryProcessingStatus(f.agentId).facts).toEqual([])
    expect(() => f.runtime.prepareReopen()).toThrow('could not be durably discarded')
    await expect(f.runtime.waitForMemoryProcessing()).rejects.toThrow('could not be durably discarded')
  } finally { release.resolve(); await expect(f.close()).rejects.toThrow('could not be durably discarded') }
})

test('runtime stop fences a projection already waiting to persist and settles its durable discard', async () => {
  const rows = table<MemoryProjection>(), writing = Promise.withResolvers<void>(), releaseWrite = Promise.withResolvers<void>()
  const persisted = Promise.withResolvers<void>(), releaseReturn = Promise.withResolvers<void>()
  const projection: MemoryTable<MemoryProjection> = { ...rows, put: async (id, value) => {
    writing.resolve(); await releaseWrite.promise; await rows.put(id, value); persisted.resolve(); await releaseReturn.promise
  } }
  const f = await fixture(projection)
  let stopping: Promise<void> | undefined
  try {
    f.runtime.observeMemoryRequest(f.agentId, f.request)
    await writing.promise
    stopping = f.runtime.stopAdmittedWork()
    releaseWrite.resolve()
    await persisted.promise
    expect(f.runtime.memoryProcessingStatus(f.agentId).facts).toEqual([])
    releaseReturn.resolve()
    await stopping
    f.runtime.prepareReopen()
    await f.runtime.waitForMemoryProcessing()
    const restored = new MemoryProcessor({ snapshot: () => f.runtime.effectiveSnapshot(), audit: f.audit, projection, extract: async () => { throw new Error('not used') } })
    expect(restored.facts(f.runtime.effectiveSnapshot(), f.agentId)).toEqual([])
    expect([...f.audit.entries()].map(([, audit]) => audit.status)).toEqual(['discarded'])
    f.runtime.observeMemoryRequest(f.agentId, f.request)
    await f.runtime.waitForMemoryProcessing()
    expect(f.runtime.memoryProcessingStatus(f.agentId).facts).toHaveLength(1)
  } finally { releaseWrite.resolve(); releaseReturn.resolve(); await stopping; await f.close() }
})
