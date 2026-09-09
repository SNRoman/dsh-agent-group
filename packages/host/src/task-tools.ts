/** Agent-facing task tools whose caller identity comes only from the live employee pool. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { WorkspaceBusinessError } from './errors.ts'
import { AgentId, TaskId } from './ids.ts'
import type { AgentId as WorkspaceAgentId, TaskDeliveryAttemptId, TaskId as WorkspaceTaskId } from './ids.ts'
import { inspectTaskDelivery, recordTaskResultAfterCancel, terminalizeTask } from './task-delivery.ts'
import { assignDelegatedTask } from './tasks.ts'
import type { WorkspaceState } from './types.ts'

/** Registry face used to install and remove one complete task-tool set. */
export type WorkspaceToolRegistry = Pick<ToolRuntime, 'register'>

/** Serialized Host operations required by the agent-facing task tools. */
export interface WorkspaceTaskToolHost {
  /** Resolve only a currently published employee Agent handle. */
  agentIdFor(agent: Agent): WorkspaceAgentId | undefined
  /** Read the durable employee status used to authenticate the opaque handle. */
  snapshot(): WorkspaceState
  /** Commit one pure aggregate mutation through the workspace table. */
  apply(mutation: (state: WorkspaceState) => WorkspaceState): Promise<WorkspaceState>
  /** Deliver one assigned task through the durable task coordinator. */
  runAssignedTask(agentId: WorkspaceAgentId, taskId: WorkspaceTaskId): Promise<string>
  /** Run one child through the existing child controller and settlement owner. */
  runChild(parentAgentId: WorkspaceAgentId, taskId: WorkspaceTaskId, prompt: string, signal?: AbortSignal): Promise<string>
}

const taskIdParameter = {
  type: 'string' as const,
  required: true as const,
  description: 'Durable Agent Workspace task id.',
}

const textOutput = (text: string) => [{ type: 'text' as const, text }]

class WorkspaceTaskToolError extends Error {
  override readonly name = 'WorkspaceTaskToolError'
  readonly code: 'WORKSPACE_TASK_POLICY_DENIED' | 'WORKSPACE_TASK_CALLER_UNAVAILABLE'

  constructor(code: 'WORKSPACE_TASK_POLICY_DENIED' | 'WORKSPACE_TASK_CALLER_UNAVAILABLE') {
    super(code === 'WORKSPACE_TASK_POLICY_DENIED'
      ? 'Workspace task request is not permitted.'
      : 'Workspace task tool caller is not an active employee.')
    this.code = code
  }
}

/** Register all task tools and return one idempotent disposer for their definitions. */
export function registerWorkspaceTaskTools(registry: WorkspaceToolRegistry, host: WorkspaceTaskToolHost): () => void {
  const definitions = createWorkspaceTaskTools(host)
  const disposers: Array<() => void> = []
  try {
    for (const definition of definitions) disposers.push(registry.register(definition))
  } catch (error) {
    disposeDefinitions(disposers)
    throw error
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    disposeDefinitions(disposers)
  }
}

