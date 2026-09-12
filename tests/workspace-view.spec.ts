import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HumanId, WorkspaceId } from '../packages/host/src/ids.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import { WorkspaceApiClient, WorkspaceApiError } from '../packages/web/src/client/api.ts'
import { en, zh } from '../packages/web/src/client/locales.ts'
import { WorkspaceOverlay } from '../packages/web/src/client/WorkspaceUi.tsx'
import type { WorkspaceTurnStreamSnapshot } from '../packages/web/src/client/contracts.ts'
import {
  activeRoomMembers,
  appendDisplayMention,
  parseMentionIds,
  parseRoomMentionIds,
  roomMessageEvents,
} from '../packages/web/src/client/view-model.ts'

// The composer remains real; only the unused message renderer is replaced
// because its published CSS modules cannot load in the Node test environment.
vi.mock('../packages/web/src/client/WorkspaceTurn.tsx', () => ({
  WorkspaceLiveTurn: ({ turn }: { readonly turn: { readonly sessionId: string; readonly turn: number } }) => ({
    type: 'article',
    props: {
      className: 'dsh-agent-group-message dsh-agent-group-live-turn',
      'data-turn': `${turn.sessionId}:${turn.turn}`,
    },
  }),
  WorkspaceMarkdownMessage: ({ text }: { readonly text: string }) => text,
}))

function workspaceFixture() {
  let state = createInitialState(WorkspaceId('local'))
  const definition = mutateWorkspace(state, {
    type: 'definition/create',
    name: '工程师',
    description: '',
    instructions: '',
  })
  state = definition.state
  const alice = mutateWorkspace(state, { type: 'agent/create', definitionId: definition.definitionId, name: 'Alice' })
  state = alice.state
  const bob = mutateWorkspace(state, { type: 'agent/create', definitionId: definition.definitionId, name: 'Bob' })
  state = bob.state
  const room = mutateWorkspace(state, { type: 'room/create', kind: 'group', name: '研发群' })
  state = room.state
  state = mutateWorkspace(state, { type: 'room/join', roomId: room.roomId, agentId: alice.agentId, memoryStart: { type: 'new-events' } }).state
  state = mutateWorkspace(state, { type: 'room/join', roomId: room.roomId, agentId: bob.agentId, memoryStart: { type: 'new-events' } }).state
  state = mutateWorkspace(state, {
    type: 'room/message',
    roomId: room.roomId,
    actor: { type: 'human', id: HumanId('web-user') },
    text: `Alice 请看一下 <@${bob.agentId}>`,
    mentions: [bob.agentId],
  }).state
  return { state, aliceId: alice.agentId, bobId: bob.agentId, roomId: room.roomId }
}

function roleAliasFixture() {
  let state = createInitialState(WorkspaceId('roles'))
  const productDefinition = mutateWorkspace(state, {
    type: 'definition/create', name: '产品经理', description: '', instructions: '',
  })
  state = productDefinition.state
  const architectDefinition = mutateWorkspace(state, {
    type: 'definition/create', name: '系统架构师', description: '', instructions: '',
  })
  state = architectDefinition.state
  const product = mutateWorkspace(state, {
    type: 'agent/create', definitionId: productDefinition.definitionId, name: '张产品',
  })
  state = product.state
  const architect = mutateWorkspace(state, {
    type: 'agent/create', definitionId: architectDefinition.definitionId, name: '老周',
  })
  state = architect.state
  const room = mutateWorkspace(state, { type: 'room/create', kind: 'group', name: '产品研发群' })
  state = room.state
  state = mutateWorkspace(state, { type: 'room/join', roomId: room.roomId, agentId: product.agentId, memoryStart: { type: 'new-events' } }).state
  state = mutateWorkspace(state, { type: 'room/join', roomId: room.roomId, agentId: architect.agentId, memoryStart: { type: 'new-events' } }).state
  return { state, roomId: room.roomId, productId: product.agentId, architectId: architect.agentId }
}

interface TestElement {
  readonly type: unknown
  readonly props: Readonly<Record<string, unknown>>
}

type TestComponent = (props: Readonly<Record<string, unknown>>) => unknown

const componentHarnessRestorers: Array<() => void> = []

afterEach(() => {
  for (const restore of componentHarnessRestorers.splice(0).reverse()) restore()
})

