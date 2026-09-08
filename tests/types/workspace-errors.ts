import { WorkspaceBusinessError } from '../../packages/host/src/errors.ts'
import type { WorkspaceBusinessErrorCode, WorkspaceBusinessErrorDetailsMap } from '../../packages/host/src/errors.ts'
import type { WorkspaceRpcResult } from '../../packages/host/src/rpc.ts'
import { WorkspaceApiError } from '../../packages/web/src/client/api.ts'
import type { WorkspaceRpcError } from '../../packages/web/src/client/contracts.ts'

// @ts-expect-error Unknown business-error codes and details remain outside the closed protocol.
const unknownBusinessError = new WorkspaceBusinessError('unknown-code', { externalId: 'external-1' })

// @ts-expect-error Each stable business code accepts only its declared details.
const mismatchedBusinessDetails = new WorkspaceBusinessError('agent-missing', { roomId: 'room-1' })

const taskNotOpen = new WorkspaceBusinessError('task-not-open', { taskId: 'task-1', status: 'cancelled' })
const taskNotAssigned = new WorkspaceBusinessError('task-not-assigned', { taskId: 'task-1', agentId: 'agent-1' })
const grantMissing = new WorkspaceBusinessError('delegation-grant-missing', { lookup: 'root-agent', rootTaskId: 'task-1', agentId: 'agent-1' })
const grantInactive = new WorkspaceBusinessError('delegation-grant-inactive', { delegationGrantId: 'grant-1' })

// @ts-expect-error Task-open failures require the terminal status that blocked the operation.
const taskNotOpenWithoutStatus = new WorkspaceBusinessError('task-not-open', { taskId: 'task-1' })

declare const looseBusinessCode: WorkspaceBusinessErrorCode
declare const looseBusinessDetails: WorkspaceBusinessErrorDetailsMap[WorkspaceBusinessErrorCode]
// @ts-expect-error Broad code and details unions do not prove that the pair matches.
const looselyPairedBusinessError = new WorkspaceBusinessError(looseBusinessCode, looseBusinessDetails)

declare const hostResult: WorkspaceRpcResult
if (!hostResult.ok
  && hostResult.error.kind === 'business'
  && hostResult.error.code === 'reserved-direct-routing') {
  const roomId: string = hostResult.error.details.roomId
  const token: '@all' = hostResult.error.details.token
  void [roomId, token]
}

// @ts-expect-error Host RPC business details must match the stable code.
const crossedHostBusinessResult: WorkspaceRpcResult = { ok: false, error: { kind: 'business', code: 'agent-missing', message: 'crossed', details: { roomId: 'room-1', token: '@all' } } }

const cancelled: WorkspaceRpcError = {
  kind: 'cancelled', code: 'cancelled', message: 'cancelled', details: {},
}

// @ts-expect-error Cancelled errors cannot carry the internal code.
const crossedRpcError: WorkspaceRpcError = {
  kind: 'cancelled', code: 'internal', message: 'crossed', details: {},
}

declare const webRpcError: WorkspaceRpcError
if (webRpcError.kind === 'business' && webRpcError.code === 'reserved-direct-routing') {
  const roomId: string = webRpcError.details.roomId
  const token: '@all' = webRpcError.details.token
  void [roomId, token]
}

// @ts-expect-error Browser RPC business details must match the stable code.
const crossedWebBusinessError: WorkspaceRpcError = { kind: 'business', code: 'agent-missing', message: 'crossed', details: { roomId: 'room-1', token: '@all' } }

// @ts-expect-error WorkspaceApiError rejects mismatched kind and code pairs.
const crossedApiError = new WorkspaceApiError({
  kind: 'internal', code: 'cancelled', message: 'crossed', details: {},
})

declare const apiError: WorkspaceApiError
if (apiError.error.kind === 'cancelled') {
  const narrowedCode: 'cancelled' = apiError.error.code
  void narrowedCode
}

if (apiError.error.kind === 'business' && apiError.error.code === 'reserved-direct-routing') {
  const roomId: string = apiError.error.details.roomId
  const token: '@all' = apiError.error.details.token
  void [roomId, token]
}

void [
  unknownBusinessError,
  mismatchedBusinessDetails,
  taskNotOpen,
  taskNotAssigned,
  grantMissing,
  grantInactive,
  taskNotOpenWithoutStatus,
  looselyPairedBusinessError,
  crossedHostBusinessResult,
  cancelled,
  crossedRpcError,
  crossedWebBusinessError,
  crossedApiError,
]
