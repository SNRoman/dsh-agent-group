// @vitest-environment jsdom

import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceApiError } from '../packages/web/src/client/api.ts'
import type { WorkspaceApiClient } from '../packages/web/src/client/api.ts'
import type { WorkspaceActivitySnapshot, WorkspaceSnapshot } from '../packages/web/src/client/contracts.ts'
import { en, zh } from '../packages/web/src/client/locales.ts'
import { selectNewerWorkspaceSnapshot } from '../packages/web/src/client/task-view-model.ts'
import { WorkspaceTasks } from '../packages/web/src/client/WorkspaceTasks.tsx'

type Dictionary = Readonly<Record<string, string>>

const mounted: Array<{ readonly root: Root; readonly container: HTMLDivElement }> = []
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })

afterEach(async () => {
  for (const item of mounted.splice(0)) await act(async () => { item.root.unmount(); item.container.remove() })
  vi.restoreAllMocks()
})

function snapshot(): WorkspaceSnapshot {
  return {
    workspaceId: 'workspace', revision: 12, nextId: 30, nextSequence: 30,
    definitions: {}, definitionRevisions: {}, rooms: {}, memberships: {}, memoryEntries: [], sessionBindings: {},
    agents: {
      alice: { id: 'alice', name: 'Alice', definitionId: 'role', definitionRevisionId: 'rev', employmentStatus: 'employed', employmentPeriods: [] },
      bob: { id: 'bob', name: 'Bob', definitionId: 'role', definitionRevisionId: 'rev', employmentStatus: 'employed', employmentPeriods: [] },
    },
    tasks: {
      root: { id: 'root', rootTaskId: 'root', title: 'Root work', status: 'open' },
      derived: { id: 'derived', rootTaskId: 'root', title: 'Derived work', status: 'open' },
      other: { id: 'other', rootTaskId: 'other', title: 'Other work', status: 'open' },
    },
    taskAssignments: {
      'assignment-root': { id: 'assignment-root', taskId: 'root', rootTaskId: 'root', assigneeAgentId: 'alice' },
      'assignment-derived': { id: 'assignment-derived', taskId: 'derived', rootTaskId: 'root', assigneeAgentId: 'bob', grantId: 'grant-active' },
      'assignment-other': { id: 'assignment-other', taskId: 'other', rootTaskId: 'other', assigneeAgentId: 'bob' },
    },
    delegationGrants: {
      'grant-revoked': { id: 'grant-revoked', rootTaskId: 'root', granteeAgentId: 'alice', grantedByHumanId: 'owner', status: 'expired' },
      'grant-active': { id: 'grant-active', rootTaskId: 'root', granteeAgentId: 'alice', grantedByHumanId: 'owner', status: 'active' },
    },
    childRuns: {
      child: { id: 'child', parentAgentId: 'alice', taskId: 'root', status: 'running' },
    },
    events: [
      { id: 'e1', sequence: 1, type: 'task/assigned', subjectId: 'assignment-root' },
      { id: 'e2', sequence: 2, type: 'task/delegation-granted', subjectId: 'grant-revoked', actor: { type: 'human', id: 'owner' } },
      { id: 'e3', sequence: 3, type: 'task/delegation-revoked', subjectId: 'grant-revoked', actor: { type: 'human', id: 'owner' } },
      { id: 'e4', sequence: 4, type: 'task/delegation-granted', subjectId: 'grant-active', actor: { type: 'human', id: 'owner' } },
      { id: 'e5', sequence: 5, type: 'task/delegated', subjectId: 'assignment-derived', actor: { type: 'agent', id: 'alice' } },
      { id: 'e6', sequence: 6, type: 'task/delivery-started', taskId: 'root', taskDeliveryAttemptId: 'attempt', messageId: 'message' },
      { id: 'e7', sequence: 7, type: 'task/delivery-failed', taskId: 'root', taskDeliveryAttemptId: 'attempt', messageId: 'message', failureCode: 'interrupted', failureSummary: 'Interrupted.' },
      { id: 'e8', sequence: 8, type: 'child/run-started', subjectId: 'child', actor: { type: 'agent', id: 'alice' } },
      { id: 'e9', sequence: 9, type: 'task/assigned', subjectId: 'assignment-other', actor: { type: 'human', id: 'owner' } },
    ],
  }
}

