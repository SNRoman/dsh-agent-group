import { describe, expect, it } from 'vitest'
import { WorkspaceApi } from '../packages/web/src/client/api.ts'
import { WorkspaceWorkflowApi, WorkflowApiError } from '../packages/web/src/client/workflow-api.ts'
import type { WorkflowCommandMap } from '../packages/web/src/client/workflow-contracts.ts'
import { emptyWorkflow } from './fixtures/workflow-browser.ts'

const brief = { title: 'Work', instructions: 'Full work', expectedArtifacts: [], acceptanceCriteria: [] }
const config = { colleagues: [{ name: 'Alice', definitionRevisionId: 'rev' }], groups: [] }
const result = { taskId: 'task', eventId: 'event', attemptId: 'attempt' }
const cases: { [K in keyof WorkflowCommandMap]: [K, WorkflowCommandMap[K], object] }[keyof WorkflowCommandMap][] = [
  ['workflow/draft/create', { brief }, { draftId: 'draft' }],
  ['workflow/draft/edit', { draftId: 'draft', expectedDraftRevision: 0, brief }, { draftId: 'draft' }],
  ['workflow/draft/discard', { draftId: 'draft', expectedDraftRevision: 0 }, { draftId: 'draft' }],
  ['workflow/draft/confirm', { draftId: 'draft', expectedDraftRevision: 0, assigneeAgentId: 'alice' }, { draftId: 'draft', taskId: 'task', taskAssignmentId: 'assignment' }],
  ['workflow/task-template/create', { name: 'Work', brief }, { templateId: 'template', templateRevisionId: 'rev' }],
  ['workflow/task-template/revise', { templateId: 'template', brief }, { templateId: 'template', templateRevisionId: 'rev' }],
  ['workflow/task-template/apply', { templateRevisionId: 'rev' }, { draftId: 'draft' }],
  ['workflow/company-template/create', { name: 'Company', config }, { templateId: 'company', templateRevisionId: 'rev' }],
  ['workflow/company-template/revise', { templateId: 'company', config }, { templateId: 'company', templateRevisionId: 'rev' }],
  ['workflow/company-template/confirm', { templateRevisionId: 'rev', confirmed: true, memoryStart: { type: 'new-events' } }, { agentIds: ['alice'], roomIds: [], membershipIds: [] }],
  ['workflow/artifact/register', { result, label: 'Report', summary: 'Report summary', reference: { kind: 'path', value: 'C:/report.txt' } }, { artifactId: 'artifact' }],
  ['workflow/result/review', { result, decision: 'changes-requested', comment: 'Revise' }, { reviewId: 'review', draftId: 'draft' }],
  ['workflow/result/handoff', { result, artifactIds: ['artifact'] }, { draftId: 'draft' }],
]
function api(response: unknown, observe?: (payload: unknown) => void, readOnly = false) {
  return new WorkspaceWorkflowApi(new WorkspaceApi({ rpc: { call: async (_channel, _endpoint, payload) => { observe?.(payload); return response } } } as never).forWorkspace('workspace', readOnly))
}
describe('workflow Browser RPC', () => {
  it.each(cases)('scopes and validates %s', async (endpoint, payload, value) => {
    let sent: unknown
    const committed = { workspaceId: 'workspace', aggregateRevision: 4, workflowRevision: 2, value, replayed: true }
    expect(await api({ ok: true, value: committed }, p => { sent = p }).mutate(endpoint, payload, { expectedAggregateRevision: 3, expectedWorkflowRevision: 1 }, 'operation')).toEqual(committed)
    expect(sent).toEqual({ workspaceId: 'workspace', operationId: 'operation', expectedAggregateRevision: 3, expectedWorkflowRevision: 1, ...payload })
  })
  it('rejects forged actors and read-only writes before transport', async () => {
    await expect(api({ ok: true }).mutate('workflow/draft/create', { brief, actor: 'forged' } as never, { expectedAggregateRevision: 0, expectedWorkflowRevision: 0 }, 'op')).rejects.toThrow()
    await expect(api({ ok: true }, undefined, true).mutate('workflow/draft/create', { brief }, { expectedAggregateRevision: 0, expectedWorkflowRevision: 0 }, 'op')).rejects.toThrow()
  })
  it('identifies invalid local input before invoking the transport', async () => {
    await expect(api({ ok: true }).mutate('workflow/artifact/register', { result, label: 'Report', summary: 'Summary', reference: { kind: 'url', value: 'javascript:alert(1)' } }, { expectedAggregateRevision: 0, expectedWorkflowRevision: 0 }, 'op')).rejects.toMatchObject({ name: 'WorkflowInputError' })
  })
  it('trims company names and selected members together before submission', async () => {
    let sent: unknown
    const committed = { workspaceId: 'workspace', aggregateRevision: 0, workflowRevision: 1, value: { templateId: 'company', templateRevisionId: 'rev' }, replayed: false }
    await api({ ok: true, value: committed }, value => { sent = value }).mutate('workflow/company-template/create', { name: ' Team ', config: { colleagues: [{ name: ' Alice ', definitionRevisionId: 'rev' }], groups: [{ name: ' Group ', memberNames: [' Alice '] }] } }, { expectedAggregateRevision: 0, expectedWorkflowRevision: 0 }, 'op')
    expect(sent).toMatchObject({ name: 'Team', config: { colleagues: [{ name: 'Alice', definitionRevisionId: 'rev' }], groups: [{ name: 'Group', memberNames: ['Alice'] }] } })
  })
  it.each(['stale-workflow-revision', 'stale-draft-revision', 'stale-revision'])('retains safe %s details', async code => {
    const details = code === 'stale-workflow-revision' ? { expectedWorkflowRevision: 0, actualWorkflowRevision: 1 } : code === 'stale-draft-revision' ? { draftId: 'draft', expectedDraftRevision: 0, actualDraftRevision: 1 } : { expectedRevision: 0, actualRevision: 1 }
    await expect(api({ ok: false, error: { kind: 'business', code, message: 'stale', details } }).snapshot()).rejects.toMatchObject({ name: 'WorkflowApiError', code, details })
  })
  it('rejects malformed receipts and cross-organization snapshots', async () => {
    await expect(api({ ok: true, value: { workspaceId: 'elsewhere', aggregateRevision: 0, workflow: emptyWorkflow() } }).snapshot()).rejects.toThrow()
    await expect(api({ ok: true, value: { workspaceId: 'workspace', aggregateRevision: 0, workflowRevision: 1, value: { draftId: 'draft', actor: 'forged' }, replayed: false } }).mutate('workflow/draft/create', { brief }, { expectedAggregateRevision: 0, expectedWorkflowRevision: 0 }, 'op')).rejects.toThrow()
    expect(WorkflowApiError).toBeDefined()
  })
  it('checks review receipt against the requested decision', async () => {
    const committed = { workspaceId: 'workspace', aggregateRevision: 0, workflowRevision: 1, replayed: false }
    await expect(api({ ok: true, value: { ...committed, value: { reviewId: 'review' } } }).mutate('workflow/result/review', { result, decision: 'changes-requested', comment: 'Revise' }, { expectedAggregateRevision: 0, expectedWorkflowRevision: 0 }, 'op')).rejects.toThrow()
    await expect(api({ ok: true, value: { ...committed, value: { reviewId: 'review', draftId: 'draft' } } }).mutate('workflow/result/review', { result, decision: 'accepted', comment: '' }, { expectedAggregateRevision: 0, expectedWorkflowRevision: 0 }, 'op')).rejects.toThrow()
  })
  it('rejects malformed nested actor and command fields in snapshot facts', async () => {
    const workflow = { ...emptyWorkflow(), facts: [{ id: 'fact', sequence: 1, type: 'workflow/draft/create', actor: { type: 'employee', id: 'alice' }, occurredAt: '2026-10-11T00:00:00.000Z', command: { type: 'workflow/draft/create', brief }, receipt: { draftId: 'draft' } }] }
    await expect(api({ ok: true, value: { workspaceId: 'workspace', aggregateRevision: 0, workflow } }).snapshot()).rejects.toThrow()
    workflow.facts[0]!.actor.type = 'human'
    Object.assign(workflow.facts[0]!.command, { actor: 'forged' })
    await expect(api({ ok: true, value: { workspaceId: 'workspace', aggregateRevision: 0, workflow } }).snapshot()).rejects.toThrow()
  })
  it.each([
    { taskTemplates: { template: { id: 'template', name: 'Broken', revisionIds: [], currentRevisionId: 'revision' } } },
    { reviews: { review: { id: 'review', result, decision: 'changes-requested', comment: '', draftId: 'draft' } } },
    { operations: { op: { id: 'op', requestDigest: 'a'.repeat(64), aggregateRevision: 0, workflowRevision: 0, receipt: { type: 'workflow/draft/create', value: { draftId: 'draft' } } } } },
  ])('rejects nested durable values forbidden by the wire specification', async malformed => {
    await expect(api({ ok: true, value: { workspaceId: 'workspace', aggregateRevision: 0, workflow: { ...emptyWorkflow(), ...malformed } } }).snapshot()).rejects.toThrow()
  })
})
