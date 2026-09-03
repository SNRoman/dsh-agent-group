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
  readonly 'stale-revision': { readonly definitionId: string; readonly revisionId: string }
  readonly 'invalid-task-authority': { readonly taskId: string; readonly agentId: string }
}

/** Stable code accepted by {@link WorkspaceBusinessError}. */
export type WorkspaceBusinessErrorCode = keyof WorkspaceBusinessErrorDetailsMap

/** Policy failure whose code and details are safe to expose over RPC. */
export class WorkspaceBusinessError<Code extends WorkspaceBusinessErrorCode = WorkspaceBusinessErrorCode> extends Error {
  override readonly name = 'WorkspaceBusinessError'

  /**
   * Create one machine-readable policy failure.
   * @param code Stable failure code.
   * @param details JSON-safe identifiers and values used to present the failure.
   * @param message Optional diagnostic for logs and non-localized callers.
   */
  constructor(
    readonly code: Code,
    readonly details: WorkspaceBusinessErrorDetailsMap[Code] & WorkspaceErrorJson,
    message: string = code,
  ) {
    super(message)
  }
}
