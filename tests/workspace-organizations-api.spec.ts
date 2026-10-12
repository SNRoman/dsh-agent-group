import { describe, expect, it } from 'vitest'
import { WorkspaceApiClient } from '../packages/web/src/client/api.ts'

function snapshot(workspaceId = 'alpha') {
  return { workspaceId, revision: 1, nextId: 1, nextSequence: 1, definitions: {}, definitionRevisions: {}, agents: {}, rooms: {}, memberships: {}, events: [], memoryEntries: [], tasks: {}, taskAssignments: {}, delegationGrants: {}, childRuns: {}, sessionBindings: {} }
}
function fixture(responses: Record<string, unknown>) {
  const calls: { endpoint: string; payload: unknown }[] = []
  const rpc = { call: async (_channel: string, endpoint: string, payload: unknown) => { calls.push({ endpoint, payload }); return { ok: true, value: responses[endpoint] } } }
  return { api: new WorkspaceApiClient({ rpc } as never), calls }
}
const descriptor = { id: 'alpha', label: 'Alpha', lifecycle: 'active' }
const operationId = 'cc63a502-d4a7-4b25-bc49-92bc26ce2a51'

describe('explicit organization Browser scope', () => {
  it('validates renamed snapshots and attaches organization identity and CAS revision', async () => {
    const committed = snapshot()
    const { api, calls } = fixture({ 'room/rename': { revision: 1, value: committed }, 'agent/rename': { revision: 1, value: committed } })
    const scoped = api.forWorkspace('alpha')
    await expect(scoped.renameRoom('room-1', '产品讨论', 0)).resolves.toEqual(committed)
    await expect(scoped.renameAgent('agent-1', '小林', 0)).resolves.toEqual(committed)
    expect(calls).toEqual([
      { endpoint: 'room/rename', payload: { workspaceId: 'alpha', expectedRevision: 0, roomId: 'room-1', name: '产品讨论' } },
      { endpoint: 'agent/rename', payload: { workspaceId: 'alpha', expectedRevision: 0, agentId: 'agent-1', name: '小林' } },
    ])
  })

  it('requires selection before any aggregate request reaches the transport', async () => {
    const { api, calls } = fixture({ snapshot: snapshot() })
    await expect(api.snapshot()).rejects.toThrow('selected organization')
    expect(calls).toEqual([])
  })
  it('keeps scoped clients immutable and attaches scope to all aggregate payloads', async () => {
    const { api, calls } = fixture({ snapshot: snapshot(), 'runtime/status': { rooms: {} }, 'runtime/activity/snapshot': { version: 0, workspaceRevision: 1, activities: [], agents: [] }, 'runtime/activity/wait': { version: 1, workspaceRevision: 1, activities: [], agents: [] }, 'definition/history': [], 'memory/query': { snapshotRevision: 1, items: [] }, 'agent/depart': { revision: 1, value: snapshot() } })
    const scoped = api.forWorkspace('alpha')
    expect(Object.isFrozen(scoped)).toBe(true)
    await scoped.snapshot(); await scoped.runtimeStatus(); await scoped.activitySnapshot(); await scoped.waitForActivity(0)
    await scoped.definitionHistory('definition'); await scoped.queryMemory({ agentId: 'agent', limit: 10, snapshotRevision: 1 })
    await scoped.setEmployment('agent', false, 0)
    expect(calls).toHaveLength(7)
    for (const call of calls) expect(call.payload).toHaveProperty('workspaceId', 'alpha')
    await expect(api.snapshot()).rejects.toThrow('selected organization')
  })
  it('overwrites a supplied scope and rejects snapshots belonging to another organization', async () => {
    const { api, calls } = fixture({ 'agent/depart': { revision: 1, value: snapshot() }, snapshot: snapshot('beta') })
    const scoped = api.forWorkspace('alpha')
    const payload = { agentId: 'agent', workspaceId: 'beta' }
    await scoped.mutate('agent/depart', payload, 0)
    expect(calls[0]?.payload).toEqual({ agentId: 'agent', expectedRevision: 0, workspaceId: 'alpha' })
    await expect(scoped.snapshot()).rejects.toThrow('scope')
  })
  it.each(['', 'white space', 'a:b', 'a\u0000b', 'a\u0085b'])('rejects invalid organization id %j', id => {
    const { api, calls } = fixture({})
    expect(() => api.forWorkspace(id)).toThrow('organization id')
    expect(calls).toEqual([])
  })
})

