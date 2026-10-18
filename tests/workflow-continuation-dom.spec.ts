// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test } from 'vitest'
import { WorkspaceWorkflow } from '../packages/web/src/client/WorkspaceWorkflow.tsx'
import { WorkspaceApi } from '../packages/web/src/client/api.ts'
import { en } from '../packages/web/src/client/locales.ts'
import { createOrganizationRpcHandler } from '../packages/host/src/organization-rpc.ts'
import type { OrganizationRpcService } from '../packages/host/src/organization-rpc.ts'
import { workflowRuntime, joinWorkflowChat, brief, expected } from './workflow-test-support.ts'
import { WorkflowOperationId } from '../packages/host/src/workflow.ts'
import { mutateWorkspace } from '../packages/host/src/state.ts'
import { acceptTaskDelivery, startTaskDelivery, terminalizeTask } from '../packages/host/src/task-delivery.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { completeMessageRecall, prepareMessageRecall } from '../packages/host/src/message-recall.ts'
import type { ContextResetId } from '../packages/host/src/communication-contract.ts'
import { WEB_WORKSPACE_HUMAN_ID } from '../packages/host/src/rpc.ts'

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })

test('result continuation waits for a selected staffed chat and persists its real message source through Browser RPC', async () => {
  const f = await workflowRuntime()
  const roomId = await joinWorkflowChat(f.runtime, f.agentId)
  await f.directory.updateAggregate(f.runtime.workspaceId, state => mutateWorkspace(state, { type: 'room/create', kind: 'group', name: 'Empty chat' }).state)
  const assignment = await f.runtime.assignChatWork({ ...expected(f.runtime), roomId, operationId: WorkflowOperationId('work'), brief, assigneeAgentId: f.agentId })
  await f.directory.updateAggregate(f.runtime.workspaceId, state => {
    const start = startTaskDelivery(state, { taskId: assignment.value.taskId })
    const accepted = acceptTaskDelivery(start.state, { taskId: assignment.value.taskId, attemptId: start.attemptId, messageId: start.message.id })
    return terminalizeTask(accepted.state, { actorAgentId: f.agentId, taskId: assignment.value.taskId, attemptId: start.attemptId, definitionRevisionId: Object.values(state.definitionRevisions)[0]!.id, result: 'Ready for review' }).state
  })
  const router = createOrganizationRpcHandler({ forWorkspace: () => f.runtime } as OrganizationRpcService)
  const api = new WorkspaceApi({ rpc: { call: async (_channel: string, endpoint: string, payload: unknown, options?: { signal?: AbortSignal }) => router(endpoint, payload, options?.signal ?? new AbortController().signal) } } as never).forWorkspace(f.runtime.workspaceId)
  const node = document.createElement('div')
  const root = createRoot(node)
  const t = (key: keyof typeof en, params?: Record<string, string | number>) => Object.entries(params ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), en[key])
  try {
    await act(async () => root.render(createElement(WorkspaceWorkflow, { api, snapshot: f.runtime.snapshot(), onSnapshot: () => {}, t: t as never })))
    const resultSelect = [...node.querySelectorAll('label')].find(label => label.querySelector('span')?.textContent === en['workflow.result'])!.querySelector('select')!
    await act(async () => { resultSelect.value = f.runtime.snapshot().events.find(event => event.type === 'task/result')!.id; resultSelect.dispatchEvent(new Event('change', { bubbles: true })) })
    const handoff = [...node.querySelectorAll('button')].find(button => button.textContent === en['workflow.handoff'])!
    expect(handoff.disabled).toBe(true)
    const roomSelect = [...node.querySelectorAll('label')].find(label => label.querySelector('span')?.textContent === en['workflow.continuationRoom'])!.querySelector('select')!
    expect([...roomSelect.options].map(option => option.text)).not.toContain('Empty chat')
    await act(async () => { roomSelect.value = roomId; roomSelect.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(handoff.disabled).toBe(false)
    await act(async () => handoff.click())
    const record = f.directory.record(f.runtime.workspaceId)
    const continued = Object.values(record.workflow.drafts).find(draft => draft.source.type === 'handoff')!
    expect(continued).toBeDefined()
    const source = record.communication.draftSources[continued.id]!
    expect(source.roomId).toBe(roomId)
    expect(record.aggregate.events.find(event => event.id === source.eventId)).toMatchObject({ type: 'room/message', subjectId: roomId })
    expect(Object.values(record.aggregate.tasks)).toHaveLength(1)
    const draftSelect = [...node.querySelectorAll('label')].find(label => label.querySelector('span')?.textContent === en['workflow.draft'])!.querySelector('select')!
    await act(async () => { draftSelect.value = continued.id; draftSelect.dispatchEvent(new Event('change', { bubbles: true })) })
    const nameInput = [...node.querySelectorAll('label')].find(label => label.querySelector('span')?.textContent === en['workflow.templateName'])!.querySelector('input')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(nameInput, 'Saved task'); nameInput.dispatchEvent(new Event('input', { bubbles: true })) })
    const createTemplate = [...node.querySelectorAll('button')].find(button => button.textContent === en['workflow.createTaskTemplate'])!
    expect(createTemplate.disabled).toBe(false)
    const resetId = 'withdraw' as ContextResetId
    await f.directory.updateRecord(f.runtime.workspaceId, raw => ({ record: completeMessageRecall(prepareMessageRecall(raw, { operationId: resetId, roomId, eventId: assignment.value.source.eventId, humanId: WEB_WORKSPACE_HUMAN_ID, requestedAt: '2026-10-13T00:00:00.000Z', restoreFiles: false }), resetId, { [f.agentId]: SessionId('fresh') }), value: undefined }))
    await act(async () => root.render(createElement(WorkspaceWorkflow, { api, snapshot: f.runtime.snapshot(), onSnapshot: () => {}, t: t as never })))
    expect(createTemplate.disabled).toBe(true)
    expect(node.textContent).not.toContain('Ready for review')
  } finally { await act(async () => root.unmount()) }
})
