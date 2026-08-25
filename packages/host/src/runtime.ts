/**
 * Long-lived DSH employee pool: one stable {@link AgentHandle} per employed
 * top-level agent, created or resumed once with single-flight admission, and
 * disposed when the agent departs.
 * @module @dsh-agent-group/host/runtime
 */

import { randomUUID } from 'node:crypto'
import type { AgentHandle, AgentOptions, AgentSetup, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentId } from './ids.ts'

/** The agent lifecycle surface the pool drives (typically `ctx.agents`). */
export interface AgentLifecycle {
  create(options: CreateAgentOptions): Promise<AgentHandle>
  resume(options: { readonly resumeSessionId: SessionId; readonly agentOptions?: AgentOptions; readonly setup?: AgentSetup }): Promise<AgentHandle>
}

/** Explicit handling decision for an already-bound employee session. */
export type EmployeeBoundSessionDisposition = 'resume' | 'replace'

/** Durable source of an agent's materialized DSH session identity. */
export interface EmployeeSessionSource {
  /** The session id bound to this agent, or `undefined` when never materialized. */
  sessionIdFor(agentId: AgentId): SessionId | undefined
  /** Durably record a freshly created or migrated session id for this agent. */
  recordSessionId(agentId: AgentId, sessionId: SessionId): Promise<void>
  /**
   * Classify a known binding before admission. `replace` is an explicit
   * compatibility migration, never a fallback from a failed resume.
   */
  classifySession?(agentId: AgentId, sessionId: SessionId): Promise<EmployeeBoundSessionDisposition>
  /** Hide one internal employee session from ordinary DSH grouping surfaces. */
  hideSession?(sessionId: SessionId): Promise<void>
}

/** Runtime configuration prepared immediately before one create/resume. */
export interface EmployeeMaterializationOptions {
  readonly agentOptions?: AgentOptions
  readonly meta?: CreateAgentOptions['meta']
  readonly setup?: AgentSetup
}

/** Prepare model, preset and scoped setup for one employee admission. */
export type EmployeeMaterializationOptionsFactory = (
  agentId: AgentId,
  mode: 'create' | 'resume',
) => EmployeeMaterializationOptions | Promise<EmployeeMaterializationOptions>

/**
 * Owns the live DSH handles for employed workspace agents. `ensure()` admits
 * one handle per agent (single-flight across concurrent calls), resuming a
 * compatible materialized session or explicitly rotating a binding classified
 * as incompatible. An ordinary resume failure never creates a replacement.
 * Departure invalidates any in-flight admission before disposing the resident
 * handle, so an async create cannot publish a stale handle after removal.
 */
export class EmployeeAgentPool {
  private readonly handles = new Map<AgentId, AgentHandle>()
  private readonly inFlight = new Map<AgentId, Promise<AgentHandle>>()
  private readonly generations = new Map<AgentId, number>()

  constructor(
    private readonly agents: AgentLifecycle,
    private readonly source: EmployeeSessionSource,
    private readonly optionsFactory?: EmployeeMaterializationOptionsFactory,
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
    if (bound !== undefined) {
      const disposition = await this.source.classifySession?.(agentId, bound) ?? 'resume'
      if (disposition === 'resume') {
        await this.source.hideSession?.(bound)
        const options = await this.optionsFactory?.(agentId, 'resume')
        // A compatible materialized session never falls back to create: a
        // resume failure remains a real persistence/runtime fault.
        return await this.agents.resume({
          resumeSessionId: bound,
          ...(options?.agentOptions === undefined ? {} : { agentOptions: options.agentOptions }),
          ...(options?.setup === undefined ? {} : { setup: options.setup }),
        })
      }
      // Replacement is intentional only after the source positively identifies
      // a known compatibility gap. Retire the visible legacy row before minting
      // the new internal identity.
      await this.source.hideSession?.(bound)
    }
    return await this.createFresh(agentId)
  }

  private async createFresh(agentId: AgentId): Promise<AgentHandle> {
    const sessionId = SessionId(randomUUID())
    const options = await this.optionsFactory?.(agentId, 'create')
    const handle = await this.agents.create({
      sessionId,
      ...(options?.agentOptions === undefined ? {} : { agentOptions: options.agentOptions }),
      ...(options?.meta === undefined ? {} : { meta: options.meta }),
      ...(options?.setup === undefined ? {} : { setup: options.setup }),
    })
    try {
      // The created Session is already live when create() resolves, so the DSH
      // workspace registry can archive it before any Agent Workspace delivery
      // makes it a visible ordinary conversation.
      await this.source.hideSession?.(sessionId)
      await this.source.recordSessionId(agentId, sessionId)
    } catch (error) {
      await handle.dispose()
      throw error
    }
    return handle
  }
}
