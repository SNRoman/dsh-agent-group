import { describe, expect, test, vi } from 'vitest'
import { WorkflowOperationId } from '../packages/host/src/workflow.ts'
import { TaskDeliveryCoordinator } from '../packages/host/src/task-delivery-coordinator.ts'
import { workflowRuntime, joinWorkflowChat, brief, expected, publishEmployee } from './workflow-test-support.ts'
import { WEB_WORKSPACE_HUMAN_ID } from '../packages/host/src/rpc.ts'
import type { WorkflowExpectedRevisions, WorkflowOperationId as OperationId, TaskDraftId } from '../packages/host/src/workflow-contract.ts'
import type { AgentId } from '../packages/host/src/ids.ts'
import { mutateWorkspace } from '../packages/host/src/state.ts'
import { WorkspaceDirectory } from '../packages/host/src/workspace-directory.ts'
import { WorkspaceRuntime } from '../packages/host/src/workspace-runtime.ts'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { inspectTaskDelivery } from '../packages/host/src/task-delivery.ts'

async function seedDraft(runtime: WorkspaceRuntime) {
  const agentId = Object.values(runtime.snapshot().agents)[0]!.id
  const roomId = await joinWorkflowChat(runtime, agentId)
  return runtime.directory.executeWorkflow(runtime.workspaceId, { ...expected(runtime), roomId, operationId: WorkflowOperationId('draft'), command: { type: 'workflow/draft/create', brief } }, { humanId: WEB_WORKSPACE_HUMAN_ID, occurredAt: '2026-10-13T00:00:00.000Z' })
}
function confirmDraft(runtime: WorkspaceRuntime, request: WorkflowExpectedRevisions & { operationId: OperationId }, command: { draftId: TaskDraftId; expectedDraftRevision: number; assigneeAgentId: AgentId }, signal?: AbortSignal) {
  const roomId = runtime.directory.record(runtime.workspaceId).communication.draftSources[command.draftId]!.roomId
  return runtime.confirmChatWork({ ...request, roomId, draftId: command.draftId, expectedDraftRevision: command.expectedDraftRevision, assigneeAgentId: command.assigneeAgentId }, signal)
}

