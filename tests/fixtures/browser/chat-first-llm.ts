/** Keyless assembled Browser fixture: deterministic replies and actual model-input evidence. */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '../../../packages/host/src/types.ts'

const PROVIDER = 'agent-workspace-chat-first'
const MODEL = 'chat-first-keyless'
const SECRET = 'CHAT_FIRST_ALREADY_READ_SECRET_20261013'

function currentRequest(options: GenerateOptions): UserMessage {
  const message = options.messages.findLast((item): item is UserMessage => item.role === 'user' && (String(item.source?.kind) === 'user' || String(item.source?.kind) === 'agent-workspace-delivery'))
  if (!message) throw new Error('Chat-first fixture needs an actual current user delivery')
  return message
}
function textOf(message: UserMessage): string { return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') }
function* reply(text: string): Iterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
function* tool(name: string, id: string, args: Record<string, unknown>): Iterable<StreamChunk> {
  const block = { id: ToolCallId(id), name, arguments: JSON.stringify(args) }
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', ...block } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

class ChatFirstAdapter extends LlmAdapter {
  override providerInfo(provider: string) { if (provider !== PROVIDER) throw new Error('Wrong chat-first provider'); return { id: provider, name: 'Chat-first keyless Browser fixture' } }
  override listModels(provider: string) { return Promise.resolve(provider === PROVIDER ? [{ provider, id: MODEL, name: 'Chat-first fixture', inputModalities: ['text'] as const }] : []) }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> { if (provider !== PROVIDER) throw new Error('Wrong chat-first provider'); return Promise.resolve({ provider, id: model, name: 'Chat-first fixture', inputModalities: ['text'], context: { contextWindow: 32_768 } }) }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const path = process.env['DSH_AGENT_GROUP_CHAT_FIRST_INPUTS']
    if (!path || !isAbsolute(path)) throw new Error('Chat-first fixture requires an absolute model-input evidence file')
    const request = currentRequest(options)
    const currentText = textOf(request)
    const { signal: _signal, ...input } = options
    appendFileSync(path, `${JSON.stringify({ currentText, input })}\n`, 'utf8')
    const results = options.messages.slice(options.messages.indexOf(request) + 1).filter(message => message.role === 'tool')
    if (currentText.includes('CHAT_FIRST_FILE_WRITE')) {
      const directory = process.env['DSH_AGENT_GROUP_CHAT_FIRST_FILES']
      if (!directory || !isAbsolute(directory)) throw new Error('File fixture needs its private workspace directory')
      if (results.some(result => result.isError)) throw new Error('Actual file tool failed')
      if (results.length < 4) {
        const file_path = join(directory, results.length < 2 ? 'restore.txt' : 'conflict.txt')
        yield* tool(results.length % 2 === 0 ? 'read' : 'write', `chat-first-file-${results.length}`, results.length % 2 === 0 ? { file_path } : { file_path, content: 'MODEL_CHANGED\n' })
      }
      else yield* reply('CHAT_FIRST_FILE_WRITTEN')
      return
    }
    if (currentText.includes('CHAT_FIRST_POST_RECALL')) {
      if (JSON.stringify(input).includes(SECRET)) throw new Error('Withdrawn content reached the actual fresh model request')
      yield* reply('CHAT_FIRST_FRESH_CONTEXT_OK'); return
    }
    if (/\bCHAT_FIRST_PROPOSE\b/u.test(currentText)) {
      if (!options.tools?.some(item => item.name === 'workspace_propose_task')) throw new Error('Real proposal tool was not published')
      const source = request.source
      if (source?.kind !== 'agent-workspace-delivery' || source.source.kind !== 'room') throw new Error('A proposal requires the actual room delivery')
      if (results.length === 0) yield* tool('workspace_propose_task', 'chat-first-proposal', { roomId: source.source.roomId, brief: { title: 'CHAT_FIRST_PROPOSAL', instructions: 'CHAT_FIRST_PROPOSED_WORK complete report', expectedArtifacts: ['report.md'], acceptanceCriteria: ['Reviewed'] } })
      else { if (results.some(result => result.isError)) throw new Error('Proposal tool failed'); yield* reply('CHAT_FIRST_PROPOSAL_READY') }
      return
    }
    const source = request.source
    if (source?.kind === 'agent-workspace-delivery' && source.source.kind === 'task') {
      if (!options.tools?.some(item => item.name === 'workspace_complete_task')) throw new Error('Real completion tool was not published')
      if (results.length === 0) yield* tool('workspace_complete_task', `chat-first-complete-${source.taskDeliveryAttemptId}`, { taskId: source.source.taskId, result: 'CHAT_FIRST_WORK_RESULT' })
      else yield* reply('CHAT_FIRST_WORK_FINISHED')
      return
    }
    if (currentText.includes('CHAT_FIRST_MARKDOWN') && !currentText.includes('CHAT_FIRST_MARKDOWN_REPLY')) { yield* reply('CHAT_FIRST_MARKDOWN_REPLY **bold**\n\nPlease ask ' + /<@[^>]+>/u.exec(currentText)?.[0] + ' for details.\n\n```text\n@invalid is code\n```'); return }
    if (currentText.includes(SECRET)) { yield* reply('CHAT_FIRST_SECRET_READ'); return }
    yield* reply('CHAT_FIRST_REPLY')
  }
}

export const name = 'agent-workspace-chat-first-llm'
export const inject = ['llm']
/** @param ctx Profile-local adapter registration. @returns Nothing. */
export function apply(ctx: Context): void {
  const path = process.env['DSH_AGENT_GROUP_CHAT_FIRST_INPUTS']
  if (!path || !isAbsolute(path)) throw new Error('Chat-first fixture needs an absolute evidence path')
  mkdirSync(dirname(path), { recursive: true })
  ctx.llm.registerAdapter([PROVIDER], new ChatFirstAdapter())
}
