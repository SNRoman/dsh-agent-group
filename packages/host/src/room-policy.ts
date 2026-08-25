/** Pure room access checks shared by the durable service and dispatcher. */

import type { AgentId, RoomId } from './ids.ts'
import type { WorkspaceActor, WorkspaceState } from './types.ts'

/** Assert that an agent is an active member of one room. */
export function assertActiveRoomMember(state: WorkspaceState, roomId: RoomId, agentId: AgentId): void {
  const membership = Object.values(state.memberships).find(candidate => (
    candidate.roomId === roomId
    && candidate.agentId === agentId
    && candidate.leftEventId === undefined
  ))
  if (membership === undefined) {
    throw new Error(`agent '${agentId}' is not an active member of room '${roomId}'`)
  }
}

/**
 * Validate the communication boundary for one room message before any durable
 * event is appended or agent is woken. Humans are external room authors in the
 * MVP; agent authors and every mentioned agent must be active room members.
 */
export function assertRoomMessageAuthorized(
  state: WorkspaceState,
  roomId: RoomId,
  actor: WorkspaceActor,
  mentions: readonly AgentId[],
): void {
  if (state.rooms[roomId] === undefined) throw new Error(`room '${roomId}' does not exist`)

  if (actor.type === 'agent') {
    const agent = state.agents[actor.id]
    if (agent === undefined) throw new Error(`agent '${actor.id}' does not exist`)
    if (agent.employmentStatus !== 'employed') throw new Error(`agent '${actor.id}' is departed and cannot create room events`)
    assertActiveRoomMember(state, roomId, actor.id)
  }

  for (const agentId of mentions) {
    const agent = state.agents[agentId]
    if (agent === undefined) throw new Error(`agent '${agentId}' does not exist`)
    if (agent.employmentStatus !== 'employed') throw new Error(`mentioned agent '${agentId}' is departed`)
    assertActiveRoomMember(state, roomId, agentId)
  }
}
