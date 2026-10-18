/** Personal event recall captured when a formal delivery enters the employee turn lane. */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { AgentId } from './ids.ts'
import { recallAgentEvents } from './memory.ts'
import type { WorkspaceState } from './types.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import type { WorkspaceActivitySource } from './activity-stream.ts'
import type { WorkspaceEventId, WorkspaceId } from './ids.ts'
import type { MemoryFact, MemoryLimits, PreparedSceneMemory } from './scene-memory-contract.ts'
import { prepareSceneMemory } from './scene-memory.ts'
import { readMemoryCoverage } from './memory-session.ts'
import { formatDeliveryClock } from './delivery-clock.ts'

/** Prepare a current turn from its exact durable trigger and logged Session coverage. */
export function prepareDeliveryMemory(state: WorkspaceState, request: {
  readonly session: Session
  readonly agentId: AgentId
  readonly contextGeneration: number
  readonly source: WorkspaceActivitySource
  readonly triggerEventId: WorkspaceEventId
  readonly delivery: UserMessage
  readonly organization: { readonly id: WorkspaceId; readonly name: string }
  readonly facts: readonly MemoryFact[]
  readonly limits: MemoryLimits
  readonly historyContextCharacters?: number
}): PreparedSceneMemory {
  const trigger = state.events.find(event => event.id === request.triggerEventId)
  if (trigger?.actor === undefined) throw new Error('memory trigger has no actor')
  const clock = formatDeliveryClock(new Date(), new Intl.DateTimeFormat().resolvedOptions().timeZone)
  const fullQuery = request.delivery.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  const essentialLength = (query: string): number => JSON.stringify({ organization: request.organization,
    source: request.source, actor: trigger.actor, triggerEventId: trigger.id,
    admissionSequence: state.nextSequence - 1, ...clock, query }).length
  let query = fullQuery
  if (essentialLength(query) > request.limits.sceneCharacters) {
    const marker = 'Preview of full delivery shown above: '
    let low = 0, high = fullQuery.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (essentialLength(marker + fullQuery.slice(0, middle)) <= request.limits.sceneCharacters) low = middle
      else high = middle - 1
    }
    query = marker + fullQuery.slice(0, low)
  }
  const roomId = request.source.kind === 'room' ? request.source.roomId : undefined
  const memberIds = roomId !== undefined
    ? new Set(Object.values(state.memberships).filter(member => member.roomId === roomId && member.leftEventId === undefined).map(member => member.agentId))
    : undefined
  return prepareSceneMemory(state, { agentId: request.agentId, contextGeneration: request.contextGeneration,
    coverage: readMemoryCoverage(request.session, state.workspaceId, request.agentId, request.contextGeneration),
    facts: request.facts, limits: request.limits,
    historyContext: state.events.filter(event => event.sequence < trigger.sequence && event.subjectId === (request.source.kind === 'room' ? request.source.roomId : request.source.taskId)
      && state.memoryEntries.some(entry => entry.agentId === request.agentId && entry.eventId === event.id))
      .map(event => event.text ?? '').join('\n').slice(-(request.historyContextCharacters ?? 0) || Number.POSITIVE_INFINITY),
    scene: { source: request.source, actor: trigger.actor, triggerEventId: trigger.id,
      admissionSequence: state.nextSequence - 1, ...clock, query, organization: request.organization,
      work: Object.values(state.taskAssignments).filter(assignment => assignment.assigneeAgentId === request.agentId)
        .toReversed().flatMap(assignment => {
          const task = state.tasks[assignment.taskId]
          return task === undefined ? [] : [{ taskId: task.id, title: task.title, status: task.status }]
        }),
      colleagues: Object.values(state.agents).filter(agent => agent.employmentStatus === 'employed' && (memberIds === undefined || memberIds.has(agent.id))).map(agent => ({
        id: agent.id, name: agent.name, ...(state.definitions[agent.definitionId] === undefined ? {} : { role: state.definitions[agent.definitionId]!.name }),
      })) },
  })
}

/**
 * Create a bounded, model-visible personal-memory message for a new delivery.
 * @param state - Committed organization snapshot at admission.
 * @param agentId - Employee whose acquired events may be recalled.
 * @param delivery - Incoming message supplying the search text.
 * @param characterBudget - Maximum rendered memory characters.
 * @returns A durable recall message, or undefined when no event fits.
 */
export function createDeliveryMemory(
  state: WorkspaceState, agentId: AgentId, delivery: UserMessage, characterBudget: number,
): UserMessage | undefined {
  const query = delivery.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  const recall = recallAgentEvents(state, { agentId, query, characterBudget })
  if (recall.rendered === '') return undefined
  return createUserMessage({ content: [{ type: 'text', text: recall.rendered }], source: { kind: 'agent-workspace-recall', eventIds: recall.entries.map(entry => entry.eventId) } })
}
