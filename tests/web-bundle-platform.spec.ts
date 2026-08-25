import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

describe('workspace browser bundle platform contract', () => {
  test('keeps DSH UI primitives in the shared browser module table', async () => {
    const source = await readFile('packages/web/tsdown.config.ts', 'utf8')

    expect(source).toContain("  '@deepseek-ai/dsh-client-ui-primitives',")
  })
})
