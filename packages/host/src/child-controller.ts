/** Process-local ownership and exact stop control for durable child runs. */

import type { AgentId, ChildRunId, TaskId } from './ids.ts'
import type { FinishChildRunRequest } from './child-runs.ts'
import { finishChildRun } from './child-runs.ts'
import type { WorkspaceStopResult } from './activity-controller.ts'
import type { WorkspaceState } from './types.ts'

/** Controller fields published immediately after the durable child id commits. */
export interface RegisterChildController {
  readonly childRunId: ChildRunId
  readonly parentAgentId: AgentId
  readonly taskId: TaskId
  readonly abort: () => void
}

/** The child-run owner used by its runtime path to propose one terminal result. */
export interface ChildSettlementOwner {
  /**
   * Commit the outcome only when it wins this child run's settlement race.
   * @param status - Durable child terminal status.
   * @param result - Nonblank result text safe for durable display.
   * @returns Whether this request is the winner and its durable write converged.
   */
  settle(status: FinishChildRunRequest['status'], result: string): Promise<boolean>
}

/** A child controller published under a teardown-visible start reservation. */
export interface ReservedChildController {
  readonly settlement: ChildSettlementOwner
  readonly startAllowed: boolean
}

/** Reservation acquired before a durable child id can be published. */
export interface ChildStartReservation {
  /**
   * Publish the committed child controller in the reserved runtime generation.
   * @param input - Exact durable child identity and runtime abort operation.
   * @returns The settlement owner and whether this generation still accepts starts.
   */
  register(input: RegisterChildController): ReservedChildController
  /** Release the publication reservation after registration or failure. */
  release(): void
}

interface ChildControllerRecord extends RegisterChildController {
  stopping: boolean
  phase: 'live' | 'stop-reserved' | 'settling' | 'settled'
  winner?: FinishChildRunRequest
  attempt: Promise<void> | undefined
}

/** CAS-slot child stop whose runtime abort is deferred until durable commit. */
export interface PreparedChildStop {
  readonly state: WorkspaceState
  readonly value: WorkspaceStopResult
  /** Publish the reserved stop after its candidate aggregate commits. */
  commit(): void
  /** Release the reservation when validation or persistence rejects the candidate. */
  rollback(): void
}

/** Serialized durable terminal mutation supplied by the Workspace Host. */
export type FinishControlledChildRun = (request: FinishChildRunRequest) => Promise<void>

/** Arbitrates stop, result, startup failure, and owner disposal for child runs. */
export class ChildControllerRegistry {
  private readonly records = new Map<ChildRunId, ChildControllerRecord>()
  private readonly reservations = new Set<object>()
  private readonly reservationWaiters = new Set<() => void>()
  private lifecycle: 'open' | 'closing' | 'closed' = 'open'
  private closeFlight: Promise<void> | undefined

  constructor(private readonly finish: FinishControlledChildRun) {}

  /**
   * Publish one controller and return its unique settlement owner.
   * @param input - Exact durable child identity and its runtime abort operation.
   * @returns The child runtime's settlement owner.
   */
  register(input: RegisterChildController): ChildSettlementOwner {
    if (this.lifecycle !== 'open') throw new Error('Child runtime is stopping.')
    return this.registerRecord(input)
  }

  /** @returns A teardown-visible reservation acquired before durable child publication. */
  reserveStart(): ChildStartReservation {
    if (this.lifecycle !== 'open') throw new Error('Child runtime is stopping.')
    const token = {}
    let released = false
    let registered = false
    this.reservations.add(token)
    return {
      register: input => {
        if (released) throw new Error('Child start reservation is already released.')
        if (registered) throw new Error('Child start reservation already published a controller.')
        registered = true
        return {
          settlement: this.registerRecord(input),
          startAllowed: this.lifecycle === 'open',
        }
      },
      release: () => {
        if (released) return
        released = true
        this.reservations.delete(token)
        if (this.reservations.size !== 0) return
        for (const resolve of this.reservationWaiters) resolve()
        this.reservationWaiters.clear()
      },
    }
  }

  /** Reopen an empty registry for a later Host runtime generation. */
  openGeneration(): void {
    if (this.lifecycle === 'closing') throw new Error('Child runtime is still stopping.')
    if (this.records.size !== 0 || this.reservations.size !== 0) {
      throw new Error('Child runtime cannot reopen with live work.')
    }
    this.lifecycle = 'open'
  }

  private registerRecord(input: RegisterChildController): ChildSettlementOwner {
    if (this.records.has(input.childRunId)) {
      throw new Error(`child run '${input.childRunId}' already has a live controller`)
    }
    const record: ChildControllerRecord = { ...input, stopping: false, phase: 'live', attempt: undefined }
    this.records.set(record.childRunId, record)
    return {
      settle: async (status, result) => await this.settle(record, { childRunId: record.childRunId, status, result }),
    }
  }

