/** Process-local ownership and exact stop control for durable child runs. */

import type { AgentId, ChildRunId, TaskId } from './ids.ts'
import type { FinishChildRunRequest } from './child-runs.ts'
import type { WorkspaceStopResult } from './activity-controller.ts'

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
   * @returns Whether this proposal acquired settlement ownership.
   */
  settle(status: FinishChildRunRequest['status'], result: string): Promise<boolean>
}

interface ChildControllerRecord extends RegisterChildController {
  stopping: boolean
  settled: boolean
}

/** Serialized durable terminal mutation supplied by the Workspace Host. */
export type FinishControlledChildRun = (request: FinishChildRunRequest) => Promise<void>

/** Arbitrates stop, result, startup failure, and owner disposal for child runs. */
export class ChildControllerRegistry {
  private readonly records = new Map<ChildRunId, ChildControllerRecord>()

  constructor(private readonly finish: FinishControlledChildRun) {}

  /**
   * Publish one controller and return its unique settlement owner.
   * @param input - Exact durable child identity and its runtime abort operation.
   * @returns The child runtime's settlement owner.
   */
  register(input: RegisterChildController): ChildSettlementOwner {
    if (this.records.has(input.childRunId)) {
      throw new Error(`child run '${input.childRunId}' already has a live controller`)
    }
    const record: ChildControllerRecord = { ...input, stopping: false, settled: false }
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
    if (record.stopping) return { status: 'already-stopping' }
    if (record.settled) return { status: 'not-active' }
    record.stopping = true
    record.abort()
    await this.settle(record, {
      childRunId,
      status: 'cancelled',
      result: 'Child run cancelled.',
    })
    return { status: 'stopping' }
  }

  /** @returns Fulfillment after every child owned by this runtime generation stops. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.records.keys()].map(async childRunId => {
      await this.stopChildRun(childRunId)
    }))
  }

  private async settle(record: ChildControllerRecord, request: FinishChildRunRequest): Promise<boolean> {
    if (record.settled) return false
    record.settled = true
    try {
      await this.finish(request)
      return true
    } finally {
      if (this.records.get(record.childRunId) === record) this.records.delete(record.childRunId)
    }
  }
}
