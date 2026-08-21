import { exec, execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, test } from 'vitest'

const execFileAsync = promisify(execFile)
const execAsync = promisify(exec)
const packageDirectories = ['packages/host', 'packages/web', 'packages/bundle']

async function pack(directory: string, destination: string): Promise<void> {
  const args = ['--dir', directory, 'pack', '--pack-destination', destination]
  if (process.platform !== 'win32') {
    await execFileAsync('pnpm', args)
    return
  }

  const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`
  const pnpm = join(process.env.PNPM_HOME ?? '', 'bin', 'pnpm.CMD')
  await execAsync([quote(pnpm), ...args.map(quote)].join(' '))
}

describe('workspace manifests', () => {
  test('builds Host before Browser so generated Remote types exist', async () => {
    const root = JSON.parse(await readFile('package.json', 'utf8')) as { scripts: Record<string, string> }
    expect(root.scripts.build).toBe('pnpm build:host && pnpm build:web && pnpm build:bundle')
  })

  test('publishes package archives without machine-local dependency links', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'dsh-agent-group-pack-'))
    try {
      for (const directory of packageDirectories) {
        await pack(directory, destination)
      }

      for (const archive of await readdir(destination)) {
        const { stdout } = await execFileAsync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xOf', join(destination, archive), 'package/package.json'])
        expect(stdout).not.toContain('link:')
      }
    } finally {
      await rm(destination, { recursive: true, force: true })
    }
  }, 60_000)
})
