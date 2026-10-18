/** Personal source selection and original-text range accounting. */
import type { AgentId, WorkspaceEventId } from './ids.ts'
import type { AgentMemoryEntry, WorkspaceEvent, WorkspaceState } from './types.ts'
import type { MemoryCoverage } from './scene-memory-contract.ts'
import { rankMemoryCandidates } from './memory-retrieval.ts'

/** One event with the exact durable association by which this colleague acquired it. */
export interface PersonalMemorySource {
  readonly entry: AgentMemoryEntry
  readonly event: WorkspaceEvent
}

/** Return personally acquired sources in acquisition order from a filtered immutable snapshot. */
export function personalMemorySources(state: WorkspaceState, agentId: AgentId): readonly PersonalMemorySource[] {
  const events = new Map<WorkspaceEventId, WorkspaceEvent>(state.events.map(event => [event.id, event]))
  return state.memoryEntries.flatMap(entry => {
    if (entry.agentId !== agentId) return []
    const event = events.get(entry.eventId)
    return event === undefined ? [] : [{ entry, event }]
  })
}

/** Whether this generation received every original-text character from this entry. */
export function hasFullOriginalCoverage(source: PersonalMemorySource, generation: number, coverage: readonly MemoryCoverage[]): boolean {
  const length = source.event.text?.length ?? 0
  if (length === 0) return coverage.some(receipt => receipt.entryId === source.entry.id && receipt.contextGeneration === generation && receipt.kind === 'original')
  let end = 0
  const ranges = coverage.filter((receipt): receipt is Extract<MemoryCoverage, { readonly kind: 'original' }> => (
    receipt.entryId === source.entry.id && receipt.contextGeneration === generation && receipt.kind === 'original'
  )).sort((left, right) => left.start - right.start)
  for (const range of ranges) {
    if (range.start > end) return false
    end = Math.max(end, range.end)
    if (end >= length) return true
  }
  return false
}

/** Start of the first original-text gap, independent of summaries or earlier generations. */
export function firstUncoveredOffset(source: PersonalMemorySource, generation: number, coverage: readonly MemoryCoverage[]): number {
  let end = 0
  const ranges = coverage.filter((receipt): receipt is Extract<MemoryCoverage, { readonly kind: 'original' }> => (
    receipt.entryId === source.entry.id && receipt.contextGeneration === generation && receipt.kind === 'original'
  )).sort((left, right) => left.start - right.start)
  for (const range of ranges) {
    if (range.start > end) break
    end = Math.max(end, range.end)
  }
  return Math.min(end, source.event.text?.length ?? 0)
}

/** Rank older eligible sources by query terms, then event recency. */
export function rankMemoryHistory(sources: readonly PersonalMemorySource[], query: string): readonly PersonalMemorySource[] {
  return rankMemoryCandidates(sources, query)
}
