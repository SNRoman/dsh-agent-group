/**
 * Long-lived DSH employee pool: one stable {@link AgentHandle} per employed
 * top-level agent, created or resumed once with single-flight admission, and
 * disposed when the agent departs.
 * @module @dsh-agent-workspace/host/runtime
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
 * materialized session or creating a fresh one. Departure disposes the handle
 * without deleting the durable binding, so re-employment resumes the same
 * conversation.
 */
export class EmployeeAgentPool {
  private readonly handles = new Map<AgentId, AgentHandle>()
  private readonly inFlight = new Map<AgentId, Promise<AgentHandle>>()

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
    const promise = this.materialize(agentId)
    this.inFlight.set(agentId, promise)
    try {
      const handle = await promise
      this.handles.set(agentId, handle)
      return handle
    } finally {
      this.inFlight.delete(agentId)
    }
  }

  /** Dispose one agent's handle; keeps its durable session binding for later resume. */
  async dispose(agentId: AgentId): Promise<void> {
    const handle = this.handles.get(agentId)
    if (handle === undefined) return
    this.handles.delete(agentId)
    await handle.dispose()
  }

  /** Dispose every live handle and clear the pool. */
  async disposeAll(): Promise<void> {
    const handles = [...this.handles.values()]
    this.handles.clear()
    await Promise.allSettled(handles.map(handle => handle.dispose()))
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
