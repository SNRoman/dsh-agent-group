/** JSON workflow data uses string identities. Shared value types have no Host runtime dependency. */
import type { TaskBrief, ArtifactReference, WorkflowExpectedRevisions, WorkflowBusinessErrorDetailsMap } from '@dsh-agent-group/host/workflow-contract'
import type { WorkspaceRpcError } from './contracts.ts'
export type { TaskBrief, ArtifactReference, WorkflowExpectedRevisions }
export type TaskDraftId = string
export type TaskTemplateId = string
export type TaskTemplateRevisionId = string
export type CompanyTemplateId = string
export type CompanyTemplateRevisionId = string
export type TaskArtifactId = string
export type TaskReviewId = string
export type WorkflowFactId = string
export type WorkflowOperationId = string
export interface TaskResultReference { readonly taskId: string; readonly eventId: string; readonly attemptId: string }
export interface ArtifactSnapshot { readonly id: string; readonly label: string; readonly summary: string; readonly reference?: ArtifactReference | undefined }
export interface HandoffContext { readonly result: TaskResultReference; readonly type: 'task/result' | 'task/result-after-cancel'; readonly text: string; readonly artifacts: readonly ArtifactSnapshot[]; readonly reviewComment?: string | undefined }
export type TaskDraftSource = { readonly type: 'human' | 'employee'; readonly id: string } | { readonly type: 'handoff'; readonly result: TaskResultReference; readonly artifactIds: readonly string[] } | { readonly type: 'changes-requested'; readonly result: TaskResultReference; readonly reviewId: string }
export interface WorkflowProposalRequest { readonly brief: TaskBrief; readonly suggestedAssigneeAgentId?: string | undefined }
export interface TaskDraft extends WorkflowProposalRequest { readonly id: string; readonly revision: number; readonly status: 'draft' | 'confirmed' | 'discarded'; readonly source: TaskDraftSource; readonly templateRevisionId?: string | undefined; readonly handoff?: HandoffContext | undefined; readonly taskId?: string | undefined }
export interface TaskTemplate { readonly id: string; readonly name: string; readonly revisionIds: readonly string[]; readonly currentRevisionId: string }
export interface TaskTemplateRevision { readonly id: string; readonly templateId: string; readonly number: number; readonly brief: TaskBrief }
export interface CompanyTemplateConfig { readonly colleagues: readonly { readonly name: string; readonly definitionRevisionId: string }[]; readonly groups: readonly { readonly name: string; readonly memberNames: readonly string[] }[] }
export type CompanyTemplate = TaskTemplate
export interface CompanyTemplateRevision { readonly id: string; readonly templateId: string; readonly number: number; readonly config: CompanyTemplateConfig }
export interface ConfirmedTaskBrief { readonly taskId: string; readonly draftId: string; readonly brief: TaskBrief; readonly templateRevisionId?: string | undefined; readonly handoff?: HandoffContext | undefined }
export interface TaskArtifact extends ArtifactSnapshot { readonly result: TaskResultReference }
export interface TaskReview { readonly id: string; readonly result: TaskResultReference; readonly decision: 'accepted' | 'changes-requested'; readonly comment: string; readonly draftId?: string | undefined }
export interface WorkflowCommandMap {
  'workflow/draft/create': WorkflowProposalRequest
  'workflow/draft/edit': WorkflowProposalRequest & { readonly draftId: string; readonly expectedDraftRevision: number }
  'workflow/draft/discard': { readonly draftId: string; readonly expectedDraftRevision: number }
  'workflow/draft/confirm': { readonly draftId: string; readonly expectedDraftRevision: number; readonly assigneeAgentId: string }
  'workflow/task-template/create': { readonly name: string; readonly brief: TaskBrief }
  'workflow/task-template/revise': { readonly templateId: string; readonly brief: TaskBrief }
  'workflow/task-template/apply': { readonly templateRevisionId: string; readonly suggestedAssigneeAgentId?: string | undefined }
  'workflow/company-template/create': { readonly name: string; readonly config: CompanyTemplateConfig }
  'workflow/company-template/revise': { readonly templateId: string; readonly config: CompanyTemplateConfig }
  'workflow/company-template/confirm': { readonly templateRevisionId: string; readonly confirmed: true; readonly memoryStart: { readonly type: 'new-events' } }
  'workflow/artifact/register': { readonly result: TaskResultReference; readonly label: string; readonly summary: string; readonly reference?: ArtifactReference | undefined }
  'workflow/result/review': { readonly result: TaskResultReference; readonly decision: 'accepted' | 'changes-requested'; readonly comment: string }
  'workflow/result/handoff': { readonly result: TaskResultReference; readonly artifactIds: readonly string[]; readonly suggestedAssigneeAgentId?: string | undefined }
}
export interface WorkflowMutationValueMap {
  'workflow/draft/create': { readonly draftId: string }
  'workflow/draft/edit': { readonly draftId: string }
  'workflow/draft/discard': { readonly draftId: string }
  'workflow/draft/confirm': { readonly draftId: string; readonly taskId: string; readonly taskAssignmentId: string }
  'workflow/task-template/create': { readonly templateId: string; readonly templateRevisionId: string }
  'workflow/task-template/revise': { readonly templateId: string; readonly templateRevisionId: string }
  'workflow/task-template/apply': { readonly draftId: string }
  'workflow/company-template/create': { readonly templateId: string; readonly templateRevisionId: string }
  'workflow/company-template/revise': { readonly templateId: string; readonly templateRevisionId: string }
  'workflow/company-template/confirm': { readonly agentIds: readonly string[]; readonly roomIds: readonly string[]; readonly membershipIds: readonly string[] }
  'workflow/artifact/register': { readonly artifactId: string }
  'workflow/result/review': { readonly reviewId: string; readonly draftId?: string | undefined }
  'workflow/result/handoff': { readonly draftId: string }
}
export type WorkflowEndpoint = keyof WorkflowCommandMap
export type WorkflowCommand<K extends WorkflowEndpoint = WorkflowEndpoint> = { readonly [P in K]: WorkflowCommandMap[P] & { readonly type: P } }[K]
export type WorkflowReceipt<K extends WorkflowEndpoint = WorkflowEndpoint> = { readonly [P in K]: { readonly type: P; readonly value: WorkflowMutationValueMap[P] } }[K]
export interface WorkflowOperation { readonly id: string; readonly requestDigest: string; readonly receipt: WorkflowReceipt; readonly aggregateRevision: number; readonly workflowRevision: number }
export type WorkflowFact = { readonly [K in WorkflowEndpoint]: { readonly id: string; readonly sequence: number; readonly type: K; readonly actor: { readonly type: 'human'; readonly id: string }; readonly occurredAt: string; readonly command: WorkflowCommand<K>; readonly receipt: WorkflowMutationValueMap[K] } }[WorkflowEndpoint] | { readonly id: string; readonly sequence: number; readonly type: 'workflow/employee/proposed'; readonly actor: { readonly type: 'employee'; readonly id: string }; readonly occurredAt: string; readonly command: WorkflowProposalRequest; readonly receipt: { readonly draftId: string } }
export interface WorkflowState {
  readonly revision: number; readonly nextId: number; readonly nextSequence: number
  readonly drafts: Readonly<Record<string, TaskDraft>>
  readonly taskTemplates: Readonly<Record<string, TaskTemplate>>
  readonly taskTemplateRevisions: Readonly<Record<string, TaskTemplateRevision>>
  readonly companyTemplates: Readonly<Record<string, CompanyTemplate>>
  readonly companyTemplateRevisions: Readonly<Record<string, CompanyTemplateRevision>>
  readonly taskBriefs: Readonly<Record<string, ConfirmedTaskBrief>>
  readonly artifacts: Readonly<Record<string, TaskArtifact>>
  readonly reviews: Readonly<Record<string, TaskReview>>
  readonly operations: Readonly<Record<string, WorkflowOperation>>
  readonly facts: readonly WorkflowFact[]
}
export interface WorkflowSnapshot { readonly workspaceId: string; readonly aggregateRevision: number; readonly workflow: WorkflowState }
export interface WorkflowMutationResult<Value> { readonly workspaceId: string; readonly aggregateRevision: number; readonly workflowRevision: number; readonly value: Value; readonly replayed: boolean }
export interface CompanyTemplatePreview { readonly workspaceId: string; readonly aggregateRevision: number; readonly workflowRevision: number; readonly templateRevisionId: string; readonly config: CompanyTemplateConfig }
export type WorkflowRpcError = WorkspaceRpcError | { [K in keyof WorkflowBusinessErrorDetailsMap]: { readonly kind: 'business'; readonly code: K; readonly message: string; readonly details: WorkflowBusinessErrorDetailsMap[K] } }[keyof WorkflowBusinessErrorDetailsMap]
