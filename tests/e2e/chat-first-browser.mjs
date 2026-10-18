/** Focused keyless UX smoke against real packed plugins in a scratch DSH Web profile. */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { execa } from 'execa'
import { chromium } from 'playwright'
import { readDurableRecord } from './workflow-browser.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const TIMEOUT = 30_000
const SECRET = 'CHAT_FIRST_ALREADY_READ_SECRET_20261013'
const LONG_NAME = '负责数据报告与工程质量检查的同事小博'

function argsOf(argv) {
  if (argv.includes('--help')) return { help: true }
  const result = { dsh: process.env['DSH_SOURCE'] === undefined ? undefined : resolve(process.env['DSH_SOURCE']), prepareOnly: false }
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (key === '--prepare-only') result.prepareOnly = true
    else if (['--dsh', '--scratch', '--evidence'].includes(key) && argv[i + 1]) result[key.slice(2)] = resolve(argv[++i])
    else throw new Error(`Unknown or incomplete argument ${key}`)
  }
  assert.ok(result.scratch, '--scratch must identify an installation-only --keep scratch directory')
  assert.ok(result.dsh, '--dsh or DSH_SOURCE must identify the pinned DSH checkout')
  const protectedHome = resolve(process.env['USERPROFILE'] ?? '.', '.dsh')
  assert.notEqual(resolve(result.scratch), protectedHome, 'Cannot run against the user DSH home')
  assert.ok(existsSync(join(result.scratch, 'dsh-home', 'profiles', 'web', 'package.json')), 'Packed scratch Web profile is missing')
  result.evidence ??= join(REPO, 'output', 'playwright', `chat-first-${Date.now()}-${randomUUID().slice(0, 8)}`)
  const relativeEvidence = relative(join(REPO, 'output', 'playwright'), result.evidence)
  assert.ok(relativeEvidence && !relativeEvidence.startsWith('..') && !isAbsolute(relativeEvidence), 'Evidence must be below output/playwright')
  return result
}
function safeEnvironment(extra) { return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH)/iu.test(key))), ...extra } }
async function prepare(args) {
  await mkdir(args.evidence, { recursive: true })
  const fileParent = join(args.dsh, '.tmp')
  await mkdir(fileParent, { recursive: true })
  const files = await mkdtemp(join(fileParent, 'chat-first-file-'))
  await writeFile(join(files, 'restore.txt'), 'ORIGINAL_CRLF\r\n', 'utf8')
  await writeFile(join(files, 'conflict.txt'), 'ORIGINAL_CONFLICT\r\n', 'utf8')
  const inputs = join(args.evidence, 'actual-generate-options.jsonl')
  const adapter = pathToFileURL(join(REPO, 'tests', 'fixtures', 'browser', 'chat-first-llm.ts')).href.replaceAll("'", "''")
  const patch = join(args.evidence, 'cordis.chat-first.yml')
  await writeFile(patch, `# Real Web profile with a local keyless model and in-page picker.\n- id: llm-deepseek\n  name: '@deepseek-ai/dsh-llm-deepseek-api-key'\n  disabled: true\n- id: agent-default-model\n  config:\n    provider: agent-workspace-chat-first\n    model: chat-first-keyless\n- id: directory-picker\n  name: '@deepseek-ai/dsh-host-directory-picker-auto'\n  disabled: true\n- id: session-persistence-jsonl\n  config:\n    root: !!js dshHomePath('sessions')\n    compression: none\n- insert:\n    - id: directory-picker-browse\n      name: '@deepseek-ai/dsh-host-directory-picker-browse'\n    - id: ui-directory-picker-browse\n      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'\n    - id: agent-workspace-chat-first-llm\n      name: '${adapter}'\n`, 'utf8')
  await writeFile(patch, `${await readFile(patch, 'utf8')}\n- id: agent-workspace\n  config:\n    fileCheckpointDirectory: '${join(args.evidence, 'file-checkpoints').replaceAll('\\', '/').replaceAll("'", "''")}'\n`, 'utf8')
  const environment = safeEnvironment({ DSH_HOME: join(args.scratch, 'dsh-home'), DSH_AGENTS_HOME: join(args.scratch, 'agents-home'), DSH_TELEMETRY_DISABLED: '1', DSH_AGENT_GROUP_CHAT_FIRST_INPUTS: inputs, DSH_AGENT_GROUP_CHAT_FIRST_FILES: files, NODE_NO_WARNINGS: '1' })
  const command = ['dsh', '--profile', 'web', '--patch', patch, '--no-open', '--port', '0']
  await writeFile(join(args.evidence, 'launch.json'), `${JSON.stringify({ cwd: args.dsh, command: 'pnpm', args: command, environment: Object.fromEntries(Object.entries(environment).filter(([key]) => key.startsWith('DSH_'))), scratch: args.scratch }, null, 2)}\n`, 'utf8')
  return { environment, command, inputs, files }
}
async function until(read, accept, description) {
  const deadline = Date.now() + TIMEOUT
  let latest
  while (Date.now() < deadline) {
    try { latest = await read(); if (accept(latest)) return latest } catch (error) { if (!['ENOENT'].includes(error.code) && !(error instanceof SyntaxError) && !(error instanceof AggregateError)) throw error }
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error(`Timed out waiting for ${description}`)
}
async function waitReady(server) {
  return new Promise((resolveReady, reject) => {
    let text = ''; const timer = setTimeout(() => reject(new Error('Scratch Host readiness timed out')), 120_000)
    const append = chunk => { text = (text + String(chunk)).slice(-100_000); const url = /dsh web: (http:\/\/[^\s]+)/u.exec(text)?.[1]; if (url) { clearTimeout(timer); const address = new URL(url); assert.ok(['localhost', '127.0.0.1'].includes(address.hostname)); assert.notEqual(address.port, '3080', 'Cannot use the user app port'); resolveReady(url) } }
    server.stdout.on('data', append); server.stderr.on('data', append)
    server.nodeChildProcess.once('error', error => { clearTimeout(timer); reject(error) })
    server.nodeChildProcess.once('exit', code => { clearTimeout(timer); reject(new Error(`Scratch Host exited before readiness (${code})\n${text}`)) })
  })
}
async function stop(server) {
  if (!server || server.nodeChildProcess.exitCode !== null) return
  if (process.platform === 'win32') await execa('taskkill', ['/PID', String(server.pid), '/T', '/F'], { reject: false, stdio: 'ignore' })
  else { try { process.kill(-server.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error } }
  await server
}
async function scenario(page, args, launch, url) {
  const snapshots = []
  let organizationId = 'local'
  const record = () => readDurableRecord(launch.environment.DSH_HOME, organizationId)
  const durable = (accept, label) => until(record, accept, label)
  const capture = async label => { snapshots.push({ label, aria: await page.locator('body').ariaSnapshot() }); await page.screenshot({ path: join(args.evidence, `${label}.png`), fullPage: true }); await writeFile(join(args.evidence, 'aria-snapshots.json'), `${JSON.stringify(snapshots, null, 2)}\n`, 'utf8'); console.log(`Captured ${label}`) }
  await page.goto(url, { waitUntil: 'load' })
  await page.getByRole('tree', { name: /^(?:Sessions|会话)$/u }).waitFor()
  const notice = page.getByRole('dialog', { name: /^(?:Internal Testing Notice|Preview Notice|内测声明|预览版说明)$/u })
  try { await notice.waitFor({ state: 'visible', timeout: 2_000 }); await notice.getByRole('button', { name: /Continue|继续/u }).click() } catch (error) { if (error.name !== 'TimeoutError') throw error }
  await page.getByRole('button', { name: 'Add workspace', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Select Workspace Directory', exact: true })
  await picker.getByRole('button', { name: 'Edit path', exact: true }).click()
  await picker.getByRole('textbox', { name: 'Edit path', exact: true }).fill(join(args.scratch, 'core-workspace'))
  await picker.getByRole('textbox', { name: 'Edit path', exact: true }).press('Enter')
  await picker.getByRole('button', { name: 'Open', exact: true }).click()
  const coreComposer = page.getByRole('textbox', { name: /^(?:Describe what you want to build|Message or run a task)(?:, \/ commands, @ files or sessions)?$|^Message the agent$/u })
  await coreComposer.fill('CHAT_FIRST_CORE_READY'); await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page.getByText('CHAT_FIRST_REPLY', { exact: true }).last().waitFor()
  await page.getByRole('button', { name: 'Open Agent Organization', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Agent Organization', exact: true })
  const organization = dialog.getByRole('combobox', { name: 'Organization', exact: true })
  await organization.waitFor()
  const organizationLabel = `Chat-first smoke ${randomUUID().slice(0, 8)}`
  await dialog.locator('.dsh-agent-group-organization-management > summary').click()
  await dialog.getByRole('textbox', { name: 'Organization label', exact: true }).fill(organizationLabel)
  await dialog.getByRole('button', { name: 'Create organization', exact: true }).click()
  await until(() => organization.locator('option:checked').textContent(), value => value === organizationLabel, 'isolated organization selection')
  organizationId = await organization.inputValue()
  await dialog.locator('.dsh-agent-group-organization-management > summary').click()
  const nav = name => dialog.getByRole('navigation', { name: 'Organization views', exact: true }).getByRole('button', { name, exact: true })
  const profile = () => dialog.locator('[data-colleague-id]')
  await nav('Colleagues').click()
  await dialog.getByRole('button', { name: 'Add colleague', exact: true }).click()
  const form = dialog.locator('[data-mode="colleagues"] aside form')
  await form.getByRole('textbox', { name: 'Colleague name', exact: true }).fill('Alice')
  if (await form.getByRole('textbox', { name: 'New role name', exact: true }).count() === 0) await form.getByRole('button', { name: 'Create shared role', exact: true }).click()
  await form.getByRole('textbox', { name: 'New role name', exact: true }).fill('Chat-first engineer')
  await form.getByRole('textbox', { name: 'Responsibilities', exact: true }).fill('Verify chat-first UX')
  await form.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Use deterministic fixture responses; preserve named chat sources.')
  await form.getByRole('button', { name: 'Save and select role', exact: true }).click()
  await form.getByRole('button', { name: 'Add colleague', exact: true }).click()
  await dialog.locator('[data-colleague-list] strong').getByText('Alice', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: 'Add colleague', exact: true }).click()
  await form.getByRole('textbox', { name: 'Colleague name', exact: true }).fill('Bob')
  await form.getByRole('button', { name: 'Add colleague', exact: true }).click()
  const bobRecord = await durable(item => Object.values(item.aggregate.agents).some(agent => agent.name === 'Bob'), 'Bob creation')
  const bobId = Object.values(bobRecord.aggregate.agents).find(agent => agent.name === 'Bob').id
  await dialog.locator(`[data-colleague-list] button[data-agent-id="${bobId}"]`).click()
  await profile().getByRole('button', { name: 'Edit profile', exact: true }).click()
  await profile().getByRole('textbox', { name: 'Colleague name', exact: true }).fill(LONG_NAME)
  await profile().getByRole('button', { name: 'Save name', exact: true }).click()
  const people = await durable(item => Object.values(item.aggregate.agents).some(agent => agent.name === LONG_NAME), 'colleague rename')
  const alice = Object.values(people.aggregate.agents).find(agent => agent.name === 'Alice')
  const bob = Object.values(people.aggregate.agents).find(agent => agent.name === LONG_NAME)
  const history = profile().locator('details').filter({ hasText: 'Employment and identity records' })
  assert.equal(await history.getAttribute('open'), null, 'Identity history should start folded')
  assert.equal(await dialog.locator('[data-role-management]').getAttribute('open'), null, 'Role templates should remain auxiliary')
  await capture('01-people-profile')
  await nav('Conversations').click(); await dialog.getByRole('button', { name: 'New group', exact: true }).click()
  await dialog.getByPlaceholder('Group name', { exact: true }).fill('Chat-first group')
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  const members = dialog.getByRole('complementary', { name: 'Group members', exact: true })
  for (const colleague of [alice, bob]) {
    await members.getByRole('button', { name: 'Add colleague', exact: true }).click()
    const picker = dialog.locator('[role="dialog"][data-add-colleague]')
    await picker.getByRole('searchbox', { name: 'Search colleague name or role', exact: true }).fill(colleague.name)
    await picker.locator(`input[type="checkbox"][name="group-colleague"][value="${colleague.id}"]`).check()
    await picker.locator('button[data-confirm-join]').click()
    await picker.waitFor({ state: 'hidden' })
    await members.getByRole('group', { name: colleague.name, exact: true }).waitFor()
  }
  await dialog.getByRole('button', { name: 'Rename group', exact: true }).click(); await dialog.getByRole('textbox', { name: 'Group name', exact: true }).fill('聊天优先验收群')
  await dialog.getByRole('button', { name: 'Save group name', exact: true }).click()
  const joined = await durable(item => Object.values(item.aggregate.rooms).some(room => room.name === '聊天优先验收群'), 'group rename')
  const room = Object.values(joined.aggregate.rooms).find(room => room.name === '聊天优先验收群')
  const composer = () => dialog.locator('.dsh-agent-group-compose-row textarea')
  const send = async text => { await composer().fill(text); await dialog.getByRole('button', { name: 'Send', exact: true }).click(); await page.waitForFunction(element => element.value === '', await composer().elementHandle()); return durable(item => item.aggregate.events.some(event => event.type === 'room/message' && event.actor?.type === 'human' && event.text?.includes(text.split(' ').at(-1))), 'human message') }
  await send('@Alice CHAT_FIRST_MARKDOWN')
  const markdown = dialog.locator('[data-author="agent"]').filter({ hasText: 'CHAT_FIRST_MARKDOWN_REPLY' }).last()
  await markdown.waitFor(); assert.equal(await markdown.locator('strong').filter({ hasText: 'bold' }).count(), 1)
  assert.equal(await markdown.locator('pre code').count(), 1)
  const paragraphGaps = await markdown.locator('p').evaluateAll(nodes => nodes.slice(1).map((node, index) => node.getBoundingClientRect().top - nodes[index].getBoundingClientRect().bottom))
  assert.ok(paragraphGaps.every(gap => gap <= 32), `Markdown separator whitespace inflated the message bubble: ${paragraphGaps.join(', ')}`)
  await markdown.getByRole('link', { name: '@Alice', exact: true }).click()
  const modalProfile = dialog.getByRole('dialog', { name: 'Colleague details', exact: true })
  await modalProfile.getByRole('heading', { name: 'Alice', exact: true }).waitFor()
  await modalProfile.getByRole('button', { name: 'Close', exact: true }).click()
  const humanBubble = dialog.locator('[data-author="human"]').filter({ hasText: 'CHAT_FIRST_MARKDOWN' }).last()
  const bubbleDirections = await Promise.all([humanBubble.evaluate(node => getComputedStyle(node).flexDirection), markdown.evaluate(node => getComputedStyle(node).flexDirection)])
  assert.notEqual(bubbleDirections[0], bubbleDirections[1], 'Human and agent bubbles must have different alignment')
  await capture('02-bubbles-mentions')
  await page.setViewportSize({ width: 390, height: 844 })
  await dialog.getByRole('button', { name: 'Show group members', exact: true }).click()
  const longMember = members.getByRole('group', { name: LONG_NAME, exact: true })
  await longMember.getByRole('button', { name: 'Direct', exact: true }).waitFor()
  const geometry = await longMember.evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth, buttons: [...node.querySelectorAll('button')].map(button => ({ left: button.getBoundingClientRect().left, right: button.getBoundingClientRect().right })) }))
  assert.ok(geometry.scroll <= geometry.width + 1, 'Long-name member card overflowed')
  assert.ok(geometry.buttons.every(button => button.left >= 0 && button.right <= 391), 'Narrow member controls are outside the viewport')
  await capture('03-narrow-members')
  await dialog.getByRole('button', { name: 'Hide group members', exact: true }).click(); await page.setViewportSize({ width: 1440, height: 960 })
  await dialog.getByRole('button', { name: 'Assign work', exact: true }).click()
  await dialog.getByRole('combobox', { name: 'Assignee', exact: true }).selectOption(alice.id)
  assert.equal(await dialog.locator('[data-allow-delegation]').isChecked(), false)
  await composer().fill('CHAT_FIRST_ASSIGNED_WORK complete report')
  await dialog.getByRole('button', { name: 'Send and assign', exact: true }).click()
  const assigned = await durable(item => Object.values(item.aggregate.tasks).some(task => task.status === 'completed' && task.title.includes('CHAT_FIRST_ASSIGNED_WORK')), 'formal work completion')
  const task = Object.values(assigned.aggregate.tasks).find(task => task.title.includes('CHAT_FIRST_ASSIGNED_WORK'))
  assert.equal(assigned.communication.taskSources[task.id].roomId, room.id); assert.equal(Object.keys(assigned.aggregate.delegationGrants).length, 0)
  const accepted = assigned.aggregate.events.filter(event => event.type === 'task/delivery-accepted' && event.taskId === task.id)
  assert.equal(accepted.length, 1, 'Chat assignment should deliver once')
  await send('@Alice CHAT_FIRST_PROPOSE')
  await dialog.locator('[data-author="agent"]').filter({ hasText: 'CHAT_FIRST_PROPOSAL_READY' }).last().waitFor()
  const proposed = await record(); const pending = Object.values(proposed.workflow.drafts).find(draft => draft.status === 'draft' && draft.brief.title === 'CHAT_FIRST_PROPOSAL')
  assert.ok(pending); assert.equal(Object.keys(proposed.aggregate.tasks).length, Object.keys(assigned.aggregate.tasks).length, 'Proposal started work before confirmation')
  await dialog.locator(`[data-mode="conversations"] [data-pending-work="${pending.id}"]`).waitFor()
  await nav('Tasks').click(); await dialog.getByRole('combobox', { name: 'Colleague', exact: true }).selectOption(alice.id)
  const sourceEventId = assigned.communication.taskSources[task.id].eventId
  await dialog.locator('.dsh-agent-group-work-card').filter({ has: page.locator(`[data-task-id="${task.id}"]`) }).getByRole('button', { name: 'From chat · 聊天优先验收群', exact: true }).click()
  await dialog.locator(`[data-message-id="${sourceEventId}"][data-highlighted="true"]`).waitFor()
  await page.waitForFunction(id => document.activeElement?.getAttribute('data-message-id') === id, sourceEventId)
  await nav('Tasks').click()
  const pendingCard = dialog.locator(`[data-pending-work="${pending.id}"]`)
  await pendingCard.getByText('Awaiting confirmation', { exact: true }).waitFor()
  await pendingCard.getByRole('button', { name: 'Confirm in chat', exact: true }).click()
  await dialog.locator('[data-chat-work]').waitFor(); await dialog.getByRole('combobox', { name: 'Assignee', exact: true }).selectOption(alice.id)
  await dialog.getByRole('button', { name: 'Send and assign', exact: true }).click()
  const confirmed = await durable(item => item.workflow.drafts[pending.id]?.status === 'confirmed', 'proposal confirmation')
  const confirmedTask = confirmed.workflow.drafts[pending.id].taskId
  assert.equal(confirmed.communication.taskSources[confirmedTask].roomId, room.id)
  assert.notEqual(confirmed.communication.taskSources[confirmedTask].eventId, confirmed.communication.draftSources[pending.id].eventId, 'Confirmation needs its own actual human message')
  await capture('04-chat-work-confirmation')
  await members.getByRole('group', { name: LONG_NAME, exact: true }).locator('.dsh-agent-group-member-identity').click()
  await modalProfile.getByRole('button', { name: 'View personal memory', exact: true }).click()
  await dialog.locator('[data-memory-owner]').getByRole('heading', { name: `${LONG_NAME}'s memory`, exact: true }).waitFor()
  assert.equal(await dialog.getByRole('combobox', { name: 'Agent', exact: true }).inputValue(), bob.id)
  await dialog.getByRole('searchbox', { name: 'Search memory', exact: true }).fill('CHAT_FIRST_MARKDOWN')
  await dialog.locator('[data-memory-event]').first().waitFor()
  const markdownMemory = dialog.locator('[data-memory-event]').filter({ hasText: 'CHAT_FIRST_MARKDOWN_REPLY' }).first()
  await markdownMemory.locator('[data-memory-event-details] > summary').click()
  await markdownMemory.locator('[data-memory-event-details] strong').filter({ hasText: 'bold' }).waitFor()
  assert.equal(await markdownMemory.locator('[data-memory-event-details] pre code').count(), 1)
  await capture('05-memory-owner-search')
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.locator('body[data-ds-dark-theme]').waitFor()
  await capture('05b-dark-memory')
  await page.emulateMedia({ colorScheme: 'light' })
  await nav('Conversations').click()
  await send('@Alice CHAT_FIRST_FILE_WRITE')
  await dialog.locator('[data-author="agent"]').filter({ hasText: 'CHAT_FIRST_FILE_WRITTEN' }).last().waitFor()
  assert.equal(await readFile(join(launch.files, 'restore.txt'), 'utf8'), 'MODEL_CHANGED\n')
  assert.equal(await readFile(join(launch.files, 'conflict.txt'), 'utf8'), 'MODEL_CHANGED\n')
  await writeFile(join(launch.files, 'conflict.txt'), 'MANUAL_CHANGE\r\n', 'utf8')
  const fileRecord = await record()
  const fileSource = fileRecord.aggregate.events.find(event => event.type === 'room/message' && event.actor?.type === 'human' && event.text?.includes('CHAT_FIRST_FILE_WRITE'))
  await dialog.locator(`[data-message-id="${fileSource.id}"]`).getByRole('button', { name: 'Withdraw', exact: true }).click()
  const fileRecall = dialog.locator('[data-message-recall]')
  const restoreCheckbox = fileRecall.getByRole('checkbox', { name: 'Also restore local files with trusted checkpoints (off by default)', exact: true })
  await restoreCheckbox.waitFor(); assert.equal(await restoreCheckbox.isChecked(), false)
  const diff = fileRecall.locator('li').filter({ hasText: 'restore.txt' }).locator('[data-file-diff]')
  await diff.locator('summary').click()
  await diff.getByText('ORIGINAL_CRLF', { exact: true }).waitFor()
  await diff.getByText('MODEL_CHANGED', { exact: true }).waitFor()
  await markdown.evaluate(node => node.scrollIntoView({ block: 'center' }))
  const copyButton = dialog.getByRole('button', { name: 'Copy', exact: true }).first()
  assert.equal(await copyButton.evaluate(node => { const r = node.getBoundingClientRect(); return Boolean(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('.dsh-agent-group-modal')) }), true, 'Markdown controls escaped the recall backdrop')
  await capture('05c-file-difference-preview')
  await diff.locator('summary').click()
  await restoreCheckbox.check(); await fileRecall.locator('[data-confirm-recall]').click()
  await fileRecall.getByText('Message withdrawn and colleague memory reset. File recovery outcomes are separate.', { exact: true }).waitFor()
  assert.equal(await readFile(join(launch.files, 'restore.txt'), 'utf8'), 'ORIGINAL_CRLF\r\n')
  assert.equal(await readFile(join(launch.files, 'conflict.txt'), 'utf8'), 'MANUAL_CHANGE\r\n')
  assert.equal(await fileRecall.getByText('Withdrawal has not been confirmed complete. Retry; if reset started, colleagues remain paused without continuing from old memory.', { exact: true }).count(), 0)
  await capture('05c-file-recovery-conflict')
  await fileRecall.press('Escape'); await fileRecall.waitFor({ state: 'hidden' })
  await send(`@Alice ${SECRET}`)
  await dialog.locator('[data-author="agent"]').filter({ hasText: 'CHAT_FIRST_SECRET_READ' }).last().waitFor()
  const before = await record(); const secretEvent = before.aggregate.events.find(event => event.type === 'room/message' && event.actor?.type === 'human' && event.text?.includes(SECRET))
  assert.ok(secretEvent)
  const oldSession = before.aggregate.sessionBindings[alice.id]
  const optionsBefore = (await readFile(launch.inputs, 'utf8')).trim().split(/\r?\n/u).map(line => JSON.parse(line))
  assert.ok(optionsBefore.some(value => value.currentText.includes(SECRET) && String(value.input.sessionId) === oldSession), 'Sentinel did not reach Alice’s actual old model context')
  await dialog.locator(`[data-message-id="${secretEvent.id}"]`).getByRole('button', { name: 'Withdraw', exact: true }).click()
  const recall = dialog.locator('[data-message-recall]')
  await recall.locator('[data-confirm-recall]').waitFor(); await recall.locator('[data-confirm-recall]').click()
  await recall.getByText('Message withdrawn and colleague memory reset. File recovery outcomes are separate.', { exact: true }).waitFor()
  await recall.getByRole('button', { name: 'Cancel', exact: true }).click()
  const resetRecord = await durable(item => Object.values(item.communication.resets).some(reset => reset.source.eventId === secretEvent.id && reset.status === 'completed'), 'completed memory reset')
  assert.notEqual(resetRecord.aggregate.sessionBindings[alice.id], oldSession, 'Recall reused the old Session')
  await send('@Alice CHAT_FIRST_POST_RECALL')
  await dialog.locator('[data-author="agent"]').filter({ hasText: 'CHAT_FIRST_FRESH_CONTEXT_OK' }).last().waitFor()
  const optionsAfter = (await readFile(launch.inputs, 'utf8')).trim().split(/\r?\n/u).map(line => JSON.parse(line)).filter(value => value.currentText.includes('CHAT_FIRST_POST_RECALL'))
  assert.ok(optionsAfter.length > 0); assert.ok(optionsAfter.every(value => !JSON.stringify(value.input).includes(SECRET) && String(value.input.sessionId) !== oldSession), 'Old already-read content reached a fresh model request')
  await capture('06-withdrawal-fresh-context')
  await nav('Memory').click(); await dialog.getByRole('combobox', { name: 'Colleague', exact: true }).selectOption(alice.id)
  await dialog.getByRole('searchbox', { name: 'Search memory', exact: true }).fill(SECRET)
  await dialog.getByText('No memory events match these filters.', { exact: true }).waitFor()
  assert.equal(await dialog.locator('[data-memory-event]').count(), 0)
  await writeFile(join(args.evidence, 'receipt.json'), `${JSON.stringify({ passed: true, scratch: args.scratch, organizationId, roomId: room.id, aliceId: alice.id, bobId: bob.id, taskId: task.id, pendingId: pending.id, confirmedTaskId: confirmedTask, oldSession, freshSession: resetRecord.aggregate.sessionBindings[alice.id], postRecallGenerateOptions: optionsAfter.length }, null, 2)}\n`, 'utf8')
}

async function chineseDarkInspection(browser, args, url) {
  const receipt = JSON.parse(await readFile(join(args.evidence, 'receipt.json'), 'utf8'))
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN', colorScheme: 'dark' })
  try {
    const page = await context.newPage(); page.setDefaultTimeout(TIMEOUT)
    await page.goto(url, { waitUntil: 'load' })
    const notice = page.getByRole('dialog', { name: /内测声明|预览版说明/u })
    try { await notice.waitFor({ timeout: 2_000 }); await notice.getByRole('button', { name: /继续/u }).click() } catch (error) { if (error.name !== 'TimeoutError') throw error }
    await page.getByRole('button', { name: '打开智能体组织', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '智能体组织', exact: true })
    await dialog.getByRole('combobox', { name: '组织', exact: true }).selectOption(receipt.organizationId)
    await dialog.getByRole('button', { name: '记忆', exact: true }).click()
    await dialog.getByRole('combobox', { name: '同事', exact: true }).selectOption(receipt.bobId)
    await dialog.getByRole('searchbox', { name: '搜索记忆', exact: true }).fill('CHAT_FIRST_MARKDOWN')
    await dialog.locator('[data-memory-event]').first().waitFor()
    assert.ok(await dialog.getByText('聊天消息', { exact: true }).count() > 0, 'Memory event labels are not Chinese')
    await dialog.getByRole('heading', { name: `${LONG_NAME} 的记忆`, exact: true }).waitFor()
    await page.locator('body[data-ds-dark-theme]').waitFor()
    await page.screenshot({ path: join(args.evidence, '07-chinese-dark-memory.png'), fullPage: true })
    await dialog.getByRole('button', { name: '同事', exact: true }).click()
    await dialog.locator(`[data-colleague-list] button[data-agent-id="${receipt.aliceId}"]`).click()
    const direct = dialog.locator('[data-colleague-id]').getByRole('button', { name: '私聊', exact: true })
    assert.ok(await direct.count() > 0, 'Personal profile navigation is missing')
    await page.screenshot({ path: join(args.evidence, '08-chinese-dark-profile.png'), fullPage: true })
    await writeFile(join(args.evidence, 'chinese-dark-aria.yml'), await page.locator('body').ariaSnapshot(), 'utf8')
    await writeFile(join(args.evidence, 'chinese-dark-receipt.json'), `${JSON.stringify({ passed: true, organizationId: receipt.organizationId, ownerId: receipt.bobId, locale: 'zh-CN', theme: 'dark' }, null, 2)}\n`, 'utf8')
  } finally { await context.close() }
}

async function main() {
  const args = argsOf(process.argv.slice(2))
  if (args.help) { console.log('Install packed plugins first with release-smoke --installation-only --keep --skip-dsh-prepare. Then: node tests/e2e/chat-first-browser.mjs --scratch <kept-scratch> --dsh <pinned-source> [--prepare-only]. DSH_SOURCE can supply --dsh. Artifacts: output/playwright/.'); return }
  const launch = await prepare(args)
  if (args.prepareOnly) { console.log(`Launch prepared: ${join(args.evidence, 'launch.json')}`); return }
  let server; let browser; let page; let hostLog = ''
  const failures = []
  const httpFailures = []
  const responseReads = []
  const rpcFrames = []
  try {
    server = execa('pnpm', launch.command, { cwd: args.dsh, env: launch.environment, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], reject: false })
    const log = chunk => { hostLog += String(chunk) }; server.stdout.on('data', log); server.stderr.on('data', log)
    const url = await waitReady(server)
    browser = await chromium.launch(); const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'en-US' })
    await context.tracing.start({ screenshots: true, snapshots: true }); page = await context.newPage(); page.setDefaultTimeout(TIMEOUT)
    page.on('pageerror', error => failures.push(error.message))
    page.on('websocket', socket => {
      socket.on('framesent', event => rpcFrames.push({ direction: 'sent', payload: String(event.payload) }))
      socket.on('framereceived', event => rpcFrames.push({ direction: 'received', payload: String(event.payload) }))
    })
    page.on('response', response => {
      if (response.status() >= 400) responseReads.push(response.text().then(body => { httpFailures.push({ pathname: new URL(response.url()).pathname, status: response.status(), request: response.request().postData(), body }) }))
    })
    try { await scenario(page, args, launch, url); await chineseDarkInspection(browser, args, url); assert.deepEqual(failures, [], 'Browser JavaScript errors') }
    finally { await context.tracing.stop({ path: join(args.evidence, 'trace.zip') }) }
    console.log(`Chat-first Browser PASS; evidence: ${args.evidence}`)
  } catch (error) {
    await page?.screenshot({ path: join(args.evidence, 'failure.png'), fullPage: true }).catch(() => {})
    if (page) await writeFile(join(args.evidence, 'failure-aria.yml'), await page.locator('body').ariaSnapshot(), 'utf8')
    await writeFile(join(args.evidence, 'failure.json'), `${JSON.stringify({ message: error.message, browserErrors: failures }, null, 2)}\n`, 'utf8')
    throw error
  } finally { await Promise.allSettled(responseReads); await writeFile(join(args.evidence, 'http-failures.json'), `${JSON.stringify(httpFailures, null, 2)}\n`, 'utf8'); await writeFile(join(args.evidence, 'rpc-frames.json'), `${JSON.stringify(rpcFrames, null, 2)}\n`, 'utf8'); await browser?.close(); await stop(server); await writeFile(join(args.evidence, 'host.log'), hostLog.replace(/([?&]token=)[^\s&]+/gu, '$1<redacted>'), 'utf8') }
}
await main()
