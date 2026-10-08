import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readText = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const readJson = (path: string) => JSON.parse(readText(path)) as Record<string, any>

const packages = [
  'packages/host/package.json',
  'packages/web/package.json',
  'packages/bundle/package.json',
] as const
const browserFixtureFiles = [
  'tests/fixtures/browser/cordis.test.yml',
  'tests/fixtures/browser/scripted-llm.ts',
  'tests/fixtures/browser/task-tools-profile.ts',
  'tests/fixtures/task-tools/profile-session.expected.json',
  'tests/e2e/task-tools-profile.mjs',
  'tests/e2e/workspace-browser.mjs',
  'tests/e2e/README.md',
  '.github/workflows/registry-smoke.yml',
] as const

const dshRange = '>=0.2.0-rc.2 <0.2.1-0'
const CONCURRENT_LANE_TEST_TIMEOUT_MS = 15_000

describe('public release contract', () => {
  it('aligns the v0.4.0 compatibility candidate and preserves the forward export surface', () => {
    const manifests = packages.map(path => readJson(path))
    const compatibility = readJson('compatibility.json')
    expect(manifests.map(manifest => manifest.version)).toEqual(['0.4.0', '0.4.0', '0.4.0'])
    expect(compatibility.candidatePluginVersion).toBe('0.4.0')
    expect(compatibility.peerRange).toBe('>=0.2.0-rc.2 <0.2.1-0')
    expect(compatibility.registryDevelopmentVersion).toBe('0.2.0-rc.2')
    expect(compatibility.verifiedSource).toEqual({
      version: '0.2.0-rc.2',
      commit: '639ed015397290b3745d163aafe02ffee4aa3f84',
    })
    expect(compatibility.forwardExport).toEqual({ format: 'dsh-agent-workspace', formatVersion: 1 })
    expect(readText('packages/host/src/forward-export.ts')).toContain("AGENT_WORKSPACE_PLUGIN_VERSION = '0.4.0'")

    const root = readJson('package.json')
    expect(root.scripts['export:forward-v1']).toBe('node scripts/export-forward-v1.mjs')
    expect(existsSync(new URL('../scripts/export-forward-v1.mjs', import.meta.url))).toBe(true)
    expect(existsSync(new URL('../tests/fixtures/v0.2.0/agent-workspace.json', import.meta.url))).toBe(true)
    expect(existsSync(new URL('../tests/fixtures/v0.2.0/portable-workspace-v1.json', import.meta.url))).toBe(true)

    const publicSources = [
      readText('packages/host/src/forward-export.ts'),
      readText('packages/host/src/index.ts'),
      readText('packages/web/src/client/api.ts'),
    ].join('\n')
    expect(publicSources).not.toMatch(/workspace\/import|importForwardWorkspace|importWorkspace/)
    expect(readText('packages/web/src/client/WorkspaceUi.tsx')).not.toMatch(/backup|export workspace|import workspace/i)

    const bundlePatch = readText('packages/bundle/cordis.patch.yml')
    expect(bundlePatch).toContain("name: '@dsh-agent-group/host/web-rpc'")
    for (const dependency of ['agentWorkspace', 'connection', 'webServer']) {
      expect(bundlePatch).toContain(`- ${dependency}`)
    }
  })

  it('documents both compatibility lines and keeps publication as a separate authorization', () => {
    const readme = readText('README.md')
    const architecture = readText('docs/architecture.md')
    const releaseNotes = readText('docs/releases/v0.2.0.md')
    const hostReadme = readText('packages/host/README.md')
    const webReadme = readText('packages/web/README.md')
    const bundleReadme = readText('packages/bundle/README.md')
    const compatibilityNotes = readText('docs/releases/v0.4.0.md')

    for (const text of [readme, releaseNotes]) {
      for (const value of ['Tasks', 'Memory', 'Runtime', 'definition revision', 'export:forward-v1']) expect(text).toContain(value)
      expect(text).toContain('no import')
    }
    expect(readme).toContain('[v0.2.0 release notes](docs/releases/v0.2.0.md)')
    expect(readme).toContain('[v0.3.0 release notes](docs/releases/v0.3.0.md)')
    expect(readme).toContain('[v0.4.0 release notes](docs/releases/v0.4.0.md)')
    expect(readme).toContain('| `0.2.x` | `>=0.1.1-rc.2 <0.1.2-0` |')
    expect(readme).toContain('| `0.3.x` | `>=0.1.7-alpha.2 <0.1.8-0` |')
    expect(readme).toContain('| `0.4.x` | `>=0.2.0-rc.2 <0.2.1-0` |')
    expect(readme).toContain('dsh plugin --profile web add dsh-agent-group@0.4.0')
    expect(readme).toContain('Do not update across plugin lines')
    expect(readme).toContain('pnpm smoke:registry -- --version 0.4.0')
    expect(releaseNotes).toContain('does not publish packages, create tags, or create a GitHub Release')
    expect(compatibilityNotes).toContain('does not publish packages, create tags, or create a GitHub Release')
    expect(architecture).toContain('TaskDeliveryCoordinator')
    expect(architecture).toContain('WorkspaceActivityStream')
    expect(architecture).toContain('RFC 8785')
    expect(hostReadme).toContain('Version `0.4.0`')
    expect(hostReadme).toContain('createForwardWorkspaceExportV1')
    expect(webReadme).toContain('four views')
    expect(bundleReadme).toContain('Compatibility for v0.4.0')
  })

  it('binds packed and registry smoke to the installed public exporter and legacy fixture', () => {
    const driver = readText('scripts/release-smoke.mjs')
    for (const value of [
      'FORWARD_EXPORT_SOURCE_FIXTURE',
      'LEGACY_SESSION_SENTINEL',
      'verifyInstalledForwardExport',
      'verifyForwardExportPeerIsolation',
      'verifyInstalledLegacyLoad',
      'createRequire',
      'forward-export-v1.json',
      'forward-export-peer-isolation.json',
      'legacy-load.json',
      'assertForwardExportEvidence',
      'assertLegacyWorkspacePreserved',
    ]) expect(driver).toContain(value)
    expect(driver.indexOf('await verifyInstalledForwardExport')).toBeLessThan(driver.indexOf('await startServer(fixture'))
    expect(driver.indexOf('await verifyInstalledLegacyLoad')).toBeLessThan(driver.indexOf('await startServer(fixture'))

    const release = readText('scripts/release.mjs')
    expect(release).toContain('assertCompatibilityDeclaration')
    expect(release).toContain('declaration.forwardExport')

    for (const workflow of ['.github/workflows/release-smoke.yml', '.github/workflows/registry-smoke.yml']) {
      const source = readText(workflow)
      expect(source).toContain('scripts/export-forward-v1.mjs')
      expect(source).toContain('packages/host/src/forward-export.ts')
      expect(source).toContain('tests/fixtures/v0.1.0/agent-workspace.json')
      expect(source).not.toContain('--installation-only')
    }
  })

  it('independently validates forward-export smoke evidence', async () => {
    const { assertForwardExportEvidence, assertLegacyWorkspacePreserved } = await import('../scripts/release-smoke-contract.mjs')
    const source = readJson('tests/fixtures/v0.2.0/agent-workspace.json')
    const document = readJson('tests/fixtures/v0.2.0/portable-workspace-v1.json')
    const state = source.tables.workspaces.local
    expect(() => assertForwardExportEvidence(document, state, '0.2.0', {
      format: 'dsh-agent-workspace', formatVersion: 1,
    })).not.toThrow()
    expect(() => assertForwardExportEvidence({ ...document, pluginVersion: '0.1.1' }, state, '0.2.0', {
      format: 'dsh-agent-workspace', formatVersion: 1,
    })).toThrow(/plugin version/i)
    expect(() => assertForwardExportEvidence({
      ...document,
      workspace: { ...document.workspace, aggregate: { ...document.workspace.aggregate, sessionBindings: state.sessionBindings } },
    }, state, '0.2.0', { format: 'dsh-agent-workspace', formatVersion: 1 })).toThrow(/sessionBindings/i)
    expect(() => assertForwardExportEvidence({ ...document, digest: { ...document.digest, hex: '0'.repeat(64) } }, state, '0.2.0', {
      format: 'dsh-agent-workspace', formatVersion: 1,
    })).toThrow(/digest/i)
    expect(() => assertLegacyWorkspacePreserved(source, structuredClone(source))).not.toThrow()
    const rewritten = structuredClone(source)
    rewritten.tables.workspaces.local.sessionBindings['agent-3'] = 'rewritten-session'
    expect(() => assertLegacyWorkspacePreserved(source, rewritten)).toThrow(/rewrote.*session bindings/i)
  })

  it('ships an MIT license and public installation instructions', () => {
    expect(existsSync(new URL('../LICENSE', import.meta.url))).toBe(true)
    expect(readText('LICENSE')).toContain('MIT License')

    const readme = readText('README.md')
    expect(readme).toContain('dsh plugin --profile web add dsh-agent-group')
    expect(readme).toContain('dsh plugin --profile web update dsh-agent-group')
    expect(readme).toContain('dsh plugin --profile web remove dsh-agent-group')
    expect(readme).not.toContain('scaffold; not yet implemented')
    expect(readme).not.toContain('Web overlay is a scaffold')
  })

  it.each(packages)('%s has public npm metadata', path => {
    const manifest = readJson(path)
    expect(manifest.license).toBe('MIT')
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/SNRoman/dsh-agent-group.git',
      directory: path.replace('/package.json', '').replace('packages/bundle', 'packages/bundle'),
    })
    expect(manifest.homepage).toBe('https://github.com/SNRoman/dsh-agent-group#readme')
    expect(manifest.bugs).toEqual({ url: 'https://github.com/SNRoman/dsh-agent-group/issues' })
    expect(manifest.publishConfig).toEqual({ access: 'public' })
  })

  it('targets the current DeepSeek Harness release line and Cordis major', () => {
    const host = readJson('packages/host/package.json')
    const web = readJson('packages/web/package.json')
    const bundle = readJson('packages/bundle/package.json')

    expect(host.peerDependencies['@deepseek-ai/cordis']).toBe('^4.0.1')
    expect(bundle.peerDependencies['@deepseek-ai/cordis']).toBe('^4.0.1')

    for (const [name, range] of Object.entries(host.peerDependencies)) {
      if (name.startsWith('@deepseek-ai/dsh-')) expect(range).toBe(dshRange)
    }
    for (const [name, range] of Object.entries(web.peerDependencies)) {
      if (name.startsWith('@deepseek-ai/dsh-')) expect(range).toBe(dshRange)
    }
    for (const [name, range] of Object.entries(bundle.dependencies)) {
      if (name.startsWith('@deepseek-ai/dsh-')) expect(range).toBe(dshRange)
    }
  })

  it('defines deterministic release commands and a packed clean-install gate', () => {
    const root = readJson('package.json')
    expect(root.scripts['release:pack']).toBeTruthy()
    expect(root.scripts['release:publish']).toBeTruthy()
    expect(root.scripts['smoke:packed']).toBeTruthy()
    expect(root.scripts['test:e2e:browser']).toBe('pnpm release:pack && node scripts/release-smoke.mjs --mode packed')

    const ci = readText('.github/workflows/ci.yml')
    expect(ci).toContain('pnpm exec playwright install --with-deps chromium')
    expect(ci).toContain('pnpm test:e2e:browser -- --dsh "$GITHUB_WORKSPACE/deepseek-harness"')
    expect(ci).toContain('ref: 639ed015397290b3745d163aafe02ffee4aa3f84')

    const workflow = readText('.github/workflows/release-smoke.yml')
    expect(workflow).toContain('pnpm test:e2e:browser -- --dsh "$GITHUB_WORKSPACE/deepseek-harness"')
    expect(workflow).toContain('timeout-minutes: 30')
    for (const path of [
      'compatibility.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'scripts/release-artifacts.mjs',
      'scripts/release-smoke-contract.mjs',
      'tests/e2e/README.md',
    ]) {
      expect(workflow).toContain(`- '${path}'`)
    }
    const driver = readText('scripts/release-smoke.mjs')
    expect(driver).toContain("['dsh', '--profile', 'web'")
    expect(driver).toContain("'--port', '0'")
    expect(driver).toContain("'--scratch-root'")
    expect(driver).toContain("DSH_AGENT_GROUP_SCRATCH_ROOT")
    expect(driver).toContain("argument === '--scratch-root' ? 'scratchRoot'")
    expect(driver).not.toContain('mkdtemp(join(tmpdir()')
    expect(driver).toContain('verifyReleaseArtifacts')
    const release = readText('scripts/release.mjs')
    expect(release).toContain('writeReleaseManifest')
    expect(release).toContain('verifyReleaseSmokeReceipt')
    expect(release).toContain('releasePublishCommands(release.artifacts, forwarded)')
  })

  it('binds publishing and packed smoke to the same current release artifacts', async () => {
    const {
      releasePublishCommands,
      verifyReleaseArtifacts,
      verifyReleaseSmokeReceipt,
      writeReleaseManifest,
      writeReleaseSmokeReceipt,
    } = await import('../scripts/release-artifacts.mjs')
    const root = await mkdtemp(join(tmpdir(), 'dsh-agent-group-release-artifacts-'))
    try {
      await writeFile(join(root, 'LICENSE'), 'license\n', 'utf8')
      for (const directory of ['host', 'web', 'bundle']) {
        await mkdir(join(root, 'packages', directory, 'src'), { recursive: true })
        await writeFile(join(root, 'packages', directory, 'package.json'), `${JSON.stringify({ version: '1.2.3' })}\n`, 'utf8')
        await writeFile(join(root, 'packages', directory, 'README.md'), `${directory}\n`, 'utf8')
        await writeFile(join(root, 'packages', directory, 'src', 'index.ts'), `export const value = '${directory}'\n`, 'utf8')
      }
      await writeFile(join(root, 'packages', 'bundle', 'cordis.patch.yml'), 'plugins: []\n', 'utf8')
      await mkdir(join(root, 'scripts'), { recursive: true })
      await mkdir(join(root, 'tests', 'e2e'), { recursive: true })
      await mkdir(join(root, 'tests', 'fixtures', 'browser'), { recursive: true })
      await mkdir(join(root, 'tests', 'fixtures', 'v0.1.0'), { recursive: true })
      await writeFile(join(root, 'scripts', 'release-smoke.mjs'), 'smoke driver\n', 'utf8')
      await writeFile(join(root, 'scripts', 'release-smoke-contract.mjs'), 'smoke assertions\n', 'utf8')
      await writeFile(join(root, 'tests', 'e2e', 'workspace-browser.mjs'), 'browser scenario\n', 'utf8')
      await writeFile(join(root, 'tests', 'e2e', 'README.md'), 'browser operator guide\n', 'utf8')
      await writeFile(join(root, 'tests', 'fixtures', 'browser', 'cordis.test.yml'), 'fixture\n', 'utf8')
      await writeFile(join(root, 'tests', 'fixtures', 'v0.1.0', 'agent-workspace.json'), '{}\n', 'utf8')
      const releaseDir = join(root, 'release')
      await mkdir(releaseDir)
      for (const filename of [
        'dsh-agent-group-host-1.2.3.tgz',
        'dsh-agent-group-web-1.2.3.tgz',
        'dsh-agent-group-1.2.3.tgz',
      ]) await writeFile(join(releaseDir, filename), filename, 'utf8')

      writeReleaseManifest(root, '1.2.3')
      expect(() => verifyReleaseArtifacts(root, '1.2.3')).not.toThrow()
      expect(() => verifyReleaseSmokeReceipt(root, '1.2.3', { version: '0.1.1-rc.2', commit: 'abc' })).toThrow('smoke receipt')
      writeReleaseSmokeReceipt(root, '1.2.3', { version: '0.1.1-rc.2', commit: 'abc' })
      expect(() => verifyReleaseSmokeReceipt(root, '1.2.3', { version: '0.1.1-rc.2', commit: 'abc' })).not.toThrow()
      const release = verifyReleaseArtifacts(root, '1.2.3')
      const publish = releasePublishCommands(release.artifacts, ['--tag', 'next'])
      expect(publish).toEqual([
        ['publish', release.artifacts.host, '--access', 'public', '--tag', 'next'],
        ['publish', release.artifacts.web, '--access', 'public', '--tag', 'next'],
        ['publish', release.artifacts.bundle, '--access', 'public', '--tag', 'next'],
      ])
      expect(publish.flat()).not.toContain('pack')
      expect(publish.flat()).not.toContain('--filter')

      await writeFile(join(root, 'tests', 'e2e', 'workspace-browser.mjs'), 'stronger browser scenario\n', 'utf8')
      expect(() => verifyReleaseSmokeReceipt(root, '1.2.3', { version: '0.1.1-rc.2', commit: 'abc' })).toThrow('smoke receipt')
      await writeFile(join(root, 'tests', 'e2e', 'workspace-browser.mjs'), 'browser scenario\n', 'utf8')
      await writeFile(join(root, 'tests', 'e2e', 'README.md'), 'changed operator guide\n', 'utf8')
      expect(() => verifyReleaseSmokeReceipt(root, '1.2.3', { version: '0.1.1-rc.2', commit: 'abc' })).toThrow('smoke receipt')
      await writeFile(join(root, 'tests', 'e2e', 'README.md'), 'browser operator guide\n', 'utf8')
      await writeFile(join(root, 'packages', 'host', 'src', 'index.ts'), 'changed\n', 'utf8')
      expect(() => verifyReleaseArtifacts(root, '1.2.3')).toThrow('source')
      await writeFile(join(root, 'packages', 'host', 'src', 'index.ts'), "export const value = 'host'\n", 'utf8')
      await writeFile(join(releaseDir, 'dsh-agent-group-host-1.2.3.tgz'), 'changed artifact', 'utf8')
      expect(() => verifyReleaseArtifacts(root, '1.2.3')).toThrow('artifact')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, CONCURRENT_LANE_TEST_TIMEOUT_MS)

  it('ships executable packed and registry smoke entry points', () => {
    for (const path of browserFixtureFiles) {
      expect(existsSync(new URL(`../${path}`, import.meta.url))).toBe(true)
    }

    const fixture = readText('tests/fixtures/browser/cordis.test.yml')
    expect(fixture).toContain('agent-workspace-scripted-llm')
    expect(fixture).toContain("name: './scripted-llm.ts'")
    expect(fixture).toContain('agent-workspace-task-tools-profile')
    expect(fixture).toContain("name: './task-tools-profile.ts'")
    expect(fixture).toContain('id: directory-picker')
    expect(fixture).toContain('id: session-persistence-jsonl')
    expect(fixture).toContain("root: !!js dshHomePath('sessions')")
    expect(fixture).toContain('compression: none')
    expect(fixture).toContain('id: agent-default-model')
    expect(fixture).toContain('provider: agent-workspace-scripted')
    expect(fixture).toContain('model: workspace-smoke')
    expect(fixture).toContain('id: directory-picker-browse')
    expect(fixture).toContain("name: '@deepseek-ai/dsh-host-directory-picker-browse'")
    expect(fixture).toContain('id: ui-directory-picker-browse')
    expect(fixture).toContain("name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'")

    const scripted = readText('tests/fixtures/browser/scripted-llm.ts')
    expect(scripted).toContain('@deepseek-ai/dsh-llm')
    expect(scripted).toContain('scripted')
    expect(scripted).toContain("const PROVIDER = 'agent-workspace-scripted'")
    expect(scripted).toContain("const MODEL = 'workspace-smoke'")
    expect(scripted).toContain('workspace_complete_task')
    expect(scripted).toContain("`${gate}.denial-result-ready`")
    expect(scripted).toContain('const GATE_TIMEOUT_MS = 120_000')
    expect(scripted).toContain('setTimeout(() => finish(new Error(\'scripted smoke gate timed out\')), GATE_TIMEOUT_MS)')
    for (const marker of [
      'V020_DELEGATE',
      'V020_CHILD',
      'V020_SAFE_FAILURE',
      'V020_HOLD',
    ]) expect(scripted).toContain(marker)
    expect(readText('tests/fixtures/browser/task-tools-profile.ts')).toContain('runAssignedTask')
    expect(readText('tests/fixtures/task-tools/profile-session.expected.json')).toContain('workspace_delegate_task')

    const hostSource = readText('packages/host/src/index.ts')
    expect(hostSource).toContain("childProvider: z.string().default('spawn')")
    expect(hostSource).toContain('this.config.childProvider')
    expect(hostSource).not.toContain("'spawn-in-process'")

    const smoke = readText('tests/e2e/workspace-browser.mjs')
    expect(smoke).toContain('playwright')
    expect(smoke).toContain('toMatchAriaSnapshot')
    expect(smoke).toContain('@all')
    expect(smoke).toContain("waitForFixtureReceipt(`${args.gate}.denial-result-ready`)")
    expect(smoke).toContain('name: /^Release room \\d+$/u')
    expect(smoke).toContain("name: /^Alice Responding Direct$/u")
    expect(smoke).toContain("row.locator('p').getByText(entry.text, { exact: true })")
    expect(smoke).toContain("isRecordedToolError(")
    expect(smoke).toContain("'profile-policy-denial'")
    expect(smoke).toContain("getByRole('article', { name: '修订 1', exact: true }).waitFor")
    expect(smoke).toContain("getByRole('article', { name: '修订 2', exact: true }).waitFor")
    expect(smoke).toContain('Creation event ${receipt.revisionEventSequence}')
    expect(smoke).toContain("getByText('当前没有运行活动。', { exact: true })")
    expect(smoke).toContain('zh-CN runtime rendered an untranslated Host failure summary')
    expect(smoke).toContain("['不可变修订历史', '修订 1', '修订 2', '指令', '保存新修订']")
    expect(smoke).not.toContain('getByText(/响应中|正在停止|排队中/u)')
    expect(smoke).not.toContain('if (await prompt.count() > 0) return')

    const taskToolsSmoke = readText('tests/e2e/task-tools-profile.mjs')
    expect(taskToolsSmoke).toContain('task-tools-recorded-session.json')
    expect(taskToolsSmoke).toContain('profile-session.expected.json')
    expect(taskToolsSmoke).toContain("/^session(?:\\.v\\d+)?\\.jsonl$/u")
    expect(smoke).toContain("/^session(?:\\.v\\d+)?\\.jsonl$/u")

    const registryWorkflow = readText('.github/workflows/registry-smoke.yml')
    expect(registryWorkflow).toContain('workflow_dispatch')
    expect(registryWorkflow).toContain('plugin-version')
    expect(registryWorkflow).toContain('pnpm smoke:registry')
    expect(registryWorkflow).toContain('--dsh "$GITHUB_WORKSPACE/deepseek-harness"')
    expect(registryWorkflow).toContain('timeout-minutes: 30')
    const releaseDriver = readText('scripts/release-smoke.mjs')
    expect(releaseDriver).toContain("['view', `${name}@${version}`, 'version', 'dist.integrity'")
    expect(releaseDriver).toContain('verifyInstalledPackages')
    expect(releaseDriver).toContain('assertPublishedRegistryPackage')
    expect(releaseDriver).toContain('assertProfileManifest')
    expect(releaseDriver).toContain('assertResolvedPackages')
    expect(releaseDriver).toContain('registryProfileCommands')
    expect(releaseDriver).toContain('assertProfileLock')
    expect(releaseDriver).toContain('assertAssembledConfig')
    expect(releaseDriver).toContain('packed-manifests.json')
    expect(releaseDriver).toContain('--task-tools-only')
    expect(releaseDriver).toContain("REGISTRY_PACKAGES = ['@dsh-agent-group/host', '@dsh-agent-group/web', 'dsh-agent-group']")
    expect(releaseDriver).toContain("'--phase', 'after-restart'")
    expect(releaseDriver.indexOf("'--phase', 'after-restart'")).toBeLessThan(releaseDriver.lastIndexOf('uninstallProfileCommand'))
    expect(releaseDriver).toContain('randomUUID')
    expect(releaseDriver).toContain('cordis.after-restart.yml')
    expect(releaseDriver).toContain('fixture.restartPath')
    expect(releaseDriver).toContain('host-lifecycle.json')

    const guide = readText('tests/e2e/README.md')
    for (const required of [
      'pnpm test:e2e:browser',
      '--dsh',
      'DSH_SOURCE',
      '639ed015397290b3745d163aafe02ffee4aa3f84',
      'evidence/',
      'twice',
      'cleanup',
    ]) expect(guide).toContain(required)

    const browserScenario = readText('tests/e2e/workspace-browser.mjs')
    expect(browserScenario).toContain('Preview Notice|内测声明|预览版说明')
    expect(browserScenario).toContain('composer.pressSequentially(text)')
    expect(browserScenario).toContain('Describe what you want to build|Message or run a task')
    expect(browserScenario).not.toContain('waitForTimeout(')
    expect(browserScenario).not.toContain('setTimeout(resolvePromise')
    expect(browserScenario).toContain("const prefix = `${args.phase}-`")
    for (const required of [
      'V020_ROOT',
      'V020_CHILD',
      'V020_HOLD',
      'Grant delegation for',
      'Stop Alice current turn (',
      'Unified personal memory',
      'Save revision',
      'Synchronize revision',
      'zh-CN',
      'after-restart',
    ]) expect(browserScenario).toContain(required)
  })

  it('rejects incomplete registry and profile evidence before the browser smoke', async () => {
    const {
      assertAssembledConfig,
      assertProfileLock,
      assertProfileManifest,
      assertPublishedRegistryPackage,
      assertResolvedPackages,
      registryProfileCommands,
    } = await import('../scripts/release-smoke-contract.mjs')
    const version = '1.2.3'
    const registry = {
      name: '@dsh-agent-group/host',
      version,
      integrity: 'sha512-host-integrity',
      tarball: 'https://registry.npmjs.org/@dsh-agent-group/host/-/host-1.2.3.tgz',
    }
    const bundle = {
      name: 'dsh-agent-group',
      version,
      integrity: 'sha512-bundle-integrity',
      tarball: 'https://registry.npmjs.org/dsh-agent-group/-/dsh-agent-group-1.2.3.tgz',
      dependencies: { '@dsh-agent-group/host': `^${version}`, '@dsh-agent-group/web': `^${version}` },
    }
    const web = {
      name: '@dsh-agent-group/web',
      version,
      integrity: 'sha512-web-integrity',
      tarball: 'https://registry.npmjs.org/@dsh-agent-group/web/-/web-1.2.3.tgz',
    }
    const profile = {
      dependencies: {
        '@dsh-agent-group/host': version,
        '@dsh-agent-group/web': version,
        'dsh-agent-group': version,
      },
    }
    const lock = `
importers:
  .:
    dependencies:
      '@dsh-agent-group/host':
        specifier: 1.2.3
        version: 1.2.3
      '@dsh-agent-group/web':
        specifier: 1.2.3
        version: 1.2.3
      dsh-agent-group:
        specifier: 1.2.3
        version: 1.2.3
packages:
  '@dsh-agent-group/host@1.2.3':
    resolution: {integrity: sha512-host-integrity}
  '@dsh-agent-group/web@1.2.3':
    resolution: {integrity: sha512-web-integrity}
  dsh-agent-group@1.2.3:
    resolution: {integrity: sha512-bundle-integrity}
snapshots:
  '@dsh-agent-group/host@1.2.3': {}
  '@dsh-agent-group/web@1.2.3': {}
  dsh-agent-group@1.2.3: {}
`
    const resolved = [registry, web, bundle].map(entry => ({
      name: entry.name,
      installations: [{ version, resolved: entry.tarball }],
      registryIntegrity: entry.integrity,
    }))

    expect(() => {
      expect(registryProfileCommands(version)).toEqual([
        ['dsh', 'plugin', '--profile', 'web', 'add', `dsh-agent-group@${version}`],
        [
          'dsh',
          'plugin',
          '--profile',
          'web',
          'add',
          '--save-exact',
          `@dsh-agent-group/host@${version}`,
          `@dsh-agent-group/web@${version}`,
        ],
      ])
      assertPublishedRegistryPackage(registry, version)
      assertPublishedRegistryPackage(web, version)
      assertPublishedRegistryPackage(bundle, version)
      assertProfileManifest(profile, version)
      assertProfileLock(lock, version, [registry, web, bundle])
      assertResolvedPackages(resolved, version)
      assertAssembledConfig(`
- id: agent-workspace
  name: '@dsh-agent-group/host'
- id: agent-workspace-web
  name: '@dsh-agent-group/web'
- id: directory-picker
  name: '@deepseek-ai/dsh-host-directory-picker-auto'
  disabled: true
- id: directory-picker-browse
  name: '@deepseek-ai/dsh-host-directory-picker-browse'
- id: ui-directory-picker-browse
  name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
- id: agent-workspace-scripted-llm
  name: file:///scripted-llm.ts
- id: agent-workspace-task-tools-profile
  name: file:///task-tools-profile.ts
`, 'file:///scripted-llm.ts', 'file:///task-tools-profile.ts')
      assertAssembledConfig(`
- id: agent-workspace
  name: '@dsh-agent-group/host'
- id: agent-workspace-web
  name: '@dsh-agent-group/web'
- id: directory-picker
  name: '@deepseek-ai/dsh-host-directory-picker-auto'
  disabled: true
- id: directory-picker-browse
  name: '@deepseek-ai/dsh-host-directory-picker-browse'
- id: ui-directory-picker-browse
  name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
- id: agent-workspace-scripted-llm
  name: >-
    file:///scripted-llm.ts
- id: agent-workspace-task-tools-profile
  name: file:///task-tools-profile.ts
`, 'file:///scripted-llm.ts', 'file:///task-tools-profile.ts')
    }).not.toThrow()
    expect(() => assertPublishedRegistryPackage({ ...registry, integrity: undefined }, version)).toThrow('integrity')
    expect(() => assertPublishedRegistryPackage({ ...registry, tarball: 'https://registry.npmjs.org/@dsh-agent-group/host/-/host-1.2.2.tgz' }, version)).toThrow('tarball')
    expect(() => assertPublishedRegistryPackage({
      ...registry,
      name: 'dsh-agent-group',
      dependencies: { '@dsh-agent-group/host': version, '@dsh-agent-group/web': `^${version}` },
    }, version)).toThrow('bundle dependency')
    expect(() => assertProfileManifest({
      ...profile,
      dependencies: { ...profile.dependencies, '@dsh-agent-group/host': `^${version}` },
    }, version)).toThrow('profile dependency')
    expect(() => assertProfileLock(lock.replace('specifier: 1.2.3', 'specifier: ^1.2.3'), version, [registry, web, bundle])).toThrow('specifier')
    expect(() => assertProfileLock(`
packages:
  '@dsh-agent-group/host@1.2.2':
    resolution: {integrity: sha512-host-integrity}
`, version, [registry])).toThrow('expected only')
    expect(() => assertProfileLock(`
packages:
  '@dsh-agent-group/host@1.2.3':
    resolution: {integrity: sha512-wrong-integrity}
`, version, [registry])).toThrow('integrity')
    expect(() => assertResolvedPackages(resolved.map(entry => entry.name === '@dsh-agent-group/web'
      ? { ...entry, installations: [{ version: '1.2.4' }] }
      : entry), version)).toThrow('expected only')
    expect(() => assertAssembledConfig(`
- id: agent-workspace-scripted-llm
  name: file:///scripted-llm.ts
`, 'file:///scripted-llm.ts', 'file:///task-tools-profile.ts')).toThrow('Host')
    expect(() => assertAssembledConfig(`
- id: agent-workspace
  name: '@dsh-agent-group/host'
- id: agent-workspace-web
  name: '@dsh-agent-group/web'
- id: directory-picker
  name: '@deepseek-ai/dsh-host-directory-picker-auto'
- id: agent-workspace-scripted-llm
  name: file:///scripted-llm.ts
`, 'file:///scripted-llm.ts', 'file:///task-tools-profile.ts')).toThrow('directory picker')
    expect(() => assertAssembledConfig(`
- id: agent-workspace
  name: '@dsh-agent-group/host'
- id: agent-workspace-web
  name: '@dsh-agent-group/web'
- id: directory-picker
  name: '@deepseek-ai/dsh-host-directory-picker-auto'
  disabled: true
- id: directory-picker-browse
  name: '@deepseek-ai/dsh-host-directory-picker-browse'
- id: ui-directory-picker-browse
  name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
- id: agent-workspace-scripted-llm
  name: file:///scripted-llm.ts
`, 'file:///wrong-scripted-llm.ts', 'file:///task-tools-profile.ts')).toThrow('scripted')
    expect(() => assertAssembledConfig(`
- id: agent-workspace
  config:
    name: '@dsh-agent-group/host'
- id: agent-workspace-web
  name: '@dsh-agent-group/web'
- id: agent-workspace-scripted-llm
  name: file:///scripted-llm.ts
`, 'file:///scripted-llm.ts', 'file:///task-tools-profile.ts')).toThrow('Host')

    expect(() => assertAssembledConfig(`
- id: agent-workspace
  name: '@dsh-agent-group/host'
- id: agent-workspace-web
  name: '@dsh-agent-group/web'
- id: directory-picker
  name: '@deepseek-ai/dsh-host-directory-picker-auto'
  disabled: true
- id: directory-picker-browse
  name: '@deepseek-ai/dsh-host-directory-picker-browse'
- id: ui-directory-picker-browse
  name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
- id: agent-workspace-scripted-llm
  name: file:///scripted-llm.ts
`, 'file:///scripted-llm.ts', 'file:///task-tools-profile.ts')).toThrow('task-tools')
  })

  it('rejects incomplete durable Browser evidence', async () => {
    const { assertBrowserDurableEvidence } = await import('../scripts/release-smoke-contract.mjs')
    const durable = {
      agents: {
        alice: { id: 'alice', name: 'Alice' },
        bob: { id: 'bob', name: 'Bob' },
      },
      rooms: {
        release: { id: 'release', kind: 'group', name: 'Release room' },
      },
      memberships: {
        alice: { id: 'membership-alice', roomId: 'release', agentId: 'alice', memoryStart: { type: 'new-events' } },
        bob: { id: 'membership-bob', roomId: 'release', agentId: 'bob', memoryStart: { type: 'event-range', startSequence: 7, endSequence: 7 } },
      },
      events: [
        { id: 'history', sequence: 7, type: 'room/message', subjectId: 'release', actor: { type: 'human', id: 'web-user' }, text: 'HISTORY_BEFORE_JOIN' },
        { id: 'direct', type: 'room/message', actor: { type: 'agent', id: 'alice' }, text: 'DIRECT_REPLY Alice' },
        { id: 'hold', type: 'room/message', actor: { type: 'agent', id: 'alice' }, text: 'HOLD_REPLY Alice' },
        { id: 'memory', type: 'room/message', actor: { type: 'agent', id: 'alice' }, text: 'MEMORY_OK Alice' },
      ],
      memoryEntries: [
        { id: 'bob-history', agentId: 'bob', eventId: 'history', acquiredBy: 'history-sync' },
      ],
    }

    expect(() => assertBrowserDurableEvidence(durable)).not.toThrow()
    expect(() => assertBrowserDurableEvidence({
      ...durable,
      memberships: {
        ...durable.memberships,
        alice: { ...durable.memberships.alice, memoryStart: { type: 'event-range', startSequence: 1, endSequence: 1 } },
      },
    })).toThrow('new-events')
    expect(() => assertBrowserDurableEvidence({
      ...durable,
      memberships: {
        ...durable.memberships,
        bob: { ...durable.memberships.bob, memoryStart: { type: 'new-events' } },
      },
    })).toThrow('historical')
    expect(() => assertBrowserDurableEvidence({
      ...durable,
      memberships: {
        ...durable.memberships,
        bob: { ...durable.memberships.bob, memoryStart: { type: 'event-range', startSequence: 6, endSequence: 7 } },
      },
    })).toThrow('historical')
    expect(() => assertBrowserDurableEvidence({
      ...durable,
      memoryEntries: [...durable.memoryEntries, { id: 'alice-history', agentId: 'alice', eventId: 'history', acquiredBy: 'history-sync' }],
    })).toThrow('Alice')
    expect(() => assertBrowserDurableEvidence({ ...durable, memoryEntries: [] })).toThrow('Bob')
    expect(() => assertBrowserDurableEvidence({
      ...durable,
      memoryEntries: [...durable.memoryEntries, { id: 'duplicate-bob-history', agentId: 'bob', eventId: 'history', acquiredBy: 'history-sync' }],
    })).toThrow('Bob')
    expect(() => assertBrowserDurableEvidence({
      ...durable,
      memoryEntries: [...durable.memoryEntries, { id: 'wrong-bob-history', agentId: 'bob', eventId: 'history', acquiredBy: 'room-membership' }],
    })).toThrow('Bob')
    for (const text of ['DIRECT_REPLY Alice', 'HOLD_REPLY Alice', 'MEMORY_OK Alice']) {
      expect(() => assertBrowserDurableEvidence({
        ...durable,
        events: [...durable.events, { id: `duplicate-${text}`, type: 'room/message', actor: { type: 'agent', id: 'alice' }, text }],
      })).toThrow(text)
    }
    expect(() => assertBrowserDurableEvidence({
      ...durable,
      events: [...durable.events, { id: 'partial', type: 'room/message', actor: { type: 'agent', id: 'alice' }, text: 'LIVE_PARTIAL' }],
    })).toThrow('LIVE_PARTIAL')
  })

  it('derives an uninstall command from only the release packages that are direct profile dependencies', async () => {
    const { uninstallProfileCommand } = await import('../scripts/release-smoke-contract.mjs')

    expect(uninstallProfileCommand({
      dependencies: {
        '@deepseek-ai/dsh-base': '0.1.1-rc.2',
        'dsh-agent-group': 'file:C:/release/dsh-agent-group.tgz',
      },
    })).toEqual([
      'dsh', 'plugin', '--profile', 'web', 'remove', 'dsh-agent-group',
    ])
    expect(uninstallProfileCommand({
      dependencies: {
        '@dsh-agent-group/host': '1.2.3',
        '@dsh-agent-group/web': '1.2.3',
        'dsh-agent-group': '1.2.3',
      },
    })).toEqual([
      'dsh', 'plugin', '--profile', 'web', 'remove',
      '@dsh-agent-group/host', '@dsh-agent-group/web', 'dsh-agent-group',
    ])
    expect(uninstallProfileCommand({ dependencies: { unrelated: '1.0.0' } })).toBeNull()
  })

  it('rejects an uninstall result that leaves a release package or loses the external fixture', async () => {
    const { assertUninstalledProfile } = await import('../scripts/release-smoke-contract.mjs')
    const fixture = 'file:///scripted-llm.ts'
    const manifest = {
      dependencies: { '@deepseek-ai/dsh-base': '0.1.1-rc.2' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }
    const config = `
- id: directory-picker
  name: '@deepseek-ai/dsh-host-directory-picker-auto'
  disabled: true
- id: directory-picker-browse
  name: '@deepseek-ai/dsh-host-directory-picker-browse'
- id: ui-directory-picker-browse
  name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
- id: agent-workspace-scripted-llm
  name: ${fixture}
- id: dsh-base
  name: '@deepseek-ai/dsh-base'
`

    expect(() => assertUninstalledProfile(manifest, config, fixture)).not.toThrow()
    for (const name of ['@dsh-agent-group/host', '@dsh-agent-group/web', 'dsh-agent-group']) {
      expect(() => assertUninstalledProfile({
        ...manifest,
        dependencies: { ...manifest.dependencies, [name]: '1.2.3' },
      }, config, fixture)).toThrow('direct dependency')
      expect(() => assertUninstalledProfile({
        ...manifest,
        dsh: { profile: { bundles: [...manifest.dsh.profile.bundles, name] } },
      }, config, fixture)).toThrow('bundle')
    }
    expect(() => assertUninstalledProfile(manifest, `
- id: agent-workspace
  name: '@dsh-agent-group/host'
${config}`, fixture)).toThrow('Host')
    expect(() => assertUninstalledProfile(manifest, `
- id: agent-workspace-web
  name: '@dsh-agent-group/web'
${config}`, fixture)).toThrow('Web')
    expect(() => assertUninstalledProfile(manifest, `
- id: directory-picker
  name: '@deepseek-ai/dsh-host-directory-picker-auto'
  disabled: true
- id: directory-picker-browse
  name: '@deepseek-ai/dsh-host-directory-picker-browse'
- id: ui-directory-picker-browse
  name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
- id: dsh-base
  name: '@deepseek-ai/dsh-base'
`, fixture)).toThrow('scripted')
    expect(() => assertUninstalledProfile(manifest, config.replace(
      '  disabled: true',
      '  disabled: false',
    ), fixture)).toThrow('directory picker')
  })

  it('requires every pre-uninstall session file to remain addressable after restart', async () => {
    const { assertFileTreePreserved } = await import('../scripts/release-smoke-contract.mjs')
    const before = [
      { path: 'alpha.jsonl', size: 17, sha256: 'a'.repeat(64) },
      { path: 'nested/beta.json', size: 29, sha256: 'b'.repeat(64) },
    ]

    expect(() => assertFileTreePreserved(before, structuredClone(before))).not.toThrow()
    expect(() => assertFileTreePreserved(before, [
      before[0],
      { ...before[1], sha256: 'c'.repeat(64) },
    ])).not.toThrow()
    expect(() => assertFileTreePreserved(before, [...before, {
      path: 'new.jsonl', size: 1, sha256: 'd'.repeat(64),
    }])).not.toThrow()
    expect(() => assertFileTreePreserved(before, [before[0]])).toThrow('nested/beta.json')
  })

  it('manifests every persisted Session file with stable relative paths and byte hashes', async () => {
    const { manifestFileTree } = await import('../scripts/release-smoke-contract.mjs')
    const root = await mkdtemp(join(tmpdir(), 'dsh-agent-group-manifest-'))
    try {
      await mkdir(join(root, 'nested'))
      await writeFile(join(root, 'z.jsonl'), 'alpha', 'utf8')
      await writeFile(join(root, 'nested', 'a.json'), 'beta', 'utf8')

      await expect(manifestFileTree(root)).resolves.toEqual([
        {
          path: 'nested/a.json',
          size: 4,
          sha256: 'f44e64e75f3948e9f73f8dfa94721c4ce8cbb4f265c4790c702b2d41cfbf2753',
        },
        {
          path: 'z.jsonl',
          size: 5,
          sha256: '8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8',
        },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('documents the packed and exact-version registry smoke commands', () => {
    const readme = readText('README.md')
    expect(readme).toContain('pnpm exec playwright install chromium')
    expect(readme).toContain('pnpm smoke:packed')
    expect(readme).toContain('pnpm smoke:registry -- --version')
    expect(readme).toContain('tests/e2e/workspace-browser.mjs')
  })
})
