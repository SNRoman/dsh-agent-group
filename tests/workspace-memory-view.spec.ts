// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceApiError } from '../packages/web/src/client/api.ts'
import type { WorkspaceApiClient } from '../packages/web/src/client/api.ts'
import type { MemoryPage, WorkspaceSnapshot } from '../packages/web/src/client/contracts.ts'
import { en, zh } from '../packages/web/src/client/locales.ts'
import { WorkspaceMemory } from '../packages/web/src/client/WorkspaceMemory.tsx'

type Dictionary = Readonly<Record<string, string>>
const mounted: Array<{ readonly root: Root; readonly container: HTMLDivElement }> = []
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })

afterEach(async () => {
  for (const item of mounted.splice(0)) await act(async () => { item.root.unmount(); item.container.remove() })
  vi.restoreAllMocks()
})

function snapshot(revision = 12): WorkspaceSnapshot {
  return {
    workspaceId: 'workspace', revision, nextId: 40, nextSequence: 40,
    definitions: { role: { id: 'role', name: 'Engineer', revisionIds: ['rev-1'], currentRevisionId: 'rev-1' } },
    definitionRevisions: { 'rev-1': { id: 'rev-1', definitionId: 'role', number: 1, description: 'Build', instructions: 'Ship' } },
    agents: {
      alice: { id: 'alice', name: 'Alice', definitionId: 'role', definitionRevisionId: 'rev-1', employmentStatus: 'employed', employmentPeriods: [] },
      bob: { id: 'bob', name: 'Bob', definitionId: 'role', definitionRevisionId: 'rev-1', employmentStatus: 'departed', employmentPeriods: [] },
    },
    rooms: { room: { id: 'room', kind: 'group', name: 'Planning' } }, memberships: {}, events: [], memoryEntries: [],
    tasks: { task: { id: 'task', rootTaskId: 'task', title: 'Release', status: 'open' } }, taskAssignments: {}, delegationGrants: {},
    childRuns: { child: { id: 'child', parentAgentId: 'alice', taskId: 'task', status: 'completed', result: 'done' } }, sessionBindings: {},
  }
}

const firstPage: MemoryPage = {
  snapshotRevision: 12,
  items: [{
    eventId: 'event-9', sequence: 9, type: 'child/run-finished', provenance: 'child-result',
    source: { kind: 'child', id: 'child', label: 'Child child', taskId: 'task', taskLabel: 'Release' },
    actor: { type: 'agent', id: 'alice', label: 'Alice' }, subject: { id: 'bob', label: 'Bob' }, text: 'Delivered result',
    childStatus: 'completed', definitionRevision: { status: 'active', id: 'rev-1', number: 1 },
  }],
  nextCursor: 'cursor-9',
}

function translate(dictionary: Dictionary) {
  return (key: string, params?: Readonly<Record<string, string | number>>): string => Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), dictionary[key] ?? key,
  )
}

function api(overrides: Partial<WorkspaceApiClient> = {}): WorkspaceApiClient {
  return {
    queryMemory: vi.fn().mockResolvedValue(firstPage), snapshot: vi.fn().mockResolvedValue(snapshot()), ...overrides,
  } as unknown as WorkspaceApiClient
}

async function mount(client: WorkspaceApiClient, dictionary: Dictionary = en, source = snapshot()) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => { root.render(createElement(WorkspaceMemory, { snapshot: source, api: client, onSnapshot: vi.fn(), t: translate(dictionary) as never })); await Promise.resolve() })
  return container
}