function createWorkspaceTaskTools(host: WorkspaceTaskToolHost): readonly ToolDefinition[] {
  const delegate = defineTool({
    name: 'workspace_delegate_task',
    description: 'Delegate work under an assigned root task to another employed workspace agent.',
    parameters: {
      rootTaskId: taskIdParameter,
      assigneeAgentId: {
        type: 'string',
        required: true,
        description: 'Durable id of the employed agent that should receive the peer task.',
      },
      title: {
        type: 'string',
        required: true,
        description: 'Complete title and instruction for the delegated task.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          taskAssignmentId: { type: 'string', required: true },
          status: { type: 'string', const: 'completed', required: true },
          result: { type: 'string', required: true },
        },
      },
      render: (_args, value) => textOutput(`Delegated task ${value.taskId} completed.\n\n${value.result}`),
    },
    execute: async (args, exec) => {
      assertExactArguments('workspace_delegate_task', args, ['rootTaskId', 'assigneeAgentId', 'title'])
      const actorAgentId = resolveActor(host, exec)
      const rootTaskId = TaskId(args.rootTaskId)
      const assigneeAgentId = AgentId(args.assigneeAgentId)
      return await runAsActiveActor(actorAgentId, async () => {
        let delegated: { readonly taskId: WorkspaceTaskId; readonly taskAssignmentId: string } | undefined
        await host.apply(current => {
          const changed = assignDelegatedTask(current, {
            actorAgentId,
            rootTaskId,
            assigneeAgentId,
            title: args.title,
          })
          delegated = { taskId: changed.taskId, taskAssignmentId: changed.taskAssignmentId }
          return changed.state
        })
        if (delegated === undefined) throw new Error('Workspace task delegation did not publish durable ids.')
        const published = delegated
        const result = await host.runAssignedTask(assigneeAgentId, published.taskId)
        return {
          taskId: published.taskId,
          taskAssignmentId: published.taskAssignmentId,
          status: 'completed' as const,
          result,
        }
      })
    },
  })

  const runChild = defineTool({
    name: 'workspace_run_child',
    description: 'Run one one-shot child for an open task assigned to the calling employee.',
    parameters: {
      taskId: taskIdParameter,
      prompt: {
        type: 'string',
        required: true,
        description: 'Complete prompt for the one-shot child.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          result: { type: 'string', required: true },
        },
      },
      render: (_args, value) => textOutput(value.result),
    },
    execute: async (args, exec) => {
      assertExactArguments('workspace_run_child', args, ['taskId', 'prompt'])
      const actorAgentId = resolveActor(host, exec)
      const taskId = TaskId(args.taskId)
      const result = await runAsActiveActor(actorAgentId, async () => await host.runChild(actorAgentId, taskId, args.prompt, exec.signal))
      return { taskId, result }
    },
  })

  const complete = defineTool({
    name: 'workspace_complete_task',
    description: 'Submit the complete result for the calling employee\'s current accepted task attempt.',
    parameters: {
      taskId: taskIdParameter,
      result: {
        type: 'string',
        required: true,
        description: 'Complete textual task result to store durably.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          attemptId: { type: 'string', required: true },
          status: { type: 'string', const: 'completed', required: true },
        },
      },
      render: (_args, value) => textOutput(`Completed task ${value.taskId}.`),
    },
    execute: async (args, exec) => {
      assertExactArguments('workspace_complete_task', args, ['taskId', 'result'])
      const actorAgentId = resolveActor(host, exec)
      const taskId = TaskId(args.taskId)
      let attemptId: TaskDeliveryAttemptId | undefined
      await runAsActiveActor(actorAgentId, async () => {
        await host.apply(current => {
          const inspection = inspectTaskDelivery(current, taskId)
          if (inspection.attemptId === undefined || inspection.phase !== 'accepted') {
            throw new WorkspaceTaskToolError('WORKSPACE_TASK_POLICY_DENIED')
          }
          const actor = current.agents[actorAgentId]
          if (actor?.employmentStatus !== 'employed') {
            throw new WorkspaceTaskToolError('WORKSPACE_TASK_CALLER_UNAVAILABLE')
          }
          attemptId = inspection.attemptId
          const request = {
            actorAgentId,
            taskId,
            attemptId: inspection.attemptId,
            result: args.result,
            definitionRevisionId: actor.definitionRevisionId,
          }
          return current.tasks[taskId]?.status === 'cancelled'
            ? recordTaskResultAfterCancel(current, request).state
            : terminalizeTask(current, request).state
        })
      })
      if (attemptId === undefined) throw new Error('Workspace task completion did not settle an accepted attempt.')
      exec.concludeTurn()
      return { taskId, attemptId, status: 'completed' as const }
    },
  })

  return [delegate, runChild, complete]
}

function resolveActor(host: WorkspaceTaskToolHost, exec: ToolRunContext): WorkspaceAgentId {
  if (exec.agent === undefined) throw new WorkspaceTaskToolError('WORKSPACE_TASK_CALLER_UNAVAILABLE')
  const agentId = host.agentIdFor(exec.agent)
  if (agentId === undefined) throw new WorkspaceTaskToolError('WORKSPACE_TASK_CALLER_UNAVAILABLE')
  if (host.snapshot().agents[agentId]?.employmentStatus !== 'employed') {
    throw new WorkspaceTaskToolError('WORKSPACE_TASK_CALLER_UNAVAILABLE')
  }
  return agentId
}

function disposeDefinitions(disposers: readonly (() => void)[]): void {
  for (const dispose of disposers.toReversed()) dispose()
}

async function runAsActiveActor<Result>(agentId: WorkspaceAgentId, operation: () => Promise<Result>): Promise<Result> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof WorkspaceBusinessError) {
      const callerUnavailable = (error.code === 'agent-missing' || error.code === 'agent-departed')
        && 'agentId' in error.details
        && error.details.agentId === agentId
      throw new WorkspaceTaskToolError(callerUnavailable
        ? 'WORKSPACE_TASK_CALLER_UNAVAILABLE'
        : 'WORKSPACE_TASK_POLICY_DENIED')
    }
    throw error
  }
}

function assertExactArguments(toolName: string, args: object, expected: readonly string[]): void {
  const allowed = new Set(expected)
  const unsupported = Object.keys(args).find(name => !allowed.has(name))
  if (unsupported !== undefined) throw new Error(`${toolName} does not accept argument '${unsupported}'`)
}
