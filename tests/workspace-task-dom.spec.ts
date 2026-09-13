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

function field(container: HTMLElement, name: string): HTMLInputElement | HTMLSelectElement {
  const label = [...container.querySelectorAll('label')].find(item => item.querySelector(':scope > span')?.textContent?.trim() === name)
  const control = label?.querySelector('input, select')
  if (!(control instanceof HTMLInputElement) && !(control instanceof HTMLSelectElement)) throw new Error(`field '${name}' not found`)
  return control
}

function actionNames(dictionary: Dictionary = en) {
  const t = translate(dictionary)
  return {
    cancelRoot: t('task.cancelNamed', { task: 'Root work', id: 'root' }),
    cancelDerived: t('task.cancelNamed', { task: 'Derived work', id: 'derived' }),
    cancelOther: t('task.cancelNamed', { task: 'Other work', id: 'other' }),
    grantOther: t('task.grantNamed', { task: 'Other work', grantee: 'Bob', id: 'other' }),
    revokeAlice: t('task.revokeNamed', { task: 'Root work', grantee: 'Alice', grant: 'grant-active' }),
    retryRoot: t('task.retryDeliveryNamed', { task: 'Root work', id: 'root' }),
    stopTurn: t('task.stopTurnNamed', { task: 'Root work', agent: 'Alice', activity: 'activity' }),
    stopChild: t('task.stopChildNamed', { task: 'Root work', child: 'child' }),
  }
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
    const title = field(container, 'Task title') as HTMLInputElement
    const assignee = field(container, 'Assignee') as HTMLSelectElement
    const names = actionNames()
    await change(title, 'New root')
    await change(assignee, 'alice')
    await click(button(container, 'Assign task'))
    await click(button(container, names.grantOther))
    await click(button(container, names.revokeAlice))
    await click(button(container, names.cancelDerived))
    await click(button(container, names.retryRoot))
    await click(button(container, names.stopTurn))
    await click(button(container, names.stopChild))

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
    await change(field(container, 'Task title'), 'Committed root')
    await change(field(container, 'Assignee'), 'alice')
    await click(button(container, 'Assign task'))

    expect(snapshots).toContain(committed)
    expect((field(container, 'Task title') as HTMLInputElement).value).toBe('')
    expect(container.textContent).toContain('Refresh failed. Use Refresh to reconcile current task controls.')
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
    const names = actionNames()
    await click(button(container, names.cancelRoot))
    await click(button(container, names.cancelOther))
    await act(async () => waits[first].reject(stale()))
    await act(async () => waits[second].reject(stale()))

    expect(button(container, `Retry action ${names.cancelRoot}`).disabled).toBe(false)
    expect(button(container, `Retry action ${names.cancelOther}`).disabled).toBe(false)
    await click(button(container, `Retry action ${names.cancelRoot}`))
    expect(button(container, `Retry action ${names.cancelOther}`).disabled).toBe(false)
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
    const names = actionNames()
    await click(button(container, names.cancelRoot))
    await click(button(container, names.cancelOther))
    if (order === 'stale-first') {
      await act(async () => staleWait.reject(stale()))
      await act(async () => successWait.resolve(refreshed))
    } else {
      await act(async () => successWait.resolve(refreshed))
      await act(async () => staleWait.reject(stale()))
    }
    expect(button(container, `Retry action ${names.cancelRoot}`).disabled).toBe(false)
  })

  it('disables only the exact pending control and treats not-active as refreshed convergence', async () => {
    const wait = deferred<WorkspaceSnapshot>()
    const api = createApi({
      cancelTask: vi.fn((taskId: string) => taskId === 'root' ? wait.promise : Promise.resolve(snapshot())),
      stopActivity: vi.fn().mockResolvedValue({ revision: 12, value: { status: 'not-active' } }),
    })
    const { container } = await mount(api)
    const names = actionNames()
    const rootCancel = button(container, names.cancelRoot)
    const otherCancel = button(container, names.cancelOther)
    await click(rootCancel)
    expect(rootCancel.disabled).toBe(true)
    expect(otherCancel.disabled).toBe(false)
    await click(button(container, names.stopTurn))
    expect(api.snapshot).toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')).toBeNull()
    await act(async () => wait.resolve(snapshot()))
  })

  it('adopts a newer durable snapshot and retries at its revision when only activity refresh fails', async () => {
    const refreshed = { ...snapshot(), revision: 13 }
    const api = createApi({
      cancelTask: vi.fn().mockRejectedValueOnce(stale()).mockResolvedValueOnce(refreshed),
      snapshot: vi.fn().mockResolvedValue(refreshed),
      activitySnapshot: vi.fn().mockRejectedValue(new Error('activity unavailable')),
    })
    const { container, snapshots } = await mount(api)
    const names = actionNames()

    await click(button(container, names.cancelOther))
    expect(snapshots).toContain(refreshed)
    expect(container.textContent).toContain('Refresh failed. Use Refresh to reconcile current task controls.')
    await click(button(container, `Retry action ${names.cancelOther}`))

    expect(api.cancelTask).toHaveBeenLastCalledWith('other', 13)
  })

  it.each(['snapshot', 'activity'] as const)('adopts the successful %s refresh leg independently', async successfulRead => {
    const refreshed = { ...snapshot(), revision: 13 }
    const refreshedActivity = { ...activity(), version: 3, activities: [] }
    const api = createApi({
      cancelTask: vi.fn().mockRejectedValue(stale()),
      snapshot: successfulRead === 'snapshot' ? vi.fn().mockResolvedValue(refreshed) : vi.fn().mockRejectedValue(new Error('snapshot unavailable')),
      activitySnapshot: successfulRead === 'activity' ? vi.fn().mockResolvedValue(refreshedActivity) : vi.fn().mockRejectedValue(new Error('activity unavailable')),
    })
    const { container, snapshots, activities } = await mount(api)

    await click(button(container, actionNames().cancelOther))

    if (successfulRead === 'snapshot') expect(snapshots).toContain(refreshed)
    else expect(activities).toContain(refreshedActivity)
    expect(container.textContent).toContain('Refresh failed. Use Refresh to reconcile current task controls.')
  })

  it.each(['snapshot', 'activity'] as const)('prevents replay after delivery retry succeeds while %s refresh fails', async failedRead => {
    const source = snapshot()
    const committed: WorkspaceSnapshot = {
      ...source,
      revision: 13,
      events: [...source.events, { id: 'e10', sequence: 10, type: 'task/delivery-started', taskId: 'root', taskDeliveryAttemptId: 'attempt-2', messageId: 'message-2' }],
    }
    const api = createApi({
      retryTaskDelivery: vi.fn().mockResolvedValue({ revision: 13, value: 'attempt-2' }),
      snapshot: failedRead === 'snapshot' ? vi.fn().mockRejectedValue(new Error('snapshot unavailable')) : vi.fn().mockResolvedValue(committed),
      activitySnapshot: failedRead === 'activity' ? vi.fn().mockRejectedValue(new Error('activity unavailable')) : vi.fn().mockResolvedValue(activity()),
    })
    const { container } = await mount(api)
    const label = actionNames().retryRoot

    await click(button(container, label))

    const replay = [...container.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === label)
    expect(replay === undefined || replay.disabled).toBe(true)
    expect(api.retryTaskDelivery).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Refresh failed. Use Refresh to reconcile current task controls.')
  })

  it('prevents replay of a converged not-active stop while activity refresh is unavailable', async () => {
    const api = createApi({
      stopActivity: vi.fn().mockResolvedValue({ revision: 12, value: { status: 'not-active' } }),
      activitySnapshot: vi.fn().mockRejectedValue(new Error('activity unavailable')),
    })
    const { container } = await mount(api)
    const label = actionNames().stopTurn

    await click(button(container, label))

    expect(button(container, label).disabled).toBe(true)
    await click(button(container, label))
    expect(api.stopActivity).toHaveBeenCalledTimes(1)
  })

  it('prevents replay after child stop succeeds while its durable refresh is unavailable', async () => {
    const api = createApi({
      stopChildRun: vi.fn().mockResolvedValue({ revision: 12, value: { status: 'stopping' } }),
      snapshot: vi.fn().mockRejectedValue(new Error('snapshot unavailable')),
    })
    const { container } = await mount(api)
    const label = actionNames().stopChild

    await click(button(container, label))

    expect(button(container, label).disabled).toBe(true)
    await click(button(container, label))
    expect(api.stopChildRun).toHaveBeenCalledTimes(1)
  })

  it.each([en, zh] as const)('distinguishes repeated result disclosures by their localized task names', async dictionary => {
    const source = snapshot()
    const completed: WorkspaceSnapshot = {
      ...source,
      tasks: {
        ...source.tasks,
        root: { ...source.tasks.root!, status: 'completed' },
        other: { ...source.tasks.other!, status: 'completed' },
      },
      events: [
        ...source.events,
        { id: 'e10', sequence: 10, type: 'task/result', taskId: 'root', taskDeliveryAttemptId: 'attempt', definitionRevisionId: 'rev', text: 'root result' },
        { id: 'e11', sequence: 11, type: 'task/result', taskId: 'other', taskDeliveryAttemptId: 'other-attempt', definitionRevisionId: 'rev', text: 'other result' },
      ],
    }
    const { container } = await mount(createApi(), dictionary, completed)
    const t = translate(dictionary)
    const names = [
      t('task.resultNamed', { task: 'Root work', id: 'root' }),
      t('task.resultNamed', { task: 'Other work', id: 'other' }),
    ]

    for (const name of names) {
      expect([...container.querySelectorAll('summary')].some(summary => summary.getAttribute('aria-label') === name)).toBe(true)
    }
  })

  it.each([[zh, ['任务标题', '负责人', '分配任务']], [en, ['Task title', 'Assignee', 'Assign task']]] as const)(
    'exposes distinguishable bilingual accessible labels and authoritative provenance', async (dictionary, names) => {
      const { container } = await mount(createApi(), dictionary)
      expect(field(container, names[0])).toBeInstanceOf(HTMLInputElement)
      expect(field(container, names[1])).toBeInstanceOf(HTMLSelectElement)
      expect(button(container, names[2])).toBeInstanceOf(HTMLButtonElement)
      for (const name of Object.values(actionNames(dictionary))) expect(button(container, name)).toBeInstanceOf(HTMLButtonElement)
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
          { id: 'e10', sequence: 10, type: 'task/cancelled', subjectId: 'derived', actor: { type: 'human', id: 'owner' }, cancellationScope: 'root-cascade' },
          { id: 'e11', sequence: 11, type: 'task/cancelled', subjectId: 'root', actor: { type: 'human', id: 'owner' }, cancellationScope: 'root-cascade' },
        ],
      }
      const cascadeView = await mount(createApi(), dictionary, cascade)
      expect(cascadeView.container.textContent).toContain(translate(dictionary)('task.cancellation.rootCascade', { sequence: 11 }))
      expect(cascadeView.container.textContent).toContain(translate(dictionary)('task.grantTerminalExpiry'))

      const derivedOnly: WorkspaceSnapshot = {
        ...source,
        tasks: { ...source.tasks, derived: { ...source.tasks.derived!, status: 'cancelled' } },
        events: [...source.events, { id: 'e10', sequence: 10, type: 'task/cancelled', subjectId: 'derived', actor: { type: 'human', id: 'owner' }, cancellationScope: 'derived-only' }],
      }
      const derivedView = await mount(createApi(), dictionary, derivedOnly)
      expect(derivedView.container.textContent).toContain(translate(dictionary)('task.cancellation.derivedOnly', { sequence: 10 }))

      const legacy: WorkspaceSnapshot = {
        ...source,
        tasks: { ...source.tasks, derived: { ...source.tasks.derived!, status: 'cancelled' } },
        events: [...source.events, { id: 'e10', sequence: 10, type: 'task/cancelled', subjectId: 'derived', actor: { type: 'human', id: 'owner' } }],
      }
      const legacyView = await mount(createApi(), dictionary, legacy)
      expect(legacyView.container.textContent).toContain(translate(dictionary)('task.cancellation.unknown', { sequence: 10 }))
    },
  )
})
