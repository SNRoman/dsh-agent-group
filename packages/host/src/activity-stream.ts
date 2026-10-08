/**
 * Process-local projection of queued and live employee activity for the Agent
 * Workspace browser. Durable room and task events remain the source of truth.
 * @module @dsh-agent-group/host/activity-stream
 */

import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceActivityId } from './ids.ts'
import type { AgentId, RoomId, TaskDeliveryAttemptId, TaskId } from './ids.ts'

/** The durable Workspace context that caused one employee delivery. */
export type WorkspaceActivitySource =
  | { readonly kind: 'room'; readonly roomId: RoomId }
  | { readonly kind: 'task'; readonly taskId: TaskId; readonly attemptId: TaskDeliveryAttemptId }

/** Exact identity required to stop, settle, or retire one claimed activity. */
export interface WorkspaceActivityIdentity {
  readonly activityId: WorkspaceActivityId
  readonly agentId: AgentId
  readonly messageId: MessageId
  readonly sessionId: SessionId
  readonly turn: number
}

/** Display-safe failure fields retained by the activity projection. */
export interface WorkspaceActivityError {
  readonly code: string
  readonly summary: string
}

/** A text block assembled from one or more token deltas. */
export interface WorkspaceActivityTextBlock {
  readonly kind: 'text'
  readonly index: number
  readonly text: string
}

/** A reasoning block assembled from one or more reasoning deltas. */
export interface WorkspaceActivityReasoningBlock {
  readonly kind: 'reasoning'
  readonly index: number
  readonly text: string
}

/** A projected tool invocation and its eventual result. */
export interface WorkspaceActivityToolBlock {
  readonly kind: 'tool'
  readonly index: number
  readonly callId: string
  readonly name: string
  readonly arguments: string
  readonly status: 'running' | 'completed' | 'failed'
  readonly resultText?: string
  readonly error?: WorkspaceActivityError
}

/** Forward-compatible fallback for a displayable but unknown block. */
export interface WorkspaceActivityUnknownBlock {
  readonly kind: 'unknown'
  readonly index: number
  readonly label: string
  readonly value: JsonSafeValue
}

/** Ordered display blocks projected for one activity. */
export type WorkspaceActivityBlock =
  | WorkspaceActivityTextBlock
  | WorkspaceActivityReasoningBlock
  | WorkspaceActivityToolBlock
  | WorkspaceActivityUnknownBlock

/** One queued, active, stopping, or recently settled employee activity. */
export interface WorkspaceActivity {
  readonly activityId: WorkspaceActivityId
  readonly agentId: AgentId
  readonly source: WorkspaceActivitySource
  readonly messageId: MessageId
  readonly startOrder: number
  readonly status: 'queued' | 'responding' | 'stopping' | 'settled'
  readonly claimed?: { readonly sessionId: SessionId; readonly turn: number }
  readonly blocks: readonly WorkspaceActivityBlock[]
  readonly terminalReason?: string
  readonly error?: WorkspaceActivityError
}

/** One agent's process-local execution summary. */
export interface WorkspaceAgentActivitySummary {
  readonly agentId: AgentId
  readonly status: 'idle' | 'active' | 'failed'
  readonly usingTool: boolean
  readonly error?: WorkspaceActivityError
}

/** Versioned snapshot used by cancellation-aware long polling. */
export interface WorkspaceActivitySnapshot {
  readonly version: number
  readonly workspaceRevision: number
  readonly activities: readonly WorkspaceActivity[]
  readonly agents: readonly WorkspaceAgentActivitySummary[]
}

/** Queue-time fields available before DSH assigns the delivery a turn. */
export interface QueueWorkspaceActivityInput {
  readonly agentId: AgentId
  readonly source: WorkspaceActivitySource
  readonly messageId: MessageId
}

/** Construction options for bounded settled-activity retention. */
export interface WorkspaceActivityStreamOptions {
  readonly settledLimit: number
}

/** Display-safe durable failure projected from Workspace task events. */
export interface WorkspaceActivityDurableFailure {
  readonly agentId: AgentId
  readonly error: WorkspaceActivityError
}

