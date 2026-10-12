/** Pure workflow transitions, reference validation and deterministic task instructions. */
import type * as W from './workflow-contract.ts'
import type { AgentId, HumanId, TaskId } from './ids.ts'
import type { TaskResultEvent, WorkspaceState } from './types.ts'
import { WorkspaceBusinessError } from './errors.ts'
import { assignHumanTask } from './tasks.ts'
import { mutateWorkspace } from './state.ts'
import { joinRoomWithMemory } from './memory.ts'
import { workflowCommandSchema, workflowProposalSchema, workflowStateSchema } from './workflow-schema.ts'

export function TaskDraftId(value: string): W.TaskDraftId { return value as W.TaskDraftId }
export function TaskTemplateId(value: string): W.TaskTemplateId { return value as W.TaskTemplateId }
export function TaskTemplateRevisionId(value: string): W.TaskTemplateRevisionId { return value as W.TaskTemplateRevisionId }
export function CompanyTemplateId(value: string): W.CompanyTemplateId { return value as W.CompanyTemplateId }
export function CompanyTemplateRevisionId(value: string): W.CompanyTemplateRevisionId { return value as W.CompanyTemplateRevisionId }
export function TaskArtifactId(value: string): W.TaskArtifactId { return value as W.TaskArtifactId }
export function TaskReviewId(value: string): W.TaskReviewId { return value as W.TaskReviewId }
export function WorkflowFactId(value: string): W.WorkflowFactId { return value as W.WorkflowFactId }
export function WorkflowOperationId(value: string): W.WorkflowOperationId { return value as W.WorkflowOperationId }

/** Machine-readable failures contain identifiers and counters, never source bodies. */
export class WorkflowBusinessError<K extends keyof W.WorkflowBusinessErrorDetailsMap = keyof W.WorkflowBusinessErrorDetailsMap> extends Error {
  override readonly name = 'WorkflowBusinessError'
  constructor(readonly code: K, readonly details: W.WorkflowBusinessErrorDetailsMap[K]) { super(code) }
}

/** Create the empty successor plane without inventing historical facts. */
export function createInitialWorkflowState(): W.WorkflowState {
  return { revision: 0, nextId: 1, nextSequence: 1, drafts: {}, taskTemplates: {}, taskTemplateRevisions: {}, companyTemplates: {}, companyTemplateRevisions: {}, taskBriefs: {}, artifacts: {}, reviews: {}, operations: {}, facts: [] }
}

/** Own-property lookup rejects inherited identifiers in every workflow relationship. */
function own<T>(map: Readonly<Record<string, T>>, id: string, entityKind: string): T {
  if (!Object.hasOwn(map, id)) throw new WorkflowBusinessError('workflow-reference-invalid', { entityKind, entityId: id })
  return map[id]!
}
function employed(aggregate: WorkspaceState, id: AgentId): void {
  if (!Object.hasOwn(aggregate.agents, id)) throw new WorkspaceBusinessError('agent-missing', { agentId: id })
  if (aggregate.agents[id]!.employmentStatus !== 'employed') throw new WorkspaceBusinessError('agent-departed', { agentId: id })
}
function resultEvent(aggregate: WorkspaceState, result: W.TaskResultReference): TaskResultEvent {
  own(aggregate.tasks, result.taskId, 'task')
  const event = aggregate.events.find(event => event.id === result.eventId)
  if (event === undefined || (event.type !== 'task/result' && event.type !== 'task/result-after-cancel') || event.taskId !== result.taskId || event.taskDeliveryAttemptId !== result.attemptId) {
    throw new WorkflowBusinessError('workflow-reference-invalid', { entityKind: 'task-result', entityId: result.eventId })
  }
  return event
}
function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => equal(value, right[index]))
  const leftRecord = left as Record<string, unknown>; const rightRecord = right as Record<string, unknown>
  const keys = Object.keys(leftRecord)
  return keys.length === Object.keys(rightRecord).length && keys.every(key => Object.hasOwn(rightRecord, key) && equal(leftRecord[key], rightRecord[key]))
}
function requireEqual(left: unknown, right: unknown): void { if (!equal(left, right)) throw new Error('workflow immutable data differs from its recorded fact') }
function unique(values: readonly string[]): void { if (new Set(values).size !== values.length) throw new Error('workflow references must be unique') }
function configReferences(aggregate: WorkspaceState, config: W.CompanyTemplateConfig): void {
  unique(config.colleagues.map(item => item.name)); unique(config.groups.map(item => item.name))
  const names = new Set(config.colleagues.map(item => item.name))
  for (const colleague of config.colleagues) own(aggregate.definitionRevisions, colleague.definitionRevisionId, 'definition-revision')
  for (const group of config.groups) {
    unique(group.memberNames)
    for (const name of group.memberNames) if (!names.has(name)) throw new WorkflowBusinessError('workflow-reference-invalid', { entityKind: 'colleague-name', entityId: name })
  }
}
function handoffContext(aggregate: WorkspaceState, workflow: W.WorkflowState, result: W.TaskResultReference, ids: readonly W.TaskArtifactId[], comment?: string): W.HandoffContext {
  unique(ids)
  const event = resultEvent(aggregate, result)
  const artifacts = ids.map(id => {
    const artifact = own(workflow.artifacts, id, 'artifact')
    requireEqual(artifact.result, result)
    const { result: _result, ...snapshot } = artifact
    return structuredClone(snapshot)
  })
  return { result: structuredClone(result), type: event.type, text: event.text, artifacts, ...(comment === undefined ? {} : { reviewComment: comment }) }
}
function sourceBrief(aggregate: WorkspaceState, workflow: W.WorkflowState, taskId: TaskId): W.TaskBrief {
  if (Object.hasOwn(workflow.taskBriefs, taskId)) return structuredClone(workflow.taskBriefs[taskId]!.brief)
  const task = own(aggregate.tasks, taskId, 'task')
  return { title: task.title, instructions: task.title, expectedArtifacts: [], acceptanceCriteria: [] }
}

