import { expect, test } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { workflowRuntime, joinWorkflowChat, brief, expected } from './workflow-test-support.ts'
import { WorkflowOperationId } from '../packages/host/src/workflow.ts'
import type { WorkflowCommand } from '../packages/host/src/workflow-contract.ts'
import type { ContextResetId } from '../packages/host/src/communication-contract.ts'
import { WEB_WORKSPACE_HUMAN_ID } from '../packages/host/src/rpc.ts'
import { prepareMessageRecall, completeMessageRecall } from '../packages/host/src/message-recall.ts'
import { acceptTaskDelivery, startTaskDelivery, terminalizeTask } from '../packages/host/src/task-delivery.ts'
import { WorkspaceWorkflowApi } from '../packages/web/src/client/workflow-api.ts'
import { WorkspaceApi } from '../packages/web/src/client/api.ts'

async function fixture() {
  const f = await workflowRuntime()
  const roomId = await joinWorkflowChat(f.runtime, f.agentId)
  const assigned = await f.runtime.assignChatWork({ ...expected(f.runtime), roomId, operationId: WorkflowOperationId('assign'), brief, assigneeAgentId: f.agentId })
  await f.directory.updateAggregate(f.runtime.workspaceId, state => {
    const start = startTaskDelivery(state, { taskId: assigned.value.taskId })
    const accepted = acceptTaskDelivery(start.state, { taskId: assigned.value.taskId, attemptId: start.attemptId, messageId: start.message.id })
    return terminalizeTask(accepted.state, { actorAgentId: f.agentId, taskId: assigned.value.taskId, attemptId: start.attemptId, definitionRevisionId: Object.values(state.definitionRevisions)[0]!.id, result: 'Withdrawable result' }).state
  })
  const event = f.runtime.snapshot().events.find(event => event.type === 'task/result')!
  const result = { taskId: assigned.value.taskId, eventId: event.id, attemptId: event.taskDeliveryAttemptId! }
  const execute = (command: WorkflowCommand, operationId = command.type) => f.directory.executeWorkflow(f.runtime.workspaceId, { ...expected(f.runtime), operationId: WorkflowOperationId(operationId), command, roomId }, { humanId: WEB_WORKSPACE_HUMAN_ID, occurredAt: '2026-10-13T00:00:00.000Z' })
  return { ...f, roomId, assigned, result, execute }
}

test('withdrawn workflow references reject edits, revisions and result reuse without changing the audit record', async () => {
  const f = await fixture()
  const draft = await f.execute({ type: 'workflow/draft/create', brief })
  const template = await f.execute({ type: 'workflow/task-template/create', name: 'Legacy', brief })
  const artifact = await f.execute({ type: 'workflow/artifact/register', result: f.result, label: 'Report', summary: 'Derived result' })
  if (!('draftId' in draft.value) || !('templateRevisionId' in template.value) || !('templateId' in template.value) || !('artifactId' in artifact.value)) throw new Error('Unexpected fixture receipt')
  const resetId = 'withdraw' as ContextResetId
  await f.directory.updateRecord(f.runtime.workspaceId, record => ({ record: completeMessageRecall(prepareMessageRecall(record, { operationId: resetId, roomId: f.roomId, eventId: f.assigned.value.source.eventId, humanId: WEB_WORKSPACE_HUMAN_ID, requestedAt: '2026-10-13T00:00:00.000Z', restoreFiles: false }), resetId, { [f.agentId]: SessionId('fresh') }), value: undefined }))
  const before = f.directory.record(f.runtime.workspaceId)
  const commands: WorkflowCommand[] = [
    { type: 'workflow/draft/edit', draftId: draft.value.draftId, expectedDraftRevision: 0, brief },
    { type: 'workflow/draft/confirm', draftId: draft.value.draftId, expectedDraftRevision: 0, assigneeAgentId: f.agentId },
    { type: 'workflow/task-template/apply', templateRevisionId: template.value.templateRevisionId },
    { type: 'workflow/task-template/revise', templateId: template.value.templateId, brief },
    { type: 'workflow/artifact/register', result: f.result, label: 'Revival', summary: 'Revival' },
    { type: 'workflow/result/handoff', result: f.result, artifactIds: [artifact.value.artifactId] },
    { type: 'workflow/result/review', result: f.result, decision: 'changes-requested', comment: 'Revival' },
  ]
  for (const command of commands) await expect(f.execute(command, `after-${command.type}`)).rejects.toMatchObject({ code: 'workflow-reference-invalid' })
  await expect(f.execute({ type: 'workflow/draft/create', brief })).rejects.toMatchObject({ code: 'workflow-reference-invalid' })
  await expect(f.execute({ type: 'workflow/task-template/create', name: 'Legacy', brief })).rejects.toMatchObject({ code: 'workflow-reference-invalid' })
  expect(f.directory.record(f.runtime.workspaceId)).toEqual(before)
  expect(f.runtime.workflowSnapshot().workflow.drafts).toEqual({})
  expect(f.runtime.workflowSnapshot().workflow.taskTemplateRevisions).toEqual({})
  expect(f.runtime.workflowSnapshot().workflow.artifacts).toEqual({})
  expect(JSON.stringify(f.runtime.workflowSnapshot())).not.toContain('Withdrawable result')
})

