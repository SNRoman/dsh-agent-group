/** Pure Browser projections over a Workspace snapshot. */

import type { AgentId, AgentInstanceView, RoomId, WorkspaceEventView, WorkspaceSnapshot } from './contracts.ts'

const MENTION_RE = /<@([^>\s]+)>/g
const DISPLAY_MENTION_BOUNDARY = /[\s,，。.!！？?;；:：、)）\]】}》>"'“”‘’]/u
const ALL_MENTION = '@all'

/** Active employed members of one room in durable membership order. */
export function activeRoomMembers(state: WorkspaceSnapshot, roomId: RoomId): AgentInstanceView[] {
  const seen = new Set<string>()
  const members: AgentInstanceView[] = []
  for (const membership of Object.values(state.memberships)) {
    if (membership.roomId !== roomId || membership.leftEventId !== undefined || seen.has(membership.agentId)) continue
    const agent = state.agents[membership.agentId]
    if (agent === undefined || agent.employmentStatus !== 'employed') continue
    seen.add(agent.id)
    members.push(agent)
  }
  return members
}

/** Canonical room-message events for one selected room in sequence order. */
export function roomMessageEvents(state: WorkspaceSnapshot, roomId: RoomId): WorkspaceEventView[] {
  return state.events
    .filter(event => event.type === 'room/message' && event.subjectId === roomId)
    .sort((left, right) => left.sequence - right.sequence)
}

/** Parse canonical `<@agent-id>` markers in first-seen order. */
export function parseMentionIds(text: string): AgentId[] {
  const ids = new Set<AgentId>()
  for (const match of text.matchAll(MENTION_RE)) {
    const id = match[1]
    if (id !== undefined && id.length > 0) ids.add(id)
  }
  return [...ids]
}

/**
 * Resolve mentions exactly as a human sees them in a room. Canonical markers
 * remain accepted for backwards compatibility. A unique active member may be
 * addressed by instance name (`@老周`) or, when exactly one room member owns
 * that role, by definition name (`@系统架构师`). In group rooms the reserved
 * lowercase `@all` token expands to every active employed member in stable
 * membership order. Ambiguous aliases intentionally do not resolve because
 * silently choosing one colleague would be unsafe.
 */
export function parseRoomMentionIds(state: WorkspaceSnapshot, roomId: RoomId, text: string): AgentId[] {
  const room = state.rooms[roomId]
  if (room === undefined) return []
  const members = activeRoomMembers(state, roomId)
  if (room.kind === 'group' && containsDisplayToken(text, ALL_MENTION)) {
    return members.map(member => member.id)
  }

  const memberIds = new Set(members.map(member => member.id))
  const hits: Array<{ index: number; id: AgentId }> = []

  for (const match of text.matchAll(MENTION_RE)) {
    const rawId = match[1]
    if (rawId === undefined) continue
    const id = rawId as AgentId
    if (memberIds.has(id)) hits.push({ index: match.index, id })
  }

  const aliases = new Map<string, Set<AgentId>>()
  const addAlias = (alias: string | undefined, id: AgentId): void => {
    if (alias === undefined || alias.trim() === '') return
    const owners = aliases.get(alias) ?? new Set<AgentId>()
    owners.add(id)
    aliases.set(alias, owners)
  }
  for (const member of members) {
    addAlias(member.name, member.id)
    addAlias(state.definitions[member.definitionId]?.name, member.id)
  }

  for (const [alias, owners] of aliases) {
    if (owners.size !== 1) continue
    const id = [...owners][0]
    if (id === undefined) continue
    const token = `@${alias}`
    let from = 0
    while (from < text.length) {
      const index = text.indexOf(token, from)
      if (index < 0) break
      const after = text[index + token.length]
      if (after === undefined || DISPLAY_MENTION_BOUNDARY.test(after)) hits.push({ index, id })
      from = index + token.length
    }
  }

  hits.sort((left, right) => left.index - right.index)
  const seen = new Set<AgentId>()
  const ids: AgentId[] = []
  for (const hit of hits) {
    if (seen.has(hit.id)) continue
    seen.add(hit.id)
    ids.push(hit.id)
  }
  return ids
}

/** Append the visible `@name` token used by the composer without leaking ids. */
export function appendDisplayMention(draft: string, name: string): string {
  const token = `@${name}`
  if (containsDisplayToken(draft, token)) return draft
  return `${draft}${draft.trim() === '' ? '' : ' '}${token} `
}

/** Replace durable mention markers with current display names for presentation. */
export function formatMessageText(state: WorkspaceSnapshot, text: string): string {
  return text.replace(MENTION_RE, (_whole, rawId: string) => `@${state.agents[rawId]?.name ?? rawId}`)
}

/** Human-readable room label with a stable fallback for direct rooms. */
export function roomLabel(state: WorkspaceSnapshot, roomId: RoomId): string {
  const room = state.rooms[roomId]
  if (room === undefined) return roomId
  if (room.name !== undefined && room.name.trim() !== '') return room.name
  const names = activeRoomMembers(state, roomId).map(agent => agent.name)
  return names.length > 0 ? names.join('、') : '私聊'
}

/** Resolve a durable actor to display copy without changing the event. */
export function actorLabel(state: WorkspaceSnapshot, actor: WorkspaceEventView['actor']): string {
  if (actor === undefined) return '系统'
  if (actor.type === 'human') return actor.id === 'web-user' ? '我' : actor.id
  return state.agents[actor.id]?.name ?? actor.id
}

function containsDisplayToken(text: string, token: string): boolean {
  let from = 0
  while (from < text.length) {
    const index = text.indexOf(token, from)
    if (index < 0) return false
    const after = text[index + token.length]
    if (after === undefined || DISPLAY_MENTION_BOUNDARY.test(after)) return true
    from = index + token.length
  }
  return false
}
