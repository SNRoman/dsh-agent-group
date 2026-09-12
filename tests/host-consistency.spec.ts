import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { apply as domainApply, Config as DomainConfig, inject as domainInject } from '@deepseek-ai/dsh-storage-domain'
import { apply as jsonApply, Config as JsonConfig, inject as jsonInject } from '@deepseek-ai/dsh-storage-json'
import AgentWorkspaceDomainService from '../packages/host/src/index.ts'
import { WorkspaceDispatcher } from '../packages/host/src/dispatcher.ts'
import type { SubagentRuntimeLike, WorkspaceDispatcherHost } from '../packages/host/src/dispatcher.ts'
import { AgentId, AgentMemoryEntryId, ChildRunId, HumanId, RoomId, WorkspaceActivityId, WorkspaceEventId, WorkspaceId } from '../packages/host/src/ids.ts'
import { EmployeeAgentPool } from '../packages/host/src/runtime.ts'
import type { EmployeeSessionSource } from '../packages/host/src/runtime.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import { assignHumanTask, recordChildRunStarted } from '../packages/host/src/tasks.ts'
import { failTaskDelivery, startTaskDelivery } from '../packages/host/src/task-delivery.ts'
import type { WorkspaceState } from '../packages/host/src/types.ts'
import { TaskDeliveryCoordinator } from '../packages/host/src/task-delivery-coordinator.ts'
import { createWorkspaceRpcHandler } from '../packages/host/src/rpc.ts'

const limits = { maxAgentHops: 3, maxRepliesPerRoot: 8, recallCharacterBudget: 4000 }

function handle(dispose = vi.fn(async () => {})): AgentHandle {
  return { agent: { id: 'agent' } as unknown as Agent, dispose }
}

function buildWorkspace(agentNames: string[], joinedNames = agentNames): { state: WorkspaceState; roomId: RoomId; agentIds: AgentId[] } {
  let state = createInitialState(WorkspaceId('local'))
  const definition = mutateWorkspace(state, { type: 'definition/create', name: 'Worker', description: 'd', instructions: 'i' })
  state = definition.state
  const agentIds: AgentId[] = []
  for (const name of agentNames) {
    const created = mutateWorkspace(state, { type: 'agent/create', definitionId: definition.definitionId, name })
    state = created.state
    agentIds.push(created.agentId)
  }
  const room = mutateWorkspace(state, { type: 'room/create', kind: 'group', name: 'room' })
  state = room.state
  for (let index = 0; index < agentNames.length; index++) {
    if (!joinedNames.includes(agentNames[index]!)) continue
    state = mutateWorkspace(state, {
      type: 'room/join',
      roomId: room.roomId,
      agentId: agentIds[index]!,
      memoryStart: { type: 'new-events' },
    }).state
  }
  return { state, roomId: room.roomId, agentIds }
}

interface FakeHost extends WorkspaceDispatcherHost {
  state: WorkspaceState
  delivered: AgentId[]
  deliveryMessages: UserMessage[]
  transact<T>(mutation: (state: WorkspaceState) => { state: WorkspaceState; result: T }): Promise<T>
}

function fakeHost(initial: WorkspaceState, replies = new Map<AgentId, string>()): FakeHost {
  const host: FakeHost = {
    state: structuredClone(initial),
    delivered: [],
    deliveryMessages: [],
    snapshot: () => structuredClone(host.state),
    execute: async command => {
      host.state = mutateWorkspace(host.state, command).state
      return structuredClone(host.state)
    },
    apply: async mutation => {
      await Promise.resolve()
      host.state = mutation(host.state)
      return structuredClone(host.state)
    },
    transact: async mutation => {
      const result = mutation(host.state)
      host.state = result.state
      return result.result
    },
    deliver: async (agentId, delivery, _recall, _source, hooks) => {
      host.delivered.push(agentId)
      host.deliveryMessages.push(delivery)
      await hooks?.onClaim?.()
      return {
        output: [{ type: 'text', text: replies.get(agentId) ?? '' }],
        stopReason: { kind: 'completed' },
        interrupted: false,
      }
    },
    ensureEmployee: async () => handle(),
  }
  return host
}

describe('dispatcher consistency', () => {
  test('room deliveries identify their workspace and exact source event', async () => {
    const { state, roomId, agentIds } = buildWorkspace(['alice'])
    const alice = agentIds[0]!
    const host = fakeHost(state)
    const dispatcher = new WorkspaceDispatcher(host, { start: vi.fn() } as unknown as SubagentRuntimeLike, 'spawn', limits)

    await dispatcher.postHumanMessage(roomId, HumanId('owner'), 'please review', [alice])

    const sourceEvent = host.state.events.find(event => event.type === 'room/message' && event.text === 'please review')!
    expect(host.deliveryMessages[0]?.source).toEqual({
      kind: 'agent-workspace-delivery',
      workspaceId: 'local',
      source: { kind: 'room', roomId },
      sourceEventId: sourceEvent.id,
    })
  })

  test('concurrent root messages keep each delivery bound to its own source event', async () => {
    const { state, roomId, agentIds } = buildWorkspace(['alice'])
    const alice = agentIds[0]!
    const host = fakeHost(state)
    const dispatcher = new WorkspaceDispatcher(host, { start: vi.fn() } as unknown as SubagentRuntimeLike, 'spawn', limits)
    const pending: Array<{ readonly state: WorkspaceState; readonly resolve: (state: WorkspaceState) => void }> = []
    host.execute = async command => {
      host.state = mutateWorkspace(host.state, command).state
      const committed = structuredClone(host.state)
      if (command.type !== 'room/message') return committed
      return await new Promise<WorkspaceState>(resolve => pending.push({ state: committed, resolve }))
    }

    const firstStarted = dispatcher.startHumanMessage(roomId, HumanId('owner'), 'first root', [alice])
    const secondStarted = dispatcher.startHumanMessage(roomId, HumanId('owner'), 'second root', [alice])
    expect(pending).toHaveLength(2)
    pending[1]!.resolve(pending[1]!.state)
    pending[0]!.resolve(pending[0]!.state)
    const [first, second] = await Promise.all([firstStarted, secondStarted])
    await Promise.all([first.completion, second.completion])

    for (const text of ['first root', 'second root']) {
      const sourceEvent = host.state.events.find(event => event.type === 'room/message' && event.text === text)!
      const delivery = host.deliveryMessages.find(message => message.content.some(block => block.type === 'text' && block.text === text))
      expect(delivery?.source).toMatchObject({ sourceEventId: sourceEvent.id })
    }
  })

  test('task deliveries point to the durable assignment event', async () => {
    const { state, agentIds } = buildWorkspace(['alice'])
    const alice = agentIds[0]!
    const assigned = assignHumanTask(state, { humanId: HumanId('owner'), assigneeAgentId: alice, title: 'formal task' })
    const host = fakeHost(assigned.state, new Map([[alice, 'done']]))
    const coordinator = new TaskDeliveryCoordinator(host)
    const dispatcher = new WorkspaceDispatcher(
      host,
      { start: vi.fn() } as unknown as SubagentRuntimeLike,
      'spawn',
      limits,
      coordinator,
    )

    await dispatcher.runAssignedTask(alice, assigned.taskId)

    const assignment = Object.values(assigned.state.taskAssignments).find(candidate => candidate.taskId === assigned.taskId)!
    const assignmentEvent = assigned.state.events.find(event => event.type === 'task/assigned' && event.subjectId === assignment.id)!
    expect(host.deliveryMessages[0]?.source).toEqual({
      kind: 'agent-workspace-delivery',
      workspaceId: 'local',
      source: { kind: 'task', taskId: assigned.taskId },
      sourceEventId: assignmentEvent.id,
      taskDeliveryAttemptId: expect.any(String),
    })
  })

  test('concurrent child runs keep distinct committed ids and both settle', async () => {
    const { state, agentIds } = buildWorkspace(['alice'])
    const alice = agentIds[0]!
    const assigned = assignHumanTask(state, { humanId: HumanId('owner'), assigneeAgentId: alice, title: 'work' })
    const host = fakeHost(assigned.state)
    const subagents = {
      start: vi.fn(async () => ({
        result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }),
        dispose: async () => {},
      })),
    }
    const dispatcher = new WorkspaceDispatcher(host, subagents as unknown as SubagentRuntimeLike, 'spawn', limits)

    await Promise.all([
      dispatcher.runChild(alice, assigned.taskId, 'one'),
      dispatcher.runChild(alice, assigned.taskId, 'two'),
    ])

    const runs = Object.values(host.snapshot().childRuns)
    expect(runs).toHaveLength(2)
    expect(new Set(runs.map(run => run.id)).size).toBe(2)
    expect(runs.every(run => run.status === 'completed')).toBe(true)
  })

  test('a rejected child result is durably terminal instead of remaining running', async () => {
    const { state, agentIds } = buildWorkspace(['alice'])
    const alice = agentIds[0]!
    const assigned = assignHumanTask(state, { humanId: HumanId('owner'), assigneeAgentId: alice, title: 'work' })
    const host = fakeHost(assigned.state)
    const dispose = vi.fn(async () => {})
    const subagents = {
      start: vi.fn(async () => ({ result: Promise.reject(new Error('boom')), dispose })),
    }
    const dispatcher = new WorkspaceDispatcher(host, subagents as unknown as SubagentRuntimeLike, 'spawn', limits)

    await expect(dispatcher.runChild(alice, assigned.taskId, 'fail')).rejects.toThrow(/boom/)

    const runs = Object.values(host.snapshot().childRuns)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).toBe('failed')
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  test('task authorization happens before the assignee agent is woken', async () => {
    const { state, agentIds } = buildWorkspace(['alice', 'bob'])
    const [alice, bob] = agentIds as [AgentId, AgentId]
    const assigned = assignHumanTask(state, { humanId: HumanId('owner'), assigneeAgentId: alice, title: 'restricted work' })
    const host = fakeHost(assigned.state)
    const dispatcher = new WorkspaceDispatcher(host, { start: vi.fn() } as unknown as SubagentRuntimeLike, 'spawn', limits)

    await expect(dispatcher.runAssignedTask(bob, assigned.taskId)).rejects.toThrow(/not assigned/)
    expect(host.delivered).toEqual([])
  })

  test('a room message cannot mention an employed agent who is not a room member', async () => {
    const { state, roomId, agentIds } = buildWorkspace(['alice', 'bob'], ['alice'])
    const bob = agentIds[1]!
    const host = fakeHost(state)
    const dispatcher = new WorkspaceDispatcher(host, { start: vi.fn() } as unknown as SubagentRuntimeLike, 'spawn', limits)
    const before = host.snapshot()

    await expect(dispatcher.postHumanMessage(roomId, HumanId('owner'), 'private room message', [bob])).rejects.toThrow(/not an active member/)

    expect(host.delivered).toEqual([])
    expect(host.snapshot().events).toEqual(before.events)
  })
})