  /**
   * Abort and durably cancel one exact active child run.
   * @param childRunId - Durable child identity to stop.
   * @returns Whether this call started stopping, repeated it, or found no live controller.
   */
  async stopChildRun(childRunId: ChildRunId): Promise<WorkspaceStopResult> {
    const record = this.records.get(childRunId)
    if (record === undefined) return { status: 'not-active' }
    if (record.stopping) {
      if (record.phase === 'live' && record.winner !== undefined) {
        await this.settle(record, record.winner)
      }
      return { status: 'already-stopping' }
    }
    if (record.winner !== undefined) {
      await this.converge(record)
      return { status: 'not-active' }
    }
    record.stopping = true
    record.abort()
    await this.settle(record, {
      childRunId,
      status: 'cancelled',
      result: 'Child run cancelled.',
    })
    return { status: 'stopping' }
  }

  /**
   * Reserve an exact live child and build its terminal state in the caller's serialized update.
   * @param state - Aggregate current in the caller's table update slot.
   * @param childRunId - Exact durable child identity to stop.
   * @returns Candidate state plus commit and rollback hooks for the table write.
   */
  prepareStop(state: WorkspaceState, childRunId: ChildRunId): PreparedChildStop {
    const record = this.records.get(childRunId)
    if (record === undefined || record.winner !== undefined && record.phase !== 'stop-reserved') {
      return inertPreparedStop(state, { status: 'not-active' })
    }
    if (record.stopping || record.phase === 'stop-reserved') {
      return inertPreparedStop(state, { status: 'already-stopping' })
    }

    const request: FinishChildRunRequest = {
      childRunId,
      status: 'cancelled',
      result: 'Child run cancelled.',
    }
    const candidate = finishChildRun(state, request).state
    const barrier = Promise.withResolvers<void>()
    record.stopping = true
    record.winner = request
    record.phase = 'stop-reserved'
    record.attempt = barrier.promise
    let completed = false
    return {
      state: candidate,
      value: { status: 'stopping' },
      commit: () => {
        if (completed) return
        completed = true
        record.abort()
        record.phase = 'settled'
        record.attempt = undefined
        if (this.records.get(childRunId) === record) this.records.delete(childRunId)
        barrier.resolve()
      },
      rollback: () => {
        if (completed) return
        completed = true
        record.stopping = false
        delete record.winner
        record.phase = 'live'
        record.attempt = undefined
        barrier.resolve()
      },
    }
  }

  /** @returns Fulfillment after every child owned by this runtime generation stops. */
  async stopAll(): Promise<void> {
    if (this.lifecycle === 'closed') return
    const current = this.closeFlight
    if (current !== undefined) return await current
    this.lifecycle = 'closing'
    const flight = this.closeGeneration()
    this.closeFlight = flight
    try {
      await flight
      this.lifecycle = 'closed'
    } finally {
      if (this.closeFlight === flight) this.closeFlight = undefined
    }
  }

  private async closeGeneration(): Promise<void> {
    await this.waitForReservations()
    for (const record of [...this.records.values()]) await this.converge(record)
  }

  private async waitForReservations(): Promise<void> {
    if (this.reservations.size === 0) return
    await new Promise<void>(resolve => this.reservationWaiters.add(resolve))
  }

  private async converge(record: ChildControllerRecord): Promise<void> {
    if (record.phase === 'stop-reserved') await record.attempt
    if (record.phase === 'settled') return
    if (record.winner === undefined) {
      record.stopping = true
      record.abort()
      await this.settle(record, {
        childRunId: record.childRunId,
        status: 'cancelled',
        result: 'Child run cancelled.',
      })
      return
    }
    if (record.phase === 'settling') {
      try {
        await record.attempt
      } catch (_error) {
        // The settlement owner observes this failure; this lifecycle caller retries its retained winner once.
      }
    }
    if (record.phase === 'live') await this.settle(record, record.winner)
  }

  private async settle(record: ChildControllerRecord, request: FinishChildRunRequest): Promise<boolean> {
    if (record.phase === 'settled') return false
    if (record.phase === 'stop-reserved') {
      await record.attempt
      if (this.records.get(record.childRunId) !== record) return false
      return await this.settle(record, request)
    }
    if (record.winner === undefined) record.winner = { ...request }
    else if (!sameTerminalRequest(record.winner, request)) return false
    if (record.phase === 'settling') {
      const attempt = record.attempt
      if (attempt === undefined) throw new Error('settling child has no durable write attempt')
      await attempt
      return true
    }

    const winner = record.winner
    if (winner === undefined) throw new Error('settling child has no winning terminal request')
    record.phase = 'settling'
    const attempt = Promise.resolve().then(async () => await this.finish(winner))
    record.attempt = attempt
    try {
      await attempt
      record.phase = 'settled'
      if (this.records.get(record.childRunId) === record) this.records.delete(record.childRunId)
      return true
    } catch (error) {
      if (record.attempt === attempt) {
        record.phase = 'live'
        record.attempt = undefined
      }
      throw error
    }
  }
}

function inertPreparedStop(state: WorkspaceState, value: WorkspaceStopResult): PreparedChildStop {
  return { state, value, commit: () => {}, rollback: () => {} }
}

function sameTerminalRequest(left: FinishChildRunRequest, right: FinishChildRunRequest): boolean {
  return left.childRunId === right.childRunId
    && left.status === right.status
    && left.result === right.result
}
