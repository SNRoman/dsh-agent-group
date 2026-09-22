// @vitest-environment jsdom

import { act, createElement, useMemo, useState } from 'react'
import type { RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceApiError } from '../packages/web/src/client/api.ts'
import type { WorkspaceApiClient } from '../packages/web/src/client/api.ts'
import type { WorkspaceActivitySnapshot, WorkspaceSnapshot } from '../packages/web/src/client/contracts.ts'
import { en, zh } from '../packages/web/src/client/locales.ts'
import { projectWorkspaceActivity } from '../packages/web/src/client/activity-view-model.ts'
import { WorkspaceActivityDrawer } from '../packages/web/src/client/WorkspaceActivityDrawer.tsx'
import { WorkspaceOverlay } from '../packages/web/src/client/WorkspaceUi.tsx'
import type { WorkspaceUiError, WorkspaceUiState } from '../packages/web/src/client/store.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  MarkdownText: ({ text }: { readonly text: string }) => text,
  DisclosureRow: ({ title, collapsedContent, children }: { readonly title: string; readonly collapsedContent?: unknown; readonly children?: unknown }) => createElement('section', null, createElement('strong', null, title), collapsedContent as never, children as never),
}))

const mounted: Array<{ readonly root: Root; readonly container: HTMLDivElement; readonly cleanup?: () => void }> = []
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })

afterEach(async () => {
  for (const item of mounted.splice(0)) await act(async () => { item.root.unmount(); item.container.remove(); item.cleanup?.() })
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

function translate(dictionary: Readonly<Record<string, string>>) {
  return (key: string, params?: Readonly<Record<string, string | number>>): string => (
    Object.entries(params ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), dictionary[key] ?? key)
  )
}

const t = translate(en)

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

async function mount(api: WorkspaceApiClient, state = snapshot(), stream = activity(), selectedActivityId = 'activity', dictionary: Readonly<Record<string, string>> = en) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const trigger = document.createElement('button')
  document.body.append(trigger)
  const entry = { root, container, cleanup: () => trigger.remove() }
  mounted.push(entry)
  trigger.focus()
  const returnFocusRef = { current: trigger } as RefObject<HTMLButtonElement>
  const onSnapshot = vi.fn()
  const onActivity = vi.fn()
  const onClose = vi.fn()
  const onSelectActivity = vi.fn()
  let currentStream = stream
  const render = async (selection = selectedActivityId, nextStream = currentStream): Promise<void> => {
    currentStream = nextStream
    await act(async () => root.render(createElement(WorkspaceActivityDrawer, {
      projection: projectWorkspaceActivity(state, currentStream), snapshot: state, api,
      selectedActivityId: selection, onSelectActivity, onSnapshot, onActivity,
      onClose, returnFocusRef, t: translate(dictionary) as never,
    })))
  }
  await render()
  return {
    container, trigger, onSnapshot, onActivity, onClose, onSelectActivity, render,
    unmount: async () => {
      const index = mounted.indexOf(entry)
      if (index >= 0) mounted.splice(index, 1)
      await act(async () => { root.unmount(); container.remove(); trigger.remove() })
    },
  }
}

interface OverlayActionsLog {
  readonly close: ReturnType<typeof vi.fn>
  readonly setSnapshot: ReturnType<typeof vi.fn>
  readonly setBusy: ReturnType<typeof vi.fn>
  readonly setError: ReturnType<typeof vi.fn>
}

