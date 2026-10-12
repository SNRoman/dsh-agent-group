import { expect, test, vi } from 'vitest'
import { workflowTaskInstructions } from '../packages/host/src/workflow-delivery.ts'
import { workflowRuntime, expected, brief } from './workflow-test-support.ts'
import { WorkflowOperationId } from '../packages/host/src/workflow.ts'
import { TaskDeliveryCoordinator } from '../packages/host/src/task-delivery-coordinator.ts'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import { WorkspaceTurnTracker } from '../packages/host/src/turn-tracker.ts'
import { startTaskDelivery, inspectTaskDelivery } from '../packages/host/src/task-delivery.ts'
import { assignHumanTask } from '../packages/host/src/tasks.ts'
import { HumanId } from '../packages/host/src/ids.ts'

const golden = 'Ship\n\nInstructions\nComplete all details\n\nExpected artifacts\n- report\n\nAcceptance criteria\n- Reviewed'
async function confirmed() {
  const fixture = await workflowRuntime(); const { runtime, directory, agentId } = fixture
  const draft = await runtime.executeWorkflow({ ...expected(runtime), operationId: WorkflowOperationId('draft') }, { type: 'workflow/draft/create', brief })
  const result = await directory.executeWorkflow(runtime.workspaceId, { ...expected(runtime), operationId: WorkflowOperationId('confirm'), command: { type: 'workflow/draft/confirm', draftId: draft.value.draftId, expectedDraftRevision: 0, assigneeAgentId: agentId } }, { humanId: HumanId('owner'), occurredAt: '2026-10-11T00:00:00.000Z' })
  return { ...fixture, taskId: result.value.taskId }
}

test('persisted confirmation renders the complete brief deterministically', async () => {
  const { runtime, directory, agentId } = await workflowRuntime()
  const draft = await runtime.executeWorkflow({ ...expected(runtime), operationId: WorkflowOperationId('draft') }, { type: 'workflow/draft/create', brief })
  const result = await directory.executeWorkflow(runtime.workspaceId, { ...expected(runtime), operationId: WorkflowOperationId('confirm'), command: { type: 'workflow/draft/confirm', draftId: draft.value.draftId, expectedDraftRevision: 0, assigneeAgentId: agentId } }, { humanId: 'web-workspace-human' as never, occurredAt: new Date().toISOString() })
  expect(workflowTaskInstructions(directory.record(runtime.workspaceId), result.value.taskId)).toBe(golden)
})

test('normal coordinator delivery logs the full brief in real Session user/message while retaining exact identities', async () => {
  const fixture = await confirmed(); const { runtime, directory, taskId, agentId } = fixture
  const before = runtime.snapshot(); const legacy = startTaskDelivery(before, { taskId })
  const session = Session.create(SessionId('workflow-session')); const events = new Context()
  const tracker = new WorkspaceTurnTracker(); tracker.install(events)
  let sent!: UserMessage
  const agent = { id: session.id, session, followup: (message: UserMessage) => {
    sent = message; session.append('user/message', message, { surfaceOp: 'append' })
    events.emit('agent/inbox/claimed', { message, turn: 1 } as never)
    const answer = session.append('assistant/message', { turn: 1, message: { id: 'answer' as never, role: 'assistant', content: [{ type: 'text', text: 'Report ready' }] } }, { surfaceOp: 'append' })
    events.emit('session/event', session, answer)
    const end = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    events.emit('session/event', session, end)
  } } as Agent
  const coordinator = new TaskDeliveryCoordinator({
    snapshot: () => runtime.snapshot(), apply: mutation => directory.updateAggregate(runtime.workspaceId, mutation),
    taskInstructions: task => workflowTaskInstructions(directory.record(runtime.workspaceId), task),
    ensureEmployee: async () => ({ agent, dispose: async () => {} }),
    deliver: async (_id, message, recall, source, hooks) => await tracker.deliver(agent, message, recall, source, hooks),
  })
  expect(await coordinator.deliver(taskId)).toBe('Report ready'); await coordinator.drain()
  expect(sent.content).toEqual([{ type: 'text', text: golden }])
  expect(sent.id).toBe(legacy.message.id); expect(sent.source).toEqual(legacy.message.source)
  expect(Object.isFrozen(sent)).toBe(true); expect(Object.isFrozen(sent.content)).toBe(true)
  expect(Object.isFrozen(sent.content[0])).toBe(true)
  expect(session.snapshotEvents().find(event => event.type === 'user/message')?.data).toEqual(sent)
  expect(runtime.snapshot().events.find(event => event.type === 'task/result')).toMatchObject({ taskId, definitionRevisionId: runtime.snapshot().agents[agentId]!.definitionRevisionId, text: 'Report ready' })
})

