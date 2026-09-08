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
})
