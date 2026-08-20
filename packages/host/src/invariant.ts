/**
 * Pure workspace aggregate invariant checks. Each violation throws with a
 * message naming the broken owned relationship; the runtime companion and the
 * test suite both call these so a corrupt state fails loudly rather than
 * silently projecting nonsense.
 * @module @dsh-agent-workspace/host/invariant
 */

import type { WorkspaceState } from './types.ts'

/**
 * Assert every owned relationship the aggregate promises:
 * - memory entries reference an existing event and agent;
 * - active delegation grants reference an open root task;
 * - session bindings reference an existing agent;
 * - task assignments reference an existing task and assignee;
 * - child runs reference an existing parent agent and task.
 * @param state - The committed workspace aggregate.
 * @returns nothing; throws on the first violation.
 */
export function assertWorkspaceInvariants(state: WorkspaceState): void {
  for (const entry of state.memoryEntries) {
    if (state.events.every(event => event.id !== entry.eventId)) {
      throw new Error(`memory entry '${entry.id}' references missing event '${entry.eventId}'`)
    }
    if (state.agents[entry.agentId] === undefined) {
      throw new Error(`memory entry '${entry.id}' references missing agent '${entry.agentId}'`)
    }
  }
  for (const grant of Object.values(state.delegationGrants)) {
    if (grant.status !== 'active') continue
    const task = state.tasks[grant.rootTaskId]
    if (task === undefined || task.id !== task.rootTaskId) {
      throw new Error(`active grant '${grant.id}' references missing root task '${grant.rootTaskId}'`)
    }
    if (task.status !== 'open') {
      throw new Error(`active grant '${grant.id}' references non-open root task '${grant.rootTaskId}'`)
    }
  }
  for (const [agentId] of Object.entries(state.sessionBindings)) {
    if (state.agents[agentId as keyof typeof state.agents] === undefined) {
      throw new Error(`session binding references missing agent '${agentId}'`)
    }
  }
  for (const assignment of Object.values(state.taskAssignments)) {
    if (state.tasks[assignment.taskId] === undefined) {
      throw new Error(`task assignment '${assignment.id}' references missing task '${assignment.taskId}'`)
    }
    if (state.agents[assignment.assigneeAgentId] === undefined) {
      throw new Error(`task assignment '${assignment.id}' references missing assignee '${assignment.assigneeAgentId}'`)
    }
  }
  for (const childRun of Object.values(state.childRuns)) {
    if (state.agents[childRun.parentAgentId] === undefined) {
      throw new Error(`child run '${childRun.id}' references missing parent '${childRun.parentAgentId}'`)
    }
    if (state.tasks[childRun.taskId] === undefined) {
      throw new Error(`child run '${childRun.id}' references missing task '${childRun.taskId}'`)
    }
  }
}