describe('organization directory read validation', () => {
  it('lists on the root transport and discards validated creation metadata', async () => {
    const creation = { kind: 'created', createdAt: '2026-10-10T00:00:00.000Z', operationId, requestDigest: 'a'.repeat(64) }
    const { api, calls } = fixture({ 'organization/list': [{ descriptor: { ...descriptor, creation }, revision: 1, eventCount: 0, agentCount: 0 }] })
    await expect(api.listOrganizations()).resolves.toEqual([{ descriptor, revision: 1, eventCount: 0, agentCount: 0 }])
    expect(calls).toEqual([{ endpoint: 'organization/list', payload: {} }])
  })
  it.each([
    { descriptor: { ...descriptor, id: 'bad:id' }, revision: 1, eventCount: 0, agentCount: 0 },
    { descriptor: { ...descriptor, lifecycle: 'deleted' }, revision: 1, eventCount: 0, agentCount: 0 },
    { descriptor: { ...descriptor, creation: { kind: 'created' } }, revision: 1, eventCount: 0, agentCount: 0 },
    { descriptor, revision: 1, eventCount: -1, agentCount: 0 },
    { descriptor, revision: 1, eventCount: 0, agentCount: 0, secret: true },
  ])('rejects malformed directory entry %#', async value => {
    const { api } = fixture({ 'organization/list': [value] })
    await expect(api.listOrganizations()).rejects.toThrow('invalid')
  })
  it('sends exact organization-operation fields and validates preview metadata', async () => {
    const preview = { operationId, sourceWorkspaceId: 'source', sourcePluginVersion: '0.1.0', exportedAt: '2026-10-10T00:00:00.000Z', label: 'Imported', lifecycle: 'active', eventCount: 2, agentCount: 1, taskCount: 0, sessionBindingsExcluded: true }
    const { api, calls } = fixture({ 'organization/create': descriptor, 'organization/rename': descriptor, 'organization/archive': { ...descriptor, lifecycle: 'archived' }, 'organization/reopen': descriptor, 'organization/export': { json: '{}', document: {} }, 'organization/import-preview': preview, 'organization/import-confirm': descriptor })
    await api.createOrganization('Alpha', operationId); await api.renameOrganization('alpha', 'Renamed'); await api.archiveOrganization('alpha', 'wait'); await api.reopenOrganization('alpha'); await api.exportOrganization('alpha', true)
    await expect(api.previewImport('{}')).resolves.toEqual(preview)
    await api.confirmImport(operationId, '{}', 'Imported', true)
    expect(calls.map(call => call.payload)).toEqual([{ operationId, label: 'Alpha' }, { workspaceId: 'alpha', label: 'Renamed' }, { workspaceId: 'alpha', mode: 'wait' }, { workspaceId: 'alpha' }, { workspaceId: 'alpha', confirmed: true }, { json: '{}' }, { operationId, json: '{}', label: 'Imported', confirmed: true }])
  })
  it('rejects malformed export and preview metadata', async () => {
    const { api } = fixture({ 'organization/export': { json: '{}', document: {}, extra: true }, 'organization/import-preview': { operationId, sessionBindingsExcluded: false } })
    await expect(api.exportOrganization('alpha', true)).rejects.toThrow('invalid')
    await expect(api.previewImport('{}')).rejects.toThrow('invalid')
  })
  it('rejects an organization-operation response for another identity', async () => {
    const { api } = fixture({ 'organization/rename': { ...descriptor, id: 'beta' }, 'organization/archive': { ...descriptor, id: 'beta', lifecycle: 'archived' }, 'organization/reopen': { ...descriptor, id: 'beta' } })
    await expect(api.renameOrganization('alpha', 'Renamed')).rejects.toThrow('scope')
    await expect(api.archiveOrganization('alpha', 'stop')).rejects.toThrow('scope')
    await expect(api.reopenOrganization('alpha')).rejects.toThrow('scope')
  })
  it('rejects non-UUID create and import operation identities before transport', async () => {
    const { api, calls } = fixture({ 'organization/create': descriptor, 'organization/import-confirm': descriptor })
    await expect(api.createOrganization('Alpha', 'not-a-uuid')).rejects.toThrow('operation id')
    await expect(api.confirmImport('not-a-uuid', '{}', 'Imported', true)).rejects.toThrow('operation id')
    expect(calls).toEqual([])
  })
})
