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
import type { SessionEvent, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { AgentId, WorkspaceActivityId } from './ids.ts'
import type { WorkspaceActivityIdentity, WorkspaceActivitySource, WorkspaceActivityStream } from './activity-stream.ts'

/** The terminal Workspace reply captured for one delivery. */
export interface WorkspaceTurnOutcome {
  /** Last non-empty assistant content the delivery's turn produced. */
  readonly output: ContentBlock[]
  /** Authoritative merge-extensible DSH reason that closed the owning turn. */
  readonly stopReason: TurnEndReason
  /** Whether the captured output is the prefix of an interrupted assistant message. */
  readonly interrupted: boolean
  /** Exact transient Workspace activity, present for room and task deliveries. */
  readonly workspaceActivity?: WorkspaceActivityIdentity
}

interface PendingDelivery {
  readonly messageId: MessageId
  readonly recall: UserMessage | undefined
  readonly source: WorkspaceActivitySource | undefined
  readonly activityId: WorkspaceActivityId | undefined
  activity: WorkspaceActivityIdentity | undefined
  turn: number | undefined
  output: ContentBlock[]
  interrupted: boolean
  settled: boolean
  resolve: (outcome: WorkspaceTurnOutcome) => void
  reject: (reason: unknown) => void
}

/** Optional Workspace stream identity for one per-agent tracker. */
export interface WorkspaceTurnTrackerOptions {
  readonly agentId: AgentId
  readonly sessionId: SessionId
  readonly stream: WorkspaceActivityStream
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
      if (pending.activityId !== undefined && this.options !== undefined) {
        const identity: WorkspaceActivityIdentity = {
          activityId: pending.activityId,
          agentId: this.options.agentId,
          messageId: pending.messageId,
          sessionId: this.options.sessionId,
          turn: payload.turn,
        }
        this.options.stream.claim(identity)
        pending.activity = identity
      }
    }) as never)

    events.on('agent/inbox/discarded', ((payload: { message: UserMessage }) => {
      const pending = this.byMessage.get(payload.message.id)
      if (pending === undefined) return
      this.settleRejected(pending, new Error('delivery discarded before its turn was claimed'), 'delivery-discarded')
    }) as never)

    events.on('agent/disposed', (() => {
      for (const pending of [...this.byMessage.values()]) {
        this.settleRejected(pending, new Error('agent disposed before the delivery settled'), 'agent-disposed')
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
      const turn = 'turn' in event.data && typeof event.data.turn === 'number'
        ? event.data.turn
        : undefined
      if (turn === undefined) return
      const pending = this.byTurn.get(turn)
      if (pending === undefined) return

      if (event.type === 'assistant/message') {
        const content = event.data.message.content
        if (content.length > 0) {
          pending.output = content
          pending.interrupted = event.data.interrupted === true
        }
      }

      if (pending.activity !== undefined && this.options !== undefined) {
        this.options.stream.acceptSessionEvent({
          ...pending.activity,
          event,
        })
      }

      if (event.type === 'turn/end') {
        this.settleResolved(pending, {
          output: pending.output,
          stopReason: event.data.reason,
          interrupted: pending.interrupted,
          ...(pending.activity === undefined ? {} : { workspaceActivity: pending.activity }),
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
   * @param source - Workspace room or durable task-attempt source; absent for children.
   * @returns the terminal reply outcome.
   */
  deliver(agent: Agent, delivery: UserMessage, recall?: UserMessage, source?: WorkspaceActivitySource): Promise<WorkspaceTurnOutcome> {
    return new Promise<WorkspaceTurnOutcome>((resolve, reject) => {
      const activityId = source === undefined || this.options === undefined
        ? undefined
        : this.options.stream.queue({ agentId: this.options.agentId, messageId: delivery.id, source })
      const pending: PendingDelivery = {
        messageId: delivery.id,
        recall,
        source,
        activityId,
        activity: undefined,
        turn: undefined,
        output: [],
        interrupted: false,
        settled: false,
        resolve,
        reject,
      }
      this.byMessage.set(delivery.id, pending)
      try {
        agent.followup(delivery)
      } catch (error) {
        this.settleRejected(pending, error, 'followup-failed')
      }
    })
  }

  private settleResolved(pending: PendingDelivery, outcome: WorkspaceTurnOutcome): void {
    if (pending.settled) return
    pending.settled = true
    this.removePending(pending)
    pending.resolve(outcome)
  }

  private settleRejected(pending: PendingDelivery, reason: unknown, fallbackCode: string): void {
    if (pending.settled) return
    pending.settled = true
    this.removePending(pending)
    if (pending.activityId !== undefined && this.options !== undefined) {
      this.options.stream.discard(pending.activityId, reason, fallbackCode)
    }
    pending.reject(reason)
  }

  private removePending(pending: PendingDelivery): void {
    this.byMessage.delete(pending.messageId)
    if (pending.turn !== undefined) this.byTurn.delete(pending.turn)
  }
}
