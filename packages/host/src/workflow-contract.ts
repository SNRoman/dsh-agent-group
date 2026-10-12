/** Durable workflow data and endpoint-specific request and receipt types. No runtime dependencies. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { AgentId, DefinitionRevisionId, HumanId, MembershipId, RoomId, TaskAssignmentId, TaskDeliveryAttemptId, TaskId, WorkspaceEventId, WorkspaceId } from './ids.ts'
import type { WorkspaceState } from './types.ts'

export type TaskDraftId = Branded<'TaskDraftId'>
export type TaskTemplateId = Branded<'TaskTemplateId'>
export type TaskTemplateRevisionId = Branded<'TaskTemplateRevisionId'>
export type CompanyTemplateId = Branded<'CompanyTemplateId'>
export type CompanyTemplateRevisionId = Branded<'CompanyTemplateRevisionId'>
export type TaskArtifactId = Branded<'TaskArtifactId'>
export type TaskReviewId = Branded<'TaskReviewId'>
export type WorkflowFactId = Branded<'WorkflowFactId'>
export type WorkflowOperationId = Branded<'WorkflowOperationId'>

/** Full instructions copied when a human confirms a draft. */
export interface TaskBrief { readonly title: string; readonly instructions: string; readonly expectedArtifacts: readonly string[]; readonly acceptanceCriteria: readonly string[] }
/** Inert reference; a URL must use HTTP(S). */
export type ArtifactReference = { readonly kind: 'path'; readonly value: string } | { readonly kind: 'url'; readonly value: string }
/** Exact result identity, including cancelled late results. */
export interface TaskResultReference { readonly taskId: TaskId; readonly eventId: WorkspaceEventId; readonly attemptId: TaskDeliveryAttemptId }
export interface WorkflowExpectedRevisions { readonly expectedAggregateRevision: number; readonly expectedWorkflowRevision: number }
export interface WorkflowSnapshot { readonly workspaceId: WorkspaceId; readonly aggregateRevision: number; readonly workflow: WorkflowState }
export interface WorkflowMutationResult<Value> { readonly workspaceId: WorkspaceId; readonly aggregateRevision: number; readonly workflowRevision: number; readonly value: Value; readonly replayed: boolean }
export interface WorkflowTransition<Value> { readonly aggregate: WorkspaceState; readonly workflow: WorkflowState; readonly value: Value; readonly deliveryTaskId?: TaskId | undefined }
export interface WorkflowProposalRequest { readonly brief: TaskBrief; readonly suggestedAssigneeAgentId?: AgentId | undefined }
export interface WorkflowProposalResult { readonly draftId: TaskDraftId; readonly summary: string; readonly status: 'awaiting-human-confirmation' }