function activity(): WorkspaceActivitySnapshot {
  return {
    version: 2, workspaceRevision: 12, agents: [{ agentId: 'alice', status: 'active', usingTool: false }],
    activities: [{
      activityId: 'activity', agentId: 'alice', source: { kind: 'task', taskId: 'root', attemptId: 'attempt' },
      messageId: 'message', startOrder: 1, status: 'responding', claimed: { sessionId: 'session', turn: 3 }, blocks: [],
    }],
  }
}

function translate(dictionary: Dictionary) {
  return (key: string, params?: Readonly<Record<string, string | number>>): string => {
    const source = dictionary[key] ?? key
    return Object.entries(params ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), source)
  }
}

function createApi(overrides: Partial<WorkspaceApiClient> = {}): WorkspaceApiClient {
  const state = snapshot()
  const stream = activity()
  const mutation = { revision: state.revision, value: { state, taskId: 'created', taskAssignmentId: 'created-assignment' } }
  return {
    snapshot: vi.fn().mockResolvedValue(state), activitySnapshot: vi.fn().mockResolvedValue(stream),
    assignTask: vi.fn().mockResolvedValue(mutation),
    grantTask: vi.fn().mockResolvedValue({ revision: state.revision, value: { state, delegationGrantId: 'new-grant' } }),
    revokeTask: vi.fn().mockResolvedValue(state), cancelTask: vi.fn().mockResolvedValue(state),
    retryTaskDelivery: vi.fn().mockResolvedValue({ revision: state.revision, value: 'attempt-2' }),
    stopActivity: vi.fn().mockResolvedValue({ revision: state.revision, value: { status: 'stopping' } }),
    stopChildRun: vi.fn().mockResolvedValue({ revision: state.revision, value: { status: 'stopping' } }),
    ...overrides,
  } as unknown as WorkspaceApiClient
}

async function mount(
  api: WorkspaceApiClient,
  dictionary: Dictionary = en,
  initialState: WorkspaceSnapshot = snapshot(),
  initialActivity: WorkspaceActivitySnapshot = activity(),
) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  const snapshots: WorkspaceSnapshot[] = []
  const activities: WorkspaceActivitySnapshot[] = []
  function Harness() {
    const [state, setState] = useState(initialState)
    const [stream, setStream] = useState(initialActivity)
    return createElement(WorkspaceTasks, { snapshot: state, activity: stream, api, onSnapshot: (value: WorkspaceSnapshot) => {
      snapshots.push(value)
      setState(current => value.revision < current.revision ? current : value)
    }, onActivity: (value: WorkspaceActivitySnapshot) => { activities.push(value); setStream(value) }, t: translate(dictionary) as never })
  }
  await act(async () => root.render(createElement(Harness)))
  return { container, snapshots, activities }
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === name || item.getAttribute('aria-label') === name)
  if (!(found instanceof HTMLButtonElement)) throw new Error(`button '${name}' not found`)
  return found
}

function taskButton(container: HTMLElement, taskId: string, name: string): HTMLButtonElement {
  const task = container.querySelector(`[data-task-id="${taskId}"]`)
  if (!(task instanceof HTMLElement)) throw new Error(`task '${taskId}' not found`)
  return button(task, name)
}

async function click(element: HTMLButtonElement): Promise<void> {
  await act(async () => { element.click() })
}

