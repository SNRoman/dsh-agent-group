import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  new URL('../packages/web/src/client/index.ts', import.meta.url),
  'utf8',
)

function quotedValues(pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map(match => match[1]).filter((value): value is string => value !== undefined)
}

describe('workspace UI registration compatibility', () => {
  it('occupies only the two additive DSH slots', () => {
    const injectedSlots = quotedValues(/ctx\.slots\.inject\(\s*'([^']+)'/g)
    const registeredSlots = quotedValues(/\bname:\s*'([^']+)'/g)

    expect(injectedSlots).toEqual(['sidebar.footer.action', 'shell.overlay'])
    expect(registeredSlots).toEqual(['sidebar.footer.action', 'shell.overlay'])

    for (const coreSlot of ['sidebar', 'conversation', 'details']) {
      expect(injectedSlots).not.toContain(coreSlot)
      expect(registeredSlots).not.toContain(coreSlot)
    }
  })

  it('creates one plugin-local store and shares it between both entries', () => {
    expect(source.match(/createWorkspaceUiStore\(\)/g)).toHaveLength(1)
    expect(source.match(/^\s*store,\s*$/gm)).toHaveLength(2)
  })

  it('uses the plugin id for both additive registrations', () => {
    expect(source.match(/id:\s*'agent-workspace'/g)).toHaveLength(2)
  })
})
