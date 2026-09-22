/** Deterministic LLM adapter for the assembled Agent Workspace release smoke. */

import { existsSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  CallId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
  type Message,
} from '@deepseek-ai/dsh-llm'

const PROVIDER = 'deepseek-official'
const MODEL = 'deepseek-v4-flash'
const TASK_TOOLS_REQUEST = 'PROFILE_TASK_TOOLS_REQUEST'
const V020_DELEGATE = 'V020_DELEGATE'
const V020_CHILD = 'V020_CHILD'
const V020_SAFE_FAILURE = 'V020_SAFE_FAILURE'
const V020_HOLD = 'V020_HOLD'
const V020_CHILD_EXECUTION = 'V020_CHILD_EXECUTION'
const GATE_TIMEOUT_MS = 120_000

interface TaskToolsFixture {
  readonly taskId: string
  readonly deniedAssigneeAgentId: string
}

interface WorkspaceFixture {
  readonly tasks: Readonly<Record<string, { readonly id: string; readonly title: string; readonly rootTaskId: string }>>
  readonly agents: Readonly<Record<string, { readonly id: string; readonly name: string }>>
  readonly delegationGrants: Readonly<Record<string, { readonly rootTaskId: string; readonly granteeAgentId: string; readonly status: string }>>
}

function textOf(options: GenerateOptions): string {
  return options.messages.flatMap(message => message.content)
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('\n')
}

/** Select the latest delivery, excluding recalled history and tool results. */
export function currentRequest(options: GenerateOptions): Message {
  const message = options.messages.findLast(message => message.role === 'user'
    && (String(message.source.kind) === 'user' || String(message.source.kind) === 'agent-workspace-delivery'))
  if (message === undefined) throw new Error('scripted fixture requires a current request')
  return message
}

function currentText(options: GenerateOptions): string {
  return currentRequest(options).content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/** Resolve the exact delivery identity; task titles alone cannot identify an attempt. */
export function taskIdentity(options: GenerateOptions): { taskId: string; attemptId: string } {
  const source = currentRequest(options).source as unknown as {
    kind: string; source?: { kind: string; taskId?: string }; taskDeliveryAttemptId?: string
  }
  if (options.sessionId === undefined || source.kind !== 'agent-workspace-delivery'
    || source.source?.kind !== 'task' || !source.source.taskId || !source.taskDeliveryAttemptId) {
    throw new Error('scripted task requires session, task and attempt identity')
  }
  return { taskId: source.source.taskId, attemptId: source.taskDeliveryAttemptId }
}

/** Count only ordered results belonging to this delivery's finite tool protocol. */
export function protocolStep(options: GenerateOptions, calls: readonly string[]): number {
  const request = currentRequest(options)
  const results = options.messages.slice(options.messages.indexOf(request) + 1)
    .flatMap(message => message.content).filter(block => block.type === 'tool-result')
  for (const [index, result] of results.entries()) {
    if (result.toolCallId !== calls[index]) throw new Error('scripted task received an unexpected tool result')
  }
  if (results.length >= calls.length) throw new Error('scripted task protocol already completed')
  return results.length
}

function scriptedReadyPath(fixturePath: string): string {
  return `${fixturePath}.scripted-llm-ready`
}

function workspaceFixture(): WorkspaceFixture {
  const home = process.env['DSH_HOME']
  if (home === undefined) throw new Error('DSH_HOME is required for the v0.2 Browser task fixture')
  const paths = [`${home}/storages/agent_workspace.json`, `${home}/storages/agent_workspace/workspaces/local.json`]
  for (const path of paths) {
    if (!existsSync(path)) continue
    const document = JSON.parse(readFileSync(path, 'utf8')) as { readonly tables?: { readonly workspaces?: { readonly local?: WorkspaceFixture } }; readonly value?: WorkspaceFixture }
    const state = (document.tables?.workspaces?.local ?? document.value ?? document) as WorkspaceFixture
    if (state.tasks !== undefined && state.agents !== undefined && state.delegationGrants !== undefined) return state
  }
  throw new Error('the v0.2 Browser task fixture could not read a durable workspace')
}

function workspaceFixturePath(): string {
  const home = process.env['DSH_HOME']
  if (home === undefined) throw new Error('DSH_HOME is required for the v0.2 Browser task fixture')
  const path = [`${home}/storages/agent_workspace.json`, `${home}/storages/agent_workspace/workspaces/local.json`]
    .find(candidate => existsSync(candidate))
  if (path === undefined) throw new Error('the v0.2 Browser task fixture could not resolve its durable file')
  return path
}

function requiredWorkspaceItem<T extends { readonly name?: string; readonly title?: string }>(items: Readonly<Record<string, T>>, marker: string): T {
  const item = Object.values(items).find(candidate => candidate.name === marker || candidate.title?.includes(marker) === true)
  if (item === undefined) throw new Error(`the v0.2 Browser task fixture could not resolve ${marker}`)
  return item
}

async function waitForWorkspace(predicate: (state: WorkspaceFixture) => boolean, signal: AbortSignal | undefined): Promise<WorkspaceFixture> {
  signal?.throwIfAborted()
  const path = workspaceFixturePath()
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => finish(new Error('the v0.2 Browser task fixture timed out waiting for durable state')), 30_000)
    const abort = (): void => finish(new Error('scripted smoke generation aborted'))
    const watcher = watch(dirname(path), (_event, filename) => {
      if (filename !== null && String(filename) !== basename(path)) return
      try { if (predicate(workspaceFixture())) finish() } catch { /* a replacement write can be observed before its complete JSON is visible */ }
    })
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      watcher.close()
      signal?.removeEventListener('abort', abort)
      if (error === undefined) resolve()
      else reject(error)
    }
    watcher.once('error', finish)
    signal?.addEventListener('abort', abort, { once: true })
    try { if (predicate(workspaceFixture())) finish() } catch { /* the next replacement event retries a partial write */ }
  })
  return workspaceFixture()
}

