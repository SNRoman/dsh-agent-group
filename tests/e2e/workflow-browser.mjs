/** Human workflow controls and independent durable evidence for the packed Browser smoke. */
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import canonicalize from 'canonicalize'

export const WORKFLOW_BRIEF = { title: 'WF_REPORT', instructions: 'WF_FULL_INSTRUCTIONS 中文报告', expectedArtifacts: ['WF_EXPECTED_A', 'WF_EXPECTED_B'], acceptanceCriteria: ['WF_CRITERION_A', 'WF_CRITERION_B'] }
export const SELECTED_REFERENCE = 'https://example.invalid/WF_SELECTED'
export const UNSELECTED_REFERENCE = 'E:/WF_UNSELECTED.txt'

/** Observe only Direct unary replies; drain reads before closing the page or saving failure evidence. */
export function observeDirectRpcResponses(page, evidence) {
  const pending = new Set()
  const safeText = text => text.replace(/https?:\/\/[^\s)]+/giu, '<redacted-url>').replace(/Bearer\s+\S+/giu, 'Bearer <redacted>')
  const fields = (value, names) => Object.fromEntries(names.filter(name => Object.hasOwn(value, name) && ['string', 'number', 'boolean'].includes(typeof value[name])).map(name => [name, typeof value[name] === 'string' ? safeText(value[name]) : value[name]]))
  const listener = response => {
    const request = response.request()
    if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/agent-workspace/room/direct/open') return
    const observed = (async () => {
      const entry = { endpoint: 'room/direct/open', httpStatus: response.status() }
      try {
        const sent = request.postDataJSON()
        entry.request = { ...fields(sent, ['type', 'rpcId', 'method']), payload: fields(sent.payload, ['workspaceId', 'expectedRevision', 'agentId']) }
        const received = await response.json()
        const result = received.result
        const error = result.error
        entry.response = { ...fields(received, ['type', 'rpcId']), result: result.ok === false ? { ok: false, error: {
          ...fields(error, ['kind', 'code']),
          message: typeof error.message === 'string' ? safeText(error.message) : undefined,
          details: fields(error.details, ['expectedRevision', 'actualRevision', 'agentId', 'roomId', 'definitionId', 'revisionId']),
        } } : { ...(typeof result.ok === 'boolean' ? { ok: result.ok } : {}), ...fields(result.value ?? {}, ['revision']), ...fields(result.value?.value ?? {}, ['roomId']) } }
      } catch (readError) { entry.responseReadFailed = true } // Raw transport errors may contain authenticated URLs.
      evidence.push(entry)
    })()
    pending.add(observed)
    void observed.finally(() => pending.delete(observed))
  }
  page.on('response', listener)
  return async () => { page.off('response', listener); await Promise.all([...pending]) }
}

