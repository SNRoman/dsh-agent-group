import { expect, test } from 'vitest'
import { createOrganizationRpcHandler } from '../packages/host/src/organization-rpc.ts'
import type { OrganizationRpcService } from '../packages/host/src/organization-rpc.ts'
import { workflowRuntime, joinWorkflowChat, brief, expected } from './workflow-test-support.ts'
import { WorkflowOperationId } from '../packages/host/src/workflow.ts'
import { WEB_WORKSPACE_HUMAN_ID } from '../packages/host/src/rpc.ts'
import { startTaskDelivery, acceptTaskDelivery, terminalizeTask } from '../packages/host/src/task-delivery.ts'
import type { WorkflowEndpoint, WorkflowCommandMap, WorkflowMutationResult, WorkflowMutationValueMap } from '../packages/host/src/workflow-contract.ts'

test('registered organization router accepts explicit workflow scope and rejects actor overrides', async () => {
  const { runtime } = await workflowRuntime()
  const handler = createOrganizationRpcHandler({ forWorkspace: () => runtime } as OrganizationRpcService)
  const payload = { workspaceId: runtime.workspaceId, operationId: 'create', expectedAggregateRevision: runtime.snapshot().revision, expectedWorkflowRevision: 0, brief }
  const signal = new AbortController().signal
  expect(await handler('workflow/draft/create', { ...payload, actor: 'forged' }, signal)).toMatchObject({ ok: false, error: { kind: 'bad-request' } })
  expect(await handler('workflow/draft/create', { ...payload, type: 'workflow/draft/create' }, signal)).toMatchObject({ ok: false, error: { kind: 'bad-request' } })
  expect(await handler('workflow/draft/create', payload, signal)).toMatchObject({ ok: false, error: { code: 'workflow-reference-invalid', details: { entityKind: 'chat-source-required' } } })
  expect(await handler('workflow/snapshot', { workspaceId: runtime.workspaceId }, signal)).toMatchObject({ ok: true, value: { workflow: { revision: 0 } } })
})

