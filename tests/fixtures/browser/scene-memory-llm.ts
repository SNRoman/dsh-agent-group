/** Deterministic external-model stand-in for the isolated scene-memory profile. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { MEMORY_EXTRACTION_SYSTEM } from '../../../packages/host/src/memory-projection.ts'

const PROVIDER = 'agent-workspace-scene-scripted'
const MODEL = 'scene-v1'

function textOf(options: GenerateOptions): string {
  return options.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
}

function currentMarker(options: GenerateOptions): string | undefined {
  return latestSceneMarker(options.messages.filter(message => message.source?.kind === 'agent-workspace-context')
    .map(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')))
}

/** Keep the delivery scene across later tool-read context messages. */
export function latestSceneMarker(contexts: readonly string[]): string | undefined {
  for (const context of contexts.toReversed()) {
    const marker = sceneMarkerFromContext(context)
    if (marker !== undefined) return marker
  }
  return undefined
}

function toolResult(options: GenerateOptions, id: string): ToolResultMessage | undefined {
  return options.messages.findLast((message): message is ToolResultMessage => message.role === 'tool' && message.toolCallId === id)
}

function resultText(result: ToolResultMessage): string {
  if (result.isError === true) throw new Error(`scene memory tool failed: ${result.toolCallId}`)
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/** Marker from the current scene query, excluding recalled historical messages. */
export function sceneMarkerFromContext(text: string): string | undefined {
  const query = /Current scene \(caller context\): \{[^\n]*"query":"([^"]*)"/u.exec(text)?.[1]
  return query?.match(/SCENE_[A-Z_]+/u)?.[0]
    ?? (query?.includes('现在知道了吗') ? 'SCENE_GENERIC' : query?.includes('上次项目怎样了') ? 'SCENE_FORMAL_STATUS' : undefined)
}

function responseFor(options: GenerateOptions): string {
  if (options.system === MEMORY_EXTRACTION_SYSTEM) {
    const last = options.messages.at(-1)
    const prompt = last?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? ''
    const input = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as { readonly text: string }
    if (input.text.includes('请叫我邵老师')) return JSON.stringify({ facts: [{ kind: 'controlled', property: 'person.address',
      subject: 'source-actor', temporal: 'current', operation: 'set', value: '邵老师',
      application: { kind: 'source-room', evidence: '本群' }, sourceQuote: '在本群请叫我邵老师。',
      assertionKind: 'human-explicit' }] })
    if (input.text.includes('email in English')) return JSON.stringify({ facts: [{ kind: 'controlled', property: 'communication.language',
      subject: 'source-actor', temporal: 'current', operation: 'set', value: 'English',
      application: { kind: 'organization', evidence: 'For all correspondence' },
      sourceQuote: 'For all correspondence, please send email in English.', assertionKind: 'human-explicit' }] })
    return '{"facts":[]}'
  }
  const text = textOf(options)
  const marker = currentMarker(options)
  const required = (marker: string, source: string): void => {
    if (!text.includes(source)) throw new Error(`${marker} did not receive acquired source ${source}`)
  }
  if (marker === 'SCENE_CROSS_ALICE') { required(marker, 'SRC_NO_MENTION'); return 'SCENE_CROSS_ALICE_OK' }
  if (marker === 'SCENE_GENERIC') { required(marker, '请叫我邵老师'); return '知道了，称呼邵老师。' }
  if (marker === 'SCENE_FORMAL_STATUS') {
    if (!text.includes('旧项目') || !text.includes('"status":"cancelled"')) throw new Error('cancelled formal task status is absent from current scene')
    return 'FORMAL_STOPPED_OK'
  }
  if (marker === 'SCENE_STRANGER_BOB') {
    if (text.includes('SRC_NO_MENTION')) throw new Error('SCENE_STRANGER_BOB received another colleague source')
    return 'SCENE_STRANGER_BOB_OK'
  }
  if (marker === 'SCENE_LANGUAGE_SWITCH') { required(marker, 'email in English'); return 'SCENE_LANGUAGE_SWITCH_OK 中文回复' }
  if (marker === 'SCENE_VERSION_B') { required(marker, 'VERSION_B_CURRENT'); return 'SCENE_VERSION_B_OK' }
  if (marker === 'SCENE_AFTER_WITHDRAWAL') {
    if (text.includes('VERSION_B_CURRENT')) throw new Error('withdrawn B source reached employee')
    return 'SCENE_AFTER_WITHDRAWAL_OK'
  }
  if (marker === 'SCENE_RESTART_RECALL') { required(marker, 'SRC_NO_MENTION'); return 'SCENE_RESTART_RECALL_OK' }
  if (marker === 'SCENE_AFTER_STOP') {
    return 'SCENE_AFTER_STOP_OK'
  }
  if (marker === 'SCENE_AFTER_TOOL_WITHDRAWAL') {
    if (text.includes('TOOL_ONLY_SECRET_617')) throw new Error('withdrawn tool-only dependency leaked into replacement context')
    return 'SCENE_AFTER_TOOL_WITHDRAWAL_OK'
  }
  throw new Error(`scripted scene request has no recognized current marker: ${marker ?? 'missing'}`)
}

