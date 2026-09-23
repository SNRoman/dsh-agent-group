import type { Context } from '@deepseek-ai/cordis'
import { createToolResultMessage, createUserMessage, ToolCallId, type GenerateOptions, type LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { apply, protocolStep, taskIdentity, waitForObservedStop } from './fixtures/browser/scripted-llm.ts'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function adapter(): LlmAdapter {
  let registered: LlmAdapter | undefined
  apply({ llm: { registerAdapter: (_providers: string[], value: LlmAdapter) => { registered = value } } } as unknown as Context)
  if (registered === undefined) throw new Error('scripted adapter was not registered')
  return registered
}

function request(...texts: string[]): GenerateOptions {
  return {
    provider: 'deepseek-official', model: 'deepseek-v4-flash', system: '身份是“Alice”',
    messages: texts.map(text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })),
  }
}

async function output(options: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter().stream(options)) chunks.push(chunk)
  return chunks
}

describe('Browser scripted request protocol', () => {
  it('requires the visible held-turn tool before starting the stop hold', async () => {
    const options = request('V020_HOLD')
    const held = { ...options, sessionId: 'session', messages: [{ ...options.messages[0], source: { kind: 'agent-workspace-delivery', source: { kind: 'task', taskId: 'held' }, taskDeliveryAttemptId: 'attempt' } }] } as unknown as GenerateOptions
    await expect(output(held)).rejects.toThrow('held turn requires workspace_delegate_task')
  })
  it('keeps an aborted provider pending until the Browser acknowledges Stopping and releases it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'browser-stop-protocol-'))
    const path = join(directory, 'stop')
    const controller = new AbortController()
    const identity = { taskId: 'task', attemptId: 'attempt', sessionId: 'session', messageId: 'message' }
    let settled = false
    const pending = waitForObservedStop(path, controller.signal, identity).then(() => { settled = true }, () => { settled = true })
    try {
      controller.abort()
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(settled).toBe(false)
      expect(JSON.parse(await readFile(`${path}.held`, 'utf8'))).toEqual(identity)
      expect(JSON.parse(await readFile(`${path}.abort-received`, 'utf8'))).toEqual(identity)
      await writeFile(`${path}.stopping-observed`, JSON.stringify(identity), 'utf8')
      await writeFile(path, 'release\n', 'utf8')
      await pending
      expect(settled).toBe(true)
      expect(JSON.parse(await readFile(`${path}.released`, 'utf8'))).toEqual(identity)
    } finally {
      await writeFile(`${path}.stopping-observed`, JSON.stringify(identity), 'utf8')
      await writeFile(path, 'release\n', 'utf8')
      await pending
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('does not carry the previous task step into another request in the same session', () => {
    const previous = request('V020_ROOT V020_DELEGATE')
    previous.messages.push(createToolResultMessage({ callId: ToolCallId('v020-safe-failure'), content: [{ type: 'text', text: 'denied' }], isError: true }))
    expect(protocolStep(previous, ['v020-safe-failure', 'v020-delegate'])).toBe(1)
    previous.messages.push(...request('V020_CHILD').messages)
    expect(protocolStep(previous, ['v020-child-run', 'v020-child-complete'])).toBe(0)
  })

  it('rejects tool results from a different protocol and a completed protocol', () => {
    const options = request('V020_CHILD')
    options.messages.push(createToolResultMessage({ callId: ToolCallId('v020-child-run'), content: [], isError: false }))
    expect(() => protocolStep(options, ['v020-safe-failure', 'v020-delegate'])).toThrow('unexpected tool result')
    expect(() => protocolStep(options, ['v020-child-run'])).toThrow('already completed')
  })

  it('rejects a task with no authoritative delivery identity', () => {
    expect(() => taskIdentity(request('V020_CHILD'))).toThrow('session, task and attempt identity')
  })
  it.each(['V020_DELEGATE', 'V020_CHILD', 'PROFILE_TASK_TOOLS_REQUEST', 'HOLD_WAKE'])('does not route a new room request using historical %s', async marker => {
    const chunks = await output(request(marker, '@Alice NAMED_WAKE'))
    expect(chunks.filter(chunk => chunk.type === 'text-delta')).toEqual([{ type: 'text-delta', index: 0, text: 'NAMED_REPLY Alice' }])
  })

  it('rejects a task marker without published task tools', async () => {
    await expect(output(request('V020_ROOT V020_DELEGATE'))).rejects.toThrow('workspace_delegate_task')
  })

  it('rejects an employee reply without employee identity', async () => {
    await expect(output({ ...request('NAMED_WAKE'), system: '' })).rejects.toThrow('employee identity')
  })

  it('still uses history as evidence for an explicit memory check', async () => {
    const chunks = await output(request('MEMORY_SEED', 'V020_DELEGATE', 'CHECK_MEMORY'))
    expect(chunks.filter(chunk => chunk.type === 'text-delta')).toEqual([{ type: 'text-delta', index: 0, text: 'MEMORY_OK Alice' }])
  })
})