interface MutableActivity {
  activityId: WorkspaceActivityId
  agentId: AgentId
  source: WorkspaceActivitySource
  messageId: MessageId
  startOrder: number
  status: 'queued' | 'responding' | 'stopping' | 'settled'
  claimed?: { sessionId: SessionId; turn: number }
  blocks: WorkspaceActivityBlock[]
  terminalReason?: string
  error?: WorkspaceActivityError
}

interface Waiter {
  readonly resolve: (snapshot: WorkspaceActivitySnapshot) => void
  readonly reject: (reason: unknown) => void
  readonly signal: AbortSignal
  readonly abort: () => void
}

type JsonSafeValue = null | boolean | number | string | JsonSafeValue[] | { [key: string]: JsonSafeValue }

const DEFAULT_SETTLED_LIMIT = 32

/** In-memory owner for Workspace activity and failure summaries. */
export class WorkspaceActivityStream {
  private version = 0
  private workspaceRevision = 0
  private nextStartOrder = 1
  private readonly activities = new Map<WorkspaceActivityId, MutableActivity>()
  private readonly activityIdByMessage = new Map<MessageId, WorkspaceActivityId>()
  private readonly knownAgents = new Set<AgentId>()
  private readonly failures = new Map<AgentId, WorkspaceActivityError>()
  private readonly durableFailures = new Map<AgentId, WorkspaceActivityError>()
  private readonly waiters = new Set<Waiter>()
  private readonly settledLimit: number

  constructor(options: Partial<WorkspaceActivityStreamOptions> = {}) {
    const settledLimit = options.settledLimit ?? DEFAULT_SETTLED_LIMIT
    if (!Number.isSafeInteger(settledLimit) || settledLimit < 0) {
      throw new Error('workspace activity settled limit must be a non-negative integer')
    }
    this.settledLimit = settledLimit
  }

  /** Return a detached snapshot containing no runtime handles or error objects. */
  snapshot(): WorkspaceActivitySnapshot {
    const activities = [...this.activities.values()]
      .sort((left, right) => left.startOrder - right.startOrder)
      .map(activity => cloneActivity(activity))
    const agents = [...this.knownAgents].map(agentId => this.agentSummary(agentId))
    return { version: this.version, workspaceRevision: this.workspaceRevision, activities, agents }
  }