class SceneAdapter extends LlmAdapter {
  override providerInfo(provider: string) {
    if (provider !== PROVIDER) throw new Error(`unknown scene provider: ${provider}`)
    return { id: provider, name: 'Scene memory scripted profile' }
  }
  override listModels(provider: string) {
    return Promise.resolve(provider === PROVIDER ? [{ provider, id: MODEL, name: MODEL, inputModalities: ['text'] as const }] : [])
  }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (provider !== PROVIDER || model !== MODEL) throw new Error('unknown scripted scene model')
    return Promise.resolve({ provider, id: model, name: MODEL, inputModalities: ['text'], context: { contextWindow: 16_384 } })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const marker = currentMarker(options)
    if (marker === 'SCENE_OLD_WORK') {
      await new Promise<void>((resolve, reject) => {
        if (options.signal?.aborted) { resolve(); return }
        const timer = setTimeout(() => reject(new Error('old work was not stopped')), 30_000)
        timer.unref()
        options.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
      })
      return
    }
    if (marker === 'SCENE_TOOL_ONLY') {
      const searched = toolResult(options, 'scene-tool-search')
      const read = toolResult(options, 'scene-tool-read')
      if (searched === undefined && textOf(options).includes('TOOL_ONLY_SECRET_617')) throw new Error('tool-only source leaked into initial context')
      if (read !== undefined) {
        const result = JSON.parse(resultText(read)) as { readonly text: string; readonly eventId: string; readonly offset: number }
        if (result.offset !== 1600 || !result.text.includes('TOOL_ONLY_SECRET_617')) throw new Error('tool read missed the source tail')
        const response = 'SCENE_TOOL_ONLY_OK'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: response }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: response } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      let name = 'workspace_search_memory', id = 'scene-tool-search', args = JSON.stringify({ query: 'TOOL_ONLY_SECRET_617' })
      if (searched !== undefined) {
        const result = JSON.parse(resultText(searched)) as { readonly events: readonly { readonly eventId: string }[] }
        const eventId = result.events[0]?.eventId
        if (eventId === undefined) throw new Error('tool search missed the acquired source')
        name = 'workspace_read_memory'; id = 'scene-tool-read'; args = JSON.stringify({ eventId, offset: 1600 })
      }
      const call = { id: ToolCallId(id), name, arguments: args }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', ...call } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const response = responseFor(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: response }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: response } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'agent-workspace-scene-scripted-llm'
export const inject = ['llm']

/** Register only the profile-local synthetic route. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], new SceneAdapter()))
  const root = process.env['DSH_AGENT_GROUP_SCENE_EVIDENCE']
  if (root === undefined) throw new Error('DSH_AGENT_GROUP_SCENE_EVIDENCE is required')
  writeFileSync(join(root, 'adapter.ready'), 'ready\n', 'utf8')
}
