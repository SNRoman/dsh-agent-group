import { execFile as execFileCallback } from 'node:child_process'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const publishableManifests = [
  'packages/host/package.json',
  'packages/web/package.json',
  'packages/bundle/package.json',
]
const excludedCopyDirectories = new Set(['.git', 'node_modules', 'release', '.superpowers'])
const sensitiveEnvironmentName = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i

/**
 * Returns a child environment without credential-bearing ambient variables.
 *
 * @param environment - ambient variables to scrub before launching a child process.
 * @returns a fresh environment safe for source-check subprocesses.
 */
export function sanitizeChildEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name, value]) => value !== undefined && !sensitiveEnvironmentName.test(name)))
}

/** Returns a pnpm child-process invocation supported by the selected platform. */
export function pnpmInvocation(platform, environment, args) {
  if (platform === 'win32') {
    return {
      command: environment.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'pnpm.cmd', ...args],
    }
  }
  return { command: 'pnpm', args }
}

/** Reads and validates the repository compatibility declaration. */
export async function readCompatibility(pluginDirectory) {
  const declaration = await readJson(join(pluginDirectory, 'compatibility.json'))
  if (declaration.schemaVersion !== 1) {
    throw new Error(`compatibility.json: schemaVersion expected 1, actual ${String(declaration.schemaVersion)}`)
  }
  for (const field of ['candidatePluginVersion', 'peerRange', 'registryDevelopmentVersion']) {
    if (typeof declaration[field] !== 'string' || declaration[field] === '') {
      throw new Error(`compatibility.json: ${field} expected a non-empty string, actual ${String(declaration[field])}`)
    }
  }
  if (declaration.forwardExport?.format !== 'dsh-agent-workspace' || declaration.forwardExport?.formatVersion !== 1) {
    throw new Error('compatibility.json: forwardExport expected dsh-agent-workspace format version 1, actual invalid')
  }
  if (
    typeof declaration.verifiedSource !== 'object'
    || declaration.verifiedSource === null
    || typeof declaration.verifiedSource.version !== 'string'
    || typeof declaration.verifiedSource.commit !== 'string'
  ) {
    throw new Error('compatibility.json: verifiedSource expected version and commit strings, actual invalid')
  }
  return declaration
}

/** Formats the README sentence that is kept in sync with compatibility.json. */
export function formatReadmeCompatibility(declaration) {
  return `DeepSeek Harness compatibility: ${declaration.peerRange}; registry development: ${declaration.registryDevelopmentVersion}; verified source: ${declaration.verifiedSource.version} (${declaration.verifiedSource.commit}).`
}

/** Validates compatibility metadata used by published packages and continuous integration. */
export async function validateCompatibility(pluginDirectory) {
  const declaration = await readCompatibility(pluginDirectory)

  for (const manifestPath of publishableManifests) {
    const manifest = await readJson(join(pluginDirectory, manifestPath))
    assertEqual(manifestPath, 'version', declaration.candidatePluginVersion, manifest.version)
    for (const dependencyField of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const [name, value] of Object.entries(manifest[dependencyField] ?? {})) {
        if (name.startsWith('@deepseek-ai/dsh-')) {
          assertEqual(manifestPath, name, declaration.peerRange, value)
        }
      }
    }
  }

  const rootManifest = await readJson(join(pluginDirectory, 'package.json'))
  for (const [name, value] of Object.entries(rootManifest.devDependencies ?? {})) {
    if (name.startsWith('@deepseek-ai/dsh-')) {
      assertEqual('package.json', name, declaration.registryDevelopmentVersion, value)
    }
  }

  const workspacePath = join(pluginDirectory, 'pnpm-workspace.yaml')
  const workspace = await readFile(workspacePath, 'utf8')
  if (workspace.includes('link:')) {
    throw new Error(`${relative(pluginDirectory, workspacePath) || 'pnpm-workspace.yaml'}: source overrides expected absent, actual link override`)
  }

  const workflowPath = join(pluginDirectory, '.github', 'workflows', 'ci.yml')
  const workflow = await readFile(workflowPath, 'utf8')
  const sourceRef = workflow.match(/repository:\s*deepseek-ai\/deepseek-harness[\s\S]{0,400}?\n\s*ref:\s*([^\s#]+)/)?.[1]
  assertEqual('.github/workflows/ci.yml', 'DeepSeek Harness source ref', declaration.verifiedSource.commit, sourceRef)

  const readmePath = join(pluginDirectory, 'README.md')
  const readme = await readFile(readmePath, 'utf8')
  const expectedStatement = formatReadmeCompatibility(declaration)
  if (!readme.includes(expectedStatement)) {
    throw new Error(`README.md: compatibility statement expected ${expectedStatement}, actual missing`)
  }

  return declaration
}

/**
 * Verifies an explicit DSH source checkout and prepares an isolated plugin copy with source overrides.
 *
 * @returns The temporary directory and copied plugin directory. The caller owns removing the temporary directory.
 */
export async function prepareSourceCompatibility({ pluginDirectory, dshDirectory }) {
  const absolutePluginDirectory = resolve(pluginDirectory)
  const absoluteDshDirectory = resolve(dshDirectory)
  const declaration = await validateCompatibility(absolutePluginDirectory)
  const sourcePackages = await validateDshSource(absolutePluginDirectory, absoluteDshDirectory, declaration)
  const originalWorkspace = await readFile(join(absolutePluginDirectory, 'pnpm-workspace.yaml'), 'utf8')
  if (originalWorkspace.includes('link:')) {
    throw new Error('pnpm-workspace.yaml: source overrides expected absent before preparation, actual link override')
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'dsh-agent-group-source-'))
  const copiedPluginDirectory = join(temporaryDirectory, 'plugin')
  try {
    await cp(absolutePluginDirectory, copiedPluginDirectory, {
      recursive: true,
      filter: source => !excludedCopyDirectories.has(basename(source)),
    })
    await writeFile(
      join(copiedPluginDirectory, 'pnpm-workspace.yaml'),
      `${originalWorkspace.trimEnd()}\n\noverrides:\n${formatSourceOverrides(sourcePackages)}`,
    )
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true })
    throw error
  }

  return { temporaryDirectory, pluginDirectory: copiedPluginDirectory }
}

