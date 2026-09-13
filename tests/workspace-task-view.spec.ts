import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceActivitySnapshot, WorkspaceSnapshot } from '../packages/web/src/client/contracts.ts'
import { projectTaskRoots, selectNewerActivitySnapshot } from '../packages/web/src/client/task-view-model.ts'
import { WorkspaceTasks } from '../packages/web/src/client/WorkspaceTasks.tsx'

function snapshot(): WorkspaceSnapshot {
  return {
    workspaceId: 'workspace-1', revision: 12, nextId: 30, nextSequence: 30,
    definitions: {}, definitionRevisions: {}, rooms: {}, memberships: {}, memoryEntries: [], sessionBindings: {},
    agents: {
      alice: { id: 'alice', name: 'Alice', definitionId: 'role', definitionRevisionId: 'rev', employmentStatus: 'employed', employmentPeriods: [] },
      bob: { id: 'bob', name: 'Bob', definitionId: 'role', definitionRevisionId: 'rev', employmentStatus: 'employed', employmentPeriods: [] },
    },
    tasks: {
      'root-late': { id: 'root-late', rootTaskId: 'root-late', title: 'Late root', status: 'open' },
      derived: { id: 'derived', rootTaskId: 'root-late', title: 'Derived work', status: 'cancelled' },
      'root-first': { id: 'root-first', rootTaskId: 'root-first', title: 'First root', status: 'completed' },
    },
    taskAssignments: {
      'assign-late': { id: 'assign-late', taskId: 'root-late', rootTaskId: 'root-late', assigneeAgentId: 'alice' },
      'assign-derived': { id: 'assign-derived', taskId: 'derived', rootTaskId: 'root-late', assigneeAgentId: 'bob', grantId: 'grant-1' },
      'assign-first': { id: 'assign-first', taskId: 'root-first', rootTaskId: 'root-first', assigneeAgentId: 'bob' },
    },
    delegationGrants: {
      'grant-1': { id: 'grant-1', rootTaskId: 'root-late', granteeAgentId: 'alice', grantedByHumanId: 'human-1', status: 'expired' },
      'grant-active': { id: 'grant-active', rootTaskId: 'root-late', granteeAgentId: 'alice', grantedByHumanId: 'human-1', status: 'active' },
    },
    childRuns: {
      'child-running': { id: 'child-running', parentAgentId: 'alice', taskId: 'root-late', status: 'running' },
      'child-done': { id: 'child-done', parentAgentId: 'bob', taskId: 'derived', status: 'completed', result: 'child result' },
    },
    events: [
      { id: 'e2', sequence: 2, type: 'task/assigned', subjectId: 'assign-first', actor: { type: 'human', id: 'human-1' }, text: 'First root' },
      { id: 'e10', sequence: 10, type: 'task/assigned', subjectId: 'assign-late', actor: { type: 'human', id: 'human-1' }, text: 'Late root' },
      { id: 'e11', sequence: 11, type: 'task/delegation-granted', subjectId: 'grant-1', actor: { type: 'human', id: 'human-1' } },
      { id: 'e12', sequence: 12, type: 'task/delegation-revoked', subjectId: 'grant-1', actor: { type: 'human', id: 'human-1' } },
      { id: 'e13', sequence: 13, type: 'task/delegation-granted', subjectId: 'grant-active', actor: { type: 'human', id: 'human-1' } },
      { id: 'e14', sequence: 14, type: 'task/delegated', subjectId: 'assign-derived', actor: { type: 'agent', id: 'alice' }, text: 'Derived work' },
      { id: 'e15', sequence: 15, type: 'task/delivery-started', taskId: 'root-late', taskDeliveryAttemptId: 'attempt-1', messageId: 'message-1' },
      { id: 'e16', sequence: 16, type: 'task/delivery-accepted', taskId: 'root-late', taskDeliveryAttemptId: 'attempt-1', messageId: 'message-1' },
      { id: 'e17', sequence: 17, type: 'task/delivery-failed', taskId: 'root-late', taskDeliveryAttemptId: 'attempt-1', messageId: 'message-1', failureCode: 'turn-interrupted', failureSummary: 'Interrupted safely.' },
      { id: 'e18', sequence: 18, type: 'child/run-started', subjectId: 'child-running', actor: { type: 'agent', id: 'alice' } },
      { id: 'e19', sequence: 19, type: 'child/run-started', subjectId: 'child-done', actor: { type: 'agent', id: 'bob' } },
      { id: 'e20', sequence: 20, type: 'child/run-finished', subjectId: 'child-done', actor: { type: 'agent', id: 'bob' }, text: 'child result', childRunStatus: 'completed' },
      { id: 'e21', sequence: 21, type: 'task/cancelled', subjectId: 'derived', actor: { type: 'human', id: 'human-1' } },
      { id: 'e3', sequence: 3, type: 'task/delivery-started', taskId: 'root-first', taskDeliveryAttemptId: 'attempt-done', messageId: 'message-done' },
      { id: 'e4', sequence: 4, type: 'task/delivery-accepted', taskId: 'root-first', taskDeliveryAttemptId: 'attempt-done', messageId: 'message-done' },
      { id: 'e5', sequence: 5, type: 'task/result', taskId: 'root-first', taskDeliveryAttemptId: 'attempt-done', definitionRevisionId: 'rev', text: 'done' },
    ],
  }
}

