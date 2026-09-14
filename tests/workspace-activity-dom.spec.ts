// @vitest-environment jsdom

import { act, createElement } from 'react'
import type { RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceApiError } from '../packages/web/src/client/api.ts'
import type { WorkspaceApiClient } from '../packages/web/src/client/api.ts'
import type { WorkspaceActivitySnapshot, WorkspaceSnapshot } from '../packages/web/src/client/contracts.ts'
import { en } from '../packages/web/src/client/locales.ts'
import { projectWorkspaceActivity } from '../packages/web/src/client/activity-view-model.ts'
import { WorkspaceActivityDrawer } from '../packages/web/src/client/WorkspaceActivityDrawer.tsx'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  MarkdownText: ({ text }: { readonly text: string }) => text,
  DisclosureRow: ({ title, collapsedContent, children }: { readonly title: string; readonly collapsedContent?: unknown; readonly children?: unknown }) => createElement('section', null, createElement('strong', null, title), collapsedContent as never, children as never),
}))

const mounted: Array<{ readonly root: Root; readonly container: HTMLDivElement }> = []
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })

afterEach(async () => {
  for (const item of mounted.splice(0)) await act(async () => { item.root.unmount(); item.container.remove() })
  vi.restoreAllMocks()
})

function snapshot(revision = 12): WorkspaceSnapshot {
  return {
    workspaceId: 'workspace', revision, nextId: 20, nextSequence: 20,
    definitions: {}, definitionRevisions: {}, memberships: {}, events: [], memoryEntries: [], sessionBindings: {},
    agents: {
      alice: { id: 'alice', name: 'Alice', definitionId: 'role', definitionRevisionId: 'revision', employmentStatus: 'employed', employmentPeriods: [] },
      bob: { id: 'bob', name: 'Bob', definitionId: 'role', definitionRevisionId: 'revision', employmentStatus: 'employed', employmentPeriods: [] },
    },
    rooms: { room: { id: 'room', kind: 'group', name: 'Engineering' } },
    tasks: { task: { id: 'task', rootTaskId: 'task', title: 'Release', status: 'open' } },
    taskAssignments: {}, delegationGrants: {}, childRuns: {},
  }
}

function activity(status: 'responding' | 'stopping' | 'settled' = 'responding', version = 3): WorkspaceActivitySnapshot {
  return {
    version, workspaceRevision: 12,
    agents: [
      { agentId: 'alice', status: 'active', usingTool: true },
      { agentId: 'bob', status: 'failed', usingTool: false, error: { code: 'room-failed', summary: 'Safe failure.' } },
    ],
    activities: [{
      activityId: 'activity', agentId: 'alice', source: { kind: 'room', roomId: 'room' }, messageId: 'message',
      startOrder: 1, status, claimed: { sessionId: 'session', turn: 7 },
      blocks: [
        { kind: 'text', index: 0, text: '**working**' },
        { kind: 'reasoning', index: 1, text: 'safe reasoning' },
        { kind: 'tool', index: 2, callId: 'call', name: 'shell', arguments: '{"cmd":"pwd"}', status: 'running' },
      ],
      ...(status === 'settled' ? { terminalReason: 'completed' } : {}),
    }],
  }
}

function t(key: string, params?: Readonly<Record<string, string | number>>): string {
  return Object.entries(params ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), en[key] ?? key)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

async function mount(api: WorkspaceApiClient, state = snapshot(), stream = activity()) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  const trigger = document.createElement('button')
  document.body.append(trigger)
  trigger.focus()
  const returnFocusRef = { current: trigger } as RefObject<HTMLButtonElement>
  const onSnapshot = vi.fn()
  const onActivity = vi.fn()
  const onClose = vi.fn()
  await act(async () => root.render(createElement(WorkspaceActivityDrawer, {
    projection: projectWorkspaceActivity(state, stream), snapshot: state, api,
    selectedActivityId: 'activity', onSelectActivity: vi.fn(), onSnapshot, onActivity,
    onClose, returnFocusRef, t: t as never,
  })))
  return { container, trigger, onSnapshot, onActivity, onClose }
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === name || item.getAttribute('aria-label') === name)
  if (!(found instanceof HTMLButtonElement)) throw new Error(`button '${name}' not found`)
  return found
}

