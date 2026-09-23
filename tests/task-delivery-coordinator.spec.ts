import { describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { AgentId, HumanId, TaskId, WorkspaceId } from '../packages/host/src/ids.ts'
import { TaskDeliveryCoordinator } from '../packages/host/src/task-delivery-coordinator.ts'
import type { TaskDeliveryCoordinatorHost, WorkspaceDeliveryHooks } from '../packages/host/src/task-delivery-coordinator.ts'
import { EmployeeAgentPool } from '../packages/host/src/runtime.ts'
import { mutateWorkspace, createInitialState } from '../packages/host/src/state.ts'
import { assignHumanTask, cancelTask } from '../packages/host/src/tasks.ts'
import type { WorkspaceState } from '../packages/host/src/types.ts'
import { WorkspaceTurnTracker } from '../packages/host/src/turn-tracker.ts'
import type { WorkspaceTurnOutcome } from '../packages/host/src/turn-tracker.ts'
import { acceptTaskDelivery, failTaskDelivery, startTaskDelivery } from '../packages/host/src/task-delivery.ts'
import { WorkspaceActivityStream } from '../packages/host/src/activity-stream.ts'

function assignedTask(): { state: WorkspaceState; taskId: TaskId; agentId: AgentId } {
  let state = createInitialState(WorkspaceId('local'))
  const definition = mutateWorkspace(state, {
    type: 'definition/create', name: 'Worker', description: 'work', instructions: 'reply',
  })
  state = definition.state
  const agent = mutateWorkspace(state, {
    type: 'agent/create', definitionId: definition.definitionId, name: 'alice',
  })
  state = agent.state
  const task = assignHumanTask(state, { humanId: HumanId('owner'), assigneeAgentId: agent.agentId, title: 'ship it' })
  return { state: task.state, taskId: task.taskId, agentId: agent.agentId }
}

function handle(): AgentHandle {
  return { agent: { id: 'session' } as never, dispose: async () => {} }
}

function recoveredHandle(nextTurn: readonly UserMessage[], events: readonly SessionEvent[]): AgentHandle {
  return {
    agent: {
      id: SessionId('session'),
      inbox: { nextTurn, nextStep: [] },
      session: { snapshotEvents: () => events },
    } as unknown as Agent,
    dispose: async () => {},
  }
}

function persistedTurn(
  message: UserMessage,
  options: { readonly reason?: TurnEndReason; readonly output?: string; readonly interrupted?: true } = {},
): SessionEvent[] {
  const events = [
    { type: 'agent/inbox/spliced', seq: 0, time: 1, data: { target: 'next-turn', start: 0, inserted: [message] } },
    { type: 'turn/start', seq: 1, time: 2, data: { turn: 7 } },
    { type: 'agent/inbox/spliced', seq: 2, time: 3, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
    { type: 'user/message', seq: 3, time: 4, data: message, surfaceOp: 'append' },
  ] as unknown as SessionEvent[]
  if (options.output !== undefined) {
    events.push({
      type: 'assistant/message',
      seq: events.length,
      time: 5,
      data: {
        turn: 7,
        step: 1,
        message: { id: 'assistant-1', role: 'assistant', content: [{ type: 'text', text: options.output }] },
        ...(options.interrupted === undefined ? {} : { interrupted: true }),
      },
      surfaceOp: 'append',
    } as never)
  }
  if (options.reason !== undefined) {
    events.push({ type: 'turn/end', seq: events.length, time: 6, data: { turn: 7, reason: options.reason } } as never)
  }
  return events
}

function startedTask(): ReturnType<typeof assignedTask> & { readonly message: UserMessage } {
  const built = assignedTask()
  const started = startTaskDelivery(built.state, { taskId: built.taskId })
  return { ...built, state: started.state, message: started.message }
}

function acceptedTask(): ReturnType<typeof startedTask> {
  const built = startedTask()
  const event = built.state.events.find(candidate => candidate.type === 'task/delivery-started')!
  return {
    ...built,
    state: acceptTaskDelivery(built.state, {
      taskId: built.taskId,
      attemptId: event.taskDeliveryAttemptId,
      messageId: event.messageId,
    }).state,
  }
}

function outcome(text: string): WorkspaceTurnOutcome {
  return { output: [{ type: 'text', text }], stopReason: { kind: 'completed' }, interrupted: false }
}

function deferred<T = void>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  const pending = Promise.withResolvers<T>()
  return { promise: pending.promise, resolve: pending.resolve }
}

function trackerEvents(): {
  readonly context: Context
  readonly emit: (event: string, ...args: unknown[]) => void
} {
  const listeners = new Map<string, Array<(...args: never[]) => unknown>>()
  return {
    context: {
      on: (event: string, listener: (...args: never[]) => unknown) => {
        const current = listeners.get(event) ?? []
        current.push(listener)
        listeners.set(event, current)
        return () => {}
      },
    } as unknown as Context,
    emit: (event, ...args) => {
      for (const listener of listeners.get(event) ?? []) listener(...(args as never[]))
    },
  }
}

describe('TaskDeliveryCoordinator', () => {
  test('durably starts, accepts, and terminalizes one assignment', async () => {
    const built = assignedTask()
    let state = built.state
    const host: TaskDeliveryCoordinatorHost = {
      snapshot: () => structuredClone(state),
      apply: async mutation => { state = mutation(state); return structuredClone(state) },
      ensureEmployee: vi.fn(async () => handle()),
      deliver: vi.fn(async (_agentId, _message, _recall, _source, hooks) => {
        await hooks?.onClaim?.()
        return outcome('done')
      }),
    }
    const coordinator = new TaskDeliveryCoordinator(host)

    await expect(coordinator.deliver(built.taskId)).resolves.toBe('done')
    expect(state.events.filter(event => event.type === 'task/delivery-started')).toHaveLength(1)
    expect(state.events.filter(event => event.type === 'task/delivery-accepted')).toHaveLength(1)
    expect(state.events.filter(event => event.type === 'task/result')).toHaveLength(1)
    expect(state.tasks[built.taskId]?.status).toBe('completed')
  })

  test('keeps an active task result on its claimed revision and uses the refreshed revision for later work', async () => {
    const built = assignedTask()
    let state = built.state
    const oldRevisionId = state.agents[built.agentId]!.definitionRevisionId
    const firstResult = deferred<WorkspaceTurnOutcome>()
    let deliveryNumber = 0
    const host: TaskDeliveryCoordinatorHost = {
      snapshot: () => structuredClone(state),
      apply: async mutation => { state = mutation(state); return structuredClone(state) },
      ensureEmployee: async () => handle(),
      deliver: async (_agentId, _message, _recall, _source, hooks) => {
        deliveryNumber++
        const captured = state.agents[built.agentId]!.definitionRevisionId
        await hooks?.onClaim?.(captured)
        if (deliveryNumber === 1) return await firstResult.promise
        return { ...outcome('new-role result'), definitionRevisionId: captured }
      },
    }
    const coordinator = new TaskDeliveryCoordinator(host)
    const active = coordinator.deliver(built.taskId)
    await vi.waitFor(() => expect(state.events.some(event => event.type === 'task/delivery-accepted')).toBe(true))
    const definitionId = state.agents[built.agentId]!.definitionId
    const revised = mutateWorkspace(state, {
      type: 'definition/revise', definitionId, description: 'new', instructions: 'new',
      synchronizeAgentIds: [built.agentId],
    })
    state = revised.state
    firstResult.resolve({ ...outcome('old-role result'), definitionRevisionId: oldRevisionId })
    await active

    const laterTask = assignHumanTask(state, {
      humanId: HumanId('owner'), assigneeAgentId: built.agentId, title: 'later work',
    })
    state = laterTask.state
    await coordinator.deliver(laterTask.taskId)
    const results = state.events.filter(event => event.type === 'task/result')
    expect(results.map(event => ({ text: event.text, revisionId: event.definitionRevisionId }))).toEqual([
      { text: 'old-role result', revisionId: oldRevisionId },
      { text: 'new-role result', revisionId: revised.definitionRevisionId },
    ])
    const accepted = state.events.filter(event => event.type === 'task/delivery-accepted')
    expect(accepted.map(event => event.definitionRevisionId)).toEqual([
      oldRevisionId,
      revised.definitionRevisionId,
    ])
  })

  test('a wake failure leaves an open task retryable without creating another task', async () => {
    const built = assignedTask()
    let state = built.state
    let failWake = true
    const host: TaskDeliveryCoordinatorHost = {
      snapshot: () => structuredClone(state),
      apply: async mutation => { state = mutation(state); return structuredClone(state) },
      ensureEmployee: vi.fn(async () => handle()),
      deliver: vi.fn(async (_agentId, _message, _recall, _source, hooks) => {
        if (failWake) throw new Error('wake failed')
        await hooks?.onClaim?.()
        return outcome('retried')
      }),
    }
    const coordinator = new TaskDeliveryCoordinator(host)

    await expect(coordinator.deliver(built.taskId)).rejects.toThrow('wake failed')
    expect(state.tasks[built.taskId]?.status).toBe('open')
    expect(state.events.filter(event => event.type === 'task/delivery-failed')).toEqual([
      expect.objectContaining({ failureCode: 'delivery-rejected' }),
    ])
    failWake = false
    await expect(coordinator.retryTaskDelivery(built.taskId)).resolves.toBe('retried')
    expect(Object.keys(state.tasks)).toEqual([built.taskId])
    expect(state.events.filter(event => event.type === 'task/result')).toHaveLength(1)
  })

  test('a rejection after claim records an interrupted attempt instead of an inbox rejection', async () => {
    const built = assignedTask()
    let state = built.state
    const host: TaskDeliveryCoordinatorHost = {
      snapshot: () => structuredClone(state),
      apply: async mutation => { state = mutation(state); return structuredClone(state) },
      ensureEmployee: async () => handle(),
      deliver: async (_agentId, _message, _recall, _source, hooks) => {
        await hooks?.onClaim?.()
        throw new Error('agent disposed')
      },
    }
    const coordinator = new TaskDeliveryCoordinator(host)

    await expect(coordinator.deliver(built.taskId)).rejects.toThrow('agent disposed')
    expect(state.events.filter(event => event.type === 'task/delivery-failed')).toEqual([
      expect.objectContaining({
        failureCode: 'interrupted',
        failureSummary: 'Delivery was interrupted before a terminal result.',
      }),
    ])
  })

  test('an acceptance write failure after claim is interrupted rather than delivery-rejected', async () => {
    const built = assignedTask()
    let state = built.state
    let rejectAcceptance = true
    const host: TaskDeliveryCoordinatorHost = {
      snapshot: () => structuredClone(state),
      apply: async mutation => {
        const changed = mutation(state)
        if (rejectAcceptance && changed.events.at(-1)?.type === 'task/delivery-accepted') {
          rejectAcceptance = false
          throw new Error('acceptance storage failed')
        }
        state = changed
        return structuredClone(state)
      },
      ensureEmployee: async () => handle(),
      deliver: async (_agentId, _message, _recall, _source, hooks) => {
        await hooks?.onClaim?.()
        return outcome('unreachable')
      },
    }
    const coordinator = new TaskDeliveryCoordinator(host)

    await expect(coordinator.deliver(built.taskId)).rejects.toThrow('acceptance storage failed')
    expect(state.events.filter(event => event.type === 'task/delivery-failed')).toEqual([
      expect.objectContaining({ failureCode: 'interrupted' }),
    ])
  })

  test('simultaneous retries share one delivery attempt', async () => {
    const built = assignedTask()
    let state = built.state
    let rejectFirst = true
    let retryDeliveries = 0
    const retryEntered = deferred()
    const releaseRetry = deferred()
    const host: TaskDeliveryCoordinatorHost = {
      snapshot: () => structuredClone(state),
      apply: async mutation => { state = mutation(state); return structuredClone(state) },
      ensureEmployee: async () => handle(),
      deliver: async (_agentId, _message, _recall, _source, hooks) => {
        if (rejectFirst) {
          rejectFirst = false
          throw new Error('wake failed')
        }
        retryDeliveries++
        retryEntered.resolve()
        await hooks?.onClaim?.()
        await releaseRetry.promise
        return outcome('retried once')
      },
    }
    const coordinator = new TaskDeliveryCoordinator(host)
    await expect(coordinator.deliver(built.taskId)).rejects.toThrow('wake failed')

    const first = coordinator.retryTaskDelivery(built.taskId)
    await retryEntered.promise
    const second = coordinator.retryTaskDelivery(built.taskId)
    expect(retryDeliveries).toBe(1)
    releaseRetry.resolve()

    await expect(Promise.all([first, second])).resolves.toEqual(['retried once', 'retried once'])
    expect(state.events.filter(event => event.type === 'task/delivery-started')).toHaveLength(2)
    expect(state.events.filter(event => event.type === 'task/result')).toHaveLength(1)
  })

  test('a rolled-back Browser reservation releases joiners and preserves retryable state', async () => {
    const built = assignedTask()
    let state = built.state
    const host: TaskDeliveryCoordinatorHost = {
      snapshot: () => structuredClone(state),
      apply: async mutation => { state = mutation(state); return structuredClone(state) },
      ensureEmployee: async () => handle(),
      deliver: async (_agentId, _message, _recall, _source, hooks) => {
        await hooks?.onClaim?.()
        return outcome('retry after rollback')
      },
    }
    const coordinator = new TaskDeliveryCoordinator(host)
    const reservation = coordinator.reserveTaskDelivery(built.taskId)
    reservation.prepare(state)
    const joined = coordinator.retryTaskDelivery(built.taskId)
    const joinedOutcome = joined.then(
      value => ({ status: 'fulfilled' as const, value }),
      error => ({ status: 'rejected' as const, error }),
    )

    reservation.rollback()

    await expect(joinedOutcome).resolves.toMatchObject({ status: 'rejected', error: expect.any(Error) })
    expect(state).toEqual(built.state)
    await expect(coordinator.retryTaskDelivery(built.taskId)).resolves.toBe('retry after rollback')
    expect(state.events.filter(event => event.type === 'task/delivery-started')).toHaveLength(1)
  })

  test('teardown during an owned retry resume releases the flight and preserves retryable state', async () => {
    const built = startedTask()
    const first = built.state.events.find(event => event.type === 'task/delivery-started')!
    let state = failTaskDelivery(built.state, {
      taskId: built.taskId,
      attemptId: first.taskDeliveryAttemptId,
      messageId: first.messageId,
      failureCode: 'test',
      failureSummary: 'retryable',
    }).state
    const recoveryFinished = deferred()
    const releaseResume = deferred()
    const dispose = vi.fn(async () => {})
    const resumed = recoveredHandle([], [])
    let coordinator: TaskDeliveryCoordinator
    const pool = new EmployeeAgentPool(
      {
        create: vi.fn(async () => { throw new Error('must resume the bound employee') }),
        resume: vi.fn(async options => {
          await options.setup?.({} as Context, resumed.agent)
          return { ...resumed, dispose }
        }),
      },
      {
        sessionIdFor: () => SessionId('session'),
        recordSessionId: async () => {},
      },
      undefined,
      async (agentId, agent) => {
        await coordinator.recoverAgent(agentId, { agent })
        recoveryFinished.resolve()
        await releaseResume.promise
      },
    )
    coordinator = new TaskDeliveryCoordinator({
      snapshot: () => structuredClone(state),
      apply: async mutation => { state = mutation(state); return structuredClone(state) },
      ensureEmployee: async agentId => await pool.ensure(agentId),
      deliver: async () => { throw new Error('teardown must prevent delivery') },
    })
    const reservation = coordinator.reserveTaskDelivery(built.taskId)
    const prepared = reservation.prepare(state)
    state = prepared.state
    reservation.commit(prepared)

    await recoveryFinished.promise
    const teardown = pool.disposeAll()
    releaseResume.resolve()

    await teardown
    await expect(reservation.result()).rejects.toThrow(/invalidated by disposal/)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(state.tasks[built.taskId]?.status).toBe('open')
    expect(state.events.filter(event => event.type === 'task/delivery-failed')).toHaveLength(2)
    const released = coordinator.reserveTaskDelivery(built.taskId)
    released.rollback()
    await expect(released.result()).rejects.toThrow(/rolled back/)
  })

  test.each(['deliver', 'retryTaskDelivery'] as const)(
    'the first %s call that resumes a pending attempt shares its recovered completion',
    async method => {
      const built = startedTask()
      let state = built.state
      const recoveryFinished = deferred()
      const releaseEnsure = deferred()
      const tracked = deferred<WorkspaceTurnOutcome>()
      const resumed = recoveredHandle([built.message], [])
      let coordinator: TaskDeliveryCoordinator
      const host: TaskDeliveryCoordinatorHost = {
        snapshot: () => structuredClone(state),
        apply: async mutation => { state = mutation(state); return structuredClone(state) },
        ensureEmployee: async agentId => {
          await coordinator.recoverAgent(agentId, resumed)
          recoveryFinished.resolve()
          await releaseEnsure.promise
          return resumed
        },
        deliver: async () => { throw new Error('must not insert a second delivery') },
        recoverDelivery: async (_agentId, _handle, _delivery, _source, hooks) => {
          const result = await tracked.promise
          await hooks?.onClaim?.()
          return result
        },
      }
      coordinator = new TaskDeliveryCoordinator(host)

      const pending = coordinator[method](built.taskId)
      await recoveryFinished.promise
      releaseEnsure.resolve()
      tracked.resolve(outcome('recovered result'))

      await expect(pending).resolves.toBe('recovered result')
      expect(state.events.filter(event => event.type === 'task/delivery-started')).toHaveLength(1)
      expect(state.events.filter(event => event.type === 'task/result')).toHaveLength(1)
    },
  )

  test.each([
    ['aborted', { kind: 'aborted', reason: { kind: 'user' } }],
    ['failed', { kind: 'error', error: { code: 'UNKNOWN', message: 'boom' } }],
  ] as const)('a %s turn records interrupted failure without its partial output', async (_label, stopReason) => {
    const built = assignedTask()
    let state = built.state
    const host: TaskDeliveryCoordinatorHost = {
      snapshot: () => structuredClone(state),
      apply: async mutation => { state = mutation(state); return structuredClone(state) },
      ensureEmployee: async () => handle(),
      deliver: async (_agentId, _message, _recall, _source, hooks) => {
        await hooks?.onClaim?.()
        return {
          output: [{ type: 'text', text: 'unsafe partial output' }],
          stopReason: stopReason as never,
          interrupted: true,
        }
      },
    }
    const coordinator = new TaskDeliveryCoordinator(host)

    await expect(coordinator.deliver(built.taskId)).rejects.toThrow(/interrupted/)
    expect(state.events.filter(event => event.type === 'task/result' || event.type === 'task/result-after-cancel')).toHaveLength(0)
    expect(state.events.filter(event => event.type === 'task/delivery-failed')).toEqual([
      expect.objectContaining({
        failureCode: 'interrupted',
        failureSummary: 'Delivery was interrupted before a terminal result.',
      }),
    ])
  })

  test('converges an interrupted flight after its first terminal failure write rejects', async () => {
    const built = assignedTask()
    let state = built.state
    let rejectedTerminalWrite = false
    const host: TaskDeliveryCoordinatorHost = {
      snapshot: () => structuredClone(state),
      apply: async mutation => {
        const next = mutation(state)
        const appendedFailure = next.events.some(event => event.type === 'task/delivery-failed')
          && !state.events.some(event => event.type === 'task/delivery-failed')
        if (appendedFailure && !rejectedTerminalWrite) {
          rejectedTerminalWrite = true
          throw new Error('transient terminal write failure')
        }
        state = next
        return structuredClone(state)
      },
      ensureEmployee: async () => handle(),
      deliver: async (_agentId, _message, _recall, _source, hooks) => {
        await hooks?.onClaim?.()
        return {
          output: [{ type: 'text', text: 'unsafe partial output' }],
          stopReason: { kind: 'aborted', reason: { kind: 'user' } },
          interrupted: true,
        }
      },
    }
    const coordinator = new TaskDeliveryCoordinator(host)

    await expect(coordinator.deliver(built.taskId)).rejects.toThrow('transient terminal write failure')
    expect(rejectedTerminalWrite).toBe(true)
    expect(state.events.filter(event => event.type === 'task/delivery-failed')).toEqual([
      expect.objectContaining({ failureCode: 'interrupted' }),
    ])
  })

  test('a complete result that loses the cancellation race is recorded once without reopening the task', async () => {
    const built = assignedTask()
    let state = built.state
    const host: TaskDeliveryCoordinatorHost = {
      snapshot: () => structuredClone(state),
      apply: async mutation => { state = mutation(state); return structuredClone(state) },
      ensureEmployee: async () => handle(),
      deliver: async (_agentId, _message, _recall, _source, hooks) => {
        await hooks?.onClaim?.()
        state = cancelTask(state, { humanId: HumanId('owner'), taskId: built.taskId }).state
        return outcome('full raced result')
      },
    }
    const coordinator = new TaskDeliveryCoordinator(host)

    await expect(coordinator.deliver(built.taskId)).resolves.toBe('full raced result')
    expect(state.tasks[built.taskId]?.status).toBe('cancelled')
    expect(state.events.filter(event => event.type === 'task/result')).toHaveLength(0)
    expect(state.events.filter(event => event.type === 'task/result-after-cancel')).toEqual([
      expect.objectContaining({ text: 'full raced result' }),
    ])
  })

  test('recovery marks a started attempt with no inbox insertion as interrupted', async () => {
    const built = startedTask()
    let state = built.state
    const host: TaskDeliveryCoordinatorHost = {
      snapshot: () => structuredClone(state),
      apply: async mutation => { state = mutation(state); return structuredClone(state) },
      ensureEmployee: async () => handle(),
      deliver: async () => outcome('unused'),
    }
    const coordinator = new TaskDeliveryCoordinator(host)

    await expect(coordinator.recoverAgent(built.agentId, recoveredHandle([], []))).resolves.toEqual([
      { taskId: built.taskId, status: 'interrupted' },
    ])
    expect(state.events.filter(event => event.type === 'task/delivery-failed')).toEqual([
      expect.objectContaining({
        failureCode: 'interrupted',
        failureSummary: 'Delivery was interrupted before a terminal result.',
      }),
    ])
  })

  test('recovery accepts an inserted message only when its pending tracker observes claim', async () => {
    const built = startedTask()
    let state = built.state
    const tracked = deferred<WorkspaceTurnOutcome>()
    const recovered = deferred()
    let claimHooks: WorkspaceDeliveryHooks | undefined
    const host: TaskDeliveryCoordinatorHost = {
      snapshot: () => structuredClone(state),
      apply: async mutation => { state = mutation(state); return structuredClone(state) },
      ensureEmployee: async () => handle(),
      deliver: async () => outcome('unused'),
      recoverDelivery: async (_agentId, _handle, delivery, source, hooks) => {
        expect(delivery).toEqual(built.message)
        expect(source).toEqual({
          kind: 'task',
          taskId: built.taskId,
          attemptId: expect.any(String),
        })
        claimHooks = hooks
        recovered.resolve()
        return await tracked.promise
      },
    }
    const coordinator = new TaskDeliveryCoordinator(host)

    await expect(coordinator.recoverAgent(built.agentId, recoveredHandle([built.message], []))).resolves.toEqual([
      { taskId: built.taskId, status: 'pending' },
    ])
    await recovered.promise
    expect(state.events.filter(event => event.type === 'task/delivery-accepted')).toHaveLength(0)
    if (claimHooks === undefined) throw new Error('recovered tracker did not receive claim hooks')
    await claimHooks.onClaim?.()
    await claimHooks.onClaim?.()
    expect(state.events.filter(event => event.type === 'task/delivery-accepted')).toHaveLength(1)
  })

  test('recovery reads the public Inbox state and real DSH Session event log', async () => {
    const built = startedTask()
    let state = built.state
    const session = Session.create(SessionId('persisted-session'))
    const inbox = { nextTurn: [built.message], nextStep: [] }
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [built.message] })
    const tracked = deferred<WorkspaceTurnOutcome>()
    const host: TaskDeliveryCoordinatorHost = {
      snapshot: () => structuredClone(state),
      apply: async mutation => { state = mutation(state); return structuredClone(state) },
      ensureEmployee: async () => handle(),
      deliver: async () => outcome('unused'),
      recoverDelivery: async () => await tracked.promise,
    }
    const coordinator = new TaskDeliveryCoordinator(host)
    const agent = { id: session.id, inbox, session } as unknown as Agent

    expect(inbox.nextTurn).toEqual([built.message])
    expect(session.snapshotEvents()).toEqual([
      expect.objectContaining({
        type: 'agent/inbox/spliced',
        data: expect.objectContaining({ target: 'next-turn', inserted: [built.message] }),
      }),
    ])
    await expect(coordinator.recoverAgent(built.agentId, { agent })).resolves.toEqual([
      { taskId: built.taskId, status: 'pending' },
    ])
  })

  test('recovery restores an already accepted pending message without duplicating acceptance', async () => {
    const built = acceptedTask()
    let state = built.state
    const tracked = deferred<WorkspaceTurnOutcome>()
    let claimHooks: WorkspaceDeliveryHooks | undefined
    const host: TaskDeliveryCoordinatorHost = {
      snapshot: () => structuredClone(state),
      apply: async mutation => { state = mutation(state); return structuredClone(state) },
      ensureEmployee: async () => handle(),
      deliver: async () => outcome('unused'),
      recoverDelivery: async (_agentId, _handle, _delivery, _source, hooks) => {
        claimHooks = hooks
        return await tracked.promise
      },
    }
    const coordinator = new TaskDeliveryCoordinator(host)

    await expect(coordinator.recoverAgent(built.agentId, recoveredHandle([built.message], []))).resolves.toEqual([
      { taskId: built.taskId, status: 'pending' },
    ])
    if (claimHooks === undefined) throw new Error('recovered tracker did not receive claim hooks')
    await claimHooks.onClaim?.()
    await claimHooks.onClaim?.()
    expect(state.events.filter(event => event.type === 'task/delivery-accepted')).toHaveLength(1)
  })

  test('pending accepted recovery retains its durable claim revision after synchronization', async () => {
    const started = startedTask()
    const agent = started.state.agents[started.agentId]!
    const deliveryStarted = started.state.events.find(event => event.type === 'task/delivery-started')!
    const accepted = acceptTaskDelivery(started.state, {
      taskId: started.taskId,
      attemptId: deliveryStarted.taskDeliveryAttemptId,
      messageId: deliveryStarted.messageId,
      definitionRevisionId: agent.definitionRevisionId,
    })
    const revised = mutateWorkspace(accepted.state, {
      type: 'definition/revise', definitionId: agent.definitionId,
      description: 'new', instructions: 'new', synchronizeAgentIds: [started.agentId],
    })
    let state = revised.state
    const tracked = deferred<WorkspaceTurnOutcome>()
    const host: TaskDeliveryCoordinatorHost = {
      snapshot: () => structuredClone(state),
      apply: async mutation => { state = mutation(state); return structuredClone(state) },
      ensureEmployee: async () => handle(),
      deliver: async () => outcome('unused'),
      recoverDelivery: async () => await tracked.promise,
    }
    const coordinator = new TaskDeliveryCoordinator(host)

    await expect(coordinator.recoverAgent(started.agentId, recoveredHandle([started.message], []))).resolves.toEqual([
      { taskId: started.taskId, status: 'pending' },
    ])
    const completion = coordinator.deliver(started.taskId)
    tracked.resolve({ ...outcome('recovered result'), definitionRevisionId: revised.definitionRevisionId })
    await expect(completion).resolves.toBe('recovered result')

    const acceptedEvent = state.events.find(event => event.type === 'task/delivery-accepted')
    const resultEvent = state.events.find(event => event.type === 'task/result')
    expect(acceptedEvent?.definitionRevisionId).toBe(agent.definitionRevisionId)
    expect(resultEvent?.definitionRevisionId).toBe(agent.definitionRevisionId)
  })

  test('recovery terminalizes one completed correlated turn exactly once', async () => {
    const built = acceptedTask()
    let state = built.state
    const host: TaskDeliveryCoordinatorHost = {
      snapshot: () => structuredClone(state),
      apply: async mutation => { state = mutation(state); return structuredClone(state) },
      ensureEmployee: async () => handle(),
      deliver: async () => outcome('unused'),
    }
    const coordinator = new TaskDeliveryCoordinator(host)
    const resumed = recoveredHandle([], persistedTurn(built.message, {
      output: 'durable answer',
      reason: { kind: 'completed' },
    }))

    await expect(coordinator.recoverAgent(built.agentId, resumed)).resolves.toEqual([
      { taskId: built.taskId, status: 'completed' },
    ])
    await expect(coordinator.recoverAgent(built.agentId, resumed)).resolves.toEqual([])
    expect(state.events.filter(event => event.type === 'task/result')).toHaveLength(1)
    expect(state.tasks[built.taskId]?.status).toBe('completed')
  })

  test('legacy recovery derives the accepted turn revision instead of using a later synchronized revision', async () => {
    const built = acceptedTask()
    const agent = built.state.agents[built.agentId]!
    const oldRevisionId = agent.definitionRevisionId
    const revised = mutateWorkspace(built.state, {
      type: 'definition/revise', definitionId: agent.definitionId,
      description: 'new', instructions: 'new', synchronizeAgentIds: [built.agentId],
    })
    let state = revised.state
    const host: TaskDeliveryCoordinatorHost = {
      snapshot: () => structuredClone(state),
      apply: async mutation => { state = mutation(state); return structuredClone(state) },
      ensureEmployee: async () => handle(),
      deliver: async () => outcome('unused'),
    }
    const coordinator = new TaskDeliveryCoordinator(host)
    const resumed = recoveredHandle([], persistedTurn(built.message, {
      output: 'legacy answer', reason: { kind: 'completed' },
    }))

    await expect(coordinator.recoverAgent(built.agentId, resumed)).resolves.toEqual([
      { taskId: built.taskId, status: 'completed' },
    ])
    const result = state.events.find(event => event.type === 'task/result')
    expect(result?.definitionRevisionId).toBe(oldRevisionId)
    expect(result?.definitionRevisionId).not.toBe(revised.definitionRevisionId)
  })

  test('legacy recovery refuses to invent an unprovable claim revision', async () => {
    const built = acceptedTask()
    let state = {
      ...built.state,
      events: built.state.events.filter(event => event.type !== 'definition/created'),
    }
    const host: TaskDeliveryCoordinatorHost = {
      snapshot: () => structuredClone(state),
      apply: async mutation => { state = mutation(state); return structuredClone(state) },
      ensureEmployee: async () => handle(),
      deliver: async () => outcome('unused'),
    }
    const coordinator = new TaskDeliveryCoordinator(host)
    const resumed = recoveredHandle([], persistedTurn(built.message, {
      output: 'ambiguous answer', reason: { kind: 'completed' },
    }))

    await expect(coordinator.recoverAgent(built.agentId, resumed)).resolves.toEqual([
      { taskId: built.taskId, status: 'interrupted' },
    ])
    expect(state.events.some(event => event.type === 'task/result')).toBe(false)
    expect(state.events.findLast(event => event.type === 'task/delivery-failed')).toEqual(expect.objectContaining({
      failureCode: 'interrupted', failureSummary: 'Delivery claim revision could not be recovered.',
    }))
  })

  test('a matching user message without the durable inbox removal is not treated as a claimed task', async () => {
    const built = acceptedTask()
    let state = built.state
    const host: TaskDeliveryCoordinatorHost = {
      snapshot: () => structuredClone(state),
      apply: async mutation => { state = mutation(state); return structuredClone(state) },
      ensureEmployee: async () => handle(),
      deliver: async () => outcome('unused'),
    }
    const coordinator = new TaskDeliveryCoordinator(host)
    const events = persistedTurn(built.message, {
      output: 'uncorrelated answer',
      reason: { kind: 'completed' },
    }).filter(event => !(event.type === 'agent/inbox/spliced' && event.data.removedCount === 1))

    await expect(coordinator.recoverAgent(built.agentId, recoveredHandle([], events))).resolves.toEqual([
      { taskId: built.taskId, status: 'interrupted' },
    ])
    expect(state.events.filter(event => event.type === 'task/result')).toHaveLength(0)
  })

  test.each([
    ['aborted', persistedTurn, { output: 'partial', interrupted: true as const, reason: { kind: 'aborted', reason: { kind: 'user' } } as TurnEndReason }],
    ['failed', persistedTurn, { reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'boom' } } as TurnEndReason }],
    ['claimed without terminal', persistedTurn, {}],
  ] as const)('recovery classifies a %s correlated turn as interrupted', async (_label, buildEvents, options) => {
    const built = acceptedTask()
    let state = built.state
    const host: TaskDeliveryCoordinatorHost = {
      snapshot: () => structuredClone(state),
      apply: async mutation => { state = mutation(state); return structuredClone(state) },
      ensureEmployee: async () => handle(),
      deliver: async () => outcome('unused'),
    }
    const coordinator = new TaskDeliveryCoordinator(host)

    await expect(coordinator.recoverAgent(
      built.agentId,
      recoveredHandle([], buildEvents(built.message, options)),
    )).resolves.toEqual([{ taskId: built.taskId, status: 'interrupted' }])
    expect(state.events.filter(event => event.type === 'task/result')).toHaveLength(0)
    expect(state.events.filter(event => event.type === 'task/delivery-failed')).toEqual([
      expect.objectContaining({ failureCode: 'interrupted' }),
    ])
  })

  test('the tracker waits for durable claim acceptance before publishing a terminal outcome', async () => {
    const built = startedTask()
    const events = trackerEvents()
    const claimCommitted = deferred()
    const releaseClaim = deferred()
    const tracker = new WorkspaceTurnTracker()
    tracker.install(events.context)
    let delivery: UserMessage | undefined
    const agent = { followup: (message: UserMessage) => { delivery = message } } as unknown as Agent

    const pending = tracker.deliver(agent, built.message, undefined, undefined, {
      onClaim: async () => {
        claimCommitted.resolve()
        await releaseClaim.promise
      },
    })
    expect(delivery).toEqual(built.message)
    events.emit('agent/inbox/claimed', { message: built.message, turn: 4 })
    events.emit('session/event', {}, {
      type: 'assistant/message',
      data: { turn: 4, step: 1, message: { content: [{ type: 'text', text: 'done' }] } },
    })
    events.emit('session/event', {}, { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } })
    await claimCommitted.promise
    let settled = false
    void pending.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    releaseClaim.resolve()
    await expect(pending).resolves.toMatchObject({ output: [{ type: 'text', text: 'done' }] })
  })

  test('the tracker reconstructs a pending activity without appending the recovered message again', async () => {
    const built = acceptedTask()
    const events = trackerEvents()
    const stream = new WorkspaceActivityStream()
    const tracker = new WorkspaceTurnTracker({
      agentId: built.agentId,
      sessionId: SessionId('session'),
      stream,
    })
    tracker.install(events.context)
    const followup = vi.fn()
    const agent = { followup } as unknown as Agent

    const pending = tracker.recover(
      agent,
      built.message,
      { kind: 'task', taskId: built.taskId, attemptId: built.state.events.find(event => event.type === 'task/delivery-accepted')!.taskDeliveryAttemptId },
    )
    expect(followup).not.toHaveBeenCalled()
    expect(stream.snapshot().activities).toEqual([
      expect.objectContaining({ status: 'queued', messageId: built.message.id }),
    ])

    events.emit('agent/inbox/claimed', { message: built.message, turn: 5 })
    events.emit('session/event', {}, {
      type: 'assistant/message',
      data: { turn: 5, step: 1, message: { content: [{ type: 'text', text: 'recovered' }] } },
    })
    events.emit('session/event', {}, { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })
    await expect(pending).resolves.toMatchObject({ output: [{ type: 'text', text: 'recovered' }] })
  })
})
