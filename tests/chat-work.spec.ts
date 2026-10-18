import { expect, test, vi } from 'vitest'
import { workflowRuntime, brief, expected, publishEmployee } from './workflow-test-support.ts'
import { mutateWorkspace } from '../packages/host/src/state.ts'
import { WorkflowOperationId } from '../packages/host/src/workflow.ts'
import { WEB_WORKSPACE_HUMAN_ID } from '../packages/host/src/rpc.ts'

async function fixture() {
  const f = await workflowRuntime()
  const room = mutateWorkspace(f.runtime.snapshot(), { type: 'room/create', kind: 'group', name: 'Work' })
  const joined = mutateWorkspace(room.state, { type: 'room/join', roomId: room.roomId, agentId: f.agentId, memoryStart: { type: 'new-events' } })
  await f.directory.updateAggregate(f.runtime.workspaceId, () => joined.state)
  const delivered: string[] = []
  Object.assign(f.runtime, { taskDelivery: { deliver: async (id: string) => { const record = f.directory.record(f.runtime.workspaceId); expect(record.communication.taskSources[id as keyof typeof record.communication.taskSources]).toBeDefined(); delivered.push(id); return 'done' } } })
  Object.assign(f.runtime, { dispatcher: { runAssignedTask: async (_agentId: string, id: string) => { const record = f.directory.record(f.runtime.workspaceId); expect(record.communication.taskSources[id as keyof typeof record.communication.taskSources]).toBeDefined(); delivered.push(id); return 'done' } } })
  return { ...f, roomId: room.roomId, delivered }
}

test('chat assignment commits source, complete confirmed brief and default-off authority before one delivery', async () => {
  const f = await fixture()
  expect(f.runtime).toHaveProperty('assignChatWork')
  if (!('assignChatWork' in f.runtime)) return
  const request = { ...expected(f.runtime), operationId: WorkflowOperationId('assign'), roomId: f.roomId, brief, assigneeAgentId: f.agentId }
  const result = await f.runtime.assignChatWork(request)
  await f.runtime.admission.drain()
  const record = f.directory.record(f.runtime.workspaceId)
  expect(record.aggregate.events.filter(event => event.type === 'room/message')).toHaveLength(1)
  expect(record.aggregate.events.find(event => event.id === result.value.source.eventId)).toMatchObject({ text: brief.instructions, actor: { type: 'human', id: WEB_WORKSPACE_HUMAN_ID } })
  expect(record.workflow.taskBriefs[result.value.taskId]?.brief).toEqual(brief)
  expect(record.communication.draftSources[result.value.draftId]).toEqual(result.value.source)
  expect(record.communication.taskSources[result.value.taskId]).toEqual(result.value.source)
  expect(record.aggregate.delegationGrants).toEqual({})
  expect(f.delivered).toEqual([result.value.taskId])
  expect(await f.runtime.assignChatWork(request)).toMatchObject({ replayed: true, value: result.value })
  await f.runtime.admission.drain()
  expect(f.delivered).toEqual([result.value.taskId])
  expect(f.directory.record(f.runtime.workspaceId)).toEqual(record)
})

test('same chat operation id rejects changed room, instructions or permission', async () => {
  const f = await fixture()
  expect(f.runtime).toHaveProperty('assignChatWork')
  if (!('assignChatWork' in f.runtime)) return
  const request = { ...expected(f.runtime), operationId: WorkflowOperationId('assign'), roomId: f.roomId, brief, assigneeAgentId: f.agentId }
  await f.runtime.assignChatWork(request)
  for (const changed of [{ roomId: 'other' as typeof f.roomId }, { brief: { ...brief, instructions: 'Different' } }, { allowDelegation: true }]) {
    await expect(f.runtime.assignChatWork({ ...request, ...changed })).rejects.toMatchObject({ code: 'workflow-operation-reused' })
  }
})

test('chat assignment rollback stores neither message nor task and starts no delivery', async () => {
  const f = await fixture()
  expect(f.runtime).toHaveProperty('assignChatWork')
  if (!('assignChatWork' in f.runtime)) return
  const before = f.directory.record(f.runtime.workspaceId)
  f.fail()
  await expect(f.runtime.assignChatWork({ ...expected(f.runtime), operationId: WorkflowOperationId('failed'), roomId: f.roomId, brief, assigneeAgentId: f.agentId })).rejects.toThrow('disk failed')
  expect(f.directory.record(f.runtime.workspaceId)).toEqual(before)
  expect(f.delivered).toEqual([])
})

test('ordinary message mentions create no task or delegation grant', async () => {
  const f = await fixture()
  Object.assign(f.runtime, { dispatcher: { dispatchHumanPost: vi.fn(async () => {}) } })
  await f.runtime.postHumanMessage(f.runtime.snapshot().revision, f.roomId, WEB_WORKSPACE_HUMAN_ID, 'Please discuss work', [])
  expect(f.runtime.snapshot().tasks).toEqual({})
  expect(f.runtime.snapshot().delegationGrants).toEqual({})
})

