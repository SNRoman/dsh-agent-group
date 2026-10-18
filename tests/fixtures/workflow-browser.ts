import { HumanId, WorkspaceId } from '../../packages/host/src/ids.ts'
import { createInitialState, mutateWorkspace } from '../../packages/host/src/state.ts'
import { createInitialWorkflowState, applyWorkflowCommand, previewCompanyTemplate } from '../../packages/host/src/workflow.ts'
import { startTaskDelivery, acceptTaskDelivery, terminalizeTask } from '../../packages/host/src/task-delivery.ts'
import { createInitialCommunicationState } from '../../packages/host/src/communication.ts'
import { WorkspaceApi } from '../../packages/web/src/client/api.ts'
import type { WorkflowCommand, CompanyTemplateRevisionId } from '../../packages/host/src/workflow-contract.ts'
export const emptyWorkflow = createInitialWorkflowState
export function workflowBrowserFixture(workspaceId = 'workspace') {
  const definition = mutateWorkspace(createInitialState(WorkspaceId(workspaceId)), { type: 'definition/create', name: 'Engineer', description: 'Role', instructions: 'Do work' })
  const agent = mutateWorkspace(definition.state, { type: 'agent/create', name: 'Alice', definitionId: definition.definitionId })
  const room = mutateWorkspace(agent.state, { type: 'room/create', kind: 'group', name: 'Work chat' })
  let aggregate = mutateWorkspace(room.state, { type: 'room/join', roomId: room.roomId, agentId: agent.agentId, memoryStart: { type: 'new-events' } }).state; let workflow = createInitialWorkflowState()
  const commands: WorkflowCommand[] = []
  const operations = new Map<string, { readonly command: string; readonly value: unknown }>()
  const context = { humanId: HumanId('owner'), occurredAt: '2026-10-11T00:00:00.000Z' }
  const api = new WorkspaceApi({ rpc: { call: async (_channel: string, endpoint: string, request: unknown) => {
    if (endpoint === 'snapshot') return { ok: true, value: structuredClone(aggregate) }
    if (endpoint === 'workflow/snapshot') return { ok: true, value: { workspaceId, aggregateRevision: aggregate.revision, workflow: structuredClone(workflow) } }
    if (endpoint === 'communication/snapshot') return { ok: true, value: { workspaceId, aggregateRevision: aggregate.revision, workflowRevision: workflow.revision, communication: createInitialCommunicationState() } }
    const fields = { ...request as Record<string, unknown> }; delete fields['workspaceId']; delete fields['expectedAggregateRevision']; delete fields['expectedWorkflowRevision']; delete fields['operationId']
    delete fields['roomId']
    if (endpoint === 'workflow/company-template/preview') return { ok: true, value: { workspaceId, aggregateRevision: aggregate.revision, workflowRevision: workflow.revision, templateRevisionId: fields['templateRevisionId'], config: previewCompanyTemplate(aggregate, workflow, fields['templateRevisionId'] as CompanyTemplateRevisionId) } }
    const command = { ...fields, type: endpoint } as WorkflowCommand
    const operationId = (request as Record<string, unknown>)['operationId']
    const previous = typeof operationId === 'string' ? operations.get(operationId) : undefined
    if (previous) {
      if (previous.command !== JSON.stringify(command)) throw new Error('Operation identity reused for different input')
      return { ok: true, value: { workspaceId, aggregateRevision: aggregate.revision, workflowRevision: workflow.revision, value: structuredClone(previous.value), replayed: true } }
    }
    const transition = applyWorkflowCommand({ aggregate, workflow }, command, context)
    aggregate = transition.aggregate; workflow = transition.workflow; commands.push(command)
    if (typeof operationId === 'string') operations.set(operationId, { command: JSON.stringify(command), value: structuredClone(transition.value) })
    return { ok: true, value: { workspaceId, aggregateRevision: aggregate.revision, workflowRevision: workflow.revision, value: transition.value, replayed: false } }
  } } } as never).forWorkspace(workspaceId)
  return { api, commands, roomId: room.roomId, agentId: agent.agentId, roleRevisionId: definition.definitionRevisionId, get aggregate() { return aggregate }, get workflow() { return workflow }, seedDraft(brief = { title: 'Report', instructions: 'Write a complete report', expectedArtifacts: ['Report file'], acceptanceCriteria: ['Reviewed'] }) {
    const transition = applyWorkflowCommand({ aggregate, workflow }, { type: 'workflow/draft/create', brief }, context)
    aggregate = transition.aggregate; workflow = transition.workflow; return transition.value.draftId
  }, seedConfirmed() {
    const draft = applyWorkflowCommand({ aggregate, workflow }, { type: 'workflow/draft/create', brief: { title: 'Report', instructions: 'Write a complete report', expectedArtifacts: ['Report file'], acceptanceCriteria: ['Reviewed'] } }, context)
    const transition = applyWorkflowCommand(draft, { type: 'workflow/draft/confirm', draftId: draft.value.draftId, expectedDraftRevision: 0, assigneeAgentId: agent.agentId }, context)
    aggregate = transition.aggregate; workflow = transition.workflow; return transition.value
  }, addColleague(name: string) {
    const added = mutateWorkspace(aggregate, { type: 'agent/create', name, definitionId: definition.definitionId }); aggregate = added.state; return added.agentId
  }, complete() {
    const task = Object.values(aggregate.tasks).at(-1)!
    const start = startTaskDelivery(aggregate, { taskId: task.id }); const accepted = acceptTaskDelivery(start.state, { taskId: task.id, attemptId: start.attemptId, messageId: start.message.id })
    aggregate = terminalizeTask(accepted.state, { actorAgentId: agent.agentId, taskId: task.id, attemptId: start.attemptId, definitionRevisionId: definition.definitionRevisionId, result: '<script>unsafe</script> Result' }).state
  } }
}