function activity(): WorkspaceActivitySnapshot {
  return {
    version: 9, workspaceRevision: 12,
    agents: [
      { agentId: 'alice', status: 'active', usingTool: false },
      { agentId: 'bob', status: 'failed', usingTool: false, error: { code: 'delivery', summary: 'failed' } },
    ],
    activities: [
      { activityId: 'activity-queued', agentId: 'bob', source: { kind: 'task', taskId: 'derived', attemptId: 'attempt-derived' }, messageId: 'message-derived', startOrder: 2, status: 'queued', blocks: [] },
      { activityId: 'activity-task', agentId: 'alice', source: { kind: 'task', taskId: 'root-late', attemptId: 'attempt-2' }, messageId: 'message-2', startOrder: 1, status: 'stopping', claimed: { sessionId: 'session-1', turn: 7 }, blocks: [] },
    ],
  }
}

describe('task center projection', () => {
  it('groups immutable canonical records into deterministic traceable root trees', () => {
    const source = snapshot()
    const stream = activity()
    const originalSnapshot = structuredClone(source)
    const originalActivity = structuredClone(stream)

    const roots = projectTaskRoots(source, stream)

    expect(roots.map(root => root.id)).toEqual(['root-first', 'root-late'])
    expect(roots[1]).toMatchObject({
      id: 'root-late', status: 'open', firstEventSequence: 10,
      assignment: { id: 'assign-late', assignee: { id: 'alice', label: 'Alice' }, assigningActor: { type: 'human', id: 'human-1', label: 'human-1' } },
      grants: [
        { id: 'grant-1', status: 'expired', grantee: { id: 'alice', label: 'Alice' }, grantedBy: { id: 'human-1', label: 'human-1' }, eventSequences: [11, 12] },
        { id: 'grant-active', status: 'active', grantee: { id: 'alice', label: 'Alice' }, grantedBy: { id: 'human-1', label: 'human-1' }, eventSequences: [13] },
      ],
      delivery: { attemptId: 'attempt-1', phase: 'interrupted', failure: { code: 'turn-interrupted', summary: 'Interrupted safely.' }, retryable: true },
      eventSequences: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
    })
    expect(roots[1]?.derivedTasks[0]).toMatchObject({
      id: 'derived', status: 'cancelled', firstEventSequence: 14,
      assignment: { id: 'assign-derived', assignee: { id: 'bob', label: 'Bob' }, assigningActor: { type: 'agent', id: 'alice', label: 'Alice' }, grantId: 'grant-1' },
      children: [{ id: 'child-done', status: 'completed', result: 'child result', eventSequences: [19, 20] }],
      activities: [{ activityId: 'activity-queued', status: 'queued' }],
    })
    expect(roots[1]?.children[0]).toMatchObject({ id: 'child-running', status: 'running', parent: { id: 'alice', label: 'Alice' } })
    expect(roots[1]?.activities[0]).toEqual({
      activityId: 'activity-task', agentId: 'alice', agentLabel: 'Alice', attemptId: 'attempt-2', messageId: 'message-2', status: 'stopping',
      stopIdentity: { activityId: 'activity-task', agentId: 'alice', messageId: 'message-2', sessionId: 'session-1', turn: 7 },
    })
    expect(source).toEqual(originalSnapshot)
    expect(stream).toEqual(originalActivity)
    expect(projectTaskRoots(source, stream)).toEqual(roots)
  })

  it('projects completed delivery and exposes retry only for an open retryable task', () => {
    const roots = projectTaskRoots(snapshot(), activity())
    expect(roots[0]?.delivery).toMatchObject({ attemptId: 'attempt-done', phase: 'completed', retryable: false, result: 'done' })
    expect(roots[1]?.delivery.retryable).toBe(true)
    expect(roots[1]?.derivedTasks[0]?.delivery).toEqual({ phase: 'not-started', retryable: false })
  })

  it.each([
    [['e15'], 'started', false],
    [['e15', 'e16'], 'accepted', false],
    [['e15', 'e16', 'e17'], 'interrupted', true],
  ] as const)('folds canonical delivery events %j to %s', (eventIds, phase, retryable) => {
    const state = snapshot()
    const retained = new Set(['e10', ...eventIds])
    const projected = projectTaskRoots({ ...state, events: state.events.filter(event => retained.has(event.id)) }, activity())
      .find(root => root.id === 'root-late')
    expect(projected?.delivery).toMatchObject({ phase, retryable })
  })

  it('distinguishes a non-interruption delivery failure with its display-safe fields', () => {
    const state = snapshot()
    const events = state.events.filter(event => ['e10', 'e15', 'e16', 'e17'].includes(event.id)).map(event => (
      event.id === 'e17' && event.type === 'task/delivery-failed'
        ? { ...event, failureCode: 'delivery-rejected', failureSummary: 'Could not queue delivery.' }
        : event
    ))
    const delivery = projectTaskRoots({ ...state, events }, activity()).find(root => root.id === 'root-late')?.delivery
    expect(delivery).toEqual({ attemptId: 'attempt-1', phase: 'failed', retryable: true, failure: { code: 'delivery-rejected', summary: 'Could not queue delivery.' } })
  })

  it('retains exact opaque ids instead of deriving identities from labels or positions', () => {
    const root = projectTaskRoots(snapshot(), activity())[1]!
    expect(root.id).toBe('root-late')
    expect(root.assignment?.id).toBe('assign-late')
    expect(root.grants.map(grant => grant.id)).toEqual(['grant-1', 'grant-active'])
    expect(root.children.map(child => child.id)).toEqual(['child-running'])
    expect(root.activities.map(item => item.activityId)).toEqual(['activity-task'])
  })

  it('orders roots by the first related tree event even when that event belongs to a grant', () => {
    const state = snapshot()
    const reordered: WorkspaceSnapshot = {
      ...state,
      events: state.events.map(event => event.id === 'e11' ? { ...event, sequence: 1 } : event),
    }
    const roots = projectTaskRoots(reordered, activity())
    expect(roots.map(root => [root.id, root.firstEventSequence])).toEqual([['root-late', 1], ['root-first', 2]])
  })

  it('rejects an older activity refresh after a newer stream replacement', () => {
    const current = activity()
    const older: WorkspaceActivitySnapshot = { ...current, version: current.version - 1, activities: [] }
    expect(selectNewerActivitySnapshot(current, older)).toBe(current)
    expect(selectNewerActivitySnapshot(older, current)).toBe(current)
  })
})

