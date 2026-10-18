// @vitest-environment jsdom
import { act, createElement, useMemo, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceApiClient } from '../packages/web/src/client/api.ts'
import { createWorkspaceUiStore, type WorkspaceUiState } from '../packages/web/src/client/store.ts'
import type { WorkspaceDescriptor, WorkspaceDirectoryEntry, WorkspaceSnapshot } from '../packages/web/src/client/contracts.ts'
import { en, zh } from '../packages/web/src/client/locales.ts'
import { createInitialCommunicationState } from '../packages/host/src/communication.ts'
import { createInitialWorkflowState } from '../packages/host/src/workflow.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ MarkdownText: ({ text }: { text: string }) => text, DisclosureRow: ({ title, children }: { title: string; children: never }) => createElement('section', null, title, children) }))
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
const mounted: { root: Root; container: HTMLDivElement }[] = []
afterEach(async () => {
  for (const item of mounted.splice(0)) await act(async () => { item.root.unmount(); item.container.remove() })
  vi.restoreAllMocks()
})
function descriptor(id: string, lifecycle: WorkspaceDescriptor['lifecycle'] = 'active'): WorkspaceDescriptor { return { id, label: id.toUpperCase(), lifecycle } }
function entry(value: WorkspaceDescriptor): WorkspaceDirectoryEntry { return { descriptor: value, revision: 1, agentCount: 0, eventCount: 0 } }
function snapshot(workspaceId: string): WorkspaceSnapshot {
  return { workspaceId, revision: workspaceId === 'alpha' ? 100 : 1, nextId: 1, nextSequence: 1, definitions: {}, definitionRevisions: {}, agents: {}, rooms: { same: { id: 'same', kind: 'group', name: workspaceId.toUpperCase() } }, memberships: {}, events: [], memoryEntries: [], tasks: {}, taskAssignments: {}, delegationGrants: {}, childRuns: {}, sessionBindings: {} }
}
function deferred<Value>() { let resolve!: (value: Value) => void; const promise = new Promise<Value>(accept => { resolve = accept }); return { promise, resolve } }
async function mount(initial = [entry(descriptor('alpha')), entry(descriptor('beta'))], dictionary: Readonly<Record<string, string>> = en, override?: (endpoint: string, payload: Record<string, unknown>) => unknown) {
  const loaded = await import('../packages/web/src/client/WorkspaceOrganizations.tsx').catch(() => ({ WorkspaceOrganizations: undefined }))
  expect(loaded.WorkspaceOrganizations).toBeTypeOf('function')
  if (loaded.WorkspaceOrganizations === undefined) throw new Error('organization shell missing')
  const Shell = loaded.WorkspaceOrganizations
  let directory = initial
  const calls: { endpoint: string; payload: Record<string, unknown>; signal?: AbortSignal }[] = []
  const signals: AbortSignal[] = []
  const api = new WorkspaceApiClient({ rpc: { call: async (_channel: string, endpoint: string, value: unknown, signal?: AbortSignal) => {
    const payload = value as Record<string, unknown>
    calls.push({ endpoint, payload, ...(signal === undefined ? {} : { signal }) })
    const replacement = override?.(endpoint, payload)
    if (replacement !== undefined) return { ok: true, value: await replacement }
    const workspaceId = String(payload['workspaceId'])
    switch (endpoint) {
      case 'organization/list': return { ok: true, value: directory }
      case 'organization/create': { const created = { ...descriptor('created'), label: String(payload['label']) }; directory = [...directory, entry(created)]; return { ok: true, value: created } }
      case 'organization/rename': case 'organization/archive': case 'organization/reopen': {
        const old = directory.find(item => item.descriptor.id === workspaceId)!.descriptor
        const updated = { ...old, ...(endpoint.endsWith('rename') ? { label: String(payload['label']) } : { lifecycle: endpoint.endsWith('archive') ? 'archived' : 'active' }) }
        directory = directory.map(item => item.descriptor.id === workspaceId ? entry(updated as WorkspaceDescriptor) : item)
        return { ok: true, value: updated }
      }
      case 'organization/export': return { ok: true, value: { json: '{"portable":true}', document: { portable: true } } }
      case 'organization/import-preview': return { ok: true, value: { operationId: '1f3d3231-8b51-409c-960d-2275deed056b', sourceWorkspaceId: 'source', sourcePluginVersion: '0.1.0', exportedAt: '2026-10-10T00:00:00.000Z', label: 'Portable', lifecycle: 'active', eventCount: 12, agentCount: 2, taskCount: 3, sessionBindingsExcluded: true } }
      case 'organization/import-confirm': { const imported = { ...descriptor('imported'), label: String(payload['label']) }; directory = [...directory, entry(imported)]; return { ok: true, value: imported } }
      case 'snapshot': return { ok: true, value: snapshot(workspaceId) }
      case 'communication/snapshot': return { ok: true, value: { workspaceId, aggregateRevision: snapshot(workspaceId).revision, workflowRevision: 0, communication: createInitialCommunicationState() } }
      case 'workflow/snapshot': return { ok: true, value: { workspaceId, aggregateRevision: snapshot(workspaceId).revision, workflow: createInitialWorkflowState() } }
      case 'runtime/activity/snapshot': return { ok: true, value: { version: 0, workspaceRevision: snapshot(workspaceId).revision, agents: [], activities: [] } }
      case 'runtime/activity/wait': {
        if (signal !== undefined) signals.push(signal)
        return await new Promise(resolve => signal?.addEventListener('abort', () => resolve({ ok: false, error: { kind: 'cancelled', code: 'cancelled', message: 'cancelled', details: {} } }), { once: true }))
      }
      default: throw new Error(`unexpected endpoint ${endpoint}`)
    }
  } } } as never)
  const handle = createWorkspaceUiStore() as { definition: { init(): WorkspaceUiState; actions: Record<string, (draft: WorkspaceUiState, ...args: never[]) => void> } }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); mounted.push({ root, container })
  const states: WorkspaceUiState[] = []
  let reopen = (): void => { throw new Error('organization shell has not mounted') }
  function Harness() {
    const [state, setState] = useState<WorkspaceUiState>({ ...handle.definition.init(), open: true })
    states.push(state)
    reopen = () => setState(current => ({ ...current, open: true }))
    const actions = useMemo(() => Object.fromEntries(Object.entries(handle.definition.actions).map(([key, action]) => [key, (...args: never[]) => setState(current => { const next = { ...current }; action(next, ...args); return next })])), [])
    return createElement(Shell, { api, useStore: (selector: (state: WorkspaceUiState) => unknown) => selector(state), actions, t: (key: string, params?: Record<string, string | number>) => Object.entries(params ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), dictionary[key] ?? key) } as never)
  }
  await act(async () => root.render(createElement(Harness)))
  return { container, calls, signals, states, open: async (): Promise<void> => { await act(async () => reopen()) } }
}
function button(container: HTMLElement, name: string) { const value = [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === name || item.getAttribute('aria-label') === name); if (value === undefined) throw new Error(`button missing: ${name}`); return value }
function field(container: HTMLElement, name: string) { const value = [...container.querySelectorAll('input,select')].find(item => item.getAttribute('aria-label') === name); if (!(value instanceof HTMLInputElement) && !(value instanceof HTMLSelectElement)) throw new Error(`field missing: ${name}`); return value }
async function click(container: HTMLElement, name: string) { await act(async () => button(container, name).click()) }
async function change(control: HTMLInputElement | HTMLSelectElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(control instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype, 'value')!.set!.call(control, value); control.dispatchEvent(new Event('input', { bubbles: true })); control.dispatchEvent(new Event('change', { bubbles: true })) }) }
async function chooseFile(container: HTMLElement, content = '{}') { const input = field(container, 'Import organization'); const file = new File([content], 'organization.json', { type: 'application/json' }); Object.defineProperty(file, 'text', { value: async () => content }); Object.defineProperty(input, 'files', { configurable: true, value: [file] }); await act(async () => input.dispatchEvent(new Event('change', { bubbles: true }))) }

