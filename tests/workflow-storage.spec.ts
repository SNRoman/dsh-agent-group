import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import canonicalize from 'canonicalize'
import { afterEach, expect, test, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import { apply as domainApply, Config as DomainConfig, inject as domainInject } from '@deepseek-ai/dsh-storage-domain'
import { apply as jsonApply, Config as JsonConfig, inject as jsonInject } from '@deepseek-ai/dsh-storage-json'
import { WorkspaceDirectory } from '../packages/host/src/workspace-directory.ts'
import { agentWorkspaceSpec } from '../packages/host/src/spec.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import { AgentId, HumanId, WorkspaceId } from '../packages/host/src/ids.ts'
import { createInitialWorkflowState, WorkflowOperationId } from '../packages/host/src/workflow.ts'
import { createWorkspaceExportV3, prepareWorkspaceImport } from '../packages/host/src/workspace-portable.ts'
import { workspaceRecordV2Schema } from '../packages/host/src/workspace-record.ts'
import { acceptTaskDelivery, startTaskDelivery, terminalizeTask } from '../packages/host/src/task-delivery.ts'
import { proposeWorkflowDraft } from '../packages/host/src/workflow.ts'
import type { WorkflowCommand, WorkflowEndpoint } from '../packages/host/src/workflow-contract.ts'

const roots: string[] = []
const context = { humanId: HumanId('owner'), occurredAt: '2026-10-11T00:00:00.000Z' }
const brief = { title: 'Report', instructions: 'Write report', expectedArtifacts: ['report'], acceptanceCriteria: ['accepted'] }
const limits = { maxBytes: 1_000_000, maxEntities: 10_000, maxEvents: 10_000, maxStringBytes: 100_000, maxDepth: 32 }
const local = WorkspaceId('local')
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function boot(root?: string) {
  const path = root ?? await mkdtemp(join(tmpdir(), 'workflow-storage-')); if (root === undefined) roots.push(path)
  const ctx = new Context()
  const fibers = [await ctx.plugin(Storage), await ctx.plugin({ apply: jsonApply, Config: JsonConfig, inject: jsonInject }, { root: path }), await ctx.plugin({ apply: domainApply, Config: DomainConfig, inject: domainInject }, { backend: 'json' })]
  const kv = ctx.storage.backend.get('json').kv!; const open = kv.open.bind(kv); let unit!: KvUnit
  vi.spyOn(kv, 'open').mockImplementationOnce(async descriptor => { unit = await open(descriptor); return unit })
  const domain = await ctx.storageDomain.open(agentWorkspaceSpec); const table = domain.table('workspaces'); const directory = new WorkspaceDirectory(table)
  return { root: path, directory, table, unit, dispose: async () => { await domain.close(); for (const fiber of fibers.toReversed()) await fiber.dispose() } }
}
async function seeded() {
  const host = await boot(); await host.directory.initialize()
  const definition = mutateWorkspace(host.directory.snapshot(local), { type: 'definition/create', name: 'Role', description: 'd', instructions: 'i' })
  const agent = mutateWorkspace(definition.state, { type: 'agent/create', definitionId: definition.definitionId, name: 'Ada' })
  await host.directory.updateAggregate(local, () => agent.state)
  return { ...host, agentId: agent.agentId }
}
function request<K extends WorkflowEndpoint>(directory: WorkspaceDirectory, command: WorkflowCommand<K>, op: string) {
  const record = directory.record(local)
  return { expectedAggregateRevision: record.aggregate.revision, expectedWorkflowRevision: record.workflow.revision, operationId: WorkflowOperationId(op), command }
}
function sign(document: Record<string, unknown>): string { const { digest: _digest, ...envelope } = document; return JSON.stringify({ ...envelope, digest: { algorithm: 'sha-256', canonicalization: 'RFC8785', hex: createHash('sha256').update(canonicalize(envelope)!).digest('hex') } }) }

test('whole directory validation precedes bare and v1 migration writes', async () => {
  const host = await boot()
  try {
    await host.table.put(local, createInitialState(local))
    await host.table.put(WorkspaceId('wrong'), { recordVersion: 1, descriptor: { id: WorkspaceId('other'), label: 'Other', lifecycle: 'active' }, aggregate: createInitialState(WorkspaceId('other')) })
    await expect(host.directory.initialize()).rejects.toThrow()
    expect(host.table.get(local)).not.toHaveProperty('recordVersion')
  } finally { await host.dispose() }
})
test('bare and v1 upgrade once to empty workflow without invented facts', async () => {
  const host = await boot()
  try {
    const bare = createInitialState(local); await host.table.put(local, bare)
    const id = WorkspaceId('other'); await host.table.put(id, { recordVersion: 1, descriptor: { id, label: 'Other', lifecycle: 'active' }, aggregate: createInitialState(id) })
    const update = vi.spyOn(host.table, 'update')
    await host.directory.initialize(); await host.directory.initialize()
    expect(update).toHaveBeenCalledTimes(2)
    for (const workspaceId of [local, id]) { const record = host.directory.record(workspaceId); expect(record.recordVersion).toBe(2); expect(record.workflow).toEqual(createInitialWorkflowState()); expect(record.descriptor.creation).toBeUndefined() }
  } finally { await host.dispose() }
})
test('receipt retry after restart bypasses stale CAS without reassigning', async () => {
  const host = await seeded(); let retry!: ReturnType<typeof request<'workflow/draft/confirm'>>; let taskId: string
  try {
    const draft = await host.directory.executeWorkflow(local, request(host.directory, { type: 'workflow/draft/create', brief }, 'create'), context)
    retry = request(host.directory, { type: 'workflow/draft/confirm', draftId: draft.value.draftId, expectedDraftRevision: 0, assigneeAgentId: host.agentId }, 'confirm')
    const confirmed = await host.directory.executeWorkflow(local, retry, context); taskId = confirmed.value.taskId
    expect(confirmed.replayed).toBe(false)
  } finally { await host.dispose() }
  const restart = await boot(host.root)
  try {
    await restart.directory.initialize(); const before = restart.directory.record(local)
    const replay = await restart.directory.executeWorkflow(local, retry, { ...context, occurredAt: '2026-10-12T00:00:00.000Z' })
    expect(replay.value.taskId).toBe(taskId!); expect(replay.replayed).toBe(true); expect(restart.directory.record(local)).toEqual(before)
    expect(before.aggregate.events.filter(event => event.type === 'task/delivery-started')).toHaveLength(0)
  } finally { await restart.dispose() }
})
test('aggregate and descriptor writes preserve workflow', async () => {
  const host = await seeded()
  try { await host.directory.executeWorkflow(local, request(host.directory, { type: 'workflow/draft/create', brief }, 'draft'), context); const workflow = host.directory.record(local).workflow
    await host.directory.rename(local, 'Renamed'); await host.directory.updateAggregate(local, aggregate => mutateWorkspace(aggregate, { type: 'room/create', kind: 'group', name: 'G' }).state); await host.directory.setLifecycle(local, 'archived')
    expect(host.directory.record(local).workflow).toEqual(workflow)
  } finally { await host.dispose() }
})
test('failed backend commit leaves aggregate and workflow unchanged', async () => {
  const host = await seeded()
  try {
    const draft = await host.directory.executeWorkflow(local, request(host.directory, { type: 'workflow/draft/create', brief }, 'draft'), context); const before = host.directory.record(local)
    const file = join(host.root, 'agent_workspace.json'); const diskBefore = await readFile(file, 'utf8')
    vi.spyOn(host.unit, 'putRecord').mockRejectedValueOnce(new Error('backend commit rejected'))
    const confirm = request(host.directory, { type: 'workflow/draft/confirm', draftId: draft.value.draftId, expectedDraftRevision: 0, assigneeAgentId: host.agentId }, 'confirm')
    await expect(host.directory.executeWorkflow(local, confirm, context)).rejects.toThrow('backend commit rejected')
    expect(host.directory.record(local)).toEqual(before)
    expect(await readFile(file, 'utf8')).toBe(diskBefore)
    expect((await host.directory.executeWorkflow(local, confirm, context)).replayed).toBe(false)
  } finally { await host.dispose() }
})
test('two concurrent confirms accept one operation', async () => {
  const host = await seeded()
  try { const draft = await host.directory.executeWorkflow(local, request(host.directory, { type: 'workflow/draft/create', brief }, 'draft'), context)
    const first = request(host.directory, { type: 'workflow/draft/confirm', draftId: draft.value.draftId, expectedDraftRevision: 0, assigneeAgentId: host.agentId }, 'one')
    const results = await Promise.allSettled([host.directory.executeWorkflow(local, first, context), host.directory.executeWorkflow(local, { ...first, operationId: WorkflowOperationId('two') }, context)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(Object.keys(host.directory.record(local).aggregate.tasks)).toHaveLength(1)
  } finally { await host.dispose() }
})
test('operation mismatch is refused even with stale CAS', async () => {
  const host = await seeded()
  try { const draft = request(host.directory, { type: 'workflow/draft/create', brief }, 'operation'); await host.directory.executeWorkflow(local, draft, context)
    await expect(host.directory.executeWorkflow(local, { ...draft, command: { ...draft.command, brief: { ...brief, title: 'Changed' } } }, context)).rejects.toMatchObject({ code: 'workflow-operation-reused' })
  } finally { await host.dispose() }
})
test('durable and imported operation digests match the recorded human semantic command', async () => {
  const host = await seeded()
  try {
    await host.directory.executeWorkflow(local, request(host.directory, { type: 'workflow/draft/create', brief }, 'draft'), context)
    const original = host.directory.record(local); const exported = createWorkspaceExportV3(original, { exportedAt: context.occurredAt })
    const damaged = JSON.parse(exported.json); damaged.workspace.workflow.operations.draft.requestDigest = 'a'.repeat(64)
    expect(() => prepareWorkspaceImport(sign(damaged), { workspaceId: WorkspaceId('invalid'), limits })).toThrow(/relationships/i)
    const broken = { ...original, workflow: { ...original.workflow, operations: { ...original.workflow.operations, [WorkflowOperationId('draft')]: { ...original.workflow.operations[WorkflowOperationId('draft')]!, requestDigest: 'a'.repeat(64) } } } }
    await host.table.put(local, broken)
    await expect(new WorkspaceDirectory(host.table).initialize()).rejects.toThrow(/digest/i)
  } finally { await host.dispose() }
})
test('queued and precommit aborts append no facts', async () => {
  const host = await seeded()
  try {
    const barrier = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>(); const update = host.table.update.bind(host.table)
    vi.spyOn(host.table, 'update').mockImplementationOnce(async (id, transform) => { entered.resolve(); await barrier.promise; return update(id, transform) })
    const first = host.directory.rename(local, 'Hold'); await entered.promise
    const queued = new AbortController(); const mutation = host.directory.executeWorkflow(local, request(host.directory, { type: 'workflow/draft/create', brief }, 'queued'), context, queued.signal); queued.abort(); barrier.resolve(); await first
    await expect(mutation).rejects.toThrow(); expect(host.directory.record(local).workflow.facts).toHaveLength(0)
    const precommit = new AbortController(); vi.mocked(host.table.update).mockImplementationOnce(async (id, transform) => { precommit.abort(); return update(id, transform) })
    await expect(host.directory.executeWorkflow(local, request(host.directory, { type: 'workflow/draft/create', brief }, 'precommit'), context, precommit.signal)).rejects.toThrow()
    expect(host.directory.record(local).workflow.facts).toHaveLength(0)
  } finally { await host.dispose() }
})
test('abort after backend durability returns the committed receipt', async () => {
  const host = await seeded()
  try {
    const signal = new AbortController(); const put = host.unit.putRecord.bind(host.unit)
    vi.spyOn(host.unit, 'putRecord').mockImplementationOnce(async (...args) => { await put(...args); signal.abort() })
    const committed = await host.directory.executeWorkflow(local, request(host.directory, { type: 'workflow/draft/create', brief }, 'committed'), context, signal.signal)
    expect(committed.replayed).toBe(false); expect(host.directory.record(local).workflow.drafts[committed.value.draftId]).toBeDefined()
    expect(host.directory.record(local).workflow.operations[WorkflowOperationId('committed')]).toBeDefined()
  } finally { await host.dispose() }
})
test('v3 retains workflow and equal internal IDs across imported organizations', async () => {
  const host = await seeded()
  try { await host.directory.executeWorkflow(local, request(host.directory, { type: 'workflow/draft/create', brief, suggestedAssigneeAgentId: host.agentId }, 'draft'), context)
    const original = host.directory.record(local); const exported = createWorkspaceExportV3(original, { exportedAt: context.occurredAt })
    const copy = prepareWorkspaceImport(exported.json, { workspaceId: WorkspaceId('copy'), limits })
    expect(copy.workflow).toEqual(original.workflow); expect(copy.state.agents).toEqual(original.aggregate.agents); expect(copy.descriptor).not.toHaveProperty('creation'); expect(copy.state.sessionBindings).toEqual({})
    expect(workspaceRecordV2Schema.safeParse({ recordVersion: 2, descriptor: copy.descriptor, aggregate: copy.state, workflow: copy.workflow }).success).toBe(true)
    expect(host.directory.record(local)).toEqual(original)
  } finally { await host.dispose() }
})
test('v3 rejects raw digest corruption, workflow references and collection budget excess', async () => {
  const host = await seeded()
  try { await host.directory.executeWorkflow(local, request(host.directory, { type: 'workflow/draft/create', brief }, 'draft'), context)
    const exported = createWorkspaceExportV3(host.directory.record(local), { exportedAt: context.occurredAt }); const document = JSON.parse(exported.json)
    document.workspace.workflow.drafts[Object.keys(document.workspace.workflow.drafts)[0]!].suggestedAssigneeAgentId = AgentId('toString')
    expect(() => prepareWorkspaceImport(sign(document), { workspaceId: WorkspaceId('copy'), limits })).toThrow(/relationships/i)
    expect(() => prepareWorkspaceImport(exported.json.replace('Write report', 'Changed report'), { workspaceId: WorkspaceId('copy'), limits })).toThrow(/digest/i)
    const entityCount = Object.keys(host.directory.snapshot(local).definitions).length + Object.keys(host.directory.snapshot(local).definitionRevisions).length + Object.keys(host.directory.snapshot(local).agents).length
    expect(() => prepareWorkspaceImport(exported.json, { workspaceId: WorkspaceId('copy'), limits: { ...limits, maxEntities: entityCount } })).toThrow(/maxEntities/i)
    expect(() => prepareWorkspaceImport(exported.json, { workspaceId: WorkspaceId('copy'), limits: { ...limits, maxEvents: host.directory.snapshot(local).events.length } })).toThrow(/maxEvents/i)
  } finally { await host.dispose() }
})

test('v3 preserves templates, confirmed briefs, results, selected handoffs and operation history', async () => {
  const host = await seeded()
  try {
    const template = await host.directory.executeWorkflow(local, request(host.directory, { type: 'workflow/task-template/create', name: 'Report', brief }, 'template'), context)
    const draft = await host.directory.executeWorkflow(local, request(host.directory, { type: 'workflow/task-template/apply', templateRevisionId: template.value.templateRevisionId }, 'apply'), context)
    const confirmed = await host.directory.executeWorkflow(local, request(host.directory, { type: 'workflow/draft/confirm', draftId: draft.value.draftId, expectedDraftRevision: 0, assigneeAgentId: host.agentId }, 'confirm'), context)
    let attemptId!: ReturnType<typeof startTaskDelivery>['attemptId']
    await host.directory.updateAggregate(local, state => {
      const started = startTaskDelivery(state, { taskId: confirmed.value.taskId }); attemptId = started.attemptId
      const accepted = acceptTaskDelivery(started.state, { taskId: confirmed.value.taskId, attemptId, messageId: started.message.id })
      return terminalizeTask(accepted.state, { actorAgentId: host.agentId, taskId: confirmed.value.taskId, attemptId, definitionRevisionId: state.agents[host.agentId]!.definitionRevisionId, result: 'Exact source report' }).state
    })
    const event = host.directory.snapshot(local).events.find(event => event.type === 'task/result')!
    const result = { taskId: confirmed.value.taskId, eventId: event.id, attemptId }
    const selected = await host.directory.executeWorkflow(local, request(host.directory, { type: 'workflow/artifact/register', result, label: 'Selected', summary: 'Reviewed report', reference: { kind: 'url', value: 'https://example.com/report' } }, 'artifact'), context)
    const unselected = await host.directory.executeWorkflow(local, request(host.directory, { type: 'workflow/artifact/register', result, label: 'Unselected', summary: 'Notes' }, 'notes'), context)
    await host.directory.executeWorkflow(local, request(host.directory, { type: 'workflow/result/review', result, decision: 'changes-requested', comment: 'More detail' }, 'changes'), context)
    await host.directory.executeWorkflow(local, request(host.directory, { type: 'workflow/result/review', result, decision: 'accepted', comment: '' }, 'accept'), context)
    const handoff = await host.directory.executeWorkflow(local, request(host.directory, { type: 'workflow/result/handoff', result, artifactIds: [selected.value.artifactId] }, 'handoff'), context)
    await host.directory.executeWorkflow(local, request(host.directory, { type: 'workflow/draft/confirm', draftId: handoff.value.draftId, expectedDraftRevision: 0, assigneeAgentId: host.agentId }, 'handoff-confirm'), context)
    const config = { colleagues: [{ name: 'New colleague', definitionRevisionId: host.directory.snapshot(local).agents[host.agentId]!.definitionRevisionId }], groups: [{ name: 'New group', memberNames: ['New colleague'] }] }
    const company = await host.directory.executeWorkflow(local, request(host.directory, { type: 'workflow/company-template/create', name: 'Company', config }, 'company'), context)
    await host.directory.executeWorkflow(local, request(host.directory, { type: 'workflow/company-template/confirm', templateRevisionId: company.value.templateRevisionId, confirmed: true, memoryStart: { type: 'new-events' } }, 'company-confirm'), context)
    await host.directory.updateRecord(local, record => { const proposal = proposeWorkflowDraft(record, { brief, suggestedAssigneeAgentId: host.agentId }, { agentId: host.agentId, occurredAt: context.occurredAt }); return { record: { ...record, aggregate: proposal.aggregate, workflow: proposal.workflow }, value: proposal.value } })
    await host.directory.updateAggregate(local, state => mutateWorkspace(state, { type: 'agent/depart', agentId: host.agentId }).state)
    const original = host.directory.record(local); const exported = createWorkspaceExportV3(original, { exportedAt: context.occurredAt })
    const copy = prepareWorkspaceImport(exported.json, { workspaceId: WorkspaceId('copied'), limits })
    expect(copy.workflow).toEqual(original.workflow)
    expect(copy.workflow.drafts[handoff.value.draftId]?.handoff?.artifacts.map(item => item.id)).toEqual([selected.value.artifactId])
    expect(copy.workflow.artifacts[unselected.value.artifactId]).toBeDefined()
    expect(copy.state.events.filter(event => 'messageId' in event)).toEqual(original.aggregate.events.filter(event => 'messageId' in event).map(event => 'messageId' in event ? { ...event, messageId: `agent-workspace-task:copied:${event.taskDeliveryAttemptId}` } : event))
    const second = createWorkspaceExportV3({ recordVersion: 2, descriptor: copy.descriptor, aggregate: copy.state, workflow: copy.workflow }, { exportedAt: context.occurredAt })
    expect(prepareWorkspaceImport(second.json, { workspaceId: WorkspaceId('twice'), limits }).workflow).toEqual(original.workflow)
    const damaged = JSON.parse(exported.json)
    damaged.workspace.workflow.operations['confirm'].receipt.value.taskAssignmentId = 'toString'
    expect(() => prepareWorkspaceImport(sign(damaged), { workspaceId: WorkspaceId('invalid'), limits })).toThrow(/relationships/i)
  } finally { await host.dispose() }
})
