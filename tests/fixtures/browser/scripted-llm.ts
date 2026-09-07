/** Deterministic LLM adapter for the assembled Agent Workspace release smoke. */

import { existsSync, watch } from 'node:fs'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

const PROVIDER = 'deepseek-official'
const MODEL = 'deepseek-v4-flash'

function textOf(options: GenerateOptions): string {
  return options.messages.flatMap(message => message.content)
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('\n')
}

function employeeName(options: GenerateOptions): string {
  return /身份是“([^”]+)”/u.exec(options.system ?? '')?.[1] ?? 'unknown'
}

function responseFor(options: GenerateOptions): string {
  const messages = textOf(options)
  const name = employeeName(options)
  if (messages.includes('CORE_SESSION_SENTINEL')) return 'CORE_REPLY'
  if (messages.includes('CHECK_MEMORY')) {
    return `${messages.includes('MEMORY_SEED') ? 'MEMORY_OK' : 'MEMORY_MISSING'} ${name}`
  }
  if (messages.includes('HOLD_WAKE')) return `HOLD_REPLY ${name}`
  if (messages.includes('DIRECT_WAKE')) return `DIRECT_REPLY ${name}`
  if (messages.includes('ALL_WAKE')) return `ALL_REPLY ${name}`
  if (messages.includes('NAMED_WAKE')) return `NAMED_REPLY ${name}`
  return `SCRIPTED_REPLY ${name}`
}

async function waitForGate(path: string, signal: AbortSignal | undefined): Promise<void> {
  if (existsSync(path)) return
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let watcher: ReturnType<typeof watch> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      watcher?.close()
      signal?.removeEventListener('abort', abort)
      if (error === undefined) resolve()
      else reject(error)
    }
    const abort = (): void => finish(new Error('scripted smoke generation aborted'))
    watcher = watch(dirname(path), () => {
      if (existsSync(path)) finish()
    })
    watcher.once('error', error => finish(error))
    timer = setTimeout(() => finish(new Error('scripted smoke gate timed out')), 30_000)
    timer.unref()
    signal?.addEventListener('abort', abort, { once: true })
    if (existsSync(path)) finish()
  })
}

class ScriptedWorkspaceAdapter extends LlmAdapter {
  override providerInfo(provider: string) {
    if (provider !== PROVIDER) throw new Error(`unknown scripted provider: ${provider}`)
    return { id: provider, name: 'Agent Workspace scripted release smoke' }
  }

  override listModels(provider: string) {
    return Promise.resolve(provider === PROVIDER
      ? [{ provider, id: MODEL, name: 'Scripted workspace model', inputModalities: ['text'] as const }]
      : [])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (provider !== PROVIDER) throw new Error(`unknown scripted provider: ${provider}`)
    return Promise.resolve({
      provider,
      id: model,
      name: 'Scripted workspace model',
      inputModalities: ['text'],
      context: { contextWindow: 16_384 },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const response = responseFor(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    if (textOf(options).includes('HOLD_WAKE')) {
      yield { type: 'text-delta', index: 0, text: 'LIVE_PARTIAL' }
      const gate = process.env['DSH_AGENT_GROUP_SMOKE_GATE']
      if (gate === undefined) throw new Error('DSH_AGENT_GROUP_SMOKE_GATE is required for HOLD_WAKE')
      await waitForGate(gate, options.signal)
    }
    yield { type: 'text-delta', index: 0, text: response }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: response } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'agent-workspace-scripted-llm'
export const inject = ['llm']

/** Register the smoke adapter on the shipped default provider route. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter([PROVIDER], new ScriptedWorkspaceAdapter())
}
