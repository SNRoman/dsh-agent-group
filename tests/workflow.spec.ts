import { expect, test } from 'vitest'
import { AgentId, HumanId, TaskDeliveryAttemptId, WorkspaceId } from '../packages/host/src/ids.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import { acceptTaskDelivery, startTaskDelivery, terminalizeTask } from '../packages/host/src/task-delivery.ts'
import { applyWorkflowCommand, assertWorkflowInvariants, createInitialWorkflowState, previewCompanyTemplate, proposeWorkflowDraft, renderWorkflowTaskInstructions } from '../packages/host/src/workflow.ts'
import type { WorkflowCommand, WorkflowEndpoint, WorkflowState } from '../packages/host/src/workflow-contract.ts'
import type { WorkspaceState } from '../packages/host/src/types.ts'

const context = { humanId: HumanId('owner'), occurredAt: '2026-10-11T00:00:00.000Z' }
const brief = { title: 'Ship', instructions: 'Build the report', expectedArtifacts: ['report'], acceptanceCriteria: ['reviewed'] }
function fixture() {
  const definition = mutateWorkspace(createInitialState(WorkspaceId('local')), { type: 'definition/create', name: 'Engineer', description: 'd', instructions: 'i' })
  const agent = mutateWorkspace(definition.state, { type: 'agent/create', definitionId: definition.definitionId, name: 'Ada' })
  return { aggregate: agent.state, workflow: createInitialWorkflowState(), agentId: agent.agentId, revisionId: definition.definitionRevisionId }
}
function run<K extends WorkflowEndpoint>(input: { aggregate: WorkspaceState; workflow: WorkflowState }, command: WorkflowCommand<K>) { return applyWorkflowCommand(input, command, context) }
function confirmed() {
  const f = fixture(); const draft = run(f, { type: 'workflow/draft/create', brief })
  const confirm = run(draft, { type: 'workflow/draft/confirm', draftId: draft.value.draftId, expectedDraftRevision: 0, assigneeAgentId: f.agentId })
  const started = startTaskDelivery(confirm.aggregate, { taskId: confirm.value.taskId })
  const accepted = acceptTaskDelivery(started.state, { taskId: confirm.value.taskId, attemptId: started.attemptId, messageId: started.message.id })
  const ended = terminalizeTask(accepted.state, { actorAgentId: f.agentId, taskId: confirm.value.taskId, attemptId: started.attemptId, definitionRevisionId: f.revisionId, result: 'Exact source text' })
  const event = ended.state.events.find(e => e.type === 'task/result')!
  return { ...confirm, aggregate: ended.state, result: { taskId: confirm.value.taskId, attemptId: started.attemptId, eventId: event.id }, agentId: f.agentId }
}
test('drafts never assign or grant', () => {
  const f = fixture(); const create = run(f, { type: 'workflow/draft/create', brief, suggestedAssigneeAgentId: f.agentId })
  const edit = run(create, { type: 'workflow/draft/edit', draftId: create.value.draftId, expectedDraftRevision: 0, brief: { ...brief, title: 'Edited' } })
  const discard = run(edit, { type: 'workflow/draft/discard', draftId: create.value.draftId, expectedDraftRevision: 1 })
  const template = run(discard, { type: 'workflow/task-template/create', name: 'Report', brief })
  const applied = run(template, { type: 'workflow/task-template/apply', templateRevisionId: template.value.templateRevisionId })
  const proposed = proposeWorkflowDraft(applied, { brief }, { agentId: f.agentId, occurredAt: context.occurredAt })
  expect(proposed.aggregate).toEqual(f.aggregate)
  expect(proposed.aggregate.tasks).toEqual({}); expect(proposed.aggregate.delegationGrants).toEqual({})
  expect(proposed.workflow.facts.map(fact => fact.type)).toContain('workflow/employee/proposed')
  expect(proposed.workflow.drafts[create.value.draftId]?.status).toBe('discarded')
})
test('confirmed brief is detached', () => {
  const f = fixture(); const mutable = structuredClone(brief)
  const draft = run(f, { type: 'workflow/draft/create', brief: mutable })
  mutable.instructions = 'changed outside'
  const confirm = run(draft, { type: 'workflow/draft/confirm', draftId: draft.value.draftId, expectedDraftRevision: 0, assigneeAgentId: f.agentId })
  expect(Object.keys(confirm.aggregate.tasks)).toHaveLength(1)
  expect(confirm.deliveryTaskId).toBe(confirm.value.taskId)
  expect(confirm.workflow.taskBriefs[confirm.value.taskId]?.brief.instructions).toBe('Build the report')
  expect(() => run(confirm, { type: 'workflow/draft/edit', draftId: draft.value.draftId, expectedDraftRevision: 0, brief })).toThrow()
  expect(renderWorkflowTaskInstructions(confirm.workflow.taskBriefs[confirm.value.taskId]!)).toBe('Ship\n\nInstructions\nBuild the report\n\nExpected artifacts\n- report\n\nAcceptance criteria\n- reviewed')
  assertWorkflowInvariants(confirm.aggregate, confirm.workflow)
})
test('template revision stays pinned', () => {
  const f = fixture(); const template = run(f, { type: 'workflow/task-template/create', name: 'T', brief })
  const applied = run(template, { type: 'workflow/task-template/apply', templateRevisionId: template.value.templateRevisionId })
  const revised = run(applied, { type: 'workflow/task-template/revise', templateId: template.value.templateId, brief: { ...brief, instructions: 'new' } })
  expect(revised.workflow.drafts[applied.value.draftId]?.brief).toEqual(brief)
  expect(revised.workflow.taskTemplateRevisions[template.value.templateRevisionId]?.brief).toEqual(brief)
  expect(revised.workflow.taskTemplates[template.value.templateId]?.revisionIds).toHaveLength(2)
})
test('company configuration is atomic', () => {
  const f = fixture(); const config = { colleagues: [{ name: 'One', definitionRevisionId: f.revisionId }], groups: [{ name: 'Team', memberNames: ['One'] }] }
  const template = run(f, { type: 'workflow/company-template/create', name: 'Company', config })
  expect(previewCompanyTemplate(template.aggregate, template.workflow, template.value.templateRevisionId)).toEqual(config)
  expect(template.aggregate).toEqual(f.aggregate)
  const confirm = run(template, { type: 'workflow/company-template/confirm', templateRevisionId: template.value.templateRevisionId, confirmed: true, memoryStart: { type: 'new-events' } })
  expect(confirm.value.agentIds).toHaveLength(1); expect(confirm.value.roomIds).toHaveLength(1); expect(confirm.value.membershipIds).toHaveLength(1)
  expect(Object.keys(confirm.aggregate.sessionBindings)).toHaveLength(0); expect(Object.keys(confirm.aggregate.tasks)).toHaveLength(0)
  const pinned = mutateWorkspace(f.aggregate, { type: 'definition/revise', definitionId: f.aggregate.definitionRevisions[f.revisionId]!.definitionId, description: 'new', instructions: 'new' }).state
  const later = run({ ...template, aggregate: pinned }, { type: 'workflow/company-template/confirm', templateRevisionId: template.value.templateRevisionId, confirmed: true, memoryStart: { type: 'new-events' } })
  expect(later.aggregate.agents[later.value.agentIds[0]!]!.definitionRevisionId).toBe(f.revisionId)
  expect(() => run(f, { type: 'workflow/company-template/create', name: 'Bad', config: { ...config, groups: [{ name: 'G', memberNames: ['absent'] }] } })).toThrow()
  expect(f.aggregate.agents).toHaveProperty(f.agentId)
})
test('reviews select exact result', () => {
  const f = confirmed()
  expect(() => run(f, { type: 'workflow/result/review', result: { ...f.result, attemptId: TaskDeliveryAttemptId('wrong') }, decision: 'accepted', comment: '' })).toThrow()
  const accepted = run(f, { type: 'workflow/result/review', result: f.result, decision: 'accepted', comment: '' })
  expect(accepted.workflow.reviews[accepted.value.reviewId]?.result).toEqual(f.result)
  const changes = run(accepted, { type: 'workflow/result/review', result: f.result, decision: 'changes-requested', comment: 'Fix report' })
  expect(changes.value.draftId).toBeDefined(); expect(changes.aggregate).toEqual(f.aggregate)
  expect(changes.workflow.drafts[changes.value.draftId!]?.handoff?.reviewComment).toBe('Fix report')
})
test('handoff copies only selected artifacts', () => {
  const f = confirmed(); const one = run(f, { type: 'workflow/artifact/register', result: f.result, label: 'One', summary: 'Selected', reference: { kind: 'path', value: 'report.txt' } })
  const two = run(one, { type: 'workflow/artifact/register', result: f.result, label: 'Two', summary: 'Secret' })
  const handoff = run(two, { type: 'workflow/result/handoff', result: f.result, artifactIds: [one.value.artifactId] })
  expect(handoff.workflow.drafts[handoff.value.draftId]?.handoff).toMatchObject({ text: 'Exact source text', artifacts: [{ label: 'One' }] })
  const confirm = run(handoff, { type: 'workflow/draft/confirm', draftId: handoff.value.draftId, expectedDraftRevision: 0, assigneeAgentId: f.agentId })
  const text = renderWorkflowTaskInstructions(confirm.workflow.taskBriefs[confirm.value.taskId]!)
  expect(text).toContain('Exact source text'); expect(text).toContain('report.txt'); expect(text).not.toContain('Secret')
})
test('departed proposal is refused', () => {
  const f = fixture(); const proposal = proposeWorkflowDraft(f, { brief, suggestedAssigneeAgentId: f.agentId }, { agentId: f.agentId, occurredAt: context.occurredAt })
  const departed = mutateWorkspace(f.aggregate, { type: 'agent/depart', agentId: f.agentId }).state
  assertWorkflowInvariants(departed, proposal.workflow)
  expect(() => proposeWorkflowDraft({ ...f, aggregate: departed }, { brief }, { agentId: f.agentId, occurredAt: context.occurredAt })).toThrow()
})
test('relationships use own properties', () => {
  const f = fixture()
  for (const id of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
    expect(() => run(f, { type: 'workflow/draft/create', brief, suggestedAssigneeAgentId: AgentId(id) })).toThrow()
  }
})
test('company confirmation validates created configuration against its immutable fact', () => {
  const f = fixture(); const config = { colleagues: [{ name: 'New', definitionRevisionId: f.revisionId }], groups: [{ name: 'Team', memberNames: ['New'] }] }
  const template = run(f, { type: 'workflow/company-template/create', name: 'Company', config })
  const confirmed = run(template, { type: 'workflow/company-template/confirm', templateRevisionId: template.value.templateRevisionId, confirmed: true, memoryStart: { type: 'new-events' } })
  const damaged = { ...confirmed.workflow, facts: confirmed.workflow.facts.map(fact => fact.type === 'workflow/company-template/confirm' ? { ...fact, receipt: { agentIds: [], roomIds: [], membershipIds: [] } } : fact) }
  expect(() => assertWorkflowInvariants(template.aggregate, damaged)).toThrow()
  let later = mutateWorkspace(confirmed.aggregate, { type: 'definition/revise', definitionId: f.aggregate.definitionRevisions[f.revisionId]!.definitionId, description: 'new', instructions: 'new', synchronizeAgentIds: confirmed.value.agentIds }).state
  later = mutateWorkspace(later, { type: 'agent/depart', agentId: confirmed.value.agentIds[0]! }).state
  assertWorkflowInvariants(later, confirmed.workflow)
  const brokenPin = { ...confirmed.aggregate, events: confirmed.aggregate.events.map(event => event.type === 'agent/definition-revision-assigned' && event.subjectId === confirmed.value.agentIds[0] ? { ...event, definitionRevisionId: undefined } : event) }
  expect(() => assertWorkflowInvariants(brokenPin, confirmed.workflow)).toThrow()
})
