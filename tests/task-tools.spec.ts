import { describe, expect, test, vi } from 'vitest'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AgentId, HumanId, TaskId, WorkspaceId } from '../packages/host/src/ids.ts'
import { finishChildRun } from '../packages/host/src/child-runs.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import {
  acceptTaskDelivery,
  startTaskDelivery,
  terminalizeTask,
} from '../packages/host/src/task-delivery.ts'
import { TaskDeliveryCoordinator } from '../packages/host/src/task-delivery-coordinator.ts'
import type { TaskDeliveryCoordinatorHost } from '../packages/host/src/task-delivery-coordinator.ts'
import {
  assignHumanTask,
  grantTaskDelegation,
  recordChildRunStarted,
  revokeTaskDelegation,
} from '../packages/host/src/tasks.ts'
import type { WorkspaceState } from '../packages/host/src/types.ts'
import {
  registerWorkspaceTaskTools,
  type WorkspaceTaskToolHost,
  type WorkspaceToolRegistry,
} from '../packages/host/src/task-tools.ts'

type RegisteredTool = Parameters<WorkspaceToolRegistry['register']>[0]

function agent(sessionId: string): Agent {
  return { id: SessionId(sessionId) } as Agent
}

function toolExecution(caller?: Agent, signal = new AbortController().signal) {
  return {
    agent: caller,
    signal,
    concludeTurn: vi.fn(),
    deferContext: vi.fn(),
  } as never
}

function createWorkspace() {
  const initial = createInitialState(WorkspaceId('local'))
  const definition = mutateWorkspace(initial, {
    type: 'definition/create', name: 'Engineer', description: 'Build', instructions: 'Ship',
  })
  const manager = mutateWorkspace(definition.state, {
    type: 'agent/create', definitionId: definition.definitionId, name: 'Manager',
  })
  const engineer = mutateWorkspace(manager.state, {
    type: 'agent/create', definitionId: definition.definitionId, name: 'Engineer',
  })
  const root = assignHumanTask(engineer.state, {
    humanId: HumanId('owner'), assigneeAgentId: manager.agentId, title: 'Ship the release',
  })
  return {
    state: root.state,
    rootTaskId: root.taskId,
    managerId: manager.agentId,
    engineerId: engineer.agentId,
    manager: agent('manager-session'),
    engineer: agent('engineer-session'),
  }
}

function harness(initial: ReturnType<typeof createWorkspace>, stateOverride?: WorkspaceState) {
  let state = stateOverride ?? initial.state
  const identities = new WeakMap<Agent, ReturnType<typeof AgentId>>()
  identities.set(initial.manager, initial.managerId)
  identities.set(initial.engineer, initial.engineerId)
  const runAssignedTask = vi.fn(async (assigneeAgentId: ReturnType<typeof AgentId>, taskId: ReturnType<typeof TaskId>) => {
    const started = startTaskDelivery(state, { taskId })
    const accepted = acceptTaskDelivery(started.state, {
      taskId, attemptId: started.attemptId, messageId: started.message.id,
    })
    const assignee = accepted.state.agents[assigneeAgentId]
    if (assignee === undefined) throw new Error('assigned employee is missing')
    state = terminalizeTask(accepted.state, {
      actorAgentId: assigneeAgentId,
      taskId,
      attemptId: started.attemptId,
      result: 'peer result',
      definitionRevisionId: assignee.definitionRevisionId,
    }).state
    return 'peer result'
  })
  const runChild = vi.fn(async (
    parentAgentId: ReturnType<typeof AgentId>,
    taskId: ReturnType<typeof TaskId>,
    _prompt: string,
    _signal?: AbortSignal,
  ) => {
    const started = recordChildRunStarted(state, { parentAgentId, taskId })
    state = finishChildRun(started.state, {
      childRunId: started.childRunId, status: 'completed', result: 'child result',
    }).state
    return 'child result'
  })
  const host: WorkspaceTaskToolHost = {
    agentIdFor: caller => identities.get(caller),
    snapshot: () => structuredClone(state),
    apply: async mutation => {
      state = mutation(state)
      return structuredClone(state)
    },
    runAssignedTask,
    runChild,
  }
  return {
    host,
    identities,
    runAssignedTask,
    runChild,
    state: () => state,
  }
}