test('explicit reservation retry of a never-delivered restored task uses the same persisted full brief', async () => {
  const { runtime, directory, taskId } = await confirmed()
  const seen: UserMessage[] = []
  const coordinator = new TaskDeliveryCoordinator({ snapshot: () => runtime.snapshot(), apply: mutation => directory.updateAggregate(runtime.workspaceId, mutation), taskInstructions: task => workflowTaskInstructions(directory.record(runtime.workspaceId), task), ensureEmployee: async () => ({ agent: {} as Agent, dispose: async () => {} }), deliver: async (_agentId, message, _recall, _source, hooks) => { seen.push(message); await hooks?.onClaim?.(); return { output: [{ type: 'text', text: 'Retry ready' }], stopReason: { kind: 'completed' }, interrupted: false } } })
  Object.assign(runtime, { taskDelivery: coordinator })
  expect(inspectTaskDelivery(runtime.snapshot(), taskId)).toEqual({ phase: 'retryable' })
  expect(seen).toEqual([])
  const result = await runtime.retryTaskDelivery(runtime.snapshot().revision, taskId)
  expect(result.value).toBe('Retry ready'); expect(seen).toHaveLength(1)
  expect(seen[0]!.content).toEqual([{ type: 'text', text: golden }])
  expect(inspectTaskDelivery(runtime.snapshot(), taskId).phase).toBe('settled')
  await coordinator.drain(); await runtime.admission.drain()
})

test('legacy tasks retain exact title-only messages and resumed inbox input is never rerendered', async () => {
  const { runtime, directory, agentId } = await workflowRuntime()
  let taskId!: ReturnType<typeof assignHumanTask>['taskId']
  await directory.updateAggregate(runtime.workspaceId, state => { const changed = assignHumanTask(state, { humanId: HumanId('owner'), assigneeAgentId: agentId, title: 'Legacy title' }); taskId = changed.taskId; return changed.state })
  const baseline = startTaskDelivery(runtime.snapshot(), { taskId }); let delivered!: UserMessage
  const coordinator = new TaskDeliveryCoordinator({ snapshot: () => runtime.snapshot(), apply: mutation => directory.updateAggregate(runtime.workspaceId, mutation), taskInstructions: task => workflowTaskInstructions(directory.record(runtime.workspaceId), task), ensureEmployee: async () => ({ agent: {} as Agent, dispose: async () => {} }), deliver: async (_id, message, _recall, _source, hooks) => { delivered = message; await hooks?.onClaim?.(); return { output: [{ type: 'text', text: 'Legacy done' }], stopReason: { kind: 'completed' }, interrupted: false } } })
  await coordinator.deliver(taskId); expect(delivered).toEqual(baseline.message)
  const restored = await confirmed(); const started = startTaskDelivery(restored.runtime.snapshot(), { taskId: restored.taskId })
  await restored.directory.updateAggregate(restored.runtime.workspaceId, () => started.state)
  const frozen = { ...started.message, content: [{ type: 'text' as const, text: 'Session frozen input' }] }
  const session = Session.create(SessionId('resumed'))
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [frozen] })
  const pending = Promise.withResolvers<{ output: { type: 'text'; text: string }[]; stopReason: { kind: 'completed' }; interrupted: boolean }>()
  const taskInstructions = vi.fn(() => 'Later instructions'); let recovered!: UserMessage
  const resumed = new TaskDeliveryCoordinator({ snapshot: () => restored.runtime.snapshot(), apply: mutation => restored.directory.updateAggregate(restored.runtime.workspaceId, mutation), taskInstructions, ensureEmployee: async () => ({ agent: {} as Agent, dispose: async () => {} }), deliver: async () => { throw new Error('must not deliver twice') }, recoverDelivery: async (_id, _agent, message, _source, hooks) => { recovered = message; await hooks?.onClaim?.(); return await pending.promise } })
  try {
    expect(await resumed.recoverAgent(restored.agentId, { agent: { id: session.id, session, inbox: { nextTurn: [frozen], nextStep: [] } } as Agent })).toEqual([{ taskId: restored.taskId, status: 'pending' }])
    expect(recovered).toEqual(frozen); expect(taskInstructions).not.toHaveBeenCalled()
  } finally { pending.resolve({ output: [{ type: 'text', text: 'Recovered done' }], stopReason: { kind: 'completed' }, interrupted: false }); await resumed.drain() }
  expect(inspectTaskDelivery(restored.runtime.snapshot(), restored.taskId).phase).toBe('settled')
})