describe('employee pool lifecycle', () => {
  test('dispose during admission preparation prevents agent creation and session binding', async () => {
    const optionsStarted = Promise.withResolvers<void>()
    const releaseOptions = Promise.withResolvers<void>()
    const create = vi.fn(async () => handle())
    const recordSessionId = vi.fn(async () => {})
    const source: EmployeeSessionSource = {
      sessionIdFor: () => undefined,
      recordSessionId,
    }
    const pool = new EmployeeAgentPool(
      { create, resume: vi.fn() },
      source,
      async () => {
        optionsStarted.resolve()
        await releaseOptions.promise
        return {}
      },
    )
    const alice = AgentId('alice')

    const ensuring = pool.ensure(alice)
    await optionsStarted.promise
    const disposing = pool.dispose(alice)
    releaseOptions.resolve()

    await expect(ensuring).rejects.toThrow(/invalidated|disposed/)
    await disposing
    expect(create).not.toHaveBeenCalled()
    expect(recordSessionId).not.toHaveBeenCalled()
    expect(pool.handleFor(alice)).toBeUndefined()
  })
})

interface Booted {
  ctx: Context
  service: AgentWorkspaceDomainService
  dispose: () => Promise<void>
}

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function boot(): Promise<Booted> {
  const root = await mkdtemp(join(tmpdir(), 'agent-group-consistency-'))
  roots.push(root)
  const ctx = new Context()
  const fibers = [
    await ctx.plugin(Storage),
    await ctx.plugin({ apply: jsonApply, Config: JsonConfig, inject: jsonInject }, { root }),
    await ctx.plugin({ apply: domainApply, Config: DomainConfig, inject: domainInject }, { backend: 'json' }),
    await ctx.plugin(AgentWorkspaceDomainService),
  ]
  return {
    ctx,
    service: ctx.agentWorkspace,
    dispose: async () => {
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
    },
  }
}

async function seedRetryableTask(service: AgentWorkspaceDomainService): Promise<{ agentId: AgentId; taskId: ReturnType<typeof assignHumanTask>['taskId'] }> {
  let agentId: AgentId | undefined
  let taskId: ReturnType<typeof assignHumanTask>['taskId'] | undefined
  await service.apply(current => {
    const definition = mutateWorkspace(current, { type: 'definition/create', name: 'Worker', description: '', instructions: '' })
    const agent = mutateWorkspace(definition.state, { type: 'agent/create', definitionId: definition.definitionId, name: 'Alice' })
    const assigned = assignHumanTask(agent.state, { humanId: HumanId('owner'), assigneeAgentId: agent.agentId, title: 'root' })
    const started = startTaskDelivery(assigned.state, { taskId: assigned.taskId })
    agentId = agent.agentId
    taskId = assigned.taskId
    return failTaskDelivery(started.state, {
      taskId: assigned.taskId,
      attemptId: started.attemptId,
      messageId: started.message.id,
      failureCode: 'test',
      failureSummary: 'retryable',
    }).state
  })
  if (agentId === undefined || taskId === undefined) throw new Error('retry setup did not publish durable ids')
  return { agentId, taskId }
}

