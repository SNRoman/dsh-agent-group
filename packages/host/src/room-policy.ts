/** Pure room access checks shared by the durable service and dispatcher. */

import { WorkspaceBusinessError } from './errors.ts'
import type { AgentId, RoomId } from './ids.ts'
import type { WorkspaceActor, WorkspaceState } from './types.ts'

const RESERVED_DIRECT_ROUTING_TOKEN = /(?<![\p{L}\p{M}\p{N}\p{Pc}])@all(?![\p{L}\p{M}\p{N}\p{Pc}])/u

/** Reject the group-only lowercase routing token in direct-room text. */
export function assertDirectRoomTextAllowed(roomId: RoomId, text: string): void {
  if (RESERVED_DIRECT_ROUTING_TOKEN.test(text)) {
    throw new WorkspaceBusinessError('reserved-direct-routing', { roomId, token: '@all' })
  }
}

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
 * Resolve the Host-authoritative wake set for one human room post.
 *
 * Group rooms preserve explicit Browser routing: only supplied active employed
 * members wake. Direct rooms derive their sole target from durable membership,
 * so a private chat never depends on a synthetic `@agent` token from the UI.
 */
export function resolveHumanWakeTargets(
  state: WorkspaceState,
  roomId: RoomId,
  mentions: readonly AgentId[],
): AgentId[] {
  const room = state.rooms[roomId]
  if (room === undefined) throw new Error(`room '${roomId}' does not exist`)

  if (room.kind === 'direct') {
    const memberships = Object.values(state.memberships).filter(membership => membership.roomId === roomId)
    const active = memberships
      .filter(membership => membership.leftEventId === undefined)
      .map(membership => state.agents[membership.agentId])
      .filter(agent => agent !== undefined && agent.employmentStatus === 'employed')
    if (active.length !== 1) {
      const departed = memberships
        .map(membership => state.agents[membership.agentId])
        .find(agent => agent?.employmentStatus === 'departed')
      if (departed !== undefined) {
        throw new WorkspaceBusinessError(
          'agent-departed',
          { agentId: departed.id },
          `direct room '${roomId}' must have exactly one active employed member`,
        )
      }
      throw new Error(`direct room '${roomId}' must have exactly one active employed member`)
    }
    const target = active[0]!
    for (const mention of mentions) {
      if (mention !== target.id) {
        throw new Error(`direct room '${roomId}' cannot route to agent '${mention}'`)
      }
    }
    return [target.id]
  }

  const resolved: AgentId[] = []
  const seen = new Set<AgentId>()
  for (const agentId of mentions) {
    const agent = state.agents[agentId]
    if (agent === undefined) {
      throw new WorkspaceBusinessError('agent-missing', { agentId }, `mentioned agent '${agentId}' does not exist`)
    }
    if (agent.employmentStatus !== 'employed') {
      throw new WorkspaceBusinessError('agent-departed', { agentId }, `mentioned agent '${agentId}' is departed`)
    }
    assertActiveRoomMember(state, roomId, agentId)
    if (!seen.has(agentId)) {
      seen.add(agentId)
      resolved.push(agentId)
    }
  }
  return resolved
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
    if (agent === undefined) {
      throw new WorkspaceBusinessError('agent-missing', { agentId: actor.id }, `agent '${actor.id}' does not exist`)
    }
    if (agent.employmentStatus !== 'employed') {
      throw new WorkspaceBusinessError('agent-departed', { agentId: actor.id }, `agent '${actor.id}' is departed and cannot create room events`)
    }
    assertActiveRoomMember(state, roomId, actor.id)
  }

  for (const agentId of mentions) {
    const agent = state.agents[agentId]
    if (agent === undefined) {
      throw new WorkspaceBusinessError('agent-missing', { agentId }, `agent '${agentId}' does not exist`)
    }
    if (agent.employmentStatus !== 'employed') {
      throw new WorkspaceBusinessError('agent-departed', { agentId }, `mentioned agent '${agentId}' is departed`)
    }
    assertActiveRoomMember(state, roomId, agentId)
  }
}