describe('workflow runtime', () => {
  test('confirmation commits before delivery and replay bypasses delivery with stale revisions', async () => {
    const { runtime, directory, agentId } = await workflowRuntime()
    const created = await seedDraft(runtime)
    const deliver = vi.fn(async () => { expect(Object.values(directory.record(runtime.workspaceId).communication.operations)).toHaveLength(1); return 'done' })
    Object.assign(runtime, { taskDelivery: { deliver } as Pick<TaskDeliveryCoordinator, 'deliver'> })
    const request = { ...expected(runtime), operationId: WorkflowOperationId('confirm') }
    const command = { type: 'workflow/draft/confirm' as const, draftId: created.value.draftId, expectedDraftRevision: 0, assigneeAgentId: agentId }
    const confirmed = await confirmDraft(runtime, request, command)
    await runtime.admission.drain()
    expect(deliver).toHaveBeenCalledExactlyOnceWith(confirmed.value.taskId)
    Object.defineProperty(runtime, 'taskDelivery', { get: () => { throw new Error('replay accessed delivery coordinator') } })
    expect(await confirmDraft(runtime, request, command)).toMatchObject({ replayed: true, value: confirmed.value })
  })
  test('failed commit starts no delivery', async () => {
    const { runtime, agentId, fail } = await workflowRuntime()
    const draft = await seedDraft(runtime)
    const deliver = vi.fn(); Object.assign(runtime, { taskDelivery: { deliver } }); fail()
    await expect(confirmDraft(runtime, { ...expected(runtime), operationId: WorkflowOperationId('confirm') }, { draftId: draft.value.draftId, expectedDraftRevision: 0, assigneeAgentId: agentId })).rejects.toThrow('disk failed')
    expect(deliver).not.toHaveBeenCalled(); expect(Object.keys(runtime.snapshot().tasks)).toHaveLength(0)
  })
  test('archived reads remain available but new writes fail', async () => {
    const { runtime, directory } = await workflowRuntime()
    await directory.setLifecycle(runtime.workspaceId, 'archived')
    await runtime.stopAdmittedWork()
    expect(runtime.workflowSnapshot().workspaceId).toBe(runtime.workspaceId)
    await expect(runtime.executeWorkflow({ ...expected(runtime), operationId: WorkflowOperationId('draft') }, { type: 'workflow/draft/create', brief })).rejects.toMatchObject({ code: 'workflow-read-only' })
  })
  test('queued cancellation and atomic-callback cancellation persist no template', async () => {
    for (const phase of ['queue', 'callback']) {
      const fixture = await workflowRuntime()
      const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>()
      fixture.beforeUpdate(async () => { entered.resolve(); await release.promise })
      const blocker = fixture.directory.rename(fixture.runtime.workspaceId, 'Blocked')
      await entered.promise
      const cancellation = new AbortController()
      const operation = fixture.runtime.executeWorkflow({ ...expected(fixture.runtime), operationId: WorkflowOperationId('cancelled') }, { type: 'workflow/task-template/create', name: 'Cancelled', brief }, cancellation.signal)
      const rejected = expect(operation).rejects.toMatchObject({ name: 'AbortError' })
      if (phase === 'queue') cancellation.abort()
      else fixture.beforeUpdate(async () => { cancellation.abort() })
      release.resolve(); await blocker; await rejected
      expect(fixture.runtime.workflowSnapshot().workflow.revision).toBe(0)
      expect(fixture.runtime.admission.pending).toBe(0)
    }
  })
  test('post-transform cancellation returns the committed receipt', async () => {
    const fixture = await workflowRuntime(); const signal = new AbortController()
    fixture.afterTransform(() => signal.abort())
    const result = await fixture.runtime.executeWorkflow({ ...expected(fixture.runtime), operationId: WorkflowOperationId('committed') }, { type: 'workflow/task-template/create', name: 'Committed', brief }, signal.signal)
    expect(result).toMatchObject({ replayed: false, workflowRevision: 1 })
    expect(fixture.runtime.workflowSnapshot().workflow.taskTemplateRevisions[result.value.templateRevisionId]).toBeDefined()
  })
  test('close drains a confirmation admitted before the commit barrier and its delivery', async () => {
    const fixture = await workflowRuntime(); const { runtime } = fixture
    const draft = await seedDraft(runtime)
    const entered = Promise.withResolvers<void>(); const commit = Promise.withResolvers<void>(); const delivered = Promise.withResolvers<string>()
    fixture.beforeUpdate(async () => { entered.resolve(); await commit.promise })
    const deliver = vi.fn(() => delivered.promise)
    Object.assign(runtime, { taskDelivery: { deliver, cancelAllDeliveries: () => {}, drain: () => delivered.promise } })
    const operation = confirmDraft(runtime, { ...expected(runtime), operationId: WorkflowOperationId('confirm') }, { draftId: draft.value.draftId, expectedDraftRevision: 0, assigneeAgentId: fixture.agentId })
    await entered.promise; runtime.closeAdmission()
    let drained = false; const drain = runtime.admission.drain().then(() => { drained = true })
    commit.resolve(); await operation
    expect(deliver).toHaveBeenCalledTimes(1); expect(drained).toBe(false)
    delivered.resolve('done'); await drain; expect(runtime.admission.pending).toBe(0)
    expect(() => runtime.workflowSnapshot()).toThrow('unavailable')
  })
  test('proposal rechecks employee employment and pool generation inside the atomic callback', async () => {
    for (const mode of ['departed', 'revoked', 'archived']) {
      const fixture = await workflowRuntime(); const { runtime } = fixture
      const roomId = await joinWorkflowChat(runtime, fixture.agentId)
      const employee = await publishEmployee(runtime, fixture.agentId)
      const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>()
      fixture.beforeUpdate(async () => { entered.resolve(); await release.promise })
      const operation = runtime.proposeTask(employee.agent, { brief, roomId })
      const rejected = expect(operation).rejects.toThrow()
      await entered.promise
      if (mode === 'revoked') await employee.pool.dispose(fixture.agentId)
      else {
        const record = fixture.directory.record(runtime.workspaceId)
        fixture.rows.set(runtime.workspaceId, mode === 'archived' ? { ...record, descriptor: { ...record.descriptor, lifecycle: 'archived' } } : { ...record, aggregate: mutateWorkspace(record.aggregate, { type: 'agent/depart', agentId: fixture.agentId }).state })
      }
      release.resolve(); await rejected
      expect(runtime.directory.record(runtime.workspaceId).workflow.revision).toBe(0)
      await employee.pool.disposeAll()
    }
  })
  test('restoring an undelivered confirmation never starts it and replay remains inert', async () => {
    const fixture = await workflowRuntime(); const { runtime } = fixture
    const draft = await seedDraft(runtime)
    const request = { ...expected(runtime), operationId: WorkflowOperationId('confirm') }
    const command = { type: 'workflow/draft/confirm' as const, draftId: draft.value.draftId, expectedDraftRevision: 0, assigneeAgentId: fixture.agentId }
    const confirmed = await confirmDraft(runtime, request, command)
    const restored = new WorkspaceDirectory(fixture.table); await restored.initialize()
    const second = new WorkspaceRuntime(new Context(), {} as never, restored, runtime.workspaceId)
    const deliver = vi.fn(); Object.assign(second, { taskDelivery: { deliver } })
    expect(second.snapshot().events.filter(event => event.type === 'task/delivery-started')).toHaveLength(0)
    expect(await confirmDraft(second, request, command)).toMatchObject({ replayed: true, value: confirmed.value })
    expect(deliver).not.toHaveBeenCalled()
  })
  test('a coordinator failure after confirmation preserves the receipt and retryable task', async () => {
    const { runtime, directory, agentId } = await workflowRuntime()
    const draft = await seedDraft(runtime)
    const deliver = vi.fn(async () => { throw new Error('inbox offline') })
    const coordinator = new TaskDeliveryCoordinator({ snapshot: () => runtime.snapshot(), apply: mutation => directory.updateAggregate(runtime.workspaceId, mutation), ensureEmployee: async () => ({ agent: {} as Agent, dispose: async () => {} }), deliver })
    Object.assign(runtime, { taskDelivery: coordinator })
    const request = { ...expected(runtime), operationId: WorkflowOperationId('confirm') }
    const command = { type: 'workflow/draft/confirm' as const, draftId: draft.value.draftId, expectedDraftRevision: 0, assigneeAgentId: agentId }
    const result = await confirmDraft(runtime, request, command)
    await runtime.admission.drain(); await coordinator.drain()
    expect(runtime.communicationSnapshot().communication.operations[request.operationId]?.receipt).toEqual(result.value)
    expect(runtime.snapshot().tasks[result.value.taskId]?.status).toBe('open')
    expect(inspectTaskDelivery(runtime.snapshot(), result.value.taskId).phase).toBe('retryable')
    expect(runtime.snapshot().events.filter(event => event.type === 'task/delivery-failed')).toHaveLength(1)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(await confirmDraft(runtime, request, command)).toMatchObject({ replayed: true, value: result.value })
    expect(runtime.snapshot().events.filter(event => event.type === 'task/delivery-started')).toHaveLength(1)
  })
  test('disposal stops a confirmed live attempt and drains its durable failure settlement', async () => {
    const { runtime, directory, agentId } = await workflowRuntime()
    const draft = await seedDraft(runtime)
    const accepted = Promise.withResolvers<void>(); const finish = Promise.withResolvers<void>()
    const coordinator = new TaskDeliveryCoordinator({ snapshot: () => runtime.snapshot(), apply: mutation => directory.updateAggregate(runtime.workspaceId, mutation), ensureEmployee: async () => ({ agent: {} as Agent, dispose: async () => {} }), deliver: async (_id, _message, _recall, _source, hooks) => { await hooks?.onClaim?.(); accepted.resolve(); await finish.promise; return { output: [{ type: 'text', text: 'late result' }], stopReason: { kind: 'completed' }, interrupted: false } } })
    Object.assign(runtime, { taskDelivery: coordinator })
    const result = await confirmDraft(runtime, { ...expected(runtime), operationId: WorkflowOperationId('confirm') }, { draftId: draft.value.draftId, expectedDraftRevision: 0, assigneeAgentId: agentId })
    await accepted.promise
    let disposed = false; const disposal = runtime.dispose().then(() => { disposed = true })
    expect(disposed).toBe(false); expect(runtime.admission.pending).toBe(1)
    finish.resolve(); await disposal
    expect(runtime.admission.pending).toBe(0)
    expect(runtime.snapshot().events.filter(event => event.type === 'task/result')).toHaveLength(0)
    expect(runtime.snapshot().events.filter(event => event.type === 'task/delivery-failed')).toHaveLength(1)
    expect(inspectTaskDelivery(runtime.snapshot(), result.value.taskId).phase).toBe('settled')
    expect(directory.record(runtime.workspaceId).workflow.drafts[draft.value.draftId]).toMatchObject({ status: 'confirmed', taskId: result.value.taskId })
  })
  test('archive reaching an admitted confirmation before its atomic callback rejects the new task', async () => {
    const fixture = await workflowRuntime(); const { runtime } = fixture
    const draft = await seedDraft(runtime)
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>()
    fixture.beforeUpdate(async () => { entered.resolve(); await release.promise })
    const delivery = vi.fn(); Object.assign(runtime, { taskDelivery: { deliver: delivery } })
    const operation = confirmDraft(runtime, { ...expected(runtime), operationId: WorkflowOperationId('confirm') }, { draftId: draft.value.draftId, expectedDraftRevision: 0, assigneeAgentId: fixture.agentId })
    const rejected = expect(operation).rejects.toMatchObject({ code: 'workflow-read-only' })
    await entered.promise; runtime.admission.close()
    const record = fixture.directory.record(runtime.workspaceId)
    fixture.rows.set(runtime.workspaceId, { ...record, descriptor: { ...record.descriptor, lifecycle: 'archived' } })
    release.resolve(); await rejected; await runtime.admission.drain()
    expect(Object.keys(runtime.snapshot().tasks)).toHaveLength(0); expect(delivery).not.toHaveBeenCalled()
    expect(runtime.workflowSnapshot().workflow.drafts[draft.value.draftId]?.status).toBe('draft')
  })
})
