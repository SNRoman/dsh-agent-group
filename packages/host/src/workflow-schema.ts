/** Strict durable workflow readers and endpoint payload parsers. */
import { z } from 'zod'
import type * as W from './workflow-contract.ts'
import { AgentId, DefinitionRevisionId, HumanId, TaskAssignmentId, TaskDeliveryAttemptId, TaskId, WorkspaceEventId, RoomId, MembershipId } from './ids.ts'

const id = z.string().min(1).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value))
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positive = count.min(1)
const text = z.string().trim().min(1)
const draftId = id.transform(value => value as W.TaskDraftId)
const templateId = id.transform(value => value as W.TaskTemplateId)
const templateRevisionId = id.transform(value => value as W.TaskTemplateRevisionId)
const companyId = id.transform(value => value as W.CompanyTemplateId)
const companyRevisionId = id.transform(value => value as W.CompanyTemplateRevisionId)
const artifactId = id.transform(value => value as W.TaskArtifactId)
const reviewId = id.transform(value => value as W.TaskReviewId)
const agentId = id.transform(AgentId)
const taskId = id.transform(TaskId)
const timestamp = z.string().refine(value => { const date = new Date(value); return !Number.isNaN(date.valueOf()) && date.toISOString() === value })

export const taskBriefSchema = z.object({ title: text, instructions: text, expectedArtifacts: z.array(text), acceptanceCriteria: z.array(text) }).strict() satisfies z.ZodType<W.TaskBrief>
export const artifactReferenceSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('path'), value: text }).strict(), z.object({ kind: z.literal('url'), value: text.refine(value => { try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch (_error) { return false } }) }).strict()]) satisfies z.ZodType<W.ArtifactReference>
export const taskResultReferenceSchema = z.object({ taskId, eventId: id.transform(WorkspaceEventId), attemptId: id.transform(TaskDeliveryAttemptId) }).strict() satisfies z.ZodType<W.TaskResultReference>
export const companyTemplateConfigSchema = z.object({ colleagues: z.array(z.object({ name: text, definitionRevisionId: id.transform(DefinitionRevisionId) }).strict()).min(1), groups: z.array(z.object({ name: text, memberNames: z.array(text) }).strict()) }).strict() satisfies z.ZodType<W.CompanyTemplateConfig>
export const workflowProposalSchema = z.object({ brief: taskBriefSchema, suggestedAssigneeAgentId: agentId.optional() }).strict() satisfies z.ZodType<W.WorkflowProposalRequest>

/** Parsers reject caller actor, source, organization and time fields. */
export const workflowCommandPayloadSchemas = {
  'workflow/draft/create': workflowProposalSchema,
  'workflow/draft/edit': workflowProposalSchema.extend({ draftId, expectedDraftRevision: count }).strict(),
  'workflow/draft/discard': z.object({ draftId, expectedDraftRevision: count }).strict(),
  'workflow/draft/confirm': z.object({ draftId, expectedDraftRevision: count, assigneeAgentId: agentId }).strict(),
  'workflow/task-template/create': z.object({ name: text, brief: taskBriefSchema }).strict(),
  'workflow/task-template/revise': z.object({ templateId, brief: taskBriefSchema }).strict(),
  'workflow/task-template/apply': z.object({ templateRevisionId, suggestedAssigneeAgentId: agentId.optional() }).strict(),
  'workflow/company-template/create': z.object({ name: text, config: companyTemplateConfigSchema }).strict(),
  'workflow/company-template/revise': z.object({ templateId: companyId, config: companyTemplateConfigSchema }).strict(),
  'workflow/company-template/confirm': z.object({ templateRevisionId: companyRevisionId, confirmed: z.literal(true), memoryStart: z.object({ type: z.literal('new-events') }).strict() }).strict(),
  'workflow/artifact/register': z.object({ result: taskResultReferenceSchema, label: text, summary: text, reference: artifactReferenceSchema.optional() }).strict(),
  'workflow/result/review': z.object({ result: taskResultReferenceSchema, decision: z.enum(['accepted', 'changes-requested']), comment: z.string() }).strict().refine(value => value.decision === 'accepted' || value.comment.trim() !== ''),
  'workflow/result/handoff': z.object({ result: taskResultReferenceSchema, artifactIds: z.array(artifactId), suggestedAssigneeAgentId: agentId.optional() }).strict(),
} satisfies { [K in W.WorkflowEndpoint]: z.ZodType<W.WorkflowCommandMap[K]> }

const receiptSchemas = {
  'workflow/draft/create': z.object({ draftId }).strict(),
  'workflow/draft/edit': z.object({ draftId }).strict(),
  'workflow/draft/discard': z.object({ draftId }).strict(),
  'workflow/draft/confirm': z.object({ draftId, taskId, taskAssignmentId: id.transform(TaskAssignmentId) }).strict(),
  'workflow/task-template/create': z.object({ templateId, templateRevisionId }).strict(),
  'workflow/task-template/revise': z.object({ templateId, templateRevisionId }).strict(),
  'workflow/task-template/apply': z.object({ draftId }).strict(),
  'workflow/company-template/create': z.object({ templateId: companyId, templateRevisionId: companyRevisionId }).strict(),
  'workflow/company-template/revise': z.object({ templateId: companyId, templateRevisionId: companyRevisionId }).strict(),
  'workflow/company-template/confirm': z.object({ agentIds: z.array(agentId), roomIds: z.array(id.transform(RoomId)), membershipIds: z.array(id.transform(MembershipId)) }).strict(),
  'workflow/artifact/register': z.object({ artifactId }).strict(),
  'workflow/result/review': z.object({ reviewId, draftId: draftId.optional() }).strict(),
  'workflow/result/handoff': z.object({ draftId }).strict(),
} satisfies { [K in W.WorkflowEndpoint]: z.ZodType<W.WorkflowMutationValueMap[K]> }

