/** Strict workflow wire parsing; no Host runtime imports. */
import { z } from 'zod'
import { assertWorkspaceRpcError } from './api.ts'
import type { WorkspaceApiClient } from './api.ts'
import type { CompanyTemplatePreview, WorkflowCommandMap, WorkflowEndpoint, WorkflowExpectedRevisions, WorkflowMutationResult, WorkflowMutationValueMap, WorkflowRpcError, WorkflowSnapshot } from './workflow-contracts.ts'

const id = z.string().trim().min(1)
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positive = counter.min(1)
const text = z.string().trim().min(1)
const brief = z.strictObject({ title: text, instructions: text, expectedArtifacts: z.array(text), acceptanceCriteria: z.array(text) })
const reference = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('path'), value: text }), z.strictObject({ kind: z.literal('url'), value: z.string().refine(v => { try { return ['http:', 'https:'].includes(new URL(v).protocol) } catch { return false } }) })])
const result = z.strictObject({ taskId: id, eventId: id, attemptId: id })
const proposal = z.strictObject({ brief, suggestedAssigneeAgentId: id.optional() })
const config = z.strictObject({ colleagues: z.array(z.strictObject({ name: text, definitionRevisionId: id })), groups: z.array(z.strictObject({ name: text, memberNames: z.array(text) })) }).superRefine((v, ctx) => {
  const names = v.colleagues.map(c => c.name.trim())
  if (new Set(names).size !== names.length || v.groups.some(g => new Set(g.memberNames).size !== g.memberNames.length || g.memberNames.some(n => !names.includes(n)))) ctx.addIssue({ code: 'custom', message: 'Invalid company membership' })
})
const artifact = z.strictObject({ id, label: text, summary: text, reference: reference.optional() })
const handoff = z.strictObject({ result, type: z.enum(['task/result', 'task/result-after-cancel']), text: z.string(), artifacts: z.array(artifact), reviewComment: z.string().optional() })
const source = z.discriminatedUnion('type', [z.strictObject({ type: z.literal('human'), id }), z.strictObject({ type: z.literal('employee'), id }), z.strictObject({ type: z.literal('handoff'), result, artifactIds: z.array(id) }), z.strictObject({ type: z.literal('changes-requested'), result, reviewId: id })])
const draft = z.strictObject({ id, revision: counter, status: z.enum(['draft', 'confirmed', 'discarded']), source, brief, suggestedAssigneeAgentId: id.optional(), templateRevisionId: id.optional(), handoff: handoff.optional(), taskId: id.optional() })
const template = z.strictObject({ id, name: text, revisionIds: z.array(id).min(1), currentRevisionId: id })
const review = z.strictObject({ id, result, decision: z.enum(['accepted', 'changes-requested']), comment: z.string(), draftId: id.optional() }).refine(v => v.decision === 'accepted' || v.comment.trim() !== '')
const commands = {
  'workflow/draft/create': proposal,
  'workflow/draft/edit': proposal.extend({ draftId: id, expectedDraftRevision: counter }),
  'workflow/draft/discard': z.strictObject({ draftId: id, expectedDraftRevision: counter }),
  'workflow/draft/confirm': z.strictObject({ draftId: id, expectedDraftRevision: counter, assigneeAgentId: id }),
  'workflow/task-template/create': z.strictObject({ name: text, brief }),
  'workflow/task-template/revise': z.strictObject({ templateId: id, brief }),
  'workflow/task-template/apply': z.strictObject({ templateRevisionId: id, suggestedAssigneeAgentId: id.optional() }),
  'workflow/company-template/create': z.strictObject({ name: text, config }),
  'workflow/company-template/revise': z.strictObject({ templateId: id, config }),
  'workflow/company-template/confirm': z.strictObject({ templateRevisionId: id, confirmed: z.literal(true), memoryStart: z.strictObject({ type: z.literal('new-events') }) }),
  'workflow/artifact/register': z.strictObject({ result, label: text, summary: text, reference: reference.optional() }),
  'workflow/result/review': z.strictObject({ result, decision: z.enum(['accepted', 'changes-requested']), comment: z.string() }).refine(v => v.decision !== 'changes-requested' || v.comment.trim() !== ''),
  'workflow/result/handoff': z.strictObject({ result, artifactIds: z.array(id), suggestedAssigneeAgentId: id.optional() }),
} satisfies Record<WorkflowEndpoint, z.ZodType>
const values = {
  'workflow/draft/create': z.strictObject({ draftId: id }), 'workflow/draft/edit': z.strictObject({ draftId: id }), 'workflow/draft/discard': z.strictObject({ draftId: id }),
  'workflow/draft/confirm': z.strictObject({ draftId: id, taskId: id, taskAssignmentId: id }),
  'workflow/task-template/create': z.strictObject({ templateId: id, templateRevisionId: id }), 'workflow/task-template/revise': z.strictObject({ templateId: id, templateRevisionId: id }),
  'workflow/task-template/apply': z.strictObject({ draftId: id }),
  'workflow/company-template/create': z.strictObject({ templateId: id, templateRevisionId: id }), 'workflow/company-template/revise': z.strictObject({ templateId: id, templateRevisionId: id }),
  'workflow/company-template/confirm': z.strictObject({ agentIds: z.array(id), roomIds: z.array(id), membershipIds: z.array(id) }),
  'workflow/artifact/register': z.strictObject({ artifactId: id }), 'workflow/result/review': z.strictObject({ reviewId: id, draftId: id.optional() }), 'workflow/result/handoff': z.strictObject({ draftId: id }),
} satisfies Record<WorkflowEndpoint, z.ZodType>
const endpoint = z.enum(Object.keys(commands) as [WorkflowEndpoint, ...WorkflowEndpoint[]])
const receipt = z.strictObject({ type: endpoint, value: z.unknown() }).superRefine((v, ctx) => { if (!values[v.type].safeParse(v.value).success) ctx.addIssue({ code: 'custom', message: 'Invalid workflow receipt' }) })
const fact = z.strictObject({ id, sequence: positive, type: z.union([endpoint, z.literal('workflow/employee/proposed')]), actor: z.strictObject({ type: z.enum(['human', 'employee']), id }), occurredAt: z.iso.datetime(), command: z.unknown(), receipt: z.unknown() }).superRefine((v, ctx) => {
  const employee = v.type === 'workflow/employee/proposed'
  const schema = employee ? proposal : commands[v.type as WorkflowEndpoint]
  const payload = typeof v.command === 'object' && v.command !== null ? { ...v.command } as Record<string, unknown> : {}
  if (!employee) { if (payload['type'] !== v.type) ctx.addIssue({ code: 'custom', message: 'Invalid command type' }); delete payload['type'] }
  if (v.actor.type !== (employee ? 'employee' : 'human') || !schema.safeParse(payload).success || !(employee ? values['workflow/draft/create'] : values[v.type as WorkflowEndpoint]).safeParse(v.receipt).success) ctx.addIssue({ code: 'custom', message: 'Invalid workflow fact' })
})
function map<T extends z.ZodType>(schema: T, key = 'id') { return z.record(z.string(), schema).superRefine((v, ctx) => { for (const [name, entry] of Object.entries(v)) if (['__proto__', 'constructor', 'prototype'].includes(name) || typeof entry !== 'object' || entry === null || (entry as Record<string, unknown>)[key] !== name) ctx.addIssue({ code: 'custom', message: 'Invalid workflow identity' }) }) }
const state = z.strictObject({ revision: counter, nextId: positive, nextSequence: positive,
  drafts: map(draft), taskTemplates: map(template), taskTemplateRevisions: map(z.strictObject({ id, templateId: id, number: positive, brief })), companyTemplates: map(template), companyTemplateRevisions: map(z.strictObject({ id, templateId: id, number: positive, config })),
  taskBriefs: map(z.strictObject({ taskId: id, draftId: id, brief, templateRevisionId: id.optional(), handoff: handoff.optional() }), 'taskId'), artifacts: map(artifact.extend({ result })), reviews: map(review),
  operations: map(z.strictObject({ id, requestDigest: z.string().regex(/^[0-9a-f]{64}$/u), receipt, aggregateRevision: counter, workflowRevision: positive })), facts: z.array(fact),
})
const expectedSchema = z.strictObject({ expectedAggregateRevision: counter, expectedWorkflowRevision: counter })
const snapshotSchema = z.strictObject({ workspaceId: id, aggregateRevision: counter, workflow: state })
const previewSchema = z.strictObject({ workspaceId: id, aggregateRevision: counter, workflowRevision: counter, templateRevisionId: id, config })
const errorDetails = {
  'stale-workflow-revision': z.strictObject({ expectedWorkflowRevision: counter, actualWorkflowRevision: counter }),
  'stale-draft-revision': z.strictObject({ draftId: id, expectedDraftRevision: counter, actualDraftRevision: counter }),
  'workflow-operation-reused': z.strictObject({ operationId: id }), 'workflow-reference-invalid': z.strictObject({ entityKind: id, entityId: id }),
  'draft-not-editable': z.strictObject({ draftId: id, status: z.enum(['confirmed', 'discarded']) }), 'workflow-read-only': z.strictObject({ workspaceId: id }),
}
/** Validated workflow and existing aggregate failure retained for localized UI. */
export class WorkflowApiError extends Error {
  override readonly name = 'WorkflowApiError'
  readonly kind: WorkflowRpcError['kind']; readonly code: WorkflowRpcError['code']; readonly details: WorkflowRpcError['details']
  constructor(readonly error: WorkflowRpcError) { super(error.message); this.kind = error.kind; this.code = error.code; this.details = error.details }
}
/** Caller input was rejected before a workflow write entered the transport. */
export class WorkflowInputError extends Error { override readonly name = 'WorkflowInputError'; constructor() { super('Agent Workspace workflow input is invalid') } }
/** @param value Host error or Connection-decoded fields. @returns Safe known error, or an internal failure. */
export function assertWorkflowRpcError(value: unknown): WorkflowRpcError {
  const fields = { code: z.enum(Object.keys(errorDetails) as [keyof typeof errorDetails, ...(keyof typeof errorDetails)[]]), message: z.string(), details: z.unknown() }
  const parsed = z.union([z.strictObject({ ...fields, kind: z.literal('business') }), z.strictObject(fields)]).safeParse(value)
  if (parsed.success && errorDetails[parsed.data.code].safeParse(parsed.data.details).success) return { ...structuredClone(parsed.data), kind: 'business' } as WorkflowRpcError
  return assertWorkspaceRpcError(value)
}
/** Endpoint-specific client bound to one immutable organization API. */
export class WorkspaceWorkflowApi {
  constructor(private readonly api: WorkspaceApiClient) {}
  private scope<T extends { readonly workspaceId: string }>(value: T): T { if (value.workspaceId !== this.api.workspaceId) throw new Error('Agent Workspace workflow organization scope mismatch'); return value }
  async snapshot(signal?: AbortSignal): Promise<WorkflowSnapshot> { return this.scope(snapshotSchema.parse(await this.api.callWorkflow('workflow/snapshot', {}, signal)) as WorkflowSnapshot) }
  async previewCompanyTemplate(templateRevisionId: string, expected: WorkflowExpectedRevisions, signal?: AbortSignal): Promise<CompanyTemplatePreview> {
    return this.scope(previewSchema.parse(await this.api.callWorkflow('workflow/company-template/preview', { templateRevisionId: id.parse(templateRevisionId), ...expectedSchema.parse(expected) }, signal)))
  }
  /** @param endpoint Human workflow action. @param payload Semantic command fields. @param expected Both displayed revisions. @param operationId Stable retry identity. @param signal Caller cancellation. @param roomId Actual chat receiving the continuation message. @returns Validated organization-scoped receipt. */
  async mutate<K extends WorkflowEndpoint>(endpoint: K, payload: WorkflowCommandMap[K], expected: WorkflowExpectedRevisions, operationId: string, signal?: AbortSignal, roomId?: string): Promise<WorkflowMutationResult<WorkflowMutationValueMap[K]>> {
    if (this.api.readOnly) throw new WorkflowApiError({ kind: 'business', code: 'workflow-read-only', message: 'Read-only', details: { workspaceId: this.api.workspaceId ?? '' } })
    const parsed = commands[endpoint].safeParse(payload)
    const revisions = expectedSchema.safeParse(expected)
    const identity = id.safeParse(operationId)
    const room = id.optional().safeParse(roomId)
    if (!parsed.success || !revisions.success || !identity.success || !room.success) throw new WorkflowInputError()
    const value = await this.api.callWorkflow(endpoint, { ...parsed.data, ...revisions.data, operationId: identity.data, ...(room.data === undefined ? {} : { roomId: room.data }) }, signal)
    const envelope = z.strictObject({ workspaceId: id, aggregateRevision: counter, workflowRevision: counter, value: z.unknown(), replayed: z.boolean() }).parse(value)
    const parsedValue = values[endpoint].parse(envelope.value)
    if (endpoint === 'workflow/result/review' && 'decision' in parsed.data && 'reviewId' in parsedValue) {
      if ((parsed.data.decision === 'changes-requested') !== ('draftId' in parsedValue)) throw new Error('Agent Workspace returned an invalid review draft receipt')
    }
    return this.scope({ ...envelope, value: parsedValue }) as WorkflowMutationResult<WorkflowMutationValueMap[K]>
  }
}
