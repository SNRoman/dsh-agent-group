/** Personal event recall captured when a formal delivery enters the employee turn lane. */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { AgentId } from './ids.ts'
import { recallAgentEvents } from './memory.ts'
import type { WorkspaceState } from './types.ts'

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
  return createUserMessage({ content: [{ type: 'text', text: recall.rendered }], source: { kind: 'agent-workspace-recall' } })
}