  /** Resolve after the stream advances beyond `afterVersion`. */
  wait(afterVersion: number, signal: AbortSignal): Promise<WorkspaceActivitySnapshot> {
    if (signal.aborted) return Promise.reject(abortError())
    if (this.version > afterVersion) return Promise.resolve(this.snapshot())

    return new Promise<WorkspaceActivitySnapshot>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        abort: () => {
          this.waiters.delete(waiter)
          signal.removeEventListener('abort', waiter.abort)
          reject(abortError())
        },
      }
      this.waiters.add(waiter)
      signal.addEventListener('abort', waiter.abort, { once: true })
    })
  }

  /** Publish a changed durable Workspace revision to subscribers. */
  setWorkspaceRevision(revision: number): void {
    if (this.workspaceRevision === revision) return
    this.workspaceRevision = revision
    this.publish()
  }

  /** Replace the agent roster and task failures re-derived from durable state. */
  setWorkspaceProjection(
    revision: number,
    agentIds: readonly AgentId[],
    failures: readonly WorkspaceActivityDurableFailure[],
  ): void {
    const nextAgents = new Set(agentIds)
    for (const activity of this.activities.values()) nextAgents.add(activity.agentId)
    for (const agentId of this.failures.keys()) nextAgents.add(agentId)
    const nextFailures = new Map(failures.map(failure => [failure.agentId, { ...failure.error }]))
    const changed = this.workspaceRevision !== revision
      || !sameSet(this.knownAgents, nextAgents)
      || !sameFailureMap(this.durableFailures, nextFailures)
    if (!changed) return
    this.workspaceRevision = revision
    this.knownAgents.clear()
    for (const agentId of nextAgents) this.knownAgents.add(agentId)
    this.durableFailures.clear()
    for (const [agentId, error] of nextFailures) this.durableFailures.set(agentId, error)
    this.publish()
  }

  /** Publish one delivery before DSH claims its Session turn. */
  queue(input: QueueWorkspaceActivityInput): WorkspaceActivityId {
    const currentId = this.activityIdByMessage.get(input.messageId)
    if (currentId !== undefined) {
      const current = this.activities.get(currentId)
      if (current === undefined) throw new Error(`activity '${currentId}' has no queued record`)
      if (current.agentId !== input.agentId) throw new Error(`message '${input.messageId}' is queued for another agent`)
      if (!sameSource(current.source, input.source)) throw new Error(`message '${input.messageId}' is queued for another source`)
      return currentId
    }

    const activityId = WorkspaceActivityId(`workspace-activity:${input.messageId}`)
    this.knownAgents.add(input.agentId)
    this.activities.set(activityId, {
      activityId,
      agentId: input.agentId,
      source: cloneSource(input.source),
      messageId: input.messageId,
      startOrder: this.nextStartOrder++,
      status: 'queued',
      blocks: [],
    })
    this.activityIdByMessage.set(input.messageId, activityId)
    this.publish()
    return activityId
  }

  /** Bind the exact Session turn assigned by `agent/inbox/claimed`. */
  claim(identity: WorkspaceActivityIdentity): void {
    const activity = this.requireActivity(identity.activityId)
    if (activity.agentId !== identity.agentId) throw new Error(`activity '${identity.activityId}' agent does not match its queued record`)
    if (activity.messageId !== identity.messageId) throw new Error(`activity '${identity.activityId}' message does not match its queued record`)
    if (activity.claimed !== undefined) {
      if (activity.claimed.sessionId !== identity.sessionId || activity.claimed.turn !== identity.turn) {
        throw new Error(`activity '${identity.activityId}' is already bound to another Session turn`)
      }
      return
    }
    if (activity.status !== 'queued') throw new Error(`activity '${identity.activityId}' is not queued`)
    activity.claimed = { sessionId: identity.sessionId, turn: identity.turn }
    activity.status = 'responding'
    this.publish()
  }

  /** Mark one claimed activity as stopping using its complete identity. */
  markStopping(identity: WorkspaceActivityIdentity): void {
    const activity = this.requireClaimed(identity)
    if (activity.status === 'settled' || activity.status === 'stopping') return
    activity.status = 'stopping'
    this.publish()
  }

  /** Fold one authoritative Session event into its claimed activity. */
  acceptSessionEvent(input: WorkspaceActivityIdentity & { readonly event: SessionEvent }): void {
    const activity = this.requireClaimed(input)
    if (activity.status === 'settled') return
    const data = recordOf(input.event.data)
    if (integerOf(data?.turn) !== input.turn) return

    let changed = false
    switch (input.event.type) {
      case 'assistant/message':
        changed = this.acceptAssistantMessage(activity, data)
        break
      case 'tool/call':
        changed = this.acceptToolCall(activity, data)
        break
      case 'tool/result':
        changed = this.acceptToolResult(activity, data)
        break
      case 'turn/end':
        changed = this.acceptTurnEnd(activity, data)
        break
      default:
        return
    }
    if (!changed) return
    this.retireSettledOverflow()
    this.publish()
  }

  /** Fold one process-local assistant chunk into its claimed activity. */
  acceptAssistantFrame(input: WorkspaceActivityIdentity & { readonly frame: AssistantStreamFrame }): void {
    if (input.frame.type !== 'chunk') return
    const activity = this.requireClaimed(input)
    if (activity.status === 'settled') return
    if (!this.acceptAssistantChunk(activity, { chunk: input.frame.chunk })) return
    this.publish()
  }

  /** Remove a queued activity and retain its explicitly display-safe failure. */
  discard(activityId: WorkspaceActivityId, error: WorkspaceActivityError): void {
    const activity = this.activities.get(activityId)
    if (activity === undefined) return
    this.activities.delete(activityId)
    this.activityIdByMessage.delete(activity.messageId)
    this.knownAgents.add(activity.agentId)
    this.failures.set(activity.agentId, { ...error })
    this.publish()
  }

  /** Retain a process-local failure until the browser acknowledges it. */
  recordAgentFailure(agentId: AgentId, error: WorkspaceActivityError): void {
    const next = { ...error }
    this.knownAgents.add(agentId)
    const current = this.failures.get(agentId)
    if (current?.code === next.code && current.summary === next.summary) return
    this.failures.set(agentId, next)
    this.publish()
  }

  /** Retain a fallback failure only when no more specific process failure exists. */
  recordAgentFailureIfAbsent(agentId: AgentId, error: WorkspaceActivityError): void {
    if (this.failures.has(agentId)) return
    this.recordAgentFailure(agentId, error)
  }

  /** Clear one process-local failure without changing durable Workspace history. */
  acknowledgeAgentFailure(agentId: AgentId): void {
    if (!this.failures.delete(agentId)) return
    this.publish()
  }

  /** Remove one settled activity after its durable Workspace projection converges. */
  retire(identity: WorkspaceActivityIdentity, workspaceRevision?: number): void {
    const activity = this.activities.get(identity.activityId)
    let removed = false
    if (activity !== undefined) {
      this.assertIdentity(activity, identity)
      removed = this.removeActivity(activity)
    }
    const revisionChanged = workspaceRevision !== undefined && workspaceRevision !== this.workspaceRevision
    if (workspaceRevision !== undefined) this.workspaceRevision = workspaceRevision
    if (removed || revisionChanged) this.publish()
  }

  private agentSummary(agentId: AgentId): WorkspaceAgentActivitySummary {
    const error = this.failures.get(agentId) ?? this.durableFailures.get(agentId)
    const active = [...this.activities.values()].some(activity => (
      activity.agentId === agentId && activity.status !== 'settled'
    ))
    const usingTool = [...this.activities.values()].some(activity => (
      activity.agentId === agentId
      && (activity.status === 'responding' || activity.status === 'stopping')
      && activity.blocks.some(block => block.kind === 'tool' && block.status === 'running')
    ))
    if (error !== undefined) return { agentId, status: 'failed', usingTool, error: { ...error } }
    return { agentId, status: active ? 'active' : 'idle', usingTool }
  }

  private requireActivity(activityId: WorkspaceActivityId): MutableActivity {
    const activity = this.activities.get(activityId)
    if (activity === undefined) throw new Error(`workspace activity '${activityId}' does not exist`)
    return activity
  }

  private requireClaimed(identity: WorkspaceActivityIdentity): MutableActivity {
    const activity = this.requireActivity(identity.activityId)
    this.assertIdentity(activity, identity)
    return activity
  }

  private assertIdentity(activity: MutableActivity, identity: WorkspaceActivityIdentity): void {
    if (activity.agentId !== identity.agentId) throw new Error(`activity '${identity.activityId}' agent does not match`)
    if (activity.messageId !== identity.messageId) throw new Error(`activity '${identity.activityId}' message does not match`)
    if (activity.claimed?.sessionId !== identity.sessionId || activity.claimed.turn !== identity.turn) {
      throw new Error(`activity '${identity.activityId}' Session turn does not match`)
    }
  }

  private acceptAssistantChunk(activity: MutableActivity, data: Record<string, unknown> | undefined): boolean {
    const chunk = recordOf(data?.chunk)
    const type = stringOf(chunk?.type)
    const index = integerOf(chunk?.index) ?? activity.blocks.length
    if (type === 'text-delta') return appendTextLike(activity, index, 'text', stringOf(chunk?.text) ?? '')
    if (type === 'reasoning-delta') return appendTextLike(activity, index, 'reasoning', stringOf(chunk?.text) ?? '')
    if (type !== 'tool-call-delta') return false

    const existing = toolAt(activity, index)
    const next: WorkspaceActivityToolBlock = {
      kind: 'tool',
      index,
      callId: stringOf(chunk?.id) ?? existing?.callId ?? `tool-${index}`,
      name: stringOf(chunk?.name) ?? existing?.name ?? '',
      arguments: `${existing?.arguments ?? ''}${stringOf(chunk?.argumentsDelta) ?? stringOf(chunk?.arguments) ?? ''}`,
      status: existing?.status ?? 'running',
      ...(existing?.resultText === undefined ? {} : { resultText: existing.resultText }),
      ...(existing?.error === undefined ? {} : { error: existing.error }),
    }
    return replaceBlock(activity, index, next)
  }

  private acceptAssistantMessage(activity: MutableActivity, data: Record<string, unknown> | undefined): boolean {
    const message = recordOf(data?.message)
    const content = Array.isArray(message?.content) ? message.content : []
    let changed = false
    for (let index = 0; index < content.length; index++) {
      const block = recordOf(content[index])
      const type = stringOf(block?.type)
      if (type === 'text') {
        const current = activity.blocks.find(candidate => candidate.kind === 'text' && candidate.index === index)
        if (current === undefined) changed = replaceBlock(activity, index, { kind: 'text', index, text: stringOf(block?.text) ?? '' }) || changed
      } else if (type === 'reasoning') {
        const current = activity.blocks.find(candidate => candidate.kind === 'reasoning' && candidate.index === index)
        if (current === undefined) changed = replaceBlock(activity, index, { kind: 'reasoning', index, text: stringOf(block?.text) ?? '' }) || changed
      } else if (type === 'tool-call') {
        const callId = stringOf(block?.id) ?? stringOf(block?.toolCallId) ?? `tool-${index}`
        const existing = activity.blocks.find((candidate): candidate is WorkspaceActivityToolBlock => candidate.kind === 'tool' && candidate.callId === callId)
        if (existing === undefined) {
          changed = replaceBlock(activity, index, {
            kind: 'tool', index, callId, name: stringOf(block?.name) ?? '', arguments: stringOf(block?.arguments) ?? '', status: 'running',
          }) || changed
        }
      }
    }
    return changed
  }

  private acceptToolCall(activity: MutableActivity, data: Record<string, unknown> | undefined): boolean {
    const callId = stringOf(data?.callId)
    if (callId === undefined) return false
    const existing = activity.blocks.find((candidate): candidate is WorkspaceActivityToolBlock => candidate.kind === 'tool' && candidate.callId === callId)
    const index = existing?.index ?? nextToolIndex(activity)
    return replaceBlock(activity, index, {
      kind: 'tool',
      index,
      callId,
      name: stringOf(data?.name) ?? existing?.name ?? '',
      arguments: stringOf(data?.arguments) ?? existing?.arguments ?? '',
      status: existing?.status ?? 'running',
      ...(existing?.resultText === undefined ? {} : { resultText: existing.resultText }),
      ...(existing?.error === undefined ? {} : { error: existing.error }),
    })
  }

  private acceptToolResult(activity: MutableActivity, data: Record<string, unknown> | undefined): boolean {
    const message = recordOf(data?.message)
    const source = recordOf(message?.source)
    const content = Array.isArray(message?.content) ? message.content : []
    const first = recordOf(content[0])
    const callId = stringOf(source?.callId) ?? stringOf(first?.toolCallId)
    if (callId === undefined) return false

    const existing = activity.blocks.find((candidate): candidate is WorkspaceActivityToolBlock => candidate.kind === 'tool' && candidate.callId === callId)
    const index = existing?.index ?? nextToolIndex(activity)
    const resultText = toolResultText(content)
    const isError = message?.isError === true || first?.isError === true || data?.error !== undefined
    return replaceBlock(activity, index, {
      kind: 'tool',
      index,
      callId,
      name: existing?.name ?? '',
      arguments: existing?.arguments ?? '',
      status: isError ? 'failed' : 'completed',
      ...(!isError && resultText !== '' ? { resultText } : {}),
      ...(isError ? { error: { code: 'tool-failed', summary: 'Tool call failed.' } } : {}),
    })
  }

  private acceptTurnEnd(activity: MutableActivity, data: Record<string, unknown> | undefined): boolean {
    const reason = recordOf(data?.reason)
    const terminalReason = stringOf(reason?.kind) ?? 'completed'
    const error = terminalReason === 'error'
      ? { code: 'agent-turn-failed', summary: 'Agent turn failed.' }
      : undefined
    const changed = activity.status !== 'settled'
      || activity.terminalReason !== terminalReason
      || !sameError(activity.error, error)
    activity.status = 'settled'
    activity.terminalReason = terminalReason
    if (error === undefined) delete activity.error
    else {
      activity.error = error
      this.failures.set(activity.agentId, error)
    }
    return changed
  }

  private retireSettledOverflow(): void {
    const settled = [...this.activities.values()]
      .filter(activity => activity.status === 'settled')
      .sort((left, right) => left.startOrder - right.startOrder)
    for (const activity of settled.slice(0, Math.max(0, settled.length - this.settledLimit))) {
      this.removeActivity(activity)
    }
  }

  private removeActivity(activity: MutableActivity): boolean {
    this.activityIdByMessage.delete(activity.messageId)
    return this.activities.delete(activity.activityId)
  }

  private publish(): void {
    this.version++
    if (this.waiters.size === 0) return
    const snapshot = this.snapshot()
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter)
      waiter.signal.removeEventListener('abort', waiter.abort)
      waiter.resolve(snapshot)
    }
  }
}

