/** Profile-only capture of actual model requests and terminal stream usage. */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'agent-workspace-scene-memory-observer'
export const inject = ['llm']

/** Capture real GenerateOptions before dispatch and raw chunks after dispatch. */
export function apply(ctx: Context): void {
  const root = process.env['DSH_AGENT_GROUP_SCENE_EVIDENCE']
  if (root === undefined) throw new Error('DSH_AGENT_GROUP_SCENE_EVIDENCE is required')
  let nextId = 0
  ctx.on('llm/stream', async function* (options, next) {
    const id = ++nextId
    const started = performance.now()
    appendFileSync(join(root, 'model-requests.jsonl'), `${JSON.stringify({ id, cwd: process.cwd(),
      provider: options.provider, model: options.model, sessionId: options.sessionId, system: options.system,
      messages: options.messages, tools: options.tools, toolHistory: options.toolHistory,
      reasoningEffort: options.reasoningEffort, temperature: options.temperature, maxTokens: options.maxTokens,
      stop: options.stop, purpose: options.purpose, signalAborted: options.signal?.aborted ?? false })}\n`, 'utf8')
    try {
      for await (const chunk of next()) {
        appendFileSync(join(root, 'model-chunks.jsonl'), `${JSON.stringify({ id, chunk })}\n`, 'utf8')
        yield chunk
      }
      appendFileSync(join(root, 'model-settlements.jsonl'), `${JSON.stringify({ id, elapsedMs: performance.now() - started, status: 'completed' })}\n`, 'utf8')
    } catch (error) {
      appendFileSync(join(root, 'model-settlements.jsonl'), `${JSON.stringify({ id, elapsedMs: performance.now() - started,
        status: 'failed', error: error instanceof Error ? error.message : String(error) })}\n`, 'utf8')
      throw error
    }
  })
}
