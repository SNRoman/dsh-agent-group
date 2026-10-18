import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { apply as domainApply, Config as DomainConfig, inject as domainInject } from '@deepseek-ai/dsh-storage-domain'
import { apply as jsonApply, Config as JsonConfig, inject as jsonInject } from '@deepseek-ai/dsh-storage-json'
import AgentWorkspaceDomainService from '../packages/host/src/index.ts'
import type { WorkspaceRuntime } from '../packages/host/src/workspace-runtime.ts'
import type { WorkspaceRecordV3 } from '../packages/host/src/workspace-record.ts'
import { createInitialWorkflowState } from '../packages/host/src/workflow.ts'
import { createInitialCommunicationState } from '../packages/host/src/communication.ts'
import { queryAgentMemory } from '../packages/host/src/memory-query.ts'
import { agentWorkspaceSpec } from '../packages/host/src/spec.ts'
import { AgentId, AgentMemoryEntryId, HumanId, TaskDeliveryAttemptId, TaskId, WorkspaceEventId, WorkspaceId } from '../packages/host/src/ids.ts'
import type { WorkspaceState } from '../packages/host/src/types.ts'
import type { TaskId as WorkspaceTaskId } from '../packages/host/src/ids.ts'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { assignHumanTask, recordChildRunStarted } from '../packages/host/src/tasks.ts'
import { TaskDeliveryCoordinator } from '../packages/host/src/task-delivery-coordinator.ts'
import type { TaskDeliveryCoordinatorHost } from '../packages/host/src/task-delivery-coordinator.ts'
import { memoryAuditSpec, memoryProjectionSpec } from '../packages/host/src/memory-projection.ts'
import type { MemoryAudit, MemoryExtractionInput } from '../packages/host/src/memory-projection.ts'
import { MemoryProcessor, sourceDigest } from '../packages/host/src/memory-processor.ts'
import { mutateWorkspace } from '../packages/host/src/state.ts'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { WorkspaceTurnTracker } from '../packages/host/src/turn-tracker.ts'
import { registerWorkspaceMemoryTools } from '../packages/host/src/memory-tools.ts'
import { startTaskDelivery } from '../packages/host/src/task-delivery.ts'
import { getCommunicationInvalidation } from '../packages/host/src/communication.ts'
import { prepareMessageRecall } from '../packages/host/src/message-recall.ts'
import type { ContextResetId } from '../packages/host/src/communication-contract.ts'
import { WEB_WORKSPACE_HUMAN_ID } from '../packages/host/src/rpc.ts'

interface Booted {
  ctx: Context
  service: WorkspaceRuntime
  dispose: () => Promise<void>
}

