/** Checks and deterministic evidence helpers for the release smoke. */

import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

const BUNDLE = 'dsh-agent-group'
const HOST = '@dsh-agent-group/host'
const WEB = '@dsh-agent-group/web'
const AUTO_DIRECTORY_PICKER = '@deepseek-ai/dsh-host-directory-picker-auto'
const BROWSER_DIRECTORY_PICKER = '@deepseek-ai/dsh-host-directory-picker-browse'
const BROWSER_DIRECTORY_PICKER_UI = '@deepseek-ai/dsh-client-ui-directory-picker-browse'
const REGISTRY_PACKAGES = [HOST, WEB, BUNDLE]

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function scalar(value) {
  const trimmed = value.trim()
  if ((trimmed.startsWith("'") && trimmed.endsWith("'"))
    || (trimmed.startsWith('"') && trimmed.endsWith('"'))) return trimmed.slice(1, -1)
  return trimmed
}

function packageEntries(lockfile, name) {
  const packagesHeading = /^packages:\s*$/mu.exec(lockfile)
  if (packagesHeading === null) return []
  const afterPackages = lockfile.slice(packagesHeading.index + packagesHeading[0].length)
  const nextSection = /\n\S[^\n]*:\s*$/mu.exec(afterPackages)
  const packages = afterPackages.slice(0, nextSection?.index)
  const heading = new RegExp(`^ {2}(?:['\"])?${escapeRegExp(name)}@([^'\":(]+)(?:\\([^)]*\\))?(?:['\"])?\\s*:\\s*$`, 'gmu')
  const entries = []
  for (let match = heading.exec(packages); match !== null; match = heading.exec(packages)) {
    const remainder = packages.slice(match.index + match[0].length)
    const nextHeading = /\n {2}\S/u.exec(remainder)
    const block = packages.slice(match.index, nextHeading === null ? packages.length : match.index + match[0].length + nextHeading.index)
    const integrity = /^ {4}resolution:\s*\{[^}\n]*\bintegrity:\s*([^,}\s]+)[^}\n]*\}/mu.exec(block)?.[1]
      ?? /^ {4}resolution:\s*\n(?:^ {6}.*\n)*?^ {6}integrity:\s*([^\s]+)\s*$/mu.exec(block)?.[1]
    entries.push({ version: match[1], integrity })
  }
  return entries
}

function importerSpecifier(lockfile, name) {
  const importersHeading = /^importers:\s*$/mu.exec(lockfile)
  if (importersHeading === null) return undefined
  const afterImporters = lockfile.slice(importersHeading.index + importersHeading[0].length)
  const packagesHeading = /\npackages:\s*$/mu.exec(afterImporters)
  const importers = afterImporters.slice(0, packagesHeading?.index)
  const heading = new RegExp(`^ {6}(?:['"])?${escapeRegExp(name)}(?:['"])?:\\s*$`, 'mu').exec(importers)
  if (heading === null) return undefined
  const remainder = importers.slice(heading.index + heading[0].length)
  const nextHeading = /\n {6}\S/u.exec(remainder)
  const block = remainder.slice(0, nextHeading?.index)
  return /^ {8}specifier:\s*([^\s]+)\s*$/mu.exec(block)?.[1]
}

function configRows(config) {
  const lines = config.split(/\r?\n/u)
  const rows = []
  for (let index = 0; index < lines.length; index++) {
    const start = /^(\s*)-\s+(id|name):\s*(.+?)\s*$/u.exec(lines[index])
    if (start === null) continue
    const indent = start[1].length
    const values = { [start[2]]: scalar(start[3]) }
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const line = lines[cursor]
      const next = /^(\s*)-\s+/u.exec(line)
      if (next !== null && next[1].length <= indent) break
      const field = /^(\s+)(id|name|disabled):\s*(.+?)\s*$/u.exec(line)
      if (field !== null && field[1].length === indent + 2) {
        const value = scalar(field[3])
        if (value === '>-' || value === '>-') {
          const continuation = lines.slice(cursor + 1).find(candidate => candidate.trim() !== '')
          if (continuation !== undefined && continuation.search(/\S/u) > field[1].length) values[field[2]] = scalar(continuation)
        } else values[field[2]] = value
      }
      if (line.trim() !== '' && line.search(/\S/u) <= indent) break
    }
    rows.push(values)
  }
  return rows
}