function field(container: HTMLElement, name: string): HTMLInputElement | HTMLSelectElement {
  const item = [...container.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')].find(element => element.getAttribute('aria-label') === name)
  if (item === undefined) throw new Error(`missing field ${name}`)
  return item
}

async function change(element: HTMLInputElement | HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')
    descriptor?.set?.call(element, value)
    element.dispatchEvent(new Event('change', { bubbles: true }))
    element.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve() })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('unified personal memory', () => {
  it.each([[en, 'Departed'], [zh, '已离职']] as const)('selects departed agents and renders the complete read-only timeline in %s', async (dictionary, departed) => {
    const container = await mount(api(), dictionary)
    expect(container.textContent).toContain(departed)
    await change(field(container, translate(dictionary)('memory.agent')), 'bob')
    expect(container.textContent).toContain('9')
    for (const value of ['child/run-finished', translate(dictionary)('memory.provenance.child-result'), 'Child child', 'Alice', 'Bob', 'Delivered result', translate(dictionary)('memory.child.completed'), translate(dictionary)('memory.definitionRevision', { number: 1 })]) {
      expect(container.textContent).toContain(value)
    }
    expect(container.querySelector('[aria-label="Edit memory"]')).toBeNull()
    expect(container.querySelector('[aria-label="Delete memory"]')).toBeNull()
  })

  it('sends every active filter with each page request and couples source ids to their kind', async () => {
    const client = api()
    const container = await mount(client)
    await change(field(container, 'Source kind'), 'task')
    await change(field(container, 'Source'), 'task')
    await change(field(container, 'First provenance'), 'task')
    await click(field(container, 'Event type child/run-finished'))
    await change(field(container, 'Minimum sequence'), '3')
    await change(field(container, 'Maximum sequence'), '20')
    await change(field(container, 'Search memory'), 'RESULT')
    const query = vi.mocked(client.queryMemory).mock.calls.at(-1)?.[0]
    expect(query).toEqual({ agentId: 'alice', sourceKind: 'task', sourceId: 'task', provenance: 'task', eventTypes: ['child/run-finished'], minimumSequence: 3, maximumSequence: 20, text: 'RESULT', limit: 25, snapshotRevision: 12 })
    await change(field(container, 'Source kind'), 'room')
    expect(vi.mocked(client.queryMemory).mock.calls.at(-1)?.[0]).not.toHaveProperty('sourceId')
  })

  it('appends unique server-ordered pages and exposes an end state', async () => {
    const client = api({ queryMemory: vi.fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce({ snapshotRevision: 12, items: [firstPage.items[0], { ...firstPage.items[0], eventId: 'event-8', sequence: 8, text: 'older' }] }) })
    const container = await mount(client)
    await click([...container.querySelectorAll('button')].find(item => item.textContent === 'Load more')!)
    expect(container.textContent?.match(/Delivered result/g)).toHaveLength(1)
    expect(container.textContent).toContain('older')
    expect(container.textContent).toContain('End of memory')
    expect(vi.mocked(client.queryMemory).mock.calls[1]?.[0]).toMatchObject({ cursor: 'cursor-9', snapshotRevision: 12 })
  })

  it('refreshes and restarts from the first page after stale while suppressing a late old request', async () => {
    const old = deferred<MemoryPage>()
    const refreshed = snapshot(13)
    const client = api({
      queryMemory: vi.fn()
        .mockReturnValueOnce(old.promise)
        .mockRejectedValueOnce(new WorkspaceApiError({ kind: 'business', code: 'stale-revision', message: 'stale', details: { expectedRevision: 12, actualRevision: 13 } }))
        .mockResolvedValue({ snapshotRevision: 13, items: [{ ...firstPage.items[0], eventId: 'event-new', sequence: 10, text: 'new revision' }] }),
      snapshot: vi.fn().mockResolvedValue(refreshed),
    })
    const adopted: WorkspaceSnapshot[] = []
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    mounted.push({ root, container })
    const render = (source: WorkspaceSnapshot) => createElement(WorkspaceMemory, { snapshot: source, api: client, onSnapshot: (value: WorkspaceSnapshot) => { adopted.push(value); renderAt(value) }, t: translate(en) as never })
    const renderAt = (source: WorkspaceSnapshot) => root.render(render(source))
    await act(async () => { renderAt(snapshot()); await Promise.resolve() })
    await change(field(container, 'Search memory'), 'new')
    await vi.waitFor(() => expect(adopted).toEqual([refreshed]))
    await vi.waitFor(() => expect(container.textContent).toContain('new revision'))
    await act(async () => old.resolve(firstPage))
    expect(container.textContent).not.toContain('Delivered result')
    expect(vi.mocked(client.queryMemory).mock.calls.at(-1)?.[0]).toMatchObject({ text: 'new', snapshotRevision: 13 })
  })

  it('renders localized loading, empty, safe error, retry and unresolved history states', async () => {
    const wait = deferred<MemoryPage>()
    const client = api({ queryMemory: vi.fn().mockReturnValueOnce(wait.promise).mockRejectedValueOnce(new Error('private')).mockResolvedValueOnce({ snapshotRevision: 12, items: [{ ...firstPage.items[0], definitionRevision: { status: 'unresolved' } }] }) })
    const container = await mount(client)
    expect(container.textContent).toContain('Loading memory')
    await act(async () => wait.resolve({ snapshotRevision: 12, items: [] }))
    expect(container.textContent).toContain('No memory events match these filters.')
    await change(field(container, 'Search memory'), 'x')
    await vi.waitFor(() => expect(container.textContent).toContain('Memory request failed.'))
    await click([...container.querySelectorAll('button')].find(item => item.textContent === 'Retry')!)
    expect(container.textContent).toContain('Historical revision unresolved')
  })
})
