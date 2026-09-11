/** Stable machine-readable policy failures exposed by Agent Workspace. */

/** JSON values accepted in business-error details. */
export type WorkspaceErrorJson = null | boolean | number | string | readonly WorkspaceErrorJson[] | {
  readonly [key: string]: WorkspaceErrorJson
}

/** Closed business-error codes shared with transport consumers. */
export type WorkspaceBusinessErrorDetailsMap = {
  readonly 'reserved-direct-routing': { readonly roomId: string; readonly token: '@all' }
  readonly 'agent-missing': { readonly agentId: string }
  readonly 'agent-departed': { readonly agentId: string }
  readonly 'duplicate-membership': { readonly roomId: string; readonly agentId: string }
  /** Aggregate CAS mismatch or an unavailable immutable definition revision. */
  readonly 'stale-revision':
    | { readonly definitionId: string; readonly revisionId: string }
    | { readonly expectedRevision: number; readonly actualRevision: number }
  readonly 'invalid-task-authority': { readonly taskId: string; readonly agentId: string }
  readonly 'task-not-open': { readonly taskId: string; readonly status: 'completed' | 'cancelled' }
  readonly 'task-not-assigned': { readonly taskId: string; readonly agentId: string }
  readonly 'delegation-grant-missing':
    | { readonly lookup: 'id'; readonly delegationGrantId: string }
    | { readonly lookup: 'root-agent'; readonly rootTaskId: string; readonly agentId: string }
  readonly 'delegation-grant-inactive': { readonly delegationGrantId: string }
}

/** Stable code accepted by {@link WorkspaceBusinessError}. */
export type WorkspaceBusinessErrorCode = keyof WorkspaceBusinessErrorDetailsMap

type WorkspaceBusinessErrorArguments<Code extends WorkspaceBusinessErrorCode> = {
  readonly [CurrentCode in Code]: readonly [
    code: CurrentCode,
    details: WorkspaceBusinessErrorDetailsMap[CurrentCode] & WorkspaceErrorJson,
    message?: string,
  ]
}[Code]

/** Policy failure whose code and details are safe to expose over RPC. */
export class WorkspaceBusinessError<Code extends WorkspaceBusinessErrorCode = WorkspaceBusinessErrorCode> extends Error {
  override readonly name = 'WorkspaceBusinessError'
  /** Stable failure code. */
  readonly code: Code
  /** JSON-safe identifiers and values used to present the failure. */
  readonly details: WorkspaceBusinessErrorDetailsMap[Code] & WorkspaceErrorJson

  /**
   * Create one machine-readable policy failure.
   * @param code Stable failure code.
   * @param details JSON-safe identifiers and values used to present the failure.
   * @param message Optional diagnostic for logs and non-localized callers.
   */
  constructor(...[code, details, message = code]: WorkspaceBusinessErrorArguments<Code>) {
    super(message)
    this.code = code
    this.details = details
  }
}