function componentHarness(initialTurnStream?: WorkspaceTurnStreamSnapshot) {
  const webRequire = createRequire(new URL('../packages/web/package.json', import.meta.url))
  const react = webRequire('react') as {
    __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: {
      ReactCurrentDispatcher: { current: unknown }
    }
  }
  const states = new Map<TestComponent, unknown[]>()
  const effects = new Map<TestComponent, Array<() => void | (() => void)>>()
  let currentState: unknown[] = []
  let currentEffects: Array<() => void | (() => void)> = []
  let hookIndex = 0
  const dispatcher = react.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
  const previousDispatcher = dispatcher.current
  componentHarnessRestorers.push(() => { dispatcher.current = previousDispatcher })
  dispatcher.current = {
    useState(initial: unknown) {
      const index = hookIndex++
      if (!(index in currentState)) {
        const value = typeof initial === 'function' ? (initial as () => unknown)() : initial
        currentState[index] = initialTurnStream !== undefined && isTurnStreamSnapshot(value)
          ? initialTurnStream
          : value
      }
      const owner = currentState
      return [owner[index], (next: unknown) => {
        owner[index] = typeof next === 'function' ? (next as (previous: unknown) => unknown)(owner[index]) : next
      }]
    },
    useEffect(effect: () => void | (() => void)) { hookIndex += 1; currentEffects.push(effect) },
    useMemo(factory: () => unknown) { hookIndex += 1; return factory() },
  }

  const render = (component: TestComponent, props: Readonly<Record<string, unknown>>): unknown => {
    currentState = states.get(component) ?? []
    states.set(component, currentState)
    currentEffects = []
    hookIndex = 0
    const rendered = component(props)
    effects.set(component, currentEffects)
    return rendered
  }

  const find = (root: unknown, predicate: (element: TestElement) => boolean): TestElement | undefined => {
    if (Array.isArray(root)) {
      for (const child of root) {
        const match = find(child, predicate)
        if (match !== undefined) return match
      }
      return undefined
    }
    if (!isTestElement(root)) return undefined
    if (typeof root.type === 'function') return find(render(root.type as TestComponent, root.props), predicate)
    if (predicate(root)) return root
    return find(root.props['children'], predicate)
  }

  const findAll = (root: unknown, predicate: (element: TestElement) => boolean): TestElement[] => {
    if (Array.isArray(root)) return root.flatMap(child => findAll(child, predicate))
    if (!isTestElement(root)) return []
    if (typeof root.type === 'function') return findAll(render(root.type as TestComponent, root.props), predicate)
    return [
      ...(predicate(root) ? [root] : []),
      ...findAll(root.props['children'], predicate),
    ]
  }

  return { effectsFor: (component: TestComponent) => effects.get(component) ?? [], find, findAll, render }
}

function isTestElement(value: unknown): value is TestElement {
  return typeof value === 'object' && value !== null && 'type' in value && 'props' in value
}

function isTurnStreamSnapshot(value: unknown): value is WorkspaceTurnStreamSnapshot {
  return typeof value === 'object'
    && value !== null
    && 'version' in value
    && 'workspaceRevision' in value
    && 'turns' in value
}

function translate(dictionary: typeof zh | typeof en) {
  return (key: keyof typeof zh, params?: Readonly<Record<string, string | number>>): string =>
    dictionary[key].replace(/\{([^}]+)\}/g, (_token, name: string) => String(params?.[name] ?? `{${name}}`))
}

function pendingPromise<T>(): { readonly promise: Promise<T>; readonly reject: (reason: unknown) => void } {
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((_resolve, rejectPromise) => { reject = rejectPromise })
  return { promise, reject }
}

function settlementFixture() {
  const fixture = workspaceFixture()
  const beforeSettlement = fixture.state
  const afterSettlement = mutateWorkspace(beforeSettlement, {
    type: 'room/message',
    roomId: fixture.roomId,
    actor: { type: 'agent', id: fixture.aliceId },
    text: 'done',
    mentions: [],
  }).state
  const laggingStream: WorkspaceTurnStreamSnapshot = {
    version: 4,
    workspaceRevision: beforeSettlement.revision,
    turns: [{
      roomId: fixture.roomId,
      agentId: fixture.aliceId,
      sessionId: 'alice-session',
      turn: 3,
      status: 'settled',
      blocks: [{ kind: 'text', index: 0, text: 'done' }],
      stopReason: 'completed',
    }],
  }
  const retiredStream: WorkspaceTurnStreamSnapshot = {
    version: 5,
    workspaceRevision: afterSettlement.revision,
    turns: [],
  }
  return { fixture, beforeSettlement, afterSettlement, laggingStream, retiredStream }
}

