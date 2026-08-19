import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

describe('workspace manifests', () => {
  test('builds Host before Browser so generated Remote types exist', async () => {
    const root = JSON.parse(await readFile('package.json', 'utf8')) as { scripts: Record<string, string> }
    expect(root.scripts.build).toBe('pnpm build:host && pnpm build:web && pnpm build:bundle')
  })
})
