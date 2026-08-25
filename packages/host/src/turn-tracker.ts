/**
 * Correlates one workspace delivery with the agent turn it opens and the
 * assistant reply that turn produces. One tracker instance serves one agent:
 * `install` registers the agent-scoped listeners, `deliver` submits a delivery
 * (and optional recall) and resolves when the owning turn closes.
 * @module @dsh-agent-group/host/turn-tracker
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { AgentId, RoomId } from './ids.ts'
import type { WorkspaceTurnIdentity, WorkspaceTurnStream } from './turn-stream.ts'

/** The terminal reply captured for one delivery. */
export interface DeliveryOutcome {
  /** Last non-empty assistant content the delivery's turn produced. */
  readonly output: ContentBlock[]
  /** Why the owning turn closed, from its merge-extensible `TurnEndReason.kind`. */
  readonly stopReason: string
  /** Exact transient Workspace turn, present only for room-backed deliveries. */
  readonly workspaceTurn?: WorkspaceTurnIdentity
}

interface PendingDelivery {
  readonly messageId: MessageId
  readonly recall: UserMessage | undefined
  readonly roomId: RoomId | undefined
  turn: number | undefined
  output: ContentBlock[]
  resolve: (outcome: DeliveryOutcome) => void
  reject: (reason: unknown) => void
}

/** Optional Workspace stream identity for one per-agent tracker. */
export interface WorkspaceTurnTrackerOptions {
  readonly agentId: AgentId
  readonly sessionId: SessionId
  readonly stream: WorkspaceTurnStream
}

/** A permissive event-source view used only to register scoped listeners. */
interface ScopedEvents {
  on(event: string, listener: (...args: never[]) => unknown): () => void
}

/** The `agent/pre-step` waterfall decision the recall listener rewrites. */
interface PreStepEnter {
  kind: 'enter'
  messages: UserMessage[]
}

/**
 * Per-agent delivery-to-reply tracker. Listeners are registered on the agent's
 * scoped context, so turns from other agents never reach this instance.
 */
export class WorkspaceTurnTracker {
  private readonly byMessage = new Map<MessageId, PendingDelivery>()
  private readonly byTurn = new Map<number, PendingDelivery>()

  constructor(private readonly options?: WorkspaceTurnTrackerOptions) {}

  /** Register this tracker's listeners on one agent's scoped context. */
  install(agentCtx: Context): void {
    const events = agentCtx as unknown as ScopedEvents

    events.on('agent/inbox/claimed', ((payload: { message: UserMessage; turn: number }) => {
      const pending = this.byMessage.get(payload.message.id)
      if (pending === undefined) return
      pending.turn = payload.turn
      this.byTurn.set(payload.turn, pending)
      if (pending.roomId !== undefined && this.options !== undefined) {
        this.options.stream.begin({
          roomId: pending.roomId,
          agentId: this.options.agentId,
          sessionId: this.options.sessionId,
          turn: payload.turn,
        })
      }
    }) as never)

    events.on('agent/inbox/discarded', ((payload: { message: UserMessage }) => {
      const pending = this.byMessage.get(payload.message.id)
      if (pending === undefined) return
      this.settleRejected(pending, new Error('delivery discarded before its turn was claimed'))
    }) as never)

    events.on('agent/disposed', (() => {
      for (const pending of [...this.byMessage.values()]) {
        this.settleRejected(pending, new Error('agent disposed before the delivery settled'))
      }
    }) as never)

    // The recall listener runs after downstream admission and inserts the
    // pending recall immediately after the delivery that owns it.
    events.on('agent/pre-step', (async (_payload: { messages: UserMessage[] }, next: () => Promise<PreStepEnter>) => {
      const decision = await next()
      if (decision.kind !== 'enter') return decision
      const index = decision.messages.findIndex(message => this.byMessage.has(message.id))
      if (index < 0) return decision
      const delivery = decision.messages[index]
      if (delivery === undefined) return decision
      const pending = this.byMessage.get(delivery.id)
      if (pending === undefined || pending.recall === undefined) return decision
      return {
        kind: 'enter',
        messages: [...decision.messages.slice(0, index + 1), pending.recall, ...decision.messages.slice(index + 1)],
      }
    }) as never)

    events.on('session/event', ((_session: unknown, event: SessionEvent) => {
      const data = event.data as { turn?: number; message?: { content?: ContentBlock[] }; reason?: { kind?: string } }
      if (typeof data.turn !== 'number') return
      const pending = this.byTurn.get(data.turn)
      if (pending === undefined) return

      if (event.type === 'assistant/message') {
        const content = data.message?.content
        if (content !== undefined && content.length > 0) pending.output = content
      }

      if (pending.roomId !== undefined && this.options !== undefined) {
        this.options.stream.acceptSessionEvent({
          roomId: pending.roomId,
          agentId: this.options.agentId,
          sessionId: this.options.sessionId,
          event,
        })
      }

      if (event.type === 'turn/end') {
        this.byTurn.delete(data.turn)
        this.byMessage.delete(pending.messageId)
        const workspaceTurn = pending.roomId !== undefined && this.options !== undefined
          ? {
              roomId: pending.roomId,
              agentId: this.options.agentId,
              sessionId: this.options.sessionId,
              turn: data.turn,
            }
          : undefined
        pending.resolve({
          output: pending.output,
          stopReason: data.reason?.kind ?? 'completed',
          ...(workspaceTurn === undefined ? {} : { workspaceTurn }),
        })
      }
    }) as never)
  }

  /**
   * Submit one delivery to the agent and resolve when its turn closes. The
   * optional recall is injected by the `agent/pre-step` listener right after
   * the delivery message, so it lands in the same durable turn. A synchronous
   * inbox-admission error removes the pending correlation before rejecting.
   * @param agent - the live agent receiving the delivery.
   * @param delivery - the waking user message.
   * @param recall - optional model-visible context injected after the delivery.
   * @param roomId - owning Workspace room; absent for non-room tasks/children.
   * @returns the terminal reply outcome.
   */
  deliver(agent: Agent, delivery: UserMessage, recall?: UserMessage, roomId?: RoomId): Promise<DeliveryOutcome> {
    return new Promise<DeliveryOutcome>((resolve, reject) => {
      const pending: PendingDelivery = {
        messageId: delivery.id,
        recall,
        roomId,
        turn: undefined,
        output: [],
        resolve,
        reject,
      }
      this.byMessage.set(delivery.id, pending)
      try {
        agent.followup(delivery)
      } catch (error) {
        this.settleRejected(pending, error)
      }
    })
  }

  private settleRejected(pending: PendingDelivery, reason: unknown): void {
    this.byMessage.delete(pending.messageId)
    if (pending.turn !== undefined) this.byTurn.delete(pending.turn)
    pending.reject(reason)
  }
}