/** Wait for the English installed workbench and directory before taking its first snapshot. */
export async function waitForOrganizationReady(dialog, timeout) {
  await dialog.waitFor({ state: 'visible', timeout })
  const element = await dialog.elementHandle()
  assert.ok(element, 'Organization dialog is missing')
  try {
    const result = await dialog.page().waitForFunction(root => {
      if (root.querySelector('[role="alert"]')) return 'failed'
      const directory = root.querySelector('select[aria-label="Organization"]')
      const conversations = [...root.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Conversations')
      return directory && !directory.disabled && directory.value !== '' && directory.selectedOptions.length === 1 && directory.getClientRects().length > 0
        && conversations && !conversations.disabled && conversations.getClientRects().length > 0 ? 'ready' : false
    }, element, { timeout })
    try { assert.equal(await result.jsonValue(), 'ready', 'Organization startup failed') }
    finally { await result.dispose() }
  } finally { await element.dispose() }
}

/** Read the complete durable record from either profile storage layout. */
export async function readDurableRecord(dshHome, workspaceId = 'local') {
  try {
    const document = JSON.parse(await readFile(join(dshHome, 'storages', 'agent_workspace.json'), 'utf8'))
    const record = document.tables.workspaces[workspaceId]
    assert.ok(record, 'selected organization is missing')
    return record
  } catch (singleError) {
    try {
      const document = JSON.parse(await readFile(join(dshHome, 'storages', 'agent_workspace', 'workspaces', `${workspaceId}.json`), 'utf8'))
      return document.value ?? document
    } catch (recordError) { throw new AggregateError([singleError, recordError], 'could not read the durable organization record') }
  }
}

/** Read all complete organizations, including inactive and empty organizations. */
export async function readDurableOrganizations(dshHome) {
  let ids
  try {
    const document = JSON.parse(await readFile(join(dshHome, 'storages', 'agent_workspace.json'), 'utf8'))
    ids = Object.keys(document.tables.workspaces)
  } catch (singleError) {
    try { ids = (await readdir(join(dshHome, 'storages', 'agent_workspace', 'workspaces'))).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)) }
    catch (recordError) { throw new AggregateError([singleError, recordError], 'could not enumerate durable organizations') }
  }
  return Object.fromEntries(await Promise.all(ids.map(async id => [id, await readDurableRecord(dshHome, id)])))
}

/** Keep every old log and organization exact; admit at most one fresh profile-owned core UI blank. */
export function assertWorkflowRestartQuiescence(before, after, coreWorkspace, beforeOrganizations, afterOrganizations) {
  assert.deepEqual(afterOrganizations, beforeOrganizations, 'Host restart changed complete organization records or employee Session bindings')
  const prior = new Map(before.map(session => [session.header.id, session]))
  const current = new Map(after.map(session => [session.header.id, session]))
  assert.equal(prior.size, before.length, 'duplicate baseline Session identity')
  assert.equal(current.size, after.length, 'duplicate current Session identity')
  for (const [id, session] of prior) assert.deepEqual(current.get(id), session, `Host restart changed or removed old Session ${id}`)
  const added = after.filter(session => !prior.has(session.header.id))
  assert.ok(added.length <= 1, 'one page load created multiple new Sessions')
  for (const { header, rows } of added) {
    const { id, createdAt, ...metadata } = header
    assert.match(id, /^session-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u, 'new Session is not a core generated identity')
    assert.deepEqual(metadata, { type: 'session', version: 4, cwd: coreWorkspace, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }, 'new Session is not the exact profile core workspace blank')
    assert.ok(Number.isSafeInteger(createdAt) && createdAt >= 0 && before.every(session => createdAt >= session.header.createdAt), 'new core Session creation time is invalid')
    const settings = [{ type: 'permission/preset', data: { preset: 'workspace-write' } }, { type: 'sandbox/mode', data: { mode: 'workspace-write' } }, { type: 'approval/policy', data: { policy: 'ask' } }]
    assert.equal(rows.length, settings.length, 'new core Session contains execution or missing initial settings')
    let previousTime = createdAt
    rows.forEach((row, seq) => {
      const { time, ...event } = row
      assert.deepEqual(event, { ...settings[seq], seq }, 'new core Session differs from exact profile initial settings')
      assert.ok(Number.isSafeInteger(time) && time >= previousTime, 'new core Session event time is invalid')
      previousTime = time
    })
  }
  return { preservedSessionIds: [...prior.keys()], blankCoreSessionIds: added.map(session => session.header.id) }
}

