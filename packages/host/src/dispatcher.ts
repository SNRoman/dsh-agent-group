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
import type { AgentDefinitionId, ChildRunId as ChildId, WorkspaceEventId } from './ids.ts'
import { finishChildRun } from './child-runs.ts'
import { recallAgentEvents } from './memory.ts'
import { assertRoomMessageAuthorized } from './room-policy.ts'
import { completeTask, recordChildRunStarted } from './tasks.ts'
import { assertAssignedTaskRunnable } from './task-policy.ts'
import type { WorkspaceTurnOutcome } from './turn-tracker.ts'
import type { WorkspaceActivityIdentity, WorkspaceActivitySource } from './activity-stream.ts'
import type { WorkspaceActor, WorkspaceCommand, WorkspaceState } from './types.ts'

/** The host surface the dispatcher drives. */
export interface WorkspaceDispatcherHost {
  snapshot(): WorkspaceState
  execute(command: WorkspaceCommand, settledActivity?: WorkspaceActivityIdentity): Promise<WorkspaceState>
  apply(mutation: (state: WorkspaceState) => WorkspaceState): Promise<WorkspaceState>
  deliver(agentId: AgentId, delivery: UserMessage, recall?: UserMessage, source?: WorkspaceActivitySource): Promise<WorkspaceTurnOutcome>
  ensureEmployee(agentId: AgentId): Promise<AgentHandle>
  retireWorkspaceActivity?(activity: WorkspaceActivityIdentity, workspaceRevision: number): void
}

/** A durable root post plus the separately awaitable collaboration chain it started. */
export interface StartedWorkspaceDispatch {
  readonly state: WorkspaceState
  readonly completion: Promise<void>
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
  readonly sourceEventId: WorkspaceEventId
  readonly depth: number
}

type DeliverySource = { readonly kind: 'room'; readonly roomId: RoomId } | { readonly kind: 'task'; readonly taskId: TaskId }

interface ActiveRoomMember {
  readonly id: AgentId
  readonly name: string
  readonly definitionId: AgentDefinitionId
}

const MENTION_RE = /<@([^>\s]+)>/g
const DISPLAY_MENTION_BOUNDARY = /[\s,，。.!！？?;；:：、)）\]】}》>"'“”‘’]/u

