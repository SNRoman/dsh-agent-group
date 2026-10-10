import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'
import { WorkspaceId } from '../packages/host/src/ids.ts'
import { createInitialState } from '../packages/host/src/state.ts'
import { agentWorkspaceSpec } from '../packages/host/src/spec.ts'

describe('durable workspace records', () => {
  test('declares the new record reader', async () => {
    const module = await import('../packages/host/src/workspace-record.ts').catch(() => ({}))
    expect(module).toHaveProperty('workspaceRecordSchema')
  })

  test.each(['v0.1.0', 'v0.2.0'])('retains domain version zero and accepts the %s legacy local aggregate', async version => {
    const stored = JSON.parse(await readFile(new URL(`./fixtures/${version}/agent-workspace.json`, import.meta.url), 'utf8'))
    expect(agentWorkspaceSpec.version).toBe(0)
    expect(agentWorkspaceSpec.tables.workspaces.valueSchema.parse(stored.tables.workspaces.local)).toEqual(stored.tables.workspaces.local)
  })

  test('accepts strict v1 records while rejecting unknown metadata and mismatched identities', () => {
    const aggregate = createInitialState(WorkspaceId('org-one'))
    const record = { recordVersion: 1, descriptor: { id: aggregate.workspaceId, label: '组织', lifecycle: 'active' }, aggregate }
    const schema = agentWorkspaceSpec.tables.workspaces.valueSchema
    expect(schema.parse(record)).toEqual(record)
    expect(schema.safeParse({ ...record, extra: true }).success).toBe(false)
    expect(schema.safeParse({ ...record, descriptor: { ...record.descriptor, extra: true } }).success).toBe(false)
    expect(schema.safeParse({ ...record, descriptor: { ...record.descriptor, id: 'other' } }).success).toBe(false)
    expect(schema.safeParse(aggregate).success).toBe(false)
  })

  test.each(['legacy', 'wrapper'])('rejects decoded prototype keys in %s records before Zod strips them', kind => {
    const aggregate = createInitialState(WorkspaceId('local'))
    Object.defineProperty(aggregate.definitions, '__proto__', { value: { private: 'private-secret' }, enumerable: true })
    const value = kind === 'legacy' ? aggregate : { recordVersion: 1, descriptor: { id: 'local', label: '__proto__', lifecycle: 'active' }, aggregate }
    expect(agentWorkspaceSpec.tables.workspaces.valueSchema.safeParse(value).success).toBe(false)
  })
})
