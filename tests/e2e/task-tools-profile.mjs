/** Durable evidence reader for the real profile task-tools smoke. */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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

async function taskToolSessionRows(dshHome) {
  const contents = await Promise.all((await jsonlFiles(join(dshHome, 'sessions'))).map(path => readFile(path, 'utf8')))
  return contents.flatMap(content => content.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line)))
}

async function evidence(durable, args) {
  const expected = JSON.parse(await readFile(TASK_TOOL_EXPECTED, 'utf8'))
  const fixture = JSON.parse(await readFile(args['task-tools-fixture'], 'utf8'))
  const completed = durable.events.filter(event => (
    event.type === 'task/result' && event.text === expected.result
  ))
  if (completed.length !== 1) throw new Error(`expected one durable task-tool result; found ${completed.length}`)
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
  if (denied[0].includes('"details"')) throw new Error('recorded policy denial exposed error details')
  for (const id of [fixture.taskId, fixture.deniedAssigneeAgentId, 'profile-task-human']) {
    if (denied[0].includes(id)) throw new Error('recorded policy denial leaked a workspace identifier')
  }
  return {
    tools: expected.tools,
    result: expected.result,
    policyError: expected.policyError,
    policyResultRows: denied.length,
  }
}

async function waitForEvidence(args) {
  const deadline = Date.now() + STEP_TIMEOUT_MS
  let lastError
  while (Date.now() < deadline) {
    try {
      return await evidence(await readDurableWorkspace(args['dsh-home']), args)
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

await main()
