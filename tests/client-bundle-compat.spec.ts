import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Browser bundle compatibility', () => {
  it('requests only client modules provided by the current DSH shell', async () => {
    const source = await readFile('packages/web/lib/client.js', 'utf8')
    const requested = new Set<string>()
    let loaded = false
    const window = {
      __ModuleLoader__: {
        load(bundle: {
          readonly id: string
          readonly factory: (require: (id: string) => Record<string, never>) => unknown
        }) {
          expect(bundle.id).toBe('@dsh-agent-group/web')
          bundle.factory((id) => {
            requested.add(id)
            return {}
          })
          loaded = true
        },
      },
    }

    new Function('window', source)(window)

    expect(loaded).toBe(true)
    expect(requested).toContain('@deepseek-ai/dsh-client-store')
    expect(requested).not.toContain('@deepseek-ai/dsh-client-runtime/client')
  })
})