/** Preview validates the pinned role references and reserves no entities. */
export function previewCompanyTemplate(aggregate: WorkspaceState, workflow: W.WorkflowState, templateRevisionId: W.CompanyTemplateRevisionId): W.CompanyTemplateConfig {
  const config = own(workflow.companyTemplateRevisions, templateRevisionId, 'company-template-revision').config
  configReferences(aggregate, config)
  return structuredClone(config)
}

/** Apply one human command to detached data. Only confirmation returns a delivery identity. */
export function applyWorkflowCommand<K extends W.WorkflowEndpoint>(input: { readonly aggregate: WorkspaceState; readonly workflow: W.WorkflowState }, command: W.WorkflowCommand<K>, context: { readonly humanId: HumanId; readonly occurredAt: string }): W.WorkflowTransition<W.WorkflowMutationValueMap[K]> {
  assertWorkflowInvariants(input.aggregate, input.workflow)
  const parsed = workflowCommandSchema.parse(command)
  let aggregate = structuredClone(input.aggregate)
  let workflow = structuredClone(input.workflow)
  let deliveryTaskId: TaskId | undefined
  let value: W.WorkflowMutationValueMap[W.WorkflowEndpoint]
  function mint<T extends string>(prefix: string, brand: (value: string) => T): T {
    const id = brand(`${prefix}-${workflow.nextId}`)
    workflow = { ...workflow, nextId: workflow.nextId + 1 }
    return id
  }
  function draft(brief: W.TaskBrief, source: W.TaskDraftSource, options: { suggestedAssigneeAgentId?: AgentId; templateRevisionId?: W.TaskTemplateRevisionId; handoff?: W.HandoffContext } = {}): W.TaskDraftId {
    if (options.suggestedAssigneeAgentId !== undefined) own(aggregate.agents, options.suggestedAssigneeAgentId, 'agent')
    const id = mint('draft', TaskDraftId)
    const item: W.TaskDraft = { id, revision: 0, status: 'draft', source, brief: structuredClone(brief), ...structuredClone(options) }
    workflow = { ...workflow, drafts: { ...workflow.drafts, [id]: item } }
    return id
  }
  function editable(id: W.TaskDraftId, expected: number): W.TaskDraft {
    const item = own(workflow.drafts, id, 'draft')
    if (item.status !== 'draft') throw new WorkflowBusinessError('draft-not-editable', { draftId: id, status: item.status })
    if (item.revision !== expected) throw new WorkflowBusinessError('stale-draft-revision', { draftId: id, expectedDraftRevision: expected, actualDraftRevision: item.revision })
    return item
  }
  switch (parsed.type) {
    case 'workflow/draft/create': {
      value = { draftId: draft(parsed.brief, { type: 'human', id: context.humanId }, parsed.suggestedAssigneeAgentId === undefined ? {} : { suggestedAssigneeAgentId: parsed.suggestedAssigneeAgentId }) }; break
    }
    case 'workflow/draft/edit': {
      const item = editable(parsed.draftId, parsed.expectedDraftRevision)
      if (parsed.suggestedAssigneeAgentId !== undefined) own(aggregate.agents, parsed.suggestedAssigneeAgentId, 'agent')
      const { suggestedAssigneeAgentId: _old, ...rest } = item
      workflow = { ...workflow, drafts: { ...workflow.drafts, [item.id]: { ...rest, revision: item.revision + 1, brief: structuredClone(parsed.brief), ...(parsed.suggestedAssigneeAgentId === undefined ? {} : { suggestedAssigneeAgentId: parsed.suggestedAssigneeAgentId }) } } }
      value = { draftId: item.id }; break
    }
    case 'workflow/draft/discard': {
      const item = editable(parsed.draftId, parsed.expectedDraftRevision)
      workflow = { ...workflow, drafts: { ...workflow.drafts, [item.id]: { ...item, status: 'discarded' } } }
      value = { draftId: item.id }; break
    }
    case 'workflow/draft/confirm': {
      const item = editable(parsed.draftId, parsed.expectedDraftRevision)
      employed(aggregate, parsed.assigneeAgentId)
      const assigned = assignHumanTask(aggregate, { humanId: context.humanId, assigneeAgentId: parsed.assigneeAgentId, title: item.brief.title })
      aggregate = assigned.state; deliveryTaskId = assigned.taskId
      const confirmed: W.ConfirmedTaskBrief = { taskId: assigned.taskId, draftId: item.id, brief: structuredClone(item.brief), ...(item.templateRevisionId === undefined ? {} : { templateRevisionId: item.templateRevisionId }), ...(item.handoff === undefined ? {} : { handoff: structuredClone(item.handoff) }) }
      workflow = { ...workflow, drafts: { ...workflow.drafts, [item.id]: { ...item, status: 'confirmed', taskId: assigned.taskId } }, taskBriefs: { ...workflow.taskBriefs, [assigned.taskId]: confirmed } }
      value = { draftId: item.id, taskId: assigned.taskId, taskAssignmentId: assigned.taskAssignmentId }; break
    }
    case 'workflow/task-template/create': {
      const templateId = mint('task-template', TaskTemplateId); const revisionId = mint('task-template-revision', TaskTemplateRevisionId)
      workflow = { ...workflow, taskTemplates: { ...workflow.taskTemplates, [templateId]: { id: templateId, name: parsed.name, revisionIds: [revisionId], currentRevisionId: revisionId } }, taskTemplateRevisions: { ...workflow.taskTemplateRevisions, [revisionId]: { id: revisionId, templateId, number: 1, brief: structuredClone(parsed.brief) } } }
      value = { templateId, templateRevisionId: revisionId }; break
    }
    case 'workflow/task-template/revise': {
      const root = own(workflow.taskTemplates, parsed.templateId, 'task-template'); const revisionId = mint('task-template-revision', TaskTemplateRevisionId)
      workflow = { ...workflow, taskTemplates: { ...workflow.taskTemplates, [root.id]: { ...root, revisionIds: [...root.revisionIds, revisionId], currentRevisionId: revisionId } }, taskTemplateRevisions: { ...workflow.taskTemplateRevisions, [revisionId]: { id: revisionId, templateId: root.id, number: root.revisionIds.length + 1, brief: structuredClone(parsed.brief) } } }
      value = { templateId: root.id, templateRevisionId: revisionId }; break
    }
    case 'workflow/task-template/apply': {
      const revision = own(workflow.taskTemplateRevisions, parsed.templateRevisionId, 'task-template-revision')
      value = { draftId: draft(revision.brief, { type: 'human', id: context.humanId }, { templateRevisionId: revision.id, ...(parsed.suggestedAssigneeAgentId === undefined ? {} : { suggestedAssigneeAgentId: parsed.suggestedAssigneeAgentId }) }) }; break
    }
    case 'workflow/company-template/create': {
      configReferences(aggregate, parsed.config)
      const templateId = mint('company-template', CompanyTemplateId); const revisionId = mint('company-template-revision', CompanyTemplateRevisionId)
      workflow = { ...workflow, companyTemplates: { ...workflow.companyTemplates, [templateId]: { id: templateId, name: parsed.name, revisionIds: [revisionId], currentRevisionId: revisionId } }, companyTemplateRevisions: { ...workflow.companyTemplateRevisions, [revisionId]: { id: revisionId, templateId, number: 1, config: structuredClone(parsed.config) } } }
      value = { templateId, templateRevisionId: revisionId }; break
    }
    case 'workflow/company-template/revise': {
      const root = own(workflow.companyTemplates, parsed.templateId, 'company-template'); configReferences(aggregate, parsed.config)
      const revisionId = mint('company-template-revision', CompanyTemplateRevisionId)
      workflow = { ...workflow, companyTemplates: { ...workflow.companyTemplates, [root.id]: { ...root, revisionIds: [...root.revisionIds, revisionId], currentRevisionId: revisionId } }, companyTemplateRevisions: { ...workflow.companyTemplateRevisions, [revisionId]: { id: revisionId, templateId: root.id, number: root.revisionIds.length + 1, config: structuredClone(parsed.config) } } }
      value = { templateId: root.id, templateRevisionId: revisionId }; break
    }
    case 'workflow/company-template/confirm': {
      const config = previewCompanyTemplate(aggregate, workflow, parsed.templateRevisionId)
      const agents = new Map<string, AgentId>(); const roomIds: W.WorkflowMutationValueMap['workflow/company-template/confirm']['roomIds'][number][] = []; const membershipIds: W.WorkflowMutationValueMap['workflow/company-template/confirm']['membershipIds'][number][] = []
      for (const colleague of config.colleagues) {
        const revision = own(aggregate.definitionRevisions, colleague.definitionRevisionId, 'definition-revision')
        const created = mutateWorkspace(aggregate, { type: 'agent/create', definitionId: revision.definitionId, name: colleague.name }); aggregate = created.state
        aggregate = mutateWorkspace(aggregate, { type: 'definition/synchronize', definitionId: revision.definitionId, definitionRevisionId: revision.id, agentIds: [created.agentId] }).state
        agents.set(colleague.name, created.agentId)
      }
      for (const group of config.groups) {
        const room = mutateWorkspace(aggregate, { type: 'room/create', kind: 'group', name: group.name }); aggregate = room.state; roomIds.push(room.roomId)
        for (const name of group.memberNames) {
          const before = new Set(Object.keys(aggregate.memberships))
          aggregate = joinRoomWithMemory(aggregate, { type: 'room/join', roomId: room.roomId, agentId: agents.get(name)!, memoryStart: { type: 'new-events' } }).state
          for (const membership of Object.values(aggregate.memberships)) if (!before.has(membership.id)) membershipIds.push(membership.id)
        }
      }
      value = { agentIds: [...agents.values()], roomIds, membershipIds }; break
    }
    case 'workflow/artifact/register': {
      resultEvent(aggregate, parsed.result); const id = mint('artifact', TaskArtifactId)
      const artifact: W.TaskArtifact = { id, result: structuredClone(parsed.result), label: parsed.label, summary: parsed.summary, ...(parsed.reference === undefined ? {} : { reference: structuredClone(parsed.reference) }) }
      workflow = { ...workflow, artifacts: { ...workflow.artifacts, [id]: artifact } }; value = { artifactId: id }; break
    }
    case 'workflow/result/review': {
      resultEvent(aggregate, parsed.result); const id = mint('review', TaskReviewId)
      const draftId = parsed.decision === 'changes-requested' ? draft(sourceBrief(aggregate, workflow, parsed.result.taskId), { type: 'changes-requested', result: structuredClone(parsed.result), reviewId: id }, { handoff: handoffContext(aggregate, workflow, parsed.result, [], parsed.comment) }) : undefined
      const review: W.TaskReview = { id, result: structuredClone(parsed.result), decision: parsed.decision, comment: parsed.comment, ...(draftId === undefined ? {} : { draftId }) }
      workflow = { ...workflow, reviews: { ...workflow.reviews, [id]: review } }; value = { reviewId: id, ...(draftId === undefined ? {} : { draftId }) }; break
    }
    case 'workflow/result/handoff': {
      const handoff = handoffContext(aggregate, workflow, parsed.result, parsed.artifactIds)
      value = { draftId: draft(sourceBrief(aggregate, workflow, parsed.result.taskId), { type: 'handoff', result: structuredClone(parsed.result), artifactIds: [...parsed.artifactIds] }, { handoff, ...(parsed.suggestedAssigneeAgentId === undefined ? {} : { suggestedAssigneeAgentId: parsed.suggestedAssigneeAgentId }) }) }; break
    }
  }
  const factId = mint('workflow-fact', WorkflowFactId)
  const fact = { id: factId, sequence: workflow.nextSequence, type: parsed.type, actor: { type: 'human', id: context.humanId }, occurredAt: context.occurredAt, command: structuredClone(parsed), receipt: structuredClone(value) } as W.WorkflowFact
  workflow = { ...workflow, revision: workflow.revision + 1, nextSequence: workflow.nextSequence + 1, facts: [...workflow.facts, fact] }
  assertWorkflowInvariants(aggregate, workflow)
  return { aggregate, workflow, value: value as W.WorkflowMutationValueMap[K], ...(deliveryTaskId === undefined ? {} : { deliveryTaskId }) }
}