function WorkspaceOverlayHarness({ api, log }: { readonly api: WorkspaceApiClient; readonly log: OverlayActionsLog }) {
  const [ui, setUi] = useState<WorkspaceUiState>({
    open: true,
    mode: 'conversations',
    snapshot: snapshot(),
    busy: false,
  })
  const actions = useMemo(() => ({
    open: () => setUi(current => ({ ...current, open: true })),
    close: () => {
      log.close()
      setUi(current => ({ ...current, open: false }))
    },
    setMode: (mode: WorkspaceUiState['mode']) => setUi(current => ({ ...current, mode })),
    selectRoom: () => {},
    selectDefinition: () => {},
    openActivityDrawer: () => setUi(current => ({ ...current, activityDrawerOpen: true })),
    closeActivityDrawer: () => setUi(current => ({ ...current, activityDrawerOpen: false })),
    selectActivity: () => {},
    setSnapshot: (value: WorkspaceSnapshot) => {
      log.setSnapshot(value)
      setUi(current => ({ ...current, snapshot: value }))
    },
    setBusy: (value: boolean) => {
      log.setBusy(value)
      setUi(current => ({ ...current, busy: value }))
    },
    setError: (value: WorkspaceUiError | undefined) => {
      log.setError(value)
      setUi(current => ({ ...current, ...(value === undefined ? { error: undefined } : { error: value }) }))
    },
    setRetry: () => {},
  }), [log])
  return createElement(WorkspaceOverlay as never, {
    useStore: (selector: (state: WorkspaceUiState) => unknown) => selector(ui),
    actions,
    api,
    t: t as never,
  })
}

async function mountOverlay(api: WorkspaceApiClient) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const entry = { root, container }
  mounted.push(entry)
  const log: OverlayActionsLog = {
    close: vi.fn(),
    setSnapshot: vi.fn(),
    setBusy: vi.fn(),
    setError: vi.fn(),
  }
  await act(async () => root.render(createElement(WorkspaceOverlayHarness, { api, log })))
  return {
    container,
    log,
    unmount: async () => {
      const index = mounted.indexOf(entry)
      if (index >= 0) mounted.splice(index, 1)
      await act(async () => { root.unmount(); container.remove() })
    },
  }
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === name || item.getAttribute('aria-label') === name)
  if (!(found instanceof HTMLButtonElement)) throw new Error(`button '${name}' not found`)
  return found
}