/** Verify preserved business history and the committed local receipt for this exact import request. */
export function assertWorkflowImport(before, after, request) {
  assert.equal(after.recordVersion, 3)
  assert.notEqual(after.descriptor.id, before.descriptor.id)
  assert.equal(after.descriptor.lifecycle, before.descriptor.lifecycle)
  assert.equal(after.descriptor.label, request.label ?? before.descriptor.label, 'import label differs from the submitted request')
  const creation = after.descriptor.creation
  assert.ok(creation, 'committed import creation receipt is missing')
  assert.deepEqual(Object.keys(creation).sort(), ['createdAt', 'kind', 'operationId', 'requestDigest'], 'invalid import creation fields')
  assert.equal(creation.kind, 'imported', 'creation kind does not identify this import')
  assert.ok(typeof creation.operationId === 'string' && creation.operationId.trim() !== '', 'import operation identity is missing')
  if (request.operationId !== undefined) assert.equal(creation.operationId, request.operationId, 'creation belongs to another import operation')
  if (before.descriptor.creation !== undefined) {
    assert.notDeepEqual(creation, before.descriptor.creation, 'import copied source creation metadata')
    assert.notEqual(creation.operationId, before.descriptor.creation.operationId, 'import reused the source creation operation')
  }
  assert.ok(typeof creation.createdAt === 'string' && Number.isFinite(Date.parse(creation.createdAt)), 'import creation time is invalid')
  assert.equal(new Date(creation.createdAt).toISOString(), creation.createdAt, 'import creation time is not canonical')
  const sourceDigest = createHash('sha256').update(request.json).digest('hex')
  const requestDigest = createHash('sha256').update(canonicalize({ kind: 'imported', label: request.label ?? null, sourceDigest })).digest('hex')
  assert.equal(creation.requestDigest, requestDigest, 'import creation digest does not match exact source bytes and submitted label')
  assert.deepEqual(after.workflow, before.workflow, 'import changed workflow history')
  const expectedCommunication = structuredClone(before.communication)
  for (const context of Object.values(expectedCommunication.contexts)) delete context.sessionId
  for (const checkpoint of Object.values(expectedCommunication.fileCheckpoints)) {
    for (const field of ['before', 'after']) if (checkpoint[field].existed) checkpoint[field].blobId = `portable-unavailable:${checkpoint[field].sha256}`
    checkpoint.restore = { status: 'unavailable', reason: 'checkpoint bytes are not included in portable backups' }
  }
  assert.deepEqual(after.communication, expectedCommunication, 'import changed communication history or retained local byte/session references')
  assert.deepEqual(after.aggregate, { ...before.aggregate, workspaceId: after.descriptor.id, sessionBindings: {}, events: before.aggregate.events.map(event => 'messageId' in event ? { ...event, messageId: `agent-workspace-task:${after.descriptor.id}:${event.taskDeliveryAttemptId}` } : event) }, 'import changed aggregate history or local Session identities')
}

/** Check the exact attempt's logged user message, including complete persisted brief. */
export function assertWorkflowDelivery(record, sessions, taskId, attemptId, included = [], excluded = []) {
  const starts = record.aggregate.events.filter(event => event.type === 'task/delivery-started' && event.taskId === taskId && event.taskDeliveryAttemptId === attemptId)
  assert.equal(starts.length, 1, 'missing exact delivery attempt')
  const assignment = Object.values(record.aggregate.taskAssignments).find(value => value.taskId === taskId)
  assert.ok(assignment, 'missing task assignment')
  const session = sessions.find(value => value.header.id === record.aggregate.sessionBindings[assignment.assigneeAgentId])
  assert.ok(session, 'missing assignee Session')
  const deliveries = session.rows.filter(row => row.type === 'user/message' && row.data.id === starts[0].messageId)
  assert.equal(deliveries.length, 1, 'missing exact Session delivery')
  const message = deliveries[0].data
  assert.equal(message.source.source.taskId, taskId)
  assert.equal(message.source.taskDeliveryAttemptId, attemptId)
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  const confirmed = record.workflow.taskBriefs[taskId]
  assert.ok(confirmed, 'missing persisted full brief')
  const { brief, handoff } = confirmed
  const list = values => values.length === 0 ? '' : `- ${values.join('\n- ')}`
  let expected = `${brief.title}\n\nInstructions\n${brief.instructions}\n\nExpected artifacts\n${list(brief.expectedArtifacts)}\n\nAcceptance criteria\n${list(brief.acceptanceCriteria)}`
  if (handoff) {
    expected += `\n\nHandoff context\nSource result: ${handoff.result.taskId} / ${handoff.result.eventId} / ${handoff.result.attemptId} (${handoff.type})\n${handoff.text}`
    if (handoff.reviewComment !== undefined) expected += `\nReview comment: ${handoff.reviewComment}`
    for (const artifact of handoff.artifacts) expected += `\n- ${artifact.label}: ${artifact.summary}${artifact.reference ? `\n  ${artifact.reference.kind}: ${artifact.reference.value}` : ''}`
  }
  assert.equal(text, expected, 'Session input differs from the complete persisted brief')
  for (const token of included) assert.ok(text.includes(token), `missing selected input ${token}`)
  for (const token of excluded) assert.ok(!text.includes(token), `unselected artifact entered successor input: ${token}`)
  return { taskId, attemptId, sessionId: session.header.id, messageId: message.id, text }
}

