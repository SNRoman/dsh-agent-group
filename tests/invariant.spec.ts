import { describe, expect, test } from 'vitest'
import { AgentId, ChildRunId, HumanId, WorkspaceId } from '../packages/host/src/ids.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import { grantTaskDelegation, assignHumanTask } from '../packages/host/src/tasks.ts'
import { assertWorkspaceInvariants } from '../packages/host/src/invariant.ts'
import type { WorkspaceState } from '../packages/host/src/types.ts'

function buildState(): WorkspaceState {
  let state = createInitialState(WorkspaceId('local'))
  const def = mutateWorkspace(state, { type: 'definition/create', name: 'Worker', description: 'd', instructions: 'i' })
  state = def.state
  const agent = mutateWorkspace(state, { type: 'agent/create', definitionId: def.definitionId, name: 'Alice' })
  state = agent.state
  const assigned = assignHumanTask(state, { humanId: HumanId('owner'), assigneeAgentId: agent.agentId, title: 'task' })
  return assigned.state
}

describe('assertWorkspaceInvariants', () => {
  test('accepts a valid aggregate', () => {
    expect(() => assertWorkspaceInvariants(buildState())).not.toThrow()
  })

  test('rejects a memory entry referencing a missing event', () => {
    const state = buildState()
    const corrupt = { ...state, memoryEntries: [{ id: state.memoryEntries[0]!.id, agentId: AgentId('x'), eventId: state.memoryEntries[0]!.eventId, acquiredBy: 'task' as const }] }
    expect(() => assertWorkspaceInvariants(corrupt)).toThrow(/missing agent/)
  })

  test('rejects an active grant referencing a non-open root task', () => {
    const state = buildState()
    const task = Object.values(state.tasks)[0]!
    const agent = Object.values(state.agents)[0]!
    const granted = grantTaskDelegation(state, { humanId: HumanId('owner'), granteeAgentId: agent.id, rootTaskId: task.id })
    const corrupt = { ...granted.state, tasks: { ...granted.state.tasks, [task.id]: { ...task, status: 'completed' as const } } }
    expect(() => assertWorkspaceInvariants(corrupt)).toThrow(/non-open root task/)
  })

  test('rejects a child run referencing a missing parent', () => {
    const state = buildState()
    const corrupt: WorkspaceState = {
      ...state,
      childRuns: { run: { id: ChildRunId('run'), parentAgentId: AgentId('ghost'), taskId: Object.values(state.tasks)[0]!.id, status: 'running' } },
    }
    expect(() => assertWorkspaceInvariants(corrupt)).toThrow(/missing parent/)
  })
})
