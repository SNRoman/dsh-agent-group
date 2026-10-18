/** Native DSH auxiliary calls and exact fragments from dispatched model messages. */
import { AssistantStreamAccumulator, BlockAssembler, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import type { AgentId } from './ids.ts'
import type { MemoryFragment } from './memory-projection.ts'
import { MEMORY_EXTRACTION_SYSTEM } from './memory-projection.ts'
import type { MemoryExtractionRequest, MemoryExtractionResult, MemoryRoute } from './memory-processor.ts'
import type { WorkspaceState } from './types.ts'
import { isMemorySourceReceipt } from './memory-session.ts'

/** Auxiliary identity for observers and scripted adapters; never a GenerateOptions purpose. */
export { MEMORY_EXTRACTION_SYSTEM } from './memory-projection.ts'

/** Resolve the auxiliary effort on the exact employee route before its audit is written.
 * @param llm Native model runtime that owns exact-route metadata.
 * @param route Employee provider and model, unchanged by this selection.
 * @param selection `auto` or one exact advertised effort ID.
 * @param maxTokens Independent auxiliary output cap.
 * @param signal Processing generation cancellation.
 * @returns Serialized dispatch parameters, including a known default when effort is omitted.
 */
export async function resolveMemoryExtractionParameters(llm: LlmRuntime, route: MemoryRoute, selection: string, maxTokens: number, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const info = await llm.resolveModelInfo(route.provider, route.model, signal)
  signal.throwIfAborted()
  const efforts = info.reasoning?.efforts
  if (selection === 'auto') {
    const off = efforts?.find(effort => effort.id === 'off')?.id
    if (off !== undefined) return JSON.stringify({ maxTokens, reasoningEffort: off })
    const effective = info.reasoning?.defaultEffort
    return JSON.stringify({ maxTokens, ...(effective === undefined ? {} : { effectiveReasoningEffort: effective }) })
  }
  if (efforts?.some(effort => effort.id === selection) !== true) {
    throw new Error(`Provider "${route.provider}" model "${route.model}" does not support reasoning effort "${selection}"`)
  }
  return JSON.stringify({ maxTokens, reasoningEffort: selection })
}

/** Retain timed native chunks and partial output on provider error, timeout or cancellation. */
export async function extractMemoryWithModel(llm: LlmRuntime, request: MemoryExtractionRequest, timeoutMs: number): Promise<MemoryExtractionResult> {
  const parameters = z.object({ maxTokens: z.number().int().positive(), reasoningEffort: z.string().transform(ReasoningEffortId).optional(),
    effectiveReasoningEffort: z.string().transform(ReasoningEffortId).optional() }).strict().parse(JSON.parse(request.parameters ?? '{}'))
  const abort = new AbortController()
  const signal = AbortSignal.any([request.signal, abort.signal])
  const stream = new AssistantStreamAccumulator(), assembler = new BlockAssembler()
  let error: string | undefined
  const timer = setTimeout(() => abort.abort(new Error('Memory extraction timed out')), timeoutMs)
  const finished = Promise.withResolvers<void>()
  const onAbort = (): void => { error = signal.reason instanceof Error ? signal.reason.message : 'Memory extraction aborted'; finished.resolve() }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  const consume = async (): Promise<void> => {
    try {
      for await (const chunk of llm.stream({ provider: request.provider, model: request.model,
        maxTokens: parameters.maxTokens, ...(parameters.reasoningEffort === undefined ? {} : { reasoningEffort: parameters.reasoningEffort }),
        system: MEMORY_EXTRACTION_SYSTEM, messages: [{ role: 'user', content: [{ type: 'text', text: request.prompt }] }], signal })) {
        if (signal.aborted) break
        assembler.push(stream.push({ time: Date.now(), chunk }).chunk)
        if (chunk.type === 'finish' && chunk.reason.kind !== 'stop') error = `Memory extraction finish: ${chunk.reason.kind}`
      }
      if (assembler.finish === undefined) error ??= 'Memory extraction ended without finish'
    } catch (cause) { error = cause instanceof Error ? cause.message : String(cause) }
    finally { finished.resolve() }
  }
  void consume()
  await finished.promise
  clearTimeout(timer)
  signal.removeEventListener('abort', onAbort)
  const text = assembler.interruptedBlocks().flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  return { text, stream: JSON.stringify(stream.snapshot()), ...(error === undefined ? {} : { error }) }
}

/** Only text appearing in the actual request can be sent to the auxiliary extractor. */
export function requestMemoryFragments(state: WorkspaceState, agentId: AgentId, generation: number, request: GenerateOptions, fragmentCharacters: number): MemoryFragment[] {
  if (request.system === MEMORY_EXTRACTION_SYSTEM || request.purpose !== undefined) return []
  const entries = new Map(state.memoryEntries.filter(entry => entry.agentId === agentId).map(entry => [entry.id, entry]))
  const owned = new Set([...entries.values()].map(entry => entry.eventId))
  const events = new Map(state.events.map(event => [event.id, event]))
  const result = new Map<string, MemoryFragment>()
  for (const message of request.messages) {
    if (message.role !== 'user' || !('source' in message) || message.source === undefined) continue
    const body = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    const add = (eventId: WorkspaceState['events'][number]['id'], start: number, end: number): void => {
      const event = events.get(eventId)
      if (!owned.has(eventId) || event?.text === undefined || start < 0 || end > event.text.length || start >= end) return
      const text = event.text.slice(start, end)
      if (!body.includes(text)) return
      for (let offset = start; offset < end; offset += fragmentCharacters) {
        const fragmentEnd = Math.min(end, offset + fragmentCharacters)
        result.set(`${eventId}:${offset}:${fragmentEnd}`, { workspaceId: state.workspaceId, event, start: offset, end: fragmentEnd, text: event.text.slice(offset, fragmentEnd) })
      }
    }
    if (message.source.kind === 'agent-workspace-context') {
      const receipt = message.source.memoryReceipt
      if (!isMemorySourceReceipt(receipt, state.workspaceId, agentId, generation)) continue
      for (const range of receipt.coverage) {
        const entry = entries.get(range.entryId)
        if (range.kind === 'original' && entry !== undefined && range.contextGeneration === generation) add(entry.eventId, range.start, range.end)
      }
    } else if (message.source.kind === 'agent-workspace-delivery' && message.source.workspaceId === state.workspaceId) {
      const event = events.get(message.source.sourceEventId)
      if (event?.text !== undefined) add(event.id, 0, event.text.length)
    }
  }
  return [...result.values()]
}
