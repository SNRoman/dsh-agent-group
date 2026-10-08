/** Browser-visible release smoke shared by packed and exact-registry installs. */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { watch, existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { assertBrowserDurableEvidence, inspectSafeDelegationDenial, isRecordedToolError, assertTaskCausality, assertMemoryRows, assertSubsetRevisionEvidence, assertExactStopEvidence, assertRestartPersistence } from '../../scripts/release-smoke-contract.mjs'

const STEP_TIMEOUT_MS = 30_000
const CORE_SESSION_SENTINEL = 'CORE_SESSION_SENTINEL'
const CORE_REPLY = 'CORE_REPLY'
const V020_ROOT = 'V020_ROOT V020_DELEGATE'
const V020_CHILD = 'V020_CHILD'
const V020_HOLD = 'V020_HOLD'
const TASK_TOOL_EXPECTED = new URL('../fixtures/task-tools/profile-session.expected.json', import.meta.url)

function parseArgs(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid browser-smoke argument near ${key ?? '<end>'}`)
    values.set(key.slice(2), value)
  }
  for (const key of ['url', 'dsh-home', 'evidence', 'gate', 'workspace', 'phase', 'task-tools-fixture']) {
    if (!values.has(key)) throw new Error(`missing --${key}`)
  }
  const args = Object.fromEntries(values)
  if (!['installed', 'after-restart', 'after-uninstall'].includes(args.phase)) {
    throw new Error('--phase must be installed, after-restart, or after-uninstall')
  }
  return args
}

function redact(value) {
  return value.replace(/([?&]token=)[^\s&)]+/gu, '$1<redacted>')
}

async function stableAria(locator) {
  await locator.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
  return await locator.ariaSnapshot()
}

function toMatchAriaSnapshot(actual, required) {
  for (const token of required) {
    if (!actual.includes(token)) throw new Error(`ARIA snapshot is missing ${JSON.stringify(token)}`)
  }
}

async function capture(state, label, locator, required = []) {
  const aria = await stableAria(locator)
  toMatchAriaSnapshot(aria, required)
  state.snapshots.push({ label, aria })
  await writeFile(join(state.evidence, `${state.prefix}aria-snapshots.json`), `${JSON.stringify(state.snapshots, null, 2)}\n`, 'utf8')
}

async function readDurableWorkspace(dshHome) {
  const singlePath = join(dshHome, 'storages', 'agent_workspace.json')
  try {
    const document = JSON.parse(await readFile(singlePath, 'utf8'))
    return document.tables.workspaces.local
  } catch (singleError) {
    const recordPath = join(dshHome, 'storages', 'agent_workspace', 'workspaces', 'local.json')
    try {
      const document = JSON.parse(await readFile(recordPath, 'utf8'))
      return document.value ?? document
    } catch (recordError) {
      throw new AggregateError([singleError, recordError], 'could not read the durable Agent Workspace aggregate')
    }
  }
}

async function waitForIdle(dialog) {
  await Promise.all([
    dialog.getByText('Working…', { exact: true }).waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS }),
    dialog.getByText('Agents working…', { exact: true }).waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS }),
  ])
}

async function waitForDurableMessage(dshHome, text) {
  return await waitForDurableWorkspace(dshHome, workspace => (
    workspace.events.some(event => event.type === 'room/message' && event.text === text)
  ), `record ${JSON.stringify(text)}`)
}

async function waitForDurableAgentMemory(dshHome, agentName, text) {
  return await waitForDurableWorkspace(dshHome, workspace => {
    const agent = Object.values(workspace.agents).find(candidate => candidate.name === agentName)
    const event = workspace.events.find(candidate => candidate.type === 'room/message' && candidate.text === text)
    return agent !== undefined && event !== undefined
      && workspace.memoryEntries.some(entry => entry.agentId === agent.id && entry.eventId === event.id)
  }, `record ${JSON.stringify(text)} in ${agentName}'s memory`)
}

async function waitForDurableWorkspace(dshHome, predicate, description) {
  const paths = [
    join(dshHome, 'storages', 'agent_workspace.json'),
    join(dshHome, 'storages', 'agent_workspace', 'workspaces', 'local.json'),
  ]
  const path = paths.find(candidate => existsSync(candidate))
  if (path === undefined) throw new Error('durable Agent Workspace file is unavailable')
  return await new Promise((resolveWorkspace, reject) => {
    let settled = false
    let reading = false
    let rerun = false
    let watcher
    let timer
    const finish = (error, workspace) => {
      if (settled) return
      settled = true
      watcher?.close()
      clearTimeout(timer)
      if (error === undefined) resolveWorkspace(workspace)
      else reject(error)
    }
    const check = async () => {
      if (reading) { rerun = true; return }
      reading = true
      try {
        do {
          rerun = false
          try {
            const workspace = await readDurableWorkspace(dshHome)
            if (await predicate(workspace)) return finish(undefined, workspace)
          } catch (error) {
            if (!isTransientWorkspaceRead(error)) return finish(error)
          }
        } while (rerun)
      } finally {
        reading = false
      }
    }
    watcher = watch(dirname(path), (_event, filename) => {
      if (filename === null || String(filename) === basename(path)) void check()
    })
    watcher.once('error', error => finish(error))
    timer = setTimeout(() => finish(new Error(`durable workspace did not settle ${description}`)), STEP_TIMEOUT_MS)
    timer.unref()
    void check()
  })
}

function isTransientWorkspaceRead(error) {
  return error instanceof AggregateError || (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
}

async function jsonlFiles(root) {
  const files = []
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && /^session(?:\.v\d+)?\.jsonl$/u.test(entry.name)) files.push(path)
    }
  }
  await visit(root)
  return files
}

async function taskToolSessionRows(dshHome) {
  const contents = await Promise.all((await jsonlFiles(join(dshHome, 'sessions'))).map(path => readFile(path, 'utf8')))
  return contents.flatMap(content => content.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line)))
}

async function durableSessions(dshHome) {
  return await Promise.all((await jsonlFiles(join(dshHome, 'sessions'))).map(async path => {
    const [header, ...rows] = (await readFile(path, 'utf8')).split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line))
    if (header?.type !== 'session') throw new Error('missing durable Session header')
    return { header, rows }
  }))
}

