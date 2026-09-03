import { WorkspaceBusinessError } from '../../packages/host/src/errors.ts'
import { WorkspaceApiError } from '../../packages/web/src/client/api.ts'
import type { WorkspaceRpcError } from '../../packages/web/src/client/contracts.ts'

// @ts-expect-error Unknown business-error codes and details remain outside the closed protocol.
const unknownBusinessError = new WorkspaceBusinessError('unknown-code', { externalId: 'external-1' })

// @ts-expect-error Each stable business code accepts only its declared details.
const mismatchedBusinessDetails = new WorkspaceBusinessError('agent-missing', { roomId: 'room-1' })

const cancelled: WorkspaceRpcError = {
  kind: 'cancelled', code: 'cancelled', message: 'cancelled', details: {},
}

// @ts-expect-error Cancelled errors cannot carry the internal code.
const crossedRpcError: WorkspaceRpcError = {
  kind: 'cancelled', code: 'internal', message: 'crossed', details: {},
}

// @ts-expect-error WorkspaceApiError rejects mismatched kind and code pairs.
const crossedApiError = new WorkspaceApiError({
  kind: 'internal', code: 'cancelled', message: 'crossed', details: {},
})

declare const apiError: WorkspaceApiError
if (apiError.error.kind === 'cancelled') {
  const narrowedCode: 'cancelled' = apiError.error.code
  void narrowedCode
}

void [unknownBusinessError, mismatchedBusinessDetails, cancelled, crossedRpcError, crossedApiError]