describe('organization shell real DOM', () => {
  it('keeps management collapsed while organization selection stays available', async () => {
    const { container, calls } = await mount()
    const management = container.querySelector('details.dsh-agent-group-organization-management')
    expect(management).toBeInstanceOf(HTMLDetailsElement)
    expect(management?.hasAttribute('open')).toBe(false)
    expect(field(container, 'Organization').closest('details')).toBeNull()
    const writesBefore = calls.filter(call => /organization\/(create|rename|archive|reopen|export|import)/u.test(call.endpoint)).length
    await act(async () => management!.querySelector('summary')!.click())
    expect(management?.hasAttribute('open')).toBe(true)
    expect(field(container, 'Organization label').closest('details')).toBe(management)
    expect(calls.filter(call => /organization\/(create|rename|archive|reopen|export|import)/u.test(call.endpoint))).toHaveLength(writesBefore)
  })

  it('opens management for an empty directory without creating an organization', async () => {
    const { container, calls } = await mount([])
    const management = container.querySelector('details.dsh-agent-group-organization-management')
    expect(management?.hasAttribute('open')).toBe(true)
    expect(button(container, 'Create organization').disabled).toBe(true)
    expect(calls.some(call => call.endpoint === 'organization/create')).toBe(false)
  })

  it('closes management so the export confirmation is not covered by the popup', async () => {
    const { container } = await mount()
    const management = container.querySelector('details.dsh-agent-group-organization-management')!
    await act(async () => management.querySelector('summary')!.click())
    await click(container, 'Export organization')
    expect(management.hasAttribute('open')).toBe(false)
    expect(button(container, 'Confirm export and download')).toBeInstanceOf(HTMLButtonElement)
  })

  it('closes management when a validated import preview appears', async () => {
    const { container } = await mount()
    const management = container.querySelector('details.dsh-agent-group-organization-management')!
    await act(async () => management.querySelector('summary')!.click())
    await chooseFile(container)
    expect(management.hasAttribute('open')).toBe(false)
    expect(field(container, 'Imported organization label').value).toBe('Portable')
  })

  it('selects the first directory organization explicitly and switches equal entity ids without retaining drafts', async () => {
    const { container, calls, signals, states } = await mount()
    expect(calls.filter(call => call.endpoint === 'snapshot').every(call => call.payload['workspaceId'] === 'alpha')).toBe(true)
    const draft = container.querySelector('textarea')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(draft, 'alpha private draft'); draft.dispatchEvent(new Event('input', { bubbles: true })) })
    await change(field(container, 'Organization'), 'beta')
    expect(signals[0]?.aborted).toBe(true)
    expect(container.querySelector('textarea')?.value).toBe('')
    expect(states.at(-1)?.snapshot?.workspaceId).toBe('beta')
    expect(states.at(-1)?.snapshot?.revision).toBe(1)
  })
  it('creates from an empty directory and renames the explicit organization', async () => {
    const { container, calls } = await mount([])
    expect(calls.some(call => call.endpoint === 'snapshot')).toBe(false)
    await change(field(container, 'Organization label'), 'New group')
    await click(container, 'Create organization')
    expect(calls.find(call => call.endpoint === 'organization/create')?.payload).toMatchObject({ label: 'New group', operationId: expect.any(String) })
    await change(field(container, 'Organization label'), 'Renamed group')
    await click(container, 'Rename organization')
    expect(calls.find(call => call.endpoint === 'organization/rename')?.payload).toEqual({ workspaceId: 'created', label: 'Renamed group' })
  })
  it.each(['stop', 'wait'] as const)('archives with %s and reopens while preserving readable history', async mode => {
    const { container, calls } = await mount()
    await change(field(container, 'Archive running work'), mode)
    await click(container, 'Archive organization')
    expect(calls.find(call => call.endpoint === 'organization/archive')?.payload).toEqual({ workspaceId: 'alpha', mode })
    expect(container.textContent).toContain('Archived organization — read-only')
    expect(button(container, 'New group').disabled).toBe(true)
    await click(container, 'Memory')
    expect(container.textContent).toContain('No agents are available to inspect.')
    await click(container, 'Reopen organization')
    expect(container.textContent).not.toContain('Archived organization — read-only')
  })
  it('requires export warning confirmation before creating a portable download', async () => {
    const createObjectURL = vi.fn(() => 'blob:portable'); const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL }); Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const { container, calls } = await mount()
    await click(container, 'Export organization')
    expect(calls.some(call => call.endpoint === 'organization/export')).toBe(false)
    expect(container.textContent).toContain('messages, instructions and memory')
    await click(container, 'Confirm export and download')
    expect(calls.find(call => call.endpoint === 'organization/export')?.payload).toEqual({ workspaceId: 'alpha', confirmed: true })
    expect(createObjectURL).toHaveBeenCalledOnce(); expect(anchorClick).toHaveBeenCalledOnce(); expect(revokeObjectURL).toHaveBeenCalledWith('blob:portable')
  })
  it('previews a selected file and confirms a new organization without replacing the current selection', async () => {
    const { container, calls, states } = await mount()
    await chooseFile(container)
    expect(calls.some(call => call.endpoint === 'organization/import-confirm')).toBe(false)
    expect(container.textContent).toContain('0.1.0'); expect(container.textContent).toContain('12 events'); expect(container.textContent).toContain('Session bindings are excluded')
    await change(field(container, 'Imported organization label'), 'Restored group')
    await click(container, 'Confirm import as a new organization')
    expect(calls.find(call => call.endpoint === 'organization/import-confirm')?.payload).toMatchObject({ json: '{}', label: 'Restored group', confirmed: true })
    expect(states.at(-1)?.selectedWorkspaceId).toBe('alpha')
    expect(container.textContent).toContain('Restored group')
  })
  it('ignores a late old-organization snapshot after switching', async () => {
    const old = deferred<WorkspaceSnapshot>()
    const { container, states } = await mount(undefined, en, (endpoint, payload) => endpoint === 'snapshot' && payload['workspaceId'] === 'alpha' ? old.promise : undefined)
    await change(field(container, 'Organization'), 'beta')
    await act(async () => old.resolve(snapshot('alpha')))
    expect(states.at(-1)?.snapshot?.workspaceId).toBe('beta')
    expect(container.textContent).not.toContain('alpha private draft')
  })
  it('localizes directory actions and archive status in Chinese', async () => {
    const { container } = await mount([entry(descriptor('alpha', 'archived'))], zh)
    expect(container.textContent).toContain('已归档组织，仅可查看')
    expect(button(container, '重新打开组织')).toBeDefined()
    expect(container.textContent).not.toContain('Reopen organization')
  })
  it('disables archived task and revision mutations while rendering their historical records', async () => {
    const state = { ...snapshot('alpha'), definitions: { role: { id: 'role', name: 'Engineer', revisionIds: ['rev'], currentRevisionId: 'rev' } }, definitionRevisions: { rev: { id: 'rev', definitionId: 'role', number: 1, description: 'Stored role', instructions: 'Stored instructions' } }, tasks: { task: { id: 'task', rootTaskId: 'task', title: 'Historical task', status: 'open' } } }
    const history = [{ ...state.definitionRevisions.rev, creationEvent: { status: 'exact', sequence: 1 }, status: 'current', agentIds: [] }]
    const { container, calls } = await mount([entry(descriptor('alpha', 'archived'))], en, endpoint => endpoint === 'snapshot' ? state : endpoint === 'definition/history' ? history : undefined)
    await click(container, 'Tasks')
    expect(container.textContent).toContain('Historical task')
    expect(button(container, 'Cancel task').disabled).toBe(true)
    await click(container, 'Colleagues')
    expect(container.textContent).toContain('Stored role')
    expect(button(container, 'Save new revision').disabled).toBe(true)
    expect(button(container, 'Synchronize this revision').disabled).toBe(true)
    expect(calls.some(call => call.endpoint === 'task/cancel' || call.endpoint === 'definition/revise')).toBe(false)
  })
  it('does not adopt an old mutation when switching away and back to the same organization', async () => {
    const commit = deferred<unknown>()
    const { container, states } = await mount(undefined, en, endpoint => endpoint === 'room/create' ? commit.promise : undefined)
    await click(container, 'New group')
    await change(container.querySelector<HTMLInputElement>('input[placeholder="Group name"]')!, 'Old group request')
    await click(container, 'Create')
    await change(field(container, 'Organization'), 'beta')
    await change(field(container, 'Organization'), 'alpha')
    await act(async () => commit.resolve({ revision: 101, value: { ...snapshot('alpha'), revision: 101, rooms: { leaked: { id: 'leaked', kind: 'group', name: 'Leaked old operation' } } } }))
    expect(states.at(-1)?.snapshot?.revision).toBe(100)
    expect(container.textContent).not.toContain('Leaked old operation')
  })
  it.each(['embedded-close', 'escape'] as const)('clears pending directory work after %s and reopening', async closePath => {
    const creation = deferred<WorkspaceDescriptor>()
    const view = await mount(undefined, en, endpoint => endpoint === 'organization/create' ? creation.promise : undefined)
    await change(field(view.container, 'Organization label'), 'Pending creation')
    await click(view.container, 'Create organization')
    expect(button(view.container, 'Create organization').disabled).toBe(true)
    const createSignal = view.calls.find(call => call.endpoint === 'organization/create')?.signal
    await act(async () => {
      if (closePath === 'escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      else view.container.querySelector<HTMLButtonElement>('.dsh-agent-group-organization-workspace button[aria-label="Close"]')!.click()
    })
    expect(createSignal?.aborted).toBe(true)
    expect(view.container.textContent).toBe('')
    await view.open()
    await change(field(view.container, 'Organization label'), 'After reopening')
    expect(button(view.container, 'Rename organization').disabled).toBe(false)
    expect(field(view.container, 'Import organization').disabled).toBe(false)
    await click(view.container, 'Rename organization')
    expect(view.calls.find(call => call.endpoint === 'organization/rename')?.payload).toEqual({ workspaceId: 'alpha', label: 'After reopening' })
    await act(async () => creation.resolve(descriptor('created')))
    expect(view.states.at(-1)?.selectedWorkspaceId).toBe('alpha')
    expect(view.container.textContent).toContain('After reopening')
  })
  it('keeps the created directory when the older initial empty list arrives late', async () => {
    const initialDirectory = deferred<readonly WorkspaceDirectoryEntry[]>()
    let reads = 0
    const view = await mount([], en, endpoint => endpoint === 'organization/list' && reads++ === 0 ? initialDirectory.promise : undefined)
    await change(field(view.container, 'Organization label'), 'New organization')
    await click(view.container, 'Create organization')
    expect(view.states.at(-1)?.selectedWorkspaceId).toBe('created')
    expect(field(view.container, 'Organization').querySelectorAll('option')).toHaveLength(1)
    await act(async () => initialDirectory.resolve([]))
    expect(field(view.container, 'Organization').querySelectorAll('option')).toHaveLength(1)
    expect(field(view.container, 'Organization').value).toBe('created')
    expect(view.states.at(-1)?.snapshot?.workspaceId).toBe('created')
  })
})
