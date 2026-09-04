import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../scripts/verify-client-copy.mjs', import.meta.url))

function verify(fixture: 'failing.tsx' | 'passing.tsx') {
  const root = fileURLToPath(new URL(`./fixtures/client-copy/${fixture}`, import.meta.url))
  return spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' })
}

describe('client copy AST verifier', () => {
  it('reports every guarded display-literal category with source coordinates', () => {
    const result = verify('failing.tsx')
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/failing\.tsx:\d+:\d+ \[display-helper-return\]/)
    expect(result.stderr).toMatch(/failing\.tsx:\d+:\d+ \[aria-label\]/)
    expect(result.stderr).toMatch(/failing\.tsx:\d+:\d+ \[title\]/)
    expect(result.stderr).toMatch(/failing\.tsx:\d+:\d+ \[jsx-text\]/)
    expect(result.stderr).toMatch(/failing\.tsx:\d+:\d+ \[placeholder\]/)
  })

  it('accepts translations, technical attributes and user data expressions', () => {
    const result = verify('passing.tsx')
    expect(result).toMatchObject({ status: 0, stderr: '' })
  })
})
