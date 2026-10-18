/** Pure room-event memory projection and recall selection. */

import type { AgentId, WorkspaceEventId } from './ids.ts'
import { queryAgentMemory } from './memory-query.ts'
import { memoryQueryTerms, rankMemoryCandidateScores } from './memory-retrieval.ts'
import { personalMemorySources } from './scene-memory-retrieval.ts'
import type { MemoryPage, MemoryQuery } from './memory-query.ts'
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
  return {
    state: appended.state,
    eventId: appended.eventId,
    wakeAgentIds: uniqueAgentIds(command.mentions),
  }
}

/** Join one room and, when selected, associate its inclusive historical range with the joining agent. */
export function joinRoomWithMemory(state: WorkspaceState, command: JoinRoomCommand): { readonly state: WorkspaceState } {
  const joined = mutateWorkspace(state, command)
  const memoryStart = command.memoryStart
  if (memoryStart.type === 'new-events') return joined
  const rememberedEventIds = new Set(state.memoryEntries
    .filter(entry => entry.agentId === command.agentId)
    .map(entry => entry.eventId))
  const acquisitions: AgentMemoryAcquisition[] = state.events
    .filter(event => {
      if (event.subjectId !== command.roomId
        || event.sequence < memoryStart.startSequence
        || event.sequence > memoryStart.endSequence
        || rememberedEventIds.has(event.id)) return false
      rememberedEventIds.add(event.id)
      return true
    })
    .map(event => ({ agentId: command.agentId, eventId: event.id, acquiredBy: 'history-sync' }))
  return { state: appendMemoryEntries(joined.state, acquisitions) }
}

/** Select acquired personal events by keyword relevance, then recency, within a character budget. */
export function recallAgentEvents(state: WorkspaceState, request: RecallAgentEventsRequest): AgentEventRecall {
  if (request.characterBudget < 0) throw new Error('recall character budget must not be negative')
  const keywords = memoryQueryTerms(request.query)
  const firstByEvent = new Map<WorkspaceEventId, ReturnType<typeof personalMemorySources>[number]>()
  for (const source of personalMemorySources(state, request.agentId)) if (!firstByEvent.has(source.event.id)) firstByEvent.set(source.event.id, source)
  const candidates = rankMemoryCandidateScores([...firstByEvent.values()], request.query)
    .filter(candidate => !request.matchingOnly || candidate.relevance > 0)
  return fitRecall(candidates, keywords, request)
}

/** Read personal memory from one immutable workspace-state snapshot. */
export class MemoryReader {
  /** Create a reader for the supplied immutable workspace state. */
  constructor(private readonly state: WorkspaceState) {}

  /** Select events for one awakened agent. */
  recall(request: RecallAgentEventsRequest): AgentEventRecall {
    return recallAgentEvents(this.state, request)
  }

  /**
   * Inspect one employed or departed agent's durable memory at this snapshot revision.
   * @param request Filters, page limit, cursor, and required snapshot revision.
   * @returns A detached newest-first page from the reader's immutable snapshot.
   */
  query(request: MemoryQuery): MemoryPage {
    return queryAgentMemory(this.state, request)
  }
}

function uniqueAgentIds(agentIds: readonly AgentId[]): readonly AgentId[] {
  return agentIds.filter((agentId, index) => agentIds.indexOf(agentId) === index)
}

interface RecallCandidate {
  readonly event: WorkspaceEvent
  readonly entry: AgentMemoryEntry
  readonly relevance: number
}

function fitRecall(
  candidates: readonly RecallCandidate[],
  keywords: readonly string[],
  request: RecallAgentEventsRequest,
): AgentEventRecall {
  const entries: RecalledAgentEvent[] = []
  let renderedLength = 0
  for (const candidate of candidates) {
    if (entries.length >= (request.resultLimit ?? Number.POSITIVE_INFINITY)) break
    const separatorLength = entries.length === 0 ? 0 : 1
    const remainingBudget = request.characterBudget - renderedLength - separatorLength
    const rendered = renderWithinBudget(candidate, keywords, remainingBudget)
    if (rendered === undefined) continue
    entries.push({ eventId: candidate.event.id, provenance: candidate.entry.acquiredBy, rendered })
    renderedLength += separatorLength + rendered.length
  }
  return {
    eventIds: entries.map(entry => entry.eventId),
    entries,
    rendered: entries.map(entry => entry.rendered).join('\n'),
    ...(request.matchingOnly ? { hasMore: entries.length < candidates.length } : {}),
  }
}

function renderWithinBudget(candidate: RecallCandidate, keywords: readonly string[], budget: number): string | undefined {
  const rendered = renderEvent(candidate.event, candidate.entry)
  if (rendered.length <= budget) return rendered
  if (candidate.relevance === 0) return undefined
  const header = `${renderEvent({ ...candidate.event, text: '' }, candidate.entry)}[truncated] `
  const excerptBudget = budget - header.length
  const text = candidate.event.text ?? ''
  const lowerText = text.toLocaleLowerCase('en-US')
  const offsets = keywords.map(keyword => lowerText.indexOf(keyword)).filter(offset => offset >= 0)
  if (excerptBudget <= 0 || offsets.length === 0) return undefined
  const firstMatch = Math.min(...offsets)
  const start = Math.max(0, Math.min(firstMatch - Math.floor(excerptBudget / 4), text.length - excerptBudget))
  return `${header}${text.slice(start, start + excerptBudget)}`
}

function renderEvent(event: WorkspaceEvent, entry: AgentMemoryEntry): string {
  const childRunStatus = event.type === 'child/run-finished' ? ` child-status:${event.childRunStatus}` : ''
  return `[event:${event.id} sequence:${event.sequence} acquired:${entry.acquiredBy} type:${event.type}${childRunStatus}] ${event.text ?? ''}`
}
