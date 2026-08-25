/**
 * Ephemeral projection of live employee turns for the Agent Workspace browser.
 * The durable source of truth remains the workspace room-event log; this stream
 * only mirrors authoritative DSH Session events while a turn is in flight.
 * @module @dsh-agent-group/host/turn-stream
 */

import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { AgentId, RoomId } from './ids.ts'

/** A text block assembled from one or more token deltas. */
export interface WorkspaceTurnTextBlock {
  readonly kind: 'text'
  readonly index: number
  readonly text: string
}

/** A reasoning block assembled from one or more reasoning deltas. */
export interface WorkspaceTurnReasoningBlock {
  readonly kind: 'reasoning'
  readonly index: number
  readonly text: string
}

/** A projected tool invocation and its eventual result. */
export interface WorkspaceTurnToolBlock {
  readonly kind: 'tool'
  readonly index: number
  readonly callId: string
  readonly name: string
  readonly arguments: string
  readonly status: 'running' | 'completed' | 'failed'
  readonly resultText?: string
  readonly error?: string
}

/** Forward-compatible fallback for a displayable but unknown block. */
export interface WorkspaceTurnUnknownBlock {
  readonly kind: 'unknown'
  readonly index: number
  readonly label: string
  readonly value: JsonSafeValue
}

/** Ordered display blocks projected for one live turn. */
export type WorkspaceTurnBlock =
  | WorkspaceTurnTextBlock
  | WorkspaceTurnReasoningBlock
  | WorkspaceTurnToolBlock
  | WorkspaceTurnUnknownBlock

/** Stable identity shared by the tracker, dispatcher and stream retirement path. */
export interface WorkspaceTurnIdentity {
  readonly roomId: RoomId
  readonly agentId: AgentId
  readonly sessionId: SessionId
  readonly turn: number
}

/** One live/settled employee turn exposed to the Browser. */
export interface WorkspaceTurnProjection extends WorkspaceTurnIdentity {
  readonly status: 'running' | 'settled'
  readonly blocks: readonly WorkspaceTurnBlock[]
  readonly stopReason?: string
  readonly error?: string
}

/** Versioned snapshot used by the cancellation-aware long-poll transport. */
export interface WorkspaceTurnStreamSnapshot {
  readonly version: number
  readonly workspaceRevision: number
  readonly turns: readonly WorkspaceTurnProjection[]
}

interface MutableTurnProjection {
  roomId: RoomId
  agentId: AgentId
  sessionId: SessionId
  turn: number
  status: 'running' | 'settled'
  blocks: WorkspaceTurnBlock[]
  stopReason?: string
  error?: string
}

interface Waiter {
  readonly resolve: (snapshot: WorkspaceTurnStreamSnapshot) => void
  readonly reject: (reason: unknown) => void
  readonly signal: AbortSignal
  readonly abort: () => void
}

type JsonSafeValue = null | boolean | number | string | JsonSafeValue[] | { [key: string]: JsonSafeValue }

/**
 * In-memory event projection for active Workspace turns. It intentionally owns
 * no persistence and therefore cannot alter durable room or Session history.
 */
export class WorkspaceTurnStream {
  private version = 0
  private workspaceRevision = 0
  private readonly turns = new Map<string, MutableTurnProjection>()
  private readonly waiters = new Set<Waiter>()

  /** Return a detached, JSON-safe snapshot. */
  snapshot(): WorkspaceTurnStreamSnapshot {
    return {
      version: this.version,
      workspaceRevision: this.workspaceRevision,
      turns: [...this.turns.values()].map(turn => cloneTurn(turn)),
    }
  }

