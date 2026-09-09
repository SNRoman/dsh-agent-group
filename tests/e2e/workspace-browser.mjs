/** Browser-visible release smoke shared by packed and exact-registry installs. */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { assertBrowserDurableEvidence } from '../../scripts/release-smoke-contract.mjs'

const STEP_TIMEOUT_MS = 30_000
const CORE_SESSION_SENTINEL = 'CORE_SESSION_SENTINEL'
const CORE_REPLY = 'CORE_REPLY'
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
  if (args.phase !== 'installed' && args.phase !== 'after-uninstall') {
    throw new Error('--phase must be installed or after-uninstall')
  }
  return args
}

function redact(value) {
  return value.replace(/([?&]token=)[^\s&)]+/gu, '$1<redacted>')
}

async function stableAria(locator) {
  await locator.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
  let previous = await locator.ariaSnapshot()
  for (let attempt = 0; attempt < 20; attempt++) {
    await locator.page().waitForTimeout(100)
    const current = await locator.ariaSnapshot()
    if (current === previous) return current
    previous = current
  }
  throw new Error('ARIA snapshot did not converge')
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
  const deadline = Date.now() + STEP_TIMEOUT_MS
  while (Date.now() < deadline) {
    const working = await dialog.getByText('Working…', { exact: true }).count()
    const agentsWorking = await dialog.getByText('Agents working…', { exact: true }).count()
    if (working === 0 && agentsWorking === 0) return
    await dialog.page().waitForTimeout(100)
  }
  throw new Error('Agent Workspace did not become idle')
}

async function waitForDurableMessage(dshHome, text) {
  const deadline = Date.now() + STEP_TIMEOUT_MS
  while (Date.now() < deadline) {
    const workspace = await readDurableWorkspace(dshHome)
    if (workspace.events.some(event => event.type === 'room/message' && event.text === text)) return workspace
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`durable workspace did not record ${JSON.stringify(text)}`)
}

async function jsonlFiles(root) {
  const files = []
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name === 'session.jsonl') files.push(path)
    }
  }
  await visit(root)
  return files
}

async function taskToolSessionRows(dshHome) {
  const contents = await Promise.all((await jsonlFiles(join(dshHome, 'sessions'))).map(path => readFile(path, 'utf8')))
  return contents.flatMap(content => content.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line)))
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
  const denied = serializedRows.filter(row => row.includes(expected.policyError))
  if (denied.length !== 1) throw new Error(`expected one recorded policy denial; found ${denied.length}`)
  for (const id of [fixture.taskId, fixture.deniedAssigneeAgentId]) {
    if (denied[0].includes(id)) throw new Error('recorded policy denial leaked a workspace identifier')
  }
  await writeFile(join(args.evidence, 'task-tools-recorded-session.json'), `${JSON.stringify({
    tools: expected.tools,
    result: expected.result,
    policyError: expected.policyError,
    policyResultRows: denied.length,
  }, null, 2)}\n`, 'utf8')
}

