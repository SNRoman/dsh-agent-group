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
export function assertAssembledConfig(config, scriptedAdapter) {
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
