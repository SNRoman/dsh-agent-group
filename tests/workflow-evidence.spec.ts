/** Packed workflow evidence rejects missing metadata and unselected delivery inputs. */
import { describe, expect, it } from 'vitest'
import { assertWorkflowImport, assertWorkflowDelivery, assertWorkflowProposal, assertWorkflowRestartQuiescence, readDurableRecord, readDurableOrganizations, waitForOrganizationReady, observeDirectRpcResponses } from './e2e/workflow-browser.mjs'
import { chromium } from 'playwright'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workflowRuntime } from './workflow-test-support.ts'
import { WorkspaceOperationId } from '../packages/host/src/workspace-record.ts'
import { WorkflowOperationId } from '../packages/host/src/workflow.ts'
import { HumanId, WorkspaceId } from '../packages/host/src/ids.ts'
import { createWorkspaceExportV3, prepareWorkspaceImport } from '../packages/host/src/workspace-portable.ts'
import { mutateWorkspace } from '../packages/host/src/state.ts'
import { startTaskDelivery, acceptTaskDelivery, terminalizeTask } from '../packages/host/src/task-delivery.ts'
import { SessionId } from '@deepseek-ai/dsh-session'

describe('packed workflow evidence', () => {
  it('records exact Direct HTTP RPC failure fields without URLs, authentication or unrelated responses', async () => {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.route('https://diagnostic.invalid/**', route => {
        const request = route.request()
        if (request.method() !== 'POST') return route.fulfill({ contentType: 'text/html', body: '<body>Diagnostic</body>' })
        const body = request.postDataJSON()
        if (body.rpcId === 'rpc-success') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { revision: 44, value: { roomId: 'room-65', state: { token: 'SNAPSHOT_SECRET' } } } } }) })
        if (body.rpcId === 'rpc-success-nested') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { revision: { token: 'REVISION_SENTINEL' }, value: { roomId: { authorization: 'Bearer ROOM_SENTINEL' } } } } }) })
        if (body.rpcId === 'rpc-success-text') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { revision: 'https://example.invalid/?token=REVISION_URL_SENTINEL', value: { roomId: 'Bearer ROOM_TEXT_SENTINEL' } } } }) })
        if (body.rpcId === 'rpc-success-ok-object') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: { token: 'OK_SENTINEL' }, value: { revision: 44, value: { roomId: 'room-65' } } } }) })
        if (body.rpcId === 'rpc-unreadable') return route.fulfill({ contentType: 'application/json', body: 'not json URL_SECRET' })
        if (body.rpcId === 'rpc-redacted') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: { kind: { token: 'KIND_SECRET' }, code: 'internal', message: 'failure https://example.invalid/?token=MSG_SECRET Bearer BEARER_SECRET', details: { expectedRevision: { token: 'NESTED_SECRET' }, actualRevision: 42 } } } }) })
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: { kind: 'business', code: 'stale-revision', message: 'workspace revision changed', details: { expectedRevision: 41, actualRevision: 42, authentication: 'DETAIL_SECRET' } } }, authentication: 'RESPONSE_SECRET' }) })
      })
      await page.goto('https://diagnostic.invalid/?token=URL_SECRET')
      const recorded: object[] = []
      const stop = observeDirectRpcResponses(page, recorded)
      await page.evaluate(async () => {
        for (const method of ['runtime/status', 'room/direct/open']) await fetch(`agent-workspace/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer HEADER_SECRET' }, body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-identity', method, payload: { workspaceId: 'local', expectedRevision: 41, agentId: 'agent-19', token: 'PAYLOAD_SECRET' }, authentication: 'ENVELOPE_SECRET' }) })
      })
      await page.evaluate(async () => {
        for (const rpcId of ['rpc-success', 'rpc-unreadable', 'rpc-redacted', 'rpc-success-nested', 'rpc-success-text', 'rpc-success-ok-object']) await fetch('agent-workspace/room/direct/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId, method: 'room/direct/open', payload: { workspaceId: 'local', expectedRevision: 42, agentId: 'agent-19' } }) })
      })
      await stop()
      expect(recorded).toEqual([
        { endpoint: 'room/direct/open', httpStatus: 200, request: { type: 'client-request', rpcId: 'rpc-identity', method: 'room/direct/open', payload: { workspaceId: 'local', expectedRevision: 41, agentId: 'agent-19' } }, response: { type: 'server-response', rpcId: 'rpc-identity', result: { ok: false, error: { kind: 'business', code: 'stale-revision', message: 'workspace revision changed', details: { expectedRevision: 41, actualRevision: 42 } } } } },
        { endpoint: 'room/direct/open', httpStatus: 200, request: { type: 'client-request', rpcId: 'rpc-success', method: 'room/direct/open', payload: { workspaceId: 'local', expectedRevision: 42, agentId: 'agent-19' } }, response: { type: 'server-response', rpcId: 'rpc-success', result: { ok: true, revision: 44, roomId: 'room-65' } } },
        { endpoint: 'room/direct/open', httpStatus: 200, request: { type: 'client-request', rpcId: 'rpc-unreadable', method: 'room/direct/open', payload: { workspaceId: 'local', expectedRevision: 42, agentId: 'agent-19' } }, responseReadFailed: true },
        { endpoint: 'room/direct/open', httpStatus: 200, request: { type: 'client-request', rpcId: 'rpc-redacted', method: 'room/direct/open', payload: { workspaceId: 'local', expectedRevision: 42, agentId: 'agent-19' } }, response: { type: 'server-response', rpcId: 'rpc-redacted', result: { ok: false, error: { code: 'internal', message: 'failure <redacted-url> Bearer <redacted>', details: { actualRevision: 42 } } } } },
        { endpoint: 'room/direct/open', httpStatus: 200, request: { type: 'client-request', rpcId: 'rpc-success-nested', method: 'room/direct/open', payload: { workspaceId: 'local', expectedRevision: 42, agentId: 'agent-19' } }, response: { type: 'server-response', rpcId: 'rpc-success-nested', result: { ok: true } } },
        { endpoint: 'room/direct/open', httpStatus: 200, request: { type: 'client-request', rpcId: 'rpc-success-text', method: 'room/direct/open', payload: { workspaceId: 'local', expectedRevision: 42, agentId: 'agent-19' } }, response: { type: 'server-response', rpcId: 'rpc-success-text', result: { ok: true, revision: '<redacted-url>', roomId: 'Bearer <redacted>' } } },
        { endpoint: 'room/direct/open', httpStatus: 200, request: { type: 'client-request', rpcId: 'rpc-success-ok-object', method: 'room/direct/open', payload: { workspaceId: 'local', expectedRevision: 42, agentId: 'agent-19' } }, response: { type: 'server-response', rpcId: 'rpc-success-ok-object', result: { revision: 44, roomId: 'room-65' } } },
      ])
      expect(JSON.stringify(recorded)).not.toMatch(/SECRET|SENTINEL|https:|authorization|authentication|token/)
      await page.evaluate(async () => { await fetch('agent-workspace/room/direct/open', { method: 'POST', body: '{}' }) })
      expect(recorded).toHaveLength(7)
    } finally { await browser.close() }
  })
  it('captures startup only after real Conversations navigation and the directory are ready, never on loading or error', async () => {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      const loading = '<div role="dialog" aria-label="Agent Organization"><section aria-label="Organization directory"><select aria-label="Organization" disabled></select><p role="status">Loading Agent Organization…</p></section></div>'
      await page.setContent(loading)
      const dialog = page.getByRole('dialog', { name: 'Agent Organization', exact: true })
      const oldSnapshot = await dialog.ariaSnapshot()
      expect(oldSnapshot).not.toContain('Conversations')
      let captured = false
      const capture = waitForOrganizationReady(dialog, 2_000).then(async () => { captured = true; return dialog.ariaSnapshot() })
      await page.evaluate(() => document.querySelector('[role="dialog"]')!.insertAdjacentHTML('beforeend', '<button>Conversations</button>'))
      expect(captured).toBe(false)
      await page.evaluate(() => {
        const directory = document.querySelector<HTMLSelectElement>('select[aria-label="Organization"]')!
        directory.insertAdjacentHTML('beforeend', '<option value="local">Local organization</option>')
        directory.disabled = false
        document.querySelector('[role="status"]')!.remove()
      })
      expect(await capture).toContain('Conversations')
      expect(captured).toBe(true)
      await page.setContent(loading)
      const failure = expect(waitForOrganizationReady(dialog, 2_000)).rejects.toThrow(/failed/i)
      await page.evaluate(() => {
        document.querySelector('[role="status"]')!.remove()
        const directory = document.querySelector<HTMLSelectElement>('select[aria-label="Organization"]')!
        directory.insertAdjacentHTML('beforeend', '<option value="local">Local organization</option>')
        directory.disabled = false
        document.querySelector('[role="dialog"]')!.insertAdjacentHTML('beforeend', '<button>Conversations</button>')
        document.querySelector('[role="dialog"]')!.insertAdjacentHTML('beforeend', '<p role="alert">Request failed</p>')
      })
      await failure
      await page.setContent(loading)
      await expect(waitForOrganizationReady(dialog, 100)).rejects.toThrow(/timeout/i)
      await page.setContent('<div role="dialog" aria-label="Agent Organization"><select aria-label="Organization"><option value="local">Local organization</option></select></div>')
      await expect(waitForOrganizationReady(dialog, 100)).rejects.toThrow(/timeout/i)
    } finally { await browser.close() }
  })
  it('preserves every old Session and organization while admitting only the profile core blank Session', () => {
    const coreWorkspace = '/core-workspace'
    const coreHeader = { type: 'session', version: 4, id: 'session-11111111-1111-4111-8111-111111111111', createdAt: 100, cwd: coreWorkspace, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }
    const settings = [{ type: 'permission/preset', seq: 0, time: 101, data: { preset: 'workspace-write' } }, { type: 'sandbox/mode', seq: 1, time: 102, data: { mode: 'workspace-write' } }, { type: 'approval/policy', seq: 2, time: 102, data: { policy: 'ask' } }]
    const before = [{ header: coreHeader, rows: [...settings, { type: 'user/message', seq: 3, time: 103, data: { id: 'core-message' } }] }, { header: { ...coreHeader, id: 'employee-session', cwd: '/employee-workspace' }, rows: [{ type: 'user/message', seq: 0, time: 110, data: { id: 'employee-message' } }] }]
    const blank = { header: { ...coreHeader, id: 'session-22222222-2222-4222-8222-222222222222', createdAt: 200 }, rows: settings.map(row => ({ ...row, time: row.time + 100 })) }
    const records = { source: { aggregate: { sessionBindings: { bob: 'employee-session' } }, workflow: { revision: 7 } }, restored: { aggregate: { sessionBindings: {} }, workflow: { revision: 7 } }, empty: { aggregate: { sessionBindings: {} }, workflow: { revision: 0 } } }
    const inspect = (after: object[], afterRecords = records) => assertWorkflowRestartQuiescence(before, after, coreWorkspace, records, afterRecords)
    expect(() => inspect(structuredClone(before))).not.toThrow()
    expect(() => inspect([blank, ...structuredClone(before).reverse()])).not.toThrow()
    const cases = [
      [...structuredClone(before), { ...blank, header: { ...blank.header, cwd: '/employee-workspace' } }],
      [...structuredClone(before), { ...blank, header: { ...blank.header, cwd: '/unknown-workspace' } }],
      [...structuredClone(before), { ...blank, header: { ...blank.header, parentSessionId: 'employee-session' } }],
      [...structuredClone(before), { ...blank, header: { ...blank.header, agentPreset: 'employee' } }],
      [...structuredClone(before), { ...blank, rows: settings }],
      [...structuredClone(before), { ...blank, rows: [...blank.rows, { type: 'turn/start', seq: 3, time: 205, data: {} }] }],
      [...structuredClone(before), { ...blank, rows: [blank.rows[1], blank.rows[0], blank.rows[2]] }],
      [...structuredClone(before), { ...blank, rows: [blank.rows[0], blank.rows[1], { ...blank.rows[2], data: { policy: 'never' } }] }],
      [...structuredClone(before), { ...blank, rows: [blank.rows[0], blank.rows[1], { ...blank.rows[2], data: { policy: 'ask', taskId: 'task' } }] }],
      [...structuredClone(before), blank, { ...blank, header: { ...blank.header, id: 'session-33333333-3333-4333-8333-333333333333' } }],
      [before[0]],
      [...structuredClone(before), structuredClone(before[0])],
    ]
    for (const after of cases) expect(() => inspect(after)).toThrow()
    for (const type of ['user/message', 'assistant/message', 'model/selection', 'tool/result', 'task/result']) expect(() => inspect([...structuredClone(before), { ...blank, rows: [...blank.rows, { type, seq: 3, time: 205, data: {} }] }])).toThrow()
    const changedOld = structuredClone(before)
    changedOld[1]!.rows.push({ type: 'user/message', seq: 1, time: 205, data: { id: 'unauthorized' } })
    expect(() => inspect(changedOld)).toThrow(/old Session/i)
    const changedHeader = structuredClone(before)
    changedHeader[1]!.header.createdAt += 1
    expect(() => inspect(changedHeader)).toThrow(/old Session/i)
    for (const key of ['source', 'restored', 'empty'] as const) {
      const changedRecords = structuredClone(records)
      changedRecords[key].aggregate.sessionBindings = { bob: blank.header.id }
      expect(() => inspect([...before, blank], changedRecords)).toThrow(/organization/i)
    }
    const changedWorkflow = structuredClone(records)
    changedWorkflow.empty.workflow.revision += 1
    expect(() => inspect([...before, blank], changedWorkflow)).toThrow(/organization/i)
    const removedOrganization = structuredClone(records)
    Reflect.deleteProperty(removedOrganization, 'empty')
    expect(() => inspect([...before, blank], removedOrganization)).toThrow(/organization/i)
    expect(() => inspect([...before, blank], { ...records, extra: records.empty })).toThrow(/organization/i)
  })
  it('reads complete V2 workflow records from both installed storage layouts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-workflow-evidence-'))
    const record = { recordVersion: 2, descriptor: { id: 'selected', label: 'Selected', lifecycle: 'active' }, aggregate: { workspaceId: 'selected' }, workflow: { operations: { receipt: { value: 'retained' } } } }
    const empty = { recordVersion: 2, descriptor: { id: 'empty', label: 'Empty', lifecycle: 'archived' }, aggregate: { workspaceId: 'empty' }, workflow: { operations: {} } }
    try {
      for (const distributed of [false, true]) {
        const home = join(root, String(distributed))
        const directory = distributed ? join(home, 'storages', 'agent_workspace', 'workspaces') : join(home, 'storages')
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, distributed ? 'selected.json' : 'agent_workspace.json'), JSON.stringify(distributed ? { value: record } : { tables: { workspaces: { selected: record, empty } } }), 'utf8')
        if (distributed) await writeFile(join(directory, 'empty.json'), JSON.stringify({ value: empty }), 'utf8')
        await expect(readDurableRecord(home, 'selected')).resolves.toEqual(record)
        await expect(readDurableOrganizations(home)).resolves.toEqual({ selected: record, empty })
        await expect(readDurableRecord(home, 'missing')).rejects.toThrow(/durable organization record/)
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rejects an employee proposal that assigned work or lacks a logged successful receipt', () => {
    const brief = { title: 'Proposal', instructions: 'Details', expectedArtifacts: [], acceptanceCriteria: [] }
    const expected = { tool: 'workspace_propose_task', brief, status: 'draft', receiptHint: 'Awaiting human confirmation.' }
    const before = { aggregate: { tasks: {}, delegationGrants: {}, sessionBindings: { bob: 'session' } }, workflow: { revision: 0, facts: [] } }
    const after = { aggregate: { ...before.aggregate }, workflow: { revision: 1, facts: [{ type: 'workflow/employee/proposed', actor: { type: 'employee', id: 'bob' }, receipt: { draftId: 'draft' }, command: { brief } }], drafts: { draft: { id: 'draft', brief, status: 'draft', source: { type: 'employee', id: 'bob' } } } } }
    const rows = [{ type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'wf-propose-task', name: 'workspace_propose_task', arguments: JSON.stringify({ brief }) }] } } }, { type: 'tool/result', data: { message: { toolCallId: 'wf-propose-task', isError: false, content: [{ type: 'text', text: 'Draft draft: Proposal\nAwaiting human confirmation.' }] } } }]
    expect(() => assertWorkflowProposal(before, after, 'bob', rows, expected)).not.toThrow()
    Reflect.set(after.aggregate, 'tasks', { unauthorized: {} })
    expect(() => assertWorkflowProposal(before, after, 'bob', rows, expected)).toThrow(/assigned/i)
    Reflect.set(after.aggregate, 'tasks', {})
    rows[1]!.data.message.isError = true
    expect(() => assertWorkflowProposal(before, after, 'bob', rows, expected)).toThrow(/receipt/i)
  })
  it('preserves workflow while replacing source creation with the actual Directory import receipt', async () => {
    const host = await workflowRuntime()
    const limits = { maxBytes: 1_000_000, maxEntities: 10_000, maxEvents: 10_000, maxStringBytes: 100_000, maxDepth: 32 }
    try {
      const source = await host.directory.create({ operationId: WorkspaceOperationId('source-creation'), label: 'Source' })
      const seeded = await host.directory.updateAggregate(source.descriptor.id, state => {
        const role = mutateWorkspace(state, { type: 'definition/create', name: 'Import engineer', description: '', instructions: 'Write report' })
        return mutateWorkspace(role.state, { type: 'agent/create', name: 'Source employee', definitionId: role.definitionId }).state
      })
      const agentId = Object.values(seeded.agents)[0]!.id
      const context = { humanId: HumanId('owner'), occurredAt: '2026-10-11T00:00:00.000Z' }
      const drafted = await host.directory.executeWorkflow(source.descriptor.id, { expectedAggregateRevision: seeded.revision, expectedWorkflowRevision: 0, operationId: WorkflowOperationId('draft-operation'), command: { type: 'workflow/draft/create', brief: { title: 'Retained draft', instructions: 'Retained instructions', expectedArtifacts: ['Report'], acceptanceCriteria: ['Reviewed'] } } }, context)
      const confirmed = await host.directory.executeWorkflow(source.descriptor.id, { expectedAggregateRevision: drafted.aggregateRevision, expectedWorkflowRevision: drafted.workflowRevision, operationId: WorkflowOperationId('confirm-operation'), command: { type: 'workflow/draft/confirm', draftId: drafted.value.draftId, expectedDraftRevision: 0, assigneeAgentId: agentId } }, context)
      await host.directory.updateAggregate(source.descriptor.id, state => {
        const started = startTaskDelivery(state, { taskId: confirmed.value.taskId })
        const accepted = acceptTaskDelivery(started.state, { taskId: confirmed.value.taskId, attemptId: started.attemptId, messageId: started.message.id })
        const completed = terminalizeTask(accepted.state, { actorAgentId: agentId, taskId: confirmed.value.taskId, attemptId: started.attemptId, definitionRevisionId: state.agents[agentId]!.definitionRevisionId, result: 'Recorded source result' })
        return { ...completed.state, sessionBindings: { [agentId]: SessionId('source-session') } }
      })
      const before = host.directory.record(source.descriptor.id)
      const exported = createWorkspaceExportV3(before, { exportedAt: '2026-10-11T00:00:00.000Z' })
      expect(exported.document.workspace.descriptor).not.toHaveProperty('creation')
      const prepared = prepareWorkspaceImport(exported.json, { workspaceId: WorkspaceId('candidate'), limits })
      expect(prepared.descriptor).not.toHaveProperty('creation')
      const request = { operationId: WorkspaceOperationId('import-operation'), label: 'Imported', json: exported.json, limits }
      const after = await host.directory.import(request)
      expect(() => assertWorkflowImport(before, after, request)).not.toThrow()
      expect(host.directory.record(source.descriptor.id)).toEqual(before)
      await expect(host.directory.import(request)).resolves.toEqual(after)
      const secondExport = createWorkspaceExportV3(after, { exportedAt: '2026-10-11T00:00:00.000Z' })
      const secondRequest = { ...request, operationId: WorkspaceOperationId('second-import-operation'), label: 'Second imported', json: secondExport.json }
      const second = await host.directory.import(secondRequest)
      expect(() => assertWorkflowImport(after, second, secondRequest)).not.toThrow()
      expect(host.directory.record(after.descriptor.id)).toEqual(after)
      const copiedImportReceipt = structuredClone(second)
      Reflect.set(copiedImportReceipt.descriptor, 'creation', after.descriptor.creation)
      expect(() => assertWorkflowImport(after, copiedImportReceipt, { json: secondRequest.json, label: secondRequest.label })).toThrow(/copied source creation/i)
      for (const creation of [undefined, before.descriptor.creation, { ...after.descriptor.creation, kind: 'created' }, { ...after.descriptor.creation, operationId: 'wrong-operation' }, { ...after.descriptor.creation, requestDigest: '0'.repeat(64) }, { ...after.descriptor.creation, createdAt: 'invalid-date' }]) {
        const damaged = structuredClone(after)
        Reflect.set(damaged.descriptor, 'creation', creation)
        expect(() => assertWorkflowImport(before, damaged, request)).toThrow(/creation|import/i)
      }
      expect(() => assertWorkflowImport(before, after, { ...request, json: exported.json + '\n' })).toThrow(/digest/i)
      expect(() => assertWorkflowImport(before, after, { ...request, label: 'Wrong label' })).toThrow(/label|digest/i)
      const damaged = structuredClone(after)
      Reflect.set(damaged.workflow, 'operations', {})
      expect(() => assertWorkflowImport(before, damaged, request)).toThrow(/workflow/i)
      const copiedSession = structuredClone(after)
      Reflect.set(copiedSession.aggregate, 'sessionBindings', before.aggregate.sessionBindings)
      expect(() => assertWorkflowImport(before, copiedSession, request)).toThrow(/aggregate|Session/i)
      const sourceMessage = structuredClone(after)
      const event = sourceMessage.aggregate.events.find(event => 'messageId' in event)!
      Reflect.set(event, 'messageId', 'source-message')
      expect(() => assertWorkflowImport(before, sourceMessage, request)).toThrow(/aggregate/i)
    } finally { await host.runtime.dispose() }
  })

  it('matches the exact task attempt and complete brief in its logged Session input', () => {
    const brief = { title: 'Work', instructions: 'Detailed instruction', expectedArtifacts: ['Deliverable'], acceptanceCriteria: ['Criterion'] }
    const record = { aggregate: { events: [{ type: 'task/delivery-started', taskId: 'task', taskDeliveryAttemptId: 'attempt', messageId: 'delivery' }], sessionBindings: { agent: 'session' }, taskAssignments: { assignment: { taskId: 'task', assigneeAgentId: 'agent' } } }, workflow: { taskBriefs: { task: { brief } } } }
    const sessions = [{ header: { id: 'session' }, rows: [{ type: 'user/message', data: { id: 'delivery', source: { source: { taskId: 'task' }, taskDeliveryAttemptId: 'attempt' }, content: [{ type: 'text', text: 'Work\n\nInstructions\nDetailed instruction\n\nExpected artifacts\n- Deliverable\n\nAcceptance criteria\n- Criterion' }] } }] }]
    expect(() => assertWorkflowDelivery(record, sessions, 'task', 'attempt', ['Deliverable'], ['UNSELECTED'])).not.toThrow()
    record.workflow.taskBriefs.task.brief.instructions += '\nUNSELECTED'
    sessions[0]!.rows[0]!.data.content[0]!.text = sessions[0]!.rows[0]!.data.content[0]!.text.replace('Detailed instruction', 'Detailed instruction\nUNSELECTED')
    expect(() => assertWorkflowDelivery(record, sessions, 'task', 'attempt', ['Deliverable'], ['UNSELECTED'])).toThrow(/unselected/i)
    expect(() => assertWorkflowDelivery(record, sessions, 'task', 'wrong')).toThrow(/attempt/i)
  })
})
