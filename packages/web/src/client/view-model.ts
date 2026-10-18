/** Pure Browser projections over a Workspace snapshot. */

import type { AgentId, AgentInstanceView, RoomId, WorkspaceEventView, WorkspaceSnapshot } from './contracts.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { fromMarkdown } from 'mdast-util-from-markdown'

const MENTION_RE = /<@([^>\s]+)>/g
const DISPLAY_MENTION_BOUNDARY = /[\s,，。.!！？?;；:：、)）\]】}》>"'“”‘’]/u
const ALL_MENTION = '@all'

/** One admitted mention in authored text, excluding code, links and email addresses. */
export interface RoomMessageMentionSpan { readonly start: number; readonly end: number; readonly agentId: AgentId; readonly label: string }

interface MarkdownNode {
  readonly type: string
  readonly position?: { readonly start: { readonly offset?: number | undefined }; readonly end: { readonly offset?: number | undefined } } | undefined
  readonly children?: readonly MarkdownNode[] | undefined
}

/** @param state Current display identities. @param text Original authored Markdown. @param mentionedIds Persisted recipient identities. @param resolveDisplayNames Resolve current aliases only while composing a new message. @returns Nonoverlapping source spans; historical aliases without positional identity remain plain text. */
export function roomMessageMentionSpans(state: WorkspaceSnapshot, text: string, mentionedIds: readonly AgentId[], resolveDisplayNames = false): RoomMessageMentionSpan[] {
  const vocabulary = new Map<string, Set<AgentId>>()
  const add = (token: string, id: AgentId): void => {
    const owners = vocabulary.get(token) ?? new Set<AgentId>()
    owners.add(id)
    vocabulary.set(token, owners)
  }
  for (const id of mentionedIds) {
    const agent = state.agents[id]
    if (agent === undefined) continue
    add(`<@${id}>`, id)
    if (resolveDisplayNames) add(`@${agent.name}`, id)
    const role = state.definitions[agent.definitionId]?.name
    if (resolveDisplayNames && role !== undefined) add(`@${role}`, id)
  }
  const spans: RoomMessageMentionSpan[] = []
  for (const { start, end } of markdownTextRanges(text)) {
    for (const [token, owners] of vocabulary) {
      if (owners.size !== 1) continue
      const agentId = [...owners][0]!
      let index = text.indexOf(token, start)
      while (index >= start && index + token.length <= end) {
        const before = text[index - 1]
        const after = text[index + token.length]
        if (token.startsWith('<@') || ((before === undefined || !/[A-Za-z0-9_@./\\-]/u.test(before)) && (after === undefined || DISPLAY_MENTION_BOUNDARY.test(after)))) {
          spans.push({ start: index, end: index + token.length, agentId, label: `@${state.agents[agentId]!.name}` })
        }
        index = text.indexOf(token, index + token.length)
      }
    }
  }
  const admitted: RoomMessageMentionSpan[] = []
  for (const span of spans.sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (span.start >= (admitted.at(-1)?.end ?? 0)) admitted.push(span)
  }
  return admitted
}

/** @param state Current identities. @param text Composer text. @param mentionedIds Resolved recipients. @returns Authored text with stable identity markers only for recognized mentions. */
export function canonicalRoomMessageText(state: WorkspaceSnapshot, text: string, mentionedIds: readonly AgentId[]): string {
  let canonical = text
  for (const span of roomMessageMentionSpans(state, text, mentionedIds, true).reverse()) canonical = `${canonical.slice(0, span.start)}<@${span.agentId}>${canonical.slice(span.end)}`
  return canonical
}

/** @param state Current identities. @param text Original Markdown. @param mentionedIds Persisted recipients. @returns Markdown with allowlisted reserved profile targets, intercepted by its message owner without network navigation. */
export function linkRoomMessageMentions(state: WorkspaceSnapshot, text: string, mentionedIds: readonly AgentId[]): string {
  let linked = text
  for (const span of roomMessageMentionSpans(state, text, mentionedIds).reverse()) {
    const label = span.label.replace(/[\\`*_{}[\]()!<>]/g, '\\$&')
    linked = `${linked.slice(0, span.start)}[${label}](https://dsh-agent-group.invalid/people/${encodeURIComponent(span.agentId)})${linked.slice(span.end)}`
  }
  return linked
}

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

/** Stable direct room whose sole active membership belongs to one agent. */
export function directRoomForAgent(state: WorkspaceSnapshot, agentId: AgentId): RoomId | undefined {
  for (const room of Object.values(state.rooms)) {
    if (room.kind !== 'direct') continue
    const active = Object.values(state.memberships)
      .filter(membership => membership.roomId === room.id && membership.leftEventId === undefined)
    if (active.length === 1 && active[0]?.agentId === agentId) return room.id
  }
  return undefined
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

  return [...new Set(roomMessageMentionSpans(state, text, members.map(member => member.id), true).map(span => span.agentId))]
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
export function roomLabel(state: WorkspaceSnapshot, roomId: RoomId, t: TranslateNS<'agentWorkspace'>): string {
  const room = state.rooms[roomId]
  if (room === undefined) return roomId
  if (room.name !== undefined && room.name.trim() !== '') return room.name
  const names = activeRoomMembers(state, roomId).map(agent => agent.name)
  return names.length > 0 ? names.join('、') : t('room.direct')
}

/** Resolve a durable actor to display copy without changing the event. */
export function actorLabel(state: WorkspaceSnapshot, actor: WorkspaceEventView['actor'], t: TranslateNS<'agentWorkspace'>): string {
  if (actor === undefined) return t('actor.system')
  if (actor.type === 'human') return actor.id === 'web-user' ? t('actor.me') : actor.id
  return state.agents[actor.id]?.name ?? actor.id
}

function containsDisplayToken(text: string, token: string): boolean {
  for (const { start, end } of markdownTextRanges(text)) {
    let index = text.indexOf(token, start)
    while (index >= start && index + token.length <= end) {
      const before = text[index - 1]
      const after = text[index + token.length]
      if ((before === undefined || !/[A-Za-z0-9_@./\\-]/u.test(before)) && (after === undefined || DISPLAY_MENTION_BOUNDARY.test(after))) return true
      index = text.indexOf(token, index + token.length)
    }
  }
  return false
}

function markdownTextRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  const nodes: MarkdownNode[] = [fromMarkdown(text)]
  while (nodes.length > 0) {
    const node = nodes.pop()!
    if (['link', 'linkReference', 'image', 'imageReference', 'code', 'inlineCode', 'html'].includes(node.type)) continue
    if (node.children !== undefined) nodes.push(...node.children)
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (node.type === 'text' && start !== undefined && end !== undefined) ranges.push({ start, end })
  }
  return ranges
}