describe('durable service boundary', () => {
  test('a converged runtime stop validates CAS without changing durable revision', async () => {
    const booted = await boot()
    const before = booted.service.snapshot()

    const stopped = await booted.service.stopActivity(before.revision, {
      activityId: WorkspaceActivityId('activity-missing'),
      agentId: AgentId('agent-missing'),
      messageId: MessageId('message-missing'),
      sessionId: SessionId('session-missing'),
      turn: 1,
    })

    expect(stopped).toEqual({ revision: before.revision, value: { status: 'not-active' } })
    expect(booted.service.snapshot()).toEqual(before)
    await booted.dispose()
  })

  test('a stale human post fails before durable recording or runtime lookup', async () => {
    const booted = await boot()
    await booted.service.executeInternal({ type: 'room/create', kind: 'group', name: 'room' })
    const before = booted.service.snapshot()
    const room = Object.values(before.rooms)[0]!

    await expect(booted.service.postHumanMessage(
      before.revision - 1,
      room.id,
      HumanId('web-user'),
      'must not commit',
      [],
    )).rejects.toMatchObject({
      code: 'stale-revision',
      details: { expectedRevision: before.revision - 1, actualRevision: before.revision },
    })

    expect(booted.service.snapshot()).toEqual(before)
    await booted.dispose()
  })

  test('a post with wake targets rejects an unavailable dispatcher before committing', async () => {
    const booted = await boot()
    await booted.service.executeInternal({ type: 'definition/create', name: 'Worker', description: '', instructions: '' })
    let snapshot = booted.service.snapshot()
    const definition = Object.values(snapshot.definitions)[0]!
    await booted.service.executeInternal({ type: 'agent/create', definitionId: definition.id, name: 'Alice' })
    await booted.service.executeInternal({ type: 'room/create', kind: 'group', name: 'room' })
    snapshot = booted.service.snapshot()
    const alice = Object.values(snapshot.agents)[0]!
    const room = Object.values(snapshot.rooms)[0]!
    await booted.service.executeInternal({ type: 'room/join', roomId: room.id, agentId: alice.id, memoryStart: { type: 'new-events' } })
    const before = booted.service.snapshot()

    await expect(booted.service.postHumanMessage(
      before.revision, room.id, HumanId('web-user'), 'must not commit', [alice.id],
    )).rejects.toThrow(/dispatcher is not available/)

    expect(booted.service.snapshot()).toEqual(before)
    expect(booted.service.runtimeStatus()).toEqual({ rooms: {} })
    await booted.dispose()
  })

  test('a dispatcher captured before commit survives generation teardown without pending leakage', async () => {
    const booted = await boot()
    await booted.service.executeInternal({ type: 'definition/create', name: 'Worker', description: '', instructions: '' })
    let snapshot = booted.service.snapshot()
    const definition = Object.values(snapshot.definitions)[0]!
    await booted.service.executeInternal({ type: 'agent/create', definitionId: definition.id, name: 'Alice' })
    await booted.service.executeInternal({ type: 'room/create', kind: 'group', name: 'room' })
    snapshot = booted.service.snapshot()
    const alice = Object.values(snapshot.agents)[0]!
    const room = Object.values(snapshot.rooms)[0]!
    await booted.service.executeInternal({ type: 'room/join', roomId: room.id, agentId: alice.id, memoryStart: { type: 'new-events' } })
    snapshot = booted.service.snapshot()
    const continued = vi.fn(async () => {})
    ;(booted.service as unknown as { dispatcher: Pick<WorkspaceDispatcher, 'continueCommittedHumanMessage'> | undefined }).dispatcher = {
      continueCommittedHumanMessage: continued,
    }
    booted.ctx.on('domain/changed', () => {
      ;(booted.service as unknown as { dispatcher: WorkspaceDispatcher | undefined }).dispatcher = undefined
    })

    await expect(booted.service.postHumanMessage(
      snapshot.revision, room.id, HumanId('web-user'), 'committed once', [alice.id],
    )).resolves.toMatchObject({ revision: snapshot.revision + 1 })
    await Promise.resolve()

    expect(continued).toHaveBeenCalledTimes(1)
    expect(booted.service.runtimeStatus()).toEqual({ rooms: {} })
    await booted.dispose()
  })

  test('child stop commits its cancellation in the caller CAS slot', async () => {
    const booted = await boot()
    let childRunId: ChildRunId | undefined
    await booted.service.apply(current => {
      const definition = mutateWorkspace(current, { type: 'definition/create', name: 'Worker', description: '', instructions: '' })
      const agent = mutateWorkspace(definition.state, { type: 'agent/create', definitionId: definition.definitionId, name: 'Alice' })
      const assigned = assignHumanTask(agent.state, { humanId: HumanId('owner'), assigneeAgentId: agent.agentId, title: 'root' })
      const child = recordChildRunStarted(assigned.state, { parentAgentId: agent.agentId, taskId: assigned.taskId })
      childRunId = child.childRunId
      return child.state
    })
    if (childRunId === undefined) throw new Error('child setup did not publish an id')
    const expectedRevision = booted.service.snapshot().revision
    let competitor: Promise<unknown> | undefined
    ;(booted.service as unknown as { childControllers: { register(input: unknown): unknown } }).childControllers.register({
      childRunId,
      parentAgentId: Object.values(booted.service.snapshot().agents)[0]!.id,
      taskId: Object.values(booted.service.snapshot().tasks)[0]!.id,
      abort: () => {
        competitor = booted.service.execute(expectedRevision, { type: 'room/create', kind: 'group', name: 'racer' })
      },
    })

    const stopped = await booted.service.stopChildRun(expectedRevision, childRunId)
    if (competitor === undefined) throw new Error('child stop did not start its deterministic competitor')

    await expect(competitor).rejects.toMatchObject({ code: 'stale-revision' })
    expect(stopped).toEqual({ revision: expectedRevision + 1, value: { status: 'stopping' } })
    expect(booted.service.snapshot().childRuns[childRunId]?.status).toBe('cancelled')
    await booted.dispose()
  })

  test('task retry commits delivery start in the caller CAS slot', async () => {
    const booted = await boot()
    let taskId: ReturnType<typeof assignHumanTask>['taskId'] | undefined
    await booted.service.apply(current => {
      const definition = mutateWorkspace(current, { type: 'definition/create', name: 'Worker', description: '', instructions: '' })
      const agent = mutateWorkspace(definition.state, { type: 'agent/create', definitionId: definition.definitionId, name: 'Alice' })
      const assigned = assignHumanTask(agent.state, { humanId: HumanId('owner'), assigneeAgentId: agent.agentId, title: 'root' })
      const started = startTaskDelivery(assigned.state, { taskId: assigned.taskId })
      taskId = assigned.taskId
      return failTaskDelivery(started.state, {
        taskId: assigned.taskId,
        attemptId: started.attemptId,
        messageId: started.message.id,
        failureCode: 'test',
        failureSummary: 'retryable',
      }).state
    })
    if (taskId === undefined) throw new Error('task setup did not publish an id')
    const expectedRevision = booted.service.snapshot().revision
    const enteredEmployee = Promise.withResolvers<void>()
    const releaseEmployee = Promise.withResolvers<void>()
    const coordinator = new TaskDeliveryCoordinator({
      snapshot: () => booted.service.snapshot(),
      apply: async mutation => await booted.service.apply(mutation),
      ensureEmployee: async () => {
        enteredEmployee.resolve()
        await releaseEmployee.promise
        return handle()
      },
      deliver: async (_agentId, _message, _recall, _source, hooks) => {
        await hooks?.onClaim?.()
        return { output: [{ type: 'text', text: 'retried' }], stopReason: { kind: 'completed' }, interrupted: false }
      },
    })
    ;(booted.service as unknown as { taskDelivery: TaskDeliveryCoordinator }).taskDelivery = coordinator

    const retry = booted.service.retryTaskDelivery(expectedRevision, taskId)
    await enteredEmployee.promise
    await expect(booted.service.execute(expectedRevision, {
      type: 'room/create', kind: 'group', name: 'racer',
    })).rejects.toMatchObject({ code: 'stale-revision' })
    releaseEmployee.resolve()

    await expect(retry).resolves.toEqual({ revision: expectedRevision + 1, value: 'retried' })
    expect(booted.service.snapshot().events.filter(event => event.type === 'task/delivery-started')).toHaveLength(2)
    await booted.dispose()
  })

  test('a Browser retry survives recovery while its resumed assignee is unpublished', async () => {
    const booted = await boot()
    let agentId: AgentId | undefined
    let taskId: ReturnType<typeof assignHumanTask>['taskId'] | undefined
    await booted.service.apply(current => {
      const definition = mutateWorkspace(current, { type: 'definition/create', name: 'Worker', description: '', instructions: '' })
      const agent = mutateWorkspace(definition.state, { type: 'agent/create', definitionId: definition.definitionId, name: 'Alice' })
      const assigned = assignHumanTask(agent.state, { humanId: HumanId('owner'), assigneeAgentId: agent.agentId, title: 'root' })
      const started = startTaskDelivery(assigned.state, { taskId: assigned.taskId })
      agentId = agent.agentId
      taskId = assigned.taskId
      return failTaskDelivery(started.state, {
        taskId: assigned.taskId,
        attemptId: started.attemptId,
        messageId: started.message.id,
        failureCode: 'test',
        failureSummary: 'retryable',
      }).state
    })
    if (agentId === undefined || taskId === undefined) throw new Error('resumed retry setup did not publish durable ids')

    const dispose = vi.fn(async () => {})
    const resumedAgent = {
      id: SessionId('resumed-employee'),
      inbox: { nextTurn: [], nextStep: [], hasPending: false },
      session: { events: [] },
    } as unknown as Agent
    const resumedHandle = { agent: resumedAgent, dispose }
    const resume = vi.fn(async (options: { setup?: (ctx: Context) => Promise<unknown> }) => {
      await options.setup?.({ agent: resumedAgent } as unknown as Context)
      return resumedHandle
    })
    const source: EmployeeSessionSource = {
      sessionIdFor: () => SessionId('resumed-employee'),
      recordSessionId: async () => {},
    }
    let coordinator: TaskDeliveryCoordinator
    const pool = new EmployeeAgentPool(
      { create: vi.fn(async () => { throw new Error('must resume the bound employee') }), resume },
      source,
      undefined,
      async (recoveringAgentId, recoveringAgent) => {
        await coordinator.recoverAgent(recoveringAgentId, { agent: recoveringAgent })
      },
    )
    const deliveries: UserMessage[] = []
    coordinator = new TaskDeliveryCoordinator({
      snapshot: () => booted.service.snapshot(),
      apply: async mutation => await booted.service.apply(mutation),
      ensureEmployee: async ensuringAgentId => await pool.ensure(ensuringAgentId),
      deliver: async (_agentId, message, _recall, _source, hooks) => {
        deliveries.push(message)
        await hooks?.onClaim?.()
        return { output: [{ type: 'text', text: 'resumed result' }], stopReason: { kind: 'completed' }, interrupted: false }
      },
    })
    const serviceRuntime = booted.service as unknown as {
      pool: EmployeeAgentPool | undefined
      taskDelivery: TaskDeliveryCoordinator | undefined
    }
    serviceRuntime.pool = pool
    serviceRuntime.taskDelivery = coordinator

    try {
      const before = booted.service.snapshot()
      await expect(booted.service.retryTaskDelivery(before.revision, taskId)).resolves.toEqual({
        revision: before.revision + 1,
        value: 'resumed result',
      })

      const after = booted.service.snapshot()
      expect(resume).toHaveBeenCalledTimes(1)
      expect(deliveries).toHaveLength(1)
      expect(after.events.filter(event => event.type === 'task/delivery-started')).toHaveLength(2)
      expect(after.events.filter(event => event.type === 'task/delivery-failed')).toHaveLength(1)
      expect(after.events.filter(event => event.type === 'task/delivery-accepted')).toHaveLength(1)
      expect(after.events.filter(event => event.type === 'task/result')).toHaveLength(1)
      expect(after.tasks[taskId]?.status).toBe('completed')

      await pool.disposeAll()
      expect(dispose).toHaveBeenCalledTimes(1)
      expect(pool.handleFor(agentId)).toBeUndefined()
    } finally {
      serviceRuntime.pool = undefined
      serviceRuntime.taskDelivery = undefined
      await pool.disposeAll()
      await booted.dispose()
    }
  })

  test('concurrent recovery observes Browser retry ownership before reservation adoption', async () => {
    const booted = await boot()
    let agentId: AgentId | undefined
    let blockerTaskId: ReturnType<typeof assignHumanTask>['taskId'] | undefined
    let retryTaskId: ReturnType<typeof assignHumanTask>['taskId'] | undefined
    await booted.service.apply(current => {
      const definition = mutateWorkspace(current, { type: 'definition/create', name: 'Worker', description: '', instructions: '' })
      const agent = mutateWorkspace(definition.state, { type: 'agent/create', definitionId: definition.definitionId, name: 'Alice' })
      const blocker = assignHumanTask(agent.state, { humanId: HumanId('owner'), assigneeAgentId: agent.agentId, title: 'orphan' })
      const blockerStarted = startTaskDelivery(blocker.state, { taskId: blocker.taskId })
      const retry = assignHumanTask(blockerStarted.state, { humanId: HumanId('owner'), assigneeAgentId: agent.agentId, title: 'retry' })
      const retryStarted = startTaskDelivery(retry.state, { taskId: retry.taskId })
      agentId = agent.agentId
      blockerTaskId = blocker.taskId
      retryTaskId = retry.taskId
      return failTaskDelivery(retryStarted.state, {
        taskId: retry.taskId,
        attemptId: retryStarted.attemptId,
        messageId: retryStarted.message.id,
        failureCode: 'test',
        failureSummary: 'retryable',
      }).state
    })
    if (agentId === undefined || blockerTaskId === undefined || retryTaskId === undefined) {
      throw new Error('concurrent recovery setup did not publish durable ids')
    }

    const recoveryPaused = Promise.withResolvers<void>()
    const releaseRecovery = Promise.withResolvers<void>()
    let pauseRecovery = true
    const coordinator = new TaskDeliveryCoordinator({
      snapshot: () => booted.service.snapshot(),
      apply: async mutation => {
        const committed = await booted.service.apply(mutation)
        const latest = committed.events.at(-1)
        if (pauseRecovery && latest?.type === 'task/delivery-failed' && latest.taskId === blockerTaskId) {
          pauseRecovery = false
          recoveryPaused.resolve()
          await releaseRecovery.promise
        }
        return committed
      },
      ensureEmployee: async () => handle(),
      deliver: async (_agentId, _message, _recall, _source, hooks) => {
        await hooks?.onClaim?.()
        return { output: [{ type: 'text', text: 'owned result' }], stopReason: { kind: 'completed' }, interrupted: false }
      },
    })
    ;(booted.service as unknown as { taskDelivery: TaskDeliveryCoordinator | undefined }).taskDelivery = coordinator
    const recovery = coordinator.recoverAgent(agentId, {
      agent: {
        id: SessionId('already-resuming'),
        inbox: { nextTurn: [], nextStep: [], hasPending: false },
        session: { events: [] },
      } as unknown as Agent,
    })
    await recoveryPaused.promise

    type TestTable = {
      get(key: WorkspaceId): WorkspaceState | undefined
      update(key: WorkspaceId, mutation: (current: WorkspaceState | undefined) => WorkspaceState): Promise<WorkspaceState>
    }
    const table = (booted.service as unknown as { table: TestTable }).table
    const update = table.update.bind(table)
    const retryCommitted = Promise.withResolvers<void>()
    const allowAdoption = Promise.withResolvers<void>()
    let pauseRetryCommit = true
    table.update = async (key, mutation) => {
      const committed = await update(key, mutation)
      if (pauseRetryCommit) {
        pauseRetryCommit = false
        retryCommitted.resolve()
        await allowAdoption.promise
      }
      return committed
    }
    const before = booted.service.snapshot()
    const retry = booted.service.retryTaskDelivery(before.revision, retryTaskId)

    try {
      await retryCommitted.promise
      releaseRecovery.resolve()
      await expect(recovery).resolves.toEqual([{ taskId: blockerTaskId, status: 'interrupted' }])
      allowAdoption.resolve()
      await expect(retry).resolves.toEqual({ revision: before.revision + 1, value: 'owned result' })

      const after = booted.service.snapshot()
      expect(after.events.filter(event => event.type === 'task/delivery-started' && event.taskId === retryTaskId)).toHaveLength(2)
      expect(after.events.filter(event => event.type === 'task/delivery-failed' && event.taskId === retryTaskId)).toHaveLength(1)
      expect(after.events.filter(event => event.type === 'task/result' && event.taskId === retryTaskId)).toHaveLength(1)
    } finally {
      releaseRecovery.resolve()
      allowAdoption.resolve()
      table.update = update
      ;(booted.service as unknown as { taskDelivery: TaskDeliveryCoordinator | undefined }).taskDelivery = undefined
      await Promise.allSettled([recovery, retry])
      await booted.dispose()
    }
  })

  test('task cancellation invalidates a committed retry before reservation adoption', async () => {
    const booted = await boot()
    let taskId: ReturnType<typeof assignHumanTask>['taskId'] | undefined
    await booted.service.apply(current => {
      const definition = mutateWorkspace(current, { type: 'definition/create', name: 'Worker', description: '', instructions: '' })
      const agent = mutateWorkspace(definition.state, { type: 'agent/create', definitionId: definition.definitionId, name: 'Alice' })
      const assigned = assignHumanTask(agent.state, { humanId: HumanId('owner'), assigneeAgentId: agent.agentId, title: 'root' })
      const started = startTaskDelivery(assigned.state, { taskId: assigned.taskId })
      taskId = assigned.taskId
      return failTaskDelivery(started.state, {
        taskId: assigned.taskId,
        attemptId: started.attemptId,
        messageId: started.message.id,
        failureCode: 'test',
        failureSummary: 'retryable',
      }).state
    })
    if (taskId === undefined) throw new Error('retry cancellation setup did not publish a task')

    const deliveries: UserMessage[] = []
    const coordinator = new TaskDeliveryCoordinator({
      snapshot: () => booted.service.snapshot(),
      apply: async mutation => await booted.service.apply(mutation),
      ensureEmployee: async () => handle(),
      deliver: async (_agentId, message, _recall, _source, hooks) => {
        deliveries.push(message)
        await hooks?.onClaim?.()
        return { output: [{ type: 'text', text: 'must not run' }], stopReason: { kind: 'completed' }, interrupted: false }
      },
    })
    ;(booted.service as unknown as { taskDelivery: TaskDeliveryCoordinator | undefined }).taskDelivery = coordinator
    type TestTable = {
      get(key: WorkspaceId): WorkspaceState | undefined
      update(key: WorkspaceId, mutation: (current: WorkspaceState | undefined) => WorkspaceState): Promise<WorkspaceState>
    }
    const table = (booted.service as unknown as { table: TestTable }).table
    const update = table.update.bind(table)
    const retryCommitted = Promise.withResolvers<void>()
    const allowAdoption = Promise.withResolvers<void>()
    let pauseRetryCommit = true
    table.update = async (key, mutation) => {
      const committed = await update(key, mutation)
      if (pauseRetryCommit) {
        pauseRetryCommit = false
        retryCommitted.resolve()
        await allowAdoption.promise
      }
      return committed
    }
    const before = booted.service.snapshot()
    const retry = booted.service.retryTaskDelivery(before.revision, taskId)

    try {
      await retryCommitted.promise
      const cancellation = await booted.service.cancelTask(
        booted.service.snapshot().revision,
        HumanId('web-user'),
        taskId,
      )
      allowAdoption.resolve()
      await expect(retry).rejects.toThrow(/cancel/i)

      expect(cancellation.value.tasks[taskId]?.status).toBe('cancelled')
      expect(deliveries).toHaveLength(0)
      expect(booted.service.snapshot().events.some(event => (
        (event.type === 'task/result' || event.type === 'task/result-after-cancel') && event.taskId === taskId
      ))).toBe(false)
      const released = coordinator.reserveTaskDelivery(taskId)
      released.rollback()
      await expect(released.result()).rejects.toThrow(/rolled back/)
    } finally {
      allowAdoption.resolve()
      table.update = update
      ;(booted.service as unknown as { taskDelivery: TaskDeliveryCoordinator | undefined }).taskDelivery = undefined
      await Promise.allSettled([retry])
      await booted.dispose()
    }
  })

  test('task cancellation during employee admission prevents retry delivery', async () => {
    const booted = await boot()
    const { taskId } = await seedRetryableTask(booted.service)
    const ensureEntered = Promise.withResolvers<void>()
    const releaseEnsure = Promise.withResolvers<void>()
    const deliveries: UserMessage[] = []
    const coordinator = new TaskDeliveryCoordinator({
      snapshot: () => booted.service.snapshot(),
      apply: async mutation => await booted.service.apply(mutation),
      ensureEmployee: async () => {
        ensureEntered.resolve()
        await releaseEnsure.promise
        return handle()
      },
      deliver: async (_agentId, message, _recall, _source, hooks) => {
        deliveries.push(message)
        await hooks?.onClaim?.()
        return { output: [{ type: 'text', text: 'must not run' }], stopReason: { kind: 'completed' }, interrupted: false }
      },
    })
    ;(booted.service as unknown as { taskDelivery: TaskDeliveryCoordinator | undefined }).taskDelivery = coordinator
    const retry = booted.service.retryTaskDelivery(booted.service.snapshot().revision, taskId)

    try {
      await ensureEntered.promise
      await booted.service.cancelTask(booted.service.snapshot().revision, HumanId('web-user'), taskId)
      releaseEnsure.resolve()
      await expect(retry).rejects.toThrow(/cancel/i)
      expect(deliveries).toHaveLength(0)
      expect(booted.service.snapshot().events.some(event => (
        (event.type === 'task/result' || event.type === 'task/result-after-cancel') && event.taskId === taskId
      ))).toBe(false)
    } finally {
      releaseEnsure.resolve()
      ;(booted.service as unknown as { taskDelivery: TaskDeliveryCoordinator | undefined }).taskDelivery = undefined
      await Promise.allSettled([retry])
      await booted.dispose()
    }
  })

  test('task cancellation at the Host admission gate prevents tracker registration', async () => {
    const booted = await boot()
    const { agentId, taskId } = await seedRetryableTask(booted.service)
    const deliveryReady = Promise.withResolvers<void>()
    const releaseDelivery = Promise.withResolvers<void>()
    const trackerDeliver = vi.fn(async () => { throw new Error('tracker admitted after cancellation') })
    const employee = {
      agent: {
        id: SessionId('admission-gate'),
        inbox: { remove: vi.fn(() => false) },
      } as unknown as Agent,
      dispose: vi.fn(async () => {}),
    }
    const pool = {
      roleRevisionFor: () => undefined,
      handleFor: () => employee,
      runDelivery: async <T>(_agentId: AgentId, run: (handle: AgentHandle) => Promise<T>): Promise<T> => {
        deliveryReady.resolve()
        await releaseDelivery.promise
        return await run(employee)
      },
    }
    const coordinator = new TaskDeliveryCoordinator({
      snapshot: () => booted.service.snapshot(),
      apply: async mutation => await booted.service.apply(mutation),
      ensureEmployee: async () => employee,
      deliver: async (deliveryAgentId, message, recall, source, hooks) => (
        await booted.service.deliver(deliveryAgentId, message, recall, source, hooks)
      ),
    })
    const internals = booted.service as unknown as {
      pool: typeof pool | undefined
      taskDelivery: TaskDeliveryCoordinator | undefined
      trackers: Map<AgentId, { deliver: typeof trackerDeliver }>
    }
    internals.pool = pool
    internals.taskDelivery = coordinator
    internals.trackers.set(agentId, { deliver: trackerDeliver })
    const retry = booted.service.retryTaskDelivery(booted.service.snapshot().revision, taskId)

    try {
      await deliveryReady.promise
      await booted.service.cancelTask(booted.service.snapshot().revision, HumanId('web-user'), taskId)
      releaseDelivery.resolve()
      await expect(retry).rejects.toThrow(/cancel/i)
      expect(trackerDeliver).not.toHaveBeenCalled()
      expect(booted.service.snapshot().events.some(event => (
        (event.type === 'task/result' || event.type === 'task/result-after-cancel') && event.taskId === taskId
      ))).toBe(false)
    } finally {
      releaseDelivery.resolve()
      internals.trackers.delete(agentId)
      internals.pool = undefined
      internals.taskDelivery = undefined
      await Promise.allSettled([retry])
      await booted.dispose()
    }
  })

  test('task cancellation after retry claim suppresses its completed output', async () => {
    const booted = await boot()
    const { taskId } = await seedRetryableTask(booted.service)
    const claimed = Promise.withResolvers<void>()
    const releaseTurn = Promise.withResolvers<void>()
    const coordinator = new TaskDeliveryCoordinator({
      snapshot: () => booted.service.snapshot(),
      apply: async mutation => await booted.service.apply(mutation),
      ensureEmployee: async () => handle(),
      deliver: async (_agentId, _message, _recall, _source, hooks) => {
        await hooks?.onClaim?.()
        claimed.resolve()
        await releaseTurn.promise
        return { output: [{ type: 'text', text: 'cancelled output' }], stopReason: { kind: 'completed' }, interrupted: false }
      },
    })
    ;(booted.service as unknown as { taskDelivery: TaskDeliveryCoordinator | undefined }).taskDelivery = coordinator
    const retry = booted.service.retryTaskDelivery(booted.service.snapshot().revision, taskId)

    try {
      await claimed.promise
      await booted.service.cancelTask(booted.service.snapshot().revision, HumanId('web-user'), taskId)
      releaseTurn.resolve()
      await expect(retry).rejects.toThrow(/cancel/i)
      expect(booted.service.snapshot().events.some(event => (
        (event.type === 'task/result' || event.type === 'task/result-after-cancel') && event.taskId === taskId
      ))).toBe(false)
    } finally {
      releaseTurn.resolve()
      ;(booted.service as unknown as { taskDelivery: TaskDeliveryCoordinator | undefined }).taskDelivery = undefined
      await Promise.allSettled([retry])
      await booted.dispose()
    }
  })

  test('task cancellation returns its own final child-cleanup commit during unrelated work', async () => {
    const booted = await boot()
    let childRunId: ChildRunId | undefined
    let taskId: ReturnType<typeof assignHumanTask>['taskId'] | undefined
    await booted.service.apply(current => {
      const definition = mutateWorkspace(current, { type: 'definition/create', name: 'Worker', description: '', instructions: '' })
      const agent = mutateWorkspace(definition.state, { type: 'agent/create', definitionId: definition.definitionId, name: 'Alice' })
      const assigned = assignHumanTask(agent.state, { humanId: HumanId('owner'), assigneeAgentId: agent.agentId, title: 'root' })
      const child = recordChildRunStarted(assigned.state, { parentAgentId: agent.agentId, taskId: assigned.taskId })
      taskId = assigned.taskId
      childRunId = child.childRunId
      return child.state
    })
    if (taskId === undefined || childRunId === undefined) throw new Error('cancellation setup did not publish durable ids')
    const before = booted.service.snapshot()
    let competitor: Promise<unknown> | undefined
    ;(booted.service as unknown as { childControllers: { register(input: unknown): unknown } }).childControllers.register({
      childRunId,
      parentAgentId: Object.values(before.agents)[0]!.id,
      taskId,
      abort: () => {
        competitor = booted.service.execute(booted.service.snapshot().revision, {
          type: 'room/create', kind: 'group', name: 'unrelated',
        })
      },
    })

    const cancelled = await booted.service.cancelTask(before.revision, HumanId('web-user'), taskId)
    if (competitor === undefined) throw new Error('child cleanup did not start its deterministic competitor')
    await competitor

    expect(cancelled.revision).toBe(before.revision + 2)
    expect(cancelled.value.revision).toBe(cancelled.revision)
    expect(cancelled.value.childRuns[childRunId]?.status).toBe('cancelled')
    expect(Object.values(cancelled.value.rooms)).toHaveLength(0)
    expect(booted.service.snapshot().revision).toBe(cancelled.revision + 1)
    expect(Object.values(booted.service.snapshot().rooms)).toHaveLength(1)
    await booted.dispose()
  })

  test('a Browser retry rejects an existing flight before appending an unowned attempt', async () => {
    const booted = await boot()
    let taskId: ReturnType<typeof assignHumanTask>['taskId'] | undefined
    await booted.service.apply(current => {
      const definition = mutateWorkspace(current, { type: 'definition/create', name: 'Worker', description: '', instructions: '' })
      const agent = mutateWorkspace(definition.state, { type: 'agent/create', definitionId: definition.definitionId, name: 'Alice' })
      const assigned = assignHumanTask(agent.state, { humanId: HumanId('owner'), assigneeAgentId: agent.agentId, title: 'root' })
      const started = startTaskDelivery(assigned.state, { taskId: assigned.taskId })
      taskId = assigned.taskId
      return failTaskDelivery(started.state, {
        taskId: assigned.taskId,
        attemptId: started.attemptId,
        messageId: started.message.id,
        failureCode: 'test',
        failureSummary: 'retryable',
      }).state
    })
    if (taskId === undefined) throw new Error('retry race setup did not publish a task')
    const enteredEmployee = Promise.withResolvers<void>()
    const releaseEmployee = Promise.withResolvers<void>()
    const coordinator = new TaskDeliveryCoordinator({
      snapshot: () => booted.service.snapshot(),
      apply: async mutation => await booted.service.apply(mutation),
      ensureEmployee: async () => {
        enteredEmployee.resolve()
        await releaseEmployee.promise
        return handle()
      },
      deliver: async (_agentId, _message, _recall, _source, hooks) => {
        await hooks?.onClaim?.()
        return { output: [{ type: 'text', text: 'owned result' }], stopReason: { kind: 'completed' }, interrupted: false }
      },
    })
    ;(booted.service as unknown as { taskDelivery: TaskDeliveryCoordinator }).taskDelivery = coordinator
    const existing = coordinator.retryTaskDelivery(taskId)
    await enteredEmployee.promise
    const before = booted.service.snapshot()

    const browserOutcome = await booted.service.retryTaskDelivery(before.revision, taskId).then(
      value => ({ status: 'fulfilled' as const, value }),
      error => ({ status: 'rejected' as const, error }),
    )
    const whileBlocked = booted.service.snapshot()
    releaseEmployee.resolve()
    const existingOutcome = await existing.then(
      value => ({ status: 'fulfilled' as const, value }),
      error => ({ status: 'rejected' as const, error }),
    )

    expect(browserOutcome).toMatchObject({ status: 'rejected', error: expect.any(Error) })
    expect(whileBlocked).toEqual(before)
    expect(existingOutcome).toEqual({ status: 'fulfilled', value: 'owned result' })
    expect(booted.service.snapshot().events.filter(event => event.type === 'task/delivery-started')).toHaveLength(2)
    expect(booted.service.snapshot().tasks[taskId]?.status).toBe('completed')
    await booted.dispose()
  })

  test('a rejected retry table write rolls back its flight reservation', async () => {
    const booted = await boot()
    let taskId: ReturnType<typeof assignHumanTask>['taskId'] | undefined
    await booted.service.apply(current => {
      const definition = mutateWorkspace(current, { type: 'definition/create', name: 'Worker', description: '', instructions: '' })
      const agent = mutateWorkspace(definition.state, { type: 'agent/create', definitionId: definition.definitionId, name: 'Alice' })
      const assigned = assignHumanTask(agent.state, { humanId: HumanId('owner'), assigneeAgentId: agent.agentId, title: 'root' })
      const started = startTaskDelivery(assigned.state, { taskId: assigned.taskId })
      taskId = assigned.taskId
      return failTaskDelivery(started.state, {
        taskId: assigned.taskId,
        attemptId: started.attemptId,
        messageId: started.message.id,
        failureCode: 'test',
        failureSummary: 'retryable',
      }).state
    })
    if (taskId === undefined) throw new Error('retry rollback setup did not publish a task')
    const coordinator = new TaskDeliveryCoordinator({
      snapshot: () => booted.service.snapshot(),
      apply: async mutation => await booted.service.apply(mutation),
      ensureEmployee: async () => handle(),
      deliver: async (_agentId, _message, _recall, _source, hooks) => {
        await hooks?.onClaim?.()
        return { output: [{ type: 'text', text: 'retry after write failure' }], stopReason: { kind: 'completed' }, interrupted: false }
      },
    })
    ;(booted.service as unknown as { taskDelivery: TaskDeliveryCoordinator }).taskDelivery = coordinator
    const before = booted.service.snapshot()
    type TestTable = {
      get(key: WorkspaceId): WorkspaceState | undefined
      update(key: WorkspaceId, mutation: (current: WorkspaceState | undefined) => WorkspaceState): Promise<WorkspaceState>
    }
    const table = (booted.service as unknown as { table: TestTable }).table
    const update = table.update.bind(table)
    table.update = async (key, mutation) => {
      const current = table.get(key)
      mutation(current)
      throw new Error('retry table write failed')
    }

    try {
      await expect(booted.service.retryTaskDelivery(before.revision, taskId)).rejects.toThrow('retry table write failed')
      expect(booted.service.snapshot()).toEqual(before)
    } finally {
      table.update = update
    }

    await expect(booted.service.retryTaskDelivery(before.revision, taskId)).resolves.toEqual({
      revision: before.revision + 1,
      value: 'retry after write failure',
    })
    await booted.dispose()
  })

  test('task assignment rejects a missing delivery runtime before committing', async () => {
    const booted = await boot()
    await booted.service.executeInternal({ type: 'definition/create', name: 'Worker', description: '', instructions: '' })
    let before = booted.service.snapshot()
    const definition = Object.values(before.definitions)[0]!
    await booted.service.executeInternal({ type: 'agent/create', definitionId: definition.id, name: 'Alice' })
    before = booted.service.snapshot()
    const alice = Object.values(before.agents)[0]!

    await expect(booted.service.assignTask(
      before.revision,
      HumanId('web-user'),
      alice.id,
      'must not commit',
    )).rejects.toThrow(/coordinator is not available/)

    expect(booted.service.snapshot()).toEqual(before)
    await booted.dispose()
  })

  test('two mutations released at one revision commit exactly one winner', async () => {
    const booted = await boot()
    const release = Promise.withResolvers<void>()
    const compete = async (name: string) => {
      await release.promise
      return await booted.service.execute(0, {
        type: 'definition/create', name, description: '', instructions: '',
      })
    }
    const first = compete('First')
    const second = compete('Second')

    release.resolve()
    const results = await Promise.allSettled([first, second])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected')
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({
        code: 'stale-revision',
        details: { expectedRevision: 0, actualRevision: 1 },
      }),
    })
    expect(Object.values(booted.service.snapshot().definitions)).toHaveLength(1)
    await booted.dispose()
  })

  test.each([
    ['definition/create', { expectedRevision: 0, name: 'Role', description: '', instructions: '' }],
    ['definition/revise', { expectedRevision: 0, definitionId: 'missing', description: '', instructions: '' }],
    ['definition/synchronize', { expectedRevision: 0, definitionId: 'missing', definitionRevisionId: 'missing', agentIds: ['missing'] }],
    ['agent/create', { expectedRevision: 0, definitionId: 'missing', name: 'Alice' }],
    ['agent/depart', { expectedRevision: 0, agentId: 'missing' }],
    ['agent/employ', { expectedRevision: 0, agentId: 'missing' }],
    ['room/create', { expectedRevision: 0, kind: 'group', name: 'Room' }],
    ['room/direct/open', { expectedRevision: 0, agentId: 'missing' }],
    ['room/join', { expectedRevision: 0, roomId: 'missing', agentId: 'missing', memoryStart: { type: 'new-events' } }],
    ['room/leave', { expectedRevision: 0, membershipId: 'missing' }],
    ['room/post', { expectedRevision: 0, roomId: 'missing', text: 'hello', mentions: [] }],
    ['task/assign', { expectedRevision: 0, assigneeAgentId: 'missing', title: 'Task' }],
    ['task/grant', { expectedRevision: 0, granteeAgentId: 'missing', rootTaskId: 'missing' }],
    ['task/revoke', { expectedRevision: 0, delegationGrantId: 'missing' }],
    ['task/cancel', { expectedRevision: 0, taskId: 'missing' }],
    ['task/retry-delivery', { expectedRevision: 0, taskId: 'missing' }],
    ['runtime/activity/stop', { expectedRevision: 0, activityId: 'missing', agentId: 'missing', messageId: 'missing', sessionId: 'missing', turn: 0 }],
    ['runtime/child/stop', { expectedRevision: 0, childRunId: 'missing' }],
    ['runtime/failure/acknowledge', { expectedRevision: 0, agentId: 'missing' }],
  ] as const)('%s reports real stale details with zero durable or runtime effects', async (endpoint, payload) => {
    const booted = await boot()
    await booted.service.execute(0, { type: 'definition/create', name: 'Seed', description: '', instructions: '' })
    const before = booted.service.snapshot()
    const runtimeBefore = booted.service.runtimeStatus()
    const activityBefore = booted.service.activitySnapshot()

    const result = await createWorkspaceRpcHandler(booted.service)(endpoint, payload, new AbortController().signal)

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'business', code: 'stale-revision', details: { expectedRevision: 0, actualRevision: 1 } },
    })
    expect(booted.service.snapshot()).toEqual(before)
    expect(booted.service.runtimeStatus()).toEqual(runtimeBefore)
    expect(booted.service.activitySnapshot()).toEqual(activityBefore)
    await booted.dispose()
  })

  test('all definition, agent, room, membership, and post endpoints return their real committed revision', async () => {
    const booted = await boot()
    const handler = createWorkspaceRpcHandler(booted.service)
    const call = async (endpoint: string, payload: object, revision: number, committedRevision = revision + 1): Promise<void> => {
      const result = await handler(endpoint, { expectedRevision: revision, ...payload }, new AbortController().signal)
      expect(result).toMatchObject({ ok: true, value: { revision: committedRevision } })
      expect(booted.service.snapshot().revision).toBe(committedRevision)
    }

    await call('definition/create', { name: 'Worker', description: '', instructions: '' }, 0)
    let snapshot = booted.service.snapshot()
    const definition = Object.values(snapshot.definitions)[0]!
    const firstRevisionId = definition.currentRevisionId
    await call('definition/revise', { definitionId: definition.id, description: 'v2', instructions: '' }, 1)
    await call('agent/create', { definitionId: definition.id, name: 'Alice' }, 2)
    snapshot = booted.service.snapshot()
    const alice = Object.values(snapshot.agents)[0]!
    await call('definition/synchronize', {
      definitionId: definition.id, definitionRevisionId: firstRevisionId, agentIds: [alice.id],
    }, 3)
    await call('agent/depart', { agentId: alice.id }, 4)
    await call('agent/employ', { agentId: alice.id }, 5)
    await call('room/create', { kind: 'group', name: 'Group' }, 6)
    snapshot = booted.service.snapshot()
    const group = Object.values(snapshot.rooms)[0]!
    await call('room/direct/open', { agentId: alice.id }, 7, 9)
    await call('room/join', { roomId: group.id, agentId: alice.id, memoryStart: { type: 'new-events' } }, 9)
    snapshot = booted.service.snapshot()
    const groupMembership = Object.values(snapshot.memberships).find(membership => membership.roomId === group.id)!
    await call('room/leave', { membershipId: groupMembership.id }, 10)
    await call('room/post', { roomId: group.id, text: 'human note', mentions: [] }, 11)

    const message = booted.service.snapshot().events.at(-1)
    expect(message).toMatchObject({ type: 'room/message', actor: { type: 'human', id: 'web-user' } })
    await booted.dispose()
  })

  test('task mutation endpoints return the revision committed by the real service', async () => {
    const booted = await boot()
    await booted.service.execute(0, { type: 'definition/create', name: 'Worker', description: '', instructions: '' })
    const definition = Object.values(booted.service.snapshot().definitions)[0]!
    await booted.service.execute(1, { type: 'agent/create', definitionId: definition.id, name: 'Alice' })
    const alice = Object.values(booted.service.snapshot().agents)[0]!
    ;(booted.service as unknown as { taskDelivery: Pick<TaskDeliveryCoordinator, 'deliver' | 'cancelTaskDelivery'> }).taskDelivery = {
      deliver: vi.fn(async () => 'not started by this transport assertion'),
      cancelTaskDelivery: vi.fn(),
    }
    const handler = createWorkspaceRpcHandler(booted.service)

    const assigned = await handler('task/assign', {
      expectedRevision: 2, assigneeAgentId: alice.id, title: 'Root task',
    }, new AbortController().signal)
    expect(assigned).toMatchObject({ ok: true, value: { revision: 3 } })
    const rootTaskId = Object.values(booted.service.snapshot().tasks)[0]!.id

    const granted = await handler('task/grant', {
      expectedRevision: 3, granteeAgentId: alice.id, rootTaskId,
    }, new AbortController().signal)
    expect(granted).toMatchObject({ ok: true, value: { revision: 4 } })
    const grantId = Object.values(booted.service.snapshot().delegationGrants)[0]!.id

    await expect(handler('task/revoke', {
      expectedRevision: 4, delegationGrantId: grantId,
    }, new AbortController().signal)).resolves.toMatchObject({ ok: true, value: { revision: 5 } })
    await expect(handler('task/cancel', {
      expectedRevision: 5, taskId: rootTaskId,
    }, new AbortController().signal)).resolves.toMatchObject({ ok: true, value: { revision: 6 } })
    const final = booted.service.snapshot()
    expect(final.revision).toBe(6)
    expect(final.events.filter(event => (
      event.type === 'task/assigned' || event.type === 'task/delegation-granted'
      || event.type === 'task/delegation-revoked' || event.type === 'task/cancelled'
    )).every(event => event.actor?.type === 'human' && event.actor.id === 'web-user')).toBe(true)
    await booted.dispose()
  })

  test('real converged activity and failure controls return the checked durable revision', async () => {
    const booted = await boot()
    const handler = createWorkspaceRpcHandler(booted.service)

    await expect(handler('runtime/activity/stop', {
      expectedRevision: 0,
      activityId: 'missing', agentId: 'missing', messageId: 'missing', sessionId: 'missing', turn: 0,
    }, new AbortController().signal)).resolves.toEqual({
      ok: true, value: { revision: 0, value: { status: 'not-active' } },
    })
    await expect(handler('runtime/failure/acknowledge', {
      expectedRevision: 0, agentId: 'missing',
    }, new AbortController().signal)).resolves.toEqual({
      ok: true, value: { revision: 0, value: undefined },
    })
    expect(booted.service.snapshot().revision).toBe(0)
    await booted.dispose()
  })

  test('only the winning same-revision post schedules runtime work', async () => {
    const booted = await boot()
    await booted.service.executeInternal({ type: 'definition/create', name: 'Worker', description: '', instructions: '' })
    let snapshot = booted.service.snapshot()
    const definition = Object.values(snapshot.definitions)[0]!
    await booted.service.executeInternal({ type: 'agent/create', definitionId: definition.id, name: 'Alice' })
    await booted.service.executeInternal({ type: 'room/create', kind: 'group', name: 'room' })
    snapshot = booted.service.snapshot()
    const alice = Object.values(snapshot.agents)[0]!
    const room = Object.values(snapshot.rooms)[0]!
    await booted.service.executeInternal({
      type: 'room/join', roomId: room.id, agentId: alice.id, memoryStart: { type: 'new-events' },
    })
    snapshot = booted.service.snapshot()
    const continueCommittedHumanMessage = vi.fn(async () => {})
    ;(booted.service as unknown as { dispatcher: Pick<WorkspaceDispatcher, 'continueCommittedHumanMessage'> }).dispatcher = {
      continueCommittedHumanMessage,
    }
    const release = Promise.withResolvers<void>()
    const compete = async (text: string) => {
      await release.promise
      return await booted.service.postHumanMessage(
        snapshot.revision,
        room.id,
        HumanId('web-user'),
        text,
        [alice.id],
      )
    }
    const first = compete('first')
    const second = compete('second')

    release.resolve()
    const results = await Promise.allSettled([first, second])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(continueCommittedHumanMessage).toHaveBeenCalledTimes(1)
    expect(booted.service.snapshot().events.filter(event => event.type === 'room/message')).toHaveLength(1)
    await booted.dispose()
  })

  test('departing an agent closes its active membership with the departure event', async () => {
    const booted = await boot()
    await booted.service.executeInternal({ type: 'definition/create', name: 'Worker', description: 'd', instructions: 'i' })
    let snapshot = booted.service.snapshot()
    const definition = Object.values(snapshot.definitions)[0]!
    await booted.service.executeInternal({ type: 'agent/create', definitionId: definition.id, name: 'Alice' })
    await booted.service.executeInternal({ type: 'room/create', kind: 'group', name: 'room' })
    snapshot = booted.service.snapshot()
    const alice = Object.values(snapshot.agents)[0]!
    const room = Object.values(snapshot.rooms)[0]!
    await booted.service.executeInternal({
      type: 'room/join', roomId: room.id, agentId: alice.id, memoryStart: { type: 'new-events' },
    })

    const departed = await booted.service.executeInternal({ type: 'agent/depart', agentId: alice.id })

    const membership = Object.values(departed.memberships)[0]!
    const departure = departed.events.find(event => event.id === membership.leftEventId)
    expect(departure).toMatchObject({ type: 'agent/departed', subjectId: alice.id })
    await booted.dispose()
  })

  test('public room join synchronizes the requested historical room range', async () => {
    const booted = await boot()
    await booted.service.executeInternal({ type: 'definition/create', name: 'Worker', description: 'd', instructions: 'i' })
    let snapshot = booted.service.snapshot()
    const definition = Object.values(snapshot.definitions)[0]!
    await booted.service.executeInternal({ type: 'agent/create', definitionId: definition.id, name: 'Alice' })
    await booted.service.executeInternal({ type: 'room/create', kind: 'group', name: 'room' })
    snapshot = booted.service.snapshot()
    const alice = Object.values(snapshot.agents)[0]!
    const room = Object.values(snapshot.rooms)[0]!
    await booted.service.executeInternal({
      type: 'room/message',
      roomId: room.id,
      actor: { type: 'human', id: HumanId('owner') },
      text: 'historical message',
      mentions: [],
    })
    snapshot = booted.service.snapshot()
    const historical = snapshot.events.find(event => event.type === 'room/message')!

    await booted.service.executeInternal({
      type: 'room/join',
      roomId: room.id,
      agentId: alice.id,
      memoryStart: { type: 'event-range', startSequence: historical.sequence, endSequence: historical.sequence },
    })

    snapshot = booted.service.snapshot()
    expect(snapshot.memoryEntries.some(entry => entry.agentId === alice.id && entry.eventId === historical.id && entry.acquiredBy === 'history-sync')).toBe(true)
    await booted.dispose()
  })

  test('arbitrary service mutations cannot commit a state that violates aggregate invariants', async () => {
    const booted = await boot()
    const before = booted.service.snapshot()

    await expect(booted.service.apply(state => ({
      ...state,
      memoryEntries: [{
        id: AgentMemoryEntryId('memory-bad'),
        agentId: AgentId('missing-agent'),
        eventId: WorkspaceEventId('missing-event'),
        acquiredBy: 'task',
      }],
    }))).rejects.toThrow(/references missing/)

    expect(booted.service.snapshot()).toEqual(before)
    await booted.dispose()
  })

  test('unknown durable fields are rejected before commit and change notification', async () => {
    const booted = await boot()
    const changed = vi.fn()
    booted.ctx.on('domain/changed', changed)
    const before = booted.service.snapshot()

    await expect(booted.service.apply(state => ({ ...state, unknown: true }) as WorkspaceState)).rejects.toThrow()

    expect(booted.service.snapshot()).toEqual(before)
    expect(changed).not.toHaveBeenCalled()
    await booted.dispose()
  })

  test('validates the candidate produced at its serialized update slot', async () => {
    const booted = await boot()
    const changed = vi.fn()
    booted.ctx.on('domain/changed', changed)

    const accepted = booted.service.executeInternal({
      type: 'definition/create', name: 'Worker', description: 'd', instructions: 'i',
    })
    const rejected = booted.service.apply(state => {
      const definition = Object.values(state.definitions)[0]!
      return {
        ...state,
        definitions: {
          ...state.definitions,
          [definition.id]: { ...definition, unknown: true },
        },
      } as WorkspaceState
    })

    const acceptedState = await accepted
    await expect(rejected).rejects.toThrow()
    expect(booted.service.snapshot()).toEqual(acceptedState)
    expect(changed).toHaveBeenCalledTimes(1)
    await booted.dispose()
  })
})
