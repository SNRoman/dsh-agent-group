// @vitest-environment jsdom

import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceApiError } from '../packages/web/src/client/api.ts'
import type { WorkspaceApiClient } from '../packages/web/src/client/api.ts'
import type { DefinitionHistoryItem, WorkspaceSnapshot } from '../packages/web/src/client/contracts.ts'
import { en, zh } from '../packages/web/src/client/locales.ts'
import { WorkspaceDefinitionHistory } from '../packages/web/src/client/WorkspaceDefinitionHistory.tsx'

type Dictionary = Readonly<Record<string, string>>
const mounted: Array<{ readonly root: Root; readonly container: HTMLDivElement }> = []
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
afterEach(async () => { for (const item of mounted.splice(0)) await act(async () => { item.root.unmount(); item.container.remove() }); vi.restoreAllMocks() })

function snapshot(revision = 12): WorkspaceSnapshot {
  return {
    workspaceId: 'workspace', revision, nextId: 30, nextSequence: 30,
    definitions: { role: { id: 'role', name: 'Engineer', revisionIds: ['rev-1', 'rev-2', 'rev-3'], currentRevisionId: 'rev-3' } },
    definitionRevisions: {
      'rev-1': { id: 'rev-1', definitionId: 'role', number: 1, description: 'Old role', instructions: 'Old instructions' },
      'rev-2': { id: 'rev-2', definitionId: 'role', number: 2, description: 'Current role', instructions: 'Current instructions' },
      'rev-3': { id: 'rev-3', definitionId: 'role', number: 3, description: 'Newest role', instructions: 'Newest instructions' },
    },
    agents: {
      alice: { id: 'alice', name: 'Alice', definitionId: 'role', definitionRevisionId: 'rev-3', employmentStatus: 'employed', employmentPeriods: [] },
      bob: { id: 'bob', name: 'Bob', definitionId: 'role', definitionRevisionId: 'rev-1', employmentStatus: 'departed', employmentPeriods: [] },
    }, rooms: {}, memberships: {}, events: [], memoryEntries: [], tasks: {}, taskAssignments: {}, delegationGrants: {}, childRuns: {}, sessionBindings: {},
  }
}

const history: readonly DefinitionHistoryItem[] = [
  { id: 'rev-3', definitionId: 'role', number: 3, description: 'Newest role', instructions: 'Newest instructions', creationEvent: { status: 'exact', sequence: 8 }, status: 'current', agentIds: ['alice'] },
  { id: 'rev-2', definitionId: 'role', number: 2, description: 'Current role', instructions: 'Current instructions', creationEvent: { status: 'derived', sequence: 6 }, status: 'previous', agentIds: [] },
  { id: 'rev-1', definitionId: 'role', number: 1, description: 'Old role', instructions: 'Old instructions', creationEvent: { status: 'unresolved' }, status: 'previous', agentIds: ['bob'] },
]

function translate(dictionary: Dictionary) { return (key: string, params?: Readonly<Record<string, string | number>>): string => Object.entries(params ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), dictionary[key] ?? key) }
function api(overrides: Partial<WorkspaceApiClient> = {}): WorkspaceApiClient {
  return { definitionHistory: vi.fn().mockResolvedValue(history), reviseDefinition: vi.fn().mockResolvedValue(snapshot(13)), synchronizeDefinition: vi.fn().mockResolvedValue(snapshot(13)), snapshot: vi.fn().mockResolvedValue(snapshot(13)), ...overrides } as unknown as WorkspaceApiClient
}

async function mount(client: WorkspaceApiClient, dictionary: Dictionary = en) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); mounted.push({ root, container })
  function Harness() {
    const [source, setSource] = useState(snapshot())
    const [description, setDescription] = useState('Draft role')
    const [instructions, setInstructions] = useState('Draft instructions')
    return createElement(WorkspaceDefinitionHistory, {
      snapshot: source, definitionId: 'role', description, instructions, api: client, t: translate(dictionary) as never,
      onDescriptionChange: setDescription, onInstructionsChange: setInstructions, onSnapshot: setSource,
      onSaveSuccess: () => { setDescription(''); setInstructions('') },
      onEditorCancel: () => { setDescription('Current role'); setInstructions('Current instructions') },
      onDraftReservationChange: vi.fn(),
    })
  }
  await act(async () => { root.render(createElement(Harness)); await Promise.resolve() })
  return container
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const item = [...container.querySelectorAll('button')].find(element => element.getAttribute('aria-label') === name || element.textContent === name)
  if (item === undefined) throw new Error(`missing button ${name}`)
  return item
}
function field(container: HTMLElement, name: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  const item = [...container.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea')].find(element => element.getAttribute('aria-label') === name)
  if (item === undefined) throw new Error(`missing field ${name}`)
  return item
}
async function click(element: HTMLElement): Promise<void> { await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve() }) }
async function change(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set?.call(element, value); element.dispatchEvent(new Event('change', { bubbles: true })); element.dispatchEvent(new Event('input', { bubbles: true })); await Promise.resolve() })
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }

