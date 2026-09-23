import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { createWorkspaceRpcHandler } from '../packages/host/src/rpc.ts'
import { WorkspaceApi, WorkspaceApiClient } from '../packages/web/src/client/api.ts'

interface RegisteredRoute {
  readonly handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
}

interface BrowserConnectionHandle {
  readonly rpc: {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown>
  }
}

interface BrowserConnectionBundle {
  readonly apply: (ctx: { provide(name: string, value: unknown): void }) => void
}

async function realConnectionApi(): Promise<{
  readonly api: WorkspaceApiClient
  readonly wireResponses: readonly unknown[]
  readonly dispose: () => Promise<void>
}> {
  const cleanups: Array<() => Promise<void>> = []
  const dispose = async (): Promise<void> => {
    let failure: unknown
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup()
      } catch (error) {
        failure ??= error
      }
    }
    if (failure !== undefined) throw failure
  }
  let route: RegisteredRoute | undefined
  const hostContext = new Context()
  hostContext.provide('webServer', {
    register(next: RegisteredRoute) {
      route = next
      return () => { route = undefined }
    },
  } as never)

  const webRequire = createRequire(new URL('../packages/web/package.json', import.meta.url))
  const connectionNodePath = webRequire.resolve('@deepseek-ai/dsh-client-connection')
  const { HostConnectionService } = await import(connectionNodePath) as {
    readonly HostConnectionService: new (
      ctx: Context,
      trustedHosts: readonly string[],
      browserAuth: { readonly isAuthenticated: () => boolean },
    ) => {
      readonly rpc: {
        handle(
          channel: string,
          handler: ReturnType<typeof createWorkspaceRpcHandler>,
          options: { readonly authority: 'trusted-host' },
        ): () => Promise<void>
      }
    }
  }
  let hostConnection: InstanceType<typeof HostConnectionService> | undefined
  const fiber = hostContext.plugin((pluginContext) => {
    hostConnection = new HostConnectionService(pluginContext, [], { isAuthenticated: () => true })
  })
  await fiber.await()
  cleanups.push(() => fiber.dispose())
  if (hostConnection === undefined) {
    await dispose()
    throw new Error('Connection Host service did not mount')
  }
  let disposeRoute: () => Promise<void>
  try {
    disposeRoute = hostConnection.rpc.handle('/agent-workspace', createWorkspaceRpcHandler({
      acknowledgeAgentFailure: async () => ({ revision: 2, value: undefined }),
    } as never), { authority: 'trusted-host' })
  } catch (error) {
    await dispose()
    throw error
  }
  cleanups.push(disposeRoute)
  if (route === undefined) {
    await dispose()
    throw new Error('Connection Host route did not register')
  }

  const server = createServer((request, response) => {
    const activeRoute = route
    if (activeRoute === undefined) {
      response.writeHead(404)
      response.end()
      return
    }
    void activeRoute.handler(request, response).catch(error => {
      response.destroy(error instanceof Error ? error : new Error(String(error)))
    })
  })
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', rejectListen)
        resolveListen()
      })
    })
    cleanups.push(() => new Promise<void>((resolveClose, rejectClose) => {
      server.close(error => error === undefined ? resolveClose() : rejectClose(error))
    }))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Connection test server has no TCP address')
    const base = new URL(`http://127.0.0.1:${String(address.port)}`)

    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const transportDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__DSH_TRANSPORT__')
    const wireResponses: unknown[] = []
    let bundle: BrowserConnectionBundle | undefined
    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
          __ModuleLoader__: {
            load(module: { readonly factory: (require: (id: string) => unknown) => BrowserConnectionBundle }) {
              bundle = module.factory(() => ({}))
            },
          },
        },
      })
      new Function(readFileSync(webRequire.resolve('@deepseek-ai/dsh-client-connection/client'), 'utf8'))()
      if (bundle === undefined) throw new Error('Connection Browser bundle did not publish')
      Object.defineProperty(globalThis, '__DSH_TRANSPORT__', {
        configurable: true,
        value: {
          createApiClient: () => ({}),
          fetch: async (input: string | URL, init: RequestInit) => {
            const target = new URL(input, base)
            const response = await fetch(target, init)
            wireResponses.push(await response.clone().json())
            return response
          },
        },
      })
      let browserConnection: BrowserConnectionHandle | undefined
      bundle.apply({
        provide(name, value) {
          if (name === 'connection') browserConnection = value as BrowserConnectionHandle
        },
      })
      if (browserConnection === undefined) throw new Error('Connection Browser service did not mount')
      return { api: new WorkspaceApiClient(browserConnection as never), wireResponses, dispose }
    } finally {
      if (windowDescriptor === undefined) Reflect.deleteProperty(globalThis, 'window')
      else Object.defineProperty(globalThis, 'window', windowDescriptor)
      if (transportDescriptor === undefined) Reflect.deleteProperty(globalThis, '__DSH_TRANSPORT__')
      else Object.defineProperty(globalThis, '__DSH_TRANSPORT__', transportDescriptor)
    }
  } catch (error) {
    await dispose()
    throw error
  }
}

