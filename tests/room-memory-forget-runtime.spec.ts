import { expect, test } from 'vitest'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Context } from '@deepseek-ai/cordis'
import { workflowRuntime } from './workflow-test-support.ts'
import { EmployeeAgentPool } from '../packages/host/src/runtime.ts'
import type { AgentLifecycle } from '../packages/host/src/runtime.ts'
import { WEB_WORKSPACE_HUMAN_ID } from '../packages/host/src/rpc.ts'
import { mutateWorkspace } from '../packages/host/src/state.ts'
import type { ContextResetId } from '../packages/host/src/communication-contract.ts'
import { assignHumanTask, recordChildRunStarted } from '../packages/host/src/tasks.ts'
import { registerWorkspaceMemoryTools } from '../packages/host/src/memory-tools.ts'
import type { WorkspaceToolRegistry } from '../packages/host/src/task-tools.ts'
import type { ChildControllerRegistry } from '../packages/host/src/child-controller.ts'
import type { ChildRunId } from '../packages/host/src/ids.ts'
import { WorkspaceRuntime } from '../packages/host/src/workspace-runtime.ts'
import AgentWorkspaceDomainService from '../packages/host/src/index.ts'
import type { ResolvedConfig } from '../packages/host/src/index.ts'
import { prepareRoomMemoryForget } from '../packages/host/src/room-memory-forget.ts'
import { acceptTaskDelivery, inspectTaskDelivery, startTaskDelivery } from '../packages/host/src/task-delivery.ts'

function barrier() { return Promise.withResolvers<void>() }

async function fixture() {
  const f = await workflowRuntime()
  const second = mutateWorkspace(f.runtime.snapshot(), { type: 'agent/create', name: 'Bob', definitionId: f.runtime.snapshot().agents[f.agentId]!.definitionId })
  const room = mutateWorkspace(second.state, { type: 'room/create', kind: 'group', name: 'Group to leave' })
  const joined = mutateWorkspace(room.state, { type: 'room/join', roomId: room.roomId, agentId: f.agentId, memoryStart: { type: 'new-events' } })
  const secondJoined = mutateWorkspace(joined.state, { type: 'room/join', roomId: room.roomId, agentId: second.agentId, memoryStart: { type: 'new-events' } })
  const source = mutateWorkspace(secondJoined.state, { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: WEB_WORKSPACE_HUMAN_ID }, text: 'PRIVATE_GROUP_MARKER', mentions: [] })
  const outsideRoom = mutateWorkspace(source.state, { type: 'room/create', kind: 'group', name: 'Independent group' })
  const outsideJoined = mutateWorkspace(outsideRoom.state, { type: 'room/join', roomId: outsideRoom.roomId, agentId: f.agentId, memoryStart: { type: 'new-events' } })
  const outsideSecondJoined = mutateWorkspace(outsideJoined.state, { type: 'room/join', roomId: outsideRoom.roomId, agentId: second.agentId, memoryStart: { type: 'new-events' } })
  const outsideSource = mutateWorkspace(outsideSecondJoined.state, { type: 'room/message', roomId: outsideRoom.roomId, actor: { type: 'human', id: WEB_WORKSPACE_HUMAN_ID }, text: 'INDEPENDENT_MARKER', mentions: [] })
  await f.directory.updateAggregate(f.runtime.workspaceId, () => outsideSource.state)
  let created = 0, resumed = 0, disposed = 0, failDisposal = false
  const sessionIds: SessionId[] = []
  const disposedSessions: SessionId[] = [], cancelledSessions: SessionId[] = []
  const lifecycle: AgentLifecycle = { create: async options => {
    created++
    const sessionId = options.sessionId!
    sessionIds.push(sessionId)
    const agent = { id: sessionId, whenIdle: async () => {}, cancel: () => { cancelledSessions.push(sessionId) } } as Agent
    return { agent, dispose: async () => { disposed++; disposedSessions.push(sessionId); if (failDisposal) throw new Error('dispose failed') } } satisfies AgentHandle
  }, resume: async () => { resumed++; throw new Error('Old session must not be resumed.') } }
  const pool = new EmployeeAgentPool(lifecycle, f.runtime)
  Object.assign(f.runtime, { pool })
  const old = await pool.ensure(f.agentId)
  const membershipId = Object.values(joined.state.memberships).find(member => member.roomId === room.roomId && member.agentId === f.agentId)!.id
  const request = () => ({ operationId: 'forget-group' as ContextResetId, membershipId, expectedRevision: f.runtime.snapshot().revision })
  return { ...f, pool, lifecycle, old, secondAgentId: second.agentId, outsideRoomId: outsideRoom.roomId, roomId: room.roomId, sourceId: source.eventId, request, sessionIds, disposedSessions, cancelledSessions, counts: () => ({ created, resumed, disposed }), failDisposal: (value: boolean) => { failDisposal = value } }
}

