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
    expect(terminalEvent).toMatchObject({ type: 'child/run-finished', subjectId: started.childRunId, text: 'The API implementation is ready.' })
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
})