interface TestElement { readonly type: unknown; readonly props: Readonly<Record<string, unknown>> }
type TestComponent = (props: Readonly<Record<string, unknown>>) => unknown

function componentHarness() {
  const react = createRequire(new URL('../packages/web/package.json', import.meta.url))('react') as { __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: unknown } } }
  const dispatcher = react.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
  const previous = dispatcher.current
  const states: unknown[] = []
  let hook = 0
  dispatcher.current = {
    useState(initial: unknown) {
      const index = hook++
      if (!(index in states)) states[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
      return [states[index], (next: unknown) => { states[index] = typeof next === 'function' ? (next as (value: unknown) => unknown)(states[index]) : next }]
    },
    useMemo(factory: () => unknown) { hook += 1; return factory() },
  }
  const render = (component: TestComponent, props: Readonly<Record<string, unknown>>) => { hook = 0; return component(props) }
  const all = (root: unknown, predicate: (element: TestElement) => boolean): TestElement[] => {
    if (Array.isArray(root)) return root.flatMap(item => all(item, predicate))
    if (typeof root !== 'object' || root === null || !('type' in root) || !('props' in root)) return []
    const element = root as TestElement
    if (typeof element.type === 'function') return all(render(element.type as TestComponent, element.props), predicate)
    return [...(predicate(element) ? [element] : []), ...all(element.props['children'], predicate)]
  }
  return { render, all, restore: () => { dispatcher.current = previous } }
}

