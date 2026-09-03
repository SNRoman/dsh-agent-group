import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareSourceCompatibility } from '../scripts/source-compatibility.mjs'

const execFile = promisify(execFileCallback)
const peerRange = '>=0.1.1-rc.2 <0.1.2-0'
const developmentVersion = '0.1.1-rc.2'
const temporaryDirectories: string[] = []
const verifyCompatibilityScript = fileURLToPath(new URL('../scripts/verify-compatibility.mjs', import.meta.url))

interface Compatibility {
  schemaVersion: number
  candidatePluginVersion: string
  peerRange: string
  registryDevelopmentVersion: string
  verifiedSource: { version: string, commit: string }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

function readmeStatement(compatibility: Compatibility): string {
  return `DeepSeek Harness compatibility: ${compatibility.peerRange}; registry development: ${compatibility.registryDevelopmentVersion}; verified source: ${compatibility.verifiedSource.version} (${compatibility.verifiedSource.commit}).`
}

async function createPluginFixture(compatibility: Compatibility): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-agent-group-compatibility-'))
  temporaryDirectories.push(root)

  await writeJson(join(root, 'compatibility.json'), compatibility)
  await writeJson(join(root, 'package.json'), {
    name: 'fixture-root',
    private: true,
    devDependencies: { '@deepseek-ai/dsh-agent': developmentVersion },
  })
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
  await writeFile(join(root, 'README.md'), `${readmeStatement(compatibility)}\n`)
  await mkdir(join(root, '.github', 'workflows'), { recursive: true })
  await writeFile(
    join(root, '.github', 'workflows', 'ci.yml'),
    `steps:\n  - uses: actions/checkout@v4\n    with:\n      repository: deepseek-ai/deepseek-harness\n      ref: ${compatibility.verifiedSource.commit}\n`,
  )

  for (const directory of ['host', 'web', 'bundle']) {
    await writeJson(join(root, 'packages', directory, 'package.json'), {
      name: `@fixture/${directory}`,
      version: compatibility.candidatePluginVersion,
      peerDependencies: { '@deepseek-ai/dsh-agent': compatibility.peerRange },
    })
  }

  return root
}

async function createDshFixture(version = developmentVersion): Promise<{ root: string, commit: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-source-compatibility-'))
  temporaryDirectories.push(root)
  await writeJson(join(root, 'package.json'), { name: 'deepseek-harness', version })
  await writeJson(join(root, 'packages', 'core', 'agent', 'package.json'), {
    name: '@deepseek-ai/dsh-agent',
    version,
  })
  await execFile('git', ['init', '--initial-branch=main'], { cwd: root })
  await execFile('git', ['config', 'user.email', 'fixture@example.test'], { cwd: root })
  await execFile('git', ['config', 'user.name', 'Fixture'], { cwd: root })
  await execFile('git', ['add', '.'], { cwd: root })
  await execFile('git', ['commit', '-m', 'fixture'], { cwd: root })
  const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: root })
  return { root, commit: stdout.trim() }
}

function declaration(commit: string): Compatibility {
  return {
    schemaVersion: 1,
    candidatePluginVersion: '0.1.1',
    peerRange,
    registryDevelopmentVersion: developmentVersion,
    verifiedSource: { version: developmentVersion, commit },
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('compatibility declaration', () => {
  it('runs the compatibility validator against a matching fixture repository', async () => {
    const dsh = await createDshFixture()
    const compatibility = declaration(dsh.commit)
    const plugin = await createPluginFixture(compatibility)

    await expect(execFile(process.execPath, [verifyCompatibilityScript], { cwd: plugin }))
      .resolves.toMatchObject({ stdout: 'Compatibility declaration verified.\n' })
  })

  it('names the publishable manifest, package, expected range, and actual range', async () => {
    const dsh = await createDshFixture()
    const compatibility = declaration(dsh.commit)
    const plugin = await createPluginFixture(compatibility)
    await writeJson(join(plugin, 'packages', 'web', 'package.json'), {
      name: '@fixture/web',
      version: compatibility.candidatePluginVersion,
      peerDependencies: { '@deepseek-ai/dsh-agent': '^0.1.1' },
    })

    await expect(execFile(process.execPath, [verifyCompatibilityScript], { cwd: plugin, encoding: 'utf8' }))
      .rejects.toMatchObject({
        stderr: expect.stringContaining(
          'packages/web/package.json: @deepseek-ai/dsh-agent expected >=0.1.1-rc.2 <0.1.2-0, actual ^0.1.1',
        ),
      })
  })

  it('rejects a source checkout missing a required DSH package manifest', async () => {
    const dsh = await createDshFixture()
    await rm(join(dsh.root, 'packages', 'core', 'agent', 'package.json'))
    const compatibility = declaration(dsh.commit)
    const plugin = await createPluginFixture(compatibility)

    await expect(prepareSourceCompatibility({ pluginDirectory: plugin, dshDirectory: dsh.root }))
      .rejects.toThrow('required DSH package manifest: @deepseek-ai/dsh-agent expected 0.1.1-rc.2, actual missing')
  })

  it('rejects an unsupported source version and commit', async () => {
    const dsh = await createDshFixture('0.1.1-rc.1')
    const compatibility = declaration('0000000000000000000000000000000000000000')
    const plugin = await createPluginFixture(compatibility)

    await expect(prepareSourceCompatibility({ pluginDirectory: plugin, dshDirectory: dsh.root }))
      .rejects.toThrow('package.json: deepseek-harness expected 0.1.1-rc.2, actual 0.1.1-rc.1')

    await writeJson(join(dsh.root, 'package.json'), { name: 'deepseek-harness', version: developmentVersion })
    await expect(prepareSourceCompatibility({ pluginDirectory: plugin, dshDirectory: dsh.root }))
      .rejects.toThrow('git rev-parse HEAD: DeepSeek Harness expected 0000000000000000000000000000000000000000')
  })

  it('writes generated source overrides only inside the temporary plugin copy', async () => {
    const dsh = await createDshFixture()
    const compatibility = declaration(dsh.commit)
    const plugin = await createPluginFixture(compatibility)
    await mkdir(join(plugin, '.git'), { recursive: true })
    await mkdir(join(plugin, 'node_modules'), { recursive: true })
    await mkdir(join(plugin, 'release'), { recursive: true })
    await mkdir(join(plugin, '.superpowers'), { recursive: true })
    await Promise.all([
      writeFile(join(plugin, '.git', 'sentinel'), 'excluded'),
      writeFile(join(plugin, 'node_modules', 'sentinel'), 'excluded'),
      writeFile(join(plugin, 'release', 'sentinel'), 'excluded'),
      writeFile(join(plugin, '.superpowers', 'sentinel'), 'excluded'),
    ])

    const prepared = await prepareSourceCompatibility({ pluginDirectory: plugin, dshDirectory: dsh.root })
    temporaryDirectories.push(prepared.temporaryDirectory)
    const workspace = await readFile(join(prepared.pluginDirectory, 'pnpm-workspace.yaml'), 'utf8')

    expect(workspace).toContain("'@deepseek-ai/dsh-agent': 'link:")
    expect(await readFile(join(plugin, 'pnpm-workspace.yaml'), 'utf8')).not.toContain('link:')
    await expect(readFile(join(prepared.pluginDirectory, '.git', 'sentinel'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(prepared.pluginDirectory, 'node_modules', 'sentinel'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(prepared.pluginDirectory, 'release', 'sentinel'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(prepared.pluginDirectory, '.superpowers', 'sentinel'), 'utf8')).rejects.toThrow()
  })
})
