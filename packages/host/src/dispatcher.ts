/**
 * The mention dispatcher: records room messages into every member's memory,
 * wakes only explicitly mentioned employed agents, bounds agent-to-agent
 * chains, and runs one-shot children through the DSH subagent seam.
 * @module @dsh-agent-group/host/dispatcher
 */

import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { AgentId, HumanId, RoomId, TaskId } from './ids.ts'
import type { ChildRunId as ChildId } from './ids.ts'
import { finishChildRun } from './child-runs.ts'
import { recallAgentEvents } from './memory.ts'
import { assertRoomMessageAuthorized } from './room-policy.ts'
import { completeTask, recordChildRunStarted } from './tasks.ts'
import { assertAssignedTaskRunnable } from './task-policy.ts'
import type { DeliveryOutcome } from './turn-tracker.ts'
import type { WorkspaceActor, WorkspaceCommand, WorkspaceState } from './types.ts'

/** The host surface the dispatcher drives. */
export interface WorkspaceDispatcherHost {
  snapshot(): WorkspaceState
  execute(command: WorkspaceCommand): Promise<WorkspaceState>
  apply(mutation: (state: WorkspaceState) => WorkspaceState): Promise<WorkspaceState>
  deliver(agentId: AgentId, delivery: UserMessage, recall?: UserMessage): Promise<DeliveryOutcome>
  ensureEmployee(agentId: AgentId): Promise<AgentHandle>
}

/** The one-shot subagent seam, narrowed to what the dispatcher needs. */
export interface OneShotSubagentRequest {
  readonly parent: Agent
  readonly prompt: ContentBlock[]
  readonly signal: AbortSignal
  readonly label?: string
}

/** A published one-shot child handle. */
export interface OneShotSubagentRun {
  readonly result: Promise<{ readonly output: ContentBlock[]; readonly stopReason: string }>
  dispose(): Promise<void>
}

/** The subagent seam surface the dispatcher uses (typically `ctx.subagents`). */
export interface SubagentRuntimeLike {
  start(name: string, request: OneShotSubagentRequest): Promise<OneShotSubagentRun>
}

/** Fixed MVP chain bounds from the specification. */
export interface DispatcherLimits {
  readonly maxAgentHops: number
  readonly maxRepliesPerRoot: number
  readonly recallCharacterBudget: number
}

interface PendingWake {
  readonly agentId: AgentId
  readonly triggeredBy: string
  readonly depth: number
}

const MENTION_RE = /<@([^>\s]+)>/g

/**
 * Serializes each root room-message dispatch internally: one delivery at a
 * time, each agent reply recorded before its mentions schedule the next hop,
 * and the shared hop and reply budgets stop runaway agent-to-agent
 * conversation. Separate root dispatches may overlap; durable mutations are
 * serialized by the workspace domain boundary.
 */
export class WorkspaceDispatcher {
  constructor(
    private readonly host: WorkspaceDispatcherHost,
    private readonly subagents: SubagentRuntimeLike,
    private readonly provider: string,
    private readonly limits: DispatcherLimits,
  ) {}

  /** Record a human message and wake only its explicitly mentioned agents. */
  async postHumanMessage(roomId: RoomId, humanId: HumanId, text: string, mentions: readonly AgentId[]): Promise<void> {
    await this.dispatch(roomId, { type: 'human', id: humanId }, text, mentions)
  }

  /** Record an agent message and wake its explicitly mentioned agents. */
  async postAgentMessage(roomId: RoomId, agentId: AgentId, text: string, mentions: readonly AgentId[]): Promise<void> {
    await this.dispatch(roomId, { type: 'agent', id: agentId }, text, mentions)
  }

  /** Deliver one formal task to its assigned agent and complete it. */
  async runAssignedTask(agentId: AgentId, taskId: TaskId): Promise<string> {
    const state = this.host.snapshot()
    const task = assertAssignedTaskRunnable(state, agentId, taskId)
    const reply = await this.wake(agentId, undefined, task.title)
    await this.host.apply(current => completeTask(current, { actorAgentId: agentId, taskId }).state)
    return reply
  }