function appendTextLike(activity: MutableActivity, index: number, kind: 'text' | 'reasoning', delta: string): boolean {
  if (delta === '') return false
  const existing = activity.blocks.find(block => block.kind === kind && block.index === index)
  const previous = existing !== undefined && (existing.kind === 'text' || existing.kind === 'reasoning') ? existing.text : ''
  return replaceBlock(activity, index, { kind, index, text: `${previous}${delta}` })
}

function toolAt(activity: MutableActivity, index: number): WorkspaceActivityToolBlock | undefined {
  const block = activity.blocks.find(candidate => candidate.kind === 'tool' && candidate.index === index)
  return block?.kind === 'tool' ? block : undefined
}

function nextToolIndex(activity: MutableActivity): number {
  if (activity.blocks.length === 0) return 0
  return Math.max(...activity.blocks.map(block => block.index)) + 1
}

function replaceBlock(activity: MutableActivity, index: number, next: WorkspaceActivityBlock): boolean {
  const position = activity.blocks.findIndex(block => block.index === index)
  if (position < 0) {
    activity.blocks.push(next)
    activity.blocks.sort((left, right) => left.index - right.index)
    return true
  }
  const current = activity.blocks[position]
  if (current !== undefined && JSON.stringify(current) === JSON.stringify(next)) return false
  activity.blocks[position] = next
  activity.blocks.sort((left, right) => left.index - right.index)
  return true
}