const roots: string[] = []

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-workspace-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Boot the real storage hub, JSON backend, domain form, and workspace service over one root. */
async function boot(root: string): Promise<Booted> {
  const ctx = new Context()
  try {
    await ctx.plugin(Storage)
    await ctx.plugin({ apply: jsonApply, Config: JsonConfig, inject: jsonInject }, { root })
    await ctx.plugin({ apply: domainApply, Config: DomainConfig, inject: domainInject }, { backend: 'json' })
    await ctx.plugin(AgentWorkspaceDomainService)
    return {
      ctx,
      service: ctx.agentWorkspace.forWorkspace(WorkspaceId('local')),
      dispose: async () => { await ctx.fiber.dispose() },
    }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

describe('agent workspace persistence', () => {
  test.each([1, 2] as const)('boots retained JSON memory unit headers v%i without changing original audit or projection bytes', async version => {
    const root = await freshRoot(), writer = new Context()
    const fibers = [
      await writer.plugin(Storage),
      await writer.plugin({ apply: jsonApply, Config: JsonConfig, inject: jsonInject }, { root }),
      await writer.plugin({ apply: domainApply, Config: DomainConfig, inject: domainInject }, { backend: 'json' }),
    ]
    const input: MemoryExtractionInput = { workspaceId: WorkspaceId('local'), eventId: WorkspaceEventId('retained-source'), sequence: 1,
      actor: { type: 'human', id: HumanId('owner') }, scope: { organizationId: WorkspaceId('local') },
      start: 0, end: 1, totalCharacters: 1, text: 'x', sourceDigest: 'saved-source' }
    const record: MemoryAudit = { version: 1, extractionVersion: version, id: 'retained', input,
      provider: 'saved', model: 'saved', parameters: '{}', system: 'saved', prompt: 'saved',
      status: 'failed', output: '{', stream: '["retained"]', error: 'old unclassified failure' }
    try {
      const audit = await writer.storageDomain.open({ ...memoryAuditSpec, version, compatibleVersions: [] })
      const projection = await writer.storageDomain.open({ ...memoryProjectionSpec, version, compatibleVersions: [], layout: 'single' })
      await audit.table('requests').put(record.id, record)
      await projection.table('fragments').put(record.id, { version, auditId: record.id, input, output: '{' })
      await projection.close(); await audit.close()
    } finally { for (const fiber of fibers.toReversed()) await fiber.dispose() }
    const auditPath = join(root, 'agent_workspace_memory_audit.json'), projectionPath = join(root, 'agent_workspace_memory_projection.json')
    const auditBytes = await readFile(auditPath, 'utf8'), projectionBytes = await readFile(projectionPath, 'utf8')
    const reopened = await boot(root)
    try {
      expect(reopened.service.snapshot().workspaceId).toBe('local')
      expect(reopened.ctx.storageDomain.get(memoryAuditSpec.name)?.table('requests').get(record.id)).toEqual(record)
      expect(reopened.ctx.storageDomain.get(memoryProjectionSpec.name)?.table('fragments').get(record.id)).toEqual({ version, auditId: record.id, input, output: '{' })
    } finally { await reopened.dispose() }
    expect(await readFile(auditPath, 'utf8')).toBe(auditBytes)
    expect(await readFile(projectionPath, 'utf8')).toBe(projectionBytes)
  })

  test.each(['future-version', 'invalid-record'] as const)('rejects retained JSON memory %s without changing its bytes', async failure => {
    const root = await freshRoot(), writer = new Context()
    const fibers = [
      await writer.plugin(Storage),
      await writer.plugin({ apply: jsonApply, Config: JsonConfig, inject: jsonInject }, { root }),
      await writer.plugin({ apply: domainApply, Config: DomainConfig, inject: domainInject }, { backend: 'json' }),
    ]
    try {
      const domain = await writer.storageDomain.open({ ...memoryAuditSpec, version: failure === 'future-version' ? 99 : 2, compatibleVersions: [] })
      await domain.table('requests').put('retained', { version: 1, extractionVersion: 2, id: 'retained',
        input: { workspaceId: WorkspaceId('local'), eventId: WorkspaceEventId('source'), sequence: 1,
          scope: { organizationId: WorkspaceId('local') }, start: 0, end: 1, totalCharacters: 1, text: 'x', sourceDigest: 'saved' },
        provider: 'saved', model: 'saved', parameters: '{}', system: 'saved', prompt: 'saved', status: 'pending' })
      await domain.close()
    } finally { for (const fiber of fibers.toReversed()) await fiber.dispose() }
    const path = join(root, 'agent_workspace_memory_audit.json')
    if (failure === 'invalid-record') {
      const document: { tables: { requests: { retained: Record<string, unknown> } } } = JSON.parse(await readFile(path, 'utf8'))
      document.tables.requests.retained.unrecognizedField = true
      await writeFile(path, JSON.stringify(document), 'utf8')
    }
    const bytes = await readFile(path, 'utf8')
    await expect(boot(root)).rejects.toMatchObject(failure === 'future-version'
      ? { name: 'StorageError', code: 'version-mismatch' } : { code: 'invalid-record' })
    expect(await readFile(path, 'utf8')).toBe(bytes)
  })

  test('native pending task recovery logs its missing recall and attributes later tool sources after JSON reboot', async () => {
    const root = await freshRoot()
    const first = await boot(root)
    await first.service.apply(state => mutateWorkspace(state, { type: 'definition/create', name: 'Writer', description: '', instructions: 'Write' }).state)
    const definitionId = Object.values(first.service.snapshot().definitions)[0]!.id
    await first.service.apply(state => mutateWorkspace(state, { type: 'agent/create', definitionId, name: 'Alice' }).state)
    const agentId = Object.values(first.service.snapshot().agents)[0]!.id
    const room = mutateWorkspace(first.service.snapshot(), { type: 'room/create', kind: 'group', name: 'Team' })
    const joined = mutateWorkspace(room.state, { type: 'room/join', roomId: room.roomId, agentId, memoryStart: { type: 'new-events' } })
    const old = mutateWorkspace(joined.state, { type: 'room/message', roomId: room.roomId,
      actor: { type: 'human', id: WEB_WORKSPACE_HUMAN_ID }, text: 'Old agreed handoff', mentions: [] })
    await first.service.apply(() => old.state)
    let taskId!: TaskId
    await first.service.apply(state => { const assigned = assignHumanTask(state, { humanId: WEB_WORKSPACE_HUMAN_ID, assigneeAgentId: agentId, title: 'Complete frozen task' }); taskId = assigned.taskId; return assigned.state })
    const started = startTaskDelivery(first.service.snapshot(), { taskId })
    await first.service.apply(() => started.state)
    const sessionId = SessionId('pending-native-task')
    await first.service.recordSessionId(agentId, sessionId)
    const session = Session.create(sessionId)
    const originalAgent = { session, ctx: new Context() } as Agent
    const admit = Reflect.get(first.service, 'admitManagedInput') as (agentId: AgentId, agent: Agent, delivery: UserMessage, recall: UserMessage | undefined, source: { kind: 'task'; taskId: TaskId; attemptId: typeof started.attemptId }) => Promise<UserMessage>
    const prepared = await admit.call(first.service, agentId, originalAgent, started.message, undefined, { kind: 'task', taskId, attemptId: started.attemptId })
    expect(prepared.source.kind).toBe('agent-workspace-context')
    expect(session.snapshotEvents().some(event => event.type === 'user/message')).toBe(false)
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [started.message] })
    await writeFile(join(root, 'pending-session.json'), JSON.stringify(session.snapshotEvents()), 'utf8')
    const originalInput = Object.values(first.service.directory.record(first.service.workspaceId).communication.inputs)[0]!
    await first.dispose()

    const second = await boot(root)
    expect(second.service.directory.record(second.service.workspaceId).communication.inputs[originalInput.id]).toEqual(originalInput)
    const llmCtx = new Context()
    let nativeAgent: Agent | undefined
    let laterId: WorkspaceEventId | undefined
    const requests: GenerateOptions[] = []
    const adapter = new class extends LlmAdapter {
      override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> { return { provider, id: model, name: model } }
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options)
        if (requests.length === 1) {
          const later = mutateWorkspace(second.service.snapshot(), { type: 'room/message', roomId: room.roomId,
            actor: { type: 'human', id: WEB_WORKSPACE_HUMAN_ID }, text: 'Later secret: Friday 16:00', mentions: [] })
          laterId = later.eventId
          await second.service.apply(() => later.state)
          const id = ToolCallId('recovered-read')
          const args = JSON.stringify({ eventId: later.eventId, offset: 0 })
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id, name: 'workspace_read_memory', argumentsDelta: args }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'workspace_read_memory', arguments: args } }
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        } else {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: 'Recovered answer' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Recovered answer' } }
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
    }()
    try {
      await mountAgentLoopTestDependencies(llmCtx)
      llmCtx.effect(() => llmCtx.llm.registerAdapter(['mock'], adapter))
      const unregister = registerWorkspaceMemoryTools(llmCtx.tools, second.service, { characterBudget: 1000, resultLimit: 10 })
      llmCtx.effect(() => unregister)
      await llmCtx.plugin((await import('@deepseek-ai/dsh-agent-loop')).default, { agents: [] })
      const seed = JSON.parse(await readFile(join(root, 'pending-session.json'), 'utf8')) as ReturnType<Session['snapshotEvents']>
      const coordinator = new TaskDeliveryCoordinator({ snapshot: () => second.service.snapshot(), apply: mutation => second.service.apply(mutation),
        ensureEmployee: async () => { throw new Error('recovery must not create an employee') },
        deliver: async () => { throw new Error('recovery must not append a new delivery') },
        prepareRecoveredDelivery: async (id, handle, delivery, source) => await second.service.prepareRecoveredDelivery(id, handle, delivery, source),
        recoverDelivery: async (id, handle, delivery, source, hooks, recall) => await second.service.recoverDelivery(id, handle, delivery, source, hooks, recall) })
      const handle = await llmCtx.agents.create({ sessionId, seed: [...seed], meta: { cwd: root }, agentOptions: { provider: 'mock', model: 'mock' },
        setup: async (agentCtx, agent) => {
          nativeAgent = agent
          await expect(second.service.prepareRecoveredDelivery(agentId, { agent }, started.message,
            { kind: 'task', taskId, attemptId: TaskDeliveryAttemptId('wrong-attempt') })).rejects.toThrow('source or session differs')
          const tracker = new WorkspaceTurnTracker()
          tracker.install(agentCtx)
          Object.assign(second.service, { pool: { roleRevisionFor: () => second.service.snapshot().agents[agentId]!.definitionRevisionId,
            agentIdFor: (candidate: Agent) => candidate === agent ? agentId : undefined }, trackers: new Map([[agentId, tracker]]) })
          expect(await coordinator.recoverAgent(agentId, { agent })).toEqual([{ taskId, status: 'pending' }])
        } })
      expect(handle.agent.session.header.cwd).toBe(root)
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Wake the restored queue' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      await coordinator.drain()
      expect(nativeAgent?.inbox.nextTurn).toEqual([])
      expect(requests.length).toBeGreaterThanOrEqual(2)
      expect(requests[0]!.messages.some(message => message.id === started.message.id)).toBe(true)
      expect(JSON.stringify(requests[0]!.messages)).toContain('Old agreed handoff')
      expect(JSON.stringify(requests[0]!.messages)).not.toContain('Later secret: Friday 16:00')
      const logged = handle.agent.session.snapshotEvents()
      const scene = logged.flatMap(event => event.type === 'user/message' && event.data.source?.kind === 'agent-workspace-context' ? [event.data] : [])
      expect(scene[0]?.source).toMatchObject({ id: originalInput.id, memoryReceipt: { version: 1 } })
      expect(scene.some(message => message.source.kind === 'agent-workspace-context' && message.source.recalledEventIds.includes(laterId!))).toBe(true)
      const savedInput = second.service.directory.record(second.service.workspaceId).communication.inputs[originalInput.id]!
      expect(savedInput.recalledEventIds).toContain(laterId)
      const recalled = prepareMessageRecall(second.service.directory.record(second.service.workspaceId), { operationId: 'recovered-withdrawal' as ContextResetId,
        roomId: room.roomId, eventId: laterId!, humanId: WEB_WORKSPACE_HUMAN_ID, requestedAt: '2026-10-16T00:00:00.000Z', restoreFiles: false })
      const invalid = getCommunicationInvalidation(recalled.aggregate, recalled.communication)
      expect(invalid.inputIds.has(originalInput.id)).toBe(true)
      expect(invalid.taskIds.has(taskId)).toBe(true)
      await expect(second.service.recordMemoryToolRead(handle.agent, [laterId!], 'late result')).rejects.toThrow('no managed input')
      await handle.dispose()
    } finally { await llmCtx.fiber.dispose(); await second.dispose() }
  }, 15000)
  test('retains v1 raw audit through JSON reboot but only an on-use v2 request rebuilds current core', async () => {
    const root = await freshRoot()
    const first = await boot(root)
    await first.service.executeInternal({ type: 'definition/create', name: 'Worker', description: '', instructions: '' })
    const definitionId = Object.values(first.service.snapshot().definitions)[0]!.id
    await first.service.executeInternal({ type: 'agent/create', definitionId, name: 'Alice' })
    const agentId = Object.values(first.service.snapshot().agents)[0]!.id
    await first.service.executeInternal({ type: 'room/create', kind: 'group', name: 'Team' })
    const roomId = Object.values(first.service.snapshot().rooms)[0]!.id
    await first.service.executeInternal({ type: 'room/join', roomId, agentId, memoryStart: { type: 'new-events' } })
    const complete = mutateWorkspace(first.service.snapshot(), { type: 'room/message', roomId,
      actor: { type: 'human', id: HumanId('owner') }, text: 'For all work correspondence, please use English email.', mentions: [] })
    const failed = mutateWorkspace(complete.state, { type: 'room/message', roomId,
      actor: { type: 'human', id: HumanId('owner') }, text: 'Another saved source', mentions: [] })
    await first.service.apply(() => failed.state)
    const event = first.service.snapshot().events.find(item => item.id === complete.eventId)!
    const other = first.service.snapshot().events.find(item => item.id === failed.eventId)!
    const inputFor = (source: typeof event): MemoryExtractionInput => ({ workspaceId: first.service.workspaceId,
      eventId: source.id, sequence: source.sequence, actor: source.actor!, scope: { organizationId: first.service.workspaceId, roomId },
      start: 0, end: source.text!.length, totalCharacters: source.text!.length, text: source.text!, sourceDigest: sourceDigest(source) })
    const input = inputFor(event)
    const failedInput = inputFor(other)
    const output = JSON.stringify({ facts: [{ category: 'communication', subject: 'source-actor', key: 'email-language', value: 'English',
      scope: { organizationId: first.service.workspaceId, roomId }, sourceQuote: 'English email', assertionKind: 'human-explicit' }] })
    await first.dispose()
    const writerCtx = new Context()
    const writerFibers = [
      await writerCtx.plugin(Storage),
      await writerCtx.plugin({ apply: jsonApply, Config: JsonConfig, inject: jsonInject }, { root }),
      await writerCtx.plugin({ apply: domainApply, Config: DomainConfig, inject: domainInject }, { backend: 'json' }),
    ]
    const audit = await writerCtx.storageDomain.open(memoryAuditSpec)
    const projection = await writerCtx.storageDomain.open(memoryProjectionSpec)
    const record = (id: string, source: MemoryExtractionInput): MemoryAudit => ({ version: 1, extractionVersion: 1, id, input: source,
      provider: 'saved', model: 'saved', parameters: '{}', system: 'Agent Workspace source fact extraction v1. Return only the requested JSON.',
      prompt: 'saved', status: 'completed', output, stream: 'saved' })
    await audit.table('requests').put('complete', record('complete', input))
    await audit.table('requests').put('failed', { ...record('failed', failedInput), status: 'failed', error: 'provider unavailable', output: undefined })
    await projection.table('fragments').put('complete', { version: 1, auditId: 'complete', input, output })
    await projection.close()
    await audit.close()
    for (const fiber of writerFibers.toReversed()) await fiber.dispose()
    const diskBeforeRead = await readFile(join(root, 'agent_workspace_memory_audit.json'), 'utf8')

    const second = await boot(root)
    const restoredState = second.service.snapshot()
    try {
      expect(second.service.memoryProcessingStatus(agentId).available).toBe(false)
      const page = second.service.queryMemory({ agentId, snapshotRevision: second.service.snapshot().revision, limit: 20 })
      expect(page.items.find(item => item.eventId === complete.eventId)?.processing).toMatchObject({ status: 'unprocessed', available: false, facts: [] })
      expect(page.items.find(item => item.eventId === failed.eventId)?.processing).toMatchObject({ status: 'unprocessed', available: false, facts: [] })
    } finally { await second.dispose() }
    expect(await readFile(join(root, 'agent_workspace_memory_audit.json'), 'utf8')).toBe(diskBeforeRead)
    const rebuildCtx = new Context()
    const rebuildFibers = [
      await rebuildCtx.plugin(Storage),
      await rebuildCtx.plugin({ apply: jsonApply, Config: JsonConfig, inject: jsonInject }, { root }),
      await rebuildCtx.plugin({ apply: domainApply, Config: DomainConfig, inject: domainInject }, { backend: 'json' }),
    ]
    const reopenedAudit = await rebuildCtx.storageDomain.open(memoryAuditSpec)
    const reopenedProjection = await rebuildCtx.storageDomain.open(memoryProjectionSpec)
    let calls = 0
    const v2Output = JSON.stringify({ facts: [{ kind: 'controlled', property: 'communication.language', subject: 'source-actor',
      temporal: 'current', operation: 'set', value: 'English', application: { kind: 'organization', evidence: 'For all work correspondence' },
      sourceQuote: event.text!, assertionKind: 'human-explicit' }] })
    try {
      const processor = new MemoryProcessor({ snapshot: () => restoredState, audit: reopenedAudit.table('requests'),
        projection: reopenedProjection.table('fragments'), extract: async () => { calls++; return { text: v2Output, stream: '["v2"]' } } })
      expect(processor.facts(restoredState, agentId)).toEqual([])
      expect(processor.progress(restoredState, agentId).find(item => item.eventId === event.id)?.status).toBe('unprocessed')
      expect(reopenedAudit.table('requests').get('complete')).toEqual(record('complete', input))
      const fragment = { workspaceId: restoredState.workspaceId, event, start: 0, end: event.text!.length, text: event.text! }
      await processor.process(fragment, { provider: 'saved', model: 'saved' })
      expect(calls).toBe(1)
      expect(processor.facts(restoredState, agentId).map(fact => [fact.value, fact.scope.roomId])).toEqual([['English', undefined]])
      expect(processor.progress(restoredState, agentId).find(item => item.eventId === event.id)?.status).toBe('complete')
      expect(reopenedAudit.table('requests').get('complete')).toEqual(record('complete', input))
    } finally {
      await reopenedProjection.close()
      await reopenedAudit.close()
      for (const fiber of rebuildFibers.toReversed()) await fiber.dispose()
    }
  })

  test('loads and preserves legacy duplicate memory associations while querying first provenance', async () => {
    const root = await freshRoot()
    const fixture = new URL('./fixtures/v0.1.0/agent-workspace.json', import.meta.url)
    const stored = JSON.parse(await readFile(fixture, 'utf8')) as {
      unit: { name: string; version: number }
      global: null
      tables: { workspaces: { local: WorkspaceState } }
    }
    const originalEntry = stored.tables.workspaces.local.memoryEntries[0]!
    stored.tables.workspaces.local = {
      ...stored.tables.workspaces.local,
      nextId: 9,
      memoryEntries: [
        originalEntry,
        { ...originalEntry, id: AgentMemoryEntryId('memory-8'), acquiredBy: 'history-sync' },
      ],
    }
    await writeFile(join(root, 'agent_workspace.json'), JSON.stringify(stored), 'utf8')

    const first = await boot(root)
    const snapshot = first.service.snapshot()
    const agentId = Object.values(snapshot.agents)[0]!.id
    expect(first.service.queryMemory({ agentId, snapshotRevision: snapshot.revision, limit: 10 }).items).toEqual([
      expect.objectContaining({ eventId: originalEntry.eventId, provenance: 'room-membership' }),
    ])
    const afterBootText = await readFile(join(root, 'agent_workspace.json'), 'utf8')
    const afterBoot = JSON.parse(afterBootText) as { tables: { workspaces: { local: WorkspaceRecordV3 } } }
    expect(afterBoot.tables.workspaces.local).toEqual({
      recordVersion: 3,
      descriptor: { id: 'local', label: 'Local organization', lifecycle: 'active' },
      aggregate: stored.tables.workspaces.local,
      workflow: createInitialWorkflowState(),
      communication: createInitialCommunicationState(),
    })
    await first.dispose()

    const second = await boot(root)
    const restarted = second.service.snapshot()
    expect(await readFile(join(root, 'agent_workspace.json'), 'utf8')).toBe(afterBootText)
    expect(restarted.memoryEntries).toHaveLength(2)
    expect(second.service.queryMemory({ agentId, snapshotRevision: restarted.revision, limit: 10 }).items).toEqual([
      expect.objectContaining({ eventId: originalEntry.eventId, provenance: 'room-membership' }),
    ])
    await second.dispose()
  })

  test('opens, mutates, and restarts an authentic v0.1.0 workspace', async () => {
    const root = await freshRoot()
    const fixture = new URL('./fixtures/v0.1.0/agent-workspace.json', import.meta.url)
    const stored = JSON.parse(await readFile(fixture, 'utf8')) as {
      tables: { workspaces: { local: unknown } }
    }
    await copyFile(fixture, join(root, 'agent_workspace.json'))

    const first = await boot(root)
    expect(first.service.snapshot()).toEqual(stored.tables.workspaces.local)
    await first.service.executeInternal({ type: 'room/create', kind: 'group', name: 'release follow-up' })
    const afterMutation = first.service.snapshot()
    expect(afterMutation.revision).toBe(6)
    await first.dispose()

    const second = await boot(root)
    expect(second.service.snapshot()).toEqual(afterMutation)
    await second.dispose()
  })

  test('restores the committed aggregate after teardown and reboot', async () => {
    const root = await freshRoot()
    const first = await boot(root)
    await first.service.executeInternal({
      type: 'definition/create',
      name: 'Java engineer',
      description: 'Build Java services',
      instructions: 'Act as a Java engineer.',
    })
    let snapshot = first.service.snapshot()
    const definition = Object.values(snapshot.definitions)[0]!
    await first.service.executeInternal({ type: 'agent/create', definitionId: definition.id, name: 'Alice' })
    snapshot = first.service.snapshot()
    const agent = Object.values(snapshot.agents)[0]!
    await first.service.executeInternal({ type: 'room/create', kind: 'group', name: 'engineering' })
    snapshot = first.service.snapshot()
    const room = Object.values(snapshot.rooms)[0]!
    await first.service.executeInternal({ type: 'room/join', roomId: room.id, agentId: agent.id, memoryStart: { type: 'new-events' } })
    await first.service.executeInternal({
      type: 'room/message',
      roomId: room.id,
      actor: { type: 'human', id: HumanId('owner') },
      text: 'Release on Friday',
      mentions: [agent.id],
    })
    const after = first.service.snapshot()
    expect(after.revision).toBe(5)
    const beforeRestartMemory = queryAgentMemory(after, { agentId: agent.id, snapshotRevision: after.revision, limit: 10 })
    expect(beforeRestartMemory.items).toHaveLength(1)
    await first.service.executeInternal({ type: 'agent/depart', agentId: agent.id })
    const departed = first.service.snapshot()
    await first.dispose()

    const second = await boot(root)
    expect(second.service.snapshot()).toEqual(departed)
    expect(queryAgentMemory(second.service.snapshot(), {
      agentId: agent.id, snapshotRevision: departed.revision, limit: 10,
    }).items).toEqual(beforeRestartMemory.items)
    await second.dispose()
  })

  test('rejects a stored domain version mismatch at open', async () => {
    const root = await freshRoot()
    await writeFile(
      join(root, 'agent_workspace.json'),
      JSON.stringify({ unit: { name: 'agent_workspace', version: 1 }, global: null, tables: { workspaces: {} } }),
      'utf8',
    )
    const ctx = new Context()
    const fibers = [
      await ctx.plugin(Storage),
      await ctx.plugin({ apply: jsonApply, Config: JsonConfig, inject: jsonInject }, { root }),
      await ctx.plugin({ apply: domainApply, Config: DomainConfig, inject: domainInject }, { backend: 'json' }),
    ]
    await expect(ctx.storageDomain.open(agentWorkspaceSpec)).rejects.toMatchObject({ code: 'version-mismatch' })
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  })

  test('a rejected command leaves the committed aggregate unchanged', async () => {
    const root = await freshRoot()
    const booted = await boot(root)
    const before = booted.service.snapshot()
    await expect(booted.service.executeInternal({ type: 'agent/depart', agentId: AgentId('missing') })).rejects.toThrow(/does not exist/)
    const after = booted.service.snapshot()
    expect(after.revision).toBe(before.revision)
    expect(after.events).toEqual(before.events)
    await booted.dispose()
  })

  test('restarts after a failed wake and retries the same durable task', async () => {
    const root = await freshRoot()
    const first = await boot(root)
    await first.service.executeInternal({ type: 'definition/create', name: 'Worker', description: 'work', instructions: 'reply' })
    let snapshot = first.service.snapshot()
    const definition = Object.values(snapshot.definitions)[0]!
    await first.service.executeInternal({ type: 'agent/create', definitionId: definition.id, name: 'Alice' })
    snapshot = first.service.snapshot()
    const agent = Object.values(snapshot.agents)[0]!
    let taskId: WorkspaceTaskId | undefined
    await first.service.apply(current => {
      const assigned = assignHumanTask(current, {
        humanId: HumanId('owner'),
        assigneeAgentId: agent.id,
        title: 'persist me',
      })
      taskId = assigned.taskId
      return assigned.state
    })
    if (taskId === undefined) throw new Error('task assignment did not publish an id')
    const fakeHandle = { agent: { id: 'session' } as never, dispose: async () => {} } as AgentHandle
    let firstMessage: Parameters<TaskDeliveryCoordinatorHost['deliver']>[1] | undefined
    const failedHost: TaskDeliveryCoordinatorHost = {
      snapshot: () => first.service.snapshot(),
      apply: async mutation => await first.service.apply(mutation),
      ensureEmployee: async () => fakeHandle,
      deliver: async (_agentId, message) => { firstMessage = message; throw new Error('wake failed') },
    }
    await expect(new TaskDeliveryCoordinator(failedHost).deliver(taskId)).rejects.toThrow('wake failed')
    if (firstMessage === undefined || firstMessage.source.kind !== 'agent-workspace-delivery') throw new Error('first task input was not delivered')
    expect(firstMessage.content).toEqual([{ type: 'text', text: 'persist me' }])
    const originalSourceEventId = firstMessage.source.sourceEventId
    const beforeRestart = first.service.snapshot()
    await first.dispose()

    const second = await boot(root)
    expect(second.service.snapshot()).toEqual(beforeRestart)
    const resumedHost: TaskDeliveryCoordinatorHost = {
      snapshot: () => second.service.snapshot(),
      apply: async mutation => await second.service.apply(mutation),
      ensureEmployee: async () => fakeHandle,
      deliver: async (_agentId, message, _recall, _source, hooks) => {
        expect(message.content).toEqual([{ type: 'text', text: 'persist me' }])
        expect(message.source).toMatchObject({ kind: 'agent-workspace-delivery', sourceEventId: originalSourceEventId })
        await hooks?.onClaim?.()
        return { output: [{ type: 'text', text: 'finished after restart' }], stopReason: { kind: 'completed' }, interrupted: false }
      },
    }
    await expect(new TaskDeliveryCoordinator(resumedHost).retryTaskDelivery(taskId)).resolves.toBe('finished after restart')
    const afterRetry = second.service.snapshot()
    expect(Object.keys(afterRetry.tasks)).toEqual([taskId])
    expect(afterRetry.events.filter(event => event.type === 'task/delivery-started')).toHaveLength(2)
    expect(afterRetry.events.filter(event => event.type === 'task/result')).toHaveLength(1)
    await second.dispose()
  })

  test('the Host exposes durable task retry through its service boundary', async () => {
    const root = await freshRoot()
    const booted = await boot(root)

    await expect(booted.service.retryTaskDelivery(booted.service.snapshot().revision, TaskId('missing'))).rejects.toThrow(/coordinator is not available/)

    await booted.dispose()
  })

  test('repairs a durable running child before the restarted Host accepts work', async () => {
    const root = await freshRoot()
    const first = await boot(root)
    await first.service.executeInternal({ type: 'definition/create', name: 'Worker', description: 'work', instructions: 'reply' })
    let snapshot = first.service.snapshot()
    const definition = Object.values(snapshot.definitions)[0]!
    await first.service.executeInternal({ type: 'agent/create', definitionId: definition.id, name: 'Alice' })
    snapshot = first.service.snapshot()
    const agent = Object.values(snapshot.agents)[0]!
    let childRunId: ReturnType<typeof recordChildRunStarted>['childRunId'] | undefined
    await first.service.apply(current => {
      const assigned = assignHumanTask(current, {
        humanId: HumanId('owner'), assigneeAgentId: agent.id, title: 'orphan me',
      })
      const started = recordChildRunStarted(assigned.state, {
        parentAgentId: agent.id, taskId: assigned.taskId,
      })
      childRunId = started.childRunId
      return started.state
    })
    if (childRunId === undefined) throw new Error('child run start did not publish an id')
    expect(first.service.snapshot().childRuns[childRunId]?.status).toBe('running')
    await first.dispose()

    const second = await boot(root)
    expect(second.service.snapshot().childRuns[childRunId]).toMatchObject({
      status: 'cancelled',
      result: 'Host restarted before the child run settled.',
    })
    expect(second.service.snapshot().events.filter(event => (
      event.type === 'child/run-finished' && event.subjectId === childRunId
    ))).toHaveLength(1)
    await second.dispose()
  })
})