  /**
   * Run one one-shot child for a parent agent and record its terminal result
   * into the parent's memory. The run is always disposed. The committed child
   * id is captured inside the serialized mutation so concurrent starts cannot
   * reuse a stale snapshot id.
   */
  async runChild(parentAgentId: AgentId, taskId: TaskId, prompt: string, signal: AbortSignal = new AbortController().signal): Promise<string> {
    const handle = await this.host.ensureEmployee(parentAgentId)
    let publishedChildRunId: ChildId | undefined
    await this.host.apply(current => {
      const started = recordChildRunStarted(current, { parentAgentId, taskId })
      publishedChildRunId = started.childRunId
      return started.state
    })
    if (publishedChildRunId === undefined) throw new Error('child run start did not publish an id')
    const childRunId: ChildId = publishedChildRunId

    let run: OneShotSubagentRun | undefined
    let result: { readonly output: ContentBlock[]; readonly stopReason: string } | undefined
    let failure: unknown
    try {
      run = await this.subagents.start(this.provider, {
        parent: handle.agent,
        prompt: [{ type: 'text', text: prompt }],
        signal,
        label: `workspace-child:${taskId}`,
      })
      result = await run.result
    } catch (error) {
      failure = error
    } finally {
      if (run !== undefined) {
        try {
          await run.dispose()
        } catch (error) {
          if (failure === undefined) failure = error
        }
      }
    }

    if (failure !== undefined) {
      const status = signal.aborted ? 'cancelled' : 'failed'
      await this.host.apply(current => finishChildRun(current, {
        childRunId,
        status,
        result: status === 'cancelled' ? 'Child run cancelled.' : 'Child run failed.',
      }).state)
      throw failure
    }
    if (result === undefined) throw new Error('child run settled without a result')

    const output = textOf(result.output)
    const status = childStatus(result.stopReason)
    const terminalText = output.trim() === '' ? fallbackChildResult(status) : output
    await this.host.apply(current => finishChildRun(current, {
      childRunId,
      status,
      result: terminalText,
    }).state)
    return output
  }

  private async dispatch(roomId: RoomId, actor: WorkspaceActor, text: string, mentions: readonly AgentId[]): Promise<void> {
    assertRoomMessageAuthorized(this.host.snapshot(), roomId, actor, mentions)
    await this.host.execute({ type: 'room/message', roomId, actor, text, mentions })
    const queue: PendingWake[] = mentions.map(agentId => ({ agentId, triggeredBy: text, depth: 1 }))
    let replies = 0
    let stopped = false
    while (queue.length > 0 && !stopped) {
      const item = queue.shift()
      if (item === undefined) break
      if (item.depth > this.limits.maxAgentHops || replies >= this.limits.maxRepliesPerRoot) {
        await this.host.execute({ type: 'conversation/stop', roomId })
        stopped = true
        break
      }
      if (!this.isEmployed(this.host.snapshot(), item.agentId)) continue
      const reply = await this.wake(item.agentId, roomId, item.triggeredBy)
      replies++
      const next = parseMentions(reply)
      if (reply.trim() !== '') {
        const actor: WorkspaceActor = { type: 'agent', id: item.agentId }
        assertRoomMessageAuthorized(this.host.snapshot(), roomId, actor, next)
        await this.host.execute({ type: 'room/message', roomId, actor, text: reply, mentions: next })
      }
      for (const nextAgentId of next) {
        queue.push({ agentId: nextAgentId, triggeredBy: reply, depth: item.depth + 1 })
      }
    }
  }

  private async wake(agentId: AgentId, roomId: RoomId | undefined, query: string): Promise<string> {
    const state = this.host.snapshot()
    const recall = roomId === undefined
      ? { rendered: '' }
      : recallAgentEvents(state, { agentId, roomId, query, characterBudget: this.limits.recallCharacterBudget })
    const delivery = createUserMessage({
      content: [{ type: 'text', text: query }],
      source: { kind: 'agent-workspace-delivery' },
    })
    const recallMessage = recall.rendered === ''
      ? undefined
      : createUserMessage({
        content: [{ type: 'text', text: recall.rendered }],
        source: { kind: 'agent-workspace-recall' },
      })
    const outcome = await this.host.deliver(agentId, delivery, recallMessage)
    return textOf(outcome.output)
  }

  private isEmployed(state: WorkspaceState, agentId: AgentId): boolean {
    return state.agents[agentId]?.employmentStatus === 'employed'
  }
}

/** Extract the concatenated text of one assistant output. */
function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is { readonly type: 'text'; readonly text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** Extract canonical `<@agentId>` mentions from reply text. */
function parseMentions(text: string): AgentId[] {
  const ids = new Set<AgentId>()
  for (const match of text.matchAll(MENTION_RE)) {
    const id = match[1]
    if (id !== undefined) ids.add(AgentId(id))
  }
  return [...ids]
}

function childStatus(stopReason: string): 'completed' | 'failed' | 'cancelled' {
  if (stopReason === 'completed') return 'completed'
  if (stopReason === 'aborted') return 'cancelled'
  return 'failed'
}

function fallbackChildResult(status: 'completed' | 'failed' | 'cancelled'): string {
  if (status === 'completed') return 'Child run completed without textual output.'
  if (status === 'cancelled') return 'Child run cancelled without textual output.'
  return 'Child run failed without textual output.'
}