export interface ArtifactSnapshot { readonly id: TaskArtifactId; readonly label: string; readonly summary: string; readonly reference?: ArtifactReference | undefined }
export interface HandoffContext { readonly result: TaskResultReference; readonly type: 'task/result' | 'task/result-after-cancel'; readonly text: string; readonly artifacts: readonly ArtifactSnapshot[]; readonly reviewComment?: string | undefined }
export type TaskDraftSource = { readonly type: 'human'; readonly id: HumanId } | { readonly type: 'employee'; readonly id: AgentId } | { readonly type: 'handoff'; readonly result: TaskResultReference; readonly artifactIds: readonly TaskArtifactId[] } | { readonly type: 'changes-requested'; readonly result: TaskResultReference; readonly reviewId: TaskReviewId }
export interface TaskDraft { readonly id: TaskDraftId; readonly revision: number; readonly status: 'draft' | 'confirmed' | 'discarded'; readonly source: TaskDraftSource; readonly brief: TaskBrief; readonly suggestedAssigneeAgentId?: AgentId | undefined; readonly templateRevisionId?: TaskTemplateRevisionId | undefined; readonly handoff?: HandoffContext | undefined; readonly taskId?: TaskId | undefined }
export interface TaskTemplate { readonly id: TaskTemplateId; readonly name: string; readonly revisionIds: readonly TaskTemplateRevisionId[]; readonly currentRevisionId: TaskTemplateRevisionId }
export interface TaskTemplateRevision { readonly id: TaskTemplateRevisionId; readonly templateId: TaskTemplateId; readonly number: number; readonly brief: TaskBrief }
export interface CompanyTemplateConfig { readonly colleagues: readonly { readonly name: string; readonly definitionRevisionId: DefinitionRevisionId }[]; readonly groups: readonly { readonly name: string; readonly memberNames: readonly string[] }[] }
export interface CompanyTemplate { readonly id: CompanyTemplateId; readonly name: string; readonly revisionIds: readonly CompanyTemplateRevisionId[]; readonly currentRevisionId: CompanyTemplateRevisionId }
export interface CompanyTemplateRevision { readonly id: CompanyTemplateRevisionId; readonly templateId: CompanyTemplateId; readonly number: number; readonly config: CompanyTemplateConfig }
export interface CompanyTemplatePreview { readonly workspaceId: WorkspaceId; readonly aggregateRevision: number; readonly workflowRevision: number; readonly templateRevisionId: CompanyTemplateRevisionId; readonly config: CompanyTemplateConfig }
export interface ConfirmedTaskBrief { readonly taskId: TaskId; readonly draftId: TaskDraftId; readonly brief: TaskBrief; readonly templateRevisionId?: TaskTemplateRevisionId | undefined; readonly handoff?: HandoffContext | undefined }
export interface TaskArtifact extends ArtifactSnapshot { readonly result: TaskResultReference }
export interface TaskReview { readonly id: TaskReviewId; readonly result: TaskResultReference; readonly decision: 'accepted' | 'changes-requested'; readonly comment: string; readonly draftId?: TaskDraftId | undefined }