function employeeName(options: GenerateOptions): string {
  const name = /身份是“([^”]+)”/u.exec(options.system ?? '')?.[1]
  if (name === undefined) throw new Error('scripted reply requires employee identity')
  return name
}

function responseFor(options: GenerateOptions): string {
  const messages = currentText(options)
  if (messages.includes('CORE_SESSION_SENTINEL')) return 'CORE_REPLY'
  if (messages === V020_CHILD_EXECUTION) return 'V020_CHILD_RESULT'
  const name = employeeName(options)
  if (messages.includes(V020_HOLD)) return 'V020_HOLD_REPLY'
  if (messages.includes('CHECK_MEMORY')) {
    return `${textOf(options).includes('MEMORY_SEED') ? 'MEMORY_OK' : 'MEMORY_MISSING'} ${name}`
  }
  if (messages.includes('HOLD_WAKE')) return `HOLD_REPLY ${name}`
  if (messages.includes('DIRECT_WAKE')) return `DIRECT_REPLY ${name}`
  if (messages.includes('ALL_WAKE')) return `ALL_REPLY ${name}`
  if (messages.includes('NAMED_WAKE')) return `NAMED_REPLY ${name}`
  return `SCRIPTED_REPLY ${name}`
}

async function waitForGate(path: string, signal: AbortSignal | undefined, ready: () => boolean = () => existsSync(path)): Promise<void> {
  if (ready()) return
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
      if (ready()) finish()
    })
    watcher.once('error', error => finish(error))
    timer = setTimeout(() => finish(new Error('scripted smoke gate timed out')), GATE_TIMEOUT_MS)
    timer.unref()
    signal?.addEventListener('abort', abort, { once: true })
    if (ready()) finish()
  })
}