async function waitForTaskCausality(dshHome, workspace) {
  const deadline = Date.now() + STEP_TIMEOUT_MS
  let lastError
  while (Date.now() < deadline) {
    try {
      return assertTaskCausality(workspace, await durableSessions(dshHome))
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  throw new Error(`durable task Session evidence did not settle: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

function waitForFixtureReceipt(path) {
  return new Promise((resolveReceipt, reject) => {
    let watcher
    let timer
    const finish = (error, value) => {
      watcher?.close()
      clearTimeout(timer)
      if (error) reject(error)
      else resolveReceipt(value)
    }
    const check = () => {
      if (!existsSync(path)) return
      let receipt
      try { receipt = JSON.parse(readFileSync(path, 'utf8')) } catch { return }
      finish(undefined, receipt)
    }
    watcher = watch(dirname(path), check)
    watcher.once('error', error => finish(error))
    timer = setTimeout(() => finish(new Error(`fixture receipt did not arrive: ${basename(path)}`)), STEP_TIMEOUT_MS)
    check()
  })
}

async function openRuntime(dialog, taskTitle) {
  await dialog.getByRole('button', { name: 'Open runtime activity', exact: true }).click()
  const drawer = dialog.getByRole('dialog', { name: 'Runtime activity', exact: true })
  const source = `Task: ${taskTitle}`
  const activity = drawer.getByRole('button', { name: new RegExp(`^${source} (Responding|Stopping|Settled|Queued)$`, 'u') })
  await activity.click()
  await dialog.page().waitForFunction(
    element => element.getAttribute('aria-pressed') === 'true',
    await activity.elementHandle(),
    { timeout: STEP_TIMEOUT_MS },
  )
  return drawer
}

async function assertTaskToolEvidence(durable, args) {
  const expected = JSON.parse(await readFile(TASK_TOOL_EXPECTED, 'utf8'))
  const fixture = JSON.parse(await readFile(args['task-tools-fixture'], 'utf8'))
  const completed = durable.events.filter(event => (
    event.type === 'task/result' && event.text === expected.result
  ))
  if (completed.length !== 1) {
    throw new Error(`expected one durable task-tool result; found ${completed.length}`)
  }
  const task = durable.tasks[completed[0].taskId]
  if (task?.status !== 'completed') throw new Error('task-tool result did not complete its task')
  const rows = await taskToolSessionRows(args['dsh-home'])
  const serializedRows = rows.map(row => JSON.stringify(row))
  for (const name of expected.tools) {
    if (!serializedRows.some(row => row.includes(name))) throw new Error(`recorded Session omitted model-visible ${name} schema or call`)
  }
  if (!serializedRows.some(row => row.includes(expected.result))) throw new Error('recorded Session omitted successful task-tool result')
  const denied = rows.filter(row => isRecordedToolError(
    row,
    'profile-policy-denial',
    `Error: ${expected.policyError}`,
  ))
  if (denied.length !== 1) throw new Error(`expected one recorded policy denial; found ${denied.length}`)
  for (const id of [fixture.taskId, fixture.deniedAssigneeAgentId]) {
    if (JSON.stringify(denied[0]).includes(id)) throw new Error('recorded policy denial leaked a workspace identifier')
  }
  if (inspectSafeDelegationDenial(rows, durable) === undefined) throw new Error('missing recorded v0.2 delegation denial')
  await writeFile(join(args.evidence, 'task-tools-recorded-session.json'), `${JSON.stringify({
    tools: expected.tools,
    result: expected.result,
    policyError: expected.policyError,
    policyResultRows: denied.length,
  }, null, 2)}\n`, 'utf8')
}

async function send(dialog, text) {
  const composer = dialog.getByPlaceholder(/Write (?:a message|a direct message)/u)
  await composer.pressSequentially(text)
  await dialog.getByRole('button', { name: 'Send', exact: true }).click()
  await dialog.page().waitForFunction(element => element.value === '', await composer.elementHandle(), { timeout: STEP_TIMEOUT_MS })
  const failure = dialog.getByText(/^Workspace request failed:/u)
  if (await failure.count() > 0) throw new Error(await failure.first().innerText())
  await dialog.getByRole('main').getByText(text, { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
}

async function createDefinitionAndAgents(dialog) {
  await dialog.getByRole('button', { name: 'Colleagues', exact: true }).click()
  await dialog.getByRole('button', { name: 'New definition', exact: true }).click()
  await dialog.getByPlaceholder('For example: Java engineer', { exact: true }).fill('Release engineer')
  await dialog.getByPlaceholder('What is this role responsible for?', { exact: true }).fill('Verify the release workspace')
  await dialog.getByPlaceholder('Instructions for the agent role', { exact: true }).fill('Reply with the deterministic marker.')
  await dialog.getByRole('button', { name: 'Create definition', exact: true }).click()
  await dialog.getByText('Release engineer', { exact: true }).first().waitFor({ timeout: STEP_TIMEOUT_MS })
  await selectReleaseDefinition(dialog)

  const agentName = dialog.getByPlaceholder('Instance name, for example: backend-Alice', { exact: true })
  for (const name of ['Alice', 'Bob', 'Charlie']) {
    await agentName.fill(name)
    await dialog.getByRole('button', { name: 'Create instance', exact: true }).click()
    await dialog.getByText(name, { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  }
}

async function startV020Task(dialog, args, state) {
  const dshHome = args['dsh-home']
  await dialog.getByRole('button', { name: 'Tasks', exact: true }).click()
  await dialog.getByPlaceholder('Describe the work to complete', { exact: true }).fill(V020_ROOT)
  await dialog.getByRole('combobox', { name: 'Assignee', exact: true }).selectOption({ label: 'Alice' })
  await dialog.getByRole('button', { name: 'Assign task', exact: true }).click()
  await dialog.getByText(V020_ROOT, { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  await waitForFixtureReceipt(`${args.gate}.denial-result-ready`)
  const workspace = await readDurableWorkspace(dshHome)
  const denial = inspectSafeDelegationDenial(await taskToolSessionRows(dshHome), workspace)
  if (denial === undefined) throw new Error('the scripted provider reported a denial result that was absent from the durable Session')
  if (Object.values(workspace.delegationGrants).some(grant => grant.status === 'active')) {
    throw new Error('delegation was granted before observing the forbidden call')
  }
  await writeFile(join(args.evidence, 'v020-denial-observed.json'), `${JSON.stringify(denial, null, 2)}\n`, 'utf8')
  await dialog.getByRole('button', { name: /^Grant delegation for “V020_ROOT V020_DELEGATE” to Alice \([^)]+\)$/u }).click()
  await writeFile(`${args.gate}.denial-observed`, 'release\n', { encoding: 'utf8', flag: 'wx' })
  await dialog.getByText(V020_CHILD, { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  const drawer = await openRuntime(dialog, V020_CHILD)
  await drawer.getByText('Using tool', { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  await drawer.getByText('Tool: workspace_run_child', { exact: true }).click()
  await drawer.getByText('Arguments', { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  await drawer.getByText(/V020_CHILD_EXECUTION/u).waitFor({ timeout: STEP_TIMEOUT_MS })
  await capture(state, 'task-child-tool-running', drawer, ['Using tool', 'Tool: workspace_run_child', 'V020_CHILD_EXECUTION'])
  await drawer.getByRole('button', { name: 'Close runtime activity', exact: true }).click()
  const running = await waitForDurableWorkspace(dshHome, workspace => {
    const derived = Object.values(workspace.tasks).find(task => task.title === V020_CHILD)
    return Object.values(workspace.childRuns).some(child => child.taskId === derived?.id && child.status === 'running')
  }, 'the child run to enter its durable running state')
  const derivedTask = Object.values(running.tasks).find(task => task.title === V020_CHILD)
  const childRun = Object.values(running.childRuns).find(child => child.taskId === derivedTask?.id)
  if (childRun === undefined || childRun.status !== 'running') throw new Error('child detail was not observed while running')
  await dialog.getByText(`Child agent ${childRun.id}`, { exact: false }).click()
  await dialog.getByText('Parent agent: Bob', { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  await capture(state, 'task-child-detail-running', dialog, [`Child agent ${childRun.id}`, 'Parent agent: Bob'])
  await writeFile(`${args.gate}.child-observed`, 'release\n', { encoding: 'utf8', flag: 'wx' })
  const resultDrawer = await openRuntime(dialog, V020_CHILD)
  await resultDrawer.getByText('Tool: workspace_run_child', { exact: true }).click()
  await resultDrawer.getByText('Result', { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  await resultDrawer.getByText('V020_CHILD_RESULT', { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  await capture(state, 'task-child-tool-result', resultDrawer, ['Result', 'V020_CHILD_RESULT'])
  await writeFile(`${args.gate}.child-result-observed`, 'release\n', { encoding: 'utf8', flag: 'wx' })
  await resultDrawer.getByRole('button', { name: 'Close runtime activity', exact: true }).click()
  const durable = await waitForDurableWorkspace(dshHome, workspace => {
    const tasks = Object.values(workspace.tasks)
    const root = tasks.find(task => task.title === V020_ROOT)
    const child = tasks.find(task => task.title === V020_CHILD)
    return root?.status === 'completed' && child?.status === 'completed'
      && workspace.events.filter(event => event.type === 'child/run-finished').length === 1
      && workspace.events.filter(event => event.type === 'task/result' && event.text === 'V020_CHILD_RESULT').length === 1
      && workspace.events.filter(event => event.type === 'task/result' && event.text === 'V020_ROOT_RESULT').length === 1
  }, 'the root task, derived task, child run, and results')
  for (const title of [V020_ROOT, V020_CHILD]) {
    const task = Object.values(durable.tasks).find(task => task.title === title)
    await dialog.getByLabel(`View result for task “${title}” (${task.id})`, { exact: true }).click()
  }
  await dialog.getByText('V020_ROOT_RESULT', { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  await dialog.getByText('V020_CHILD_RESULT', { exact: true }).first().waitFor({ timeout: STEP_TIMEOUT_MS })
  await capture(state, 'task-results', dialog, ['V020_ROOT_RESULT', 'V020_CHILD_RESULT', 'Parent agent: Bob'])
  const causal = await waitForTaskCausality(dshHome, durable)
  await writeFile(join(args.evidence, 'v020-task-causality.json'), `${JSON.stringify(causal, null, 2)}\n`, 'utf8')
  await dialog.getByRole('button', { name: 'Conversations', exact: true }).click()
  await dialog.getByRole('button', { name: /^Release room \d+$/u }).click()
}

async function stopV020HeldTask(dialog, args, state) {
  await dialog.getByRole('button', { name: 'Tasks', exact: true }).click()
  await dialog.getByPlaceholder('Describe the work to complete', { exact: true }).fill(V020_HOLD)
  await dialog.getByRole('combobox', { name: 'Assignee', exact: true }).selectOption({ label: 'Alice' })
  await dialog.getByRole('button', { name: 'Assign task', exact: true }).click()
  await dialog.getByText(V020_HOLD, { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  const toolReady = await waitForFixtureReceipt(`${args.gate}.stop.tool-ready`)
  let drawer = await openRuntime(dialog, V020_HOLD)
  await drawer.getByText('Tool: workspace_delegate_task', { exact: true }).click()
  await drawer.getByText('Tool call failed.', { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  await capture(state, 'stop-held-tool-detail', drawer, ['Responding', 'Tool: workspace_delegate_task', 'Tool call failed.'])
  await writeFile(`${args.gate}.stop.tool-observed`, 'release\n', { encoding: 'utf8', flag: 'wx' })
  const held = await waitForFixtureReceipt(`${args.gate}.stop.held`)
  if (JSON.stringify(toolReady) !== JSON.stringify(held)) throw new Error('held tool and partial belong to different deliveries')
  const protocol = ['held']
  const identityText = await drawer.getByText(/^Activity .+; message .+$/u).innerText()
  const [, activityId, messageId] = /^Activity (.+); message (.+)$/u.exec(identityText) ?? []
  if (!activityId || messageId !== held.messageId) throw new Error('runtime drawer selected a different held activity')
  await drawer.getByText(`Delivery attempt ${held.attemptId}`, { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  await drawer.getByText('V020_STOP_PARTIAL', { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  await drawer.getByRole('article').getByText('Responding', { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  protocol.push('responding-observed')
  await drawer.getByRole('button', { name: 'Close runtime activity', exact: true }).click()
  await dialog.getByPlaceholder('Describe the work to complete', { exact: true }).fill('V020_QUEUED')
  await dialog.getByRole('combobox', { name: 'Assignee', exact: true }).selectOption({ label: 'Alice' })
  await dialog.getByRole('button', { name: 'Assign task', exact: true }).click()
  drawer = await openRuntime(dialog, V020_HOLD)
  await drawer.getByRole('button', { name: 'Task: V020_QUEUED Queued', exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  protocol.push('queued-observed')
  const before = await readDurableWorkspace(args['dsh-home'])
  const alice = Object.values(before.agents).find(agent => agent.name === 'Alice')
  const queued = Object.values(before.tasks).find(task => task.title === 'V020_QUEUED')
  const identity = { ...held, activityId, agentId: alice.id, queuedTaskId: queued.id }
  await drawer.getByText(identityText, { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  await drawer.getByRole('button', { name: `Stop Alice current turn (${activityId})`, exact: true }).click()
  protocol.push('stop-clicked')
  const aborted = await waitForFixtureReceipt(`${args.gate}.stop.abort-received`)
  if (JSON.stringify(aborted) !== JSON.stringify(held)) throw new Error('provider aborted another delivery')
  protocol.push('abort-received')
  await drawer.getByRole('article').getByText('Stopping', { exact: true }).first().waitFor({ timeout: STEP_TIMEOUT_MS })
  protocol.push('stopping-observed')
  await capture(state, '03-task-stopping', drawer, [identityText, 'V020_STOP_PARTIAL', 'Stopping'])
  await writeFile(`${args.gate}.stop.stopping-observed`, JSON.stringify(held), { encoding: 'utf8', flag: 'wx' })
  await writeFile(`${args.gate}.stop`, 'release\n', { encoding: 'utf8', flag: 'wx' })
  await waitForFixtureReceipt(`${args.gate}.stop.released`)
  protocol.push('released')
  await drawer.getByText(identityText, { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  await drawer.getByRole('article').getByText('Settled', { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  const terminalIdentityText = await drawer.getByText(/^Activity .+; message .+$/u).innerText()
  const terminalActivityId = /^Activity (.+); message .+$/u.exec(terminalIdentityText)?.[1]
  protocol.push('settled-observed')
  const after = await waitForDurableWorkspace(args['dsh-home'], workspace => workspace.tasks[queued.id]?.status === 'completed'
    && workspace.events.some(event => event.type === 'task/delivery-failed' && event.taskId === held.taskId), 'exact stopped delivery and unrelated queued work')
  const session = (await durableSessions(args['dsh-home'])).find(session => session.header.id === held.sessionId)
  if (!session) throw new Error('held Session was deleted')
  const receipt = { protocol, identity, terminalActivityId, before, after, sessionRows: session.rows }
  assertExactStopEvidence(receipt)
  await writeFile(join(args.evidence, 'v020-stop-protocol.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  await drawer.getByRole('button', { name: 'Close runtime activity', exact: true }).click()
}

async function inspectV020Memory(dialog, dshHome, state, names = ['Alice', 'Bob', 'Charlie'], status = 'Employed') {
  await dialog.getByRole('button', { name: 'Memory', exact: true }).click()
  const agent = dialog.getByRole('combobox', { name: 'Agent', exact: true })
  const search = dialog.getByRole('searchbox', { name: 'Search memory', exact: true })
  const sourceKind = dialog.getByRole('combobox', { name: 'Source kind', exact: true })
  const source = dialog.getByRole('combobox', { name: 'Source', exact: true })
  const provenance = dialog.getByRole('combobox', { name: 'First provenance', exact: true })
  const workspace = await readDurableWorkspace(dshHome)
  const room = Object.values(workspace.rooms).find(room => room.name === 'Release room')
  const root = Object.values(workspace.tasks).find(task => task.title === V020_ROOT)
  const derived = Object.values(workspace.tasks).find(task => task.title === V020_CHILD)
  const child = Object.values(workspace.childRuns).find(child => child.taskId === derived.id)
  const cases = [
    { kind: 'Room', source: `Release room (${room.id})`, provenance: 'Room membership', type: 'room/message', text: 'MEMORY_SEED no wake', event: workspace.events.find(event => event.type === 'room/message' && event.text === 'MEMORY_SEED no wake') },
    { kind: 'Room', source: `Release room (${room.id})`, provenance: 'History sync', type: 'room/message', text: 'HISTORY_BEFORE_JOIN', event: workspace.events.find(event => event.type === 'room/message' && event.text === 'HISTORY_BEFORE_JOIN') },
    { kind: 'Task', source: `${V020_ROOT} (${root.id})`, provenance: 'Task', type: 'task/result', text: 'V020_ROOT_RESULT', event: workspace.events.find(event => event.type === 'task/result' && event.taskId === root.id) },
    { kind: 'Task', source: `${V020_CHILD} (${derived.id})`, provenance: 'Task', type: 'task/result', text: 'V020_CHILD_RESULT', event: workspace.events.find(event => event.type === 'task/result' && event.taskId === derived.id) },
    { kind: 'Child agent', source: `${child.id} (${child.id})`, provenance: 'Child result', type: 'child/run-finished', text: 'V020_CHILD_RESULT', event: workspace.events.find(event => event.type === 'child/run-finished' && event.subjectId === child.id) },
  ]
  for (const name of names) {
    await agent.selectOption({ label: `${name} — ${status}` })
    const agentId = Object.values(workspace.agents).find(candidate => candidate.name === name).id
    const ownedIds = new Set(workspace.memoryEntries.filter(entry => entry.agentId === agentId).map(entry => entry.eventId))
    if (!ownedIds.has(cases[0].event.id)) throw new Error(`${name} did not retain the silent group message`)
    for (const entry of cases) {
      if (!entry.event) throw new Error('expected cross-source memory event is missing')
      await sourceKind.selectOption({ label: entry.kind })
      await source.selectOption({ label: entry.source })
      await provenance.selectOption({ label: entry.provenance })
      await dialog.getByRole('checkbox', { name: `Event type ${entry.type}`, exact: true }).check()
      await search.fill(entry.text)
      const expectedOwner = entry.text === 'MEMORY_SEED no wake' || (entry.text === 'HISTORY_BEFORE_JOIN' ? name === 'Bob'
        : entry.text === 'V020_ROOT_RESULT' ? name === 'Alice' : name === 'Bob')
      if (ownedIds.has(entry.event.id) !== expectedOwner) throw new Error(`${name} has incorrect ${entry.kind} memory ownership`)
      const expectedIds = expectedOwner ? [entry.event.id] : []
      if (expectedIds.length) {
        const row = dialog.getByRole('article', { name: `Event ${entry.event.sequence}: ${entry.type}`, exact: true })
        await row.locator('p').getByText(entry.text, { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
        await row.getByText(entry.provenance, { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
        await dialog.getByText('End of memory', { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
      } else await dialog.getByText('No memory events match these filters.', { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
      const labels = await dialog.getByRole('main').getByRole('article').evaluateAll(rows => rows.map(row => row.getAttribute('aria-label')))
      assertMemoryRows(workspace, agentId, labels, expectedIds)
      await capture(state, `memory-${name}-${status}-${entry.kind}-${entry.type}-${entry.text}`, dialog, ['Unified personal memory', 'Source kind', 'First provenance'])
      await dialog.getByRole('checkbox', { name: `Event type ${entry.type}`, exact: true }).uncheck()
    }
  }
}

async function reviseV020Definition(dialog, dshHome, state) {
  const before = await readDurableWorkspace(dshHome)
  await writeFile(join(state.evidence, 'v020-before-revision.json'), `${JSON.stringify(before, null, 2)}\n`, 'utf8')
  await dialog.getByRole('button', { name: 'Colleagues', exact: true }).click()
  await selectReleaseDefinition(dialog)
  await dialog.getByRole('textbox', { name: 'Responsibilities', exact: true }).fill('Verify the revised release workspace')
  await dialog.getByRole('button', { name: 'Save new revision', exact: true }).click()
  const save = dialog.getByRole('dialog', { name: 'Synchronize new revision', exact: true })
  await save.getByRole('radio', { name: 'Synchronize subset', exact: true }).check()
  await save.getByRole('checkbox', { name: /^Select Alice \(/u }).check()
  await save.getByRole('button', { name: 'Save revision', exact: true }).click()
  await dialog.getByRole('article', { name: 'Revision 2', exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  const after = await readDurableWorkspace(dshHome)
  const receipt = assertSubsetRevisionEvidence(before, after)
  for (const [number, id, status] of [[1, receipt.previousRevisionId, 'Previous'], [2, receipt.currentRevisionId, 'Current']]) {
    const revision = dialog.getByRole('article', { name: `Revision ${number}`, exact: true })
    const pins = receipt.pins[id].map(agentId => `${after.agents[agentId].name} (${agentId}, Employed)`).join(', ')
    await revision.getByText(`Currently pinned instances: ${pins}`, { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
    await revision.getByText(status, { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
    await revision.getByRole('button', { name: `Synchronize revision ${number}`, exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  }
  await dialog.getByRole('article', { name: 'Revision 2', exact: true })
    .getByText(`Creation event ${receipt.revisionEventSequence}`, { exact: true })
    .waitFor({ timeout: STEP_TIMEOUT_MS })
  await writeFile(join(state.evidence, 'v020-revision-pins.json'), `${JSON.stringify({ ...receipt, after }, null, 2)}\n`, 'utf8')
  await capture(state, '05-history', dialog, ['Immutable revision history', 'Revision 1', 'Revision 2', 'Previous', 'Current'])
}

async function selectReleaseDefinition(dialog) {
  await dialog.getByRole('button', { name: /^Release engineer/u }).click()
}

async function createGroupAndJoin(dialog, dshHome) {
  await dialog.getByRole('button', { name: 'Conversations', exact: true }).click()
  await dialog.getByRole('button', { name: 'New group', exact: true }).click()
  await dialog.getByPlaceholder('Group name', { exact: true }).fill('Release room')
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await dialog.getByText('Release room', { exact: true }).first().waitFor({ timeout: STEP_TIMEOUT_MS })

  await send(dialog, 'HISTORY_BEFORE_JOIN')
  const beforeJoin = await waitForDurableMessage(dshHome, 'HISTORY_BEFORE_JOIN')
  const history = beforeJoin.events.filter(event => event.type === 'room/message' && event.text === 'HISTORY_BEFORE_JOIN')
  if (history.length !== 1 || !Number.isSafeInteger(history[0].sequence)) {
    throw new Error(`expected one sequenced HISTORY_BEFORE_JOIN event; found ${history.length}`)
  }
  const historySequence = String(history[0].sequence)

  const candidate = dialog.getByRole('combobox', { name: 'Add agent', exact: true })
  const memoryStart = dialog.getByRole('combobox', { name: 'Memory start', exact: true })
  for (const name of ['Alice', 'Bob', 'Charlie']) {
    await candidate.selectOption({ label: name })
    if (name === 'Alice' || name === 'Charlie') {
      await memoryStart.selectOption({ label: 'New events only' })
    } else {
      await memoryStart.selectOption({ label: 'Historical event range' })
      await dialog.getByRole('spinbutton', { name: 'Start event sequence', exact: true }).fill(historySequence)
      await dialog.getByRole('spinbutton', { name: 'End event sequence', exact: true }).fill(historySequence)
    }
    await dialog.getByRole('button', { name: 'Join group', exact: true }).click()
    await dialog.getByRole('button', { name: `@${name}`, exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  }
}

function agentRow(dialog, name) {
  return dialog.getByRole('group', { name, exact: true }).first()
}

async function dismissTestingNotice(page) {
  const testingNotice = page.getByRole('dialog', { name: /^(?:Internal Testing Notice|Preview Notice|内测声明|预览版说明)$/u })
  const sessions = page.getByRole('tree', { name: /^(?:Sessions|会话)$/u })
  await sessions.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
  try {
    await testingNotice.waitFor({ state: 'visible', timeout: 2_000 })
  } catch (error) {
    if (error?.name === 'TimeoutError') return
    throw error
  }
  await testingNotice.getByRole('button', { name: /^(?:Continue|继续)$/u }).click()
  await testingNotice.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS })
}

async function createCoreConversation(page, args, state) {
  await page.getByRole('button', { name: 'Add workspace', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Select Workspace Directory', exact: true })
  await picker.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
  await picker.getByRole('button', { name: 'Edit path', exact: true }).click()
  await picker.getByRole('textbox', { name: 'Edit path', exact: true }).fill(args.workspace)
  await picker.getByRole('textbox', { name: 'Edit path', exact: true }).press('Enter')
  await picker.getByRole('button', { name: 'Open', exact: true }).click()
  await picker.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS })

  const composer = page.getByRole('textbox', { name: /^(?:Describe what you want to build|Message or run a task)(?:, \/ commands, @ files or sessions)?$|^Message the agent$/u })
  await composer.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
  const sendButton = page.getByRole('button', { name: 'Send message', exact: true })
  await composer.fill(CORE_SESSION_SENTINEL)
  await sendButton.click()
  await page.getByText(CORE_SESSION_SENTINEL, { exact: true }).last().waitFor({ timeout: STEP_TIMEOUT_MS })
  await page.getByText(CORE_REPLY, { exact: true }).last().waitFor({ timeout: STEP_TIMEOUT_MS })
  await page.getByRole('button', { name: 'Send message', exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  await capture(state, 'core-session-installed', page.locator('body'), [
    'Sessions', CORE_SESSION_SENTINEL, CORE_REPLY,
  ])
  await writeFile(join(state.evidence, 'core-session-installed.json'), `${JSON.stringify({
    workspace: args.workspace,
    prompt: CORE_SESSION_SENTINEL,
    reply: CORE_REPLY,
  }, null, 2)}\n`, 'utf8')
}

async function reopenCoreSession(page, workspace) {
  const prompt = page.getByText(CORE_SESSION_SENTINEL, { exact: true }).last()
  const tree = page.getByRole('tree', { name: 'Sessions', exact: true })
  await tree.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
  const workspaceItem = tree.getByRole('treeitem', { name: basename(workspace), exact: true })
  await workspaceItem.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
  if (await workspaceItem.getAttribute('aria-expanded') !== 'true') await workspaceItem.click()
  const candidate = tree.getByRole('treeitem').filter({ hasText: new RegExp(`${CORE_SESSION_SENTINEL}|${CORE_REPLY}`, 'u') }).last()
  await candidate.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
  await candidate.click()
  await prompt.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
}

async function runAfterUninstall(page, args, state) {
  await page.goto(args.url, { waitUntil: 'load', timeout: STEP_TIMEOUT_MS })
  await dismissTestingNotice(page)
  await page.getByRole('tree', { name: 'Sessions', exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
  await reopenCoreSession(page, args.workspace)
  await page.getByText(CORE_SESSION_SENTINEL, { exact: true }).last().waitFor({ timeout: STEP_TIMEOUT_MS })
  await page.getByText(CORE_REPLY, { exact: true }).last().waitFor({ timeout: STEP_TIMEOUT_MS })
  await page.getByRole('textbox', { name: /^(?:Describe what you want to build|Message or run a task)(?:, \/ commands, @ files or sessions)?$|^Message the agent$/u })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
  if (await page.getByRole('button', { name: 'Open Agent Workspace', exact: true }).count() !== 0) {
    throw new Error('Agent Workspace entry remained visible after uninstall')
  }
  await capture(state, 'core-session-after-uninstall', page.locator('body'), [
    'Sessions', CORE_SESSION_SENTINEL, CORE_REPLY,
  ])
  await writeFile(join(state.evidence, 'core-session-after-uninstall.json'), `${JSON.stringify({
    workspace: args.workspace,
    prompt: CORE_SESSION_SENTINEL,
    reply: CORE_REPLY,
    agentWorkspaceEntryCount: 0,
  }, null, 2)}\n`, 'utf8')
}

async function runAfterRestart(page, args, state) {
  await page.goto(args.url, { waitUntil: 'load', timeout: STEP_TIMEOUT_MS })
  await dismissTestingNotice(page)
  await page.getByRole('button', { name: '打开智能体工作区', exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  await page.getByRole('button', { name: '打开智能体工作区', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '智能体工作区', exact: true })
  const durable = await readDurableWorkspace(args['dsh-home'])
  const baseline = JSON.parse(await readFile(join(args.evidence, 'installed-durable-final.json'), 'utf8'))
  assertRestartPersistence(baseline, durable)
  await dialog.getByRole('button', { name: '任务', exact: true }).click()
  await dialog.getByLabel('任务中心', { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  await dialog.getByText(V020_ROOT, { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  await capture(state, 'restart-tasks-zh-CN', dialog, ['根任务', V020_ROOT, V020_CHILD])
  await dialog.getByRole('button', { name: '记忆', exact: true }).click()
  await dialog.getByText('统一个人记忆', { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  await dialog.getByRole('combobox', { name: '智能体', exact: true }).selectOption({ label: 'Alice — 在职' })
  await capture(state, 'restart-memory-zh-CN', dialog, ['统一个人记忆', 'Alice — 在职', '来源类型'])
  await dialog.getByRole('button', { name: '同事', exact: true }).click()
  await selectReleaseDefinition(dialog)
  await dialog.getByText('不可变修订历史', { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  await Promise.all([
    dialog.getByRole('article', { name: '修订 1', exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS }),
    dialog.getByRole('article', { name: '修订 2', exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS }),
  ])
  for (const englishCanary of ['Instructions', '保存新 Revision']) {
    if (await dialog.getByText(englishCanary, { exact: true }).count() !== 0) throw new Error(`zh-CN history rendered untranslated copy: ${englishCanary}`)
  }
  await capture(state, 'restart-history-zh-CN', dialog, ['不可变修订历史', '修订 1', '修订 2', '指令', '保存新修订'])
  await dialog.getByRole('button', { name: '打开运行状态', exact: true }).click()
  const runtime = dialog.getByRole('dialog', { name: '运行状态', exact: true })
  await runtime.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
  await runtime.getByText('当前没有运行活动。', { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  if (await runtime.getByText('Delivery was interrupted before a terminal result.', { exact: true }).count() !== 0) {
    throw new Error('zh-CN runtime rendered an untranslated Host failure summary')
  }
  await runtime.getByText('任务投递在产生最终结果前中断。', { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  await capture(state, 'restart-runtime-zh-CN', runtime, ['运行状态', '当前没有运行活动。', '任务投递在产生最终结果前中断。'])
  await writeFile(join(args.evidence, 'after-restart-durable.json'), `${JSON.stringify(durable, null, 2)}\n`, 'utf8')
}

async function runInstalledScenario(page, args, state) {
  await page.goto(args.url, { waitUntil: 'load', timeout: STEP_TIMEOUT_MS })
  await dismissTestingNotice(page)
  await createCoreConversation(page, args, state)
  await page.getByRole('button', { name: 'Open Agent Workspace', exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  await page.getByRole('button', { name: 'Open Agent Workspace', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'Agent Workspace', exact: true })
  await capture(state, '00-empty', dialog, ['Agent Workspace', 'Conversations'])

  await createDefinitionAndAgents(dialog)
  await capture(state, '01-agents', dialog, ['Release engineer', 'Alice', 'Bob'])
  await createGroupAndJoin(dialog, args['dsh-home'])
  await capture(state, '02-group', dialog, ['Release room', '@Alice', '@Bob', '@Charlie', '@all'])

  await startV020Task(dialog, args, state)

  await send(dialog, 'MEMORY_SEED no wake')
  await waitForIdle(dialog)
  if (await dialog.getByText(/REPLY Alice|REPLY Bob|REPLY Charlie/u).count() !== 0) throw new Error('an unmentioned agent woke for a group post')

  await send(dialog, '@Alice NAMED_WAKE')
  await dialog.getByText('NAMED_REPLY Alice', { exact: true }).last().waitFor({ timeout: STEP_TIMEOUT_MS })
  await waitForIdle(dialog)

  await send(dialog, '@all ALL_WAKE')
  await dialog.getByText('ALL_REPLY Alice', { exact: true }).last().waitFor({ timeout: STEP_TIMEOUT_MS })
  await dialog.getByText('ALL_REPLY Bob', { exact: true }).last().waitFor({ timeout: STEP_TIMEOUT_MS })
  await dialog.getByText('ALL_REPLY Charlie', { exact: true }).last().waitFor({ timeout: STEP_TIMEOUT_MS })
  await waitForIdle(dialog)

  const membersPanel = dialog.getByRole('complementary', { name: 'Group members', exact: true })
  await agentRow(membersPanel, 'Alice').getByRole('button', { name: 'Direct', exact: true }).click()
  await send(dialog, 'DIRECT_WAKE')
  await dialog.getByText('DIRECT_REPLY Alice', { exact: true }).last().waitFor({ timeout: STEP_TIMEOUT_MS })
  await waitForDurableMessage(args['dsh-home'], 'DIRECT_REPLY Alice')

  await dialog.getByRole('button', { name: 'Colleagues', exact: true }).click()
  await selectReleaseDefinition(dialog)
  await agentRow(dialog, 'Alice').getByRole('button', { name: 'Direct', exact: true }).click()
  const reopenedDirect = await readDurableWorkspace(args['dsh-home'])
  if (Object.values(reopenedDirect.rooms).filter(room => room.kind === 'direct').length !== 1) {
    throw new Error('opening direct chat did not reuse its room')
  }
  await dialog.getByText('DIRECT_REPLY Alice', { exact: true }).first().waitFor({ timeout: STEP_TIMEOUT_MS })

  await send(dialog, 'HOLD_WAKE')
  await dialog.getByText('LIVE_PARTIAL', { exact: false }).waitFor({ timeout: STEP_TIMEOUT_MS })
  await dialog.getByText('Agents working…', { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  await capture(state, '03-live', dialog, ['LIVE_PARTIAL', 'Agents working…'])

  await page.reload({ waitUntil: 'load', timeout: STEP_TIMEOUT_MS })
  await page.getByRole('button', { name: 'Open Agent Workspace', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Agent Workspace', exact: true })
  await dialog.getByRole('button', { name: /^Alice Responding Direct$/u }).click()
  await capture(state, '03-reloaded', dialog, ['HOLD_WAKE'])
  await dialog.getByText('LIVE_PARTIAL', { exact: false }).waitFor({ timeout: STEP_TIMEOUT_MS })
  await writeFile(args.gate, 'release\n', { encoding: 'utf8', flag: 'wx' })
  await dialog.getByText('HOLD_REPLY Alice', { exact: true }).last().waitFor({ timeout: STEP_TIMEOUT_MS })
  await waitForIdle(dialog)
  if (await dialog.getByText('LIVE_PARTIAL', { exact: false }).count() !== 0) throw new Error('live projection did not converge after reload')

  await stopV020HeldTask(dialog, args, state)

  const beforeDeparture = await readDurableWorkspace(args['dsh-home'])
  const aliceBeforeDeparture = Object.values(beforeDeparture.agents).find(agent => agent.name === 'Alice')
  const sessionBeforeDeparture = aliceBeforeDeparture === undefined
    ? undefined
    : beforeDeparture.sessionBindings[aliceBeforeDeparture.id]
  if (sessionBeforeDeparture === undefined) throw new Error('Alice had no durable session binding before departure')

  await dialog.getByRole('button', { name: 'Colleagues', exact: true }).click()
  await selectReleaseDefinition(dialog)
  let alice = agentRow(dialog, 'Alice')
  await alice.getByRole('button', { name: 'Depart', exact: true }).click()
  await alice.getByText('Departed', { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  await inspectV020Memory(dialog, args['dsh-home'], state, ['Alice'], 'Departed')
  await dialog.getByRole('button', { name: 'Colleagues', exact: true }).click()
  await selectReleaseDefinition(dialog)
  alice = agentRow(dialog, 'Alice')
  await alice.getByRole('button', { name: 'Re-employ', exact: true }).click()
  alice = agentRow(dialog, 'Alice')
  await alice.getByText('Employed', { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  await alice.getByRole('button', { name: 'Direct', exact: true }).click()
  await send(dialog, 'CHECK_MEMORY')
  await dialog.getByText('MEMORY_OK Alice', { exact: true }).last().waitFor({ timeout: STEP_TIMEOUT_MS })
  await waitForDurableAgentMemory(args['dsh-home'], 'Alice', 'MEMORY_OK Alice')
  await capture(state, '04-settled', dialog, ['CHECK_MEMORY', 'MEMORY_OK Alice'])
  await inspectV020Memory(dialog, args['dsh-home'], state)
  await reviseV020Definition(dialog, args['dsh-home'], state)

  const durable = await readDurableWorkspace(args['dsh-home'])
  await assertTaskToolEvidence(durable, args)
  const definitions = Object.values(durable.definitions)
  const agents = Object.values(durable.agents)
  const releaseDefinitions = definitions.filter(definition => definition.name === 'Release engineer')
  const releaseAgents = agents.filter(agent => ['Alice', 'Bob', 'Charlie'].includes(agent.name))
  const taskToolAgents = agents.filter(agent => agent.name === 'Task tools Alice' || agent.name === 'Task tools Bob')
  const groups = Object.values(durable.rooms).filter(room => room.kind === 'group')
  const directs = Object.values(durable.rooms).filter(room => room.kind === 'direct')
  if (releaseDefinitions.length !== 1 || releaseAgents.length !== 3 || taskToolAgents.length !== 2 || groups.length !== 1 || directs.length !== 2) {
    throw new Error('durable release scenario has unexpected definition, agent, or room cardinality')
  }
  if (agents.some(agent => agent.employmentStatus !== 'employed')) throw new Error('re-employed agent did not settle as employed')
  const aliceId = agents.find(agent => agent.name === 'Alice')?.id
  if (aliceId === undefined || durable.memoryEntries.filter(entry => entry.agentId === aliceId).length === 0) {
    throw new Error('Alice has no unified personal memory after re-employment')
  }
  if (durable.sessionBindings[aliceId] !== sessionBeforeDeparture) {
    throw new Error('Alice did not retain her personal session across departure and re-employment')
  }
  assertBrowserDurableEvidence(durable)
  const agentMessages = durable.events.filter(event => event.type === 'room/message' && event.actor?.type === 'agent')
  const replyCount = (text, name) => agentMessages.filter(event => (
    event.text === `${text} ${name}`
      && agents.find(agent => agent.id === event.actor.id)?.name === name
  )).length
  if (agentMessages.some(event => event.text?.startsWith('SCRIPTED_REPLY '))) {
    throw new Error('an unmentioned agent produced a durable fallback reply')
  }
  if (replyCount('NAMED_REPLY', 'Alice') !== 1 || replyCount('NAMED_REPLY', 'Bob') !== 0 || replyCount('NAMED_REPLY', 'Charlie') !== 0) {
    throw new Error('durable named-mention replies do not contain exactly Alice')
  }
  if (replyCount('ALL_REPLY', 'Alice') !== 1 || replyCount('ALL_REPLY', 'Bob') !== 1 || replyCount('ALL_REPLY', 'Charlie') !== 1) {
    throw new Error('durable @all replies do not contain each employed member exactly once')
  }
  if (agentMessages.length !== 7) throw new Error(`expected 7 durable agent replies, found ${agentMessages.length}`)
  await writeFile(join(state.evidence, `${state.prefix}durable-final.json`), `${JSON.stringify(durable, null, 2)}\n`, 'utf8')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  args['dsh-home'] = resolve(args['dsh-home'])
  args.evidence = resolve(args.evidence)
  args.gate = resolve(args.gate)
  args.workspace = resolve(args.workspace)
  await mkdir(args.evidence, { recursive: true })
  const prefix = `${args.phase}-`
  const state = { evidence: args.evidence, prefix, snapshots: [] }
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: args.phase === 'after-restart' ? 'zh-CN' : 'en-US' })
    try {
      const page = await context.newPage()
      const consoleFailures = []
      const networkFailures = []
      page.on('console', message => {
        if (message.type() === 'error' || message.type() === 'warning') {
          const location = message.location().url
          consoleFailures.push(`${message.type()}: ${message.text()}${location ? ` (${redact(location)})` : ''}`)
        }
      })
      page.on('pageerror', error => consoleFailures.push(`pageerror: ${String(error)}`))
      page.on('response', response => {
        if (response.status() >= 400) networkFailures.push(`${response.status()} ${redact(response.url())}`)
      })

      try {
        if (args.phase === 'installed') await runInstalledScenario(page, args, state)
        else if (args.phase === 'after-restart') await runAfterRestart(page, args, state)
        else await runAfterUninstall(page, args, state)
        if (consoleFailures.length > 0) throw new Error(`browser console failures:\n${consoleFailures.join('\n')}`)
        await writeFile(join(args.evidence, `${prefix}browser-console.json`), '[]\n', 'utf8')
      } catch (error) {
        const activityButton = page.getByRole('button', { name: 'Open runtime activity', exact: true })
        const activityDrawer = page.getByRole('dialog', { name: 'Runtime activity', exact: true })
        if (await activityButton.count() > 0 && await activityDrawer.count() === 0) {
          await activityButton.click().catch(() => {})
          await activityDrawer.waitFor({ state: 'visible', timeout: 2_000 }).catch(() => {})
        }
        await page.screenshot({ path: join(args.evidence, `${prefix}browser-failure.png`), fullPage: true }).catch(() => {})
        const aria = await page.locator('body').ariaSnapshot().catch(snapshotError => `ARIA capture failed: ${String(snapshotError)}`)
        let durable
        try { durable = await readDurableWorkspace(args['dsh-home']) } catch (snapshotError) { durable = { error: String(snapshotError) } }
        await writeFile(join(args.evidence, `${prefix}browser-failure.json`), `${JSON.stringify({
          error: redact(error instanceof Error ? error.stack ?? error.message : String(error)),
          aria,
          consoleFailures: consoleFailures.map(redact),
          networkFailures,
          durable,
        }, null, 2)}\n`, 'utf8')
        throw error
      }
    } finally {
      await context.close()
    }
  } finally {
    await browser.close()
  }
}

await main()
