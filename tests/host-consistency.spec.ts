import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import Storage from '@deepseek-ai/dsh-storage'
import { apply as domainApply, Config as DomainConfig, inject as domainInject } from '@deepseek-ai/dsh-storage-domain'
import { apply as jsonApply, Config as JsonConfig, inject as jsonInject } from '@deepseek-ai/dsh-storage-json'
import AgentWorkspaceDomainService from '../packages/host/src/index.ts'
import { WorkspaceDispatcher } from '../packages/host/src/dispatcher.ts'
import type { SubagentRuntimeLike, WorkspaceDispatcherHost } from '../packages/host/src/dispatcher.ts'
import { AgentId, AgentMemoryEntryId, HumanId, RoomId, WorkspaceEventId, WorkspaceId } from '../packages/host/src/ids.ts'
import { EmployeeAgentPool } from '../packages/host/src/runtime.ts'
import type { EmployeeSessionSource } from '../packages/host/src/runtime.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import { assignHumanTask } from '../packages/host/src/tasks.ts'
import type { WorkspaceState } from '../packages/host/src/types.ts'

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
  transact<T>(mutation: (state: WorkspaceState) => { state: WorkspaceState; result: T }): Promise<T>
}

function fakeHost(initial: WorkspaceState, replies = new Map<AgentId, string>()): FakeHost {
  const host: FakeHost = {
    state: structuredClone(initial),
    delivered: [],
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
    deliver: async agentId => {
      host.delivered.push(agentId)
      return { output: [{ type: 'text', text: replies.get(agentId) ?? '' }], stopReason: 'completed' }
    },
    ensureEmployee: async () => handle(),
  }
  return host
}

describe('dispatcher consistency', () => {
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
  test('dispose invalidates an in-flight ensure so a departed employee cannot be resurrected', async () => {
    let publish!: (value: AgentHandle) => void
    const created = new Promise<AgentHandle>(resolve => { publish = resolve })
    const disposeHandle = vi.fn(async () => {})
    const source: EmployeeSessionSource = {
      sessionIdFor: () => undefined,
      recordSessionId: vi.fn(async () => {}),
    }
    const pool = new EmployeeAgentPool({ create: vi.fn(async () => created), resume: vi.fn() }, source)
    const alice = AgentId('alice')

    const ensuring = pool.ensure(alice)
    const disposing = pool.dispose(alice)
    publish(handle(disposeHandle))

    await expect(ensuring).rejects.toThrow(/invalidated|disposed/)
    await disposing
    expect(pool.handleFor(alice)).toBeUndefined()
    expect(disposeHandle).toHaveBeenCalledTimes(1)
  })
})

interface Booted {
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
    service: ctx.agentWorkspace,
    dispose: async () => {
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
    },
  }
}

describe('durable service boundary', () => {
  test('public room join synchronizes the requested historical room range', async () => {
    const booted = await boot()
    await booted.service.execute({ type: 'definition/create', name: 'Worker', description: 'd', instructions: 'i' })
    let snapshot = booted.service.snapshot()
    const definition = Object.values(snapshot.definitions)[0]!
    await booted.service.execute({ type: 'agent/create', definitionId: definition.id, name: 'Alice' })
    await booted.service.execute({ type: 'room/create', kind: 'group', name: 'room' })
    snapshot = booted.service.snapshot()
    const alice = Object.values(snapshot.agents)[0]!
    const room = Object.values(snapshot.rooms)[0]!
    await booted.service.execute({
      type: 'room/message',
      roomId: room.id,
      actor: { type: 'human', id: HumanId('owner') },
      text: 'historical message',
      mentions: [],
    })
    snapshot = booted.service.snapshot()
    const historical = snapshot.events.find(event => event.type === 'room/message')!

    await booted.service.execute({
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
})