describe('workspace UI view model', () => {
  const t = (key: string) => key

  it('labels agent rows as accessible groups in chat and definition views', () => {
    const fixture = workspaceFixture()
    const definitionId = Object.keys(fixture.state.definitions)[0]
    expect(definitionId).toBeDefined()
    const actions = {
      close: vi.fn(),
      setMode: vi.fn(),
      selectRoom: vi.fn(),
      selectDefinition: vi.fn(),
      setSnapshot: vi.fn(),
      setBusy: vi.fn(),
      setError: vi.fn(), setRetry: vi.fn(),
    }
    const renderMode = (mode: 'conversations' | 'colleagues') => {
      const harness = componentHarness()
      const tree = harness.render(WorkspaceOverlay as unknown as TestComponent, {
        useStore: (selector: (state: unknown) => unknown) => selector({
          open: true,
          mode,
          selectedRoomId: fixture.roomId,
          selectedDefinitionId: definitionId,
          snapshot: fixture.state,
          busy: false,
        }),
        actions,
        api: {},
        t,
      })
      return harness.findAll(tree, element => element.props['role'] === 'group')
    }

    expect(renderMode('conversations').map(element => element.props['aria-label'])).toEqual(['Alice', 'Bob'])
    expect(renderMode('colleagues').map(element => element.props['aria-label'])).toEqual(['Alice', 'Bob'])
  })

  it('names the member panel and its candidate combobox for browser automation', () => {
    const fixture = workspaceFixture()
    const definitionId = Object.keys(fixture.state.definitions)[0]
    expect(definitionId).toBeDefined()
    const withCandidate = mutateWorkspace(fixture.state, {
      type: 'agent/create', definitionId: definitionId!, name: 'Carol',
    }).state
    const harness = componentHarness()
    const tree = harness.render(WorkspaceOverlay as unknown as TestComponent, {
      useStore: (selector: (state: unknown) => unknown) => selector({
        open: true,
        mode: 'conversations',
        selectedRoomId: fixture.roomId,
        selectedDefinitionId: undefined,
        snapshot: withCandidate,
        busy: false,
      }),
      actions: {
        close: vi.fn(), setMode: vi.fn(), selectRoom: vi.fn(), selectDefinition: vi.fn(), setSnapshot: vi.fn(), setBusy: vi.fn(), setError: vi.fn(), setRetry: vi.fn(),
      },
      api: {},
      t,
    })

    const memberPanel = harness.findAll(tree, element => element.type === 'aside')
      .find(element => element.props['aria-label'] === 'room.groupMembers')
    const candidate = harness.find(tree, element => element.type === 'select')
    expect(memberPanel).toBeDefined()
    expect(candidate?.props['aria-label']).toBe('room.addAgent')
  })

  it('starts each membership join without a memory default', () => {
    const fixture = workspaceFixture()
    const definitionId = Object.keys(fixture.state.definitions)[0]
    expect(definitionId).toBeDefined()
    const withCandidate = mutateWorkspace(fixture.state, {
      type: 'agent/create', definitionId: definitionId!, name: 'Carol',
    }).state
    const harness = componentHarness()
    const tree = harness.render(WorkspaceOverlay as unknown as TestComponent, {
      useStore: (selector: (state: unknown) => unknown) => selector({
        open: true,
        mode: 'conversations',
        selectedRoomId: fixture.roomId,
        selectedDefinitionId: undefined,
        snapshot: withCandidate,
        busy: false,
      }),
      actions: {
        close: vi.fn(), setMode: vi.fn(), selectRoom: vi.fn(), selectDefinition: vi.fn(), setSnapshot: vi.fn(), setBusy: vi.fn(), setError: vi.fn(), setRetry: vi.fn(),
      },
      api: {},
      t,
    })

    const memoryStart = harness.find(tree, element => element.type === 'select' && element.props['aria-label'] === 'room.memoryStart')
    const join = harness.find(tree, element => element.type === 'button' && element.props['children'] === 'room.join')
    expect(memoryStart?.props['value']).toBe('')
    expect(harness.findAll(memoryStart, element => element.type === 'option').map(option => [
      option.props['value'], option.props['children'], option.props['disabled'],
    ])).toEqual([
      ['', 'room.selectMemoryStart', true],
      ['new-events', 'room.memoryNewEvents', undefined],
      ['event-range', 'room.memoryEventRange', undefined],
    ])
    expect(join?.props['disabled']).toBe(true)
  })

  it('requires a valid human-selected historical range before joining a group', async () => {
    const fixture = workspaceFixture()
    const definitionId = Object.keys(fixture.state.definitions)[0]
    expect(definitionId).toBeDefined()
    const withCandidate = mutateWorkspace(fixture.state, {
      type: 'agent/create', definitionId: definitionId!, name: 'Carol',
    }).state
    const carolId = Object.keys(withCandidate.agents).find(id => withCandidate.agents[id]?.name === 'Carol')
    expect(carolId).toBeDefined()
    const ui: Record<string, unknown> = {
      open: true,
      mode: 'conversations',
      selectedRoomId: fixture.roomId,
      selectedDefinitionId: undefined,
      snapshot: withCandidate,
      busy: false,
    }
    const actions = {
      close: vi.fn(),
      setMode: vi.fn(),
      selectRoom: vi.fn(),
      selectDefinition: vi.fn(),
      setSnapshot: vi.fn((snapshot: unknown) => { ui['snapshot'] = snapshot }),
      setBusy: vi.fn((busy: boolean) => { ui['busy'] = busy }),
      setError: vi.fn(), setRetry: vi.fn(),
    }
    const api = { joinRoom: vi.fn(async () => withCandidate) }
    const harness = componentHarness()
    const render = (): unknown => harness.render(WorkspaceOverlay as unknown as TestComponent, {
      useStore: (selector: (state: unknown) => unknown) => selector(ui),
      actions,
      api,
      t,
    })

    let tree = render()
    const candidate = harness.find(tree, element => element.type === 'select' && element.props['aria-label'] === 'room.addAgent')
    const memoryStart = harness.find(tree, element => element.type === 'select' && element.props['aria-label'] === 'room.memoryStart')
    expect(candidate).toBeDefined()
    expect(memoryStart).toBeDefined()
    expect(memoryStart?.props['value']).toBe('')
    ;(candidate!.props['onChange'] as (event: unknown) => void)({ target: { value: carolId } })
    ;(memoryStart!.props['onChange'] as (event: unknown) => void)({ target: { value: 'event-range' } })

    tree = render()
    const start = harness.find(tree, element => element.type === 'input' && element.props['aria-label'] === 'room.startSequence')
    const end = harness.find(tree, element => element.type === 'input' && element.props['aria-label'] === 'room.endSequence')
    expect(start).toBeDefined()
    expect(end).toBeDefined()
    expect(start?.props['type']).toBe('number')
    expect(end?.props['type']).toBe('number')
    ;(start!.props['onChange'] as (event: unknown) => void)({ target: { value: '4' } })
    ;(end!.props['onChange'] as (event: unknown) => void)({ target: { value: '3' } })

    tree = render()
    let join = harness.find(tree, element => element.type === 'button' && element.props['children'] === 'room.join')
    expect(join?.props['disabled']).toBe(true)
    let renderedEnd = harness.find(tree, element => element.type === 'input' && element.props['aria-label'] === 'room.endSequence')!
    ;(renderedEnd.props['onChange'] as (event: unknown) => void)({ target: { value: '999' } })

    tree = render()
    join = harness.find(tree, element => element.type === 'button' && element.props['children'] === 'room.join')
    expect(join?.props['disabled']).toBe(true)
    renderedEnd = harness.find(tree, element => element.type === 'input' && element.props['aria-label'] === 'room.endSequence')!
    ;(renderedEnd.props['onChange'] as (event: unknown) => void)({ target: { value: '5' } })

    tree = render()
    join = harness.find(tree, element => element.type === 'button' && element.props['children'] === 'room.join')
    expect(join?.props['disabled']).toBe(false)
    ;(join!.props['onClick'] as () => void)()
    await vi.waitFor(() => expect(api.joinRoom).toHaveBeenCalledWith(
      fixture.roomId,
      carolId,
      { type: 'event-range', startSequence: 4, endSequence: 5 },
      withCandidate.revision,
    ))
  })

  it('clears the selected memory start when the candidate changes', () => {
    const fixture = workspaceFixture()
    const definitionId = Object.keys(fixture.state.definitions)[0]
    expect(definitionId).toBeDefined()
    const carol = mutateWorkspace(fixture.state, {
      type: 'agent/create', definitionId: definitionId!, name: 'Carol',
    })
    const dave = mutateWorkspace(carol.state, {
      type: 'agent/create', definitionId: definitionId!, name: 'Dave',
    })
    const harness = componentHarness()
    const props = {
      useStore: (selector: (state: unknown) => unknown) => selector({
        open: true,
        mode: 'conversations',
        selectedRoomId: fixture.roomId,
        selectedDefinitionId: undefined,
        snapshot: dave.state,
        busy: false,
      }),
      actions: {
        close: vi.fn(), setMode: vi.fn(), selectRoom: vi.fn(), selectDefinition: vi.fn(), setSnapshot: vi.fn(), setBusy: vi.fn(), setError: vi.fn(), setRetry: vi.fn(),
      },
      api: {},
      t,
    }
    const render = (): unknown => harness.render(WorkspaceOverlay as unknown as TestComponent, props)

    let tree = render()
    let candidate = harness.find(tree, element => element.type === 'select' && element.props['aria-label'] === 'room.addAgent')!
    let memoryStart = harness.find(tree, element => element.type === 'select' && element.props['aria-label'] === 'room.memoryStart')!
    ;(candidate.props['onChange'] as (event: unknown) => void)({ target: { value: carol.agentId } })
    ;(memoryStart.props['onChange'] as (event: unknown) => void)({ target: { value: 'new-events' } })

    tree = render()
    expect(harness.find(tree, element => element.type === 'button' && element.props['children'] === 'room.join')?.props['disabled']).toBe(false)
    candidate = harness.find(tree, element => element.type === 'select' && element.props['aria-label'] === 'room.addAgent')!
    ;(candidate.props['onChange'] as (event: unknown) => void)({ target: { value: dave.agentId } })

    tree = render()
    memoryStart = harness.find(tree, element => element.type === 'select' && element.props['aria-label'] === 'room.memoryStart')!
    expect(memoryStart.props['value']).toBe('')
    expect(harness.find(tree, element => element.type === 'button' && element.props['children'] === 'room.join')?.props['disabled']).toBe(true)
  })

  it('renders one agent row across pre-commit, racing, and retired settlement snapshots', () => {
    const { fixture, beforeSettlement, afterSettlement, laggingStream, retiredStream } = settlementFixture()
    const ui = {
      open: true,
      mode: 'conversations' as const,
      selectedRoomId: fixture.roomId,
      snapshot: afterSettlement,
      busy: false,
    }
    const actions = {
      close: vi.fn(),
      setMode: vi.fn(),
      selectRoom: vi.fn(),
      selectDefinition: vi.fn(),
      setSnapshot: vi.fn(),
      setBusy: vi.fn(),
      setError: vi.fn(), setRetry: vi.fn(),
    }
    const props = { useStore: (selector: (state: unknown) => unknown) => selector(ui), actions, api: {}, t }
    const isMessageRow = (element: TestElement): boolean => element.props['className'] === 'dsh-agent-group-message'
      || element.props['className'] === 'dsh-agent-group-message dsh-agent-group-live-turn'

    const beforeHarness = componentHarness(laggingStream)
    const beforeTree = beforeHarness.render(WorkspaceOverlay as unknown as TestComponent, {
      ...props,
      useStore: (selector: (state: unknown) => unknown) => selector({ ...ui, snapshot: beforeSettlement }),
    })
    expect(beforeHarness.findAll(beforeTree, isMessageRow)).toHaveLength(2)

    const racingHarness = componentHarness(laggingStream)
    const racingTree = racingHarness.render(WorkspaceOverlay as unknown as TestComponent, props)
    expect(racingHarness.findAll(racingTree, isMessageRow)).toHaveLength(2)

    const retiredHarness = componentHarness(retiredStream)
    const retiredTree = retiredHarness.render(WorkspaceOverlay as unknown as TestComponent, props)
    expect(retiredHarness.findAll(retiredTree, isMessageRow)).toHaveLength(2)
  })

  it('refetches durable state when a reconnect observes stream retirement first', async () => {
    const { fixture, beforeSettlement, afterSettlement, retiredStream } = settlementFixture()
    const ui = {
      open: true,
      mode: 'conversations' as const,
      selectedRoomId: fixture.roomId,
      snapshot: beforeSettlement,
      busy: false,
    }
    const actions = {
      close: vi.fn(),
      setMode: vi.fn(),
      selectRoom: vi.fn(),
      selectDefinition: vi.fn(),
      setSnapshot: vi.fn(),
      setBusy: vi.fn(),
      setError: vi.fn(), setRetry: vi.fn(),
    }
    const waitStarted = Promise.withResolvers<void>()
    const pendingWait = pendingPromise<WorkspaceTurnStreamSnapshot>()
    const controllerRejected = new Error('observer cancelled')
    const reconnectApi = {
      snapshot: vi.fn()
        .mockResolvedValueOnce(beforeSettlement)
        .mockResolvedValueOnce(afterSettlement),
      activitySnapshot: vi.fn(async () => ({
        version: retiredStream.version,
        workspaceRevision: retiredStream.workspaceRevision,
        activities: [],
        agents: [],
      })),
      waitForActivity: vi.fn((_version: number, signal: AbortSignal) => {
        signal.addEventListener('abort', () => pendingWait.reject(controllerRejected), { once: true })
        waitStarted.resolve()
        return pendingWait.promise
      }),
    }
    const reconnectHarness = componentHarness()
    reconnectHarness.render(WorkspaceOverlay as unknown as TestComponent, {
      useStore: (selector: (state: unknown) => unknown) => selector(ui),
      actions,
      api: reconnectApi,
      t,
    })
    const subscription = reconnectHarness.effectsFor(WorkspaceOverlay as unknown as TestComponent)[0]
    if (subscription === undefined) throw new Error('expected stream subscription effect')
    const cleanup = subscription()
    await waitStarted.promise
    expect(reconnectApi.snapshot).toHaveBeenCalledTimes(2)
    expect(actions.setSnapshot).toHaveBeenLastCalledWith(afterSettlement)
    expect(actions.setMode).not.toHaveBeenCalled()
    if (typeof cleanup === 'function') cleanup()
    await Promise.resolve()
  })

  it('reformats a raw stream failure exactly once after the locale changes', async () => {
    const fixture = workspaceFixture()
    const ui: Record<string, unknown> = {
      open: true,
      mode: 'conversations',
      selectedRoomId: fixture.roomId,
      snapshot: fixture.state,
      busy: false,
    }
    const actions = {
      close: vi.fn(),
      setMode: vi.fn(),
      selectRoom: vi.fn(),
      selectDefinition: vi.fn(),
      setSnapshot: vi.fn((snapshot: unknown) => { ui['snapshot'] = snapshot }),
      setBusy: vi.fn((busy: boolean) => { ui['busy'] = busy }),
      setError: vi.fn((error: unknown) => { ui['error'] = error }),
    }
    const stream = { version: 0, workspaceRevision: fixture.state.revision, activities: [], agents: [] }
    const api = {
      snapshot: vi.fn(async () => fixture.state),
      activitySnapshot: vi.fn(async () => stream),
      waitForActivity: vi.fn(async () => { throw new Error('upstream detail') }),
    }
    const harness = componentHarness()
    harness.render(WorkspaceOverlay as unknown as TestComponent, {
      useStore: (selector: (state: unknown) => unknown) => selector(ui),
      actions,
      api,
      t: translate(zh),
    })
    const subscription = harness.effectsFor(WorkspaceOverlay as unknown as TestComponent)[0]
    if (subscription === undefined) throw new Error('expected stream subscription effect')
    const cleanup = subscription()
    await vi.waitFor(() => expect(api.waitForActivity).toHaveBeenCalledOnce())

    const rerendered = harness.render(WorkspaceOverlay as unknown as TestComponent, {
      useStore: (selector: (state: unknown) => unknown) => selector(ui),
      actions,
      api,
      t: translate(en),
    })
    const errors = harness.findAll(rerendered, element => element.props['className'] === 'dsh-agent-group-error')
    expect(errors.map(error => error.props['children'])).toEqual(['Live status connection failed: upstream detail'])
    expect(actions.setError).not.toHaveBeenCalledWith(expect.any(Error))
    if (typeof cleanup === 'function') cleanup()
  })

  it('preserves stable business error code and details from the Host', async () => {
    const client = new WorkspaceApiClient({
      rpc: {
        call: async () => ({
          ok: false,
          error: {
            kind: 'business',
            code: 'reserved-direct-routing',
            message: 'reserved-direct-routing',
            details: { roomId: 'room-direct', token: '@all' },
          },
        }),
      },
    } as never)

    let caught: unknown
    try {
      await client.postMessage('room-direct', '@all hello', [], 1)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(WorkspaceApiError)
    expect(caught).toMatchObject({
      kind: 'business',
      code: 'reserved-direct-routing',
      details: { roomId: 'room-direct', token: '@all' },
    })
  })

  it('keeps the direct-room draft when the real composer receives a business failure', async () => {
    const fixture = workspaceFixture()
    const direct = mutateWorkspace(fixture.state, { type: 'room/create', kind: 'direct' })
    const joined = mutateWorkspace(direct.state, {
      type: 'room/join', roomId: direct.roomId, agentId: fixture.aliceId, memoryStart: { type: 'new-events' },
    }).state
    const ui: Record<string, unknown> = {
      open: true,
      mode: 'conversations',
      selectedRoomId: direct.roomId,
      snapshot: joined,
      busy: false,
    }
    const actions = {
      close: vi.fn(),
      setMode: vi.fn(),
      selectRoom: vi.fn(),
      selectDefinition: vi.fn(),
      setSnapshot: vi.fn((snapshot: unknown) => { ui['snapshot'] = snapshot }),
      setBusy: vi.fn((busy: boolean) => { ui['busy'] = busy }),
      setError: vi.fn((error: unknown) => { ui['error'] = error }),
    }
    const api = {
      postMessage: vi.fn(async () => {
        throw new WorkspaceApiError({
          kind: 'business',
          code: 'reserved-direct-routing',
          message: 'reserved-direct-routing',
          details: { roomId: direct.roomId, token: '@all' },
        })
      }),
    }
    const props = {
      useStore: (selector: (state: unknown) => unknown) => selector(ui),
      actions,
      api,
      t,
    }
    const harness = componentHarness()
    const renderOverlay = (): unknown => harness.render(WorkspaceOverlay as unknown as TestComponent, props)

    let tree = renderOverlay()
    const textarea = harness.find(tree, element => element.type === 'textarea')
    expect(textarea).toBeDefined()
    ;(textarea!.props['onChange'] as (event: unknown) => void)({ target: { value: '@all hello' } })

    tree = renderOverlay()
    const composer = harness.find(tree, element => element.props['className'] === 'dsh-agent-group-compose-row')
    expect(composer).toBeDefined()
    const send = harness.find(composer, element => element.type === 'button')
    expect(send).toBeDefined()
    ;(send!.props['onClick'] as () => void)()
    await vi.waitFor(() => expect(ui['error']).toBeInstanceOf(WorkspaceApiError))
    expect(api.postMessage).toHaveBeenCalledWith(direct.roomId, '@all hello', [], joined.revision)
    expect(actions.setSnapshot).not.toHaveBeenCalled()

    tree = renderOverlay()
    const retained = harness.find(tree, element => element.type === 'textarea')
    expect(retained?.props['value']).toBe('@all hello')
  })

  it('refreshes once after a stale write and retries only after the user asks', async () => {
    const fixture = workspaceFixture()
    const refreshed = { ...fixture.state, revision: fixture.state.revision + 1 }
    const ui: Record<string, unknown> = {
      open: true,
      mode: 'conversations',
      selectedRoomId: fixture.roomId,
      snapshot: fixture.state,
      busy: false,
    }
    const actions = {
      close: vi.fn(), setMode: vi.fn(), selectRoom: vi.fn(), selectDefinition: vi.fn(),
      setSnapshot: vi.fn((snapshot: unknown) => { ui['snapshot'] = snapshot }),
      setBusy: vi.fn((busy: boolean) => { ui['busy'] = busy }),
      setError: vi.fn((error: unknown) => { ui['error'] = error }),
      setRetry: vi.fn((retry: unknown) => { ui['retry'] = retry }),
    }
    const stale = new WorkspaceApiError({
      kind: 'business', code: 'stale-revision', message: 'stale',
      details: { expectedRevision: fixture.state.revision, actualRevision: refreshed.revision },
    })
    const api = {
      snapshot: vi.fn(async () => refreshed),
      postMessage: vi.fn()
        .mockRejectedValueOnce(stale)
        .mockResolvedValueOnce(refreshed),
    }
    const harness = componentHarness()
    const render = (): unknown => harness.render(WorkspaceOverlay as unknown as TestComponent, {
      useStore: (selector: (state: unknown) => unknown) => selector(ui), actions, api, t,
    })

    let tree = render()
    const draft = harness.find(tree, element => element.type === 'textarea')!
    ;(draft.props['onChange'] as (event: unknown) => void)({ target: { value: 'keep this draft' } })
    tree = render()
    const composer = harness.find(tree, element => element.props['className'] === 'dsh-agent-group-compose-row')!
    ;(harness.find(composer, element => element.type === 'button')!.props['onClick'] as () => void)()

    await vi.waitFor(() => expect(api.snapshot).toHaveBeenCalledOnce())
    expect(api.postMessage).toHaveBeenCalledTimes(1)
    tree = render()
    expect(harness.find(tree, element => element.type === 'textarea')?.props['value']).toBe('keep this draft')
    const retry = harness.find(tree, element => element.type === 'button' && element.props['children'] === 'workspace.retry')
    expect(retry).toBeDefined()
    ;(retry!.props['onClick'] as () => void)()
    await vi.waitFor(() => expect(api.postMessage).toHaveBeenCalledTimes(2))
    expect(api.postMessage.mock.calls.map(call => call[3])).toEqual([
      fixture.state.revision,
      refreshed.revision,
    ])
  })

  it('projects only active memberships for the selected room', () => {
    const fixture = workspaceFixture()
    expect(activeRoomMembers(fixture.state, fixture.roomId).map(agent => agent.name)).toEqual(['Alice', 'Bob'])
    const membership = Object.values(fixture.state.memberships).find(entry => entry.roomId === fixture.roomId && entry.agentId === fixture.bobId)
    expect(membership).toBeDefined()
    const left = mutateWorkspace(fixture.state, { type: 'room/leave', membershipId: membership!.id }).state
    expect(activeRoomMembers(left, fixture.roomId).map(agent => agent.name)).toEqual(['Alice'])
  })

  it('projects only room message events for the selected room', () => {
    const fixture = workspaceFixture()
    const messages = roomMessageEvents(fixture.state, fixture.roomId)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.text).toContain('Alice 请看一下')
    expect(messages[0]?.actor).toEqual({ type: 'human', id: 'web-user' })
  })

  it('extracts canonical agent mentions in order without duplicates', () => {
    expect(parseMentionIds('先问 <@agent-2>，再问 <@agent-4>，最后还是 <@agent-2>')).toEqual(['agent-2', 'agent-4'])
  })

  it('resolves visible @member names to active room agent ids', () => {
    const fixture = workspaceFixture()
    expect(parseRoomMentionIds(fixture.state, fixture.roomId, '先请 @Alice 看一下，再让 @Bob 复核。')).toEqual([
      fixture.aliceId,
      fixture.bobId,
    ])
    expect(parseRoomMentionIds(
      fixture.state,
      fixture.roomId,
      `兼容旧标记 <@${fixture.bobId}>，同时 @Alice，重复 @Alice 不应重复触发。`,
    )).toEqual([fixture.bobId, fixture.aliceId])
  })

  it('resolves group @all to every active employed member in room order', () => {
    const fixture = workspaceFixture()
    expect(parseRoomMentionIds(fixture.state, fixture.roomId, '@all 请大家一起评审。')).toEqual([
      fixture.aliceId,
      fixture.bobId,
    ])
    expect(parseRoomMentionIds(fixture.state, fixture.roomId, '@all @Alice 请大家一起评审。')).toEqual([
      fixture.aliceId,
      fixture.bobId,
    ])
  })

  it('excludes departed members from group @all and never expands @all in a direct room', () => {
    const fixture = workspaceFixture()
    const departed = mutateWorkspace(fixture.state, { type: 'agent/depart', agentId: fixture.bobId }).state
    expect(parseRoomMentionIds(departed, fixture.roomId, '@all')).toEqual([fixture.aliceId])

    const direct = mutateWorkspace(fixture.state, { type: 'room/create', kind: 'direct' })
    const joined = mutateWorkspace(direct.state, {
      type: 'room/join', roomId: direct.roomId, agentId: fixture.aliceId, memoryStart: { type: 'new-events' },
    }).state
    expect(parseRoomMentionIds(joined, direct.roomId, '@all')).toEqual([])
  })

  it('resolves a unique role name while refusing an ambiguous role alias', () => {
    const roles = roleAliasFixture()
    expect(parseRoomMentionIds(roles.state, roles.roomId, '@产品经理 先分析，@系统架构师 再设计。')).toEqual([
      roles.productId,
      roles.architectId,
    ])

    const shared = workspaceFixture()
    expect(parseRoomMentionIds(shared.state, shared.roomId, '@工程师 请处理')).toEqual([])
  })

  it('appends a human-readable mention token instead of exposing an internal agent id', () => {
    expect(appendDisplayMention('', '张产品')).toBe('@张产品 ')
    expect(appendDisplayMention('请处理', '张产品')).toBe('请处理 @张产品 ')
    expect(appendDisplayMention('@张产品 ', '张产品')).toBe('@张产品 ')
    expect(appendDisplayMention('', '张产品')).not.toContain('<@')
  })
})
