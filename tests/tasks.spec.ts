import { describe, expect, test } from 'vitest'
import { HumanId, WorkspaceId } from '../packages/host/src/ids.ts'
import {
  assignDelegatedTask,
  assignHumanTask,
  completeTask,
  grantTaskDelegation,
  recordChildRunFinished,
  recordChildRunStarted,
} from '../packages/host/src/tasks.ts'
import { workspaceStateSchema } from '../packages/host/src/spec.ts'
import { recallAgentEvents } from '../packages/host/src/memory.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'

const javaEngineer = {
  name: 'Java engineer',
  description: 'Build Java services',
  instructions: 'Act as a Java engineer.',
}

function createWorkspace() {
  const initial = createInitialState(WorkspaceId('local'))
  const definition = mutateWorkspace(initial, { type: 'definition/create', ...javaEngineer })
  const manager = mutateWorkspace(definition.state, {
    type: 'agent/create',
    definitionId: definition.definitionId,
    name: 'Manager',
  })
  const engineer = mutateWorkspace(manager.state, {
    type: 'agent/create',
    definitionId: definition.definitionId,
    name: 'Engineer',
  })
  return { state: engineer.state, managerId: manager.agentId, engineerId: engineer.agentId }
}

describe('formal task delegation', () => {
  test('requires an active human grant for the exact root task and expires it at root completion', () => {
    const workspace = createWorkspace()
    const root = assignHumanTask(workspace.state, {
      humanId: HumanId('owner'),
      assigneeAgentId: workspace.managerId,
      title: 'Deliver the release',
    })

    expect(() => assignDelegatedTask(root.state, {
      actorAgentId: workspace.managerId,
      assigneeAgentId: workspace.engineerId,
      rootTaskId: root.taskId,
      title: 'Implement API',
    })).toThrow(/human delegation grant/)

    const granted = grantTaskDelegation(root.state, {
      humanId: HumanId('owner'),
      granteeAgentId: workspace.managerId,
      rootTaskId: root.taskId,
    })
    const delegated = assignDelegatedTask(granted.state, {
      actorAgentId: workspace.managerId,
      assigneeAgentId: workspace.engineerId,
      rootTaskId: root.taskId,
      title: 'Implement API',
    })
    const assignment = delegated.state.taskAssignments[delegated.taskAssignmentId]

    expect(assignment).toMatchObject({
      taskId: delegated.taskId,
      rootTaskId: root.taskId,
      grantId: granted.delegationGrantId,
      assigneeAgentId: workspace.engineerId,
    })
    expect(delegated.state.tasks[delegated.taskId]).toMatchObject({ rootTaskId: root.taskId, title: 'Implement API' })

    const unrelated = assignHumanTask(granted.state, {
      humanId: HumanId('owner'),
      assigneeAgentId: workspace.managerId,
      title: 'Handle the incident',
    })
    expect(() => assignDelegatedTask(unrelated.state, {
      actorAgentId: workspace.managerId,
      assigneeAgentId: workspace.engineerId,
      rootTaskId: unrelated.taskId,
      title: 'Investigate logs',
    })).toThrow(/human delegation grant/)

    const completed = completeTask(delegated.state, { actorAgentId: workspace.managerId, taskId: root.taskId })
    expect(completed.state.delegationGrants[granted.delegationGrantId]).toMatchObject({ status: 'expired' })
    expect(() => assignDelegatedTask(completed.state, {
      actorAgentId: workspace.managerId,
      assigneeAgentId: workspace.engineerId,
      rootTaskId: root.taskId,
      title: 'Ship documentation',
    })).toThrow(/human delegation grant/)
  })
})

