/** Exact stop control for live top-level Workspace turns. */

import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { AgentId } from './ids.ts'
import type { WorkspaceActivityIdentity, WorkspaceActivityStream } from './activity-stream.ts'

/** Stable outcome of an exact stop request. */
export interface WorkspaceStopResult {
  readonly status: 'stopping' | 'already-stopping' | 'not-active'
}

/** Live employee handles addressable by durable Workspace agent id. */
export interface WorkspaceActivityHandleSource {
  /**
   * Return the resident or setup-committed employee for exact control.
   * @param agentId - Durable Workspace employee identity.
   * @returns The active generation's agent-only control, or `undefined` before admission or after revocation.
   */
  handleFor(agentId: AgentId): Pick<AgentHandle, 'agent'> | undefined
}

/** Stops only the claimed activity and employee handle named by all identity fields. */
export class WorkspaceActivityController {
  constructor(
    private readonly stream: WorkspaceActivityStream,
    private readonly handles: WorkspaceActivityHandleSource,
  ) {}

  /**
   * Validate and stop one exact active turn without disturbing queued inbox work.
   * @param identity - Complete claimed activity identity supplied by the caller.
   * @returns Whether this call started stopping, repeated it, or found no exact activity.
   */
  stopActivity(identity: WorkspaceActivityIdentity): WorkspaceStopResult {
    const activity = this.stream.snapshot().activities.find(candidate => candidate.activityId === identity.activityId)
    if (activity === undefined
      || activity.agentId !== identity.agentId
      || activity.messageId !== identity.messageId
      || activity.claimed?.sessionId !== identity.sessionId
      || activity.claimed.turn !== identity.turn
      || activity.status === 'queued'
      || activity.status === 'settled') {
      return { status: 'not-active' }
    }
    const handle = this.handles.handleFor(identity.agentId)
    if (handle === undefined || handle.agent.id !== identity.sessionId) return { status: 'not-active' }
    if (activity.status === 'stopping') return { status: 'already-stopping' }

    this.stream.markStopping(identity)
    handle.agent.cancel({ kind: 'user' }, { keepInbox: true })
    return { status: 'stopping' }
  }
}
