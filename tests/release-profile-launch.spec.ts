import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { sourceProfileInvocation } from '../scripts/release-smoke-contract.mjs'

it('launches the pinned source profile in its owned workspace with the pinned TypeScript config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-profile-launch-'))
  try {
    const dsh = join(root, 'DSH source')
    const workspace = join(root, 'owned workspace')
    const cli = join(dsh, 'apps', 'cli', 'src')
    const loader = join(dsh, 'node_modules', 'tsx')
    await Promise.all([mkdir(cli, { recursive: true }), mkdir(loader, { recursive: true }), mkdir(workspace)])
    await Promise.all([
      writeFile(join(dsh, 'package.json'), JSON.stringify({ private: true, type: 'module' }), 'utf8'),
      writeFile(join(loader, 'package.json'), JSON.stringify({ type: 'module', exports: { './esm': './esm.mjs' } }), 'utf8'),
      writeFile(join(loader, 'esm.mjs'), '', 'utf8'),
      writeFile(join(cli, 'bin.ts'), `process.stdout.write(JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), tsconfig: process.env.TSX_TSCONFIG_PATH }))\n`, 'utf8'),
    ])
    const invocation = sourceProfileInvocation(dsh, workspace, ['--profile', 'web', '--no-open', '--port', '0'])
    const result = await execa(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      timeout: 10_000,
      reject: false,
    })
    expect(result.timedOut).toBe(false)
    expect(result.signal).toBeUndefined()
    expect(result.exitCode, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      cwd: await realpath(workspace),
      argv: ['--profile', 'web', '--no-open', '--port', '0'],
      tsconfig: join(dsh, 'tsconfig.json'),
    })
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)
