// @vitest-environment jsdom
import { act, createElement, useMemo, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceOrganizations } from '../packages/web/src/client/WorkspaceOrganizations.tsx'
import { WorkspaceApiClient } from '../packages/web/src/client/api.ts'
import { createWorkspaceUiStore, type WorkspaceUiState } from '../packages/web/src/client/store.ts'
import type { WorkspaceDirectoryEntry, WorkspaceSnapshot } from '../packages/web/src/client/contracts.ts'
import { en } from '../packages/web/src/client/locales.ts'
import { createInitialCommunicationState } from '../packages/host/src/communication.ts'
import { createInitialWorkflowState } from '../packages/host/src/workflow.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ MarkdownText: ({ text }: { text: string }) => text, DisclosureRow: () => null }))
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
const mounted: { root: Root; container: HTMLDivElement }[] = []

afterEach(async () => {
  for (const item of mounted.splice(0)) await act(async () => { item.root.unmount(); item.container.remove() })
})

function translate(key: string, params?: Record<string, string | number>): string {
  return Object.entries(params ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), en[key] ?? key)
}

function entry(id: string, lifecycle: 'active' | 'archived' = 'active'): WorkspaceDirectoryEntry {
  return { descriptor: { id, label: id.toUpperCase(), lifecycle }, revision: 1, agentCount: 0, eventCount: 0 }
}

function snapshot(workspaceId: string): WorkspaceSnapshot {
  return { workspaceId, revision: 1, nextId: 1, nextSequence: 1, definitions: {}, definitionRevisions: {}, agents: {}, rooms: { group: { id: 'group', kind: 'group', name: `${workspaceId} room` } }, memberships: {}, events: [], memoryEntries: [], tasks: {}, taskAssignments: {}, delegationGrants: {}, childRuns: {}, sessionBindings: {} }
}

async function mount(options: { directory?: readonly WorkspaceDirectoryEntry[]; listFails?: boolean; renameFails?: boolean; shadow?: boolean } = {}) {
  const calls: { endpoint: string; payload: Record<string, unknown> }[] = []
  const api = new WorkspaceApiClient({ rpc: { call: async (_channel: string, endpoint: string, value: unknown, signal?: AbortSignal) => {
    const payload = value as Record<string, unknown>
    calls.push({ endpoint, payload })
    const workspaceId = String(payload['workspaceId'])
    switch (endpoint) {
      case 'organization/list':
        if (options.listFails) throw new Error('Directory unavailable')
        return { ok: true, value: options.directory ?? [entry('alpha'), entry('beta')] }
      case 'organization/rename':
        if (options.renameFails) throw new Error('Rename unavailable')
        throw new Error('Unexpected successful rename')
      case 'snapshot': return { ok: true, value: snapshot(workspaceId) }
      case 'communication/snapshot': return { ok: true, value: { workspaceId, aggregateRevision: 1, workflowRevision: 0, communication: createInitialCommunicationState() } }
      case 'workflow/snapshot': return { ok: true, value: { workspaceId, aggregateRevision: 1, workflow: createInitialWorkflowState() } }
      case 'runtime/activity/snapshot': return { ok: true, value: { version: 0, workspaceRevision: 1, agents: [], activities: [] } }
      case 'runtime/activity/wait': return await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true })
      })
      default: throw new Error(`Unexpected endpoint ${endpoint}`)
    }
  } } } as never)
  const handle = createWorkspaceUiStore() as { definition: { init(): WorkspaceUiState; actions: Record<string, (draft: WorkspaceUiState, ...args: never[]) => void> } }
  let latest = { ...handle.definition.init(), open: true }
  const container = document.createElement('div')
  const surface = options.shadow ? document.createElement('div') : container
  document.body.append(surface)
  if (options.shadow) surface.attachShadow({ mode: 'open' }).append(container)
  const root = createRoot(container)
  mounted.push({ root, container: surface })
  function Harness() {
    const [state, setState] = useState<WorkspaceUiState>(latest)
    latest = state
    const actions = useMemo(() => Object.fromEntries(Object.entries(handle.definition.actions).map(([key, action]) => [key, (...args: never[]) => setState(current => { const next = { ...current }; action(next, ...args); return next })])), [])
    return createElement(WorkspaceOrganizations, { api, useStore: (selector: (state: WorkspaceUiState) => unknown) => selector(state), actions, t: translate } as never)
  }
  await act(async () => root.render(createElement(Harness)))
  return { container, calls, state: () => latest }
}

function button(container: HTMLElement, key: string): HTMLButtonElement {
  const name = translate(key)
  const control = [...container.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === name || item.textContent?.trim() === name)
  if (control === undefined) throw new Error(`Button missing: ${name}`)
  return control
}

function field(container: HTMLElement, key: string): HTMLInputElement | HTMLSelectElement {
  const control = [...container.querySelectorAll('input,select')].find(item => item.getAttribute('aria-label') === translate(key))
  if (!(control instanceof HTMLInputElement) && !(control instanceof HTMLSelectElement)) throw new Error(`Field missing: ${key}`)
  return control
}

async function change(control: HTMLInputElement | HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(control instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype, 'value')!.set!.call(control, value)
    control.dispatchEvent(new Event('input', { bubbles: true }))
    control.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function frame(container: HTMLElement): HTMLElement {
  expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1)
  expect(container.querySelectorAll('.dsh-agent-group-workbench')).toHaveLength(1)
  const workbench = container.querySelector<HTMLElement>('.dsh-agent-group-workbench')!
  expect(workbench.closest('[role="dialog"]')).not.toBeNull()
  expect(workbench.querySelectorAll('.dsh-agent-group-topbar')).toHaveLength(1)
  return workbench
}

