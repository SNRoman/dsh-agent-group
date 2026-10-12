// @vitest-environment jsdom

import { act, createElement, useMemo, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceOverlay } from '../packages/web/src/client/WorkspaceUi.tsx'
import { createWorkspaceUiStore } from '../packages/web/src/client/store.ts'
import type { WorkspaceUiState } from '../packages/web/src/client/store.ts'
import { WorkspaceApiClient } from '../packages/web/src/client/api.ts'
import { en } from '../packages/web/src/client/locales.ts'
import { HumanId, WorkspaceId } from '../packages/host/src/ids.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ MarkdownText: ({ text }: { text: string }) => text, DisclosureRow: () => null }))
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })
const mounted: Array<{ root: Root; container: HTMLDivElement }> = []
afterEach(async () => { for (const item of mounted.splice(0)) await act(async () => { item.root.unmount(); item.container.remove() }) })

async function mount(withAnotherColleague = false) {
  const definition = mutateWorkspace(createInitialState(WorkspaceId('local')), { type: 'definition/create', name: '工程师', description: '当前职责', instructions: '当前指令' })
  const agent = mutateWorkspace(definition.state, { type: 'agent/create', definitionId: definition.definitionId, name: '小林' })
  const room = mutateWorkspace(agent.state, { type: 'room/create', kind: 'group', name: '产品讨论' })
  let state = mutateWorkspace(room.state, { type: 'room/join', roomId: room.roomId, agentId: agent.agentId, memoryStart: { type: 'new-events' } }).state
  if (withAnotherColleague) state = mutateWorkspace(state, { type: 'agent/create', definitionId: definition.definitionId, name: '小王' }).state
  state = mutateWorkspace(state, { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: HumanId('web-user') }, text: '请 <@' + agent.agentId + '> 看一下', mentions: [agent.agentId] }).state
  state = mutateWorkspace(state, { type: 'room/message', roomId: room.roomId, actor: { type: 'agent', id: agent.agentId }, text: '好的', mentions: [] }).state
  const stream = { version: 0, workspaceRevision: state.revision, activities: [], agents: [] }
  const rpc = { call: async (_channel: string, endpoint: string, payload: unknown, signal?: AbortSignal) => {
    if (endpoint === 'snapshot') return { ok: true, value: state }
    if (endpoint === 'runtime/activity/snapshot') return { ok: true, value: stream }
    if (endpoint === 'runtime/activity/wait') return await new Promise<never>((_resolve, reject) => { signal?.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }) })
    if (endpoint === 'definition/history') return { ok: true, value: [] }
    if (endpoint === 'room/rename' || endpoint === 'agent/rename') {
      const value = payload as { roomId?: string; agentId?: string; name: string; expectedRevision: number }
      state = endpoint === 'room/rename'
        ? mutateWorkspace(state, { type: 'room/rename', roomId: room.roomId, name: value.name }).state
        : mutateWorkspace(state, { type: 'agent/rename', agentId: agent.agentId, name: value.name }).state
      return { ok: true, value: { revision: state.revision, value: state } }
    }
    throw new Error('Unexpected endpoint: ' + endpoint)
  } }
  const api = new WorkspaceApiClient({ rpc } as never).forWorkspace('local')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  const store = createWorkspaceUiStore() as { definition: { actions: Record<string, (draft: WorkspaceUiState, ...args: never[]) => void> } }
  function Harness() {
    const [ui, setUi] = useState<WorkspaceUiState>({ open: true, mode: 'conversations', selectedWorkspaceId: 'local', selectedRoomId: room.roomId, snapshot: state, busy: false })
    const actions = useMemo(() => Object.fromEntries(Object.entries(store.definition.actions).map(([name, action]) => [name, (...args: never[]) => setUi(current => { const next = { ...current }; action(next, ...args); return next })])), [])
    const t = (key: string, params?: Record<string, string | number>) => Object.entries(params ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), en[key as keyof typeof en] ?? key)
    return createElement(WorkspaceOverlay, { api, useStore: (select: (value: WorkspaceUiState) => unknown) => select(ui), actions, t } as never)
  }
  await act(async () => root.render(createElement(Harness)))
  return { container, agentId: agent.agentId, roomId: room.roomId, current: () => state }
}

