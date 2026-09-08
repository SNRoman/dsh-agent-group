import { describe, expect, test } from 'vitest'
import { DelegationGrantId, HumanId, WorkspaceId } from '../packages/host/src/ids.ts'
import {
  assignDelegatedTask,
  assignHumanTask,
  completeTask,
  cancelTask,
  grantTaskDelegation,
  recordChildRunFinished,
  recordChildRunStarted,
  revokeTaskDelegation,
} from '../packages/host/src/tasks.ts'
import { startTaskDelivery, acceptTaskDelivery, terminalizeTask } from '../packages/host/src/task-delivery.ts'
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
  test('only the employed root assignee can receive delegation authority', () => {
    const workspace = createWorkspace()
    const root = assignHumanTask(workspace.state, {
      humanId: HumanId('owner'), assigneeAgentId: workspace.managerId, title: 'Deliver the release',
    })
    const before = structuredClone(root.state)

    expect(() => grantTaskDelegation(root.state, {
      humanId: HumanId('owner'), granteeAgentId: workspace.engineerId, rootTaskId: root.taskId,
    })).toThrow(expect.objectContaining({ code: 'task-not-assigned' }))
    expect(root.state).toEqual(before)
  })

  test('distinguishes missing and explicitly revoked delegation authority', () => {
    const workspace = createWorkspace()
    const root = assignHumanTask(workspace.state, {
      humanId: HumanId('owner'), assigneeAgentId: workspace.managerId, title: 'Deliver the release',
    })
    const delegatedRequest = {
      actorAgentId: workspace.managerId,
      assigneeAgentId: workspace.engineerId,
      rootTaskId: root.taskId,
      title: 'Implement API',
    }
    const beforeMissing = structuredClone(root.state)
    expect(() => assignDelegatedTask(root.state, delegatedRequest)).toThrow(expect.objectContaining({ code: 'delegation-grant-missing' }))
    expect(root.state).toEqual(beforeMissing)

    const granted = grantTaskDelegation(root.state, {
      humanId: HumanId('owner'), granteeAgentId: workspace.managerId, rootTaskId: root.taskId,
    })
    const revoked = revokeTaskDelegation(granted.state, {
      humanId: HumanId('owner'), delegationGrantId: granted.delegationGrantId,
    })
    expect(revoked.state.delegationGrants[granted.delegationGrantId]?.status).toBe('expired')
    expect(revoked.state.events.at(-1)).toMatchObject({
      type: 'task/delegation-revoked', subjectId: granted.delegationGrantId, actor: { type: 'human', id: HumanId('owner') },
    })
    const beforeInactive = structuredClone(revoked.state)
    expect(() => assignDelegatedTask(revoked.state, delegatedRequest)).toThrow(expect.objectContaining({ code: 'delegation-grant-inactive' }))
    expect(() => revokeTaskDelegation(revoked.state, {
      humanId: HumanId('owner'), delegationGrantId: granted.delegationGrantId,
    })).toThrow(expect.objectContaining({ code: 'delegation-grant-inactive' }))
    expect(revoked.state).toEqual(beforeInactive)
  })

  test('uses a new active grant after an earlier grant was revoked', () => {
    const workspace = createWorkspace()
    const root = assignHumanTask(workspace.state, {
      humanId: HumanId('owner'), assigneeAgentId: workspace.managerId, title: 'Deliver the release',
    })
    const firstGrant = grantTaskDelegation(root.state, {
      humanId: HumanId('owner'), granteeAgentId: workspace.managerId, rootTaskId: root.taskId,
    })
    const revoked = revokeTaskDelegation(firstGrant.state, {
      humanId: HumanId('owner'), delegationGrantId: firstGrant.delegationGrantId,
    })
    const secondGrant = grantTaskDelegation(revoked.state, {
      humanId: HumanId('owner'), granteeAgentId: workspace.managerId, rootTaskId: root.taskId,
    })

    const delegated = assignDelegatedTask(secondGrant.state, {
      actorAgentId: workspace.managerId, assigneeAgentId: workspace.engineerId, rootTaskId: root.taskId, title: 'Implement API',
    })

    expect(delegated.state.taskAssignments[delegated.taskAssignmentId]?.grantId).toBe(secondGrant.delegationGrantId)
  })

  test('repeated grant while authority is active is idempotent', () => {
    const workspace = createWorkspace()
    const root = assignHumanTask(workspace.state, {
      humanId: HumanId('owner'), assigneeAgentId: workspace.managerId, title: 'Deliver the release',
    })
    const first = grantTaskDelegation(root.state, {
      humanId: HumanId('owner'), granteeAgentId: workspace.managerId, rootTaskId: root.taskId,
    })
    const repeated = grantTaskDelegation(first.state, {
      humanId: HumanId('owner'), granteeAgentId: workspace.managerId, rootTaskId: root.taskId,
    })

    expect(repeated.delegationGrantId).toBe(first.delegationGrantId)
    expect(repeated.state).toBe(first.state)
    expect(Object.values(repeated.state.delegationGrants).filter(grant => grant.status === 'active')).toHaveLength(1)
  })

  test('rejects revocation of a missing grant without changing state', () => {
    const workspace = createWorkspace()
    const before = structuredClone(workspace.state)
    expect(() => revokeTaskDelegation(workspace.state, {
      humanId: HumanId('owner'), delegationGrantId: DelegationGrantId('delegation-grant-missing'),
    })).toThrow(expect.objectContaining({ code: 'delegation-grant-missing' }))
    expect(workspace.state).toEqual(before)
  })

  test('root cancellation closes the full open tree, expires grants, and reports running children', () => {
    const workspace = createWorkspace()
    const root = assignHumanTask(workspace.state, {
      humanId: HumanId('owner'), assigneeAgentId: workspace.managerId, title: 'Deliver the release',
    })
    const granted = grantTaskDelegation(root.state, {
      humanId: HumanId('owner'), granteeAgentId: workspace.managerId, rootTaskId: root.taskId,
    })
    const derived = assignDelegatedTask(granted.state, {
      actorAgentId: workspace.managerId, assigneeAgentId: workspace.engineerId, rootTaskId: root.taskId, title: 'Implement API',
    })
    const rootChild = recordChildRunStarted(derived.state, { parentAgentId: workspace.managerId, taskId: root.taskId })
    const derivedChild = recordChildRunStarted(rootChild.state, { parentAgentId: workspace.engineerId, taskId: derived.taskId })
    const rootTerminalStart = recordChildRunStarted(derivedChild.state, {
      parentAgentId: workspace.engineerId, taskId: derived.taskId,
    })
    const rootTerminal = recordChildRunFinished(rootTerminalStart.state, {
      childRunId: rootTerminalStart.childRunId, status: 'completed', result: 'root tree done',
    })
    const unrelatedRoot = assignHumanTask(rootTerminal.state, {
      humanId: HumanId('owner'), assigneeAgentId: workspace.managerId, title: 'Unrelated root',
    })
    const unrelatedGrant = grantTaskDelegation(unrelatedRoot.state, {
      humanId: HumanId('owner'), granteeAgentId: workspace.managerId, rootTaskId: unrelatedRoot.taskId,
    })
    const unrelatedRunning = recordChildRunStarted(unrelatedGrant.state, {
      parentAgentId: workspace.managerId, taskId: unrelatedRoot.taskId,
    })
    const unrelatedTerminalStart = recordChildRunStarted(unrelatedRunning.state, {
      parentAgentId: workspace.managerId, taskId: unrelatedRoot.taskId,
    })
    const unrelatedTerminal = recordChildRunFinished(unrelatedTerminalStart.state, {
      childRunId: unrelatedTerminalStart.childRunId, status: 'completed', result: 'unrelated done',
    })

    const cancelled = cancelTask(unrelatedTerminal.state, { humanId: HumanId('owner'), taskId: root.taskId })

    expect(cancelled.cancelledTaskIds).toEqual([...cancelled.cancelledTaskIds].sort())
    expect(new Set(cancelled.cancelledTaskIds)).toEqual(new Set([root.taskId, derived.taskId]))
    expect(cancelled.expiredGrantIds).toEqual([granted.delegationGrantId])
    expect(new Set(cancelled.runningChildRunIds)).toEqual(new Set([rootChild.childRunId, derivedChild.childRunId]))
    expect(cancelled.cancelledTaskIds.every(taskId => cancelled.state.tasks[taskId]?.status === 'cancelled')).toBe(true)
    expect(cancelled.state.delegationGrants[granted.delegationGrantId]?.status).toBe('expired')
    expect(cancelled.state.tasks[unrelatedRoot.taskId]?.status).toBe('open')
    expect(cancelled.state.delegationGrants[unrelatedGrant.delegationGrantId]?.status).toBe('active')
    expect(cancelled.state.childRuns[rootTerminalStart.childRunId]?.status).toBe('completed')
    expect(cancelled.state.childRuns[unrelatedRunning.childRunId]?.status).toBe('running')
    expect(cancelled.state.childRuns[unrelatedTerminalStart.childRunId]?.status).toBe('completed')
    expect(cancelled.expiredGrantIds).not.toContain(unrelatedGrant.delegationGrantId)
    expect(cancelled.runningChildRunIds).not.toContain(unrelatedRunning.childRunId)
    expect(cancelled.runningChildRunIds).not.toContain(rootTerminalStart.childRunId)
    expect(cancelled.runningChildRunIds).not.toContain(unrelatedTerminalStart.childRunId)
    const cancellationSubjects = cancelled.state.events
      .filter(event => event.type === 'task/cancelled')
      .map(event => event.subjectId)
    expect(cancellationSubjects).toEqual(cancelled.cancelledTaskIds)
  })

  test('derived cancellation leaves its root, sibling authority, and other tasks open', () => {
    const workspace = createWorkspace()
    const root = assignHumanTask(workspace.state, {
      humanId: HumanId('owner'), assigneeAgentId: workspace.managerId, title: 'Deliver the release',
    })
    const granted = grantTaskDelegation(root.state, {
      humanId: HumanId('owner'), granteeAgentId: workspace.managerId, rootTaskId: root.taskId,
    })
    const first = assignDelegatedTask(granted.state, {
      actorAgentId: workspace.managerId, assigneeAgentId: workspace.engineerId, rootTaskId: root.taskId, title: 'API',
    })
    const second = assignDelegatedTask(first.state, {
      actorAgentId: workspace.managerId, assigneeAgentId: workspace.engineerId, rootTaskId: root.taskId, title: 'Docs',
    })

    const cancelled = cancelTask(second.state, { humanId: HumanId('owner'), taskId: first.taskId })

    expect(cancelled.cancelledTaskIds).toEqual([first.taskId])
    expect(cancelled.expiredGrantIds).toEqual([])
    expect(cancelled.state.tasks[root.taskId]?.status).toBe('open')
    expect(cancelled.state.tasks[second.taskId]?.status).toBe('open')
    expect(cancelled.state.delegationGrants[granted.delegationGrantId]?.status).toBe('active')
  })

  test('rejects child work by an unassigned agent and terminal task mutations without changing state', () => {
    const workspace = createWorkspace()
    const root = assignHumanTask(workspace.state, {
      humanId: HumanId('owner'), assigneeAgentId: workspace.managerId, title: 'Deliver the release',
    })
    const beforeUnassigned = structuredClone(root.state)
    expect(() => recordChildRunStarted(root.state, {
      parentAgentId: workspace.engineerId, taskId: root.taskId,
    })).toThrow(expect.objectContaining({ code: 'task-not-assigned' }))
    expect(root.state).toEqual(beforeUnassigned)

    const completed = completeTask(root.state, { actorAgentId: workspace.managerId, taskId: root.taskId })
    const beforeTerminal = structuredClone(completed.state)
    expect(() => cancelTask(completed.state, { humanId: HumanId('owner'), taskId: root.taskId }))
      .toThrow(expect.objectContaining({ code: 'task-not-open' }))
    expect(() => recordChildRunStarted(completed.state, { parentAgentId: workspace.managerId, taskId: root.taskId }))
      .toThrow(expect.objectContaining({ code: 'task-not-open' }))
    expect(completed.state).toEqual(beforeTerminal)
  })

  test('rejects departed task participants without changing state', () => {
    const workspace = createWorkspace()
    const root = assignHumanTask(workspace.state, {
      humanId: HumanId('owner'), assigneeAgentId: workspace.managerId, title: 'Deliver the release',
    })
    const granted = grantTaskDelegation(root.state, {
      humanId: HumanId('owner'), granteeAgentId: workspace.managerId, rootTaskId: root.taskId,
    })

    const managerDeparted = mutateWorkspace(granted.state, { type: 'agent/depart', agentId: workspace.managerId }).state
    const beforeManager = structuredClone(managerDeparted)
    expect(() => grantTaskDelegation(managerDeparted, {
      humanId: HumanId('owner'), granteeAgentId: workspace.managerId, rootTaskId: root.taskId,
    })).toThrow(expect.objectContaining({ code: 'agent-departed' }))
    expect(() => assignDelegatedTask(managerDeparted, {
      actorAgentId: workspace.managerId, assigneeAgentId: workspace.engineerId, rootTaskId: root.taskId, title: 'API',
    })).toThrow(expect.objectContaining({ code: 'agent-departed' }))
    expect(() => recordChildRunStarted(managerDeparted, {
      parentAgentId: workspace.managerId, taskId: root.taskId,
    })).toThrow(expect.objectContaining({ code: 'agent-departed' }))
    expect(managerDeparted).toEqual(beforeManager)

    const engineerDeparted = mutateWorkspace(granted.state, { type: 'agent/depart', agentId: workspace.engineerId }).state
    const beforeEngineer = structuredClone(engineerDeparted)
    expect(() => assignDelegatedTask(engineerDeparted, {
      actorAgentId: workspace.managerId, assigneeAgentId: workspace.engineerId, rootTaskId: root.taskId, title: 'API',
    })).toThrow(expect.objectContaining({ code: 'agent-departed' }))
    expect(engineerDeparted).toEqual(beforeEngineer)
  })

  test('rejects every task action after completed or cancelled terminalization without changing state', () => {
    const workspace = createWorkspace()
    const root = assignHumanTask(workspace.state, {
      humanId: HumanId('owner'), assigneeAgentId: workspace.managerId, title: 'Deliver the release',
    })
    const completed = completeTask(root.state, { actorAgentId: workspace.managerId, taskId: root.taskId }).state
    const cancelledRoot = assignHumanTask(workspace.state, {
      humanId: HumanId('owner'), assigneeAgentId: workspace.managerId, title: 'Cancel this',
    })
    const cancelled = cancelTask(cancelledRoot.state, { humanId: HumanId('owner'), taskId: cancelledRoot.taskId }).state

    for (const [terminal, taskId] of [[completed, root.taskId], [cancelled, cancelledRoot.taskId]] as const) {
      const before = structuredClone(terminal)
      const actions = [
        () => grantTaskDelegation(terminal, { humanId: HumanId('owner'), granteeAgentId: workspace.managerId, rootTaskId: taskId }),
        () => assignDelegatedTask(terminal, { actorAgentId: workspace.managerId, assigneeAgentId: workspace.engineerId, rootTaskId: taskId, title: 'late' }),
        () => completeTask(terminal, { actorAgentId: workspace.managerId, taskId }),
        () => cancelTask(terminal, { humanId: HumanId('owner'), taskId }),
        () => recordChildRunStarted(terminal, { parentAgentId: workspace.managerId, taskId }),
      ]
      for (const action of actions) expect(action).toThrow(expect.objectContaining({ code: 'task-not-open' }))
      expect(terminal).toEqual(before)
    }
  })

  test('treats delivery terminalization as task completion for later task actions', () => {
    const workspace = createWorkspace()
    const root = assignHumanTask(workspace.state, {
      humanId: HumanId('owner'), assigneeAgentId: workspace.managerId, title: 'Deliver the release',
    })
    const started = startTaskDelivery(root.state, { taskId: root.taskId })
    const accepted = acceptTaskDelivery(started.state, { taskId: root.taskId, attemptId: started.attemptId, messageId: started.message.id })
    const terminal = terminalizeTask(accepted.state, {
      actorAgentId: workspace.managerId, taskId: root.taskId, attemptId: started.attemptId,
      result: 'Delivered.', definitionRevisionId: Object.values(root.state.definitionRevisions)[0]!.id,
    })

    expect(() => recordChildRunStarted(terminal.state, { parentAgentId: workspace.managerId, taskId: root.taskId }))
      .toThrow(expect.objectContaining({ code: 'task-not-open' }))
  })

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
    })).toThrow(expect.objectContaining({ code: 'task-not-open' }))
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
      const { childRunStatus: _childRunStatus, ...terminalEventWithoutStatus } = terminalEvent
      expect(workspaceStateSchema.safeParse({
        ...finished.state,
        events: [...finished.state.events.slice(0, -1), terminalEventWithoutStatus],
      }).success).toBe(false)
      const unrelatedEvent = finished.state.events.find(event => event.type !== 'child/run-finished')
      if (unrelatedEvent === undefined) throw new Error('expected unrelated event')
      expect(workspaceStateSchema.safeParse({
        ...finished.state,
        events: finished.state.events.map(event => event.id === unrelatedEvent.id ? { ...event, childRunStatus: status } : event),
      }).success).toBe(false)
      expect(workspaceStateSchema.safeParse({
        ...finished.state,
        childRuns: { ...finished.state.childRuns, [started.childRunId]: { ...childRun, result: '   ' } },
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