async function validateDshSource(pluginDirectory, dshDirectory, declaration) {
  const dshManifest = await readJson(join(dshDirectory, 'package.json'))
  assertEqual('package.json', 'deepseek-harness', declaration.verifiedSource.version, dshManifest.version)
  const { stdout } = await execFile(
    'git',
    ['-C', dshDirectory, 'rev-parse', 'HEAD'],
    { env: sanitizeChildEnvironment() },
  )
  const sourceCommit = stdout.trim()
  assertEqual('git rev-parse HEAD', 'DeepSeek Harness', declaration.verifiedSource.commit, sourceCommit)
  const { stdout: sourceStatus } = await execFile(
    'git',
    ['-C', dshDirectory, 'status', '--porcelain', '--untracked-files=no'],
    { env: sanitizeChildEnvironment() },
  )
  const trackedChanges = sourceStatus.trim()
  if (trackedChanges !== '') {
    throw new Error(`git status --porcelain: DeepSeek Harness expected clean tracked worktree and index, actual ${trackedChanges}`)
  }

  const rootManifest = await readJson(join(pluginDirectory, 'package.json'))
  const requiredNames = Object.keys(rootManifest.devDependencies ?? {}).filter(name => name.startsWith('@deepseek-ai/'))
  const sourcePackages = await findSourcePackages(dshDirectory)
  for (const name of requiredNames) {
    const manifest = sourcePackages.get(name)
    if (!manifest) {
      const expected = name.startsWith('@deepseek-ai/dsh-') ? declaration.registryDevelopmentVersion : 'a source package manifest'
      throw new Error(`required DSH package manifest: ${name} expected ${expected}, actual missing`)
    }
    if (name.startsWith('@deepseek-ai/dsh-')) {
      assertEqual(manifest.relativePath, name, declaration.registryDevelopmentVersion, manifest.version)
    }
  }
  return new Map(requiredNames.map(name => [name, sourcePackages.get(name)]))
}

async function findSourcePackages(directory) {
  const packages = new Map()
  await walk(directory, async path => {
    if (basename(path) !== 'package.json') return
    const manifest = await readJson(path)
    if (typeof manifest.name === 'string') {
      packages.set(manifest.name, {
        directory: resolve(path, '..'),
        relativePath: relative(directory, path).split(sep).join('/'),
        version: manifest.version,
      })
    }
  })
  return packages
}

async function walk(directory, visit) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excludedCopyDirectories.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await walk(path, visit)
    else await visit(path)
  }
}

function formatSourceOverrides(sourcePackages) {
  return [...sourcePackages.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, manifest]) => `  '${name}': 'link:${manifest.directory.split(sep).join('/')}'`)
    .join('\n')
    .concat('\n')
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function assertEqual(file, subject, expected, actual) {
  if (actual !== expected) {
    throw new Error(`${file}: ${subject} expected ${String(expected)}, actual ${String(actual)}`)
  }
}
