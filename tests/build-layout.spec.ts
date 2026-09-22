import { exec, execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, test } from 'vitest'

const execFileAsync = promisify(execFile)
const execAsync = promisify(exec)
const packageDirectories = ['packages/host', 'packages/web', 'packages/bundle']
const CONCURRENT_PACK_TEST_TIMEOUT_MS = 120_000

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
  test('publishes the frozen forward exporter from the built Host entry', async () => {
    const host = JSON.parse(await readFile('packages/host/package.json', 'utf8')) as {
      dependencies: Record<string, string>
      exports: Record<string, unknown>
      files: string[]
    }
    expect(host.dependencies.canonicalize).toBe('2.1.0')
    expect(host.files).toContain('lib/index.js')
    expect(host.exports['./forward-export']).toEqual({
      types: './lib/types/forward-export.d.ts',
      default: './lib/types/forward-export.js',
    })

    const built = await import('../packages/host/lib/types/forward-export.js') as Record<string, unknown>
    expect(built.WORKSPACE_EXPORT_FORMAT_VERSION).toBe(1)
    expect(built.createForwardWorkspaceExportV1).toBeTypeOf('function')
  })

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
        if (archive.startsWith('dsh-agent-group-host-')) {
          const { stdout: entries } = await execFileAsync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-tf', join(destination, archive)])
          expect(entries).toContain('package/lib/index.js')
          expect(entries).toContain('package/lib/types/forward-export.d.ts')
          expect(entries).toContain('package/src/forward-export.ts')
        }
      }
    } finally {
      await rm(destination, { recursive: true, force: true })
    }
  }, CONCURRENT_PACK_TEST_TIMEOUT_MS)
})