test('supported human workflows use scoped parsing and chat work replaces legacy creation, application and confirmation', async () => {
  const { runtime, directory, agentId } = await workflowRuntime()
  const roomId = await joinWorkflowChat(runtime, agentId)
  const router = createOrganizationRpcHandler({ forWorkspace: () => runtime } as OrganizationRpcService)
  const signal = new AbortController().signal; let next = 1
  async function write<K extends WorkflowEndpoint>(endpoint: K, payload: WorkflowCommandMap[K]): Promise<WorkflowMutationValueMap[K]> {
    const result = await router(endpoint, { workspaceId: runtime.workspaceId, ...expected(runtime), operationId: `op-${next++}`, ...payload, ...(endpoint === 'workflow/result/handoff' || endpoint === 'workflow/result/review' && 'decision' in payload && payload.decision === 'changes-requested' ? { roomId } : {}) }, signal)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(JSON.stringify(result.error))
    return (result.value as WorkflowMutationResult<WorkflowMutationValueMap[K]>).value
  }
  const seeded = await directory.executeWorkflow(runtime.workspaceId, { ...expected(runtime), operationId: WorkflowOperationId('legacy-seed'), command: { type: 'workflow/draft/create', brief, suggestedAssigneeAgentId: agentId } }, { humanId: WEB_WORKSPACE_HUMAN_ID, occurredAt: '2026-10-13T00:00:00.000Z' })
  const draft = seeded.value
  await write('workflow/draft/edit', { draftId: draft.draftId, expectedDraftRevision: 0, brief: { ...brief, instructions: 'Edited details' } })
  await write('workflow/draft/discard', { draftId: draft.draftId, expectedDraftRevision: 1 })
  const template = await write('workflow/task-template/create', { name: 'Template', brief })
  const revision = await write('workflow/task-template/revise', { templateId: template.templateId, brief: { ...brief, title: 'Revised' } })
  for (const [endpoint, payload] of [
    ['workflow/draft/create', { brief }],
    ['workflow/task-template/apply', { templateRevisionId: revision.templateRevisionId }],
    ['workflow/draft/confirm', { draftId: draft.draftId, expectedDraftRevision: 1, assigneeAgentId: agentId }],
  ] as const) expect(await router(endpoint, { workspaceId: runtime.workspaceId, ...expected(runtime), operationId: `blocked-${endpoint}`, roomId, ...payload }, signal)).toMatchObject({ ok: false, error: { code: 'workflow-reference-invalid', details: { entityKind: 'chat-source-required' } } })
  const assigned = await router('communication/assign', { workspaceId: runtime.workspaceId, ...expected(runtime), operationId: 'chat-assign', roomId, brief: runtime.workflowSnapshot().workflow.taskTemplateRevisions[revision.templateRevisionId]!.brief, assigneeAgentId: agentId }, signal)
  expect(assigned.ok).toBe(true)
  if (!assigned.ok) throw new Error('Chat assignment failed')
  const task = (assigned.value as WorkflowMutationResult<WorkflowMutationValueMap['workflow/draft/confirm']>).value
  const config = { colleagues: [{ name: 'Bob', definitionRevisionId: runtime.snapshot().agents[agentId]!.definitionRevisionId }], groups: [{ name: 'Team', memberNames: ['Bob'] }] }
  const company = await write('workflow/company-template/create', { name: 'Company', config })
  const revisedCompany = await write('workflow/company-template/revise', { templateId: company.templateId, config })
  const before = directory.record(runtime.workspaceId)
  expect(await router('workflow/company-template/preview', { workspaceId: runtime.workspaceId, ...expected(runtime), templateRevisionId: revisedCompany.templateRevisionId }, signal)).toMatchObject({ ok: true, value: { config } })
  expect(directory.record(runtime.workspaceId)).toEqual(before)
  await write('workflow/company-template/confirm', { templateRevisionId: revisedCompany.templateRevisionId, confirmed: true, memoryStart: { type: 'new-events' } })
  await directory.updateAggregate(runtime.workspaceId, state => {
    const started = startTaskDelivery(state, { taskId: task.taskId })
    const accepted = acceptTaskDelivery(started.state, { taskId: task.taskId, attemptId: started.attemptId, messageId: started.message.id })
    return terminalizeTask(accepted.state, { actorAgentId: agentId, taskId: task.taskId, attemptId: started.attemptId, result: 'Complete exact result', definitionRevisionId: state.agents[agentId]!.definitionRevisionId }).state
  })
  const event = runtime.snapshot().events.findLast(event => event.type === 'task/result')!
  if (event.type !== 'task/result') throw new Error('result missing')
  const result = { taskId: task.taskId, eventId: event.id, attemptId: event.taskDeliveryAttemptId }
  const artifact = await write('workflow/artifact/register', { result, label: 'Report', summary: 'Ready', reference: { kind: 'path', value: 'C:/inert/report.md' } })
  await write('workflow/result/review', { result, decision: 'changes-requested', comment: 'Add examples' })
  await write('workflow/result/review', { result, decision: 'accepted', comment: '' })
  await write('workflow/result/handoff', { result, artifactIds: [artifact.artifactId], suggestedAssigneeAgentId: agentId })
  expect(await router('workflow/snapshot', { workspaceId: runtime.workspaceId }, signal)).toMatchObject({ ok: true, value: { workspaceId: runtime.workspaceId, workflow: { revision: 14 } } })
  expect(Object.keys(runtime.snapshot().sessionBindings)).toHaveLength(0)
  expect(Object.keys(runtime.snapshot().delegationGrants)).toHaveLength(0)
})