describe('runtime activity drawer real DOM interactions', () => {
  it('renders safe details and restores the exact trigger on close', async () => {
    const api = {} as WorkspaceApiClient
    const { container, trigger, onClose } = await mount(api)
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Runtime activity')
    expect(container.textContent).toContain('Alice')
    expect(container.textContent).toContain('Engineering')
    expect(container.textContent).toContain('working')
    expect(container.textContent).toContain('safe reasoning')
    expect(container.textContent).toContain('Tool: shell')
    await act(async () => button(container, 'Close runtime activity').click())
    expect(onClose).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('sends the exact Host identity and leaves failure acknowledgement enabled while stop is pending', async () => {
    const pending = deferred<{ readonly revision: number; readonly value: { readonly status: 'stopping' } }>()
    const api = {
      stopActivity: vi.fn().mockReturnValue(pending.promise),
      acknowledgeAgentFailure: vi.fn().mockResolvedValue({ revision: 12, value: undefined }),
      activitySnapshot: vi.fn().mockResolvedValue(activity('stopping', 4)),
      snapshot: vi.fn().mockResolvedValue(snapshot()),
    } as unknown as WorkspaceApiClient
    const { container } = await mount(api)
    const stop = button(container, 'Stop Alice current turn (activity)')
    const acknowledge = button(container, 'Acknowledge Bob failure')
    await act(async () => stop.click())
    expect(stop.disabled).toBe(true)
    expect(acknowledge.disabled).toBe(false)
    expect(api.stopActivity).toHaveBeenCalledWith({ activityId: 'activity', agentId: 'alice', messageId: 'message', sessionId: 'session', turn: 7 }, 12)
    await act(async () => pending.resolve({ revision: 12, value: { status: 'stopping' } }))
    expect(api.activitySnapshot).toHaveBeenCalled()
  })

  it('treats not-active as convergence and requires explicit retry after a stale acknowledgement', async () => {
    const stale = new WorkspaceApiError({
      kind: 'business', code: 'stale-revision', message: 'stale', details: { expectedRevision: 12, actualRevision: 13 },
    })
    const current = snapshot(13)
    const api = {
      stopActivity: vi.fn().mockResolvedValue({ revision: 12, value: { status: 'not-active' } }),
      acknowledgeAgentFailure: vi.fn().mockRejectedValueOnce(stale).mockResolvedValueOnce({ revision: 13, value: undefined }),
      activitySnapshot: vi.fn().mockResolvedValue({ ...activity('settled', 4), workspaceRevision: 13 }),
      snapshot: vi.fn().mockResolvedValue(current),
    } as unknown as WorkspaceApiClient
    const { container, onSnapshot } = await mount(api)
    await act(async () => button(container, 'Stop Alice current turn (activity)').click())
    expect(container.querySelector('[role="alert"]')).toBeNull()
    await act(async () => button(container, 'Acknowledge Bob failure').click())
    expect(onSnapshot).toHaveBeenCalledWith(current)
    expect(api.acknowledgeAgentFailure).toHaveBeenCalledTimes(1)
    await act(async () => button(container, 'Retry acknowledging Bob failure').click())
    expect(api.acknowledgeAgentFailure).toHaveBeenLastCalledWith('bob', 13)
  })

  it('enables a stale acknowledgement retry without waiting for the independent activity refresh', async () => {
    const stale = new WorkspaceApiError({
      kind: 'business', code: 'stale-revision', message: 'stale', details: { expectedRevision: 12, actualRevision: 13 },
    })
    const activityWait = deferred<WorkspaceActivitySnapshot>()
    const api = {
      acknowledgeAgentFailure: vi.fn().mockRejectedValueOnce(stale).mockResolvedValueOnce({ revision: 13, value: undefined }),
      activitySnapshot: vi.fn().mockReturnValue(activityWait.promise),
      snapshot: vi.fn().mockResolvedValue(snapshot(13)),
    } as unknown as WorkspaceApiClient
    const { container } = await mount(api)
    try {
      await act(async () => button(container, 'Acknowledge Bob failure').click())
      expect(button(container, 'Retry acknowledging Bob failure').disabled).toBe(false)
    } finally {
      await act(async () => activityWait.resolve({ ...activity(), version: 4, workspaceRevision: 13 }))
    }
  })
})
