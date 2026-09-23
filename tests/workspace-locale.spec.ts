import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceApiError } from '../packages/web/src/client/api.ts'
import type { WorkspaceTurnProjection } from '../packages/web/src/client/contracts.ts'
import { apply, inject } from '../packages/web/src/client/index.ts'
import { WorkspaceFooterAction, WorkspaceOverlay } from '../packages/web/src/client/WorkspaceUi.tsx'
import { WorkspaceLiveTurn, WorkspaceMarkdownMessage } from '../packages/web/src/client/WorkspaceTurn.tsx'
import { WorkspaceTasks } from '../packages/web/src/client/WorkspaceTasks.tsx'
import { WorkspaceMemory } from '../packages/web/src/client/WorkspaceMemory.tsx'
import { WorkspaceDefinitionHistory } from '../packages/web/src/client/WorkspaceDefinitionHistory.tsx'
import { WorkspaceActivityDrawer } from '../packages/web/src/client/WorkspaceActivityDrawer.tsx'
import { projectWorkspaceActivity } from '../packages/web/src/client/activity-view-model.ts'
import type { WorkspaceActivitySnapshot, WorkspaceSnapshot } from '../packages/web/src/client/contracts.ts'

const browserRuntime = vi.hoisted(() => {
  const publishedLocale: Record<string, unknown> = {}
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __ModuleLoader__: {
        load(module: { readonly factory: (require: (id: string) => unknown) => Record<string, unknown> }) {
          const bundle = module as { readonly id?: string; readonly factory: (require: (id: string) => unknown) => Record<string, unknown> }
          if (bundle.id === '@deepseek-ai/dsh-client-locale') {
            Object.assign(publishedLocale, bundle.factory(id => id === '@deepseek-ai/dsh-client-store'
              ? { defineStore: (definition: unknown) => ({ definition }) }
              : {}))
            return
          }
          throw new Error(`unexpected client bundle: ${bundle.id ?? 'unknown'}`)
        },
      },
    },
  })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { languages: ['en'], language: 'en' },
  })
  return { navigatorDescriptor, publishedLocale, windowDescriptor }
})

const { publishedLocale } = browserRuntime

afterAll(() => {
  if (browserRuntime.windowDescriptor === undefined) Reflect.deleteProperty(globalThis, 'window')
  else Object.defineProperty(globalThis, 'window', browserRuntime.windowDescriptor)
  if (browserRuntime.navigatorDescriptor === undefined) Reflect.deleteProperty(globalThis, 'navigator')
  else Object.defineProperty(globalThis, 'navigator', browserRuntime.navigatorDescriptor)
})

type LocaleRuntimeInstance = {
  setLocale(id: string): void
  bind(ns: string): (key: string, params?: Readonly<Record<string, string | number>>) => string
  register(ns: string, dictionaries: Readonly<Record<string, Readonly<Record<string, string>>>>): () => void
}

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  DisclosureRow: (props: Readonly<Record<string, unknown>>) => ({ type: 'section', props }),
  MarkdownText: ({ text }: { readonly text: string }) => text,
}))

vi.mock('@deepseek-ai/dsh-client-store', () => ({
  defineStore: (definition: { readonly init: () => unknown }) => ({ definition }),
}))

const localeClientPath = createRequire(new URL('../package.json', import.meta.url)).resolve('@deepseek-ai/dsh-client-locale/client')
new Function(readFileSync(localeClientPath, 'utf8'))()
if (typeof publishedLocale['LocaleRuntime'] !== 'function') {
  throw new Error(`locale runtime did not publish: ${Object.keys(publishedLocale).join(', ')}`)
}
const LocaleRuntime = publishedLocale['LocaleRuntime'] as new (ctx: Context) => LocaleRuntimeInstance

interface TestElement {
  readonly type: unknown
  readonly props: Readonly<Record<string, unknown>>
}

type TestComponent = (props: Readonly<Record<string, unknown>>) => unknown

const restorers: Array<() => void> = []