function registeredTools(host: WorkspaceTaskToolHost) {
  const tools: RegisteredTool[] = []
  const disposed: string[] = []
  const registry: WorkspaceToolRegistry = {
    register: tool => {
      tools.push(tool)
      return () => { disposed.push(tool.name) }
    },
  }
  const dispose = registerWorkspaceTaskTools(registry, host)
  const get = (name: string): RegisteredTool => {
    const tool = tools.find(candidate => candidate.name === name)
    if (tool === undefined) throw new Error(`tool '${name}' was not registered`)
    return tool
  }
  return { tools, disposed, dispose, get }
}

describe('agent-facing workspace task tools', () => {
  test('registers three actor-free schemas and rejects forged actor properties', async () => {
    const fixture = createWorkspace()
    const built = harness(fixture)
    const registered = registeredTools(built.host)

    expect(registered.tools.map(tool => tool.name)).toEqual([
      'workspace_delegate_task',
      'workspace_run_child',
      'workspace_complete_task',
    ])
    expect(Object.keys(registered.get('workspace_delegate_task').parameters.properties)).toEqual([
      'rootTaskId', 'assigneeAgentId', 'title',
    ])
    expect(Object.keys(registered.get('workspace_run_child').parameters.properties)).toEqual(['taskId', 'prompt'])
    expect(Object.keys(registered.get('workspace_complete_task').parameters.properties)).toEqual(['taskId', 'result'])
    expect(JSON.stringify(registered.tools.map(tool => tool.parameters))).not.toMatch(/actorAgentId|humanId/)

    await expect(registered.get('workspace_delegate_task').execute({
      rootTaskId: fixture.rootTaskId,
      assigneeAgentId: fixture.engineerId,
      title: 'Implement the API',
      actorAgentId: fixture.engineerId,
    }, toolExecution(fixture.manager))).rejects.toThrow("workspace_delegate_task does not accept argument 'actorAgentId'")

    registered.dispose()
    expect(registered.disposed).toEqual([
      'workspace_complete_task',
      'workspace_run_child',
      'workspace_delegate_task',
    ])
  })

  test('rolls back earlier definitions when a later registration fails', () => {
    const fixture = createWorkspace()
    const built = harness(fixture)
    const registered: string[] = []
    const disposed: string[] = []
    const registry: WorkspaceToolRegistry = {
      register: tool => {
        registered.push(tool.name)
        if (tool.name === 'workspace_run_child') throw new Error('registry rejected duplicate')
        return () => { disposed.push(tool.name) }
      },
    }

    expect(() => registerWorkspaceTaskTools(registry, built.host)).toThrow('registry rejected duplicate')
    expect(registered).toEqual(['workspace_delegate_task', 'workspace_run_child'])
    expect(disposed).toEqual(['workspace_delegate_task'])
  })

  test('rejects missing, unowned, stale, and departed caller handles with safe errors', async () => {
    const fixture = createWorkspace()
    const built = harness(fixture)
    const delegate = registeredTools(built.host).get('workspace_delegate_task')
    const args = {
      rootTaskId: fixture.rootTaskId,
      assigneeAgentId: fixture.engineerId,
      title: 'Implement the API',
    }

    await expect(delegate.execute(args, toolExecution())).rejects.toThrow('Workspace task tools require an employee agent caller.')
    const outsider = agent('SECRET_OUTSIDER_SESSION')
    await expect(delegate.execute(args, toolExecution(outsider))).rejects.toThrow('Workspace task tool caller is not an active employee.')
    built.identities.delete(fixture.manager)
    const stale = await delegate.execute(args, toolExecution(fixture.manager)).catch((error: unknown) => error)
    expect(stale).toMatchObject({ message: 'Workspace task tool caller is not an active employee.' })
    expect(JSON.stringify(stale)).not.toContain('SECRET_OUTSIDER_SESSION')

    built.identities.set(fixture.manager, fixture.managerId)
    await built.host.apply(state => mutateWorkspace(state, {
      type: 'agent/depart', agentId: fixture.managerId,
    }).state)
    const departed = await delegate.execute(args, toolExecution(fixture.manager)).catch((error: unknown) => error)
    expect(departed).toMatchObject({ message: 'Workspace task tool caller is not an active employee.' })
    expect(JSON.stringify(departed)).not.toContain(fixture.managerId)
  })

  test('does not expose a caller id when departure wins the serialized mutation race', async () => {
    const fixture = createWorkspace()
    const built = harness(fixture)
    const grant = grantTaskDelegation(built.state(), {
      humanId: HumanId('owner'), granteeAgentId: fixture.managerId, rootTaskId: fixture.rootTaskId,
    })
    await built.host.apply(() => grant.state)
    const racedHost: WorkspaceTaskToolHost = {
      ...built.host,
      apply: async mutation => {
        const departed = mutateWorkspace(built.state(), {
          type: 'agent/depart', agentId: fixture.managerId,
        })
        return await built.host.apply(() => mutation(departed.state))
      },
    }
    const delegate = registeredTools(racedHost).get('workspace_delegate_task')

    const error = await delegate.execute({
      rootTaskId: fixture.rootTaskId,
      assigneeAgentId: fixture.engineerId,
      title: 'Implement the API',
    }, toolExecution(fixture.manager)).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ message: 'Workspace task tool caller is not an active employee.' })
    expect(JSON.stringify(error)).not.toContain(fixture.managerId)
  })

  test('delegates through the active human grant and assigned-task coordinator path', async () => {
    const fixture = createWorkspace()
    const built = harness(fixture)
    const delegate = registeredTools(built.host).get('workspace_delegate_task')
    const args = {
      rootTaskId: fixture.rootTaskId,
      assigneeAgentId: fixture.engineerId,
      title: 'Implement the API',
    }

    await expect(delegate.execute(args, toolExecution(fixture.manager))).rejects.toMatchObject({ code: 'delegation-grant-missing' })
    const granted = grantTaskDelegation(built.state(), {
      humanId: HumanId('owner'), granteeAgentId: fixture.managerId, rootTaskId: fixture.rootTaskId,
    })
    await built.host.apply(() => granted.state)
    const revoked = revokeTaskDelegation(built.state(), {
      humanId: HumanId('owner'), delegationGrantId: granted.delegationGrantId,
    })
    await built.host.apply(() => revoked.state)
    await expect(delegate.execute(args, toolExecution(fixture.manager))).rejects.toMatchObject({ code: 'delegation-grant-inactive' })

    const active = grantTaskDelegation(built.state(), {
      humanId: HumanId('owner'), granteeAgentId: fixture.managerId, rootTaskId: fixture.rootTaskId,
    })
    await built.host.apply(() => active.state)
    const result = await delegate.execute(args, toolExecution(fixture.manager))

    expect(result).toMatchObject({ status: 'completed', result: 'peer result' })
    expect(built.runAssignedTask).toHaveBeenCalledWith(fixture.engineerId, expect.any(String))
    const delegated = Object.values(built.state().tasks).find(task => task.id !== fixture.rootTaskId)
    expect(delegated).toMatchObject({ title: 'Implement the API', status: 'completed' })
  })

  test('runs child work only for the acting employee assigned to the task', async () => {
    const fixture = createWorkspace()
    const built = harness(fixture)
    const runChild = registeredTools(built.host).get('workspace_run_child')

    await expect(runChild.execute({
      taskId: fixture.rootTaskId, prompt: 'Investigate',
    }, toolExecution(fixture.engineer))).rejects.toMatchObject({ code: 'task-not-assigned' })

    const signal = new AbortController().signal
    await expect(runChild.execute({
      taskId: fixture.rootTaskId, prompt: 'Investigate',
    }, toolExecution(fixture.manager, signal))).resolves.toEqual({
      taskId: fixture.rootTaskId, result: 'child result',
    })
    expect(built.runChild).toHaveBeenCalledWith(fixture.managerId, fixture.rootTaskId, 'Investigate', signal)
    expect(Object.values(built.state().childRuns)).toContainEqual(expect.objectContaining({
      parentAgentId: fixture.managerId, taskId: fixture.rootTaskId, status: 'completed', result: 'child result',
    }))
  })

  test('atomically completes only the current accepted attempt with the explicit result', async () => {
    const fixture = createWorkspace()
    const started = startTaskDelivery(fixture.state, { taskId: fixture.rootTaskId })
    const accepted = acceptTaskDelivery(started.state, {
      taskId: fixture.rootTaskId, attemptId: started.attemptId, messageId: started.message.id,
    })
    const built = harness(fixture, accepted.state)
    const complete = registeredTools(built.host).get('workspace_complete_task')
    const execution = toolExecution(fixture.manager) as unknown as { concludeTurn: ReturnType<typeof vi.fn> }
    const beforeRevision = built.state().revision

    await expect(complete.execute({
      taskId: fixture.rootTaskId, result: 'explicit full result',
    }, execution as never)).resolves.toEqual({
      taskId: fixture.rootTaskId,
      attemptId: started.attemptId,
      status: 'completed',
    })

    expect(execution.concludeTurn).toHaveBeenCalledOnce()
    expect(built.state().revision).toBe(beforeRevision + 1)
    expect(built.state().tasks[fixture.rootTaskId]?.status).toBe('completed')
    expect(built.state().events.filter(event => event.type === 'task/result')).toEqual([
      expect.objectContaining({
        taskId: fixture.rootTaskId,
        taskDeliveryAttemptId: started.attemptId,
        definitionRevisionId: fixture.state.agents[fixture.managerId]?.definitionRevisionId,
        text: 'explicit full result',
      }),
    ])
  })

  test('rejects completion by an unassigned employee and without an accepted attempt', async () => {
    const fixture = createWorkspace()
    const built = harness(fixture)
    const complete = registeredTools(built.host).get('workspace_complete_task')

    await expect(complete.execute({
      taskId: fixture.rootTaskId, result: 'not accepted',
    }, toolExecution(fixture.manager))).rejects.toThrow('Task completion requires the current accepted delivery attempt.')

    const started = startTaskDelivery(built.state(), { taskId: fixture.rootTaskId })
    const accepted = acceptTaskDelivery(started.state, {
      taskId: fixture.rootTaskId, attemptId: started.attemptId, messageId: started.message.id,
    })
    await built.host.apply(() => accepted.state)
    await expect(complete.execute({
      taskId: fixture.rootTaskId, result: 'forged result',
    }, toolExecution(fixture.engineer))).rejects.toMatchObject({ code: 'task-not-assigned' })
  })

  test.each([
    ['later completed output', {
      output: [{ type: 'text' as const, text: 'later automatic output' }],
      stopReason: { kind: 'completed' as const },
      interrupted: false,
    }],
    ['aborted partial output', {
      output: [{ type: 'text' as const, text: 'partial output' }],
      stopReason: { kind: 'aborted' as const, reason: { kind: 'user' as const } },
      interrupted: true,
    }],
  ])('explicit tool completion converges with coordinator %s without a second terminal result', async (_label, outcome) => {
    const fixture = createWorkspace()
    let state = fixture.state
    const identities = new WeakMap<Agent, ReturnType<typeof AgentId>>([[fixture.manager, fixture.managerId]])
    let complete: RegisteredTool
    const toolHost: WorkspaceTaskToolHost = {
      agentIdFor: caller => identities.get(caller),
      snapshot: () => structuredClone(state),
      apply: async mutation => {
        state = mutation(state)
        return structuredClone(state)
      },
      runAssignedTask: vi.fn(),
      runChild: vi.fn(),
    }
    complete = registeredTools(toolHost).get('workspace_complete_task')
    const coordinatorHost: TaskDeliveryCoordinatorHost = {
      snapshot: () => structuredClone(state),
      apply: toolHost.apply,
      ensureEmployee: async (): Promise<AgentHandle> => ({ agent: fixture.manager, dispose: vi.fn(async () => {}) }),
      deliver: async (_agentId, _delivery, _recall, _source, hooks) => {
        await hooks?.onClaim?.()
        await complete.execute({
          taskId: fixture.rootTaskId, result: 'explicit full result',
        }, toolExecution(fixture.manager))
        return outcome
      },
    }

    await expect(new TaskDeliveryCoordinator(coordinatorHost).deliver(fixture.rootTaskId)).resolves.toBe('explicit full result')
    expect(state.events.filter(event => event.type === 'task/result')).toEqual([
      expect.objectContaining({ text: 'explicit full result' }),
    ])
    expect(JSON.stringify(state.events)).not.toContain('partial output')
    expect(JSON.stringify(state.events)).not.toContain('later automatic output')
  })
})
