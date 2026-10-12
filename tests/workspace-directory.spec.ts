import { readFile } from 'node:fs/promises'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, test } from 'vitest'
import { WorkspaceDirectory } from '../packages/host/src/workspace-directory.ts'
import { WorkspaceOperationId } from '../packages/host/src/workspace-record.ts'
import type { StoredWorkspace, WorkspaceRecordV1 } from '../packages/host/src/workspace-record.ts'
import { WorkspaceId } from '../packages/host/src/ids.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import { createForwardWorkspaceExportV1 } from '../packages/host/src/forward-export.ts'
import { createWorkspaceExportV2 } from '../packages/host/src/workspace-portable.ts'
import { workspaceStateSchema } from '../packages/host/src/workspace-state-schema.ts'
import type { WorkspaceState } from '../packages/host/src/types.ts'
import { createInitialWorkflowState } from '../packages/host/src/workflow.ts'

const limits = { maxBytes: 1_000_000, maxEntities: 10_000, maxEvents: 10_000, maxStringBytes: 100_000, maxDepth: 32 }
const exportedAt = '2026-10-10T00:00:00.000Z'

function table(initial: [WorkspaceId, StoredWorkspace][] = []) {
  const rows = new Map(initial)
  let failure: Error | undefined
  let writes = 0
  const result: KvTable<WorkspaceId, StoredWorkspace> = {
    get: id => rows.get(id), entries: () => rows.entries(), keys: () => rows.keys(), get size() { return rows.size },
    put: async (id, value) => { if (failure) { const error = failure; failure = undefined; throw error }; writes++; rows.set(id, structuredClone(value)) },
    delete: async id => rows.delete(id),
    update: async (id, fn) => { const value = rows.get(id); if (!value) throw new Error('missing'); const next = fn(value); await result.put(id, next); return next },
  }
  return { result, rows, fail: () => { failure = new Error('disk unavailable') }, writes: () => writes }
}

async function fixture(version = 'v0.2.0'): Promise<WorkspaceState> {
  const stored = JSON.parse(await readFile(new URL(`./fixtures/${version}/agent-workspace.json`, import.meta.url), 'utf8'))
  return workspaceStateSchema.parse(stored.tables.workspaces.local)
}

function record(aggregate: WorkspaceState, label = '组织'): WorkspaceRecordV1 {
  return { recordVersion: 1, descriptor: { id: aggregate.workspaceId, label, lifecycle: 'active' }, aggregate }
}