/** Authenticate a pending draft against its live employee's recorded proposal call and result. */
export function assertWorkflowProposal(before, after, agentId, rows, expected) {
  assert.deepEqual(after.aggregate.tasks, before.aggregate.tasks, 'employee proposal assigned work')
  assert.deepEqual(after.aggregate.delegationGrants, before.aggregate.delegationGrants, 'employee proposal delegated authority')
  assert.deepEqual(after.aggregate.sessionBindings, before.aggregate.sessionBindings, 'employee proposal materialized another employee')
  assert.equal(after.workflow.revision, before.workflow.revision + 1)
  const facts = after.workflow.facts.slice(before.workflow.facts.length)
  assert.equal(facts.length, 1)
  const fact = facts[0]
  assert.equal(fact.type, 'workflow/employee/proposed')
  assert.deepEqual(fact.actor, { type: 'employee', id: agentId })
  assert.deepEqual(fact.command, { brief: expected.brief })
  const draft = after.workflow.drafts[fact.receipt.draftId]
  assert.ok(draft)
  assert.deepEqual(draft.brief, expected.brief)
  assert.equal(draft.status, expected.status)
  assert.deepEqual(draft.source, { type: 'employee', id: agentId })
  assert.equal(Object.hasOwn(draft, 'taskId'), false)
  const calls = rows.filter(row => row.type === 'assistant/message').flatMap(row => row.data?.message?.content ?? []).filter(block => block.type === 'tool-call' && block.id === 'wf-propose-task')
  const results = rows.filter(row => row.type === 'tool/result' && (row.data?.message?.toolCallId === 'wf-propose-task' || row.data?.message?.source?.callId === 'wf-propose-task'))
  assert.equal(calls.length, 1, 'missing unique real proposal call')
  assert.equal(calls[0].name, expected.tool)
  assert.deepEqual(JSON.parse(calls[0].arguments), { brief: expected.brief })
  assert.equal(results.length, 1, 'missing unique proposal receipt')
  const result = results[0].data.message
  const payload = result.toolCallId === undefined ? result.content[0] : result
  assert.equal(payload.toolCallId, 'wf-propose-task')
  assert.notEqual(payload.isError, true, 'proposal receipt failed')
  assert.deepEqual(payload.content, [{ type: 'text', text: `Draft ${draft.id}: ${expected.brief.title}\n${expected.receiptHint}` }], 'proposal receipt exposed data beyond its bounded pending-human summary')
  assert.ok(rows.indexOf(results[0]) > rows.findIndex(row => row.type === 'assistant/message' && row.data.message.content.some(block => block.id === calls[0].id)), 'proposal result preceded its call')
  return { draft, calls, results }
}