describe('runtime activity drawer real DOM interactions', () => {
  it('localizes known Host errors and terminal reasons instead of rendering raw summaries', async () => {
    const interrupted = activity('settled')
    const stream = {
      ...interrupted,
      agents: interrupted.agents.map(agent => agent.agentId === 'bob'
        ? { ...agent, error: { code: 'interrupted', summary: 'Delivery was interrupted before a terminal result.' } }
        : agent),
      activities: interrupted.activities.map(item => ({
        ...item,
        error: { code: 'interrupted', summary: 'Delivery was interrupted before a terminal result.' },
      })),
    }
    const { container } = await mount({} as WorkspaceApiClient, snapshot(), stream, 'activity', zh)
    expect(container.textContent).toContain('任务投递在产生最终结果前中断。')
    expect(container.textContent).toContain('结束原因：已完成')
    expect(container.textContent).not.toContain('Delivery was interrupted before a terminal result.')
  })

  it('renders safe details and restores the exact trigger on close', async () => {
    const api = {} as WorkspaceApiClient
    const { container, trigger, onClose } = await mount(api)
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Runtime activity')
    expect(document.activeElement).toBe(button(container, 'Close runtime activity'))
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

  it('exposes and updates the selected activity through standard button semantics', async () => {
    const stream: WorkspaceActivitySnapshot = {
      ...activity(),
      activities: [
        ...activity().activities,
        {
          activityId: 'queued', agentId: 'alice', source: { kind: 'room', roomId: 'room' },
          messageId: 'queued-message', startOrder: 2, status: 'queued', blocks: [],
        },
      ],
    }
    const { container, onSelectActivity, render, trigger } = await mount({} as WorkspaceApiClient, snapshot(), stream)
    const choices = [...container.querySelectorAll<HTMLButtonElement>('.dsh-agent-group-list-button')]
    expect(choices.map(choice => choice.getAttribute('aria-pressed'))).toEqual(['true', 'false'])
    await act(async () => choices[1]!.click())
    expect(onSelectActivity).toHaveBeenCalledWith('queued')
    await render('queued')
    expect([...container.querySelectorAll<HTMLButtonElement>('.dsh-agent-group-list-button')].map(choice => choice.getAttribute('aria-pressed'))).toEqual(['false', 'true'])
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

  it('continues a superseded wait from the greatest independently refreshed activity version', async () => {
    const waitV6 = deferred<WorkspaceActivitySnapshot>()
    const waitAfterV10 = deferred<WorkspaceActivitySnapshot>()
    const refreshed = { ...activity(), version: 10 }
    const api = {
      snapshot: vi.fn().mockResolvedValue(snapshot()),
      activitySnapshot: vi.fn()
        .mockResolvedValueOnce({ ...activity(), version: 5 })
        .mockResolvedValueOnce(refreshed),
      waitForActivity: vi.fn()
        .mockImplementationOnce((_version: number, signal: AbortSignal) => {
          signal.addEventListener('abort', () => waitV6.reject(new DOMException('aborted', 'AbortError')), { once: true })
          return waitV6.promise
        })
        .mockImplementationOnce((_version: number, signal: AbortSignal) => {
          signal.addEventListener('abort', () => waitAfterV10.reject(new DOMException('aborted', 'AbortError')), { once: true })
          return waitAfterV10.promise
        }),
    } as unknown as WorkspaceApiClient
    const view = await mountOverlay(api)
    try {
      await vi.waitFor(() => expect(api.waitForActivity).toHaveBeenCalledWith(5, expect.any(AbortSignal)))
      await act(async () => button(view.container, 'Refresh').click())
      await act(async () => waitV6.resolve({ ...activity(), version: 6 }))
      await vi.waitFor(() => expect(api.waitForActivity).toHaveBeenLastCalledWith(10, expect.any(AbortSignal)))
      expect(api.waitForActivity).toHaveBeenCalledTimes(2)
      expect(view.container.textContent).not.toContain('Live status connection failed.')
    } finally {
      await view.unmount()
    }
  })

  it.each([
    ['close', 'snapshot', 'resolve'],
    ['close', 'snapshot', 'reject'],
    ['close', 'activity', 'resolve'],
    ['close', 'activity', 'reject'],
    ['unmount', 'snapshot', 'resolve'],
    ['unmount', 'snapshot', 'reject'],
    ['unmount', 'activity', 'resolve'],
    ['unmount', 'activity', 'reject'],
  ] as const)('suppresses a %s-time late %s refresh %s', async (lifecycle, leg, outcome) => {
    const delayedSnapshot = deferred<WorkspaceSnapshot>()
    const delayedActivity = deferred<WorkspaceActivitySnapshot>()
    const waiting = deferred<WorkspaceActivitySnapshot>()
    const refreshSignals: AbortSignal[] = []
    const api = {
      snapshot: vi.fn()
        .mockResolvedValueOnce(snapshot())
        .mockImplementationOnce((signal: AbortSignal) => {
          refreshSignals.push(signal)
          return leg === 'snapshot' ? delayedSnapshot.promise : Promise.resolve(snapshot(13))
        }),
      activitySnapshot: vi.fn()
        .mockResolvedValueOnce(activity())
        .mockImplementationOnce((signal: AbortSignal) => {
          refreshSignals.push(signal)
          return leg === 'activity' ? delayedActivity.promise : Promise.resolve({ ...activity(), version: 4 })
        }),
      waitForActivity: vi.fn((_version: number, signal: AbortSignal) => {
        signal.addEventListener('abort', () => waiting.reject(new DOMException('aborted', 'AbortError')), { once: true })
        return waiting.promise
      }),
    } as unknown as WorkspaceApiClient
    const view = await mountOverlay(api)
    await vi.waitFor(() => expect(api.waitForActivity).toHaveBeenCalledOnce())
    await act(async () => button(view.container, 'Refresh').click())
    await vi.waitFor(() => expect(refreshSignals).toHaveLength(2))
    const countsAtCancellation = {
      snapshot: view.log.setSnapshot.mock.calls.length,
      busy: view.log.setBusy.mock.calls.length,
      error: view.log.setError.mock.calls.length,
    }
    if (lifecycle === 'close') await act(async () => button(view.container, 'Close').click())
    else await view.unmount()
    expect(refreshSignals.every(signal => (signal as AbortSignal | undefined)?.aborted === true)).toBe(true)

    await act(async () => {
      const failure = new Error('late private detail')
      if (leg === 'snapshot') outcome === 'resolve' ? delayedSnapshot.resolve(snapshot(14)) : delayedSnapshot.reject(failure)
      else outcome === 'resolve' ? delayedActivity.resolve({ ...activity(), version: 14 }) : delayedActivity.reject(failure)
      await Promise.resolve()
    })
    expect(view.log.setSnapshot).toHaveBeenCalledTimes(countsAtCancellation.snapshot)
    expect(view.log.setBusy).toHaveBeenCalledTimes(countsAtCancellation.busy)
    expect(view.log.setError).toHaveBeenCalledTimes(countsAtCancellation.error)
    if (lifecycle === 'close') await view.unmount()
  })

  it('aborts a replaced manual refresh and ignores its later completion', async () => {
    const firstSnapshot = deferred<WorkspaceSnapshot>()
    const firstActivity = deferred<WorkspaceActivitySnapshot>()
    const waiting = deferred<WorkspaceActivitySnapshot>()
    const firstSignals: AbortSignal[] = []
    const api = {
      snapshot: vi.fn()
        .mockResolvedValueOnce(snapshot())
        .mockImplementationOnce((signal: AbortSignal) => { firstSignals.push(signal); return firstSnapshot.promise })
        .mockResolvedValueOnce(snapshot(13)),
      activitySnapshot: vi.fn()
        .mockResolvedValueOnce(activity())
        .mockImplementationOnce((signal: AbortSignal) => { firstSignals.push(signal); return firstActivity.promise })
        .mockResolvedValueOnce({ ...activity(), version: 10, workspaceRevision: 13 }),
      waitForActivity: vi.fn((_version: number, signal: AbortSignal) => {
        signal.addEventListener('abort', () => waiting.reject(new DOMException('aborted', 'AbortError')), { once: true })
        return waiting.promise
      }),
    } as unknown as WorkspaceApiClient
    const view = await mountOverlay(api)
    try {
      await vi.waitFor(() => expect(api.waitForActivity).toHaveBeenCalledOnce())
      await act(async () => button(view.container, 'Refresh').click())
      await vi.waitFor(() => expect(firstSignals).toHaveLength(2))
      await act(async () => button(view.container, 'Refresh').click())
      expect(firstSignals.every(signal => signal.aborted)).toBe(true)
      await vi.waitFor(() => expect(view.log.setSnapshot).toHaveBeenLastCalledWith(snapshot(13)))
      await act(async () => {
        firstSnapshot.resolve(snapshot(99))
        firstActivity.resolve({ ...activity(), version: 99, workspaceRevision: 99 })
      })
      expect(view.log.setSnapshot).not.toHaveBeenCalledWith(snapshot(99))
    } finally {
      await view.unmount()
    }
  })

  it('opens with focus inside, closes on Escape, and restores the exact trigger', async () => {
    const waiting = deferred<WorkspaceActivitySnapshot>()
    const api = {
      snapshot: vi.fn().mockResolvedValue(snapshot()),
      activitySnapshot: vi.fn().mockResolvedValue(activity()),
      waitForActivity: vi.fn((_version: number, signal: AbortSignal) => {
        signal.addEventListener('abort', () => waiting.reject(new DOMException('aborted', 'AbortError')), { once: true })
        return waiting.promise
      }),
    } as unknown as WorkspaceApiClient
    const view = await mountOverlay(api)
    try {
      const trigger = button(view.container, 'Open runtime activity')
      trigger.focus()
      await act(async () => trigger.click())
      expect(document.activeElement).toBe(button(view.container, 'Close runtime activity'))
      await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
      expect(view.container.querySelector('[aria-label="Runtime activity"]')).toBeNull()
      expect(document.activeElement).toBe(trigger)
    } finally {
      await view.unmount()
    }
  })

  it('renders no stop control for queued, unclaimed, or foreign activity', async () => {
    const base = activity().activities[0]!
    const stream: WorkspaceActivitySnapshot = {
      version: 4,
      workspaceRevision: 12,
      agents: activity().agents,
      activities: [
        { ...base, activityId: 'queued', messageId: 'queued-message', status: 'queued', claimed: undefined },
        { ...base, activityId: 'unclaimed', messageId: 'unclaimed-message', startOrder: 2, claimed: undefined },
        { ...base, activityId: 'foreign', agentId: 'unknown', messageId: 'foreign-message', startOrder: 3 },
      ],
    }
    const view = await mount({} as WorkspaceApiClient, snapshot(), stream, 'queued')
    for (const id of ['queued', 'unclaimed', 'foreign']) {
      await view.render(id)
      expect([...view.container.querySelectorAll('button')].some(item => item.getAttribute('aria-label')?.startsWith('Stop '))).toBe(false)
    }
    await view.unmount()
  })

  it('shows stopping as non-repeatable and converges an already-stopping response', async () => {
    const stoppingView = await mount({} as WorkspaceApiClient, snapshot(), activity('stopping'))
    expect(button(stoppingView.container, 'Stop Alice current turn (activity)').disabled).toBe(true)
    await stoppingView.unmount()

    const api = {
      stopActivity: vi.fn().mockResolvedValue({ revision: 12, value: { status: 'already-stopping' } }),
      activitySnapshot: vi.fn().mockResolvedValue(activity()),
    } as unknown as WorkspaceApiClient
    const view = await mount(api)
    await act(async () => button(view.container, 'Stop Alice current turn (activity)').click())
    expect(view.container.textContent).toContain('Already stopping.')
    expect(button(view.container, 'Stop Alice current turn (activity)').disabled).toBe(true)
    await view.unmount()
  })

  it('prunes a stale stop retry when the authoritative identity changes', async () => {
    const stale = new WorkspaceApiError({
      kind: 'business', code: 'stale-revision', message: 'stale', details: { expectedRevision: 12, actualRevision: 13 },
    })
    const api = {
      stopActivity: vi.fn().mockRejectedValue(stale),
      snapshot: vi.fn().mockResolvedValue(snapshot(13)),
      activitySnapshot: vi.fn().mockResolvedValue({ ...activity(), version: 4, workspaceRevision: 13 }),
    } as unknown as WorkspaceApiClient
    const view = await mount(api)
    await act(async () => button(view.container, 'Stop Alice current turn (activity)').click())
    expect(button(view.container, 'Retry stopping Alice current turn').disabled).toBe(false)
    const replacement: WorkspaceActivitySnapshot = {
      ...activity(),
      version: 5,
      activities: activity().activities.map(item => ({ ...item, claimed: { sessionId: 'replacement', turn: 8 } })),
    }
    await view.render('activity', replacement)
    expect([...view.container.querySelectorAll('button')].some(item => item.getAttribute('aria-label') === 'Retry stopping Alice current turn')).toBe(false)
    await view.unmount()
  })

  it('keeps a successful acknowledgement converged while the failed summary lags', async () => {
    const api = {
      acknowledgeAgentFailure: vi.fn().mockResolvedValue({ revision: 12, value: undefined }),
      activitySnapshot: vi.fn().mockResolvedValue(activity()),
    } as unknown as WorkspaceApiClient
    const view = await mount(api)
    const acknowledge = button(view.container, 'Acknowledge Bob failure')
    await act(async () => acknowledge.click())
    expect(acknowledge.disabled).toBe(true)
    await act(async () => acknowledge.click())
    expect(api.acknowledgeAgentFailure).toHaveBeenCalledOnce()
    await view.unmount()
  })

  it('renders a display-safe generic operation error and suppresses work after unmount', async () => {
    const pending = deferred<{ readonly revision: number; readonly value: { readonly status: 'stopping' } }>()
    const api = {
      stopActivity: vi.fn().mockRejectedValueOnce(new Error('private upstream detail')).mockReturnValueOnce(pending.promise),
      activitySnapshot: vi.fn(),
    } as unknown as WorkspaceApiClient
    const first = await mount(api)
    await act(async () => button(first.container, 'Stop Alice current turn (activity)').click())
    expect(first.container.querySelector('[role="alert"]')?.textContent).toBe('Runtime action failed.')
    expect(first.container.textContent).not.toContain('private upstream detail')
    await first.unmount()

    const second = await mount(api)
    await act(async () => button(second.container, 'Stop Alice current turn (activity)').click())
    await second.unmount()
    await act(async () => pending.resolve({ revision: 12, value: { status: 'stopping' } }))
    expect(api.activitySnapshot).not.toHaveBeenCalled()
    expect(second.onActivity).not.toHaveBeenCalled()
    expect(second.onSnapshot).not.toHaveBeenCalled()
  })
})