/** Reject a registry response that cannot prove the exact published manifest. */
export function assertPublishedRegistryPackage(manifest, version) {
  if (manifest?.version !== version) throw new Error(`${manifest?.name ?? 'registry package'} version is ${manifest?.version ?? 'missing'}; expected ${version}`)
  if (typeof manifest.integrity !== 'string' || !manifest.integrity.startsWith('sha512-')) {
    throw new Error(`${manifest.name} registry integrity is missing or invalid`)
  }
  if (typeof manifest.tarball !== 'string' || !manifest.tarball.endsWith(`-${version}.tgz`)) {
    throw new Error(`${manifest.name} registry tarball does not identify ${version}`)
  }
  if (manifest.name === BUNDLE && (manifest.dependencies?.[HOST] !== `^${version}` || manifest.dependencies?.[WEB] !== `^${version}`)) {
    throw new Error(`bundle dependency must use ^${version} for ${HOST} and ${WEB}`)
  }
}

/** Return the ordered DSH commands that install and then pin a registry release. */
export function registryProfileCommands(version) {
  return [
    ['dsh', 'plugin', '--profile', 'web', 'add', `${BUNDLE}@${version}`],
    ['dsh', 'plugin', '--profile', 'web', 'add', '--save-exact', `${HOST}@${version}`, `${WEB}@${version}`],
  ]
}

/** Return the public DSH command that removes every directly installed release package. */
export function uninstallProfileCommand(manifest) {
  const dependencies = manifest?.dependencies ?? {}
  const direct = REGISTRY_PACKAGES.filter(name => Object.hasOwn(dependencies, name))
  return direct.length === 0
    ? null
    : ['dsh', 'plugin', '--profile', 'web', 'remove', ...direct]
}

/** Reject a profile manifest unless every release package is a direct exact dependency. */
export function assertProfileManifest(manifest, version) {
  for (const name of REGISTRY_PACKAGES) {
    const specifier = manifest?.dependencies?.[name]
    if (specifier !== version) {
      throw new Error(`${name} profile dependency is ${specifier ?? 'missing'}; expected exact ${version}`)
    }
  }
}

/** Reject a profile lock whose published packages are not exact and integrity-matched. */
export function assertProfileLock(lockfile, version, registryPackages) {
  for (const registryPackage of registryPackages) {
    const entries = packageEntries(lockfile, registryPackage.name)
    if (entries.length === 0 || entries.some(entry => entry.version !== version)) {
      throw new Error(`${registryPackage.name} lock entries resolve to ${entries.map(entry => entry.version).join(', ') || 'nothing'}; expected only ${version}`)
    }
    if (entries.some(entry => entry.integrity !== registryPackage.integrity)) {
      throw new Error(`${registryPackage.name} lock integrity does not match npm view`)
    }
  }
  for (const registryPackage of registryPackages) {
    const specifier = importerSpecifier(lockfile, registryPackage.name)
    if (specifier !== version) {
      throw new Error(`${registryPackage.name} lock importer specifier is ${specifier ?? 'missing'}; expected exact ${version}`)
    }
  }
}

/** Reject a resolved dependency tree that omits or substitutes a release package. */
export function assertResolvedPackages(resolvedPackages, version) {
  for (const name of REGISTRY_PACKAGES) {
    const installations = resolvedPackages
      .filter(entry => entry.name === name)
      .flatMap(entry => entry.installations ?? [])
    if (installations.length === 0 || installations.some(installation => installation.version !== version)) {
      throw new Error(`${name} resolved to ${installations.map(item => item.version).join(', ') || 'nothing'}; expected only ${version}`)
    }
  }
}

