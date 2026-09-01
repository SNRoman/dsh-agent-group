import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readText = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const readJson = (path: string) => JSON.parse(readText(path)) as Record<string, any>

const packages = [
  'packages/host/package.json',
  'packages/web/package.json',
  'packages/bundle/package.json',
] as const

const dshRange = '>=0.1.1-rc.2 <0.1.2-0'

describe('public release contract', () => {
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

    const workflow = readText('.github/workflows/release-smoke.yml')
    expect(workflow).toContain('pnpm pack')
    expect(workflow).toContain('dsh plugin --profile web add')
    expect(workflow).toContain('--dump-config')
  })
})
