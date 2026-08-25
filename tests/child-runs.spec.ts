import { describe, expect, test } from 'vitest'
import { AgentId, HumanId, WorkspaceId } from '../packages/host/src/ids.ts'
import { finishChildRun } from '../packages/host/src/child-runs.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import { assignHumanTask, recordChildRunStarted } from '../packages/host/src/tasks.ts'

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
})