describe('definition revision history and synchronization', () => {
  it.each([[en, ['Current', 'Previous', 'Creation event 8', 'Historical creation event unresolved', 'Alice', 'Bob']], [zh, ['当前', '历史', '创建事件 8', '历史创建事件无法解析', 'Alice', 'Bob']]] as const)(
    'renders immutable ordered history and pinned instances in both locales', async (dictionary, expected) => {
      const container = await mount(api(), dictionary)
      const t = translate(dictionary)
      expect(container.textContent!.indexOf(t('agent.revision', { number: 3 }))).toBeLessThan(container.textContent!.indexOf(t('agent.revision', { number: 1 })))
      expect(container.textContent).toContain(t('history.creationDerived', { sequence: 6 }))
      for (const value of expected) expect(container.textContent).toContain(value)
      expect(container.querySelectorAll('textarea')).toHaveLength(2)
    },
  )

  it.each([
    ['none', []], ['all', ['alice', 'bob']], ['subset', ['bob']],
  ] as const)('saves a new revision once with %s synchronization', async (mode, ids) => {
    const client = api()
    const container = await mount(client)
    await click(button(container, 'Save new revision'))
    const dialog = container.querySelector('[role="dialog"][aria-label="Synchronize new revision"]')!
    await click(field(dialog as HTMLElement, `Synchronize ${mode}`))
    if (mode === 'subset') await click(field(dialog as HTMLElement, 'Select Bob (bob)'))
    await click(button(dialog as HTMLElement, 'Save revision'))
    expect(client.reviseDefinition).toHaveBeenCalledOnce()
    expect(client.reviseDefinition).toHaveBeenCalledWith({ definitionId: 'role', description: 'Draft role', instructions: 'Draft instructions', ...(ids.length === 0 ? {} : { synchronizeAgentIds: ids }) }, 12)
  })

  it('treats prompt close as synchronize-none and saves exactly once', async () => {
    const client = api()
    const container = await mount(client)
    await click(button(container, 'Save new revision'))
    await click(button(container, 'Close synchronization choice'))
    expect(client.reviseDefinition).toHaveBeenCalledOnce()
    expect(client.reviseDefinition).toHaveBeenCalledWith({ definitionId: 'role', description: 'Draft role', instructions: 'Draft instructions' }, 12)
  })

  it('validates a subset and preserves draft and choice for manual retry at the refreshed revision', async () => {
    const client = api({ reviseDefinition: vi.fn().mockRejectedValueOnce(new WorkspaceApiError({ kind: 'business', code: 'stale-revision', message: 'stale', details: { expectedRevision: 12, actualRevision: 13 } })).mockResolvedValueOnce(snapshot(14)) })
    const container = await mount(client)
    await click(button(container, 'Save new revision'))
    await click(field(container, 'Synchronize subset'))
    expect(button(container, 'Save revision').disabled).toBe(true)
    await click(field(container, 'Select Bob (bob)'))
    await click(button(container, 'Save revision'))
    await vi.waitFor(() => expect(container.textContent).toContain('Review the preserved revision and retry.'))
    expect((field(container, 'Responsibilities') as HTMLTextAreaElement).value).toBe('Draft role')
    await click(button(container, 'Retry revision save'))
    expect(client.reviseDefinition).toHaveBeenLastCalledWith(expect.objectContaining({ synchronizeAgentIds: ['bob'] }), 13)
  })

  it.each([[en, ['names', 'employment periods', 'rooms', 'sessions', 'personal memory']], [zh, ['名称', '任职期间', '群聊', '会话', '个人记忆']]] as const)(
    'synchronizes an older revision only after explicit preservation confirmation in %s', async (dictionary, preserved) => {
      const client = api()
      const container = await mount(client, dictionary)
      const t = translate(dictionary)
      await click(button(container, t('history.synchronizeNamed', { number: 1 })))
      await click(field(container, t('history.selectAgent', { name: 'Alice', id: 'alice' })))
      for (const value of preserved) expect(container.textContent).toContain(value)
      await click(button(container, t('history.confirmSynchronization')))
      expect(client.synchronizeDefinition).toHaveBeenCalledWith('role', 'rev-1', ['alice'], 12)
    },
  )

  it('closes later synchronization without mutation and suppresses late history for another selection', async () => {
    const client = api()
    const container = await mount(client)
    await click(button(container, 'Synchronize revision 1'))
    await click(button(container, 'Cancel synchronization'))
    expect(client.synchronizeDefinition).not.toHaveBeenCalled()
  })

  it('preserves later-sync selection through stale refresh and retries against the adopted revision', async () => {
    const client = api({ synchronizeDefinition: vi.fn()
      .mockRejectedValueOnce(new WorkspaceApiError({ kind: 'business', code: 'stale-revision', message: 'stale', details: { expectedRevision: 12, actualRevision: 13 } }))
      .mockResolvedValueOnce(snapshot(14)) })
    const container = await mount(client)
    await click(button(container, 'Synchronize revision 1'))
    await click(field(container, 'Select Alice (alice)'))
    await click(button(container, 'Confirm synchronization'))
    await vi.waitFor(() => expect(container.textContent).toContain('Review the preserved instance selection and retry.'))
    expect((field(container, 'Select Alice (alice)') as HTMLInputElement).checked).toBe(true)
    expect(button(container, 'Confirm synchronization').disabled).toBe(true)
    await click(button(container, 'Retry revision synchronization'))
    expect(client.synchronizeDefinition).toHaveBeenLastCalledWith('role', 'rev-1', ['alice'], 13)
  })

  it('dismisses save with Escape as synchronize-none exactly once', async () => {
    const client = api()
    const container = await mount(client)
    await click(button(container, 'Save new revision'))
    const dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Synchronize new revision"]')!
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await Promise.resolve() })
    expect(client.reviseDefinition).toHaveBeenCalledOnce()
    expect(client.reviseDefinition).toHaveBeenCalledWith({ definitionId: 'role', description: 'Draft role', instructions: 'Draft instructions' }, 12)
  })

  it('returns focus to the exact trigger after either synchronization dialog closes', async () => {
    const container = await mount(api())
    const saveTrigger = button(container, 'Save new revision')
    saveTrigger.focus()
    await click(saveTrigger)
    await click(button(container, 'Close synchronization choice'))
    await vi.waitFor(() => expect(container.querySelector('[aria-label="Synchronize new revision"]')).toBeNull())
    expect(document.activeElement).toBe(saveTrigger)

    const laterTrigger = button(container, 'Synchronize revision 1')
    laterTrigger.focus()
    await click(laterTrigger)
    await click(button(container, 'Cancel synchronization'))
    expect(document.activeElement).toBe(laterTrigger)
  })

  it('ignores a late history response after definition selection changes', async () => {
    const old = deferred<readonly DefinitionHistoryItem[]>()
    const otherHistory: readonly DefinitionHistoryItem[] = [{ id: 'other-rev', definitionId: 'other', number: 1, description: 'Other history', instructions: 'Other', creationEvent: { status: 'derived', sequence: 4 }, status: 'current', agentIds: [] }]
    const source: WorkspaceSnapshot = {
      ...snapshot(),
      definitions: { ...snapshot().definitions, other: { id: 'other', name: 'Other', revisionIds: ['other-rev'], currentRevisionId: 'other-rev' } },
      definitionRevisions: { ...snapshot().definitionRevisions, 'other-rev': { id: 'other-rev', definitionId: 'other', number: 1, description: 'Other history', instructions: 'Other' } },
    }
    const client = api({ definitionHistory: vi.fn((id: string) => id === 'role' ? old.promise : Promise.resolve(otherHistory)) })
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container); mounted.push({ root, container })
    function Harness() {
      const [id, setId] = useState('role')
      return createElement('div', {}, createElement('button', { onClick: () => setId('other') }, 'Switch definition'), createElement(WorkspaceDefinitionHistory, {
        snapshot: source, definitionId: id, description: '', instructions: '', api: client, t: translate(en) as never,
        onDescriptionChange: vi.fn(), onInstructionsChange: vi.fn(), onSnapshot: vi.fn(), onSaveSuccess: vi.fn(), onEditorCancel: vi.fn(), onDraftReservationChange: vi.fn(),
      }))
    }
    await act(async () => { root.render(createElement(Harness)); await Promise.resolve() })
    await click(button(container, 'Switch definition'))
    await vi.waitFor(() => expect(container.textContent).toContain('Other history'))
    await act(async () => old.resolve(history))
    expect(container.textContent).not.toContain('Current role')
  })
})