async function send(dialog, text) {
  const composer = dialog.getByPlaceholder(/Write (?:a message|a direct message)/u)
  await composer.fill(text)
  await dialog.getByRole('button', { name: 'Send', exact: true }).click()
  const deadline = Date.now() + STEP_TIMEOUT_MS
  while (Date.now() < deadline && await composer.inputValue() !== '') {
    const failure = dialog.getByText(/^Workspace request failed:/u)
    if (await failure.count() > 0) throw new Error(await failure.first().innerText())
    await dialog.page().waitForTimeout(100)
  }
  if (await composer.inputValue() !== '') throw new Error(`Agent Workspace did not commit ${JSON.stringify(text)}`)
  await dialog.getByRole('main').getByText(text, { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
}

async function createDefinitionAndAgents(dialog) {
  await dialog.getByRole('button', { name: 'Agents', exact: true }).click()
  await dialog.getByRole('button', { name: 'New definition', exact: true }).click()
  await dialog.getByPlaceholder('For example: Java engineer', { exact: true }).fill('Release engineer')
  await dialog.getByPlaceholder('What is this role responsible for?', { exact: true }).fill('Verify the release workspace')
  await dialog.getByPlaceholder('Instructions for the agent role', { exact: true }).fill('Reply with the deterministic marker.')
  await dialog.getByRole('button', { name: 'Create definition', exact: true }).click()
  await dialog.getByText('Release engineer', { exact: true }).first().waitFor({ timeout: STEP_TIMEOUT_MS })
  await selectReleaseDefinition(dialog)

  const agentName = dialog.getByPlaceholder('Instance name, for example: backend-Alice', { exact: true })
  for (const name of ['Alice', 'Bob']) {
    await agentName.fill(name)
    await dialog.getByRole('button', { name: 'Create instance', exact: true }).click()
    await dialog.getByText(name, { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  }
}

async function selectReleaseDefinition(dialog) {
  await dialog.getByRole('button', { name: /^Release engineer/u }).click()
}

async function createGroupAndJoin(dialog, dshHome) {
  await dialog.getByRole('button', { name: 'Chat', exact: true }).click()
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
  for (const name of ['Alice', 'Bob']) {
    await candidate.selectOption({ label: name })
    if (name === 'Alice') {
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
  const testingNotice = page.getByRole('dialog', { name: 'Internal Testing Notice', exact: true })
  const sessions = page.getByRole('tree', { name: 'Sessions', exact: true })
  await sessions.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
  try {
    await testingNotice.waitFor({ state: 'visible', timeout: 2_000 })
  } catch (error) {
    if (error?.name === 'TimeoutError') return
    throw error
  }
  await testingNotice.getByRole('button', { name: 'Continue', exact: true }).click()
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

  const composer = page.getByRole('textbox', { name: /^(?:Describe what you want to build|Message the agent)$/u })
  await composer.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
  const sendButton = page.getByRole('button', { name: 'Send message', exact: true })
  const stableDeadline = Date.now() + STEP_TIMEOUT_MS
  let stable = false
  while (Date.now() < stableDeadline) {
    await composer.fill(CORE_SESSION_SENTINEL)
    await page.waitForTimeout(100)
    if (await composer.textContent() === CORE_SESSION_SENTINEL && await sendButton.isEnabled()) {
      stable = true
      break
    }
  }
  if (!stable) throw new Error('DSH Web composer did not stabilize for the core Session message')
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
  if (await prompt.count() > 0) return
  const tree = page.getByRole('tree', { name: 'Sessions', exact: true })
  await tree.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
  const workspaceItem = tree.getByRole('treeitem', { name: basename(workspace), exact: true })
  await workspaceItem.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
  if (await workspaceItem.getAttribute('aria-expanded') !== 'true') await workspaceItem.click()
  const deadline = Date.now() + STEP_TIMEOUT_MS
  while (Date.now() < deadline) {
    for (const marker of [CORE_SESSION_SENTINEL, CORE_REPLY]) {
      const candidate = tree.getByRole('treeitem').filter({ hasText: marker }).last()
      if (await candidate.count() === 0) continue
      await candidate.click()
      await prompt.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
      return
    }
    await page.waitForTimeout(100)
  }
  throw new Error('persisted core Session was not present in the Sessions tree after uninstall')
}

async function runAfterUninstall(page, args, state) {
  await page.goto(args.url, { waitUntil: 'load', timeout: STEP_TIMEOUT_MS })
  await dismissTestingNotice(page)
  await page.getByRole('tree', { name: 'Sessions', exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
  await reopenCoreSession(page, args.workspace)
  await page.getByText(CORE_SESSION_SENTINEL, { exact: true }).last().waitFor({ timeout: STEP_TIMEOUT_MS })
  await page.getByText(CORE_REPLY, { exact: true }).last().waitFor({ timeout: STEP_TIMEOUT_MS })
  await page.getByRole('textbox', { name: /^(?:Describe what you want to build|Message the agent)$/u })
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
  await capture(state, '02-group', dialog, ['Release room', '@Alice', '@Bob', '@all'])

  await send(dialog, 'MEMORY_SEED no wake')
  await waitForIdle(dialog)
  if (await dialog.getByText(/REPLY Alice|REPLY Bob/u).count() !== 0) throw new Error('an unmentioned agent woke for a group post')

  await send(dialog, '@Alice NAMED_WAKE')
  await dialog.getByText('NAMED_REPLY Alice', { exact: true }).last().waitFor({ timeout: STEP_TIMEOUT_MS })
  await waitForIdle(dialog)

  await send(dialog, '@all ALL_WAKE')
  await dialog.getByText('ALL_REPLY Alice', { exact: true }).last().waitFor({ timeout: STEP_TIMEOUT_MS })
  await dialog.getByText('ALL_REPLY Bob', { exact: true }).last().waitFor({ timeout: STEP_TIMEOUT_MS })
  await waitForIdle(dialog)

  const membersPanel = dialog.getByRole('complementary', { name: 'Group members', exact: true })
  await agentRow(membersPanel, 'Alice').getByRole('button', { name: 'Direct', exact: true }).click()
  await send(dialog, 'DIRECT_WAKE')
  await dialog.getByText('DIRECT_REPLY Alice', { exact: true }).last().waitFor({ timeout: STEP_TIMEOUT_MS })
  await waitForDurableMessage(args['dsh-home'], 'DIRECT_REPLY Alice')

  await dialog.getByRole('button', { name: 'Agents', exact: true }).click()
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
  await dialog.getByRole('button', { name: 'Alice Direct', exact: true }).click()
  await dialog.getByText('LIVE_PARTIAL', { exact: false }).waitFor({ timeout: STEP_TIMEOUT_MS })
  await writeFile(args.gate, 'release\n', { encoding: 'utf8', flag: 'wx' })
  await dialog.getByText('HOLD_REPLY Alice', { exact: true }).last().waitFor({ timeout: STEP_TIMEOUT_MS })
  await waitForIdle(dialog)
  if (await dialog.getByText('LIVE_PARTIAL', { exact: false }).count() !== 0) throw new Error('live projection did not converge after reload')

  const beforeDeparture = await readDurableWorkspace(args['dsh-home'])
  const aliceBeforeDeparture = Object.values(beforeDeparture.agents).find(agent => agent.name === 'Alice')
  const sessionBeforeDeparture = aliceBeforeDeparture === undefined
    ? undefined
    : beforeDeparture.sessionBindings[aliceBeforeDeparture.id]
  if (sessionBeforeDeparture === undefined) throw new Error('Alice had no durable session binding before departure')

  await dialog.getByRole('button', { name: 'Agents', exact: true }).click()
  await selectReleaseDefinition(dialog)
  let alice = agentRow(dialog, 'Alice')
  await alice.getByRole('button', { name: 'Depart', exact: true }).click()
  await alice.getByText('Departed', { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  await alice.getByRole('button', { name: 'Re-employ', exact: true }).click()
  alice = agentRow(dialog, 'Alice')
  await alice.getByText('Employed', { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  await alice.getByRole('button', { name: 'Direct', exact: true }).click()
  await send(dialog, 'CHECK_MEMORY')
  await dialog.getByText('MEMORY_OK Alice', { exact: true }).last().waitFor({ timeout: STEP_TIMEOUT_MS })
  await capture(state, '04-settled', dialog, ['CHECK_MEMORY', 'MEMORY_OK Alice'])

  const durable = await readDurableWorkspace(args['dsh-home'])
  await assertTaskToolEvidence(durable, args)
  const definitions = Object.values(durable.definitions)
  const agents = Object.values(durable.agents)
  const releaseDefinitions = definitions.filter(definition => definition.name === 'Release engineer')
  const releaseAgents = agents.filter(agent => agent.name === 'Alice' || agent.name === 'Bob')
  const taskToolAgents = agents.filter(agent => agent.name === 'Task tools Alice' || agent.name === 'Task tools Bob')
  const groups = Object.values(durable.rooms).filter(room => room.kind === 'group')
  const directs = Object.values(durable.rooms).filter(room => room.kind === 'direct')
  if (releaseDefinitions.length !== 1 || releaseAgents.length !== 2 || taskToolAgents.length !== 2 || groups.length !== 1 || directs.length !== 2) {
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
  if (replyCount('NAMED_REPLY', 'Alice') !== 1 || replyCount('NAMED_REPLY', 'Bob') !== 0) {
    throw new Error('durable named-mention replies do not contain exactly Alice')
  }
  if (replyCount('ALL_REPLY', 'Alice') !== 1 || replyCount('ALL_REPLY', 'Bob') !== 1) {
    throw new Error('durable @all replies do not contain each employed member exactly once')
  }
  if (agentMessages.length !== 6) throw new Error(`expected 6 durable agent replies, found ${agentMessages.length}`)
  await writeFile(join(state.evidence, 'durable-final.json'), `${JSON.stringify(durable, null, 2)}\n`, 'utf8')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  args['dsh-home'] = resolve(args['dsh-home'])
  args.evidence = resolve(args.evidence)
  args.gate = resolve(args.gate)
  args.workspace = resolve(args.workspace)
  await mkdir(args.evidence, { recursive: true })
  const prefix = args.phase === 'after-uninstall' ? 'after-uninstall-' : ''
  const state = { evidence: args.evidence, prefix, snapshots: [] }
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'en-US' })
    try {
      const page = await context.newPage()
      const consoleFailures = []
      page.on('console', message => {
        if (message.type() === 'error' || message.type() === 'warning') consoleFailures.push(`${message.type()}: ${message.text()}`)
      })
      page.on('pageerror', error => consoleFailures.push(`pageerror: ${String(error)}`))

      try {
        if (args.phase === 'installed') await runInstalledScenario(page, args, state)
        else await runAfterUninstall(page, args, state)
        if (consoleFailures.length > 0) throw new Error(`browser console failures:\n${consoleFailures.join('\n')}`)
        await writeFile(join(args.evidence, `${prefix}browser-console.json`), '[]\n', 'utf8')
      } catch (error) {
        await page.screenshot({ path: join(args.evidence, `${prefix}browser-failure.png`), fullPage: true }).catch(() => {})
        const aria = await page.locator('body').ariaSnapshot().catch(snapshotError => `ARIA capture failed: ${String(snapshotError)}`)
        let durable
        try { durable = await readDurableWorkspace(args['dsh-home']) } catch (snapshotError) { durable = { error: String(snapshotError) } }
        await writeFile(join(args.evidence, `${prefix}browser-failure.json`), `${JSON.stringify({
          error: redact(error instanceof Error ? error.stack ?? error.message : String(error)),
          aria,
          consoleFailures: consoleFailures.map(redact),
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
