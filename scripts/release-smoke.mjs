/** Clean-profile release smoke for packed tarballs and exact registry versions. */

import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { finished } from 'node:stream/promises'
import { execa } from 'execa'
import {
  assertAssembledConfig,
  assertProfileLock,
  assertProfileManifest,
  assertPublishedRegistryPackage,
  assertResolvedPackages,
  assertFileTreePreserved,
  assertUninstalledProfile,
  manifestFileTree,
  registryProfileCommands,
  uninstallProfileCommand,
} from './release-smoke-contract.mjs'
import { verifyReleaseArtifacts, writeReleaseSmokeReceipt } from './release-artifacts.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const COMPATIBILITY = JSON.parse(readFileSync(join(REPO_ROOT, 'compatibility.json'), 'utf8'))
const FIXTURE_PATCH = join(REPO_ROOT, 'tests', 'fixtures', 'browser', 'cordis.test.yml')
const SCRIPTED_ADAPTER = join(REPO_ROOT, 'tests', 'fixtures', 'browser', 'scripted-llm.ts')
const TASK_TOOLS_PROFILE = join(REPO_ROOT, 'tests', 'fixtures', 'browser', 'task-tools-profile.ts')
const TASK_TOOLS_DRIVER = join(REPO_ROOT, 'tests', 'e2e', 'task-tools-profile.mjs')
const BROWSER_DRIVER = join(REPO_ROOT, 'tests', 'e2e', 'workspace-browser.mjs')
const READY_TIMEOUT_MS = 120_000
const COMMAND_TIMEOUT_MS = 20 * 60_000
const REGISTRY_ATTEMPTS = 12
const REGISTRY_PACKAGES = ['@dsh-agent-group/host', '@dsh-agent-group/web', 'dsh-agent-group']

function parseArgs(argv) {
  const options = { mode: 'packed', installationOnly: false, taskToolsOnly: false, keep: false, skipDshPrepare: false }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--installation-only') options.installationOnly = true
    else if (argument === '--task-tools-only') options.taskToolsOnly = true
    else if (argument === '--keep') options.keep = true
    else if (argument === '--skip-dsh-prepare') options.skipDshPrepare = true
    else if (argument === '--mode' || argument === '--dsh' || argument === '--version') {
      const value = argv[++index]
      if (value === undefined) throw new Error(`${argument} requires a value`)
      options[argument.slice(2)] = value
    } else throw new Error(`unknown release-smoke argument: ${argument}`)
  }
  if (options.mode !== 'packed' && options.mode !== 'registry') throw new Error('--mode must be packed or registry')
  if (options.mode === 'registry' && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(options.version ?? '')) {
    throw new Error('registry mode requires an exact SemVer through --version')
  }
  if (options.installationOnly && options.taskToolsOnly) throw new Error('--installation-only and --task-tools-only cannot be combined')
  const defaultDsh = resolve(REPO_ROOT, '..', '..', 'deepseek-harness')
  options.dsh = resolve(options.dsh ?? process.env['DSH_SOURCE'] ?? defaultDsh)
  return options
}

function safeEnvironment(extra = {}) {
  const entries = Object.entries(process.env)
    .filter(([name]) => !/(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH)/iu.test(name))
  return { ...Object.fromEntries(entries), ...extra }
}

async function run(command, args, options = {}) {
  const result = await execa(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env ?? safeEnvironment(),
    stdio: options.stdio ?? 'inherit',
    timeout: options.timeout ?? COMMAND_TIMEOUT_MS,
    reject: false,
  })
  if (result.timedOut || result.exitCode !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n')
    throw new Error(`${command} ${args.join(' ')} failed (${result.timedOut ? 'timeout' : `exit ${result.exitCode}`}):\n${detail}`)
  }
  return result
}