test('forgetting a group removes personal recall and replaces its already-read Session', async () => {
  const f = await fixture()
  try {
    expect(f.runtime.queryMemory({ agentId: f.agentId, snapshotRevision: f.runtime.snapshot().revision, limit: 50 }).items.some(item => item.text?.includes('PRIVATE_GROUP_MARKER'))).toBe(true)
    await f.runtime.leaveRoomAndForget(f.request())
    expect(f.counts()).toEqual({ created: 2, resumed: 0, disposed: 1 })
    expect(f.runtime.sessionIdFor(f.agentId)).toBe(f.sessionIds[1])
    expect(f.sessionIds[1]).not.toBe(f.sessionIds[0])
    expect(f.runtime.queryMemory({ agentId: f.agentId, snapshotRevision: f.runtime.snapshot().revision, limit: 50 }).items.some(item => item.text?.includes('PRIVATE_GROUP_MARKER'))).toBe(false)
    expect(f.runtime.queryMemory({ agentId: f.agentId, snapshotRevision: f.runtime.snapshot().revision, limit: 50 }).items.some(item => item.text?.includes('INDEPENDENT_MARKER'))).toBe(true)
    expect(f.runtime.queryMemory({ agentId: f.secondAgentId, snapshotRevision: f.runtime.snapshot().revision, limit: 50 }).items.some(item => item.text?.includes('PRIVATE_GROUP_MARKER'))).toBe(true)
    expect(f.runtime.snapshot().events.some(event => event.id === f.sourceId && event.text === 'PRIVATE_GROUP_MARKER')).toBe(true)
    expect(f.runtime.communicationSnapshot().communication.resets['forget-group']).toMatchObject({ kind: 'room-memory-forget', status: 'completed', affectedAgentIds: [f.agentId] })
    expect(f.runtime.agentIdFor(f.old.agent)).toBeUndefined()
    let tools: Parameters<WorkspaceToolRegistry['register']>[0][] = []
    const remove = registerWorkspaceMemoryTools({ register: tool => { tools.push(tool); return () => { tools = tools.filter(item => item !== tool) } } }, f.runtime, { characterBudget: 4000, resultLimit: 10 })
    try {
      const search = tools.find(tool => tool.name === 'workspace_search_memory')!
      const fresh = await f.pool.ensure(f.agentId)
      expect(await search.execute({ query: 'PRIVATE_GROUP_MARKER' }, { agent: fresh.agent, signal: new AbortController().signal } as never)).toMatchObject({ events: [] })
      await expect(search.execute({ query: 'PRIVATE_GROUP_MARKER' }, { agent: f.old.agent, signal: new AbortController().signal } as never)).rejects.toThrow('active employee')
    } finally { remove() }
  } finally { await f.pool.disposeAll() }
})

test('ordinary group departure retains personal history and the same Session', async () => {
  const f = await fixture()
  try {
    await f.runtime.execute(f.runtime.snapshot().revision, { type: 'room/leave', membershipId: f.request().membershipId })
    expect(f.runtime.queryMemory({ agentId: f.agentId, snapshotRevision: f.runtime.snapshot().revision, limit: 50 }).items.some(item => item.text?.includes('PRIVATE_GROUP_MARKER'))).toBe(true)
    expect(f.runtime.sessionIdFor(f.agentId)).toBe(f.sessionIds[0])
    expect(f.counts()).toEqual({ created: 1, resumed: 0, disposed: 0 })
    expect(f.runtime.communicationSnapshot().communication.resets).toEqual({})
  } finally { await f.pool.disposeAll() }
})