/** Reject an assembled profile that omits any exact release-smoke plugin row. */
export function assertAssembledConfig(config, scriptedAdapter, taskToolsProfile) {
  const rows = configRows(config)
  const has = (id, name) => rows.some(row => row.id === id && row.name === name)
  if (!has('agent-workspace', HOST)) throw new Error(`assembled profile omitted Host row id=agent-workspace name=${HOST}`)
  if (!has('agent-workspace-web', WEB)) throw new Error(`assembled profile omitted Web row id=agent-workspace-web name=${WEB}`)
  if (!rows.some(row => row.id === 'directory-picker' && row.name === AUTO_DIRECTORY_PICKER && row.disabled === 'true')
    || !has('directory-picker-browse', BROWSER_DIRECTORY_PICKER)
    || !has('ui-directory-picker-browse', BROWSER_DIRECTORY_PICKER_UI)) {
    throw new Error('assembled profile omitted the deterministic browser directory picker rows')
  }
  if (!has('agent-workspace-scripted-llm', scriptedAdapter)) throw new Error('assembled profile omitted the scripted LLM fixture row')
  if (!has('agent-workspace-task-tools-profile', taskToolsProfile)) throw new Error('assembled profile omitted the task-tools profile fixture row')
}

/** Reject a post-uninstall profile that retains a release package or loses the external fixture. */
export function assertUninstalledProfile(manifest, config, scriptedAdapter) {
  for (const name of REGISTRY_PACKAGES) {
    if (Object.hasOwn(manifest?.dependencies ?? {}, name)) {
      throw new Error(`uninstalled profile retained direct dependency ${name}`)
    }
    if ((manifest?.dsh?.profile?.bundles ?? []).includes(name)) {
      throw new Error(`uninstalled profile retained bundle ${name}`)
    }
  }
  const rows = configRows(config)
  if (rows.some(row => row.id === 'agent-workspace' && row.name === HOST)) {
    throw new Error('uninstalled assembled profile retained the Agent Workspace Host row')
  }
  if (rows.some(row => row.id === 'agent-workspace-web' && row.name === WEB)) {
    throw new Error('uninstalled assembled profile retained the Agent Workspace Web row')
  }
  const has = (id, name) => rows.some(row => row.id === id && row.name === name)
  if (!rows.some(row => row.id === 'directory-picker' && row.name === AUTO_DIRECTORY_PICKER && row.disabled === 'true')
    || !has('directory-picker-browse', BROWSER_DIRECTORY_PICKER)
    || !has('ui-directory-picker-browse', BROWSER_DIRECTORY_PICKER_UI)) {
    throw new Error('uninstalled assembled profile omitted the deterministic browser directory picker rows')
  }
  if (!rows.some(row => row.id === 'agent-workspace-scripted-llm' && row.name === scriptedAdapter)) {
    throw new Error('uninstalled assembled profile omitted the scripted LLM fixture row')
  }
}

/** Reject removal of any Session file that existed before uninstall. */
export function assertFileTreePreserved(before, after) {
  const afterPaths = new Set(after.map(entry => entry.path))
  for (const entry of before) {
    if (!afterPaths.has(entry.path)) {
      throw new Error(`persisted Session file disappeared across uninstall restart: ${entry.path}`)
    }
  }
}