async function verifyDshCheckout(dsh) {
  if (!existsSync(join(dsh, 'package.json')) || !existsSync(join(dsh, 'apps', 'cli', 'src', 'bin.ts'))) {
    throw new Error(`--dsh is not a DeepSeek Harness checkout: ${dsh}`)
  }
  const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: dsh, stdio: 'pipe' })).stdout.trim()
  if (head !== COMPATIBILITY.verifiedSource.commit) {
    throw new Error(`DeepSeek Harness checkout is ${head}; expected ${COMPATIBILITY.verifiedSource.version} (${COMPATIBILITY.verifiedSource.commit})`)
  }
  const tracked = (await run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: dsh, stdio: 'pipe' })).stdout.trim()
  if (tracked !== '') throw new Error(`DeepSeek Harness checkout has tracked changes:\n${tracked}`)
}

async function prepareDsh(dsh) {
  await run('pnpm', ['install', '--frozen-lockfile'], { cwd: dsh })
  await run('pnpm', ['build:lib'], { cwd: dsh })
  await run('pnpm', ['build:web'], { cwd: dsh })
}

async function packedArtifacts() {
  const version = COMPATIBILITY.candidatePluginVersion
  return verifyReleaseArtifacts(REPO_ROOT, version)
}

async function inspectPackedManifest(tarball) {
  const result = await run('tar', ['-xOf', tarball, 'package/package.json'], { stdio: 'pipe' })
  const manifest = JSON.parse(result.stdout)
  const serialized = JSON.stringify(manifest)
  if (serialized.includes('workspace:') || /link:[^"']*deepseek-harness/u.test(serialized)) {
    throw new Error(`packed manifest leaks a workspace or sibling-source dependency: ${basename(tarball)}`)
  }
  return manifest
}

function fileSpec(path) {
  return `file:${resolve(path).replaceAll('\\', '/')}`
}

async function stagePackedBundle(stage, evidence) {
  const verified = await packedArtifacts()
  const artifacts = verified.artifacts
  await writeFile(join(evidence, 'release-artifacts.json'), `${JSON.stringify(verified.manifest, null, 2)}\n`, 'utf8')
  const manifests = {}
  for (const [name, tarball] of Object.entries(artifacts)) manifests[name] = await inspectPackedManifest(tarball)
  const version = COMPATIBILITY.candidatePluginVersion
  if (manifests.bundle.dependencies?.['@dsh-agent-group/host'] !== `^${version}`
    || manifests.bundle.dependencies?.['@dsh-agent-group/web'] !== `^${version}`) {
    throw new Error(`packed bundle must depend on Host and Web through ^${version}`)
  }
  await writeFile(join(evidence, 'packed-manifests.json'), `${JSON.stringify(manifests, null, 2)}\n`, 'utf8')
  await mkdir(stage, { recursive: true })
  await run('tar', ['-xzf', artifacts.bundle, '-C', stage])
  const manifestPath = join(stage, 'package', 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.dependencies['@dsh-agent-group/host'] = fileSpec(artifacts.host)
  manifest.dependencies['@dsh-agent-group/web'] = fileSpec(artifacts.web)
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const packed = await run('npm', ['pack', join(stage, 'package'), '--pack-destination', stage, '--json'], { stdio: 'pipe' })
  const result = JSON.parse(packed.stdout)
  const tarball = join(stage, result[0].filename)
  if (!existsSync(tarball)) throw new Error('npm pack did not produce the staged bundle')
  return tarball
}

async function stageFixture(scratch) {
  const source = await readFile(FIXTURE_PATCH, 'utf8')
  const absoluteAdapter = pathToFileURL(resolve(SCRIPTED_ADAPTER)).href.replaceAll("'", "''")
  const absoluteTaskToolsProfile = pathToFileURL(resolve(TASK_TOOLS_PROFILE)).href.replaceAll("'", "''")
  const stagedAdapter = source.replace("name: './scripted-llm.ts'", `name: '${absoluteAdapter}'`)
  if (stagedAdapter === source) throw new Error('browser fixture has no scripted adapter placeholder')
  const staged = stagedAdapter.replace("name: './task-tools-profile.ts'", `name: '${absoluteTaskToolsProfile}'`)
  if (staged === stagedAdapter) throw new Error('browser fixture has no task-tools profile placeholder')
  const path = join(scratch, 'cordis.test.yml')
  await writeFile(path, staged, 'utf8')
  const taskToolsRow = `    # This profile-only setup seeds a human task because the Browser product\n    # does not yet expose formal-task creation.  The employee itself invokes\n    # its registered tools through the normal agent loop.\n    - id: agent-workspace-task-tools-profile\n      name: './task-tools-profile.ts'\n`
  const withoutTaskTools = source.replace(taskToolsRow, '')
  if (withoutTaskTools === source) throw new Error('browser fixture has no removable task-tools profile row')
  const uninstalledPath = join(scratch, 'cordis.after-uninstall.yml')
  await writeFile(uninstalledPath, withoutTaskTools.replace("name: './scripted-llm.ts'", `name: '${absoluteAdapter}'`), 'utf8')
  return { path, uninstalledPath, adapter: absoluteAdapter, taskToolsProfile: absoluteTaskToolsProfile }
}

async function waitForRegistry(version, evidence) {
  const observed = []
  for (let attempt = 1; attempt <= REGISTRY_ATTEMPTS; attempt++) {
    const missing = []
    const packages = []
    for (const name of REGISTRY_PACKAGES) {
      const result = await execa('npm', ['view', `${name}@${version}`, 'version', 'dist.integrity', 'dist.tarball', 'dependencies', '--json'], {
        cwd: REPO_ROOT,
        env: safeEnvironment(),
        stdio: 'pipe',
        reject: false,
        timeout: 30_000,
      })
      let manifest
      try { manifest = JSON.parse(result.stdout || 'null') } catch { manifest = undefined }
      const registryPackage = {
        name,
        exitCode: result.exitCode,
        version: manifest?.version,
        integrity: manifest?.['dist.integrity'],
        tarball: manifest?.['dist.tarball'],
        dependencies: manifest?.dependencies,
      }
      packages.push(registryPackage)
      try {
        if (result.exitCode !== 0) throw new Error(`npm view exited ${result.exitCode}`)
        assertPublishedRegistryPackage(registryPackage, version)
      } catch (error) {
        missing.push(`${name} (${error instanceof Error ? error.message : String(error)})`)
      }
    }
    observed.push({ attempt, missing, packages })
    await writeFile(join(evidence, 'registry-visibility.json'), `${JSON.stringify(observed, null, 2)}\n`, 'utf8')
    if (missing.length === 0) return packages
    if (attempt === REGISTRY_ATTEMPTS) throw new Error(`registry version ${version} is still missing: ${missing.join(', ')}`)
    await new Promise(resolveDelay => setTimeout(resolveDelay, Math.min(30_000, attempt * 2_000)))
  }
}

async function verifyInstalledPackages(profile, version, evidence, registryPackages = []) {
  const result = await run('pnpm', ['--dir', profile, 'list', '--json', '--depth', 'Infinity'], { stdio: 'pipe' })
  const roots = JSON.parse(result.stdout)
  const found = new Map(REGISTRY_PACKAGES.map(name => [name, []]))
  const visit = dependencies => {
    if (dependencies === undefined) return
    for (const [name, dependency] of Object.entries(dependencies)) {
      if (found.has(name)) found.get(name).push({ version: dependency.version, resolved: dependency.resolved })
      visit(dependency.dependencies)
    }
  }
  for (const root of roots) visit(root.dependencies)
  const registryByName = new Map(registryPackages.map(entry => [entry.name, entry]))
  const resolved = REGISTRY_PACKAGES.map(name => ({
    name,
    installations: found.get(name),
    registryIntegrity: registryByName.get(name)?.integrity,
  }))
  await writeFile(join(evidence, 'resolved-packages.json'), `${JSON.stringify(resolved, null, 2)}\n`, 'utf8')
  assertResolvedPackages(resolved, version)
  if (registryPackages.length > 0) {
    const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    assertProfileManifest(manifest, version)
    const lockfile = await readFile(join(profile, 'pnpm-lock.yaml'), 'utf8')
    assertProfileLock(lockfile, version, registryPackages)
  }
}

function captureHostLog(child, hostLog) {
  const log = createWriteStream(hostLog, { flags: 'a' })
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  const logFinished = finished(log)
  void Promise.all([finished(child.stdout), finished(child.stderr)]).then(
    () => log.end(),
    error => log.destroy(error),
  )
  return logFinished
}

async function waitForReady(child) {
  let output = ''
  return await new Promise((resolveReady, rejectReady) => {
    let settled = false
    let timer
    const settle = (error, url) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === undefined) resolveReady(url)
      else rejectReady(error)
    }
    const append = chunk => {
      output = `${output}${String(chunk)}`.slice(-200_000)
      const url = /dsh web: (http:\/\/[^\s]+)/u.exec(output)?.[1]
      if (url !== undefined) settle(undefined, url)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.nodeChildProcess.once('error', error => settle(error))
    child.nodeChildProcess.once('exit', code => settle(new Error(`dsh web exited before readiness (${String(code)})`)))
    timer = setTimeout(() => settle(new Error('dsh web readiness timed out')), READY_TIMEOUT_MS)
    timer.unref()
  })
}

async function within(promise, timeoutMs, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)
        timer.unref()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function stopTree(child) {
  const nodeChild = child.nodeChildProcess
  const exited = child.then(() => undefined, () => undefined)
  if ((nodeChild.exitCode !== null && nodeChild.exitCode !== undefined)
    || (nodeChild.signalCode !== null && nodeChild.signalCode !== undefined)) {
    await within(exited, 10_000, 'dsh web output drain')
    return
  }
  if (process.platform === 'win32') {
    const killed = await execa('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      env: safeEnvironment(),
      reject: false,
      stdio: 'ignore',
      timeout: 30_000,
    })
    if (killed.timedOut) throw new Error('taskkill timed out while stopping dsh web')
  } else {
    try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  try {
    await within(exited, 10_000, 'dsh web graceful exit')
    return
  } catch (error) {
    if (process.platform === 'win32') throw error
    try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  await within(exited, 10_000, 'dsh web forced exit')
}

async function copyProfileEvidence(dshHome, evidence) {
  await mkdir(evidence, { recursive: true })
  const profile = join(dshHome, 'profiles', 'web')
  for (const name of ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml']) {
    const source = join(profile, name)
    if (existsSync(source)) await cp(source, join(evidence, `profile-${name}`))
  }
  const storage = join(dshHome, 'storages', 'agent_workspace.json')
  if (existsSync(storage)) await cp(storage, join(evidence, 'agent_workspace.json'))
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  await verifyDshCheckout(options.dsh)
  const artifactsRoot = join(REPO_ROOT, '.release-smoke', `${options.mode}-${options.version ?? COMPATIBILITY.candidatePluginVersion}`)
  await rm(artifactsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  await mkdir(artifactsRoot, { recursive: true })
  const scratch = await mkdtemp(join(tmpdir(), `dsh-agent-group-${options.mode}-`))
  const dshHome = join(scratch, 'dsh-home')
  const agentsHome = join(scratch, 'agents-home')
  const gate = join(scratch, 'release-gate')
  const coreWorkspace = join(scratch, 'core-workspace')
  let server
  let hostLogFinished = Promise.resolve()
  const failures = []
  const startServer = async (fixture, environment, logName) => {
    server = execa('pnpm', ['dsh', '--profile', 'web', '--patch', fixture.path, '--no-open', '--port', '0'], {
      cwd: options.dsh,
      env: environment,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      reject: false,
    })
    hostLogFinished = captureHostLog(server, join(artifactsRoot, logName))
    return await waitForReady(server)
  }
  const stopServer = async () => {
    if (server === undefined) return
    await stopTree(server)
    await hostLogFinished
    server = undefined
    hostLogFinished = Promise.resolve()
  }
  try {
    if (!options.skipDshPrepare) await prepareDsh(options.dsh)
    let installCommands
    let registryPackages = []
    if (options.mode === 'packed') {
      const installSpec = await stagePackedBundle(join(scratch, 'stage'), artifactsRoot)
      installCommands = [['dsh', 'plugin', '--profile', 'web', 'add', installSpec]]
    }
    else {
      registryPackages = await waitForRegistry(options.version, artifactsRoot)
      installCommands = registryProfileCommands(options.version)
    }
    const environment = safeEnvironment({
      DSH_HOME: dshHome,
      DSH_AGENTS_HOME: agentsHome,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_AGENT_GROUP_SMOKE_GATE: gate,
      DSH_AGENT_GROUP_TASK_TOOLS_FIXTURE: join(scratch, 'task-tools-input.json'),
      NODE_NO_WARNINGS: '1',
    })
    const fixture = await stageFixture(scratch)
    await mkdir(coreWorkspace, { recursive: true })
    for (const command of installCommands) await run('pnpm', command, { cwd: options.dsh, env: environment })
    const profile = join(dshHome, 'profiles', 'web')
    await verifyInstalledPackages(
      profile,
      options.version ?? COMPATIBILITY.candidatePluginVersion,
      artifactsRoot,
      registryPackages,
    )
    const config = await run('pnpm', ['dsh', '--profile', 'web', '--patch', fixture.path, '--dump-config'], {
      cwd: options.dsh,
      env: environment,
      stdio: 'pipe',
    })
    await writeFile(join(artifactsRoot, 'assembled-config.yml'), config.stdout, 'utf8')
    assertAssembledConfig(config.stdout, fixture.adapter, fixture.taskToolsProfile)
    await copyProfileEvidence(dshHome, join(artifactsRoot, 'installed'))

    const launchUrl = await startServer(fixture, environment, 'host.log')
    if (options.installationOnly) {
      await stopServer()
    } else if (options.taskToolsOnly) {
      await run(process.execPath, [TASK_TOOLS_DRIVER,
        '--dsh-home', dshHome,
        '--evidence', artifactsRoot,
        '--task-tools-fixture', environment.DSH_AGENT_GROUP_TASK_TOOLS_FIXTURE,
      ], { cwd: REPO_ROOT, env: environment })
      await stopServer()
      await copyProfileEvidence(dshHome, join(artifactsRoot, 'installed'))
      const sessions = await manifestFileTree(join(dshHome, 'sessions'))
      if (sessions.length === 0) throw new Error('the task-tools profile run persisted no Session files')
      await writeFile(join(artifactsRoot, 'task-tools-sessions.json'), `${JSON.stringify(sessions, null, 2)}\n`, 'utf8')
    } else {
      await run(process.execPath, [BROWSER_DRIVER,
        '--url', launchUrl,
        '--dsh-home', dshHome,
        '--evidence', artifactsRoot,
        '--gate', gate,
        '--workspace', coreWorkspace,
        '--phase', 'installed',
        '--task-tools-fixture', environment.DSH_AGENT_GROUP_TASK_TOOLS_FIXTURE,
      ], { cwd: REPO_ROOT, env: environment })
      await stopServer()
      await copyProfileEvidence(dshHome, join(artifactsRoot, 'installed'))

      const sessionsRoot = join(dshHome, 'sessions')
      const sessionsBefore = await manifestFileTree(sessionsRoot)
      if (sessionsBefore.length === 0) throw new Error('the installed Browser run persisted no Session files')
      await writeFile(join(artifactsRoot, 'sessions-before-uninstall.json'), `${JSON.stringify(sessionsBefore, null, 2)}\n`, 'utf8')

      const installedManifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
      const uninstallCommand = uninstallProfileCommand(installedManifest)
      if (uninstallCommand === null) throw new Error('the installed profile has no direct Agent Workspace package to uninstall')
      await run('pnpm', uninstallCommand, { cwd: options.dsh, env: environment })

      const uninstalledManifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
      const uninstalledConfig = await run('pnpm', ['dsh', '--profile', 'web', '--patch', fixture.uninstalledPath, '--dump-config'], {
        cwd: options.dsh,
        env: environment,
        stdio: 'pipe',
      })
      assertUninstalledProfile(uninstalledManifest, uninstalledConfig.stdout, fixture.adapter)
      await writeFile(join(artifactsRoot, 'uninstalled-assembled-config.yml'), uninstalledConfig.stdout, 'utf8')
      await writeFile(join(artifactsRoot, 'uninstall.json'), `${JSON.stringify({
        command: ['pnpm', ...uninstallCommand],
        before: {
          dependencies: installedManifest.dependencies ?? {},
          bundles: installedManifest.dsh?.profile?.bundles ?? [],
        },
        after: {
          dependencies: uninstalledManifest.dependencies ?? {},
          bundles: uninstalledManifest.dsh?.profile?.bundles ?? [],
        },
      }, null, 2)}\n`, 'utf8')
      await copyProfileEvidence(dshHome, join(artifactsRoot, 'uninstalled'))

      const restartUrl = await startServer({ ...fixture, path: fixture.uninstalledPath }, environment, 'host-after-uninstall.log')
      await run(process.execPath, [BROWSER_DRIVER,
        '--url', restartUrl,
        '--dsh-home', dshHome,
        '--evidence', artifactsRoot,
        '--gate', gate,
        '--workspace', coreWorkspace,
        '--phase', 'after-uninstall',
        '--task-tools-fixture', environment.DSH_AGENT_GROUP_TASK_TOOLS_FIXTURE,
      ], { cwd: REPO_ROOT, env: environment })
      await stopServer()

      const sessionsAfter = await manifestFileTree(sessionsRoot)
      await writeFile(join(artifactsRoot, 'sessions-after-uninstall.json'), `${JSON.stringify(sessionsAfter, null, 2)}\n`, 'utf8')
      try {
        assertFileTreePreserved(sessionsBefore, sessionsAfter)
        await writeFile(join(artifactsRoot, 'sessions-comparison.json'), `${JSON.stringify({
          preserved: true,
          beforeFileCount: sessionsBefore.length,
          afterFileCount: sessionsAfter.length,
        }, null, 2)}\n`, 'utf8')
      } catch (error) {
        await writeFile(join(artifactsRoot, 'sessions-comparison.json'), `${JSON.stringify({
          preserved: false,
          error: error instanceof Error ? error.message : String(error),
        }, null, 2)}\n`, 'utf8')
        throw error
      }
    }
  } catch (error) {
    failures.push(error)
  } finally {
    if (server !== undefined) {
      try { await stopTree(server) } catch (error) { failures.push(error) }
    }
    try { await hostLogFinished } catch (error) { failures.push(error) }
    if (failures.length > 0 || options.keep) {
      try { await copyProfileEvidence(dshHome, join(artifactsRoot, 'final-state')) } catch (error) { failures.push(error) }
    }
    if (failures.length === 0 && !options.keep) {
      try {
        await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0 || options.keep) {
      await writeFile(join(artifactsRoot, 'scratch-path.txt'), `${scratch}\n`, 'utf8').catch(() => {})
    }
  }
  if (failures.length > 0) {
    const detail = failures.map(error => String(error?.stack ?? error)).join('\n\n--- cleanup or evidence failure ---\n\n')
    await writeFile(join(artifactsRoot, 'smoke-failure.txt'), `${detail}\n`, 'utf8').catch(() => {})
    throw new AggregateError(failures, `release smoke failed; evidence: ${artifactsRoot}`)
  }
  if (options.mode === 'packed' && !options.installationOnly) {
    const receipt = writeReleaseSmokeReceipt(REPO_ROOT, COMPATIBILITY.candidatePluginVersion, COMPATIBILITY.verifiedSource)
    await writeFile(join(artifactsRoot, 'release-smoke-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  }
  process.stdout.write(`release smoke passed (${options.mode}${options.version === undefined ? '' : ` ${options.version}`}); evidence: ${artifactsRoot}\n`)
}

await main()
