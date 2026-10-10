/** Durable evidence reader for the real profile task-tools smoke. */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const STEP_TIMEOUT_MS = 30_000
const TASK_TOOL_EXPECTED = new URL('../fixtures/task-tools/profile-session.expected.json', import.meta.url)

function parseArgs(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid task-tools-profile argument near ${key ?? '<end>'}`)
    values.set(key.slice(2), value)
  }
  for (const key of ['dsh-home', 'evidence', 'task-tools-fixture']) {
    if (!values.has(key)) throw new Error(`missing --${key}`)
  }
  return Object.fromEntries(values)
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

async function taskToolSessionRows(dshHome, sessionId) {
  const contents = await Promise.all((await jsonlFiles(join(dshHome, 'sessions'))).map(path => readFile(path, 'utf8')))
  const sessions = contents.map(content => content.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line)))
  const matching = sessions.filter(rows => rows[0]?.type === 'session' && rows[0].id === sessionId)
  if (matching.length !== 1) throw new Error('profile task tools require one bound employee Session')
  return matching[0].slice(1)
}

/** Assert that a formal task used a previously acquired room fact through logged recall and tool results. */
export function assertTaskToolEvidence(durable, fixture, expected, rows) {
  if (typeof fixture.memoryEventId !== 'string') throw new Error('profile task fixture omitted its passive memory event')
  const original = durable.events.find(event => event.id === fixture.memoryEventId)
  if (original?.type !== expected.memory.type || original.text !== expected.memory.text
    || original.sequence !== fixture.memorySequence || original.mentions?.length !== 0) {
    throw new Error('profile task memory does not match the unmentioned room requirement')
  }
  const memory = durable.memoryEntries.find(entry => entry.agentId === fixture.aliceAgentId && entry.eventId === original.id)
  if (memory?.acquiredBy !== expected.memory.acquiredBy) throw new Error('profile task memory did not come from room membership')
  if (durable.events.some(event => event.type === 'runtime/session-bound' && event.subjectId === fixture.aliceAgentId
    && event.sequence < original.sequence)) throw new Error('passive room requirement materialized its employee')
  const completed = durable.events.filter(event => (
    event.type === 'task/result' && event.taskId === fixture.taskId && event.text === expected.result
  ))
  if (completed.length !== 1) throw new Error(`expected one durable task-tool result; found ${completed.length}`)
  const task = durable.tasks[completed[0].taskId]
  if (task?.status !== 'completed') throw new Error('task-tool result did not complete its task')
  const serializedRows = rows.map(row => JSON.stringify(row))
  for (const name of expected.tools) {
    if (!serializedRows.some(row => row.includes(name))) throw new Error(`recorded Session omitted model-visible ${name} schema or call`)
  }
  const deliveryIndex = rows.findIndex(row => row.type === 'user/message'
    && row.data?.source?.kind === 'agent-workspace-delivery' && row.data.source.source?.kind === 'task'
    && row.data.source.source.taskId === fixture.taskId)
  const recallIndex = rows.findIndex(row => row.type === 'user/message' && row.data?.source?.kind === 'agent-workspace-recall'
    && messageText(row.data).includes(`[event:${original.id} `) && messageText(row.data).includes(expected.memory.text))
  if (deliveryIndex < 0 || recallIndex <= deliveryIndex) throw new Error('recorded formal task omitted its admitted personal-memory recall')
  const search = recordedTool(rows, 'profile-memory-search', 'workspace_search_memory')
  if (JSON.stringify(search.args) !== JSON.stringify({ query: expected.memory.query })) throw new Error('recorded memory search used the wrong query')
  const searchValue = JSON.parse(messageText(search.result))
  const found = searchValue.events?.find(event => event.eventId === original.id && event.excerpt.includes(expected.memory.text))
  if (search.result.isError === true || found === undefined || typeof searchValue.hasMore !== 'boolean') throw new Error('recorded memory search omitted its acquired room requirement')
  const read = recordedTool(rows, 'profile-memory-read', 'workspace_read_memory')
  if (JSON.stringify(read.args) !== JSON.stringify({ eventId: found.eventId })) throw new Error('recorded memory read did not use the searched event id')
  const readValue = JSON.parse(messageText(read.result))
  if (read.result.isError === true || readValue.eventId !== original.id || readValue.sequence !== original.sequence
    || readValue.type !== expected.memory.type || readValue.acquiredBy !== expected.memory.acquiredBy
    || readValue.text !== expected.memory.text || readValue.offset !== 0
    || readValue.totalCharacters !== expected.memory.text.length || readValue.nextOffset !== undefined) {
    throw new Error('recorded memory read omitted the complete original text or its source')
  }
  const policy = recordedTool(rows, 'profile-policy-denial', 'workspace_delegate_task')
  if (policy.args.rootTaskId !== fixture.taskId || policy.args.assigneeAgentId !== fixture.deniedAssigneeAgentId
    || policy.result.isError !== true) throw new Error('recorded policy denial did not fail the unauthorized delegation')
  const complete = recordedTool(rows, 'profile-complete-task', 'workspace_complete_task')
  if (complete.args.taskId !== fixture.taskId || complete.args.result !== expected.result
    || complete.result.isError === true || messageText(complete.result) !== `Completed task ${fixture.taskId}.`) {
    throw new Error('recorded task completion did not acknowledge the assigned task')
  }
  if (search.callIndex <= recallIndex || read.callIndex <= search.resultIndex
    || policy.callIndex <= read.resultIndex || complete.callIndex <= policy.resultIndex) {
    throw new Error('recorded task tools did not search, read, deny delegation and complete in order')
  }
  if (!serializedRows.some(row => row.includes(expected.result))) throw new Error('recorded Session omitted successful task-tool result')
  const denied = rows.filter(row => row.type === 'tool/result').map(row => JSON.stringify(row)).filter(row => row.includes(expected.policyError))
  if (denied.length !== 1) throw new Error(`expected one recorded policy denial; found ${denied.length}`)
  if (denied[0].includes('"details"')) throw new Error('recorded policy denial exposed error details')
  for (const id of [fixture.taskId, fixture.deniedAssigneeAgentId, 'profile-task-human']) {
    if (denied[0].includes(id)) throw new Error('recorded policy denial leaked a workspace identifier')
  }
  return {
    tools: expected.tools,
    result: expected.result,
    policyError: expected.policyError,
    policyResultRows: denied.length,
    memory: {
      eventId: original.id,
      sequence: original.sequence,
      type: readValue.type,
      acquiredBy: readValue.acquiredBy,
      text: readValue.text,
      searchCallId: search.call.id,
      readCallId: read.call.id,
    },
  }
}

function messageText(message) {
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

function recordedTool(rows, callId, name) {
  const calls = rows.filter(row => row.type === 'assistant/message')
    .flatMap(row => row.data.message.content.filter(block => block.type === 'tool-call' && block.id === callId))
  const results = rows.filter(row => row.type === 'tool/result' && row.data.message.toolCallId === callId)
  if (calls.length !== 1 || calls[0].name !== name || results.length !== 1) throw new Error(`recorded Session omitted the unique ${name} call or result`)
  const callIndex = rows.findIndex(row => row.type === 'assistant/message'
    && row.data.message.content.some(block => block.type === 'tool-call' && block.id === callId))
  const resultIndex = rows.indexOf(results[0])
  if (resultIndex <= callIndex) throw new Error(`recorded ${name} result preceded its call`)
  return { call: calls[0], args: JSON.parse(calls[0].arguments), result: results[0].data.message, callIndex, resultIndex }
}

/** Read the profile fixture's bound Session and validate its task and memory evidence. */
export async function collectTaskToolEvidence(dshHome, fixturePath) {
  const [durable, expected, fixture] = await Promise.all([
    readDurableWorkspace(dshHome),
    readFile(TASK_TOOL_EXPECTED, 'utf8').then(content => JSON.parse(content)),
    readFile(fixturePath, 'utf8').then(content => JSON.parse(content)),
  ])
  const rows = await taskToolSessionRows(dshHome, durable.sessionBindings[fixture.aliceAgentId])
  return assertTaskToolEvidence(durable, fixture, expected, rows)
}

async function waitForEvidence(args) {
  const deadline = Date.now() + STEP_TIMEOUT_MS
  let lastError
  while (Date.now() < deadline) {
    try {
      return await collectTaskToolEvidence(args['dsh-home'], args['task-tools-fixture'])
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  throw new Error(`profile task-tool evidence did not settle: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const recorded = await waitForEvidence(args)
  await writeFile(join(args.evidence, 'task-tools-recorded-session.json'), `${JSON.stringify(recorded, null, 2)}\n`, 'utf8')
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) await main()