test('failed old-Session disposal leaves recall blocked and stable retries cannot reuse that Session', async () => {
  const f = await fixture()
  try {
    const request = f.request()
    f.failDisposal(true)
    await expect(f.runtime.leaveRoomAndForget(request)).rejects.toMatchObject({ message: 'Colleague context cleanup failed.', errors: [new Error('dispose failed')] })
    expect(f.runtime.communicationSnapshot().communication.resets['forget-group']?.status).toBe('failed')
    expect(f.runtime.sessionIdFor(f.agentId)).toBeUndefined()
    expect(f.runtime.communicationSnapshot().communication.contexts[f.agentId]).toMatchObject({ generation: 1, blockedBy: 'forget-group' })
    await expect(f.runtime.leaveRoomAndForget(request)).rejects.toMatchObject({ message: 'Colleague context cleanup failed.', errors: [new Error('dispose failed')] })
    expect(f.counts().created).toBe(1)
    f.failDisposal(false)
    await f.runtime.leaveRoomAndForget(request)
    const after = f.runtime.communicationSnapshot()
    expect(after.communication.resets['forget-group']?.status).toBe('completed')
    expect(after.communication.contexts[f.agentId]?.generation).toBe(1)
    expect(f.runtime.sessionIdFor(f.agentId)).toBe(f.sessionIds[1])
    await f.runtime.leaveRoomAndForget(request)
    expect(f.counts().created).toBe(2)
    expect(f.runtime.snapshot().events.filter(event => event.type === 'room/member-left' && event.subjectId === request.membershipId)).toHaveLength(1)
  } finally { f.failDisposal(false); await f.pool.disposeAll() }
})

test('the leaving colleague cannot publish a late reply while another colleague finishes normally', async () => {
  const f = await fixture(), output = barrier(), prepared = barrier()
  const second = await f.pool.ensure(f.secondAgentId)
  const old = f.runtime.runNewOperation(async () => {
    await output.promise
    await f.runtime.apply(state => mutateWorkspace(state, { type: 'room/message', roomId: f.outsideRoomId, actor: { type: 'agent', id: f.agentId }, text: 'Late leaked PRIVATE_GROUP_MARKER', mentions: [] }).state)
  }).then(() => undefined, (error: Error) => error)
  const unaffected = f.runtime.runNewOperation(async () => {
    await output.promise
    await f.runtime.apply(state => mutateWorkspace(state, { type: 'room/message', roomId: f.outsideRoomId, actor: { type: 'agent', id: f.secondAgentId }, text: 'Bob finished ordinary work.', mentions: [] }).state)
  })
  try {
    f.afterTransform(() => { prepared.resolve() })
    const forgetting = f.runtime.leaveRoomAndForget(f.request())
    await Promise.race([prepared.promise, forgetting.then(() => { throw new Error('Forget completed before the prepared state was observed.') })])
    output.resolve()
    expect(await old).toMatchObject({ message: 'Old colleague context cannot publish new model output.' })
    await unaffected
    await forgetting
    expect(f.runtime.snapshot().events.some(event => event.text?.startsWith('Late leaked'))).toBe(false)
    expect(f.runtime.snapshot().events.some(event => event.text === 'Bob finished ordinary work.')).toBe(true)
    expect(f.pool.handleFor(f.secondAgentId)).toBe(second)
    expect(f.disposedSessions).not.toContain(second.agent.id)
    expect(f.cancelledSessions).not.toContain(second.agent.id)
  } finally { output.resolve(); f.afterTransform(); await Promise.allSettled([old, unaffected]); await f.pool.disposeAll() }
})

test('old generation child starts are fenced even though their durable event has no text', async () => {
  const f = await fixture(), output = barrier(), prepared = barrier()
  const assigned = assignHumanTask(f.runtime.snapshot(), { humanId: WEB_WORKSPACE_HUMAN_ID, assigneeAgentId: f.agentId, title: 'Independent existing task' })
  await f.directory.updateAggregate(f.runtime.workspaceId, () => assigned.state)
  const old = f.runtime.runNewOperation(async () => {
    await output.promise
    await f.runtime.apply(state => recordChildRunStarted(state, { parentAgentId: f.agentId, taskId: assigned.taskId }).state)
  }).then(() => undefined, (error: Error) => error)
  try {
    f.afterTransform(() => { prepared.resolve() })
    const forgetting = f.runtime.leaveRoomAndForget(f.request())
    await Promise.race([prepared.promise, forgetting.then(() => { throw new Error('Forget completed before the prepared state was observed.') })])
    output.resolve()
    expect(await old).toMatchObject({ message: 'Old colleague context cannot publish new model output.' })
    await forgetting
    expect(f.runtime.snapshot().events.some(event => event.type === 'child/run-started')).toBe(false)
    expect(Object.keys(f.runtime.snapshot().childRuns)).toHaveLength(0)
  } finally { output.resolve(); f.afterTransform(); await Promise.allSettled([old]); await f.pool.disposeAll() }
})