describe('one-shot child records', () => {
  test('records a terminal child result in parent memory without creating a workspace colleague', () => {
    const workspace = createWorkspace()
    const root = assignHumanTask(workspace.state, {
      humanId: HumanId('owner'),
      assigneeAgentId: workspace.managerId,
      title: 'Deliver the release',
    })
    const started = recordChildRunStarted(root.state, {
      parentAgentId: workspace.managerId,
      taskId: root.taskId,
    })

    expect(started.state.childRuns[started.childRunId]).toMatchObject({
      parentAgentId: workspace.managerId,
      taskId: root.taskId,
      status: 'running',
    })
    expect(Object.keys(started.state.agents)).not.toContain(started.childRunId)
    expect(Object.values(started.state.memberships).map(membership => membership.agentId)).not.toContain(started.childRunId)

    const finished = recordChildRunFinished(started.state, {
      childRunId: started.childRunId,
      status: 'completed',
      result: 'The API implementation is ready.',
    })
    const terminalEvent = finished.state.events.at(-1)

    expect(finished.state.childRuns[started.childRunId]).toMatchObject({
      status: 'completed',
      result: 'The API implementation is ready.',
    })
    expect(terminalEvent).toMatchObject({
      type: 'child/run-finished',
      subjectId: started.childRunId,
      childRunStatus: 'completed',
      text: 'The API implementation is ready.',
    })
    expect(finished.state.memoryEntries).toContainEqual(expect.objectContaining({
      agentId: workspace.managerId,
      eventId: terminalEvent?.id,
      acquiredBy: 'child-result',
    }))
    expect(() => recordChildRunFinished(finished.state, {
      childRunId: started.childRunId,
      status: 'completed',
      result: 'A second result.',
    })).toThrow(/already terminal/)
  })

  test('records every terminal child status in a schema-valid canonical event', () => {
    const workspace = createWorkspace()
    const root = assignHumanTask(workspace.state, {
      humanId: HumanId('owner'),
      assigneeAgentId: workspace.managerId,
      title: 'Deliver the release',
    })
    const started = recordChildRunStarted(root.state, {
      parentAgentId: workspace.managerId,
      taskId: root.taskId,
    })

    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      const finished = recordChildRunFinished(started.state, {
        childRunId: started.childRunId,
        status,
        result: `${status} child result`,
      })
      const childRun = finished.state.childRuns[started.childRunId]
      if (childRun === undefined || childRun.status === 'running') throw new Error('expected terminal child run')
      const { result: _result, ...terminalRunWithoutResult } = childRun

      expect(finished.state.events.at(-1)).toMatchObject({ type: 'child/run-finished', childRunStatus: status })
      expect(workspaceStateSchema.safeParse(finished.state).success).toBe(true)
      expect(workspaceStateSchema.safeParse({
        ...finished.state,
        childRuns: {
          ...finished.state.childRuns,
          [started.childRunId]: { ...childRun, status: 'running', result: `${status} child result` },
        },
      }).success).toBe(false)
      expect(workspaceStateSchema.safeParse({
        ...finished.state,
        childRuns: { ...finished.state.childRuns, [started.childRunId]: terminalRunWithoutResult },
      }).success).toBe(false)
      const terminalEvent = finished.state.events.at(-1)
      if (terminalEvent === undefined) throw new Error('expected terminal child event')
      expect(workspaceStateSchema.safeParse({
        ...finished.state,
        events: [...finished.state.events.slice(0, -1), { ...terminalEvent, childRunStatus: 'running' }],
      }).success).toBe(false)
      const room = mutateWorkspace(finished.state, { type: 'room/create', kind: 'group', name: 'Engineering' })
      const recalled = recallAgentEvents(room.state, {
        agentId: workspace.managerId,
        roomId: room.roomId,
        query: '',
        characterBudget: 1_000,
      })
      expect(recalled.entries.find(entry => entry.eventId === terminalEvent.id)?.rendered).toContain(`child-status:${status}`)
    }
  })

  test('rejects a child result while its parent is departed and permits the re-employed identity to finish', () => {
    const workspace = createWorkspace()
    const root = assignHumanTask(workspace.state, {
      humanId: HumanId('owner'),
      assigneeAgentId: workspace.managerId,
      title: 'Deliver the release',
    })
    const started = recordChildRunStarted(root.state, {
      parentAgentId: workspace.managerId,
      taskId: root.taskId,
    })
    const departed = mutateWorkspace(started.state, { type: 'agent/depart', agentId: workspace.managerId })
    const eventCountBeforeFinish = departed.state.events.length
    const memoryCountBeforeFinish = departed.state.memoryEntries.length

    expect(() => recordChildRunFinished(departed.state, {
      childRunId: started.childRunId,
      status: 'completed',
      result: 'The API implementation is ready.',
    })).toThrow(/is departed/)
    expect(departed.state.events).toHaveLength(eventCountBeforeFinish)
    expect(departed.state.memoryEntries).toHaveLength(memoryCountBeforeFinish)

    const reemployed = mutateWorkspace(departed.state, { type: 'agent/employ', agentId: workspace.managerId })
    const finished = recordChildRunFinished(reemployed.state, {
      childRunId: started.childRunId,
      status: 'completed',
      result: 'The API implementation is ready.',
    })
    expect(finished.state.childRuns[started.childRunId]).toMatchObject({ status: 'completed' })
  })
})