test('old independent assignment and draft create entry points cannot make source-free new work', async () => {
  const f = await fixture()
  const missingSource = { code: 'workflow-reference-invalid', details: { entityKind: 'chat-source-required' } }
  await expect(f.runtime.assignTask(f.runtime.snapshot().revision, WEB_WORKSPACE_HUMAN_ID, f.agentId, 'Unlinked')).rejects.toMatchObject(missingSource)
  await expect(f.runtime.executeWorkflow({ ...expected(f.runtime), operationId: WorkflowOperationId('old-draft') }, { type: 'workflow/draft/create', brief })).rejects.toMatchObject(missingSource)
  await expect(f.runtime.executeWorkflow({ ...expected(f.runtime), operationId: WorkflowOperationId('forged-source'), roomId: f.roomId }, { type: 'workflow/draft/create', brief })).rejects.toMatchObject(missingSource)
  expect(f.runtime.snapshot().tasks).toEqual({})
  expect(f.runtime.workflowSnapshot().workflow.drafts).toEqual({})
})

test('authorized colleague delegation commits its actual chat message and source before delivery', async () => {
  const f = await fixture()
  const employee = await publishEmployee(f.runtime, f.agentId)
  try {
    const peer = mutateWorkspace(f.runtime.snapshot(), { type: 'agent/create', definitionId: Object.values(f.runtime.snapshot().definitions)[0]!.id, name: 'Bob' })
    const joined = mutateWorkspace(peer.state, { type: 'room/join', roomId: f.roomId, agentId: peer.agentId, memoryStart: { type: 'new-events' } })
    await f.directory.updateAggregate(f.runtime.workspaceId, () => joined.state)
    const root = await f.runtime.assignChatWork({ ...expected(f.runtime), operationId: WorkflowOperationId('grant'), roomId: f.roomId, brief, assigneeAgentId: f.agentId, allowDelegation: true })
    await f.runtime.admission.drain()
    const request = { roomId: f.roomId, rootTaskId: root.value.taskId, assigneeAgentId: peer.agentId, title: 'Implement the API' }
    const delegated = await f.runtime.delegateTask(employee.agent, request)
    const record = f.directory.record(f.runtime.workspaceId)
    expect(record.communication.taskSources[delegated.taskId]).toEqual(delegated.source)
    expect(record.communication.messages[delegated.source.eventId]).toMatchObject({ intent: 'delegation' })
    expect(record.aggregate.events.find(event => event.id === delegated.source.eventId)).toMatchObject({ type: 'room/message', subjectId: f.roomId, actor: { type: 'agent', id: f.agentId }, text: request.title, mentions: [peer.agentId] })
    expect(record.aggregate.tasks[delegated.taskId]).toMatchObject({ rootTaskId: root.value.taskId, title: request.title })
    await f.runtime.runAssignedTask(peer.agentId, delegated.taskId)
    expect(f.delivered).toEqual([root.value.taskId, delegated.taskId])
    const before = f.directory.record(f.runtime.workspaceId)
    f.fail()
    await expect(f.runtime.delegateTask(employee.agent, request)).rejects.toThrow('disk failed')
    expect(f.directory.record(f.runtime.workspaceId)).toEqual(before)
  } finally { await employee.pool.disposeAll() }
})

test('ordinary chat and source labels cannot grant colleague delegation', async () => {
  const f = await fixture()
  const employee = await publishEmployee(f.runtime, f.agentId)
  try {
    const root = await f.runtime.assignChatWork({ ...expected(f.runtime), operationId: WorkflowOperationId('no-grant'), roomId: f.roomId, brief, assigneeAgentId: f.agentId })
    await f.runtime.admission.drain()
    const before = f.directory.record(f.runtime.workspaceId)
    await expect(f.runtime.delegateTask(employee.agent, { roomId: f.roomId, rootTaskId: root.value.taskId, assigneeAgentId: f.agentId, title: 'Unauthorized delegation' })).rejects.toMatchObject({ code: 'delegation-grant-missing' })
    expect(f.directory.record(f.runtime.workspaceId)).toEqual(before)
    expect(f.delivered).toEqual([root.value.taskId])
  } finally { await employee.pool.disposeAll() }
})

test('employee proposal writes a real agent chat source and starts work only after new human chat confirmation', async () => {
  const f = await fixture()
  const employee = await publishEmployee(f.runtime, f.agentId)
  try {
    const proposed = await f.runtime.proposeTask(employee.agent, { roomId: f.roomId, brief })
    const record = f.directory.record(f.runtime.workspaceId)
    const source = record.communication.draftSources[proposed.draftId]
    expect(source).toBeDefined()
    expect(record.aggregate.events.find(event => event.id === source?.eventId)).toMatchObject({ type: 'room/message', text: brief.instructions, actor: { type: 'agent', id: f.agentId } })
    expect(record.aggregate.tasks).toEqual({})
    expect(f.delivered).toEqual([])
    const confirmed = await f.runtime.confirmChatWork({ ...expected(f.runtime), operationId: WorkflowOperationId('confirm'), roomId: f.roomId, draftId: proposed.draftId, expectedDraftRevision: 0, assigneeAgentId: f.agentId })
    await f.runtime.admission.drain()
    expect(confirmed.value.source.eventId).not.toBe(source?.eventId)
    expect(f.delivered).toEqual([confirmed.value.taskId])
  } finally { await employee.pool.disposeAll() }
})