test('forget waits for a committed child controller still being published and cancels that exact child', async () => {
  const f = await fixture(), childCommitted = barrier(), childFinished = barrier(), prepared = barrier()
  const controllers = Reflect.get(f.runtime, 'childControllers') as ChildControllerRegistry
  const reservation = controllers.reserveStart()
  let childRunId!: ChildRunId
  let aborted = false
  const assigned = assignHumanTask(f.runtime.snapshot(), { humanId: WEB_WORKSPACE_HUMAN_ID, assigneeAgentId: f.agentId, title: 'Existing child work' })
  await f.directory.updateAggregate(f.runtime.workspaceId, () => assigned.state)
  const child = f.runtime.runNewOperation(async () => {
    await f.runtime.apply(state => {
      const started = recordChildRunStarted(state, { parentAgentId: f.agentId, taskId: assigned.taskId })
      childRunId = started.childRunId
      return started.state
    })
    childCommitted.resolve()
    await childFinished.promise
  })
  await childCommitted.promise
  try {
    f.afterTransform(() => { prepared.resolve() })
    const forgetting = f.runtime.leaveRoomAndForget(f.request())
    await Promise.race([prepared.promise, forgetting.then(() => { throw new Error('Forget completed before the prepared state was observed.') })])
    expect(f.runtime.communicationSnapshot().communication.contexts[f.agentId]?.blockedBy).toBe('forget-group')
    expect(f.runtime.snapshot().childRuns[childRunId]?.status).toBe('running')
    reservation.register({ childRunId, parentAgentId: f.agentId, taskId: assigned.taskId, abort: () => { aborted = true; childFinished.resolve() } })
    reservation.release()
    await forgetting
    await child
    expect(aborted).toBe(true)
    expect(f.runtime.snapshot().childRuns[childRunId]?.status).toBe('cancelled')
    expect(f.runtime.snapshot().tasks[assigned.taskId]?.status).toBe('open')
    expect(f.runtime.communicationSnapshot().communication.resets['forget-group']?.status).toBe('completed')
  } finally {
    reservation.release(); childFinished.resolve(); f.afterTransform()
    await child; await controllers.stopAll(); await f.pool.disposeAll()
  }
})