async function change(element: HTMLInputElement | HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

function stale(): WorkspaceApiError {
  return new WorkspaceApiError({
    kind: 'business', code: 'stale-revision', message: 'stale', details: { expectedRevision: 12, actualRevision: 13 },
  })
}

describe('task center real DOM interactions', () => {
  it('rejects an older durable snapshot after a newer mutation or stream replacement', () => {
    const older = snapshot()
    const newer = { ...older, revision: older.revision + 1 }
    expect(selectNewerWorkspaceSnapshot(newer, older)).toBe(newer)
    expect(selectNewerWorkspaceSnapshot(older, newer)).toBe(newer)
    expect(selectNewerWorkspaceSnapshot(newer, { ...newer })).not.toBe(newer)
  })

  it('dispatches all seven named actions through rendered accessible controls', async () => {
    const api = createApi()
    const { container } = await mount(api)
    const title = container.querySelector('input')!
    const assignee = container.querySelector('select')!
    expect(title.labels?.[0]?.textContent).toContain('Task title')
    expect(assignee.labels?.[0]?.textContent).toContain('Assignee')
    await change(title, 'New root')
    await change(assignee, 'alice')
    await click(button(container, 'Assign task'))
    await click(taskButton(container, 'other', 'Grant delegation'))
    await click(button(container, 'Revoke delegation'))
    await click(taskButton(container, 'derived', 'Cancel task'))
    await click(taskButton(container, 'root', 'Retry delivery'))
    await click(taskButton(container, 'root', 'Stop current task turn'))
    await click(taskButton(container, 'root', 'Stop child agent'))

    expect(api.assignTask).toHaveBeenCalledWith('alice', 'New root', 12)
    expect(api.grantTask).toHaveBeenCalledWith('bob', 'other', 12)
    expect(api.revokeTask).toHaveBeenCalledWith('grant-active', 12)
    expect(api.cancelTask).toHaveBeenCalledWith('derived', 12)
    expect(api.retryTaskDelivery).toHaveBeenCalledWith('root', 12)
    expect(api.stopActivity).toHaveBeenCalledWith({ activityId: 'activity', agentId: 'alice', messageId: 'message', sessionId: 'session', turn: 3 }, 12)
    expect(api.stopChildRun).toHaveBeenCalledWith('child', 12)
  })

  it.each(['snapshot', 'activity'] as const)('installs a committed assignment and clears its draft even when the independent %s refresh fails', async failedRead => {
    const committed = { ...snapshot(), revision: 13 }
    const api = createApi({
      assignTask: vi.fn().mockResolvedValue({ revision: 13, value: { state: committed, taskId: 'created', taskAssignmentId: 'created-assignment' } }),
      snapshot: failedRead === 'snapshot' ? vi.fn().mockRejectedValue(new Error('snapshot unavailable')) : vi.fn().mockResolvedValue(committed),
      activitySnapshot: failedRead === 'activity' ? vi.fn().mockRejectedValue(new Error('stream unavailable')) : vi.fn().mockResolvedValue(activity()),
    })
    const { container, snapshots } = await mount(api)
    await change(container.querySelector('input')!, 'Committed root')
    await change(container.querySelector('select')!, 'alice')
    await click(button(container, 'Assign task'))

    expect(snapshots).toContain(committed)
    expect((container.querySelector('input') as HTMLInputElement).value).toBe('')
    expect(container.textContent).toContain('Live status connection failed.')
    expect([...container.querySelectorAll('button')].some(item => item.textContent === 'Retry')).toBe(false)
  })

  it.each([['first', 'second'], ['second', 'first']] as const)('retains exact stale retries when %s settles before %s', async (first, second) => {
    const waits = { first: deferred<WorkspaceSnapshot>(), second: deferred<WorkspaceSnapshot>() }
    const refreshed = { ...snapshot(), revision: 13 }
    const api = createApi({
      snapshot: vi.fn().mockResolvedValue(refreshed),
      cancelTask: vi.fn((taskId: string) => {
        const calls = (api.cancelTask as ReturnType<typeof vi.fn>).mock.calls.filter(call => call[0] === taskId).length
        if (calls > 1) return Promise.resolve(refreshed)
        return taskId === 'root' ? waits.first.promise : waits.second.promise
      }),
    })
    const { container } = await mount(api)
    await click(taskButton(container, 'root', 'Cancel task'))
    await click(taskButton(container, 'other', 'Cancel task'))
    await act(async () => waits[first].reject(stale()))
    await act(async () => waits[second].reject(stale()))

    expect(button(container, 'Retry action cancel:root').disabled).toBe(false)
    expect(button(container, 'Retry action cancel:other').disabled).toBe(false)
    await click(button(container, 'Retry action cancel:root'))
    expect(button(container, 'Retry action cancel:other').disabled).toBe(false)
    expect(api.cancelTask).toHaveBeenLastCalledWith('root', 13)
  })

  it.each(['stale-first', 'success-first'] as const)('does not erase an unrelated stale retry when another action settles %s', async order => {
    const staleWait = deferred<WorkspaceSnapshot>()
    const successWait = deferred<WorkspaceSnapshot>()
    const refreshed = { ...snapshot(), revision: 13 }
    const api = createApi({
      snapshot: vi.fn().mockResolvedValue(refreshed),
      cancelTask: vi.fn((taskId: string) => taskId === 'root' ? staleWait.promise : successWait.promise),
    })
    const { container } = await mount(api)
    await click(taskButton(container, 'root', 'Cancel task'))
    await click(taskButton(container, 'other', 'Cancel task'))
    if (order === 'stale-first') {
      await act(async () => staleWait.reject(stale()))
      await act(async () => successWait.resolve(refreshed))
    } else {
      await act(async () => successWait.resolve(refreshed))
      await act(async () => staleWait.reject(stale()))
    }
    expect(button(container, 'Retry action cancel:root').disabled).toBe(false)
  })

  it('disables only the exact pending control and treats not-active as refreshed convergence', async () => {
    const wait = deferred<WorkspaceSnapshot>()
    const api = createApi({
      cancelTask: vi.fn((taskId: string) => taskId === 'root' ? wait.promise : Promise.resolve(snapshot())),
      stopActivity: vi.fn().mockResolvedValue({ revision: 12, value: { status: 'not-active' } }),
    })
    const { container } = await mount(api)
    const rootCancel = taskButton(container, 'root', 'Cancel task')
    const otherCancel = taskButton(container, 'other', 'Cancel task')
    await click(rootCancel)
    expect(rootCancel.disabled).toBe(true)
    expect(otherCancel.disabled).toBe(false)
    await click(taskButton(container, 'root', 'Stop current task turn'))
    expect(api.snapshot).toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')).toBeNull()
    await act(async () => wait.resolve(snapshot()))
  })

  it.each([[zh, ['任务标题', '负责人', '分配任务', '授予委派权', '撤销委派权', '取消任务', '重试投递', '停止当前任务轮次', '停止子智能体']], [en, ['Task title', 'Assignee', 'Assign task', 'Grant delegation', 'Revoke delegation', 'Cancel task', 'Retry delivery', 'Stop current task turn', 'Stop child agent']]] as const)(
    'exposes bilingual accessible labels and authoritative provenance', async (dictionary, names) => {
      const { container } = await mount(createApi(), dictionary)
      expect(container.querySelector('input')?.labels?.[0]?.textContent).toContain(names[0])
      expect(container.querySelector('select')?.labels?.[0]?.textContent).toContain(names[1])
      for (const name of names.slice(2)) expect(button(container, name)).toBeInstanceOf(HTMLButtonElement)
      expect(container.textContent).toContain(translate(dictionary)('task.grantedBy', { actor: 'owner' }))
      expect(container.textContent).toContain(translate(dictionary)('task.childParent', { parent: 'Alice' }))
      expect(container.textContent).toContain(translate(dictionary)('task.grantRevoked'))
      expect(container.textContent).toContain(translate(dictionary)('actor.unavailable'))

      const source = snapshot()
      const cascade: WorkspaceSnapshot = {
        ...source,
        tasks: {
          ...source.tasks,
          root: { ...source.tasks.root!, status: 'cancelled' },
          derived: { ...source.tasks.derived!, status: 'cancelled' },
        },
        delegationGrants: {
          ...source.delegationGrants,
          'grant-active': { ...source.delegationGrants['grant-active']!, status: 'expired' },
        },
        events: [
          ...source.events,
          { id: 'e10', sequence: 10, type: 'task/cancelled', subjectId: 'derived', actor: { type: 'human', id: 'owner' } },
          { id: 'e11', sequence: 11, type: 'task/cancelled', subjectId: 'root', actor: { type: 'human', id: 'owner' } },
        ],
      }
      const cascadeView = await mount(createApi(), dictionary, cascade)
      expect(cascadeView.container.textContent).toContain(translate(dictionary)('task.cancellation.rootCascade', { sequence: 11 }))
      expect(cascadeView.container.textContent).toContain(translate(dictionary)('task.grantTerminalExpiry'))

      const derivedOnly: WorkspaceSnapshot = {
        ...source,
        tasks: { ...source.tasks, derived: { ...source.tasks.derived!, status: 'cancelled' } },
        events: [...source.events, { id: 'e10', sequence: 10, type: 'task/cancelled', subjectId: 'derived', actor: { type: 'human', id: 'owner' } }],
      }
      const derivedView = await mount(createApi(), dictionary, derivedOnly)
      expect(derivedView.container.textContent).toContain(translate(dictionary)('task.cancellation.derivedOnly', { sequence: 10 }))
    },
  )
})