describe('task center interactions', () => {
  it('sends current revisions and exact durable identities through named API methods', async () => {
    const original = snapshot()
    const state: WorkspaceSnapshot = { ...original, tasks: { ...original.tasks, 'root-first': { ...original.tasks['root-first']!, status: 'open' }, derived: { ...original.tasks['derived']!, status: 'open' } } }
    const originalStream = activity()
    const stream: WorkspaceActivitySnapshot = { ...originalStream, activities: originalStream.activities.map(item => item.activityId === 'activity-task' ? { ...item, status: 'responding' } : item) }
    const api = {
      assignTask: vi.fn().mockResolvedValue({ revision: 13, value: { state, taskId: 'new-task', taskAssignmentId: 'new-assignment' } }),
      grantTask: vi.fn().mockResolvedValue({ revision: 13, value: { state, delegationGrantId: 'new-grant' } }),
      revokeTask: vi.fn().mockResolvedValue(state), cancelTask: vi.fn().mockResolvedValue(state),
      retryTaskDelivery: vi.fn().mockResolvedValue({ revision: 13, value: 'attempt-new' }),
      stopActivity: vi.fn().mockResolvedValue({ revision: 12, value: { status: 'stopping' } }),
      stopChildRun: vi.fn().mockResolvedValue({ revision: 12, value: { status: 'stopping' } }),
      snapshot: vi.fn().mockResolvedValue(state), activitySnapshot: vi.fn().mockResolvedValue(stream),
    }
    const harness = componentHarness()
    const props = { snapshot: state, activity: stream, api, onSnapshot: vi.fn(), onActivity: vi.fn(), t: (key: string) => key }
    let tree = harness.render(WorkspaceTasks as unknown as TestComponent, props)
    const elements = () => harness.all(tree, () => true)
    const input = elements().find(element => element.type === 'input')!
    ;(input.props['onChange'] as (event: unknown) => void)({ target: { value: 'New root' } })
    tree = harness.render(WorkspaceTasks as unknown as TestComponent, props)
    const select = elements().find(element => element.type === 'select')!
    ;(select.props['onChange'] as (event: unknown) => void)({ target: { value: 'alice' } })
    tree = harness.render(WorkspaceTasks as unknown as TestComponent, props)
    const button = (label: string, occurrence = 0) => elements().filter(element => element.type === 'button' && element.props['children'] === label)[occurrence]!

    ;(button('task.assign').props['onClick'] as () => void)()
    ;(button('task.grant').props['onClick'] as () => void)()
    ;(button('task.revoke').props['onClick'] as () => void)()
    ;(button('task.cancel', 2).props['onClick'] as () => void)()
    ;(button('task.retryDelivery').props['onClick'] as () => void)()
    ;(button('task.stopTurn').props['onClick'] as () => void)()
    ;(button('task.stopChild').props['onClick'] as () => void)()
    await vi.waitFor(() => expect(api.stopChildRun).toHaveBeenCalledOnce())

    expect(api.assignTask).toHaveBeenCalledWith('alice', 'New root', 12)
    expect(api.grantTask).toHaveBeenCalledWith('bob', 'root-first', 12)
    expect(api.revokeTask).toHaveBeenCalledWith('grant-active', 12)
    expect(api.cancelTask).toHaveBeenCalledWith('derived', 12)
    expect(api.retryTaskDelivery).toHaveBeenCalledWith('root-late', 12)
    expect(api.stopActivity).toHaveBeenCalledWith({ activityId: 'activity-task', agentId: 'alice', messageId: 'message-2', sessionId: 'session-1', turn: 7 }, 12)
    expect(api.stopChildRun).toHaveBeenCalledWith('child-running', 12)
    harness.restore()
  })

  it('keeps unrelated controls enabled while one exact request is pending', async () => {
    const original = snapshot()
    const state: WorkspaceSnapshot = { ...original, tasks: { ...original.tasks, 'root-first': { ...original.tasks['root-first']!, status: 'open' } } }
    const stream = activity()
    let resolve!: (value: unknown) => void
    const pending = new Promise(value => { resolve = value })
    const api = {
      cancelTask: vi.fn().mockReturnValue(pending), snapshot: vi.fn().mockResolvedValue(state), activitySnapshot: vi.fn().mockResolvedValue(stream),
    }
    const harness = componentHarness()
    const props = { snapshot: state, activity: stream, api, onSnapshot: vi.fn(), onActivity: vi.fn(), t: (key: string) => key }
    let tree = harness.render(WorkspaceTasks as unknown as TestComponent, props)
    const buttons = () => harness.all(tree, element => element.type === 'button')
    const cancels = buttons().filter(element => element.props['children'] === 'task.cancel')
    ;(cancels[0]!.props['onClick'] as () => void)()
    tree = harness.render(WorkspaceTasks as unknown as TestComponent, props)
    const pendingCancels = buttons().filter(element => element.props['children'] === 'task.cancel')
    expect(pendingCancels).toHaveLength(2)
    expect(pendingCancels[0]?.props['disabled']).toBe(true)
    expect(pendingCancels[1]?.props['disabled']).not.toBe(true)
    resolve(state)
    await pending
    harness.restore()
  })

  it('preserves root assignment input after stale refresh and retries manually with the new revision', async () => {
    const state = snapshot()
    const refreshed: WorkspaceSnapshot = { ...state, revision: 13 }
    const stream = activity()
    const stale = new (await import('../packages/web/src/client/api.ts')).WorkspaceApiError({
      kind: 'business', code: 'stale-revision', message: 'stale', details: { expectedRevision: 12, actualRevision: 13 },
    })
    const api = {
      assignTask: vi.fn().mockRejectedValueOnce(stale).mockResolvedValueOnce({ revision: 14, value: { state: refreshed, taskId: 'new-task', taskAssignmentId: 'new-assignment' } }),
      snapshot: vi.fn().mockResolvedValue(refreshed), activitySnapshot: vi.fn().mockResolvedValue(stream),
    }
    const harness = componentHarness()
    const onSnapshot = vi.fn()
    const baseProps = { activity: stream, api, onSnapshot, onActivity: vi.fn(), t: (key: string) => key }
    let tree = harness.render(WorkspaceTasks as unknown as TestComponent, { ...baseProps, snapshot: state })
    let elements = harness.all(tree, () => true)
    ;(elements.find(element => element.type === 'input')!.props['onChange'] as (event: unknown) => void)({ target: { value: 'Preserved title' } })
    tree = harness.render(WorkspaceTasks as unknown as TestComponent, { ...baseProps, snapshot: state })
    elements = harness.all(tree, () => true)
    ;(elements.find(element => element.type === 'select')!.props['onChange'] as (event: unknown) => void)({ target: { value: 'alice' } })
    tree = harness.render(WorkspaceTasks as unknown as TestComponent, { ...baseProps, snapshot: state })
    elements = harness.all(tree, () => true)
    ;(elements.find(element => element.type === 'button' && element.props['children'] === 'task.assign')!.props['onClick'] as () => void)()
    await vi.waitFor(() => expect(onSnapshot).toHaveBeenCalledWith(refreshed))

    tree = harness.render(WorkspaceTasks as unknown as TestComponent, { ...baseProps, snapshot: refreshed })
    elements = harness.all(tree, () => true)
    expect(elements.find(element => element.type === 'input')?.props['value']).toBe('Preserved title')
    ;(elements.find(element => element.type === 'button' && element.props['children'] === 'workspace.retry')!.props['onClick'] as () => void)()
    await vi.waitFor(() => expect(api.assignTask).toHaveBeenCalledTimes(2))
    expect(api.assignTask.mock.calls.map(call => call[2])).toEqual([12, 13])
    await vi.waitFor(() => {
      tree = harness.render(WorkspaceTasks as unknown as TestComponent, { ...baseProps, snapshot: refreshed })
      expect(harness.all(tree, element => element.type === 'input')[0]?.props['value']).toBe('')
    })
    harness.restore()
  })

  it('treats not-active stop as convergence and refreshes without an error', async () => {
    const state = snapshot()
    const stream = activity()
    const api = {
      stopActivity: vi.fn().mockResolvedValue({ revision: 12, value: { status: 'not-active' } }),
      snapshot: vi.fn().mockResolvedValue(state), activitySnapshot: vi.fn().mockResolvedValue(stream),
    }
    const onSnapshot = vi.fn()
    const onActivity = vi.fn()
    const harness = componentHarness()
    const props = { snapshot: state, activity: stream, api, onSnapshot, onActivity, t: (key: string) => key }
    let tree = harness.render(WorkspaceTasks as unknown as TestComponent, props)
    const stop = harness.all(tree, element => element.type === 'button' && element.props['children'] === 'task.stopTurn')[0]!
    ;(stop.props['onClick'] as () => void)()
    await vi.waitFor(() => expect(api.snapshot).toHaveBeenCalledOnce())
    tree = harness.render(WorkspaceTasks as unknown as TestComponent, props)
    expect(harness.all(tree, element => element.props['role'] === 'alert')).toEqual([])
    expect(onSnapshot).toHaveBeenCalledWith(state)
    expect(onActivity).toHaveBeenCalledWith(stream)
    harness.restore()
  })

  it('renders a safe localized task business error instead of the Host diagnostic', async () => {
    const state = snapshot()
    const stream = activity()
    const business = new (await import('../packages/web/src/client/api.ts')).WorkspaceApiError({
      kind: 'business', code: 'task-not-open', message: 'sensitive upstream diagnostic', details: { taskId: 'root-late', status: 'cancelled' },
    })
    const api = { cancelTask: vi.fn().mockRejectedValue(business) }
    const harness = componentHarness()
    const props = { snapshot: state, activity: stream, api, onSnapshot: vi.fn(), onActivity: vi.fn(), t: (key: string) => key }
    let tree = harness.render(WorkspaceTasks as unknown as TestComponent, props)
    const cancel = harness.all(tree, element => element.type === 'button' && element.props['children'] === 'task.cancel')[0]!
    ;(cancel.props['onClick'] as () => void)()
    await vi.waitFor(() => {
      tree = harness.render(WorkspaceTasks as unknown as TestComponent, props)
      expect(harness.all(tree, element => element.props['role'] === 'alert')[0]?.props['children']).toBe('error.taskNotOpen')
    })
    expect(harness.all(tree, element => element.props['children'] === 'sensitive upstream diagnostic')).toEqual([])
    harness.restore()
  })
})