function workspaceSnapshot(revision = 1) {
  return {
    workspaceId: 'local',
    revision,
    definitions: {},
    definitionRevisions: {},
    agents: {},
    rooms: {},
    memberships: {},
    events: [],
    nextId: 1,
    nextSequence: 1,
    memoryEntries: [],
    tasks: {},
    taskAssignments: {},
    delegationGrants: {},
    childRuns: {},
    sessionBindings: {},
  }
}

function apiFixture(responses: Record<string, unknown>) {
  const calls: Array<{ channel: string; endpoint: string; payload: unknown; signal?: AbortSignal }> = []
  const rpc = {
    call: async (channel: string, endpoint: string, payload: unknown, signal?: AbortSignal) => {
      calls.push({ channel, endpoint, payload, signal })
      if (!(endpoint in responses)) return { ok: false, error: { message: `unexpected ${endpoint}` } }
      return { ok: true, value: responses[endpoint] }
    },
  }
  return { api: new WorkspaceApiClient({ rpc } as never), calls }
}

describe('WorkspaceApiClient upgraded conversation contract', () => {
  it('adds the exact expected revision and unwraps a committed mutation result', async () => {
    const state = workspaceSnapshot(6)
    const { api, calls } = apiFixture({
      'definition/create': { revision: 6, value: state },
    })

    await expect(api.mutate('definition/create', {
      name: 'Engineer', description: '', instructions: '',
    }, 5)).resolves.toEqual({ revision: 6, value: state })
    expect(calls[0]?.payload).toEqual({
      expectedRevision: 5,
      name: 'Engineer',
      description: '',
      instructions: '',
    })
  })

  it('rejects malformed mutation envelopes', async () => {
    const { api } = apiFixture({ 'agent/depart': workspaceSnapshot(6) })
    await expect(api.mutate('agent/depart', { agentId: 'agent-1' }, 5))
      .rejects.toThrow('invalid mutation result')
  })

  it('normalizes a void acknowledgement across the shipped Connection HTTP carrier', async () => {
    const { api, wireResponses, dispose } = await realConnectionApi()
    try {
      await expect(api.acknowledgeAgentFailure('agent-1', 1))
        .resolves.toEqual({ revision: 2, value: undefined })
      expect(wireResponses).toHaveLength(1)
      expect(wireResponses[0]).toMatchObject({
        type: 'server-response',
        result: { ok: true, value: { revision: 2 } },
      })
      expect((wireResponses[0] as { result: { value: object } }).result.value)
        .not.toHaveProperty('value')
    } finally {
      await dispose()
    }
  }, 30_000)

  it.each([
    ['missing revision', {}],
    ['extra field', { revision: 2, extra: true }],
  ] as const)('rejects an acknowledgement envelope with %s', async (_name, response) => {
    const { api } = apiFixture({ 'runtime/failure/acknowledge': response })
    await expect(api.acknowledgeAgentFailure('agent-1', 1)).rejects.toThrow('invalid mutation result')
  })

  it('does not allow another mutation endpoint to omit its value', async () => {
    const { api } = apiFixture({ 'task/cancel': { revision: 2 } })
    await expect(api.cancelTask('task-1', 1)).rejects.toThrow('invalid mutation result')
  })

  it.each([undefined, 'root-cascade', 'derived-only'] as const)(
    'accepts a task cancellation snapshot with backward-compatible scope %s', async cancellationScope => {
      const event = {
        id: 'event-1', sequence: 1, type: 'task/cancelled', subjectId: 'task-1', actor: { type: 'human', id: 'owner' },
        ...(cancellationScope === undefined ? {} : { cancellationScope }),
      }
      const { api } = apiFixture({ snapshot: { ...workspaceSnapshot(), events: [event] } })
      await expect(api.snapshot()).resolves.toMatchObject({ events: [event] })
    },
  )

  it('rejects an invented task cancellation scope', async () => {
    const event = { id: 'event-1', sequence: 1, type: 'task/cancelled', subjectId: 'task-1', cancellationScope: 'tree' }
    const { api } = apiFixture({ snapshot: { ...workspaceSnapshot(), events: [event] } })
    await expect(api.snapshot()).rejects.toThrow('invalid snapshot')
  })

  it.each([
    ['snapshot event', 'snapshot', { ...workspaceSnapshot(), events: [{ id: 'event-1', sequence: 1, type: 'invented/event' }] }],
    ['activity source', 'runtime/activity/snapshot', { version: 1, workspaceRevision: 1, activities: [{ activityId: 'activity-1', agentId: 'agent-1', source: { kind: 'invented' }, messageId: 'message-1', startOrder: 1, status: 'queued', blocks: [] }], agents: [] }],
    ['activity block', 'runtime/activity/snapshot', { version: 1, workspaceRevision: 1, activities: [{ activityId: 'activity-1', agentId: 'agent-1', source: { kind: 'room', roomId: 'room-1' }, messageId: 'message-1', startOrder: 1, status: 'responding', claimed: { sessionId: 'session-1', turn: 1 }, blocks: [{ kind: 'invented', index: 0 }] }], agents: [] }],
    ['activity agent summary', 'runtime/activity/snapshot', { version: 1, workspaceRevision: 1, activities: [], agents: [{ agentId: 'agent-1', status: 'invented', usingTool: false }] }],
    ['memory item', 'memory/query', { snapshotRevision: 1, items: [{ eventId: 'event-1', sequence: 1, type: 'room/message', provenance: 'invented', definitionRevision: { status: 'unresolved' } }] }],
    ['definition history item', 'definition/history', [{ id: 'revision-1', definitionId: 'definition-1', number: 1, description: '', instructions: '', creationEvent: { status: 'invented' }, status: 'current', agentIds: [] }]],
  ] as const)('rejects a malformed nested %s response', async (_name, endpoint, response) => {
    const { api } = apiFixture({ [endpoint]: response })
    const request = endpoint === 'snapshot'
      ? api.snapshot()
      : endpoint === 'runtime/activity/snapshot'
        ? api.activitySnapshot()
        : endpoint === 'memory/query'
          ? api.queryMemory({ agentId: 'agent-1', limit: 10, snapshotRevision: 1 })
          : api.definitionHistory('definition-1')
    await expect(request).rejects.toThrow('invalid')
  })

  it.each([
    ['definition', { definitions: { 'definition-1': { id: 'definition-1', name: 'Role', revisionIds: [], currentRevisionId: 1 } } }],
    ['definition revision', { definitionRevisions: { 'revision-1': { id: 'revision-1', definitionId: 'definition-1', number: 1, description: '' } } }],
    ['agent employment', { agents: { 'agent-1': { id: 'agent-1', name: 'Alice', definitionId: 'definition-1', definitionRevisionId: 'revision-1', employmentStatus: 'invented', employmentPeriods: [] } } }],
    ['employment period', { agents: { 'agent-1': { id: 'agent-1', name: 'Alice', definitionId: 'definition-1', definitionRevisionId: 'revision-1', employmentStatus: 'employed', employmentPeriods: [{ id: 'period-1', startedEventId: 1 }] } } }],
    ['room', { rooms: { 'room-1': { id: 'room-1', kind: 'invented' } } }],
    ['membership history', { memberships: { 'membership-1': { id: 'membership-1', roomId: 'room-1', agentId: 'agent-1', memoryStart: { type: 'invented' }, joinedEventId: 'event-1' } } }],
    ['event actor', { events: [{ id: 'event-1', sequence: 1, type: 'room/message', actor: { type: 'invented', id: 'actor-1' } }] }],
    ['memory entry', { memoryEntries: [{ id: 'memory-1', agentId: 'agent-1', eventId: 'event-1', acquiredBy: 'invented' }] }],
    ['task', { tasks: { 'task-1': { id: 'task-1', rootTaskId: 'task-1', title: 'Review', status: 'invented' } } }],
    ['task assignment', { taskAssignments: { 'assignment-1': { id: 'assignment-1', taskId: 'task-1', assigneeAgentId: 'agent-1' } } }],
    ['delegation grant', { delegationGrants: { 'grant-1': { id: 'grant-1', rootTaskId: 'task-1', granteeAgentId: 'agent-1', grantedByHumanId: 'human-1', status: 'invented' } } }],
    ['child run', { childRuns: { 'child-1': { id: 'child-1', parentAgentId: 'agent-1', taskId: 'task-1', status: 'running', result: 'impossible' } } }],
    ['session binding', { sessionBindings: { 'agent-1': 7 } }],
  ] as const)('rejects a malformed snapshot %s record', async (_name, replacement) => {
    const { api } = apiFixture({ snapshot: { ...workspaceSnapshot(), ...replacement } })
    await expect(api.snapshot()).rejects.toThrow('invalid snapshot')
  })

  it.each([
    ['claimed turn', { activities: [{ activityId: 'activity-1', agentId: 'agent-1', source: { kind: 'room', roomId: 'room-1' }, messageId: 'message-1', startOrder: 1, status: 'responding', claimed: { sessionId: 'session-1', turn: -1 }, blocks: [] }], agents: [] }],
    ['tool status', { activities: [{ activityId: 'activity-1', agentId: 'agent-1', source: { kind: 'room', roomId: 'room-1' }, messageId: 'message-1', startOrder: 1, status: 'responding', claimed: { sessionId: 'session-1', turn: 1 }, blocks: [{ kind: 'tool', index: 0, callId: 'call-1', name: 'tool', arguments: '{}', status: 'invented' }] }], agents: [] }],
    ['activity error', { activities: [{ activityId: 'activity-1', agentId: 'agent-1', source: { kind: 'room', roomId: 'room-1' }, messageId: 'message-1', startOrder: 1, status: 'settled', blocks: [], error: { code: 'failed' } }], agents: [] }],
    ['summary error', { activities: [], agents: [{ agentId: 'agent-1', status: 'failed', usingTool: false, error: { code: 'failed' } }] }],
  ] as const)('rejects malformed nested activity %s', async (_name, replacement) => {
    const { api } = apiFixture({ 'runtime/activity/snapshot': { version: 1, workspaceRevision: 1, ...replacement } })
    await expect(api.activitySnapshot()).rejects.toThrow('invalid activity snapshot')
  })

  it.each([
    ['source', { source: { kind: 'invented', id: 'source-1', label: 'Source' } }],
    ['actor', { actor: { type: 'invented', id: 'actor-1', label: 'Actor' } }],
    ['definition revision', { definitionRevision: { status: 'active', id: 'revision-1', number: -1 } }],
  ] as const)('rejects a malformed nested memory %s', async (_name, replacement) => {
    const item = { eventId: 'event-1', sequence: 1, type: 'room/message', provenance: 'task', definitionRevision: { status: 'unresolved' }, ...replacement }
    const { api } = apiFixture({ 'memory/query': { snapshotRevision: 1, items: [item] } })
    await expect(api.queryMemory({ agentId: 'agent-1', limit: 10, snapshotRevision: 1 })).rejects.toThrow('invalid memory page')
  })

  it.each([
    ['business details', { kind: 'business', code: 'agent-missing', message: 'missing', details: {} }],
    ['bad request details', { kind: 'bad-request', code: 'bad-request', message: 'bad', details: { issues: 'not-an-array' } }],
    ['cancelled details', { kind: 'cancelled', code: 'cancelled', message: 'cancelled', details: { leaked: true } }],
    ['internal details', { kind: 'internal', code: 'internal', message: 'safe', details: { leaked: true } }],
  ] as const)('normalizes malformed %s RPC errors', async (_name, error) => {
    const rpc = { call: async () => ({ ok: false, error }) }
    const api = new WorkspaceApiClient({ rpc } as never)
    await expect(api.snapshot()).rejects.toMatchObject({
      error: { kind: 'internal', code: 'internal', message: 'Agent Workspace request failed', details: {} },
    })
  })

  it('normalizes an invented RPC error discriminator to the safe internal error', async () => {
    const rpc = { call: async () => ({ ok: false, error: { kind: 'business', code: 'invented', message: 'secret diagnostic', details: {} } }) }
    const api = new WorkspaceApiClient({ rpc } as never)
    await expect(api.snapshot()).rejects.toMatchObject({
      error: { kind: 'internal', code: 'internal', message: 'Agent Workspace request failed', details: {} },
    })
  })

  it.each([
    [{ kind: 'business', code: 'reserved-direct-routing', message: 'reserved', details: { roomId: 'room-1', token: '@all' } }],
    [{ kind: 'business', code: 'agent-missing', message: 'missing', details: { agentId: 'agent-1' } }],
    [{ kind: 'business', code: 'agent-departed', message: 'departed', details: { agentId: 'agent-1' } }],
    [{ kind: 'business', code: 'duplicate-membership', message: 'duplicate', details: { roomId: 'room-1', agentId: 'agent-1' } }],
    [{ kind: 'business', code: 'stale-revision', message: 'stale definition', details: { definitionId: 'definition-1', revisionId: 'revision-1' } }],
    [{ kind: 'business', code: 'stale-revision', message: 'stale workspace', details: { expectedRevision: 1, actualRevision: 2 } }],
    [{ kind: 'business', code: 'invalid-task-authority', message: 'authority', details: { taskId: 'task-1', agentId: 'agent-1' } }],
    [{ kind: 'business', code: 'task-not-open', message: 'closed', details: { taskId: 'task-1', status: 'completed' } }],
    [{ kind: 'business', code: 'task-not-assigned', message: 'assignment', details: { taskId: 'task-1', agentId: 'agent-1' } }],
    [{ kind: 'business', code: 'delegation-grant-missing', message: 'missing grant', details: { lookup: 'id', delegationGrantId: 'grant-1' } }],
    [{ kind: 'business', code: 'delegation-grant-missing', message: 'missing authority', details: { lookup: 'root-agent', rootTaskId: 'task-1', agentId: 'agent-1' } }],
    [{ kind: 'business', code: 'delegation-grant-inactive', message: 'inactive', details: { delegationGrantId: 'grant-1' } }],
    [{ kind: 'bad-request', code: 'bad-request', message: 'bad', details: { issues: [] } }],
    [{ kind: 'cancelled', code: 'cancelled', message: 'cancelled', details: {} }],
    [{ kind: 'internal', code: 'internal', message: 'safe', details: {} }],
  ] as const)('retains the closed $kind/$code RPC error contract', async (error) => {
    const rpc = { call: async () => ({ ok: false, error }) }
    const api = new WorkspaceApiClient({ rpc } as never)
    await expect(api.snapshot()).rejects.toMatchObject({ error })
  })

  it('rejects client actor fields before transport', async () => {
    const { api, calls } = apiFixture({})
    await expect(api.mutate('task/assign', {
      assigneeAgentId: 'agent-1', title: 'Review', humanId: 'forged-user',
    }, 5)).rejects.toThrow('client-owned actor')
    expect(calls).toEqual([])
  })

  it('exports the typed WorkspaceApi foundation', () => {
    expect(WorkspaceApi).toBeTypeOf('function')
  })

  it('passes the human-selected membership memory start to the Host', async () => {
    const state = workspaceSnapshot(5)
    const { api, calls } = apiFixture({ 'room/join': { revision: 5, value: state } })
    const controller = new AbortController()

    await expect(api.joinRoom('room-1', 'agent-1', {
      type: 'event-range',
      startSequence: 2,
      endSequence: 4,
    }, 4, controller.signal)).resolves.toEqual(state)
    expect(calls).toEqual([expect.objectContaining({
      channel: '/agent-workspace',
      endpoint: 'room/join',
      payload: {
        expectedRevision: 4,
        roomId: 'room-1',
        agentId: 'agent-1',
        memoryStart: { type: 'event-range', startSequence: 2, endSequence: 4 },
      },
      signal: controller.signal,
    })])
  })

  it('rejects an inverted membership event range before transport', async () => {
    const { api, calls } = apiFixture({})
    await expect(api.joinRoom('room-1', 'agent-1', {
      type: 'event-range', startSequence: 4, endSequence: 3,
    }, 1)).rejects.toThrow('event range')
    expect(calls).toEqual([])
  })

  it('normalizes the Host direct-room result into a browser snapshot and room id', async () => {
    const state = workspaceSnapshot(4)
    const { api, calls } = apiFixture({
      'room/direct/open': { revision: 4, value: { state, roomId: 'room-direct' } },
    })

    await expect(api.openDirect('agent-1', 3)).resolves.toEqual({ snapshot: state, roomId: 'room-direct' })
    expect(calls).toEqual([expect.objectContaining({
      channel: '/agent-workspace',
      endpoint: 'room/direct/open',
      payload: { expectedRevision: 3, agentId: 'agent-1' },
    })])
  })

  it.each([
    ['definition/create', { revision: 9, value: { ...workspaceSnapshot(4) } }, (api: WorkspaceApiClient) => api.createDefinition({ name: 'Role', description: '', instructions: '' }, 3)],
    ['room/direct/open', { revision: 9, value: { state: workspaceSnapshot(4), roomId: 'room-1' } }, (api: WorkspaceApiClient) => api.openDirect('agent-1', 3)],
    ['task/assign', { revision: 9, value: { state: workspaceSnapshot(4), taskId: 'task-1', taskAssignmentId: 'assignment-1' } }, (api: WorkspaceApiClient) => api.assignTask('agent-1', 'Review', 3)],
    ['task/grant', { revision: 9, value: { state: workspaceSnapshot(4), delegationGrantId: 'grant-1' } }, (api: WorkspaceApiClient) => api.grantTask('agent-1', 'task-1', 3)],
  ] as const)('rejects a %s wrapper whose committed revision contradicts its state', async (endpoint, response, invoke) => {
    const { api } = apiFixture({ [endpoint]: response })
    await expect(invoke(api)).rejects.toThrow('revision')
  })

  it.each([
    ['definition/create', { name: 'Role', description: '', instructions: '' }, { revision: 2, value: workspaceSnapshot(2) }, (api: WorkspaceApiClient) => api.createDefinition({ name: 'Role', description: '', instructions: '' }, 1)],
    ['definition/revise', { definitionId: 'definition-1', description: 'v2', instructions: 'new', synchronizeAgentIds: ['agent-1'] }, { revision: 2, value: workspaceSnapshot(2) }, (api: WorkspaceApiClient) => api.reviseDefinition({ definitionId: 'definition-1', description: 'v2', instructions: 'new', synchronizeAgentIds: ['agent-1'] }, 1)],
    ['definition/synchronize', { definitionId: 'definition-1', definitionRevisionId: 'revision-1', agentIds: ['agent-1'] }, { revision: 2, value: workspaceSnapshot(2) }, (api: WorkspaceApiClient) => api.synchronizeDefinition('definition-1', 'revision-1', ['agent-1'], 1)],
    ['agent/create', { definitionId: 'definition-1', name: 'Alice' }, { revision: 2, value: workspaceSnapshot(2) }, (api: WorkspaceApiClient) => api.createAgent('definition-1', 'Alice', 1)],
    ['agent/depart', { agentId: 'agent-1' }, { revision: 2, value: workspaceSnapshot(2) }, (api: WorkspaceApiClient) => api.setEmployment('agent-1', false, 1)],
    ['agent/employ', { agentId: 'agent-1' }, { revision: 2, value: workspaceSnapshot(2) }, (api: WorkspaceApiClient) => api.setEmployment('agent-1', true, 1)],
    ['room/create', { kind: 'group', name: 'Engineering' }, { revision: 2, value: workspaceSnapshot(2) }, (api: WorkspaceApiClient) => api.createGroup('Engineering', 1)],
    ['room/direct/open', { agentId: 'agent-1' }, { revision: 2, value: { state: workspaceSnapshot(2), roomId: 'room-1' } }, (api: WorkspaceApiClient) => api.openDirect('agent-1', 1)],
    ['room/join', { roomId: 'room-1', agentId: 'agent-1', memoryStart: { type: 'new-events' } }, { revision: 2, value: workspaceSnapshot(2) }, (api: WorkspaceApiClient) => api.joinRoom('room-1', 'agent-1', { type: 'new-events' }, 1)],
    ['room/leave', { membershipId: 'membership-1' }, { revision: 2, value: workspaceSnapshot(2) }, (api: WorkspaceApiClient) => api.leaveRoom('membership-1', 1)],
    ['room/post', { roomId: 'room-1', text: 'hello', mentions: ['agent-1'] }, { revision: 2, value: workspaceSnapshot(2) }, (api: WorkspaceApiClient) => api.postMessage('room-1', 'hello', ['agent-1'], 1)],
    ['task/assign', { assigneeAgentId: 'agent-1', title: 'Review' }, { revision: 2, value: { state: workspaceSnapshot(2), taskId: 'task-1', taskAssignmentId: 'assignment-1' } }, (api: WorkspaceApiClient) => api.assignTask('agent-1', 'Review', 1)],
    ['task/grant', { granteeAgentId: 'agent-1', rootTaskId: 'task-1' }, { revision: 2, value: { state: workspaceSnapshot(2), delegationGrantId: 'grant-1' } }, (api: WorkspaceApiClient) => api.grantTask('agent-1', 'task-1', 1)],
    ['task/revoke', { delegationGrantId: 'grant-1' }, { revision: 2, value: workspaceSnapshot(2) }, (api: WorkspaceApiClient) => api.revokeTask('grant-1', 1)],
    ['task/cancel', { taskId: 'task-1' }, { revision: 2, value: workspaceSnapshot(2) }, (api: WorkspaceApiClient) => api.cancelTask('task-1', 1)],
    ['task/retry-delivery', { taskId: 'task-1' }, { revision: 2, value: 'retried' }, (api: WorkspaceApiClient) => api.retryTaskDelivery('task-1', 1)],
    ['runtime/activity/stop', { activityId: 'activity-1', agentId: 'agent-1', messageId: 'message-1', sessionId: 'session-1', turn: 1 }, { revision: 2, value: { status: 'stopping' } }, (api: WorkspaceApiClient) => api.stopActivity({ activityId: 'activity-1', agentId: 'agent-1', messageId: 'message-1', sessionId: 'session-1', turn: 1 }, 1)],
    ['runtime/child/stop', { childRunId: 'child-1' }, { revision: 2, value: { status: 'already-stopping' } }, (api: WorkspaceApiClient) => api.stopChildRun('child-1', 1)],
    ['runtime/failure/acknowledge', { agentId: 'agent-1' }, { revision: 2 }, (api: WorkspaceApiClient) => api.acknowledgeAgentFailure('agent-1', 1)],
  ] as const)('routes %s with the exact revisioned payload and committed value', async (endpoint, payload, response, invoke) => {
    const { api, calls } = apiFixture({ [endpoint]: response })
    await expect(invoke(api)).resolves.toBeDefined()
    expect(calls).toEqual([expect.objectContaining({ endpoint, payload: { expectedRevision: 1, ...payload } })])
    expect(calls[0]?.payload).not.toHaveProperty('humanId')
    expect(calls[0]?.payload).not.toHaveProperty('actorAgentId')
  })

  it('subscribes to the versioned live turn stream through the plugin RPC channel', async () => {
    const initial = { version: 2, workspaceRevision: 4, activities: [], agents: [] }
    const changed = {
      version: 3,
      workspaceRevision: 4,
      activities: [{
        activityId: 'activity-1', agentId: 'agent-1', source: { kind: 'room', roomId: 'room-1' },
        messageId: 'message-1', startOrder: 1, claimed: { sessionId: 'session-1', turn: 7 }, status: 'responding',
        blocks: [{ kind: 'text', index: 0, text: '**流式**' }],
      }],
      agents: [{ agentId: 'agent-1', status: 'active', usingTool: false }],
    }
    const { api, calls } = apiFixture({ 'runtime/activity/snapshot': initial, 'runtime/activity/wait': changed })
    const controller = new AbortController()

    await expect(api.activitySnapshot(controller.signal)).resolves.toEqual(initial)
    await expect(api.waitForActivity(2, controller.signal)).resolves.toEqual(changed)
    expect(calls.map(call => [call.endpoint, call.payload])).toEqual([
      ['runtime/activity/snapshot', {}],
      ['runtime/activity/wait', { afterVersion: 2 }],
    ])
  })
})

