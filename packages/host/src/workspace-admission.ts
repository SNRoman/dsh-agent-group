/** Reservations for one organization's complete runtime operations and export capture. */

/** Tracks operations from admission through durable settlement and runtime cleanup. */
export class WorkspaceAdmission {
  private phase: 'open' | 'closed' | 'capturing' = 'open'
  private closedGeneration: object | undefined
  private captureRestore: { phase: 'open' | 'closed' } | undefined
  private readonly reservations = new Set<object>()
  private readonly waiters = new Set<() => void>()

  /** Number of admitted operations that have not finished cleanup. */
  get pending(): number { return this.reservations.size }

  /** @returns Idempotent release operation for a new admission. */
  reserve(): () => void {
    if (this.phase !== 'open') throw new Error(this.phase === 'closed' ? 'workspace admission is closed' : 'workspace is busy')
    const token = {}
    this.reservations.add(token)
    return () => {
      if (!this.reservations.delete(token) || this.pending !== 0) return
      for (const resolve of this.waiters) resolve()
      this.waiters.clear()
    }
  }

  /**
   * Admit one operation before its first asynchronous step.
   * @param operation Complete operation including terminal cleanup.
   * @returns The operation's result after its reservation is released.
   */
  async run<Value>(operation: () => Promise<Value>): Promise<Value> {
    const release = this.reserve()
    try {
      return await operation()
    } finally {
      release()
    }
  }

  /**
   * Block new operations without cancelling already admitted work.
   * @returns A generation-scoped rollback for use only when the archive write fails.
   */
  close(): () => void {
    if (this.phase === 'capturing') throw new Error('workspace is busy')
    if (this.phase === 'closed') return () => {}
    const generation = {}
    this.closedGeneration = generation
    this.phase = 'closed'
    return () => {
      if (this.closedGeneration !== generation) return
      if (this.phase !== 'closed' && this.captureRestore?.phase !== 'closed') return
      this.closedGeneration = undefined
      if (this.captureRestore !== undefined) this.captureRestore.phase = 'open'
      else this.phase = 'open'
    }
  }

  /** Reopen admission only after previous operations have settled. */
  reopen(): void {
    if (this.phase === 'capturing' || this.pending !== 0) throw new Error('workspace is busy')
    this.closedGeneration = undefined
    this.phase = 'open'
  }

  /** @returns Completion after every admitted operation has released. */
  async drain(): Promise<void> {
    if (this.pending === 0) return
    await new Promise<void>(resolve => { this.waiters.add(resolve) })
  }

  /**
   * Capture idle state while admissions are blocked, including for an archived organization.
   * @param capture Read and encode the committed organization snapshot.
   * @returns Captured value; a failed capture also releases its temporary barrier.
   */
  async withIdle<Value>(capture: () => Promise<Value>): Promise<Value> {
    if (this.phase === 'capturing' || this.pending !== 0) throw new Error('workspace is busy')
    const restore = { phase: this.phase }
    this.captureRestore = restore
    this.phase = 'capturing'
    try {
      return await capture()
    } finally {
      this.phase = restore.phase
      this.captureRestore = undefined
    }
  }
}
