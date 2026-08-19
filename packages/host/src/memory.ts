/** Pure room-event memory projection and recall selection. */

import type { AgentId, WorkspaceEventId } from './ids.ts'
import { appendMemoryEntries, mutateWorkspace } from './state.ts'
import type {
  AgentEventRecall,
  AgentMemoryAcquisition,
  AgentMemoryEntry,
  JoinRoomCommand,
  RecalledAgentEvent,
  RecallAgentEventsRequest,
  RoomMessageCommand,
  WorkspaceEvent,
  WorkspaceState,
} from './types.ts'

/** Result of recording a room message and delivering it into member memory. */
export interface AppendRoomMessageResult {
  readonly state: WorkspaceState
  readonly eventId: WorkspaceEventId
  readonly wakeAgentIds: readonly AgentId[]
}

/** The caller-supplied fields of a room message before its canonical event type is assigned. */
export type AppendRoomMessageCommand = Omit<RoomMessageCommand, 'type'>

/** Append one canonical room event and associate it with every active member. */
export function appendRoomMessage(state: WorkspaceState, command: AppendRoomMessageCommand): AppendRoomMessageResult {
  const appended = mutateWorkspace(state, { type: 'room/message', ...command })
  const acquisitions: AgentMemoryAcquisition[] = activeMemberIds(state, command.roomId).map(agentId => ({
    agentId,
    eventId: appended.eventId,
    acquiredBy: 'room-membership',
  }))
  return {
    state: appendMemoryEntries(appended.state, acquisitions),
    eventId: appended.eventId,
    wakeAgentIds: uniqueAgentIds(command.mentions),
  }
}

/** Join one room and, when selected, associate its inclusive historical range with the joining agent. */
export function joinRoomWithMemory(state: WorkspaceState, command: JoinRoomCommand): { readonly state: WorkspaceState } {
  const joined = mutateWorkspace(state, command)
  const memoryStart = command.memoryStart
  if (memoryStart.type === 'new-events') return joined
  const acquisitions: AgentMemoryAcquisition[] = state.events
    .filter(event => event.subjectId === command.roomId
      && event.sequence >= memoryStart.startSequence
      && event.sequence <= memoryStart.endSequence)
    .map(event => ({ agentId: command.agentId, eventId: event.id, acquiredBy: 'history-sync' }))
  return { state: appendMemoryEntries(joined.state, acquisitions) }
}

/** Select deterministic room and personal memory entries within a character budget. */
export function recallAgentEvents(state: WorkspaceState, request: RecallAgentEventsRequest): AgentEventRecall {
  if (request.characterBudget < 0) throw new Error('recall character budget must not be negative')
  const entryByEventId = rememberedEntries(state, request.agentId)
  const candidates = [...entryByEventId.entries()]
    .map(([eventId, entry]) => {
      const event = state.events.find(candidate => candidate.id === eventId)
      return event === undefined ? undefined : { event, entry }
    })
    .filter((candidate): candidate is { readonly event: WorkspaceEvent; readonly entry: AgentMemoryEntry } => candidate !== undefined)
  const currentRoom = candidates.filter(candidate => candidate.event.subjectId === request.roomId).sort(compareRecent)
  const other = candidates.filter(candidate => candidate.event.subjectId !== request.roomId).sort(compareRecent)
  const query = request.query.trim().toLocaleLowerCase('en-US')
  const lexicalMatches = other.filter(candidate => matchesLexically(candidate.event, query))
  const matchingIds = new Set(lexicalMatches.map(candidate => candidate.event.id))
  const remaining = other.filter(candidate => !matchingIds.has(candidate.event.id))
  return fitRecall([...currentRoom, ...lexicalMatches, ...remaining], request.characterBudget)
}

/** Read personal memory from one immutable workspace-state snapshot. */
export class MemoryReader {
  /** Create a reader for the supplied immutable workspace state. */
  constructor(private readonly state: WorkspaceState) {}

  /** Select events for one awakened agent. */
  recall(request: RecallAgentEventsRequest): AgentEventRecall {
    return recallAgentEvents(this.state, request)
  }
}

function activeMemberIds(state: WorkspaceState, roomId: JoinRoomCommand['roomId']): readonly AgentId[] {
  return Object.values(state.memberships)
    .filter(membership => membership.roomId === roomId && membership.leftEventId === undefined)
    .map(membership => membership.agentId)
}

function uniqueAgentIds(agentIds: readonly AgentId[]): readonly AgentId[] {
  return agentIds.filter((agentId, index) => agentIds.indexOf(agentId) === index)
}

function rememberedEntries(state: WorkspaceState, agentId: AgentId): ReadonlyMap<WorkspaceEventId, AgentMemoryEntry> {
  const entries = new Map<WorkspaceEventId, AgentMemoryEntry>()
  for (const entry of state.memoryEntries) {
    if (entry.agentId === agentId && !entries.has(entry.eventId)) entries.set(entry.eventId, entry)
  }
  return entries
}

function matchesLexically(event: WorkspaceEvent, query: string): boolean {
  if (query === '') return false
  return `${event.type} ${event.text ?? ''}`.toLocaleLowerCase('en-US').includes(query)
}

function compareRecent(
  left: { readonly event: WorkspaceEvent },
  right: { readonly event: WorkspaceEvent },
): number {
  return right.event.sequence - left.event.sequence || left.event.id.localeCompare(right.event.id)
}

function fitRecall(
  candidates: readonly { readonly event: WorkspaceEvent; readonly entry: AgentMemoryEntry }[],
  characterBudget: number,
): AgentEventRecall {
  const entries: RecalledAgentEvent[] = []
  let renderedLength = 0
  for (const candidate of candidates) {
    const rendered = renderEvent(candidate.event, candidate.entry)
    const separatorLength = entries.length === 0 ? 0 : 1
    if (renderedLength + separatorLength + rendered.length > characterBudget) break
    entries.push({ eventId: candidate.event.id, provenance: candidate.entry.acquiredBy, rendered })
    renderedLength += separatorLength + rendered.length
  }
  return {
    eventIds: entries.map(entry => entry.eventId),
    entries,
    rendered: entries.map(entry => entry.rendered).join('\n'),
  }
}

function renderEvent(event: WorkspaceEvent, entry: AgentMemoryEntry): string {
  return `[event:${event.id} sequence:${event.sequence} acquired:${entry.acquiredBy} type:${event.type}] ${event.text ?? ''}`
}
