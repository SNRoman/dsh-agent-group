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
import { AgentId, AgentMemoryEntryId, HumanId, RoomId, WorkspaceActivityId, WorkspaceEventId, WorkspaceId } from '../packages/host/src/ids.ts'
import { EmployeeAgentPool } from '../packages/host/src/runtime.ts'
import type { EmployeeSessionSource } from '../packages/host/src/runtime.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import { assignHumanTask } from '../packages/host/src/tasks.ts'
import type { WorkspaceState } from '../packages/host/src/types.ts'
import { TaskDeliveryCoordinator } from '../packages/host/src/task-delivery-coordinator.ts'

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