describe('workspace directory', () => {
  test.each(['toString', 'constructor', 'hasOwnProperty'])('rejects inherited agent referent %s on initialization', async agentId => {
    const aggregate = { ...createInitialState(WorkspaceId('local')), sessionBindings: { [agentId]: SessionId('orphan-session') } }
    const storage = table([[aggregate.workspaceId, aggregate]])
    await expect(new WorkspaceDirectory(storage.result).initialize()).rejects.toThrow(/missing agent/i)
    expect(storage.writes()).toBe(0)
  })

  test.each(['v0.1.0', 'v0.2.0'])('wraps the %s local aggregate once without fabricating creation time or business events', async version => {
    const legacy = await fixture(version)
    const storage = table([[legacy.workspaceId, legacy]])
    const directory = new WorkspaceDirectory(storage.result)
    await directory.initialize()
    await directory.initialize()
    expect(directory.record(legacy.workspaceId)).toEqual({ ...record(legacy, 'Local organization'), recordVersion: 2, workflow: createInitialWorkflowState() })
    expect(storage.writes()).toBe(1)
    expect(directory.list()).toEqual([{ descriptor: { id: 'local', label: 'Local organization', lifecycle: 'active' }, revision: legacy.revision, eventCount: legacy.events.length, agentCount: Object.keys(legacy.agents).length }])
  })

  test('creates local only for an empty directory and keeps an existing record without local', async () => {
    const empty = table(); const directory = new WorkspaceDirectory(empty.result); await directory.initialize()
    expect(directory.snapshot(WorkspaceId('local'))).toEqual(createInitialState(WorkspaceId('local')))
    const other = record(createInitialState(WorkspaceId('org-one')))
    const existing = table([[other.descriptor.id, other]]); const second = new WorkspaceDirectory(existing.result); await second.initialize()
    expect(second.list()).toHaveLength(1); expect(existing.rows.has(WorkspaceId('local'))).toBe(false)
  })

  test('validates the whole directory before wrapping legacy local', async () => {
    const local = createInitialState(WorkspaceId('local'))
    const other = record(createInitialState(WorkspaceId('org-one')))
    const storage = table([[local.workspaceId, local], [WorkspaceId('wrong-key'), other]])
    await expect(new WorkspaceDirectory(storage.result).initialize()).rejects.toThrow()
    expect(storage.writes()).toBe(0); expect(storage.rows.get(local.workspaceId)).toEqual(local)
  })

  test('rejects duplicate operation identifiers before any migration write', async () => {
    const creation = { kind: 'created' as const, createdAt: exportedAt, operationId: WorkspaceOperationId('op-one'), requestDigest: 'a'.repeat(64) }
    const first = record(createInitialState(WorkspaceId('org-one'))); const second = record(createInitialState(WorkspaceId('org-two')))
    const storage = table([[WorkspaceId('local'), createInitialState(WorkspaceId('local'))], [first.descriptor.id, { ...first, descriptor: { ...first.descriptor, creation } }], [second.descriptor.id, { ...second, descriptor: { ...second.descriptor, creation } }]])
    await expect(new WorkspaceDirectory(storage.result).initialize()).rejects.toThrow(/operation/i)
    expect(storage.writes()).toBe(0)
  })

  test('rejects cross-workspace sessions on initialization and aggregate updates', async () => {
    const legacy = await fixture()
    const [agentId] = Object.keys(legacy.agents)
    const first = record({ ...legacy, sessionBindings: { [agentId!]: SessionId('same-session') } })
    const imported = { ...legacy, workspaceId: WorkspaceId('org-two'), sessionBindings: {} }
    imported.events = imported.events.map(event => 'messageId' in event ? { ...event, messageId: `agent-workspace-task:org-two:${event.taskDeliveryAttemptId}` as typeof event.messageId } : event)
    const second = record(imported)
    const storage = table([[first.descriptor.id, first], [second.descriptor.id, second]])
    const directory = new WorkspaceDirectory(storage.result); await directory.initialize()
    await expect(directory.updateAggregate(second.descriptor.id, state => ({ ...state, sessionBindings: first.aggregate.sessionBindings }))).rejects.toThrow(/session/i)
    storage.rows.set(second.descriptor.id, record({ ...imported, sessionBindings: first.aggregate.sessionBindings }))
    expect(() => directory.snapshot(first.descriptor.id)).toThrow(/session/i)
    await expect(new WorkspaceDirectory(storage.result).initialize()).rejects.toThrow(/session/i)
  })

  test('serializes concurrent creates, deduplicates operation retries and rejects changed requests', async () => {
    const storage = table(); const directory = new WorkspaceDirectory(storage.result); await directory.initialize()
    const operationId = WorkspaceOperationId('create-one')
    const [first, second, third] = await Promise.all([directory.create({ operationId, label: '组织一' }), directory.create({ operationId, label: '组织一' }), directory.create({ operationId: WorkspaceOperationId('create-two'), label: '组织二' })])
    expect(first).toEqual(second); expect(first.descriptor.id).toMatch(/^org-[0-9a-f-]{36}$/u); expect(third.descriptor.id).not.toBe(first.descriptor.id)
    expect(first.descriptor.creation).toMatchObject({ kind: 'created', operationId }); expect(directory.list()).toHaveLength(3)
    await expect(directory.create({ operationId, label: 'changed' })).rejects.toThrow(/operation/i)
    const restarted = new WorkspaceDirectory(storage.result); await restarted.initialize()
    expect(await restarted.create({ operationId, label: '组织一' })).toEqual(first)
  })

  test('keeps the queue usable after a failed insert and preserves metadata on aggregate updates', async () => {
    const storage = table(); const directory = new WorkspaceDirectory(storage.result); await directory.initialize()
    storage.fail()
    const failed = directory.create({ operationId: WorkspaceOperationId('retry'), label: 'Retry' })
    const later = directory.create({ operationId: WorkspaceOperationId('later'), label: 'Later' })
    await expect(failed).rejects.toThrow('disk unavailable'); const created = await later
    const before = structuredClone(created.descriptor)
    const updated = await directory.updateAggregate(created.descriptor.id, state => mutateWorkspace(state, { type: 'definition/create', name: 'Worker', description: '', instructions: '' }).state)
    expect(directory.record(created.descriptor.id).descriptor).toEqual(before)
    expect(await directory.create({ operationId: WorkspaceOperationId('retry'), label: 'Retry' })).toMatchObject({ descriptor: { label: 'Retry' } })
    await expect(directory.updateAggregate(created.descriptor.id, state => ({ ...state, nextId: 1 }))).rejects.toThrow()
    expect(directory.snapshot(created.descriptor.id)).toEqual(updated)
  })

  test('changes label and lifecycle without altering the aggregate, and detaches all returned data', async () => {
    const storage = table(); const directory = new WorkspaceDirectory(storage.result); await directory.initialize()
    const id = WorkspaceId('local'); const before = directory.snapshot(id)
    await directory.rename(id, 'Renamed'); await directory.setLifecycle(id, 'archived')
    expect(directory.snapshot(id)).toEqual(before)
    const copy = directory.record(id); copy.descriptor.label = 'external mutation'; copy.aggregate.revision = 100
    const listing = directory.list(); listing[0]!.descriptor.label = 'another mutation'
    expect(directory.record(id).descriptor).toEqual({ id, label: 'Renamed', lifecycle: 'archived' })
    expect(directory.snapshot(id)).toEqual(before)
    await expect(directory.rename(id, ' ')).rejects.toThrow()
  })

  test('imports v1 and v2 with new identity, empty sessions and durable operation retries', async () => {
    const source = await fixture()
    const storage = table(); const directory = new WorkspaceDirectory(storage.result); await directory.initialize()
    const json = createForwardWorkspaceExportV1(source, { exportedAt }).json
    const options = { operationId: WorkspaceOperationId('import-one'), json, limits }
    const imported = await directory.import(options)
    expect(imported.aggregate.sessionBindings).toEqual({}); expect(imported.aggregate.workspaceId).not.toBe(source.workspaceId)
    expect(await directory.import(options)).toEqual(imported)
    await expect(directory.import({ ...options, label: 'changed' })).rejects.toThrow(/operation/i)
    await expect(directory.import({ ...options, json: `${json} ` })).rejects.toThrow(/operation/i)
    const copy = await directory.import({ operationId: WorkspaceOperationId('copy'), json: createWorkspaceExportV2(record(imported.aggregate, imported.descriptor.label), { exportedAt }).json, limits })
    expect(copy.descriptor.id).not.toBe(imported.descriptor.id); expect(copy.aggregate.definitions).toEqual(imported.aggregate.definitions)
    await expect(directory.create({ operationId: options.operationId, label: 'Local workspace' })).rejects.toThrow(/operation/i)
  })

  test('rejects oversized import JSON before reading metadata for request canonicalization', async () => {
    const storage = table(); const directory = new WorkspaceDirectory(storage.result); await directory.initialize()
    const request = {
      operationId: WorkspaceOperationId('too-large'), json: 'x'.repeat(2048), limits: { ...limits, maxBytes: 1 },
      get label(): string { throw new Error('request metadata read before byte limit') },
    }
    await expect(directory.import(request)).rejects.toThrow(/maxBytes/i)
    expect(storage.writes()).toBe(1)
  })
})