/** Exercise human workflow controls using two passive profile-seeded drafts; durable reads determine completion. */
export async function runWorkflowScenario(dialog, io) {
  await dialog.getByRole('button', { name: 'Conversations', exact: true }).click()
  await dialog.getByRole('button', { name: /^Release room \d+$/u }).click()
  const showWorkflow = async () => {
    await dialog.getByRole('button', { name: 'Tasks', exact: true }).click()
    const settings = dialog.locator('.dsh-agent-group-work-settings')
    if (await settings.getAttribute('open') === null) await settings.locator(':scope > summary').click()
  }
  await showWorkflow()
  const view = dialog.getByRole('region', { name: 'Workflow', exact: true })
  const button = name => view.getByRole('button', { name, exact: true })
  const select = name => view.getByRole('combobox', { name, exact: true })
  const fillBrief = async brief => {
    await view.getByRole('textbox', { name: 'Work title', exact: true }).fill(brief.title)
    await view.getByRole('textbox', { name: 'Full instructions', exact: true }).fill(brief.instructions)
    await view.getByRole('textbox', { name: 'Expected artifacts (one per line)', exact: true }).fill(brief.expectedArtifacts.join('\n'))
    await view.getByRole('textbox', { name: 'Acceptance criteria (one per line)', exact: true }).fill(brief.acceptanceCriteria.join('\n'))
  }
  const refresh = async () => { await button('Refresh workflow').click(); await button('Refresh workflow').waitFor({ state: 'visible' }); await dialog.page().waitForFunction(element => !element.disabled, await button('Refresh workflow').elementHandle()) }
  const mutate = async (name, endpoint) => {
    const before = await io.read()
    await button(name).click()
    const after = await io.wait(record => record.workflow.revision > before.workflow.revision, endpoint)
    const facts = after.workflow.facts.slice(before.workflow.facts.length)
    assert.equal(facts.length, 1, `${endpoint} appended unexpected facts`)
    assert.equal(facts[0].type, endpoint)
    const operation = Object.values(after.workflow.operations).find(value => value.workflowRevision === after.workflow.revision)
    assert.ok(operation, 'missing durable operation receipt')
    assert.deepEqual(operation.receipt, { type: endpoint, value: facts[0].receipt })
    await refresh()
    return { record: after, value: facts[0].receipt }
  }
  const open = async name => { const summary = view.locator('summary').filter({ hasText: new RegExp(`^${name}$`, 'u') }); if (await summary.locator('..').getAttribute('open') === null) await summary.click() }
  const baseline = await io.read()
  const initialDraft = Object.values(baseline.workflow.drafts).find(draft => draft.brief.title === WORKFLOW_BRIEF.title && draft.brief.instructions === 'WF_BEFORE_EDIT')
  const disposable = Object.values(baseline.workflow.drafts).find(draft => draft.brief.title === 'WF_DISCARD')
  assert.ok(initialDraft && disposable, 'profile passive drafts are missing')
  for (const draft of [initialDraft, disposable]) {
    assert.equal(draft.status, 'draft')
    assert.equal(Object.hasOwn(draft, 'taskId'), false, 'profile passive draft started work')
  }
  await select('Draft selection').selectOption(initialDraft.id)
  await fillBrief(WORKFLOW_BRIEF)
  const edited = await mutate('Save draft changes', 'workflow/draft/edit')
  assert.deepEqual(edited.record.aggregate, baseline.aggregate, 'draft edit assigned or woke work')
  const confirm = async draftId => {
    await select('Draft selection').selectOption(draftId)
    const prior = await io.read()
    await button('Confirm in chat').click()
    const assignee = dialog.getByRole('combobox', { name: 'Assignee', exact: true })
    await assignee.waitFor({ state: 'visible' })
    assert.equal(await assignee.inputValue(), '')
    assert.equal(await dialog.getByRole('button', { name: 'Send and assign', exact: true }).isEnabled(), false, 'confirmation did not require an explicit assignee')
    assert.deepEqual((await io.read()).aggregate, prior.aggregate, 'bringing a draft to chat started work')
    await assignee.selectOption({ label: 'Bob' })
    assert.equal(await dialog.locator('[data-allow-delegation]').isChecked(), false)
    await dialog.getByRole('button', { name: 'Send and assign', exact: true }).click()
    const record = await io.wait(value => value.workflow.drafts[draftId]?.status === 'confirmed', 'chat workflow confirmation')
    const operation = Object.values(record.communication.operations).find(value => value.command.type === 'communication/confirm' && value.command.draftId === draftId)
    assert.ok(operation, 'chat confirmation omitted its durable operation receipt')
    const result = { record, value: operation.receipt }
    const facts = record.workflow.facts.slice(prior.workflow.facts.length)
    assert.equal(facts.length, 1)
    assert.equal(facts[0].type, 'workflow/draft/confirm')
    assert.equal(result.record.workflow.drafts[draftId].taskId, result.value.taskId)
    const assignment = result.record.aggregate.taskAssignments[result.value.taskAssignmentId]
    assert.equal(assignment.taskId, result.value.taskId)
    assert.equal(assignment.assigneeAgentId, Object.values(result.record.aggregate.agents).find(agent => agent.name === 'Bob').id)
    const settled = await io.wait(record => record.aggregate.events.some(event => event.type === 'task/result' && event.taskId === result.value.taskId), 'workflow task result')
    const event = settled.aggregate.events.find(event => event.type === 'task/result' && event.taskId === result.value.taskId)
    assert.equal(event.text, `WF_RESULT ${event.taskId} ${event.taskDeliveryAttemptId}`)
    assert.equal(settled.aggregate.tasks[event.taskId].status, 'completed')
    await showWorkflow()
    await refresh()
    await open('Results, artifacts and review')
    return { record: settled, result: { taskId: event.taskId, eventId: event.id, attemptId: event.taskDeliveryAttemptId } }
  }
  const first = await confirm(initialDraft.id)
  await open('Results, artifacts and review')
  await select('Exact result selection').selectOption(first.result.eventId)
  const register = async (label, kind, value) => {
    await view.getByRole('textbox', { name: 'Artifact label', exact: true }).fill(label)
    await view.getByRole('textbox', { name: 'Artifact summary', exact: true }).fill(`${label}_SUMMARY`)
    await select('Artifact reference type').selectOption(kind)
    await view.getByRole('textbox', { name: 'Reference value', exact: true }).fill(value)
    return await mutate('Register artifact for this result', 'workflow/artifact/register')
  }
  await register('WF_SELECTED', 'url', SELECTED_REFERENCE)
  const unselected = await register('WF_UNSELECTED', 'path', UNSELECTED_REFERENCE)
  for (const artifact of Object.values(unselected.record.workflow.artifacts)) assert.deepEqual(artifact.result, first.result)
  await select('Human review decision').selectOption('changes-requested')
  await select('Continuation source chat').selectOption({ label: 'Release room' })
  await view.getByRole('textbox', { name: 'Review comment', exact: true }).fill('WF_REWORK_COMMENT')
  const rework = await mutate('Submit review for this result', 'workflow/result/review')
  assert.deepEqual(rework.record.workflow.reviews[rework.value.reviewId].result, first.result)
  assert.deepEqual(rework.record.aggregate, unselected.record.aggregate, 'changes request executed without confirmation')
  const second = await confirm(rework.value.draftId)
  assert.notEqual(second.result.taskId, first.result.taskId)
  assert.notEqual(second.result.attemptId, first.result.attemptId)
  await select('Exact result selection').selectOption(second.result.eventId)
  const selectedSuccessor = await register('WF_SELECTED', 'url', SELECTED_REFERENCE)
  const latestArtifacts = await register('WF_UNSELECTED', 'path', UNSELECTED_REFERENCE)
  assert.deepEqual(latestArtifacts.record.workflow.artifacts[selectedSuccessor.value.artifactId].result, second.result)
  await select('Human review decision').selectOption('accepted')
  await view.getByRole('textbox', { name: 'Review comment', exact: true }).fill('WF_ACCEPTED')
  const accepted = await mutate('Submit review for this result', 'workflow/result/review')
  assert.deepEqual(accepted.record.workflow.reviews[accepted.value.reviewId].result, second.result)
  await view.getByRole('checkbox', { name: /^WF_SELECTED ·/u }).check()
  assert.equal(await view.getByRole('checkbox', { name: /^WF_UNSELECTED ·/u }).isChecked(), false)
  await select('Continuation source chat').selectOption({ label: 'Release room' })
  const handoff = await mutate('Create handoff draft with selected artifacts', 'workflow/result/handoff')
  assert.deepEqual(handoff.record.workflow.drafts[handoff.value.draftId].source.artifactIds, [selectedSuccessor.value.artifactId])
  assert.deepEqual(handoff.record.workflow.drafts[handoff.value.draftId].source.result, second.result)
  const successor = await confirm(handoff.value.draftId)
  const deliveries = await io.sessionEvidence(sessions => [assertWorkflowDelivery(successor.record, sessions, first.result.taskId, first.result.attemptId), assertWorkflowDelivery(successor.record, sessions, second.result.taskId, second.result.attemptId, ['WF_REWORK_COMMENT']), assertWorkflowDelivery(successor.record, sessions, successor.result.taskId, successor.result.attemptId, [SELECTED_REFERENCE], [UNSELECTED_REFERENCE, 'WF_UNSELECTED'])])

  let passive = await io.read()
  await select('Draft selection').selectOption(disposable.id)
  const discarded = await mutate('Discard draft', 'workflow/draft/discard')
  assert.equal(discarded.record.workflow.drafts[disposable.id].status, 'discarded')
  await open('Task templates')
  await view.getByRole('textbox', { name: 'Task template name', exact: true }).fill('WF_TASK_TEMPLATE')
  await fillBrief({ ...WORKFLOW_BRIEF, title: 'WF_PINNED_OLD' })
  const template = await mutate('Create task template', 'workflow/task-template/create')
  await select('Task template selection').selectOption(template.value.templateId)
  await fillBrief({ ...WORKFLOW_BRIEF, title: 'WF_PINNED_NEW' })
  await mutate('Save task template revision', 'workflow/task-template/revise')
  await select('Task template revision').selectOption(template.value.templateRevisionId)
  const beforeTemplateChat = await io.read()
  assert.deepEqual(beforeTemplateChat.aggregate, passive.aggregate, 'passive draft/template paths assigned or woke work')
  assert.deepEqual(beforeTemplateChat.workflow.taskTemplateRevisions[template.value.templateRevisionId], template.record.workflow.taskTemplateRevisions[template.value.templateRevisionId], 'revising a template changed its selected historical revision')
  await button('Bring template to chat').click()
  const composer = dialog.getByRole('textbox', { name: 'Send message', exact: true })
  await composer.waitFor({ state: 'visible' })
  assert.equal(await composer.inputValue(), WORKFLOW_BRIEF.instructions)
  assert.deepEqual(await io.read(), beforeTemplateChat, 'bringing a template to chat wrote work or materialized an employee')
  await dialog.getByRole('combobox', { name: 'Assignee', exact: true }).selectOption({ label: 'Bob' })
  assert.equal(await dialog.locator('[data-allow-delegation]').isChecked(), false)
  await dialog.getByRole('button', { name: 'Send and assign', exact: true }).click()
  const applied = await io.wait(record => Object.values(record.workflow.drafts).some(draft => draft.brief.title === 'WF_PINNED_OLD' && draft.status === 'confirmed'), 'template brief chat confirmation')
  const appliedDraft = Object.values(applied.workflow.drafts).find(draft => draft.brief.title === 'WF_PINNED_OLD' && draft.status === 'confirmed')
  assert.deepEqual(appliedDraft.brief, beforeTemplateChat.workflow.taskTemplateRevisions[template.value.templateRevisionId].brief)
  assert.equal(Object.hasOwn(appliedDraft, 'templateRevisionId'), false, 'chat template copy falsely claimed a pinned apply operation')
  const templateSettled = await io.wait(record => record.aggregate.events.some(event => event.type === 'task/result' && event.taskId === appliedDraft.taskId), 'template chat result')
  const templateResult = templateSettled.aggregate.events.find(event => event.type === 'task/result' && event.taskId === appliedDraft.taskId)
  deliveries.push(await io.sessionEvidence(sessions => assertWorkflowDelivery(templateSettled, sessions, templateResult.taskId, templateResult.taskDeliveryAttemptId)))
  passive = templateSettled
  await showWorkflow()
  await refresh()

  await open('Company configuration templates')
  await view.getByRole('textbox', { name: 'Company template name', exact: true }).fill('WF_COMPANY_TEMPLATE')
  await button('Add configured colleague').click()
  await view.getByRole('textbox', { name: 'New colleague name', exact: true }).fill('WF_COLLEAGUE')
  const role = Object.values(passive.aggregate.definitionRevisions).find(revision => revision.number === 1 && passive.aggregate.definitions[revision.definitionId].name === 'Release engineer')
  await select('Pinned role revision').selectOption(role.id)
  await button('Add configured group').click()
  await view.getByRole('textbox', { name: 'New group name', exact: true }).fill('WF_GROUP_OLD')
  await view.getByRole('checkbox', { name: 'WF_COLLEAGUE', exact: true }).check()
  const company = await mutate('Create company template', 'workflow/company-template/create')
  await select('Company template selection').selectOption(company.value.templateId)
  await view.getByRole('textbox', { name: 'New group name', exact: true }).fill('WF_GROUP')
  const revised = await mutate('Save company template revision', 'workflow/company-template/revise')
  await select('Company template revision').selectOption(revised.value.templateRevisionId)
  await button('Preview selected company revision').click()
  await view.getByRole('checkbox', { name: 'I confirm: observe only new events after joining, without copying history or waking colleagues.', exact: true }).waitFor({ state: 'visible' })
  assert.equal(await button('Confirm company configuration').isEnabled(), false)
  assert.deepEqual((await io.read()).aggregate, passive.aggregate, 'company template or preview created employees')
  await view.getByRole('checkbox', { name: 'I confirm: observe only new events after joining, without copying history or waking colleagues.', exact: true }).check()
  const configured = await mutate('Confirm company configuration', 'workflow/company-template/confirm')
  assert.deepEqual(configured.record.aggregate.tasks, passive.aggregate.tasks)
  assert.deepEqual(configured.record.aggregate.delegationGrants, passive.aggregate.delegationGrants)
  assert.deepEqual(configured.record.aggregate.sessionBindings, passive.aggregate.sessionBindings)
  assert.equal(configured.value.agentIds.length, 1)
  assert.equal(configured.value.roomIds.length, 1)
  assert.equal(configured.value.membershipIds.length, 1)
  const member = configured.record.aggregate.memberships[configured.value.membershipIds[0]]
  assert.equal(member.agentId, configured.value.agentIds[0])
  assert.equal(member.roomId, configured.value.roomIds[0])
  assert.deepEqual(member.memoryStart, { type: 'new-events' })
  for (const id of configured.value.agentIds) { assert.equal(configured.record.aggregate.agents[id].definitionRevisionId, role.id); assert.equal(configured.record.aggregate.memoryEntries.some(entry => entry.agentId === id), false) }
  assert.equal(Object.values(configured.record.aggregate.rooms).some(room => room.name === 'WF_GROUP_OLD'), false)
  await open('Task templates')
  await select('Task template selection').selectOption(template.value.templateId)
  await io.capture('workflow-human-confirmation', view, ['WF_TASK_TEMPLATE', 'WF_COMPANY_TEMPLATE'])
  return { deliveries, first: first.result, second: second.result, successor: successor.result, record: configured.record }
}