  /**
   * Resolve after the stream advances beyond `afterVersion`. Callers normally
   * reissue the wait immediately, producing event-driven long polling without
   * a browser interval timer.
   */
  wait(afterVersion: number, signal: AbortSignal): Promise<WorkspaceTurnStreamSnapshot> {
    if (signal.aborted) return Promise.reject(abortError())
    if (this.version > afterVersion) return Promise.resolve(this.snapshot())

    return new Promise<WorkspaceTurnStreamSnapshot>((resolve, reject) => {
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

  /** Begin (or idempotently re-observe) one room-backed employee turn. */
  begin(input: WorkspaceTurnIdentity): void {
    const key = turnKey(input)
    const current = this.turns.get(key)
    if (current !== undefined) return
    this.turns.set(key, {
      roomId: input.roomId,
      agentId: input.agentId,
      sessionId: input.sessionId,
      turn: input.turn,
      status: 'running',
      blocks: [],
    })
    this.publish()
  }

  /** Fold one authoritative Session event into its active Workspace turn. */
  acceptSessionEvent(input: Omit<WorkspaceTurnIdentity, 'turn'> & { readonly event: SessionEvent }): void {
    const data = recordOf(input.event.data)
    const turn = integerOf(data?.turn)
    if (turn === undefined) return
    const key = turnKey({ ...input, turn })
    const projection = this.turns.get(key)
    if (projection === undefined) return

    let changed = false
    switch (input.event.type) {
      case 'assistant/chunk':
        changed = this.acceptAssistantChunk(projection, data)
        break
      case 'assistant/message':
        changed = this.acceptAssistantMessage(projection, data)
        break
      case 'tool/call':
        changed = this.acceptToolCall(projection, data)
        break
      case 'tool/result':
        changed = this.acceptToolResult(projection, data)
        break
      case 'turn/end':
        changed = this.acceptTurnEnd(projection, data)
        break
      default:
        return
    }
    if (changed) this.publish()
  }

  /** Remove one transient turn after its durable room projection has converged. */
  retire(input: WorkspaceTurnIdentity, workspaceRevision?: number): void {
    const removed = this.turns.delete(turnKey(input))
    const revisionChanged = workspaceRevision !== undefined && workspaceRevision !== this.workspaceRevision
    if (workspaceRevision !== undefined) this.workspaceRevision = workspaceRevision
    if (removed || revisionChanged) this.publish()
  }

  private acceptAssistantChunk(projection: MutableTurnProjection, data: Record<string, unknown> | undefined): boolean {
    const chunk = recordOf(data?.chunk)
    const type = stringOf(chunk?.type)
    const index = integerOf(chunk?.index) ?? projection.blocks.length
    if (type === 'text-delta') {
      const delta = stringOf(chunk?.text) ?? ''
      return appendTextLike(projection, index, 'text', delta)
    }
    if (type === 'reasoning-delta') {
      const delta = stringOf(chunk?.text) ?? ''
      return appendTextLike(projection, index, 'reasoning', delta)
    }
    if (type === 'tool-call-delta') {
      const callId = stringOf(chunk?.id) ?? toolAt(projection, index)?.callId ?? `tool-${index}`
      const existing = toolAt(projection, index)
      const name = stringOf(chunk?.name) ?? existing?.name ?? ''
      const delta = stringOf(chunk?.argumentsDelta) ?? stringOf(chunk?.arguments) ?? ''
      const next: WorkspaceTurnToolBlock = {
        kind: 'tool',
        index,
        callId,
        name,
        arguments: `${existing?.arguments ?? ''}${delta}`,
        status: existing?.status ?? 'running',
        ...(existing?.resultText === undefined ? {} : { resultText: existing.resultText }),
        ...(existing?.error === undefined ? {} : { error: existing.error }),
      }
      return replaceBlock(projection, index, next)
    }
    return false
  }

  private acceptAssistantMessage(projection: MutableTurnProjection, data: Record<string, unknown> | undefined): boolean {
    const message = recordOf(data?.message)
    const content = Array.isArray(message?.content) ? message.content : []
    let changed = false
    for (let index = 0; index < content.length; index++) {
      const block = recordOf(content[index])
      const type = stringOf(block?.type)
      if (type === 'text') {
        const current = projection.blocks.find(candidate => candidate.kind === 'text' && candidate.index === index)
        if (current === undefined) changed = replaceBlock(projection, index, { kind: 'text', index, text: stringOf(block?.text) ?? '' }) || changed
      } else if (type === 'reasoning') {
        const current = projection.blocks.find(candidate => candidate.kind === 'reasoning' && candidate.index === index)
        if (current === undefined) changed = replaceBlock(projection, index, { kind: 'reasoning', index, text: stringOf(block?.text) ?? '' }) || changed
      } else if (type === 'tool-call') {
        const callId = stringOf(block?.id) ?? stringOf(block?.toolCallId) ?? `tool-${index}`
        const existing = projection.blocks.find((candidate): candidate is WorkspaceTurnToolBlock => candidate.kind === 'tool' && candidate.callId === callId)
        if (existing === undefined) {
          changed = replaceBlock(projection, index, {
            kind: 'tool',
            index,
            callId,
            name: stringOf(block?.name) ?? '',
            arguments: stringOf(block?.arguments) ?? '',
            status: 'running',
          }) || changed
        }
      }
    }
    return changed
  }

  private acceptToolCall(projection: MutableTurnProjection, data: Record<string, unknown> | undefined): boolean {
    const callId = stringOf(data?.callId)
    if (callId === undefined) return false
    const existing = projection.blocks.find((candidate): candidate is WorkspaceTurnToolBlock => candidate.kind === 'tool' && candidate.callId === callId)
    const index = existing?.index ?? nextToolIndex(projection)
    const next: WorkspaceTurnToolBlock = {
      kind: 'tool',
      index,
      callId,
      name: stringOf(data?.name) ?? existing?.name ?? '',
      arguments: stringOf(data?.arguments) ?? existing?.arguments ?? '',
      status: existing?.status ?? 'running',
      ...(existing?.resultText === undefined ? {} : { resultText: existing.resultText }),
      ...(existing?.error === undefined ? {} : { error: existing.error }),
    }
    return replaceBlock(projection, index, next)
  }

  private acceptToolResult(projection: MutableTurnProjection, data: Record<string, unknown> | undefined): boolean {
    const message = recordOf(data?.message)
    const source = recordOf(message?.source)
    const content = Array.isArray(message?.content) ? message.content : []
    const first = recordOf(content[0])
    const callId = stringOf(source?.callId) ?? stringOf(first?.toolCallId)
    if (callId === undefined) return false

    const existing = projection.blocks.find((candidate): candidate is WorkspaceTurnToolBlock => candidate.kind === 'tool' && candidate.callId === callId)
    const index = existing?.index ?? nextToolIndex(projection)
    const resultText = toolResultText(content)
    const isError = first?.isError === true || data?.error !== undefined
    const failure = recordOf(data?.error)
    const error = isError
      ? (stringOf(failure?.message) ?? stringOf(failure?.name) ?? (resultText === '' ? 'Tool call failed.' : resultText))
      : undefined
    const next: WorkspaceTurnToolBlock = {
      kind: 'tool',
      index,
      callId,
      name: existing?.name ?? '',
      arguments: existing?.arguments ?? '',
      status: isError ? 'failed' : 'completed',
      ...(resultText === '' ? {} : { resultText }),
      ...(error === undefined ? {} : { error }),
    }
    return replaceBlock(projection, index, next)
  }

  private acceptTurnEnd(projection: MutableTurnProjection, data: Record<string, unknown> | undefined): boolean {
    const reason = recordOf(data?.reason)
    const stopReason = stringOf(reason?.kind) ?? 'completed'
    const failure = recordOf(reason?.error)
    const error = stopReason === 'error' ? (stringOf(failure?.message) ?? 'Agent turn failed.') : undefined
    const changed = projection.status !== 'settled' || projection.stopReason !== stopReason || projection.error !== error
    projection.status = 'settled'
    projection.stopReason = stopReason
    if (error === undefined) delete projection.error
    else projection.error = error
    return changed
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

function turnKey(input: WorkspaceTurnIdentity): string {
  return `${input.sessionId}:${input.turn}:${input.roomId}:${input.agentId}`
}

function appendTextLike(
  projection: MutableTurnProjection,
  index: number,
  kind: 'text' | 'reasoning',
  delta: string,
): boolean {
  if (delta === '') return false
  let previous = ''
  if (kind === 'text') {
    const existing = projection.blocks.find((candidate): candidate is WorkspaceTurnTextBlock => (
      candidate.kind === 'text' && candidate.index === index
    ))
    previous = existing?.text ?? ''
  } else {
    const existing = projection.blocks.find((candidate): candidate is WorkspaceTurnReasoningBlock => (
      candidate.kind === 'reasoning' && candidate.index === index
    ))
    previous = existing?.text ?? ''
  }
  return replaceBlock(projection, index, { kind, index, text: `${previous}${delta}` })
}

function toolAt(projection: MutableTurnProjection, index: number): WorkspaceTurnToolBlock | undefined {
  const block = projection.blocks.find(candidate => candidate.kind === 'tool' && candidate.index === index)
  return block?.kind === 'tool' ? block : undefined
}

function nextToolIndex(projection: MutableTurnProjection): number {
  if (projection.blocks.length === 0) return 0
  return Math.max(...projection.blocks.map(block => block.index)) + 1
}

function replaceBlock(projection: MutableTurnProjection, index: number, next: WorkspaceTurnBlock): boolean {
  const position = projection.blocks.findIndex(block => block.index === index)
  if (position < 0) {
    projection.blocks.push(next)
    projection.blocks.sort((left, right) => left.index - right.index)
    return true
  }
  const current = projection.blocks[position]
  if (current !== undefined && JSON.stringify(current) === JSON.stringify(next)) return false
  projection.blocks[position] = next
  projection.blocks.sort((left, right) => left.index - right.index)
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

function cloneTurn(turn: MutableTurnProjection): WorkspaceTurnProjection {
  return JSON.parse(JSON.stringify(turn)) as WorkspaceTurnProjection
}

function abortError(): Error {
  const error = new Error('agent workspace stream wait aborted')
  error.name = 'AbortError'
  return error
}