function toolResultText(content: readonly unknown[]): string {
  const parts: string[] = []
  for (const rawBlock of content) {
    const block = recordOf(rawBlock)
    if (block === undefined) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    if (block.type !== 'tool-result') continue
    const nested = Array.isArray(block.content) ? block.content : []
    for (const rawNested of nested) {
      const item = recordOf(rawNested)
      if (item?.type === 'text' && typeof item.text === 'string') parts.push(item.text)
    }
  }
  return parts.join('\n')
}

function sameError(left: WorkspaceActivityError | undefined, right: WorkspaceActivityError | undefined): boolean {
  return left?.code === right?.code && left?.summary === right?.summary
}

function sameSet<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  return left.size === right.size && [...left].every(value => right.has(value))
}

function sameFailureMap(
  left: ReadonlyMap<AgentId, WorkspaceActivityError>,
  right: ReadonlyMap<AgentId, WorkspaceActivityError>,
): boolean {
  if (left.size !== right.size) return false
  return [...left].every(([agentId, error]) => sameError(error, right.get(agentId)))
}

function sameSource(left: WorkspaceActivitySource, right: WorkspaceActivitySource): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'room' && right.kind === 'room') return left.roomId === right.roomId
  return left.kind === 'task' && right.kind === 'task'
    && left.taskId === right.taskId && left.attemptId === right.attemptId
}

function cloneSource(source: WorkspaceActivitySource): WorkspaceActivitySource {
  return source.kind === 'room'
    ? { kind: 'room', roomId: source.roomId }
    : { kind: 'task', taskId: source.taskId, attemptId: source.attemptId }
}

function cloneActivity(activity: MutableActivity): WorkspaceActivity {
  return structuredClone(activity)
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function integerOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

function abortError(): Error {
  const error = new Error('agent workspace activity wait aborted')
  error.name = 'AbortError'
  return error
}
