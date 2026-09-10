/** Read-only projection of immutable definition revisions and their provenance. */

import type { AgentDefinitionId, AgentId, DefinitionRevisionId } from './ids.ts'
import type { DefinitionRevision, WorkspaceEvent, WorkspaceState } from './types.ts'

/** How confidently one revision is associated with its creation event. */
export type DefinitionRevisionCreationEvent =
  | { readonly status: 'exact' | 'derived'; readonly sequence: number }
  | { readonly status: 'unresolved' }

/** One immutable definition revision enriched for history display. */
export interface DefinitionHistoryItem extends DefinitionRevision {
  readonly creationEvent: DefinitionRevisionCreationEvent
  readonly status: 'current' | 'previous'
  readonly agentIds: readonly AgentId[]
}

/**
 * Project one definition's immutable revisions in revision-number order.
 * Legacy events are derived only when their full ordered series proves a
 * positional one-to-one association with the definition's revision ids.
 * @param state - Workspace snapshot to project without mutation.
 * @param definitionId - Definition whose revision history is requested.
 * @returns Immutable revision display items in number order.
 */
export function projectDefinitionHistory(
  state: WorkspaceState,
  definitionId: AgentDefinitionId,
): readonly DefinitionHistoryItem[] {
  const definition = state.definitions[definitionId]
  if (definition === undefined) throw new Error(`definition '${definitionId}' does not exist`)
  const revisions = definition.revisionIds
    .map(id => state.definitionRevisions[id])
    .filter((revision): revision is DefinitionRevision => revision !== undefined)
    .toSorted((left, right) => left.number - right.number)
  const events = definitionEvents(state, definitionId)
  const exactByRevision = new Map<DefinitionRevisionId, number>()
  for (const event of events) {
    if (event.definitionRevisionId !== undefined
      && state.definitionRevisions[event.definitionRevisionId]?.definitionId === definitionId) {
      exactByRevision.set(event.definitionRevisionId, event.sequence)
    }
  }
  const canDeriveLegacy = events.length === revisions.length
    && events.every((event, index) => {
      const revision = revisions[index]
      return revision !== undefined
        && (event.definitionRevisionId === undefined || event.definitionRevisionId === revision.id)
    })

  return revisions.map((revision, index) => {
    const exactSequence = exactByRevision.get(revision.id)
    const event = events[index]
    const creationEvent: DefinitionRevisionCreationEvent = exactSequence !== undefined
      ? { status: 'exact', sequence: exactSequence }
      : canDeriveLegacy && event !== undefined && event.definitionRevisionId === undefined
        ? { status: 'derived', sequence: event.sequence }
        : { status: 'unresolved' }
    const agentIds = Object.values(state.agents)
      .filter(agent => agent.definitionRevisionId === revision.id)
      .map(agent => agent.id)
    return {
      ...revision,
      creationEvent,
      status: revision.id === definition.currentRevisionId ? 'current' : 'previous',
      agentIds,
    }
  })
}

function definitionEvents(state: WorkspaceState, definitionId: AgentDefinitionId): WorkspaceEvent[] {
  return state.events.filter(event => (
    (event.type === 'definition/created' || event.type === 'definition/revised')
    && event.subjectId === definitionId
  )).toSorted((left, right) => left.sequence - right.sequence)
}