describe('refreshed organization workbench shell', () => {
  it.each([false, true])('closes organization management on Escape and restores its trigger focus (shadow=%s)', async shadow => {
    const { container } = await mount({ shadow })
    const management = container.querySelector<HTMLDetailsElement>('.dsh-agent-group-organization-management')!
    const trigger = management.querySelector('summary')!
    await act(async () => trigger.click())
    const label = field(container, 'organization.label')
    label.focus()
    await act(async () => label.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true })))
    expect(management.open).toBe(false)
    expect((container.getRootNode() as Document | ShadowRoot).activeElement).toBe(trigger)
  })

  it.each([false, true])('keeps internal controls open and dismisses management on an outside pointer action (shadow=%s)', async shadow => {
    const { container } = await mount({ shadow })
    const management = container.querySelector<HTMLDetailsElement>('.dsh-agent-group-organization-management')!
    await act(async () => management.querySelector('summary')!.click())
    await act(async () => field(container, 'organization.label').dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true })))
    expect(management.open).toBe(true)
    await act(async () => button(container, 'workspace.colleagues').dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true })))
    expect(management.open).toBe(false)
  })

  it('keeps organization selection, management and all four views inside one frame', async () => {
    const { container, state } = await mount()
    const workbench = frame(container)
    const header = workbench.querySelector<HTMLElement>('.dsh-agent-group-topbar')!
    const switcher = field(container, 'organization.select')
    expect(switcher.closest('header')).toBe(header)
    expect(switcher.closest('details')).toBeNull()
    const management = header.querySelector('details')!
    expect(management.open).toBe(false)
    await act(async () => management.querySelector('summary')!.click())
    expect(management.open).toBe(true)
    expect(field(container, 'organization.label').closest('details')).toBe(management)

    const navigation = header.querySelector('nav')!
    expect(navigation.getAttribute('aria-label')).toBe(translate('workspace.views'))
    expect(navigation.querySelectorAll('button')).toHaveLength(4)
    for (const mode of ['conversations', 'colleagues', 'tasks', 'memory'] as const) {
      const tab = button(navigation, `workspace.${mode}`)
      expect(tab.getAttribute('aria-label')).toBeTruthy()
      await act(async () => tab.click())
      expect(state().mode).toBe(mode)
      expect(tab.getAttribute('aria-current')).toBe('page')
      expect(navigation.querySelectorAll('[aria-current="page"]')).toHaveLength(1)
      expect(frame(container)).toBe(workbench)
    }

    await change(switcher, 'beta')
    expect(state().selectedWorkspaceId).toBe('beta')
    expect(state().snapshot?.workspaceId).toBe('beta')
    expect(field(container, 'organization.select').value).toBe('beta')
    frame(container)
  })

  it('starts with the member panel hidden and returns focus when members are closed', async () => {
    const { container } = await mount()
    const members = container.querySelector<HTMLElement>('.dsh-agent-group-member-panel')!
    const toggle = button(container, 'room.memberToggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(members.hidden).toBe(true)
    await act(async () => toggle.click())
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(members.hidden).toBe(false)
    await act(async () => button(members, 'room.hideMembers').click())
    expect(members.hidden).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(toggle)
    await act(async () => toggle.click())
    await act(async () => toggle.click())
    expect(members.hidden).toBe(true)
  })

  it('keeps export confirmation and organization failures in the frame', async () => {
    const { container } = await mount({ renameFails: true })
    const workbench = frame(container)
    await act(async () => button(container, 'organization.export').click())
    const confirmation = button(container, 'organization.exportConfirm')
    expect(confirmation.closest('.dsh-agent-group-workbench')).toBe(workbench)
    expect(confirmation.closest('details')).toBeNull()
    expect(frame(container)).toBe(workbench)
    await act(async () => button(container, 'room.cancel').click())
    await change(field(container, 'organization.label'), 'Renamed')
    await act(async () => button(container, 'organization.rename').click())
    expect(workbench.querySelector('[role="alert"]')?.textContent).toBe(translate('workspace.requestFailed'))
    expect(field(container, 'organization.select').disabled).toBe(false)
    expect(button(container, 'organization.rename').disabled).toBe(false)
  })

  it('keeps archived history navigable while organization and room mutations stay disabled', async () => {
    const { container, calls, state } = await mount({ directory: [entry('alpha', 'archived')] })
    const workbench = frame(container)
    expect([...workbench.querySelectorAll('[role="status"]')].some(status => status.textContent === translate('organization.readOnly'))).toBe(true)
    const createRoom = button(container, 'room.newGroup')
    expect(createRoom.disabled).toBe(true)
    expect(button(container, 'organization.rename').disabled).toBe(true)
    expect(button(container, 'organization.reopen').disabled).toBe(false)
    await act(async () => createRoom.click())
    expect(calls.some(call => call.endpoint === 'room/create')).toBe(false)
    await act(async () => button(container, 'workspace.memory').click())
    expect(state().mode).toBe('memory')
    expect(frame(container)).toBe(workbench)
  })

  it.each([false, true])('keeps empty or failed directory management and Close in one frame (failed=%s)', async listFails => {
    const { container } = await mount({ directory: [], listFails })
    const workbench = frame(container)
    expect(field(container, 'organization.select').disabled).toBe(true)
    expect(field(container, 'organization.label').closest('.dsh-agent-group-workbench')).toBe(workbench)
    if (listFails) expect(workbench.querySelector('[role="alert"]')).not.toBeNull()
    else expect(workbench.querySelector('details')?.open).toBe(true)
    await act(async () => button(container, 'workspace.close').click())
    expect(container.childElementCount).toBe(0)
  })
})
