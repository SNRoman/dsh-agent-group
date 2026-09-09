import { describe, expect, test, vi } from 'vitest'
import { AgentId, HumanId, WorkspaceId } from '../packages/host/src/ids.ts'
import { ChildControllerRegistry } from '../packages/host/src/child-controller.ts'
import type { FinishChildRunRequest } from '../packages/host/src/child-runs.ts'
import { finishChildRun, repairOrphanedChildRuns } from '../packages/host/src/child-runs.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import { assignHumanTask, recordChildRunStarted } from '../packages/host/src/tasks.ts'

function childFixture(workspaceId: string) {
  let state = createInitialState(WorkspaceId(workspaceId))
  const definition = mutateWorkspace(state, {
    type: 'definition/create', name: 'Worker', description: 'd', instructions: 'i',
  })
  state = definition.state
  const created = mutateWorkspace(state, {
    type: 'agent/create', definitionId: definition.definitionId, name: 'Alice',
  })
  const assigned = assignHumanTask(created.state, {
    humanId: HumanId('owner'), assigneeAgentId: created.agentId, title: 'work',
  })
  const started = recordChildRunStarted(assigned.state, {
    parentAgentId: created.agentId, taskId: assigned.taskId,
  })
  return { ...started, agentId: created.agentId, taskId: assigned.taskId }
}

