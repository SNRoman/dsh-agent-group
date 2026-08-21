/**
 * Long-lived DSH employee pool: one stable {@link AgentHandle} per employed
 * top-level agent, created or resumed once with single-flight admission, and
 * disposed when the agent departs.
 * @module @dsh-agent-group/host/runtime
 */

import { randomUUID } from 'node:crypto'
import type { AgentHandle, AgentSetup, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentId } from './ids.ts'

/** The agent lifecycle surface the pool drives (typically `ctx.agents`). */
export interface AgentLifecycle {
  create(options: CreateAgentOptions): Promise<AgentHandle>
  resume(options: ResumeAgentOptions): Promise<AgentHandle>
}

/** Durable source of an agent's materialized DSH session identity. */
export interface EmployeeSessionSource {
  /** The session id bound to this agent, or `undefined` when never materialized. */
  sessionIdFor(agentId: AgentId): SessionId | undefined
  /** Durably record a freshly created session id for this agent. */
  recordSessionId(agentId: AgentId, sessionId: SessionId): Promise<void>
}

/**
 * Owns the live DSH handles for employed workspace agents. `ensure()` admits
 * one handle per agent (single-flight across concurrent calls), resuming a
 * materialized session or creating a fresh one. Departure invalidates any
 * in-flight admission before disposing the resident handle, so an async create
 * cannot publish a stale handle after the employee has been removed.
 */
export class EmployeeAgentPool {
  private readonly handles = new Map<AgentId, AgentHandle>()
  private readonly inFlight = new Map<AgentId, Promise<AgentHandle>>()
  private readonly generations = new Map<AgentId, number>()

  constructor(
    private readonly agents: AgentLifecycle,
    private readonly source: EmployeeSessionSource,
    private readonly setupFactory?: (agentId: AgentId) => AgentSetup,
  ) {}

  /** The live handle for an agent, or `undefined` when not materialized. */
  handleFor(agentId: AgentId): AgentHandle | undefined {
    return this.handles.get(agentId)
  }

  /** Admit the live handle for one agent, creating or resuming it exactly once. */
  async ensure(agentId: AgentId): Promise<AgentHandle> {
    const existing = this.handles.get(agentId)
    if (existing !== undefined) return existing
    const pending = this.inFlight.get(agentId)
    if (pending !== undefined) return pending

    const generation = this.generationOf(agentId)
    const promise = this.materialize(agentId).then(async handle => {
      if (this.generationOf(agentId) !== generation) {
        try {
          await handle.dispose()
        } finally {
          throw new Error(`agent '${agentId}' admission was invalidated by disposal`)
        }
      }
      this.handles.set(agentId, handle)
      return handle
    })
    this.inFlight.set(agentId, promise)
    try {
      return await promise
    } finally {
      if (this.inFlight.get(agentId) === promise) this.inFlight.delete(agentId)
    }
  }

  /** Dispose one agent's handle and invalidate any admission already in flight. */
  async dispose(agentId: AgentId): Promise<void> {
    this.generations.set(agentId, this.generationOf(agentId) + 1)
    const handle = this.handles.get(agentId)
    const pending = this.inFlight.get(agentId)
    this.handles.delete(agentId)

    let disposeError: unknown
    if (handle !== undefined) {
      try {
        await handle.dispose()
      } catch (error) {
        disposeError = error
      }
    }
    if (pending !== undefined) {
      try {
        await pending
      } catch {
        // The stale admission rejects after disposing its unpublished handle.
      }
    }
    if (disposeError !== undefined) throw disposeError
  }

  /** Dispose every live handle and invalidate every admission in flight. */
  async disposeAll(): Promise<void> {
    const ids = new Set<AgentId>([...this.handles.keys(), ...this.inFlight.keys()])
    for (const agentId of ids) this.generations.set(agentId, this.generationOf(agentId) + 1)

    const handles = [...this.handles.values()]
    const pending = [...this.inFlight.values()]
    this.handles.clear()
    await Promise.allSettled([
      ...handles.map(handle => handle.dispose()),
      ...pending,
    ])
  }

  private generationOf(agentId: AgentId): number {
    return this.generations.get(agentId) ?? 0
  }

  private async materialize(agentId: AgentId): Promise<AgentHandle> {
    const bound = this.source.sessionIdFor(agentId)
    const setup = this.setupFactory?.(agentId)
    if (bound !== undefined) {
      // A materialized session never falls back to create: a resume failure is
      // a real fault (missing/corrupt persistence), not an invitation to orphan
      // the durable history under a new session id.
      return await this.agents.resume({
        resumeSessionId: bound,
        ...(setup === undefined ? {} : { setup }),
      })
    }
    const sessionId = SessionId(randomUUID())
    const handle = await this.agents.create({
      sessionId,
      ...(setup === undefined ? {} : { setup }),
    })
    try {
      await this.source.recordSessionId(agentId, sessionId)
    } catch (error) {
      await handle.dispose()
      throw error
    }
    return handle
  }
}
