/** Pure task-admission checks that must run before waking an agent. */

import type { AgentId, TaskId } from './ids.ts'
import type { WorkspaceState, WorkspaceTask } from './types.ts'

/** Validate that one employed agent is the assignee of one open task. */
export function assertAssignedTaskRunnable(state: WorkspaceState, agentId: AgentId, taskId: TaskId): WorkspaceTask {
  const agent = state.agents[agentId]
  if (agent === undefined) throw new Error(`agent '${agentId}' does not exist`)
  if (agent.employmentStatus !== 'employed') throw new Error(`agent '${agentId}' is departed and cannot handle tasks`)

  const task = state.tasks[taskId]
  if (task === undefined) throw new Error(`task '${taskId}' does not exist`)
  if (task.status !== 'open') throw new Error(`task '${taskId}' is ${task.status}`)

  const assigned = Object.values(state.taskAssignments).some(assignment => (
    assignment.taskId === taskId && assignment.assigneeAgentId === agentId
  ))
  if (!assigned) throw new Error(`agent '${agentId}' is not assigned task '${taskId}'`)
  return task
}