/** Trusted employee proposal creates only a draft and checks current employment. */
export function proposeWorkflowDraft(input: { readonly aggregate: WorkspaceState; readonly workflow: W.WorkflowState }, request: W.WorkflowProposalRequest, context: { readonly agentId: AgentId; readonly occurredAt: string }): W.WorkflowTransition<{ readonly draftId: W.TaskDraftId }> {
  assertWorkflowInvariants(input.aggregate, input.workflow); employed(input.aggregate, context.agentId)
  const parsed = workflowProposalSchema.parse(request)
  if (parsed.suggestedAssigneeAgentId !== undefined) own(input.aggregate.agents, parsed.suggestedAssigneeAgentId, 'agent')
  const id = TaskDraftId(`draft-${input.workflow.nextId}`)
  const draft: W.TaskDraft = { id, revision: 0, status: 'draft', source: { type: 'employee', id: context.agentId }, ...structuredClone(parsed) }
  const fact: W.WorkflowFact = { id: WorkflowFactId(`workflow-fact-${input.workflow.nextId + 1}`), sequence: input.workflow.nextSequence, type: 'workflow/employee/proposed', actor: { type: 'employee', id: context.agentId }, occurredAt: context.occurredAt, command: structuredClone(parsed), receipt: { draftId: id } }
  const workflow: W.WorkflowState = { ...structuredClone(input.workflow), revision: input.workflow.revision + 1, nextId: input.workflow.nextId + 2, nextSequence: input.workflow.nextSequence + 1, drafts: { ...structuredClone(input.workflow.drafts), [id]: draft }, facts: [...structuredClone(input.workflow.facts), fact] }
  assertWorkflowInvariants(input.aggregate, workflow)
  return { aggregate: structuredClone(input.aggregate), workflow, value: { draftId: id } }
}