const endpoints = Object.keys(workflowCommandPayloadSchemas) as W.WorkflowEndpoint[]
// Payload parsers are strict, so the discriminator must be removed before payload validation.
export const workflowCommandSchema: z.ZodType<W.WorkflowCommand> = z.unknown().transform((input, ctx) => {
  if (input === null || typeof input !== 'object' || !('type' in input) || typeof input.type !== 'string' || !Object.hasOwn(workflowCommandPayloadSchemas, input.type)) { ctx.addIssue({ code: 'custom', message: 'invalid workflow command' }); return z.NEVER }
  const { type, ...payload } = input
  const endpoint = type as W.WorkflowEndpoint
  const parsed = workflowCommandPayloadSchemas[endpoint].safeParse(payload)
  if (!parsed.success) { ctx.addIssue({ code: 'custom', message: 'invalid workflow command payload' }); return z.NEVER }
  return { type: endpoint, ...parsed.data } as W.WorkflowCommand
})
const snapshot = z.object({ id: artifactId, label: text, summary: text, reference: artifactReferenceSchema.optional() }).strict()
const handoff = z.object({ result: taskResultReferenceSchema, type: z.enum(['task/result', 'task/result-after-cancel']), text: z.string(), artifacts: z.array(snapshot), reviewComment: z.string().optional() }).strict()
const source = z.discriminatedUnion('type', [z.object({ type: z.literal('human'), id: id.transform(HumanId) }).strict(), z.object({ type: z.literal('employee'), id: agentId }).strict(), z.object({ type: z.literal('handoff'), result: taskResultReferenceSchema, artifactIds: z.array(artifactId) }).strict(), z.object({ type: z.literal('changes-requested'), result: taskResultReferenceSchema, reviewId }).strict()])
const draft = z.object({ id: draftId, revision: count, status: z.enum(['draft', 'confirmed', 'discarded']), source, brief: taskBriefSchema, suggestedAssigneeAgentId: agentId.optional(), templateRevisionId: templateRevisionId.optional(), handoff: handoff.optional(), taskId: taskId.optional() }).strict()
const receipt = z.union(endpoints.map(type => z.object({ type: z.literal(type), value: receiptSchemas[type] }).strict())) as z.ZodType<W.WorkflowReceipt>
const factBase = { id: id.transform(value => value as W.WorkflowFactId), sequence: positive, occurredAt: timestamp }
const fact = z.union([
  ...endpoints.map(type => z.object({ ...factBase, type: z.literal(type), actor: z.object({ type: z.literal('human'), id: id.transform(HumanId) }).strict(), command: workflowCommandSchema.refine(value => value.type === type), receipt: receiptSchemas[type] }).strict()),
  z.object({ ...factBase, type: z.literal('workflow/employee/proposed'), actor: z.object({ type: z.literal('employee'), id: agentId }).strict(), command: workflowProposalSchema, receipt: z.object({ draftId }).strict() }).strict(),
]) as z.ZodType<W.WorkflowFact>

/** Strict fields are complemented by same-record relationship checks in assertWorkflowInvariants. */
export const workflowStateSchema = z.object({
  revision: count, nextId: positive, nextSequence: positive,
  drafts: z.record(draftId, draft),
  taskTemplates: z.record(templateId, z.object({ id: templateId, name: text, revisionIds: z.array(templateRevisionId).min(1), currentRevisionId: templateRevisionId }).strict()),
  taskTemplateRevisions: z.record(templateRevisionId, z.object({ id: templateRevisionId, templateId, number: positive, brief: taskBriefSchema }).strict()),
  companyTemplates: z.record(companyId, z.object({ id: companyId, name: text, revisionIds: z.array(companyRevisionId).min(1), currentRevisionId: companyRevisionId }).strict()),
  companyTemplateRevisions: z.record(companyRevisionId, z.object({ id: companyRevisionId, templateId: companyId, number: positive, config: companyTemplateConfigSchema }).strict()),
  taskBriefs: z.record(taskId, z.object({ taskId, draftId, brief: taskBriefSchema, templateRevisionId: templateRevisionId.optional(), handoff: handoff.optional() }).strict()),
  artifacts: z.record(artifactId, snapshot.extend({ result: taskResultReferenceSchema }).strict()),
  reviews: z.record(reviewId, z.object({ id: reviewId, result: taskResultReferenceSchema, decision: z.enum(['accepted', 'changes-requested']), comment: z.string(), draftId: draftId.optional() }).strict().refine(value => value.decision === 'accepted' || value.comment.trim() !== '')),
  operations: z.record(id.transform(value => value as W.WorkflowOperationId), z.object({ id: id.transform(value => value as W.WorkflowOperationId), requestDigest: z.string().regex(/^[0-9a-f]{64}$/u), receipt, aggregateRevision: count, workflowRevision: positive }).strict()),
  facts: z.array(fact),
}).strict() satisfies z.ZodType<W.WorkflowState>