describe('child run terminalization', () => {
  test('a started child can finish after its parent departs', () => {
    let state = createInitialState(WorkspaceId('local'))
    const definition = mutateWorkspace(state, {
      type: 'definition/create',
      name: 'Worker',
      description: 'd',
      instructions: 'i',
    })
    state = definition.state
    const created = mutateWorkspace(state, {
      type: 'agent/create',
      definitionId: definition.definitionId,
      name: 'Alice',
    })
    state = created.state
    const assigned = assignHumanTask(state, {
      humanId: HumanId('owner'),
      assigneeAgentId: created.agentId,
      title: 'work',
    })
    const started = recordChildRunStarted(assigned.state, {
      parentAgentId: created.agentId,
      taskId: assigned.taskId,
    })
    const departed = mutateWorkspace(started.state, {
      type: 'agent/depart',
      agentId: AgentId(created.agentId),
    })

    const finished = finishChildRun(departed.state, {
      childRunId: started.childRunId,
      status: 'completed',
      result: 'child result',
    })

    expect(finished.state.childRuns[started.childRunId]).toMatchObject({
      status: 'completed',
      result: 'child result',
    })
    expect(finished.state.memoryEntries.some(entry => (
      entry.agentId === created.agentId
      && entry.acquiredBy === 'child-result'
    ))).toBe(true)
  })

  test('one stop owner aborts and terminalizes a registered child exactly once', async () => {
    const committed = Promise.withResolvers<void>()
    const terminalRequests: FinishChildRunRequest[] = []
    const abort = vi.fn()
    const registry = new ChildControllerRegistry(async request => {
      terminalRequests.push(request)
      await committed.promise
    })
    const fixture = childFixture('controlled')
    const childRunId = fixture.childRunId
    registry.register({
      childRunId,
      parentAgentId: fixture.agentId,
      taskId: fixture.taskId,
      abort,
    })

    const first = registry.stopChildRun(childRunId)
    expect(abort).toHaveBeenCalledOnce()
    await expect(registry.stopChildRun(childRunId)).resolves.toEqual({ status: 'already-stopping' })
    expect(terminalRequests).toEqual([{
      childRunId,
      status: 'cancelled',
      result: 'Child run cancelled.',
    }])
    committed.resolve()
    await expect(first).resolves.toEqual({ status: 'stopping' })
    await expect(registry.stopChildRun(childRunId)).resolves.toEqual({ status: 'not-active' })
    expect(abort).toHaveBeenCalledOnce()
  })

  test('startup repair cancels only orphaned running children with the stable reason', () => {
    let state = createInitialState(WorkspaceId('repair'))
    const definition = mutateWorkspace(state, {
      type: 'definition/create', name: 'Worker', description: 'd', instructions: 'i',
    })
    state = definition.state
    const created = mutateWorkspace(state, {
      type: 'agent/create', definitionId: definition.definitionId, name: 'Alice',
    })
    const assigned = assignHumanTask(created.state, {
      humanId: HumanId('owner'), assigneeAgentId: created.agentId, title: 'work',
    })
    const completed = recordChildRunStarted(assigned.state, {
      parentAgentId: created.agentId, taskId: assigned.taskId,
    })
    const running = recordChildRunStarted(completed.state, {
      parentAgentId: created.agentId, taskId: assigned.taskId,
    })
    state = finishChildRun(running.state, {
      childRunId: completed.childRunId, status: 'completed', result: 'done',
    }).state

    const repaired = repairOrphanedChildRuns(state)

    expect(repaired.childRuns[completed.childRunId]).toMatchObject({ status: 'completed', result: 'done' })
    expect(repaired.childRuns[running.childRunId]).toMatchObject({
      status: 'cancelled',
      result: 'Host restarted before the child run settled.',
    })
    expect(repaired.events.filter(event => (
      event.type === 'child/run-finished' && event.subjectId === running.childRunId
    ))).toHaveLength(1)
  })

  test('retains one winning terminal request until its durable retry succeeds', async () => {
    const fixture = childFixture('retry-settlement')
    let durable = fixture.state
    let attempts = 0
    const retryEntered = Promise.withResolvers<void>()
    const releaseRetry = Promise.withResolvers<void>()
    const abort = vi.fn()
    const registry = new ChildControllerRegistry(async request => {
      attempts++
      if (attempts === 1) throw new Error('durable write failed')
      retryEntered.resolve()
      await releaseRetry.promise
      durable = finishChildRun(durable, request).state
    })
    const settlement = registry.register({
      childRunId: fixture.childRunId,
      parentAgentId: fixture.agentId,
      taskId: fixture.taskId,
      abort,
    })

    await expect(settlement.settle('completed', 'winning result')).rejects.toThrow('durable write failed')
    expect(durable.childRuns[fixture.childRunId]).toMatchObject({ status: 'running' })

    const retry = registry.stopChildRun(fixture.childRunId)
    const retryState = await Promise.race([
      retryEntered.promise.then(() => 'entered-durable-write' as const),
      retry.then(() => 'returned-before-write' as const),
    ])
    expect(retryState).toBe('entered-durable-write')
    await expect(settlement.settle('failed', 'replacement result')).resolves.toBe(false)
    expect(abort).not.toHaveBeenCalled()
    releaseRetry.resolve()

    await expect(retry).resolves.toEqual({ status: 'not-active' })
    expect(durable.childRuns[fixture.childRunId]).toMatchObject({ status: 'completed', result: 'winning result' })
    expect(durable.events.filter(event => (
      event.type === 'child/run-finished' && event.subjectId === fixture.childRunId
    ))).toHaveLength(1)
    await expect(settlement.settle('completed', 'winning result')).resolves.toBe(false)
    expect(attempts).toBe(2)
  })

  test('a stop racing a rejected durable settlement retries the retained winner', async () => {
    const fixture = childFixture('raced-settlement')
    let durable = fixture.state
    let attempts = 0
    const firstEntered = Promise.withResolvers<void>()
    const rejectFirst = Promise.withResolvers<void>()
    const retryEntered = Promise.withResolvers<void>()
    const releaseRetry = Promise.withResolvers<void>()
    const abort = vi.fn()
    const registry = new ChildControllerRegistry(async request => {
      attempts++
      if (attempts === 1) {
        firstEntered.resolve()
        await rejectFirst.promise
        throw new Error('first durable write failed')
      }
      retryEntered.resolve()
      await releaseRetry.promise
      durable = finishChildRun(durable, request).state
    })
    const settlement = registry.register({
      childRunId: fixture.childRunId,
      parentAgentId: fixture.agentId,
      taskId: fixture.taskId,
      abort,
    })

    const winningResult = settlement.settle('completed', 'winning result').then(
      () => ({ status: 'fulfilled' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    )
    await firstEntered.promise
    const racedStop = registry.stopChildRun(fixture.childRunId)
    rejectFirst.resolve()

    const convergence = await Promise.race([
      retryEntered.promise.then(() => 'retry-entered' as const),
      racedStop.then(() => 'stop-returned-before-retry' as const),
    ])
    expect(convergence).toBe('retry-entered')
    expect(durable.childRuns[fixture.childRunId]).toMatchObject({ status: 'running' })
    await expect(settlement.settle('failed', 'replacement result')).resolves.toBe(false)
    expect(abort).not.toHaveBeenCalled()
    releaseRetry.resolve()

    await expect(racedStop).resolves.toEqual({ status: 'not-active' })
    expect(await winningResult).toMatchObject({
      status: 'rejected',
      error: new Error('first durable write failed'),
    })
    expect(durable.childRuns[fixture.childRunId]).toMatchObject({ status: 'completed', result: 'winning result' })
    expect(durable.events.filter(event => (
      event.type === 'child/run-finished' && event.subjectId === fixture.childRunId
    ))).toHaveLength(1)
    await expect(registry.stopChildRun(fixture.childRunId)).resolves.toEqual({ status: 'not-active' })
    await expect(settlement.settle('completed', 'winning result')).resolves.toBe(false)
    expect(attempts).toBe(2)
  })
})