test('strict workflow requests reject actor/time/source overrides, unknown routes, missing scope and cancellation', async () => {
  const { runtime } = await workflowRuntime()
  const router = createOrganizationRpcHandler({ forWorkspace: () => runtime } as OrganizationRpcService)
  const payload = { workspaceId: runtime.workspaceId, ...expected(runtime), operationId: 'draft', brief }
  for (const key of ['actor', 'humanId', 'agentId', 'occurredAt', 'source', 'type']) expect(await router('workflow/draft/create', { ...payload, [key]: 'forged' }, new AbortController().signal)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  expect(await router('workflow/draft/create', { brief }, new AbortController().signal)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  for (const endpoint of ['workflow/employee/proposed', 'workflow/grant', 'workflow/propose-task']) expect(await router(endpoint, payload, new AbortController().signal)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  const aborted = AbortSignal.abort(); expect(await router('workflow/draft/create', payload, aborted)).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  expect(runtime.workflowSnapshot().workflow.revision).toBe(0)
})

test('workflow and aggregate business failures retain safe codes and details', async () => {
  const fixture = await workflowRuntime(); const { runtime } = fixture
  const router = createOrganizationRpcHandler({ forWorkspace: () => runtime } as OrganizationRpcService)
  const signal = new AbortController().signal
  const payload = { workspaceId: runtime.workspaceId, ...expected(runtime), operationId: 'draft', brief }
  const created = await fixture.directory.executeWorkflow(runtime.workspaceId, { ...expected(runtime), operationId: WorkflowOperationId('draft'), command: { type: 'workflow/draft/create', brief } }, { humanId: WEB_WORKSPACE_HUMAN_ID, occurredAt: '2026-10-13T00:00:00.000Z' })
  const draftId = created.value.draftId
  expect(await router('workflow/draft/edit', { ...payload, operationId: 'stale', draftId, expectedDraftRevision: 0 }, signal)).toMatchObject({ ok: false, error: { code: 'stale-workflow-revision', details: { expectedWorkflowRevision: 0, actualWorkflowRevision: 1 } } })
  expect(await router('workflow/draft/edit', { ...payload, ...expected(runtime), draftId, expectedDraftRevision: 0, brief: { ...brief, title: 'Other' } }, signal)).toMatchObject({ ok: false, error: { code: 'workflow-operation-reused', details: { operationId: 'draft' } } })
  expect(await router('workflow/draft/edit', { workspaceId: runtime.workspaceId, ...expected(runtime), operationId: 'edit', draftId, expectedDraftRevision: 9, brief }, signal)).toMatchObject({ ok: false, error: { code: 'stale-draft-revision', details: { draftId, expectedDraftRevision: 9, actualDraftRevision: 0 } } })
  expect(await router('workflow/draft/discard', { workspaceId: runtime.workspaceId, ...expected(runtime), operationId: 'missing', draftId: 'missing', expectedDraftRevision: 0 }, signal)).toMatchObject({ ok: false, error: { code: 'workflow-reference-invalid', details: { entityId: 'missing' } } })
  expect(await router('workflow/draft/discard', { workspaceId: runtime.workspaceId, ...expected(runtime), expectedAggregateRevision: 0, operationId: 'old', draftId, expectedDraftRevision: 0 }, signal)).toMatchObject({ ok: false, error: { code: 'stale-revision' } })
  await router('workflow/draft/discard', { workspaceId: runtime.workspaceId, ...expected(runtime), operationId: 'discard', draftId, expectedDraftRevision: 0 }, signal)
  expect(await router('workflow/draft/edit', { workspaceId: runtime.workspaceId, ...expected(runtime), operationId: 'closed', draftId, expectedDraftRevision: 1, brief }, signal)).toMatchObject({ ok: false, error: { code: 'draft-not-editable', details: { draftId, status: 'discarded' } } })
  await fixture.directory.setLifecycle(runtime.workspaceId, 'archived')
  expect(await router('workflow/draft/create', { ...payload, operationId: 'archive' }, signal)).toMatchObject({ ok: false, error: { code: 'workflow-read-only', details: { workspaceId: runtime.workspaceId } } })
})
