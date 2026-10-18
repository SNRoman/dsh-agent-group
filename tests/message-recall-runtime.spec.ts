import { expect, test, vi } from 'vitest'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { workflowRuntime } from './workflow-test-support.ts'
import { EmployeeAgentPool } from '../packages/host/src/runtime.ts'
import { WEB_WORKSPACE_HUMAN_ID } from '../packages/host/src/rpc.ts'
import { mutateWorkspace } from '../packages/host/src/state.ts'
import type { ContextResetId, CommunicationInputId } from '../packages/host/src/communication-contract.ts'
import { registerWorkspaceMemoryTools } from '../packages/host/src/memory-tools.ts'
import type { WorkspaceToolRegistry } from '../packages/host/src/task-tools.ts'

function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
async function fixture() {
  const f = await workflowRuntime()
  const room = mutateWorkspace(f.runtime.snapshot(), { type: 'room/create', kind: 'group', name: 'Team' })
  const joined = mutateWorkspace(room.state, { type: 'room/join', roomId: room.roomId, agentId: f.agentId, memoryStart: { type: 'new-events' } })
  const source = mutateWorkspace(joined.state, { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: WEB_WORKSPACE_HUMAN_ID }, text: 'WITHDRAWN_RUNTIME_MARKER', mentions: [] })
  await f.directory.updateAggregate(f.runtime.workspaceId, () => source.state)
  let created = 0, resumed = 0, disposed = 0, failDisposal = false
  const sessionIds: SessionId[] = []
  const pool = new EmployeeAgentPool({ create: async options => {
    created++
    const sessionId = options.sessionId!
    sessionIds.push(sessionId)
    const agent = { id: sessionId, whenIdle: async () => {} } as Agent
    return { agent, dispose: async () => { disposed++; if (failDisposal) throw new Error('dispose failed') } } satisfies AgentHandle
  }, resume: async () => { resumed++; throw new Error('Old session must not be resumed.') } }, f.runtime)
  Object.assign(f.runtime, { pool })
  const old = await pool.ensure(f.agentId)
  const request = () => ({ operationId: 'recall' as ContextResetId, roomId: room.roomId, eventId: source.eventId, expectedRevision: f.runtime.snapshot().revision, restoreFiles: false })
  return { ...f, roomId: room.roomId, sourceId: source.eventId, pool, old, request, sessionIds, counts: () => ({ created, resumed, disposed }), failDisposal: (value: boolean) => { failDisposal = value } }
}
test('runtime replaces an already-read employee with an unseeded session and filters registered memory tools', async () => {
  const f = await fixture()
  try {
    expect(f.runtime.queryMemory({ agentId: f.agentId, snapshotRevision: f.runtime.snapshot().revision, limit: 50 }).items.some(item => item.text?.includes('WITHDRAWN_RUNTIME_MARKER'))).toBe(true)
    const result = await f.runtime.recallMessage(f.request())
    expect(result.communication.resets.recall?.status).toBe('completed')
    expect(f.counts()).toEqual({ created: 2, resumed: 0, disposed: 1 })
    expect(f.runtime.sessionIdFor(f.agentId)).toBe(f.sessionIds[1])
    await f.runtime.recordSessionId(f.agentId, SessionId('replacement-after-reset'))
    expect(f.runtime.communicationSnapshot().communication.contexts[f.agentId]?.sessionId).toBe(SessionId('replacement-after-reset'))
    expect(f.sessionIds[1]).not.toBe(f.sessionIds[0])
    expect(f.runtime.agentIdFor(f.old.agent)).toBeUndefined()
    expect(f.runtime.queryMemory({ agentId: f.agentId, snapshotRevision: f.runtime.snapshot().revision, limit: 50 }).items.some(item => item.text?.includes('WITHDRAWN_RUNTIME_MARKER'))).toBe(false)
    let tools: Parameters<WorkspaceToolRegistry['register']>[0][] = []
    const remove = registerWorkspaceMemoryTools({ register: tool => { tools.push(tool); return () => { tools = tools.filter(item => item !== tool) } } }, f.runtime, { characterBudget: 4000, resultLimit: 10 })
    const fresh = await f.pool.ensure(f.agentId)
    const search = tools.find(tool => tool.name === 'workspace_search_memory')!
    expect(await search.execute({ query: 'WITHDRAWN_RUNTIME_MARKER' }, { agent: fresh.agent, signal: new AbortController().signal } as never)).toMatchObject({ events: [] })
    await expect(search.execute({ query: 'WITHDRAWN_RUNTIME_MARKER' }, { agent: f.old.agent, signal: new AbortController().signal } as never)).rejects.toThrow('active employee')
    remove()
  } finally { await f.pool.disposeAll() }
})

