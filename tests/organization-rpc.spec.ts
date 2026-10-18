import { describe, expect, test, vi } from 'vitest'
import { createOrganizationRpcHandler } from '../packages/host/src/organization-rpc.ts'
import type { OrganizationRpcService } from '../packages/host/src/organization-rpc.ts'
import type { WorkspaceRpcService } from '../packages/host/src/rpc.ts'
import { WorkspaceId } from '../packages/host/src/ids.ts'
import { createInitialState } from '../packages/host/src/state.ts'
import type { WorkspaceOperationId, WorkspaceRecordV3 } from '../packages/host/src/workspace-record.ts'
import { createInitialCommunicationState } from '../packages/host/src/communication.ts'
import { createInitialWorkflowState } from '../packages/host/src/workflow.ts'

function record(label = '公司甲'): WorkspaceRecordV3 {
  const id = WorkspaceId('org-a')
  return { recordVersion: 3, descriptor: { id, label, lifecycle: 'active' }, aggregate: createInitialState(id), workflow: createInitialWorkflowState(), communication: createInitialCommunicationState() }
}

function fixture() {
  const scoped = vi.fn((id: string) => {
    if (id !== 'org-a' && id !== 'org-b') throw new Error('missing organization')
    return { snapshot: () => createInitialState(WorkspaceId(id)) } as WorkspaceRpcService
  })
  const list = vi.fn(() => [])
  const create = vi.fn(async (_operationId: WorkspaceOperationId, label: string) => record(label))
  const preview = vi.fn((_json: string) => ({
    operationId: 'request-2' as WorkspaceOperationId, sourceWorkspaceId: WorkspaceId('source'), sourcePluginVersion: '0.4.0',
    exportedAt: '2026-10-10T00:00:00.000Z', label: '恢复', lifecycle: 'active' as const,
    eventCount: 0, agentCount: 0, taskCount: 0, sessionBindingsExcluded: true as const,
  }))
  const restore = vi.fn(async (_operationId: WorkspaceOperationId, _json: string, label: string) => record(label))
  const service = {
    forWorkspace: scoped, listOrganizations: list, createOrganization: create,
    previewImport: preview, importOrganization: restore,
    renameOrganization: vi.fn(async () => record()), archiveOrganization: vi.fn(async () => record()),
    reopenOrganization: vi.fn(async () => record()), exportOrganization: vi.fn(async () => ({ json: '{}', document: {} })),
  } satisfies OrganizationRpcService
  const handler = createOrganizationRpcHandler(service)
  const call = (endpoint: string, payload: unknown) => handler(endpoint, payload, new AbortController().signal)
  return { service, call }
}

describe('organization RPC routing', () => {
  test('requires an explicit organization for existing workspace endpoints', async () => {
    const { service, call } = fixture()
    expect((await call('snapshot', {})).ok).toBe(false)
    expect((await call('snapshot', { workspaceId: 'missing' })).ok).toBe(false)
    expect(service.forWorkspace).toHaveBeenCalledTimes(1)
    expect(await call('snapshot', { workspaceId: 'org-b' })).toEqual({ ok: true, value: createInitialState(WorkspaceId('org-b')) })
    expect(service.forWorkspace).toHaveBeenLastCalledWith('org-b')
  })

  test('lists the directory without selecting or fabricating local', async () => {
    const { service, call } = fixture()
    expect(await call('organization/list', {})).toEqual({ ok: true, value: [] })
    expect(service.forWorkspace).not.toHaveBeenCalled()
    expect((await call('organization/list', { workspaceId: 'local' })).ok).toBe(false)
  })

  test('rejects malformed organization identities before selecting a runtime', async () => {
    const { service, call } = fixture()
    for (const workspaceId of ['', 'org a', 'org:a', 'org\u0000a', '\ud800', '\udc00']) {
      expect((await call('snapshot', { workspaceId })).ok).toBe(false)
    }
    expect(service.forWorkspace).not.toHaveBeenCalled()
  })

  test('requires create operation identity and rejects client-owned actor fields', async () => {
    const { service, call } = fixture()
    expect(await call('organization/create', { operationId: 'request-1', label: '公司甲' })).toEqual({ ok: true, value: record().descriptor })
    expect(service.createOrganization).toHaveBeenCalledWith('request-1', '公司甲', expect.any(AbortSignal))
    expect((await call('organization/create', { label: '公司甲' })).ok).toBe(false)
    expect((await call('organization/create', { operationId: 'request-1', label: '公司甲', actor: 'human' })).ok).toBe(false)
    expect(service.createOrganization).toHaveBeenCalledTimes(1)
  })

  test('preview is read-only and import requires explicit human confirmation', async () => {
    const { service, call } = fixture()
    await call('organization/import-preview', { json: '{}' })
    expect(service.previewImport).toHaveBeenCalledWith('{}')
    expect(service.importOrganization).not.toHaveBeenCalled()
    for (const confirmed of [false, undefined]) {
      expect((await call('organization/import-confirm', { operationId: 'request-2', json: '{}', label: '恢复', confirmed })).ok).toBe(false)
    }
    expect(await call('organization/import-confirm', { operationId: 'request-2', json: '{}', label: '恢复', confirmed: true }))
      .toEqual({ ok: true, value: record('恢复').descriptor })
    expect(service.importOrganization).toHaveBeenCalledWith('request-2', '{}', '恢复', expect.any(AbortSignal))
    expect(service.importOrganization).toHaveBeenCalledTimes(1)
  })

  test('requires an explicit archive mode and confirmation before exporting sensitive history', async () => {
    const { service, call } = fixture()
    expect((await call('organization/archive', { workspaceId: 'org-a' })).ok).toBe(false)
    await call('organization/archive', { workspaceId: 'org-a', mode: 'wait' })
    expect(service.archiveOrganization).toHaveBeenCalledWith('org-a', 'wait', expect.any(AbortSignal))
    expect((await call('organization/export', { workspaceId: 'org-a' })).ok).toBe(false)
    await call('organization/export', { workspaceId: 'org-a', confirmed: true })
    expect(service.exportOrganization).toHaveBeenCalledWith('org-a', expect.any(AbortSignal))
  })

  test('honors cancellation before any directory mutation and keeps errors body-free', async () => {
    const { service } = fixture()
    const handler = createOrganizationRpcHandler(service)
    const abort = new AbortController()
    abort.abort()
    expect((await handler('organization/create', { operationId: 'r', label: 'secret' }, abort.signal)).ok).toBe(false)
    expect(service.createOrganization).not.toHaveBeenCalled()
    service.previewImport.mockImplementation(() => { throw new Error('private body') })
    const result = await handler('organization/import-preview', { json: 'private body' }, new AbortController().signal)
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('private body')
  })

  test('passes cancellation to a queued directory mutation before it commits', async () => {
    const { service } = fixture()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let mutated = false
    service.createOrganization.mockImplementation(async (_operationId, label, signal?: AbortSignal) => {
      entered.resolve()
      await release.promise
      signal?.throwIfAborted()
      mutated = true
      return record(label)
    })
    const abort = new AbortController()
    const pending = createOrganizationRpcHandler(service)('organization/create', { operationId: 'queued', label: 'new' }, abort.signal)
    await entered.promise
    abort.abort()
    release.resolve()
    const result = await pending
    expect(result).toMatchObject({ ok: false, error: { kind: 'cancelled' } })
    expect(mutated).toBe(false)
  })
})