/** Render only confirmed persisted data, in a stable English section order. */
export function renderWorkflowTaskInstructions(confirmed: W.ConfirmedTaskBrief): string {
  const list = (items: readonly string[]) => items.length === 0 ? '' : `- ${items.join('\n- ')}`
  const brief = confirmed.brief
  let text = `${brief.title}\n\nInstructions\n${brief.instructions}\n\nExpected artifacts\n${list(brief.expectedArtifacts)}\n\nAcceptance criteria\n${list(brief.acceptanceCriteria)}`
  if (confirmed.handoff !== undefined) {
    const context = confirmed.handoff
    text += `\n\nHandoff context\nSource result: ${context.result.taskId} / ${context.result.eventId} / ${context.result.attemptId} (${context.type})\n${context.text}`
    if (context.reviewComment !== undefined) text += `\nReview comment: ${context.reviewComment}`
    for (const artifact of context.artifacts) text += `\n- ${artifact.label}: ${artifact.summary}${artifact.reference === undefined ? '' : `\n  ${artifact.reference.kind}: ${artifact.reference.value}`}`
  }
  return text
}

/** Validate all durable relationships against this organization's own aggregate and facts. */
export function assertWorkflowInvariants(aggregate: WorkspaceState, workflow: W.WorkflowState): void {
  workflowStateSchema.parse(workflow)
  const ids = new Set<string>()
  let maximumId = 0
  const tables = [workflow.drafts, workflow.taskTemplates, workflow.taskTemplateRevisions, workflow.companyTemplates, workflow.companyTemplateRevisions, workflow.artifacts, workflow.reviews] as const
  for (const table of tables) for (const [key, item] of Object.entries(table)) {
    if (key !== item.id || ids.has(item.id)) throw new Error('workflow entity identity is invalid')
    ids.add(item.id); const number = Number(item.id.slice(item.id.lastIndexOf('-') + 1)); if (!Number.isSafeInteger(number) || number < 1) throw new Error('workflow entity counter is invalid'); maximumId = Math.max(maximumId, number)
  }
  function roots<T extends string, R extends string>(table: Readonly<Record<T, { id: T; revisionIds: readonly R[]; currentRevisionId: R }>>, revisions: Readonly<Record<R, { id: R; templateId: T; number: number }>>): void {
    for (const root of Object.values<{ id: T; revisionIds: readonly R[]; currentRevisionId: R }>(table)) {
      unique(root.revisionIds)
      if (root.currentRevisionId !== root.revisionIds.at(-1)) throw new Error('workflow template current revision is invalid')
      root.revisionIds.forEach((id, index) => { const revision = own(revisions, id, 'template-revision'); if (revision.templateId !== root.id || revision.number !== index + 1) throw new Error('workflow template revision ownership is invalid') })
    }
    for (const revision of Object.values<{ id: R; templateId: T; number: number }>(revisions)) if (!own(table, revision.templateId, 'template').revisionIds.includes(revision.id)) throw new Error('workflow template revision is unlisted')
  }
  roots(workflow.taskTemplates, workflow.taskTemplateRevisions); roots(workflow.companyTemplates, workflow.companyTemplateRevisions)
  for (const revision of Object.values(workflow.companyTemplateRevisions)) configReferences(aggregate, revision.config)
  for (const artifact of Object.values(workflow.artifacts)) resultEvent(aggregate, artifact.result)
  for (const review of Object.values(workflow.reviews)) {
    resultEvent(aggregate, review.result)
    if (review.decision === 'changes-requested') {
      if (review.draftId === undefined) throw new Error('changes-requested review has no draft')
      const source = own(workflow.drafts, review.draftId, 'draft').source
      if (source.type !== 'changes-requested' || source.reviewId !== review.id) throw new Error('review draft ownership is invalid')
    } else if (review.draftId !== undefined) throw new Error('accepted review cannot create a draft')
  }
  for (const draft of Object.values(workflow.drafts)) {
    if (draft.suggestedAssigneeAgentId !== undefined) own(aggregate.agents, draft.suggestedAssigneeAgentId, 'agent')
    if (draft.templateRevisionId !== undefined) own(workflow.taskTemplateRevisions, draft.templateRevisionId, 'task-template-revision')
    switch (draft.source.type) {
      case 'human': break
      case 'employee': own(aggregate.agents, draft.source.id, 'agent'); break
      case 'handoff': {
        if (draft.handoff === undefined) throw new Error('handoff draft has no context')
        requireEqual(draft.handoff, handoffContext(aggregate, workflow, draft.source.result, draft.source.artifactIds)); break
      }
      case 'changes-requested': {
        const review = own(workflow.reviews, draft.source.reviewId, 'review')
        if (review.decision !== 'changes-requested' || review.draftId !== draft.id) throw new Error('draft review ownership is invalid')
        requireEqual(draft.source.result, review.result); requireEqual(draft.handoff, handoffContext(aggregate, workflow, review.result, [], review.comment)); break
      }
    }
    if ((draft.source.type === 'human' || draft.source.type === 'employee') && draft.handoff !== undefined) throw new Error('ordinary draft cannot contain handoff context')
    if (draft.status === 'confirmed') {
      if (draft.taskId === undefined) throw new Error('confirmed draft has no task')
      const confirmed = own(workflow.taskBriefs, draft.taskId, 'task-brief')
      if (confirmed.draftId !== draft.id) throw new Error('confirmed draft ownership is invalid')
    } else if (draft.taskId !== undefined) throw new Error('unconfirmed draft cannot contain a task')
  }
  for (const [id, confirmed] of Object.entries(workflow.taskBriefs)) {
    const task = own(aggregate.tasks, id, 'task'); const draft = own(workflow.drafts, confirmed.draftId, 'draft')
    if (id !== confirmed.taskId || draft.taskId !== id || draft.status !== 'confirmed' || task.rootTaskId !== task.id || task.title !== confirmed.brief.title) throw new Error('confirmed task brief ownership is invalid')
    requireEqual(confirmed.brief, draft.brief); requireEqual(confirmed.handoff, draft.handoff); requireEqual(confirmed.templateRevisionId, draft.templateRevisionId)
  }
  if (workflow.revision !== workflow.facts.length || workflow.nextSequence !== workflow.facts.length + 1) throw new Error('workflow fact counters are invalid')
  const draftsSeen = new Map<W.TaskDraftId, { brief: W.TaskBrief; revision: number; status: W.TaskDraft['status'] }>()
  const templateRevisionsSeen = new Set<string>(); const artifactsSeen = new Set<string>(); const reviewsSeen = new Set<string>()
  const configuredAgents = new Set<AgentId>(); const configuredRooms = new Set<string>(); const configuredMemberships = new Set<string>()
  function companyReceipt(config: W.CompanyTemplateConfig, receipt: W.WorkflowMutationValueMap['workflow/company-template/confirm']): void {
    if (receipt.agentIds.length !== config.colleagues.length || receipt.roomIds.length !== config.groups.length || receipt.membershipIds.length !== config.groups.reduce((count, group) => count + group.memberNames.length, 0)) throw new Error('company configuration receipt does not match its config')
    let eventIndex = aggregate.events.findIndex(event => event.type === 'agent/created' && event.subjectId === receipt.agentIds[0])
    if (eventIndex < 0) throw new Error('company configuration has no creation events')
    const agentsByName = new Map<string, AgentId>()
    for (const [index, colleague] of config.colleagues.entries()) {
      const id = receipt.agentIds[index]!
      const agent = own(aggregate.agents, id, 'agent'); const revision = own(aggregate.definitionRevisions, colleague.definitionRevisionId, 'definition-revision')
      if (configuredAgents.has(id) || agent.name !== colleague.name || agent.definitionId !== revision.definitionId) throw new Error('company colleague differs from its config')
      configuredAgents.add(id); agentsByName.set(colleague.name, id)
      const created = aggregate.events[eventIndex++]; const synchronized = aggregate.events[eventIndex++]
      if (created?.type !== 'agent/created' || created.subjectId !== id || synchronized?.type !== 'agent/definition-revision-assigned' || synchronized.subjectId !== id || synchronized.definitionRevisionId !== revision.id) throw new Error('company colleague creation or pinned revision event is invalid')
    }
    let membershipIndex = 0
    for (const [index, group] of config.groups.entries()) {
      const id = receipt.roomIds[index]!
      const room = own(aggregate.rooms, id, 'room'); const created = aggregate.events[eventIndex++]
      if (configuredRooms.has(id) || room.kind !== 'group' || room.name !== group.name || created?.type !== 'room/created' || created.subjectId !== id) throw new Error('company group creation differs from its config')
      configuredRooms.add(id)
      for (const name of group.memberNames) {
        const membershipId = receipt.membershipIds[membershipIndex++]!
        const membership = own(aggregate.memberships, membershipId, 'membership'); const joined = aggregate.events[eventIndex++]
        if (configuredMemberships.has(membershipId) || membership.agentId !== agentsByName.get(name) || membership.roomId !== id || membership.memoryStart.type !== 'new-events' || joined?.type !== 'room/member-joined' || joined.subjectId !== membershipId || joined.id !== membership.joinedEventId) throw new Error('company membership creation differs from its config')
        configuredMemberships.add(membershipId)
      }
    }
  }
  function createdDraft(id: W.TaskDraftId, brief: W.TaskBrief, source: W.TaskDraftSource, templateRevisionId?: W.TaskTemplateRevisionId): void {
    if (draftsSeen.has(id)) throw new Error('draft created more than once')
    const item = own(workflow.drafts, id, 'draft'); requireEqual(item.source, source); requireEqual(item.templateRevisionId, templateRevisionId)
    draftsSeen.set(id, { brief, revision: 0, status: 'draft' })
  }
  function receiptReferences(receipt: W.WorkflowReceipt): void {
    const value = receipt.value
    if ('draftId' in value && value.draftId !== undefined) own(workflow.drafts, value.draftId, 'draft')
    if ('taskId' in value) {
      const assignment = own(aggregate.taskAssignments, value.taskAssignmentId, 'task-assignment')
      if (assignment.taskId !== value.taskId || assignment.rootTaskId !== value.taskId || assignment.grantId !== undefined || own(workflow.drafts, value.draftId, 'draft').taskId !== value.taskId) throw new Error('workflow confirmation assignment is invalid')
    }
    if ('templateId' in value) {
      if (receipt.type.startsWith('workflow/company-template/')) {
        const revision = own(workflow.companyTemplateRevisions, value.templateRevisionId, 'company-template-revision'); if (revision.templateId !== value.templateId) throw new Error('company template receipt is invalid')
      } else {
        const revision = own(workflow.taskTemplateRevisions, value.templateRevisionId, 'task-template-revision'); if (revision.templateId !== value.templateId) throw new Error('task template receipt is invalid')
      }
    }
    if ('artifactId' in value) own(workflow.artifacts, value.artifactId, 'artifact')
    if ('reviewId' in value) own(workflow.reviews, value.reviewId, 'review')
    if ('agentIds' in value) { unique(value.agentIds); unique(value.roomIds); unique(value.membershipIds); for (const id of value.agentIds) own(aggregate.agents, id, 'agent'); for (const id of value.roomIds) own(aggregate.rooms, id, 'room'); for (const id of value.membershipIds) { const membership = own(aggregate.memberships, id, 'membership'); if (!value.agentIds.includes(membership.agentId) || !value.roomIds.includes(membership.roomId) || membership.memoryStart.type !== 'new-events') throw new Error('company configuration receipt is invalid') } }
  }
  workflow.facts.forEach((fact, index) => {
    if (fact.sequence !== index + 1 || ids.has(fact.id)) throw new Error('workflow fact order is invalid')
    ids.add(fact.id); const suffix = Number(fact.id.slice(fact.id.lastIndexOf('-') + 1)); if (!Number.isSafeInteger(suffix) || suffix < 1) throw new Error('workflow fact identity is invalid'); maximumId = Math.max(maximumId, suffix)
    if (fact.type === 'workflow/employee/proposed') { own(aggregate.agents, fact.actor.id, 'agent'); createdDraft(fact.receipt.draftId, fact.command.brief, { type: 'employee', id: fact.actor.id }); return }
    receiptReferences({ type: fact.type, value: fact.receipt } as W.WorkflowReceipt)
    const command = fact.command
    if ('suggestedAssigneeAgentId' in command && command.suggestedAssigneeAgentId !== undefined) own(aggregate.agents, command.suggestedAssigneeAgentId, 'agent')
    if ('result' in command) resultEvent(aggregate, command.result)
    switch (fact.type) {
      case 'workflow/draft/create': createdDraft(fact.receipt.draftId, fact.command.brief, { type: 'human', id: fact.actor.id }); break
      case 'workflow/task-template/apply': { const revision = own(workflow.taskTemplateRevisions, fact.command.templateRevisionId, 'task-template-revision'); createdDraft(fact.receipt.draftId, revision.brief, { type: 'human', id: fact.actor.id }, revision.id); break }
      case 'workflow/draft/edit': case 'workflow/draft/discard': case 'workflow/draft/confirm': {
        const previous = draftsSeen.get(fact.command.draftId)
        if (previous === undefined || previous.status !== 'draft' || previous.revision !== fact.command.expectedDraftRevision || fact.receipt.draftId !== fact.command.draftId) throw new Error('workflow draft fact order is invalid')
        if (fact.type === 'workflow/draft/edit') draftsSeen.set(fact.command.draftId, { brief: fact.command.brief, revision: previous.revision + 1, status: 'draft' })
        else {
          draftsSeen.set(fact.command.draftId, { ...previous, status: fact.type === 'workflow/draft/confirm' ? 'confirmed' : 'discarded' })
          if (fact.type === 'workflow/draft/confirm') { const assignment = own(aggregate.taskAssignments, fact.receipt.taskAssignmentId, 'task-assignment'); if (assignment.assigneeAgentId !== fact.command.assigneeAgentId) throw new Error('confirmation assignee differs from its fact'); requireEqual(own(workflow.taskBriefs, fact.receipt.taskId, 'task-brief').brief, previous.brief) }
        }
        break
      }
      case 'workflow/task-template/create': case 'workflow/task-template/revise': { const revision = own(workflow.taskTemplateRevisions, fact.receipt.templateRevisionId, 'task-template-revision'); requireEqual(revision.brief, fact.command.brief); templateRevisionsSeen.add(revision.id); if (fact.type === 'workflow/task-template/create') requireEqual(own(workflow.taskTemplates, fact.receipt.templateId, 'template').name, fact.command.name); else if (fact.command.templateId !== fact.receipt.templateId) throw new Error('template revision fact is invalid'); break }
      case 'workflow/company-template/create': case 'workflow/company-template/revise': { const revision = own(workflow.companyTemplateRevisions, fact.receipt.templateRevisionId, 'company-template-revision'); requireEqual(revision.config, fact.command.config); templateRevisionsSeen.add(revision.id); if (fact.type === 'workflow/company-template/create') requireEqual(own(workflow.companyTemplates, fact.receipt.templateId, 'template').name, fact.command.name); else if (fact.command.templateId !== fact.receipt.templateId) throw new Error('company template revision fact is invalid'); break }
      case 'workflow/company-template/confirm': companyReceipt(own(workflow.companyTemplateRevisions, fact.command.templateRevisionId, 'company-template-revision').config, fact.receipt); break
      case 'workflow/artifact/register': { const { id: _id, ...artifact } = own(workflow.artifacts, fact.receipt.artifactId, 'artifact'); const { type: _type, ...recorded } = fact.command; requireEqual(artifact, recorded); artifactsSeen.add(fact.receipt.artifactId); break }
      case 'workflow/result/review': {
        const review = own(workflow.reviews, fact.receipt.reviewId, 'review'); requireEqual(review.result, fact.command.result); requireEqual(review.decision, fact.command.decision); requireEqual(review.comment, fact.command.comment); requireEqual(review.draftId, fact.receipt.draftId); reviewsSeen.add(review.id)
        if (review.draftId !== undefined) createdDraft(review.draftId, sourceBrief(aggregate, workflow, review.result.taskId), { type: 'changes-requested', result: review.result, reviewId: review.id }); break
      }
      case 'workflow/result/handoff': createdDraft(fact.receipt.draftId, sourceBrief(aggregate, workflow, fact.command.result.taskId), { type: 'handoff', result: fact.command.result, artifactIds: fact.command.artifactIds }); break
    }
  })
  for (const draft of Object.values(workflow.drafts)) { const expected = draftsSeen.get(draft.id); if (expected === undefined) throw new Error('draft has no creation fact'); requireEqual(draft.brief, expected.brief); if (draft.status !== expected.status || draft.revision !== expected.revision) throw new Error('draft differs from its facts') }
  if (templateRevisionsSeen.size !== Object.keys(workflow.taskTemplateRevisions).length + Object.keys(workflow.companyTemplateRevisions).length || artifactsSeen.size !== Object.keys(workflow.artifacts).length || reviewsSeen.size !== Object.keys(workflow.reviews).length) throw new Error('workflow immutable entity has no fact')
  if (workflow.nextId <= maximumId) throw new Error('workflow nextId is invalid')
  for (const [key, operation] of Object.entries(workflow.operations)) {
    if (key !== operation.id || operation.aggregateRevision > aggregate.revision || operation.workflowRevision > workflow.revision) throw new Error('workflow operation counters are invalid')
    const fact = workflow.facts[operation.workflowRevision - 1]
    if (fact === undefined || fact.type === 'workflow/employee/proposed' || fact.type !== operation.receipt.type) throw new Error('workflow operation has no matching fact')
    requireEqual(operation.receipt.value, fact.receipt); receiptReferences(operation.receipt)
  }
}