it('shows different message bubbles for the human and colleague', async () => {
  const { container } = await mount()
  expect(container.querySelectorAll('.dsh-agent-group-message[data-author="human"]')).toHaveLength(1)
  expect(container.querySelectorAll('.dsh-agent-group-message[data-author="agent"]')).toHaveLength(1)
})

it('opens the same colleague profile from a message avatar, author and group member', async () => {
  const { container, agentId } = await mount()
  const avatar = container.querySelector<HTMLButtonElement>(`.dsh-agent-group-message button[data-agent-id="${agentId}"]`)
  expect(avatar).not.toBeNull()
  await act(async () => avatar!.click())
  expect(container.querySelector('[role="dialog"][data-colleague-id]')?.getAttribute('data-colleague-id')).toBe(agentId)
  expect(container.textContent).toContain('当前职责')
})

it('provides a rename action in the group title', async () => {
  const { container } = await mount()
  expect(container.querySelector('button[aria-label="Rename group"]')).not.toBeNull()
})

it('lists actual colleagues before role templates on the people page', async () => {
  const { container } = await mount()
  const navigation = container.querySelector<HTMLButtonElement>('button[aria-label="Colleagues"]')!
  await act(async () => navigation.click())
  expect(container.querySelector('[data-mode="colleagues"] [data-colleague-list]')?.textContent).toContain('小林')
  expect(container.querySelector('details[data-role-management]')?.hasAttribute('open')).toBe(false)
})

it('saves a group display name without replacing its message history', async () => {
  const { container, roomId, current } = await mount()
  const original = current().events
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Rename group"]')!.click())
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Group name"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '新群名称')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(current().rooms[roomId]!.name).toBe('新群名称')
  expect(current().events).toEqual(original)
  expect(container.querySelectorAll('.dsh-agent-group-message')).toHaveLength(2)
})

it.each(['.dsh-agent-group-avatar', '.dsh-agent-group-identity', '.dsh-agent-group-mention', '.dsh-agent-group-member-identity'])('opens one identity from %s and returns focus after closing', async selector => {
  const { container, agentId } = await mount()
  const trigger = container.querySelector<HTMLButtonElement>(`button${selector}`)!
  trigger.focus()
  await act(async () => trigger.click())
  const dialog = container.querySelector<HTMLElement>('[role="dialog"][data-colleague-id]')!
  expect(dialog.getAttribute('data-colleague-id')).toBe(agentId)
  await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(container.querySelector('[data-colleague-id][role="dialog"]')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

it('keeps role history folded in the colleague directory', async () => {
  const { container } = await mount()
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Colleagues"]')!.click())
  expect(container.querySelector('details[data-revision-history]')).not.toBeNull()
  expect(container.querySelector('details[data-revision-history]')!.hasAttribute('open')).toBe(false)
})

it('renames the selected colleague without changing the role, identity or historical mention routing', async () => {
  const { container, agentId, current } = await mount()
  const original = structuredClone(current().agents[agentId]!)
  await act(async () => container.querySelector<HTMLButtonElement>('button.dsh-agent-group-mention')!.click())
  const input = container.querySelector<HTMLInputElement>('[role="dialog"][data-colleague-id] input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '小李')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(current().agents[agentId]).toEqual({ ...original, name: '小李' })
  expect(container.querySelector('.dsh-agent-group-mention')?.textContent).toBe('@小李')
  expect(container.querySelector('.dsh-agent-group-mention')?.getAttribute('data-agent-id')).toBe(agentId)
})

it('rejects a colleague name collision in the profile without switching identities', async () => {
  const { container, agentId, current } = await mount(true)
  await act(async () => container.querySelector<HTMLButtonElement>('button.dsh-agent-group-mention')!.click())
  const input = container.querySelector<HTMLInputElement>('[role="dialog"][data-colleague-id] input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, ' 小王 ')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(current().agents[agentId]!.name).toBe('小林')
  expect(container.querySelector('[data-colleague-id][role="dialog"]')?.getAttribute('data-colleague-id')).toBe(agentId)
  expect(container.querySelector('[data-colleague-id] [role="alert"]')?.textContent).toContain('nonempty name')
})