type SubagentRuntimeSource = SubagentRuntimeLike | (() => SubagentRuntimeLike | undefined) | undefined

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
    private readonly subagents: SubagentRuntimeSource,
    private readonly provider: string,
    private readonly limits: DispatcherLimits,
  ) {}

  /**
   * Durably record a human message, then expose the collaboration chain as a
   * separate promise. Browser transports can acknowledge the durable post
   * without holding one RPC open for the whole agent-to-agent conversation.
   */
  async startHumanMessage(roomId: RoomId, humanId: HumanId, text: string, mentions: readonly AgentId[]): Promise<StartedWorkspaceDispatch> {
    return await this.startDispatch(roomId, { type: 'human', id: humanId }, text, mentions)
  }

  /** Record a human message and wait for its complete collaboration chain. */
  async postHumanMessage(roomId: RoomId, humanId: HumanId, text: string, mentions: readonly AgentId[]): Promise<void> {
    const started = await this.startHumanMessage(roomId, humanId, text, mentions)
    await started.completion
  }

  /** Record an agent message and wake its explicitly mentioned agents. */
  async postAgentMessage(roomId: RoomId, agentId: AgentId, text: string, mentions: readonly AgentId[]): Promise<void> {
    const started = await this.startDispatch(roomId, { type: 'agent', id: agentId }, text, mentions)
    await started.completion
  }

  /** Deliver one formal task to its assigned agent and complete it. */
  async runAssignedTask(agentId: AgentId, taskId: TaskId): Promise<string> {
    const state = this.host.snapshot()
    const task = assertAssignedTaskRunnable(state, agentId, taskId)
    const reply = await this.wake(agentId, { kind: 'task', taskId }, taskSourceEventId(state, taskId), task.title)
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
    const subagents = this.resolveSubagents()
    if (subagents === undefined) throw new Error('subagent runtime is not available in this deployment')
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
      run = await subagents.start(this.provider, {
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

  /** Persist the root room event before any potentially long-running agent wake. */
  private async startDispatch(roomId: RoomId, actor: WorkspaceActor, text: string, mentions: readonly AgentId[]): Promise<StartedWorkspaceDispatch> {
    assertRoomMessageAuthorized(this.host.snapshot(), roomId, actor, mentions)
    const state = await this.host.execute({ type: 'room/message', roomId, actor, text, mentions })
    const sourceEventId = requireLatestRoomMessageId(state, roomId)
    const completion = this.continueDispatch(roomId, text, mentions, sourceEventId)
    return { state, completion }
  }

  /** Continue only the agent wake/reply portion after the root event is durable. */
  private async continueDispatch(roomId: RoomId, text: string, mentions: readonly AgentId[], sourceEventId: WorkspaceEventId): Promise<void> {
    const queue: PendingWake[] = mentions.map(agentId => ({ agentId, triggeredBy: text, sourceEventId, depth: 1 }))
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
      const outcome = await this.wakeOutcome(item.agentId, { kind: 'room', roomId }, item.sourceEventId, item.triggeredBy)
      const reply = textOf(outcome.output)
      const successful = outcome.stopReason.kind === 'completed' || outcome.stopReason.kind === 'max-tokens'
      if (successful && reply.trim() !== '') {
        replies++
        const next = parseRoomMentions(this.host.snapshot(), roomId, reply)
        const actor: WorkspaceActor = { type: 'agent', id: item.agentId }
        assertRoomMessageAuthorized(this.host.snapshot(), roomId, actor, next)
        const committed = await this.host.execute(
          { type: 'room/message', roomId, actor, text: reply, mentions: next },
          outcome.workspaceActivity,
        )
        const replyEventId = requireLatestRoomMessageId(committed, roomId)
        for (const nextAgentId of next) {
          queue.push({ agentId: nextAgentId, triggeredBy: reply, sourceEventId: replyEventId, depth: item.depth + 1 })
        }
      } else if (outcome.workspaceActivity !== undefined) {
        // A tool-only/empty-text reply has no Workspace room message to commit,
        // and only DSH's completed/max-tokens reasons prove a successful step.
        // Retire every uncommitted transient against the current durable revision.
        this.host.retireWorkspaceActivity?.(outcome.workspaceActivity, this.host.snapshot().revision)
      }
    }
  }

  private async wake(agentId: AgentId, source: DeliverySource, sourceEventId: WorkspaceEventId, query: string): Promise<string> {
    const outcome = await this.wakeOutcome(agentId, source, sourceEventId, query)
    return textOf(outcome.output)
  }

  private async wakeOutcome(agentId: AgentId, source: DeliverySource, sourceEventId: WorkspaceEventId, query: string): Promise<WorkspaceTurnOutcome> {
    const state = this.host.snapshot()
    const roomId = source.kind === 'room' ? source.roomId : undefined
    const recall = roomId === undefined
      ? { rendered: '' }
      : recallAgentEvents(state, { agentId, roomId, query, characterBudget: this.limits.recallCharacterBudget })
    const collaboration = roomId === undefined ? '' : renderCollaborationContext(state, roomId)
    const delivery = createUserMessage({
      content: [{ type: 'text', text: query }],
      source: { kind: 'agent-workspace-delivery', workspaceId: state.workspaceId, source, sourceEventId },
    })
    const supplemental = [recall.rendered, collaboration].filter(value => value.trim() !== '').join('\n\n')
    const recallMessage = supplemental === ''
      ? undefined
      : createUserMessage({
        content: [{ type: 'text', text: supplemental }],
        source: { kind: 'agent-workspace-recall' },
      })
    // Task 5's delivery coordinator supplies the durable attempt identity.
    // The legacy task path remains untracked instead of inventing an attempt.
    const activitySource = source.kind === 'room' ? source : undefined
    return await this.host.deliver(agentId, delivery, recallMessage, activitySource)
  }

  private isEmployed(state: WorkspaceState, agentId: AgentId): boolean {
    return state.agents[agentId]?.employmentStatus === 'employed'
  }

  private resolveSubagents(): SubagentRuntimeLike | undefined {
    return typeof this.subagents === 'function' ? this.subagents() : this.subagents
  }
}

/** Extract the concatenated text of one assistant output. */
function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is { readonly type: 'text'; readonly text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function requireLatestRoomMessageId(state: WorkspaceState, roomId: RoomId): WorkspaceEventId {
  const event = state.events.at(-1)
  if (event?.type !== 'room/message' || event.subjectId !== roomId) {
    throw new Error(`room '${roomId}' mutation did not append its message event`)
  }
  return event.id
}

function taskSourceEventId(state: WorkspaceState, taskId: TaskId): WorkspaceEventId {
  const assignment = Object.values(state.taskAssignments).find(candidate => candidate.taskId === taskId)
  if (assignment === undefined) throw new Error(`task '${taskId}' has no assignment`)
  const event = state.events.find(candidate =>
    (candidate.type === 'task/assigned' || candidate.type === 'task/delegated')
    && candidate.subjectId === assignment.id,
  )
  if (event === undefined) throw new Error(`task '${taskId}' has no assignment event`)
  return event.id
}

/** Extract canonical, instance-name and unique role-name mentions from a reply. */
function parseRoomMentions(state: WorkspaceState, roomId: RoomId, text: string): AgentId[] {
  const members = activeRoomMembers(state, roomId)
  const memberIds = new Set(members.map(member => member.id))
  const hits: Array<{ index: number; id: AgentId }> = []

  for (const match of text.matchAll(MENTION_RE)) {
    const rawId = match[1]
    if (rawId === undefined) continue
    const id = AgentId(rawId)
    if (memberIds.has(id)) hits.push({ index: match.index, id })
  }

  const aliases = new Map<string, Set<AgentId>>()
  const addAlias = (alias: string | undefined, id: AgentId): void => {
    if (alias === undefined || alias.trim() === '') return
    const owners = aliases.get(alias) ?? new Set<AgentId>()
    owners.add(id)
    aliases.set(alias, owners)
  }
  for (const member of members) {
    addAlias(member.name, member.id)
    addAlias(state.definitions[member.definitionId]?.name, member.id)
  }

  for (const [alias, owners] of aliases) {
    if (owners.size !== 1) continue
    const id = [...owners][0]
    if (id === undefined) continue
    const token = `@${alias}`
    let from = 0
    while (from < text.length) {
      const index = text.indexOf(token, from)
      if (index < 0) break
      const after = text[index + token.length]
      if (after === undefined || DISPLAY_MENTION_BOUNDARY.test(after)) hits.push({ index, id })
      from = index + token.length
    }
  }

  hits.sort((left, right) => left.index - right.index)
  const seen = new Set<AgentId>()
  return hits.flatMap(hit => {
    if (seen.has(hit.id)) return []
    seen.add(hit.id)
    return [hit.id]
  })
}

function activeRoomMembers(state: WorkspaceState, roomId: RoomId): ActiveRoomMember[] {
  const seen = new Set<AgentId>()
  const members: ActiveRoomMember[] = []
  for (const membership of Object.values(state.memberships)) {
    if (membership.roomId !== roomId || membership.leftEventId !== undefined || seen.has(membership.agentId)) continue
    const agent = state.agents[membership.agentId]
    if (agent === undefined || agent.employmentStatus !== 'employed') continue
    seen.add(agent.id)
    members.push({ id: agent.id, name: agent.name, definitionId: agent.definitionId })
  }
  return members
}

function renderCollaborationContext(state: WorkspaceState, roomId: RoomId): string {
  const members = activeRoomMembers(state, roomId)
  if (members.length === 0) return ''
  const roleCounts = new Map<string, number>()
  for (const member of members) {
    const role = state.definitions[member.definitionId]?.name
    if (role !== undefined) roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1)
  }
  const rows = members.map(member => {
    const role = state.definitions[member.definitionId]?.name
    if (role === undefined) return `- @${member.name}`
    const roleAlias = roleCounts.get(role) === 1 && role !== member.name ? `；唯一角色别名 @${role}` : ''
    return `- @${member.name} — ${role}${roleAlias}`
  })
  return [
    '当前房间可协作成员：',
    ...rows,
    '需要其他成员继续处理时，优先使用准确的实例显示名称 @成员名；上面标注了“唯一角色别名”的角色也可以直接 @角色名。不要输出内部 agent id。',
  ].join('\n')
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
