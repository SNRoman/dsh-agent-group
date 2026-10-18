/** Restore personal-memory coverage from the current Session message surface. */
import type { Session } from '@deepseek-ai/dsh-session'
import type { AgentId, WorkspaceId } from './ids.ts'
import type { MemoryCoverage } from './scene-memory-contract.ts'
import type { MemorySourceReceipt } from './communication-contract.ts'

/** Read only receipts that actually reached a logged user message in this organization and generation. */
export function readMemoryCoverage(session: Session, workspaceId: WorkspaceId, agentId: AgentId, generation: number): MemoryCoverage[] {
  const result: MemoryCoverage[] = []
  for (const message of session.deriveMessages()) {
    if (message.role !== 'user' || message.source.kind !== 'agent-workspace-context') continue
    const receipt = message.source.memoryReceipt
    if (!isMemorySourceReceipt(receipt, workspaceId, agentId, generation)) continue
    result.push(...receipt.coverage)
  }
  return result
}

/** Validate durable or dispatched receipt data before selecting original text ranges. */
export function isMemorySourceReceipt(receipt: MemorySourceReceipt | undefined, workspaceId: WorkspaceId, agentId: AgentId, generation: number): receipt is MemorySourceReceipt {
  if (receipt === undefined || receipt === null || typeof receipt !== 'object' || receipt.version !== 1 || receipt.workspaceId !== workspaceId
    || receipt.agentId !== agentId || receipt.contextGeneration !== generation || !Array.isArray(receipt.coverage)) return false
  return receipt.coverage.every(item => item !== null && typeof item === 'object'
    && item.contextGeneration === generation && typeof item.entryId === 'string'
    && (item.kind === 'original'
      ? Number.isSafeInteger(item.start) && item.start >= 0 && Number.isSafeInteger(item.end) && item.end >= item.start
      : item.kind === 'summary' && typeof item.category === 'string'))
}