test.each(['handoff', 'changes-requested'] as const)('valid %s continuation creates a real chat source and awaits chat confirmation', async kind => {
  const f = await fixture()
  const command = kind === 'handoff' ? { type: 'workflow/result/handoff' as const, result: f.result, artifactIds: [] } : { type: 'workflow/result/review' as const, result: f.result, decision: 'changes-requested' as const, comment: 'Please revise' }
  await expect(f.runtime.executeWorkflow({ ...expected(f.runtime), operationId: WorkflowOperationId('missing-room') }, command)).rejects.toMatchObject({ code: 'workflow-reference-invalid' })
  await expect(f.directory.executeWorkflow(f.runtime.workspaceId, { ...expected(f.runtime), operationId: WorkflowOperationId('missing-room-direct'), command }, { humanId: WEB_WORKSPACE_HUMAN_ID, occurredAt: '2026-10-13T00:00:00.000Z' })).rejects.toMatchObject({ code: 'workflow-reference-invalid', details: { entityKind: 'chat-source-required' } })
  const request = { ...expected(f.runtime), roomId: f.roomId, operationId: WorkflowOperationId(kind) }
  const continued = await f.runtime.executeWorkflow(request, command)
  if (!('draftId' in continued.value) || continued.value.draftId === undefined) throw new Error('Missing continuation draft')
  const record = f.directory.record(f.runtime.workspaceId)
  const source = record.communication.draftSources[continued.value.draftId]!
  expect(source.roomId).toBe(f.roomId)
  expect(record.aggregate.events.find(event => event.id === source.eventId)).toMatchObject({ type: 'room/message', subjectId: f.roomId, actor: { type: 'human', id: WEB_WORKSPACE_HUMAN_ID } })
  expect(Object.keys(record.aggregate.tasks)).toHaveLength(1)
  expect(await f.runtime.executeWorkflow(request, command)).toMatchObject({ replayed: true })
  await expect(f.runtime.executeWorkflow({ ...request, roomId: 'other' as typeof f.roomId }, command)).rejects.toMatchObject({ code: 'workflow-operation-reused' })
  const confirmationRoomId = await joinWorkflowChat(f.runtime, f.agentId)
  const confirmed = await f.runtime.confirmChatWork({ ...expected(f.runtime), roomId: confirmationRoomId, operationId: WorkflowOperationId('confirm-continuation'), draftId: continued.value.draftId, expectedDraftRevision: 0, assigneeAgentId: f.agentId })
  expect(confirmed.value.source.eventId).not.toBe(source.eventId)
  expect(confirmed.value.source.roomId).toBe(confirmationRoomId)
  expect(f.directory.record(f.runtime.workspaceId).communication.draftSources[continued.value.draftId]).toEqual(source)
  expect(await f.runtime.executeWorkflow(request, command)).toMatchObject({ replayed: true })
  expect(Object.keys(f.runtime.snapshot().tasks)).toHaveLength(2)
})

test('browser workflow continuation forwards the selected room outside the semantic command', async () => {
  let sent: unknown
  const api = new WorkspaceWorkflowApi(new WorkspaceApi({ rpc: { call: async (_channel: string, _endpoint: string, payload: unknown) => { sent = payload; return { ok: true, value: { workspaceId: 'local', aggregateRevision: 1, workflowRevision: 1, value: { draftId: 'draft' }, replayed: false } } } } } as never).forWorkspace('local'))
  await api.mutate('workflow/result/handoff', { result: { taskId: 'task', eventId: 'result', attemptId: 'attempt' }, artifactIds: [] }, { expectedAggregateRevision: 0, expectedWorkflowRevision: 0 }, 'continue', undefined, 'room')
  expect(sent).toMatchObject({ roomId: 'room', operationId: 'continue', workspaceId: 'local' })
})