test('later file consent and its retry exclude files from an earlier opted-out withdrawal', async () => {
  const f = await fixture()
  const journal = { preview: vi.fn().mockResolvedValue([]), restore: vi.fn().mockResolvedValue([]) }
  Object.assign(f.runtime, { fileJournal: journal })
  const addInput = async (name: string, eventId: typeof f.sourceId, generation: number) => {
    const id = name as CommunicationInputId
    await f.directory.updateRecord(f.runtime.workspaceId, record => ({ record: { ...record, communication: { ...record.communication, inputs: { ...record.communication.inputs, [id]: { id, agentId: f.agentId, contextGeneration: generation, target: { kind: 'room-input', eventId }, recordedAtSequence: record.aggregate.nextSequence - 1, directEventIds: [eventId], recalledEventIds: [], sessionEventIds: [] } } } }, value: undefined }))
    return id
  }
  try {
    await addInput('first', f.sourceId, 0)
    await f.runtime.recallMessage(f.request())
    expect(journal.restore).not.toHaveBeenCalled()
    const later = mutateWorkspace(f.runtime.snapshot(), { type: 'room/message', roomId: f.roomId, actor: { type: 'human', id: WEB_WORKSPACE_HUMAN_ID }, text: 'Independent later work', mentions: [] })
    await f.directory.updateAggregate(f.runtime.workspaceId, () => later.state)
    const second = await addInput('second', later.eventId, 1)
    await f.runtime.previewRecall(f.roomId, later.eventId)
    expect(journal.preview.mock.lastCall?.[1]).toEqual(new Set([second]))
    const operationId = 'second-recall' as ContextResetId
    await f.runtime.recallMessage({ ...f.request(), operationId, eventId: later.eventId, restoreFiles: true })
    await f.runtime.retryRecallFiles(operationId)
    expect(journal.restore.mock.calls.map(call => call[1])).toEqual([new Set([second]), new Set([second])])
  } finally { await f.pool.disposeAll() }
})
test('a pending old output cannot cross the withdrawal commit; cleanup waits for that old operation', async () => {
  const f = await fixture(), output = barrier(), fenced = barrier()
  try {
    const old = f.runtime.runNewOperation(async () => {
      await output.promise
      await f.runtime.apply(state => mutateWorkspace(state, { type: 'room/message', roomId: f.roomId, actor: { type: 'agent', id: f.agentId }, text: 'Late WITHDRAWN_RUNTIME_MARKER', mentions: [] }).state)
    })
    const rejected = expect(old).rejects.toThrow('Old colleague context')
    f.afterTransform(() => { fenced.release() })
    const recall = f.runtime.recallMessage(f.request())
    await fenced.promise
    output.release()
    await rejected
    await recall
    expect(f.runtime.snapshot().events.some(event => event.text?.startsWith('Late'))).toBe(false)
  } finally { output.release(); f.afterTransform(); await f.pool.disposeAll() }
})
test('a stop failure never becomes completion on retry just because the old handle was unpublished', async () => {
  const f = await fixture()
  f.failDisposal(true)
  await expect(f.runtime.recallMessage(f.request())).rejects.toThrow('dispose failed')
  expect(f.runtime.communicationSnapshot().communication.resets.recall?.status).toBe('failed')
  expect(f.runtime.sessionIdFor(f.agentId)).toBeUndefined()
  await expect(f.runtime.recallMessage(f.request())).rejects.toThrow('dispose failed')
  expect(f.counts().created).toBe(1)
  f.failDisposal(false)
  await f.runtime.recallMessage(f.request())
  expect(f.runtime.sessionIdFor(f.agentId)).toBe(f.sessionIds[1])
  await f.pool.disposeAll()
})
test('concurrent withdrawal is fenced before the durable prepare finishes', async () => {
  const f = await fixture(), entered = barrier(), release = barrier()
  f.beforeUpdate(async () => { entered.release(); await release.promise })
  const first = f.runtime.recallMessage(f.request())
  await entered.promise
  await expect(f.runtime.recallMessage(f.request())).rejects.toThrow('already running')
  f.beforeUpdate(); release.release()
  await first
  expect(f.counts().created).toBe(2)
  await f.pool.disposeAll()
})
test('completed memory reset can retry file recovery separately without rotating sessions again', async () => {
  const f = await fixture()
  const restore = vi.fn(async () => [])
  Object.assign(f.runtime, { fileJournal: { restore } })
  try {
    await f.runtime.recallMessage({ ...f.request(), restoreFiles: true })
    const before = f.runtime.communicationSnapshot()
    await f.runtime.retryRecallFiles('recall' as ContextResetId)
    expect(restore).toHaveBeenCalledTimes(2)
    expect(f.runtime.communicationSnapshot().communication.contexts).toEqual(before.communication.contexts)
    expect(f.counts().created).toBe(2)
  } finally { await f.pool.disposeAll() }
})
