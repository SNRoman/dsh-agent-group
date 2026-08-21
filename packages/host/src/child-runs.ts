/** Child-run terminalization that remains valid after the parent departs. */

import { appendMemoryEntries, appendWorkspaceEvent, beginWorkspaceMutation } from './state.ts'
import type { ChildRunId } from './ids.ts'
import type { ChildRun, WorkspaceEvent, WorkspaceState } from './types.ts'

export interface FinishChildRunRequest {
  readonly childRunId: ChildRunId
  readonly status: Exclude<ChildRun['status'], 'running'>
  readonly result: string
}

/**
 * Record one terminal child outcome exactly once. Employment is checked when
 * the run starts; a later parent departure must not prevent an already-running
 * child from reaching a durable terminal state.
 */
export function finishChildRun(state: WorkspaceState, request: FinishChildRunRequest): { readonly state: WorkspaceState } {
  const childRun = state.childRuns[request.childRunId]
  if (childRun === undefined) throw new Error(`child run '${request.childRunId}' does not exist`)
  if (childRun.status !== 'running') throw new Error(`child run '${request.childRunId}' is already terminal`)
  if (state.agents[childRun.parentAgentId] === undefined) throw new Error(`child run '${childRun.id}' references missing parent '${childRun.parentAgentId}'`)
  if (request.result.trim() === '') throw new Error('child run result must not be empty')

  let changed = beginWorkspaceMutation(state)
  let event: WorkspaceEvent
  ;[changed, event] = appendWorkspaceEvent(changed, 'child/run-finished', childRun.id, {
    childRunStatus: request.status,
    text: request.result,
  })
  changed = {
    ...changed,
    childRuns: {
      ...changed.childRuns,
      [childRun.id]: { ...childRun, status: request.status, result: request.result },
    },
  }
  changed = appendMemoryEntries(changed, [{ agentId: childRun.parentAgentId, eventId: event.id, acquiredBy: 'child-result' }])
  return { state: changed }
}
