import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isCompletePackedSmoke } from '../scripts/release-smoke-contract.mjs'
import { resolveScratchRoot } from '../scripts/scratch-paths.mjs'

describe('release smoke authorization', () => {
  it.each([
    { mode: 'packed', installationOnly: false, taskToolsOnly: false, eligible: true },
    { mode: 'packed', installationOnly: true, taskToolsOnly: false, eligible: false },
    { mode: 'packed', installationOnly: false, taskToolsOnly: true, eligible: false },
    { mode: 'registry', installationOnly: false, taskToolsOnly: false, eligible: false },
    { mode: 'registry', installationOnly: true, taskToolsOnly: false, eligible: false },
    { mode: 'registry', installationOnly: false, taskToolsOnly: true, eligible: false },
  ])('certifies mode=$mode installationOnly=$installationOnly taskToolsOnly=$taskToolsOnly: $eligible', ({ eligible, ...options }) => {
    expect(isCompletePackedSmoke(options)).toBe(eligible)
  })
})

function smokeWorkflowPaths(filename: string) {
  const source = readFileSync(new URL(`../.github/workflows/${filename}`, import.meta.url), 'utf8')
  const steps = source.split(/^      - /mu).slice(1)
  const smokeIndex = steps.findIndex(step => /pnpm (?:test:e2e:browser|smoke:registry)/u.test(step))
  const smoke = steps[smokeIndex]
  const upload = steps.slice(smokeIndex + 1).find(step => /uses: actions\/upload-artifact@/u.test(step))
  if (smoke === undefined || upload === undefined) throw new Error('workflow must run smoke and upload its evidence')
  const runLines = smoke.split(/\r?\n/u)
  const runIndex = runLines.findIndex(line => /^ {8}run:/u.test(line))
  if (runIndex < 0) throw new Error('smoke step must provide a run command')
  const firstLine = runLines[runIndex].replace(/^ {8}run:\s*/u, '')
  const command = firstLine === '>-' || firstLine === '|'
    ? runLines.slice(runIndex + 1).map(line => line.trim()).join(' ')
    : firstLine
  const scratchArgument = /--scratch-root\s+(?:"([^"]+)"|'([^']+)'|(\S+))/u.exec(command)
  const scratchRoot = scratchArgument?.slice(1).find(value => value !== undefined)
  const uploadPath = /^ {10}path:\s*(.+)$/mu.exec(upload)?.[1]
  if (uploadPath === undefined) throw new Error('artifact upload must provide its evidence path')
  return { scratchRoot, uploadPath }
}

describe('CI smoke evidence collection', () => {
  it.each(['release-smoke.yml', 'registry-smoke.yml', 'ci.yml'])('%s writes smoke evidence inside its uploaded directory', filename => {
    const workspace = resolve('test-ci-workspace')
    const paths = smokeWorkflowPaths(filename)
    const scratchRoot = resolveScratchRoot(paths.scratchRoot?.replaceAll('$GITHUB_WORKSPACE', workspace), {})
    const uploadedDirectory = resolve(workspace, paths.uploadPath)

    expect(join(scratchRoot, 'evidence', 'run')).toBe(join(uploadedDirectory, 'evidence', 'run'))
  })
})