/** Read a file tree without following links and return a stable byte manifest. */
export async function manifestFileTree(root) {
  const files = []
  const visit = async directory => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) files.push(path)
      else throw new Error(`persisted Session tree contains a non-file entry: ${relative(root, path)}`)
    }
  }
  await visit(root)
  const manifest = []
  for (const path of files) {
    const bytes = await readFile(path)
    manifest.push({
      path: relative(root, path).replaceAll('\\', '/'),
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  return manifest.sort((left, right) => left.path.localeCompare(right.path))
}

/** Reject Browser evidence that does not prove selected membership memory and settled durable replies. */
export function assertBrowserDurableEvidence(durable) {
  const agents = Object.values(durable.agents)
  const group = Object.values(durable.rooms).find(room => room.kind === 'group' && room.name === 'Release room')
  if (group === undefined) throw new Error('durable Browser evidence omitted Release room')
  const alice = agents.find(agent => agent.name === 'Alice')
  const bob = agents.find(agent => agent.name === 'Bob')
  const membershipFor = agent => agent === undefined
    ? undefined
    : Object.values(durable.memberships).find(candidate => candidate.roomId === group.id && candidate.agentId === agent.id)
  const aliceMembership = membershipFor(alice)
  if (aliceMembership?.memoryStart?.type !== 'new-events'
    || Object.keys(aliceMembership.memoryStart).length !== 1) {
    throw new Error('Alice Release room membership did not preserve the selected new-events memory start')
  }
  const historyEvents = durable.events.filter(event => event.type === 'room/message'
    && event.subjectId === group.id
    && event.actor?.type === 'human'
    && event.text === 'HISTORY_BEFORE_JOIN')
  if (historyEvents.length !== 1) throw new Error(`expected exactly one durable HISTORY_BEFORE_JOIN; found ${historyEvents.length}`)
  const history = historyEvents[0]
  const bobMembership = membershipFor(bob)
  const bobMemoryStart = bobMembership?.memoryStart
  if (bobMemoryStart?.type !== 'event-range'
    || bobMemoryStart.startSequence !== history.sequence
    || bobMemoryStart.endSequence !== history.sequence
    || Object.keys(bobMemoryStart).length !== 3) {
    throw new Error('Bob Release room membership did not preserve the selected historical event range')
  }
  const historyMemories = durable.memoryEntries.filter(entry => entry.eventId === history.id)
  const aliceHistoryCount = historyMemories.filter(entry => entry.agentId === alice?.id).length
  if (aliceHistoryCount !== 0) throw new Error(`expected Alice to omit historical event memory; found ${aliceHistoryCount}`)
  const bobHistory = historyMemories.filter(entry => entry.agentId === bob?.id)
  if (bobHistory.length !== 1 || bobHistory[0].acquiredBy !== 'history-sync') {
    throw new Error(`expected Bob to have exactly one historical event memory; found ${bobHistory.length}`)
  }
  const agentMessages = durable.events.filter(event => event.type === 'room/message' && event.actor?.type === 'agent')
  for (const text of ['DIRECT_REPLY Alice', 'HOLD_REPLY Alice', 'MEMORY_OK Alice']) {
    const count = agentMessages.filter(event => event.actor.id === alice?.id && event.text === text).length
    if (count !== 1) throw new Error(`expected exactly one durable ${text}; found ${count}`)
  }
  if (JSON.stringify(durable).includes('LIVE_PARTIAL')) {
    throw new Error('durable Browser evidence contains LIVE_PARTIAL')
  }
}

/** Return the recorded refusal, rejecting duplicate results, leaked ids, and unsafe payloads. */
export function inspectSafeDelegationDenial(rows, workspace) {
  const results = rows.filter(row => row.type === 'tool/result'
    && row.data?.message?.source?.kind === 'tool'
    && row.data.message.source.callId === 'v020-safe-failure')
  if (results.length === 0) return undefined
  if (results.length !== 1) throw new Error('expected exactly one authoritative delegation denial')
  const result = results[0]
  const serialized = JSON.stringify(result.data)
  const ids = new Set()
  const collectIds = value => {
    if (value === null || typeof value !== 'object') return
    for (const [key, entry] of Object.entries(value)) {
      if ((key === 'id' || key.endsWith('Id')) && typeof entry === 'string' && entry !== '') {
        ids.add(entry)
      } else if (key.endsWith('Ids') && Array.isArray(entry)) {
        for (const id of entry) if (typeof id === 'string' && id !== '') ids.add(id)
      } else {
        collectIds(entry)
      }
    }
  }
  collectIds(workspace)
  for (const id of ids) if (serialized.includes(id)) throw new Error('delegation denial leaked an actual workspace identifier')
  if (result.data.meta !== undefined) throw new Error('delegation denial included Host metadata')
  const blocks = result.data.message.content
  const refusal = blocks?.[0]
  if (blocks?.length !== 1 || refusal?.type !== 'tool-result' || refusal.toolCallId !== 'v020-safe-failure'
    || refusal.isError !== true || JSON.stringify(refusal.content) !== JSON.stringify([{ type: 'text', text: 'Error: Workspace task request is not permitted.' }])) {
    throw new Error('recorded delegation result was not a safe policy denial')
  }
  return result
}

const RESTART_DURABLE_KEYS = [
  'definitions', 'definitionRevisions', 'agents', 'rooms', 'memberships', 'events',
  'memoryEntries', 'tasks', 'taskAssignments', 'delegationGrants', 'childRuns', 'sessionBindings',
]

/** Require a seed-free Host restart to preserve every durable product record exactly. */
export function assertRestartPersistence(before, after) {
  for (const key of RESTART_DURABLE_KEYS) {
    if (JSON.stringify(after[key]) !== JSON.stringify(before[key])) {
      throw new Error(`Host restart changed durable ${key}`)
    }
  }
}

function equalEvidence(actual, expected, description) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(description)
}

function exactlyOne(items, description) {
  if (items.length !== 1) throw new Error(`expected exactly one ${description}; found ${items.length}`)
  return items[0]
}

/** Verify exact subset pins and preservation of every existing business record. */
export function assertSubsetRevisionEvidence(before, after) {
  const definition = exactlyOne(Object.values(before.definitions).filter(item => item.name === 'Release engineer'), 'release definition')
  const previousRevisionId = definition.currentRevisionId
  equalEvidence(definition.revisionIds, [previousRevisionId], 'expected one previous revision')
  const next = after.definitions[definition.id]
  const currentRevisionId = next?.currentRevisionId
  if (!currentRevisionId || currentRevisionId === previousRevisionId) throw new Error('missing new revision')
  equalEvidence(next.revisionIds, [previousRevisionId, currentRevisionId], 'revision sequence changed')
  equalEvidence(after.definitionRevisions[previousRevisionId], before.definitionRevisions[previousRevisionId], 'previous revision was not preserved')
  if (after.definitionRevisions[currentRevisionId]?.definitionId !== definition.id || after.definitionRevisions[currentRevisionId]?.number !== 2) throw new Error('new revision belongs to another definition')
  const pins = { [previousRevisionId]: [], [currentRevisionId]: [] }
  for (const name of ['Alice', 'Bob', 'Charlie']) {
    const agent = exactlyOne(Object.values(before.agents).filter(item => item.name === name), name)
    if (agent.definitionRevisionId !== previousRevisionId) throw new Error('unexpected original pin')
    const expectedPin = name === 'Alice' ? currentRevisionId : previousRevisionId
    if (after.agents[agent.id]?.definitionRevisionId !== expectedPin) throw new Error(`unexpected ${name} pin`)
    equalEvidence(after.agents[agent.id], { ...agent, definitionRevisionId: expectedPin }, `${name} business data was not preserved`)
    pins[expectedPin].push(agent.id)
  }
  for (const key of ['rooms', 'memberships', 'sessionBindings', 'memoryEntries', 'tasks', 'taskAssignments', 'delegationGrants', 'childRuns']) {
    equalEvidence(after[key], before[key], `${key} was not preserved`)
  }
  equalEvidence(after.events.slice(0, before.events.length), before.events, 'existing events were not preserved')
  const appended = after.events.slice(before.events.length)
  const revisionEvent = exactlyOne(appended.filter(event => event.type === 'definition/revised'), 'new revision event')
  const assignmentEvent = exactlyOne(appended.filter(event => event.type === 'agent/definition-revision-assigned'), 'new revision assignment event')
  if (appended.length !== 2) throw new Error(`expected only revision and assignment events; found ${appended.length}`)
  if (revisionEvent.subjectId !== definition.id || revisionEvent.definitionRevisionId !== currentRevisionId || revisionEvent.actor !== undefined) {
    throw new Error('new revision event identity changed')
  }
  const alice = exactlyOne(Object.values(before.agents).filter(item => item.name === 'Alice'), 'Alice')
  if (assignmentEvent.subjectId !== alice.id || assignmentEvent.definitionRevisionId !== currentRevisionId || assignmentEvent.actor !== undefined) {
    throw new Error('new revision assignment event identity changed')
  }
  const previousSequence = before.events.at(-1)?.sequence
  if (!Number.isSafeInteger(previousSequence)
    || revisionEvent.sequence !== previousSequence + 1
    || assignmentEvent.sequence !== revisionEvent.sequence + 1) {
    throw new Error('new revision event order changed')
  }
  if (typeof revisionEvent.id !== 'string' || revisionEvent.id === '' || typeof assignmentEvent.id !== 'string' || assignmentEvent.id === '' || revisionEvent.id === assignmentEvent.id) {
    throw new Error('new revision event ids changed')
  }
  return {
    definitionId: definition.id,
    previousRevisionId,
    currentRevisionId,
    revisionEventId: revisionEvent.id,
    revisionEventSequence: revisionEvent.sequence,
    assignmentEventId: assignmentEvent.id,
    assignmentEventSequence: assignmentEvent.sequence,
    pins,
  }
}

/** Join accessible event labels to canonical ids and reject duplicate acquisitions or rows. */
export function assertMemoryRows(workspace, agentId, labels, expectedIds) {
  const entries = workspace.memoryEntries.filter(entry => entry.agentId === agentId)
  if (new Set(entries.map(entry => entry.eventId)).size !== entries.length) throw new Error('duplicate durable memory event')
  const ids = labels.map(label => {
    const event = exactlyOne(workspace.events.filter(event => label === `Event ${event.sequence}: ${event.type}`), 'visible memory event')
    if (!entries.some(entry => entry.eventId === event.id)) throw new Error('visible memory belongs to another agent')
    return event.id
  })
  if (new Set(ids).size !== ids.length) throw new Error('duplicate visible memory event')
  equalEvidence([...ids].sort(), [...expectedIds].sort(), 'visible memory rows do not match expected event ids')
  return ids
}

/** Require observed stop ordering, terminal delivery, and preservation of queued work and Session. */
export function assertExactStopEvidence({ protocol, identity, terminalActivityId, before, after, sessionRows }) {
  equalEvidence(protocol, ['held', 'responding-observed', 'queued-observed', 'stop-clicked', 'abort-received', 'stopping-observed', 'released', 'settled-observed'], 'invalid stop protocol order')
  if (terminalActivityId !== identity.activityId) throw new Error('a different activity settled')
  const heldAttempt = after.events.filter(event => 'taskId' in event
    && event.taskId === identity.taskId
    && 'taskDeliveryAttemptId' in event
    && event.taskDeliveryAttemptId === identity.attemptId
    && ['task/delivery-started', 'task/delivery-accepted', 'task/delivery-failed'].includes(event.type))
  equalEvidence(heldAttempt.map(event => event.type), ['task/delivery-started', 'task/delivery-accepted', 'task/delivery-failed'], 'held attempt lifecycle changed')
  if (!heldAttempt.every(event => event.messageId === identity.messageId)) throw new Error('held attempt message identity changed')
  const terminal = heldAttempt[2]
  if (terminal.failureCode !== 'interrupted') throw new Error('held attempt did not record an interrupted failure')
  if (!(heldAttempt[0].sequence < heldAttempt[1].sequence && heldAttempt[1].sequence < terminal.sequence)) throw new Error('held attempt event order changed')
  if (after.tasks[identity.taskId]?.status !== 'open') throw new Error('stopped task is not open and retryable')
  if (after.events.some(event => event.type === 'task/result' && event.taskId === identity.taskId)) throw new Error('stopped activity recorded a task result')
  equalEvidence(after.sessionBindings, before.sessionBindings, 'Session bindings were not preserved')
  if (after.sessionBindings[identity.agentId] !== identity.sessionId) throw new Error('held Session identity changed')
  if (before.tasks[identity.queuedTaskId]?.status !== 'open' || after.tasks[identity.queuedTaskId]?.status !== 'completed') throw new Error('unrelated queued work was not preserved')
  const queuedStarted = exactlyOne(after.events.filter(event => event.type === 'task/delivery-started' && event.taskId === identity.queuedTaskId), 'queued attempt start')
  const queuedAccepted = exactlyOne(after.events.filter(event => event.type === 'task/delivery-accepted' && event.taskId === identity.queuedTaskId), 'queued attempt acceptance')
  const queuedResult = exactlyOne(after.events.filter(event => event.type === 'task/result' && event.taskId === identity.queuedTaskId), 'queued attempt result')
  const queuedCompleted = exactlyOne(after.events.filter(event => event.type === 'task/completed' && event.subjectId === identity.queuedTaskId), 'queued attempt completion')
  if (queuedAccepted.taskDeliveryAttemptId !== queuedStarted.taskDeliveryAttemptId
    || queuedResult.taskDeliveryAttemptId !== queuedStarted.taskDeliveryAttemptId
    || queuedAccepted.messageId !== queuedStarted.messageId
    || !(queuedStarted.sequence < queuedAccepted.sequence && queuedAccepted.sequence < queuedResult.sequence && queuedResult.sequence < queuedCompleted.sequence)) {
    throw new Error('queued attempt identity or event order changed')
  }
  const partialMessages = sessionRows.filter(row => row.data?.message?.role === 'assistant'
    && JSON.stringify(row.data.message.content).includes('V020_STOP_PARTIAL'))
  if (partialMessages.length !== 1 || partialMessages[0]?.data?.interrupted !== true) {
    throw new Error('stopped partial assistant message was not retained exactly once as interrupted evidence')
  }
}

/** Verify the Browser's root/grant/derived/child chain against immutable events and Session logs. */
export function assertTaskCausality(workspace, sessions) {
  const alice = exactlyOne(Object.values(workspace.agents).filter(agent => agent.name === 'Alice'), 'Alice')
  const bob = exactlyOne(Object.values(workspace.agents).filter(agent => agent.name === 'Bob'), 'Bob')
  const root = exactlyOne(Object.values(workspace.tasks).filter(task => task.title === 'V020_ROOT V020_DELEGATE'), 'root task')
  const derived = exactlyOne(Object.values(workspace.tasks).filter(task => task.title === 'V020_CHILD'), 'derived task')
  if (root.rootTaskId !== root.id || derived.rootTaskId !== root.id) throw new Error('rootTaskId association changed')
  const grant = exactlyOne(Object.values(workspace.delegationGrants).filter(grant => grant.rootTaskId === root.id), 'root grant')
  if (grant.granteeAgentId !== alice.id || grant.status !== 'expired') throw new Error('wrong grantee or unexpired terminal grant')
  const grantEvent = exactlyOne(workspace.events.filter(event => event.type === 'task/delegation-granted' && event.subjectId === grant.id), 'grant event')
  equalEvidence(grantEvent.actor, { type: 'human', id: grant.grantedByHumanId }, 'grant actor changed')
  const attempts = {}
  for (const [task, assignee, marker] of [[root, alice, 'V020_ROOT_RESULT'], [derived, bob, 'V020_CHILD_RESULT']]) {
    if (task.status !== 'completed') throw new Error('task is not completed')
    const assignment = exactlyOne(Object.values(workspace.taskAssignments).filter(item => item.taskId === task.id), 'task assignment')
    if (assignment.rootTaskId !== root.id || assignment.assigneeAgentId !== assignee.id || (task === derived && assignment.grantId !== grant.id)) throw new Error('assignment association changed')
    const assigned = exactlyOne(workspace.events.filter(event => event.subjectId === assignment.id && event.type === (task === root ? 'task/assigned' : 'task/delegated')), 'assignment event')
    equalEvidence(assigned.actor, task === root ? { type: 'human', id: grant.grantedByHumanId } : { type: 'agent', id: alice.id }, 'delegator association changed')
    if (task === derived && assigned.sequence <= grantEvent.sequence) throw new Error('delegation preceded grant')
    const started = exactlyOne(workspace.events.filter(event => event.type === 'task/delivery-started' && event.taskId === task.id), 'attempt start')
    const accepted = exactlyOne(workspace.events.filter(event => event.type === 'task/delivery-accepted' && event.taskId === task.id), 'attempt acceptance')
    const result = exactlyOne(workspace.events.filter(event => event.type === 'task/result' && event.taskId === task.id), 'task result')
    const completed = exactlyOne(workspace.events.filter(event => event.type === 'task/completed' && event.subjectId === task.id), 'task completion')
    if (accepted.taskDeliveryAttemptId !== started.taskDeliveryAttemptId || result.taskDeliveryAttemptId !== started.taskDeliveryAttemptId || accepted.messageId !== started.messageId || result.definitionRevisionId !== accepted.definitionRevisionId || result.text !== marker) throw new Error('attempt/result association changed')
    equalEvidence(completed.actor, { type: 'agent', id: assignee.id }, 'completion actor changed')
    if (!(assigned.sequence < started.sequence && started.sequence < accepted.sequence && accepted.sequence < result.sequence && result.sequence < completed.sequence)) throw new Error('task event order changed')
    const session = exactlyOne(sessions.filter(session => session.header.id === workspace.sessionBindings[assignee.id]), 'assignee Session')
    const delivery = exactlyOne(session.rows.filter(row => row.type === 'user/message' && row.data?.id === started.messageId), 'Session delivery')
    if (delivery.data.source.source?.taskId !== task.id || delivery.data.source.taskDeliveryAttemptId !== started.taskDeliveryAttemptId) throw new Error('Session delivery association changed')
    const expectedCalls = task === root
      ? [['v020-delegate', 'workspace_delegate_task', { rootTaskId: root.id, assigneeAgentId: bob.id, title: derived.title }], ['v020-root-complete', 'workspace_complete_task', { taskId: root.id, result: marker }]]
      : [['v020-child-run', 'workspace_run_child', { taskId: derived.id, prompt: 'V020_CHILD_EXECUTION' }], ['v020-child-complete', 'workspace_complete_task', { taskId: derived.id, result: marker }]]
    for (const [callId, name, args] of expectedCalls) {
      const call = exactlyOne(session.rows.filter(row => row.type === 'assistant/message').flatMap(row => row.data?.message?.content ?? []).filter(block => block.type === 'tool-call' && block.id === callId), 'tool call')
      if (call.name !== name) throw new Error('tool name changed')
      equalEvidence(JSON.parse(call.arguments), args, 'tool arguments association changed')
      const toolResult = exactlyOne(session.rows.filter(row => row.type === 'tool/result' && row.data?.message?.source?.callId === callId), 'tool result')
      const block = exactlyOne(toolResult.data.message.content, 'tool result block')
      if (block.type !== 'tool-result' || block.toolCallId !== callId || block.isError === true) throw new Error('tool result failed or belongs to another call')
      if (callId === 'v020-child-run') equalEvidence(block.content, [{ type: 'text', text: 'V020_CHILD_RESULT' }], 'child tool result changed')
    }
    attempts[task.id] = started.taskDeliveryAttemptId
  }
  const child = exactlyOne(Object.values(workspace.childRuns).filter(child => child.taskId === derived.id), 'child run')
  if (child.parentAgentId !== bob.id || child.status !== 'completed' || child.result !== 'V020_CHILD_RESULT') throw new Error('child parent/result association changed')
  const started = exactlyOne(workspace.events.filter(event => event.type === 'child/run-started' && event.subjectId === child.id), 'child start')
  const finished = exactlyOne(workspace.events.filter(event => event.type === 'child/run-finished' && event.subjectId === child.id), 'child finish')
  equalEvidence(started.actor, { type: 'agent', id: bob.id }, 'child start actor changed')
  if (finished.childRunStatus !== 'completed' || finished.text !== child.result || finished.sequence <= started.sequence) throw new Error('child terminal event changed')
  const childSession = exactlyOne(sessions.filter(session => session.header.parentSession === workspace.sessionBindings[bob.id]
    && session.rows.some(row => row.type === 'subagent/descriptor' && row.data?.label === `workspace-child:${derived.id}`)), 'child Session')
  const output = exactlyOne(childSession.rows.filter(row => row.type === 'assistant/message' && row.data?.message?.role === 'assistant'), 'child assistant result')
  equalEvidence(output.data.message.content, [{ type: 'text', text: child.result }], 'child Session result changed')
  return { rootTaskId: root.id, derivedTaskId: derived.id, grantId: grant.id, attempts, childRunId: child.id, childSessionId: childSession.header.id }
}