describe('Workspace Browser source contract', () => {
  it('uses event-driven stream waits rather than interval polling', () => {
    const source = readFileSync(resolve('packages/web/src/client/WorkspaceUi.tsx'), 'utf8')
    expect(source).toContain('waitForActivity')
    expect(source).not.toContain('setInterval')
    expect(source).not.toContain('window.setInterval')
  })

  it('exposes private chat and group-only @all composition in the workspace UI', () => {
    const source = readFileSync(resolve('packages/web/src/client/WorkspaceUi.tsx'), 'utf8')
    expect(source).toContain('openDirect')
    expect(source).toContain("props.t('room.direct')")
    expect(source).toContain('@all')
    expect(source).toContain("selectedRoom.kind === 'group'")
  })

  it('selects a newly opened direct room only after adopting its snapshot', () => {
    const source = readFileSync(resolve('packages/web/src/client/WorkspaceUi.tsx'), 'utf8')
    const openDirect = source.slice(source.indexOf('const openDirect ='), source.indexOf('\n\n  return ('))
    expect(openDirect).toContain('const committed = await commit')
    expect(openDirect.indexOf('return result.snapshot')).toBeLessThan(openDirect.indexOf('actions.selectRoom(roomId)'))
  })

  it('renders live turns through public DSH markdown and disclosure primitives only', () => {
    const path = resolve('packages/web/src/client/WorkspaceTurn.tsx')
    expect(existsSync(path)).toBe(true)
    if (!existsSync(path)) return
    const source = readFileSync(path, 'utf8')
    expect(source).toContain("from '@deepseek-ai/dsh-client-ui-primitives'")
    expect(source).toContain('MarkdownText')
    expect(source).toContain('DisclosureRow')
    expect(source).not.toMatch(/@deepseek-ai\/[^'\"]+\/src\//)
  })

  it('bundles ui-primitives the same way DSH browser packages do', () => {
    const pkg = JSON.parse(readFileSync(resolve('packages/web/package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>
      dsh?: { client?: { inject?: string[] } }
    }
    expect(pkg.devDependencies?.['@deepseek-ai/dsh-client-ui-primitives']).toBeDefined()
    expect(pkg.dsh?.client?.inject ?? []).not.toContain('@deepseek-ai/dsh-client-ui-primitives')
  })
})