/** Hold an aborted fixture request until the Browser has observed Stopping. */
export async function waitForObservedStop(path: string, signal: AbortSignal | undefined, identity: Readonly<{ taskId: string; attemptId: string; sessionId: string; messageId: string }>): Promise<void> {
  if (signal === undefined) throw new Error('exact stop requires an abort signal')
  const receipt = JSON.stringify(identity)
  const abort = (): void => { writeFileSync(`${path}.abort-received`, receipt, { encoding: 'utf8', flag: 'wx' }) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    writeFileSync(`${path}.held`, receipt, { encoding: 'utf8', flag: 'wx' })
    if (signal.aborted) abort()
    await waitForGate(`${path}.stopping-observed`, undefined, () => existsSync(`${path}.stopping-observed`) && readFileSync(`${path}.stopping-observed`, 'utf8') === receipt)
    if (!signal.aborted || readFileSync(`${path}.stopping-observed`, 'utf8') !== receipt) throw new Error('Browser stop observation does not match the aborted delivery')
    await waitForGate(path, undefined)
    writeFileSync(`${path}.released`, receipt, { encoding: 'utf8', flag: 'wx' })
    throw new Error('scripted smoke generation aborted after Browser observed Stopping')
  } finally {
    signal.removeEventListener('abort', abort)
  }
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
    const request = currentText(options)
    if (request.includes(TASK_TOOLS_REQUEST)) {
      yield* this.taskToolResponse(options)
      return
    }
    if (request.includes(V020_DELEGATE) || request === V020_CHILD) {
      yield* this.browserTaskResponse(options)
      return
    }
    if (request === V020_HOLD) {
      if (!options.tools?.some(tool => tool.name === 'workspace_delegate_task')) throw new Error('held turn requires workspace_delegate_task')
      const identity = taskIdentity(options)
      const step = protocolStep(options, ['v020-hold-tool', 'v020-hold-unreachable'])
      if (step === 0) {
        const bob = requiredWorkspaceItem(workspaceFixture().agents, 'Bob')
        const tool = { id: CallId('v020-hold-tool'), name: 'workspace_delegate_task', arguments: JSON.stringify({ rootTaskId: identity.taskId, assigneeAgentId: bob.id, title: 'V020_HOLD_SAFE_FAILURE' }) }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: tool.id, name: tool.name, argumentsDelta: tool.arguments }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', ...tool } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const gate = process.env['DSH_AGENT_GROUP_SMOKE_GATE']
      if (gate === undefined) throw new Error('held tool observation requires a fixture gate')
      writeFileSync(`${gate}.stop.tool-ready`, JSON.stringify({ ...identity, sessionId: String(options.sessionId), messageId: String(currentRequest(options).id) }), { encoding: 'utf8', flag: 'wx' })
      await waitForGate(`${gate}.stop.tool-observed`, options.signal)
    }
    const response = responseFor(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    if (request === V020_CHILD_EXECUTION) {
      const gate = process.env['DSH_AGENT_GROUP_SMOKE_GATE']
      if (gate === undefined) throw new Error('child detail observation requires a fixture gate')
      yield { type: 'text-delta', index: 0, text: 'V020_CHILD_PARTIAL' }
      await waitForGate(`${gate}.child-observed`, options.signal)
    }
    if (request.includes('HOLD_WAKE') || request.includes(V020_HOLD)) {
      const stopping = request.includes(V020_HOLD)
      if (stopping) taskIdentity(options)
      yield { type: 'text-delta', index: 0, text: stopping ? 'V020_STOP_PARTIAL' : 'LIVE_PARTIAL' }
      const gate = process.env['DSH_AGENT_GROUP_SMOKE_GATE']
      if (gate === undefined) throw new Error('DSH_AGENT_GROUP_SMOKE_GATE is required for a held smoke turn')
      if (stopping) {
        await waitForObservedStop(`${gate}.stop`, options.signal, {
          ...taskIdentity(options), sessionId: String(options.sessionId), messageId: String(currentRequest(options).id),
        })
      } else await waitForGate(gate, options.signal)
    }
    yield { type: 'text-delta', index: 0, text: response }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: response } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  private async * browserTaskResponse(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const published = new Set(options.tools?.map(tool => tool.name))
    for (const name of ['workspace_delegate_task', 'workspace_run_child', 'workspace_complete_task']) {
      if (!published.has(name)) throw new Error(`v0.2 Browser task fixture did not receive ${name}`)
    }
    const state = workspaceFixture()
    const identity = taskIdentity(options)
    const task = state.tasks[identity.taskId]
    if (task === undefined || task.title !== currentText(options)) throw new Error('scripted task identity does not match its durable task')
    const root = state.tasks[task.rootTaskId]
    if (root === undefined || !root.title.includes(V020_DELEGATE)) throw new Error('scripted task is missing its root task')
    const alice = requiredWorkspaceItem(state.agents, 'Alice')
    const bob = requiredWorkspaceItem(state.agents, 'Bob')
    const isChild = task.title === V020_CHILD
    if (isChild && task.id === root.id) throw new Error('scripted child task cannot use the root identity')
    const calls = isChild ? ['v020-child-run', 'v020-child-complete'] : ['v020-safe-failure', 'v020-delegate', 'v020-root-complete']
    const step = protocolStep(options, calls)
    if (isChild && step === 1) {
      const gate = process.env['DSH_AGENT_GROUP_SMOKE_GATE']
      if (gate === undefined) throw new Error('child result observation requires a fixture gate')
      await waitForGate(`${gate}.child-result-observed`, options.signal)
    }
    const tool = isChild
      ? step === 0
        ? { id: CallId('v020-child-run'), name: 'workspace_run_child', arguments: JSON.stringify({ taskId: task.id, prompt: V020_CHILD_EXECUTION }) }
        : { id: CallId('v020-child-complete'), name: 'workspace_complete_task', arguments: JSON.stringify({ taskId: task.id, result: 'V020_CHILD_RESULT' }) }
      : step === 0
        ? { id: CallId('v020-safe-failure'), name: 'workspace_delegate_task', arguments: JSON.stringify({ rootTaskId: root.id, assigneeAgentId: bob.id, title: V020_SAFE_FAILURE }) }
        : step === 1
          ? await this.grantedDelegation(root.id, alice.id, bob.id, options.signal)
          : { id: CallId('v020-root-complete'), name: 'workspace_complete_task', arguments: JSON.stringify({ taskId: root.id, result: 'V020_ROOT_RESULT' }) }
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: tool.id, name: tool.name, argumentsDelta: tool.arguments }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', ...tool } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }

  private async grantedDelegation(rootTaskId: string, aliceId: string, bobId: string, signal: AbortSignal | undefined) {
    const gate = process.env['DSH_AGENT_GROUP_SMOKE_GATE']
    if (gate === undefined) throw new Error('DSH_AGENT_GROUP_SMOKE_GATE is required for denial observation')
    writeFileSync(`${gate}.denial-result-ready`, JSON.stringify({ rootTaskId, aliceId, bobId }), { encoding: 'utf8', flag: 'wx' })
    await waitForGate(`${gate}.denial-observed`, signal)
    const state = await waitForWorkspace(candidate => Object.values(candidate.delegationGrants).some(grant => (
      grant.rootTaskId === rootTaskId && grant.granteeAgentId === aliceId && grant.status === 'active'
    )), signal)
    if (requiredWorkspaceItem(state.agents, 'Bob').id !== bobId) throw new Error('the v0.2 Browser task fixture resolved an unstable peer identity')
    return { id: CallId('v020-delegate'), name: 'workspace_delegate_task', arguments: JSON.stringify({ rootTaskId, assigneeAgentId: bobId, title: V020_CHILD }) }
  }

  private async * taskToolResponse(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const fixturePath = process.env['DSH_AGENT_GROUP_TASK_TOOLS_FIXTURE']
    if (fixturePath === undefined) throw new Error('DSH_AGENT_GROUP_TASK_TOOLS_FIXTURE is required for profile task tools')
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as TaskToolsFixture
    const expected = ['workspace_delegate_task', 'workspace_run_child', 'workspace_complete_task']
    const published = new Set(options.tools?.map(tool => tool.name))
    if (!expected.every(name => published.has(name))) {
      throw new Error('profile task tools were not visible to the scripted model')
    }
    const identity = taskIdentity(options)
    if (identity.taskId !== fixture.taskId) throw new Error('profile task identity does not match its fixture')
    const step = protocolStep(options, ['profile-policy-denial', 'profile-complete-task'])
    const tool = step === 0
      ? {
          id: CallId('profile-policy-denial'),
          name: 'workspace_delegate_task',
          arguments: JSON.stringify({
            rootTaskId: fixture.taskId,
            assigneeAgentId: fixture.deniedAssigneeAgentId,
            title: 'PROFILE_DENIED_DELEGATION',
          }),
        }
      : {
          id: CallId('profile-complete-task'),
          name: 'workspace_complete_task',
          arguments: JSON.stringify({ taskId: fixture.taskId, result: 'PROFILE_TASK_TOOL_RESULT' }),
        }
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: tool.id, name: tool.name, argumentsDelta: tool.arguments }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', ...tool } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

export const name = 'agent-workspace-scripted-llm'
export const inject = ['llm']

/** Register the smoke adapter on the shipped default provider route. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter([PROVIDER], new ScriptedWorkspaceAdapter())
  const fixturePath = process.env['DSH_AGENT_GROUP_TASK_TOOLS_FIXTURE']
  if (fixturePath !== undefined) writeFileSync(scriptedReadyPath(fixturePath), 'ready\n', 'utf8')
}