afterEach(() => {
  for (const restore of restorers.splice(0).reverse()) restore()
})

function renderHarness() {
  const webRequire = createRequire(new URL('../packages/web/package.json', import.meta.url))
  const react = webRequire('react') as {
    __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: {
      ReactCurrentDispatcher: { current: unknown }
    }
  }
  const dispatcher = react.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
  const previous = dispatcher.current
  restorers.push(() => { dispatcher.current = previous })
  let states: unknown[] = []
  let hook = 0
  dispatcher.current = {
    useState(initial: unknown) {
      const index = hook++
      if (!(index in states)) states[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
      return [states[index], (next: unknown) => {
        states[index] = typeof next === 'function'
          ? (next as (previousValue: unknown) => unknown)(states[index])
          : next
      }]
    },
    useRef(initial: unknown) {
      const index = hook++
      if (!(index in states)) states[index] = { current: initial }
      return states[index]
    },
    useEffect() { hook += 1 },
    useLayoutEffect() { hook += 1 },
    useMemo(factory: () => unknown) { hook += 1; return factory() },
  }
  return (component: TestComponent, props: Readonly<Record<string, unknown>>): unknown => {
    hook = 0
    return component(props)
  }
}

function strings(root: unknown): string[] {
  if (typeof root === 'string') return [root]
  if (Array.isArray(root)) return root.flatMap(strings)
  if (!isElement(root)) return []
  const attributes = ['aria-label', 'title', 'placeholder']
    .map(key => root.props[key])
    .filter((value): value is string => typeof value === 'string')
  return [...attributes, ...strings(root.props['children'])]
}

function isElement(value: unknown): value is TestElement {
  return typeof value === 'object' && value !== null && 'type' in value && 'props' in value
}

function registerPlugin(locale: LocaleRuntimeInstance) {
  const entries: Array<{ readonly options: Record<string, unknown>; readonly component: TestComponent }> = []
  const disposers: Array<() => void> = []
  const ctx = {
    locale,
    get: () => ({ rpc: { call: vi.fn() } }),
    effect: (effect: () => void | (() => void)) => {
      const dispose = effect()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    slots: {
      inject: (_name: string, register: () => unknown) => { register() },
      register: (options: Record<string, unknown>, component: TestComponent) => {
        entries.push({ options, component })
        return () => {}
      },
    },
  }
  apply(ctx as never)
  return { entries, dispose: () => disposers.reverse().forEach(dispose => dispose()) }
}

const liveTurn: WorkspaceTurnProjection = {
  activityId: 'activity-1',
  roomId: 'room-1',
  agentId: 'agent-1',
  sessionId: 'session-1',
  turn: 1,
  status: 'running',
  blocks: [],
}

describe('Agent Workspace locale runtime', () => {
  it.each([
    ['zh', { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }],
    ['en', { code: { copyLabel: 'Copy', copiedLabel: 'Copied' }, footnotes: 'Footnotes' }],
  ] as const)('supplies current Markdown chrome labels in %s', (localeId, expected) => {
    const locale = new LocaleRuntime(new Context())
    locale.setLocale(localeId)
    const registered = registerPlugin(locale)
    const t = locale.bind('agentWorkspace' as never)
    const markdown = WorkspaceMarkdownMessage({ text: 'hello', t } as never)
    expect(markdown.props.labels).toEqual(expected)
    registered.dispose()
  })

  it.each([
    ['zh', ['智能体工作区', '打开智能体工作区', '会话', '同事', '任务', '记忆', '打开运行状态', '正在读取智能体工作区…', '正在回复…', '正在思考…', '工作区请求失败。']],
    ['en', ['Agent Workspace', 'Open Agent Workspace', 'Conversations', 'Colleagues', 'Tasks', 'Memory', 'Open runtime activity', 'Loading Agent Workspace…', 'Replying…', 'Thinking…', 'Workspace request failed.']],
  ] as const)('renders footer, overlay, live, empty, error and accessibility copy in %s', (localeId, expected) => {
    const locale = new LocaleRuntime(new Context())
    locale.setLocale(localeId)
    const registered = registerPlugin(locale)
    const t = locale.bind('agentWorkspace' as never)
    const render = renderHarness()
    const actions = { open: vi.fn(), close: vi.fn(), setMode: vi.fn(), selectRoom: vi.fn(), selectDefinition: vi.fn(), setSnapshot: vi.fn(), setBusy: vi.fn(), setError: vi.fn() }
    const footer = WorkspaceFooterAction({ wide: true, actions, t } as never)
    const overlay = render(WorkspaceOverlay as unknown as TestComponent, {
      useStore: (select: (state: unknown) => unknown) => select({ open: true, mode: 'conversations', busy: false, error: new Error('upstream detail') }),
      actions,
      api: {},
      t,
    })
    const live = render(WorkspaceLiveTurn as unknown as TestComponent, { turn: liveTurn, agentName: 'Alice', t })
    const rendered = [...strings(footer), ...strings(overlay), ...strings(live)]
    for (const value of expected) expect(rendered).toContain(value)
    expect(registered.entries).toHaveLength(2)
    expect(registered.entries.every(entry => entry.options['locale'] === 'agentWorkspace')).toBe(true)
    registered.dispose()
  })

  it.each([
    ['zh', ['运行状态', '关闭运行状态', '当前没有运行活动。']],
    ['en', ['Runtime activity', 'Close runtime activity', 'No runtime activity.']],
  ] as const)('renders activity drawer accessibility and empty copy in %s', (localeId, expected) => {
    const locale = new LocaleRuntime(new Context())
    locale.setLocale(localeId)
    const registered = registerPlugin(locale)
    const t = locale.bind('agentWorkspace' as never)
    const render = renderHarness()
    const snapshot: WorkspaceSnapshot = {
      workspaceId: 'workspace', revision: 0, nextId: 1, nextSequence: 1,
      definitions: {}, definitionRevisions: {}, agents: {}, rooms: {}, memberships: {}, events: [], memoryEntries: [], tasks: {}, taskAssignments: {}, delegationGrants: {}, childRuns: {}, sessionBindings: {},
    }
    const activity: WorkspaceActivitySnapshot = { version: 0, workspaceRevision: 0, activities: [], agents: [] }
    const drawer = render(WorkspaceActivityDrawer as unknown as TestComponent, {
      projection: projectWorkspaceActivity(snapshot, activity), snapshot, api: {}, selectedActivityId: undefined,
      onSelectActivity: vi.fn(), onSnapshot: vi.fn(), onActivity: vi.fn(), onClose: vi.fn(), returnFocusRef: { current: null }, t,
    })
    const rendered = strings(drawer)
    for (const value of expected) expect(rendered).toContain(value)
    registered.dispose()
  })

  it.each([
    ['zh', ['任务中心', '分配根任务', '任务标题', '负责人', '分配任务', '还没有任务。为一名在职智能体分配根任务即可开始。']],
    ['en', ['Task center', 'Assign root task', 'Task title', 'Assignee', 'Assign task', 'No tasks yet. Assign a root task to an employed agent to begin.']],
  ] as const)('renders task empty-state, form and accessibility copy in %s', (localeId, expected) => {
    const locale = new LocaleRuntime(new Context())
    locale.setLocale(localeId)
    const registered = registerPlugin(locale)
    const t = locale.bind('agentWorkspace' as never)
    const render = renderHarness()
    const snapshot: WorkspaceSnapshot = {
      workspaceId: 'workspace', revision: 0, nextId: 1, nextSequence: 1,
      definitions: {}, definitionRevisions: {}, agents: {}, rooms: {}, memberships: {}, events: [], memoryEntries: [], tasks: {}, taskAssignments: {}, delegationGrants: {}, childRuns: {}, sessionBindings: {},
    }
    const activity: WorkspaceActivitySnapshot = { version: 0, workspaceRevision: 0, activities: [], agents: [] }
    const taskView = render(WorkspaceTasks as unknown as TestComponent, { snapshot, activity, api: {}, onSnapshot: vi.fn(), onActivity: vi.fn(), t })
    const rendered = strings(taskView)
    for (const value of expected) expect(rendered).toContain(value)
    registered.dispose()
  })

  it.each([
    ['zh', ['统一个人记忆', '智能体', '来源类型', '首次获得途径', '不可变修订历史', '正在读取修订历史…']],
    ['en', ['Unified personal memory', 'Agent', 'Source kind', 'First provenance', 'Immutable revision history', 'Loading revision history…']],
  ] as const)('renders memory and definition-history product copy in %s', (localeId, expected) => {
    const locale = new LocaleRuntime(new Context())
    locale.setLocale(localeId)
    const registered = registerPlugin(locale)
    const t = locale.bind('agentWorkspace' as never)
    const render = renderHarness()
    const snapshot: WorkspaceSnapshot = {
      workspaceId: 'workspace', revision: 1, nextId: 2, nextSequence: 2,
      definitions: { role: { id: 'role', name: 'Engineer', revisionIds: ['revision'], currentRevisionId: 'revision' } },
      definitionRevisions: { revision: { id: 'revision', definitionId: 'role', number: 1, description: '', instructions: '' } },
      agents: { alice: { id: 'alice', name: 'Alice', definitionId: 'role', definitionRevisionId: 'revision', employmentStatus: 'employed', employmentPeriods: [] } },
      rooms: {}, memberships: {}, events: [], memoryEntries: [], tasks: {}, taskAssignments: {}, delegationGrants: {}, childRuns: {}, sessionBindings: {},
    }
    const client = { queryMemory: vi.fn(), definitionHistory: vi.fn() }
    const memory = render(WorkspaceMemory as unknown as TestComponent, { snapshot, api: client, onSnapshot: vi.fn(), t })
    const renderHistory = renderHarness()
    const history = renderHistory(WorkspaceDefinitionHistory as unknown as TestComponent, {
      snapshot, definitionId: 'role', description: '', instructions: '', api: client,
      onDescriptionChange: vi.fn(), onInstructionsChange: vi.fn(), onSnapshot: vi.fn(), onSaveSuccess: vi.fn(), onEditorCancel: vi.fn(), onDraftReservationChange: vi.fn(), t,
    })
    const rendered = [...strings(memory), ...strings(history)]
    for (const value of expected) expect(rendered).toContain(value)
    registered.dispose()
  })

  it.each([
    ['zh', '私聊 room-direct 不能使用保留路由 @all。'],
    ['en', 'Direct room room-direct cannot use reserved route @all.'],
  ] as const)('formats stable business details without parsing the Host message in %s', (localeId, expected) => {
    const locale = new LocaleRuntime(new Context())
    locale.setLocale(localeId)
    const registered = registerPlugin(locale)
    const t = locale.bind('agentWorkspace' as never)
    const render = renderHarness()
    const error = new WorkspaceApiError({
      kind: 'business',
      code: 'reserved-direct-routing',
      message: 'do not parse this diagnostic',
      details: { roomId: 'room-direct', token: '@all' },
    })
    const overlay = render(WorkspaceOverlay as unknown as TestComponent, {
      useStore: (select: (state: unknown) => unknown) => select({ open: true, mode: 'conversations', busy: false, error }),
      actions: { close: vi.fn(), setMode: vi.fn(), selectRoom: vi.fn(), selectDefinition: vi.fn(), setSnapshot: vi.fn(), setBusy: vi.fn(), setError: vi.fn() },
      api: {},
      t,
    })
    expect(strings(overlay)).toContain(expected)
    expect(strings(overlay)).not.toContain('do not parse this diagnostic')
    registered.dispose()
  })
})

describe('Agent Workspace locale wiring', () => {
  it('declares the locale service alongside slots and connection', () => {
    expect(inject).toEqual(['slots', 'connection', 'locale'])
  })
})