test.each(['started', 'accepted'] as const)('a restarted pending forget settles the target %s task delivery without cancelling the task or another colleague delivery', async phase => {
  const f = await fixture()
  const assigned = assignHumanTask(f.runtime.snapshot(), { humanId: WEB_WORKSPACE_HUMAN_ID, assigneeAgentId: f.agentId, title: 'Target independent task' })
  const otherAssigned = assignHumanTask(assigned.state, { humanId: WEB_WORKSPACE_HUMAN_ID, assigneeAgentId: f.secondAgentId, title: 'Other colleague independent task' })
  const delivery = startTaskDelivery(otherAssigned.state, { taskId: assigned.taskId })
  const otherDelivery = startTaskDelivery(delivery.state, { taskId: otherAssigned.taskId })
  const identity = { taskId: assigned.taskId, attemptId: delivery.attemptId, messageId: delivery.message.id }
  const otherIdentity = { taskId: otherAssigned.taskId, attemptId: otherDelivery.attemptId, messageId: otherDelivery.message.id }
  let beforeCrash = otherDelivery.state
  if (phase === 'accepted') beforeCrash = acceptTaskDelivery(acceptTaskDelivery(beforeCrash, identity).state, otherIdentity).state
  await f.directory.updateAggregate(f.runtime.workspaceId, () => beforeCrash)
  const request = f.request()
  await f.directory.updateRecord(f.runtime.workspaceId, record => ({ record: prepareRoomMemoryForget(record, request.membershipId, request.operationId, WEB_WORKSPACE_HUMAN_ID, '2026-10-17T00:00:00.000Z'), value: undefined }))
  await f.pool.disposeAll()
  const restarted = new WorkspaceRuntime(new Context(), AgentWorkspaceDomainService.Config({}) as ResolvedConfig, f.directory, f.runtime.workspaceId)
  const pool = new EmployeeAgentPool(f.lifecycle, restarted)
  Object.assign(restarted, { pool })
  try {
    await restarted.initialize()
    expect(restarted.sessionIdFor(f.agentId)).toBeUndefined()
    await restarted.leaveRoomAndForget(request)
    const state = restarted.snapshot()
    expect(inspectTaskDelivery(state, assigned.taskId)).toEqual({ attemptId: delivery.attemptId, phase: phase === 'started' ? 'retryable' : 'settled' })
    expect(state.events.filter(event => event.type === 'task/delivery-failed' && event.taskId === assigned.taskId)).toEqual([expect.objectContaining({ taskId: assigned.taskId, taskDeliveryAttemptId: delivery.attemptId, messageId: delivery.message.id, failureCode: 'interrupted' })])
    expect(inspectTaskDelivery(state, otherAssigned.taskId)).toEqual({ attemptId: otherDelivery.attemptId, phase })
    expect(state.tasks[assigned.taskId]?.status).toBe('open')
    expect(restarted.communicationSnapshot().communication.contexts[f.agentId]?.generation).toBe(1)
    expect(restarted.communicationSnapshot().communication.resets[request.operationId]?.status).toBe('completed')
    expect(f.counts().resumed).toBe(0)
    expect(f.counts().created).toBe(2)
  } finally { await pool.disposeAll() }
})

test('a child handle that temporarily fails disposal is retried before the same forget operation can complete', async () => {
  const f = await fixture(), started = barrier()
  const ctx = Reflect.get(f.runtime, 'ctx') as Context
  let failCleanup = true, attempts = 0
  await f.runtime.initialize()
  const providers = await ctx.plugin(provider => {
    provider.provide('agents', { create: async () => { throw new Error('Native pool is supplied by the fixture.') }, resume: async () => { throw new Error('Old Session must not resume.') } } as never)
    provider.provide('subagents', { start: async (_name: string, request: { readonly signal: AbortSignal }) => {
      started.resolve()
      return {
        result: new Promise<never>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('Child aborted.')), { once: true })),
        dispose: async () => { attempts++; if (failCleanup) throw new Error('Child cleanup failed temporarily.') },
      }
    } } as never)
  })
  await (Reflect.get(f.runtime, 'preparation') as Promise<void> | undefined)
  Object.assign(f.runtime, { pool: f.pool })
  const assigned = assignHumanTask(f.runtime.snapshot(), { humanId: WEB_WORKSPACE_HUMAN_ID, assigneeAgentId: f.agentId, title: 'Actual child cleanup retry' })
  await f.directory.updateAggregate(f.runtime.workspaceId, () => assigned.state)
  const child = f.runtime.runChild(f.agentId, assigned.taskId, 'Child work').then(() => undefined, (error: Error) => error)
  try {
    await Promise.race([started.promise, child.then(error => { throw error ?? new Error('Child returned before starting.') })])
    const request = f.request()
    await expect(f.runtime.leaveRoomAndForget(request)).rejects.toThrow('cleanup failed')
    await child
    expect(f.runtime.communicationSnapshot().communication.resets[request.operationId]?.status).toBe('failed')
    expect(f.runtime.sessionIdFor(f.agentId)).toBeUndefined()
    const beforeRetry = attempts
    failCleanup = false
    await f.runtime.leaveRoomAndForget(request)
    expect(attempts).toBeGreaterThan(beforeRetry)
    expect(f.runtime.communicationSnapshot().communication.resets[request.operationId]?.status).toBe('completed')
    expect(f.runtime.communicationSnapshot().communication.contexts[f.agentId]?.generation).toBe(1)
    expect(f.counts().created).toBe(2)
  } finally {
    failCleanup = false
    await f.runtime.dispose()
    await providers.dispose()
    await child
  }
})