export interface WorkflowCommandMap {
  'workflow/draft/create': WorkflowProposalRequest
  'workflow/draft/edit': WorkflowProposalRequest & { readonly draftId: TaskDraftId; readonly expectedDraftRevision: number }
  'workflow/draft/discard': { readonly draftId: TaskDraftId; readonly expectedDraftRevision: number }
  'workflow/draft/confirm': { readonly draftId: TaskDraftId; readonly expectedDraftRevision: number; readonly assigneeAgentId: AgentId }
  'workflow/task-template/create': { readonly name: string; readonly brief: TaskBrief }
  'workflow/task-template/revise': { readonly templateId: TaskTemplateId; readonly brief: TaskBrief }
  'workflow/task-template/apply': { readonly templateRevisionId: TaskTemplateRevisionId; readonly suggestedAssigneeAgentId?: AgentId | undefined }
  'workflow/company-template/create': { readonly name: string; readonly config: CompanyTemplateConfig }
  'workflow/company-template/revise': { readonly templateId: CompanyTemplateId; readonly config: CompanyTemplateConfig }
  'workflow/company-template/confirm': { readonly templateRevisionId: CompanyTemplateRevisionId; readonly confirmed: true; readonly memoryStart: { readonly type: 'new-events' } }
  'workflow/artifact/register': { readonly result: TaskResultReference; readonly label: string; readonly summary: string; readonly reference?: ArtifactReference | undefined }
  'workflow/result/review': { readonly result: TaskResultReference; readonly decision: 'accepted' | 'changes-requested'; readonly comment: string }
  'workflow/result/handoff': { readonly result: TaskResultReference; readonly artifactIds: readonly TaskArtifactId[]; readonly suggestedAssigneeAgentId?: AgentId | undefined }
}
export interface WorkflowMutationValueMap {
  'workflow/draft/create': { readonly draftId: TaskDraftId }
  'workflow/draft/edit': { readonly draftId: TaskDraftId }
  'workflow/draft/discard': { readonly draftId: TaskDraftId }
  'workflow/draft/confirm': { readonly draftId: TaskDraftId; readonly taskId: TaskId; readonly taskAssignmentId: TaskAssignmentId }
  'workflow/task-template/create': { readonly templateId: TaskTemplateId; readonly templateRevisionId: TaskTemplateRevisionId }
  'workflow/task-template/revise': { readonly templateId: TaskTemplateId; readonly templateRevisionId: TaskTemplateRevisionId }
  'workflow/task-template/apply': { readonly draftId: TaskDraftId }
  'workflow/company-template/create': { readonly templateId: CompanyTemplateId; readonly templateRevisionId: CompanyTemplateRevisionId }
  'workflow/company-template/revise': { readonly templateId: CompanyTemplateId; readonly templateRevisionId: CompanyTemplateRevisionId }
  'workflow/company-template/confirm': { readonly agentIds: readonly AgentId[]; readonly roomIds: readonly RoomId[]; readonly membershipIds: readonly MembershipId[] }
  'workflow/artifact/register': { readonly artifactId: TaskArtifactId }
  'workflow/result/review': { readonly reviewId: TaskReviewId; readonly draftId?: TaskDraftId | undefined }
  'workflow/result/handoff': { readonly draftId: TaskDraftId }
}
export type WorkflowEndpoint = keyof WorkflowCommandMap
export type WorkflowCommand<K extends WorkflowEndpoint = WorkflowEndpoint> = { readonly [P in K]: WorkflowCommandMap[P] & { readonly type: P } }[K]
export type WorkflowReceipt<K extends WorkflowEndpoint = WorkflowEndpoint> = { readonly [P in K]: { readonly type: P; readonly value: WorkflowMutationValueMap[P] } }[K]
export interface WorkflowOperation { readonly id: WorkflowOperationId; readonly requestDigest: string; readonly receipt: WorkflowReceipt; readonly aggregateRevision: number; readonly workflowRevision: number }
export type WorkflowFact = { readonly [K in WorkflowEndpoint]: { readonly id: WorkflowFactId; readonly sequence: number; readonly type: K; readonly actor: { readonly type: 'human'; readonly id: HumanId }; readonly occurredAt: string; readonly command: WorkflowCommand<K>; readonly receipt: WorkflowMutationValueMap[K] } }[WorkflowEndpoint] | { readonly id: WorkflowFactId; readonly sequence: number; readonly type: 'workflow/employee/proposed'; readonly actor: { readonly type: 'employee'; readonly id: AgentId }; readonly occurredAt: string; readonly command: WorkflowProposalRequest; readonly receipt: { readonly draftId: TaskDraftId } }
export interface WorkflowState {
  readonly revision: number; readonly nextId: number; readonly nextSequence: number
  readonly drafts: Readonly<Record<TaskDraftId, TaskDraft>>
  readonly taskTemplates: Readonly<Record<TaskTemplateId, TaskTemplate>>
  readonly taskTemplateRevisions: Readonly<Record<TaskTemplateRevisionId, TaskTemplateRevision>>
  readonly companyTemplates: Readonly<Record<CompanyTemplateId, CompanyTemplate>>
  readonly companyTemplateRevisions: Readonly<Record<CompanyTemplateRevisionId, CompanyTemplateRevision>>
  readonly taskBriefs: Readonly<Record<TaskId, ConfirmedTaskBrief>>
  readonly artifacts: Readonly<Record<TaskArtifactId, TaskArtifact>>
  readonly reviews: Readonly<Record<TaskReviewId, TaskReview>>
  readonly operations: Readonly<Record<WorkflowOperationId, WorkflowOperation>>
  readonly facts: readonly WorkflowFact[]
}

/** Safe identifiers/counters exposed by the workflow RPC error envelope. */
export interface WorkflowBusinessErrorDetailsMap {
  'stale-workflow-revision': { readonly expectedWorkflowRevision: number; readonly actualWorkflowRevision: number }
  'stale-draft-revision': { readonly draftId: string; readonly expectedDraftRevision: number; readonly actualDraftRevision: number }
  'workflow-operation-reused': { readonly operationId: string }
  'workflow-reference-invalid': { readonly entityKind: string; readonly entityId: string }
  'draft-not-editable': { readonly draftId: string; readonly status: 'confirmed' | 'discarded' }
  'workflow-read-only': { readonly workspaceId: string }
}
