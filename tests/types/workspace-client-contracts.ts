import type { WorkspaceState } from '../../packages/host/src/types.ts'
import type { WorkspaceActivitySnapshot as HostActivitySnapshot } from '../../packages/host/src/activity-stream.ts'
import type { DefinitionHistoryItem as HostDefinitionHistoryItem } from '../../packages/host/src/definition-history.ts'
import type { MemoryPage as HostMemoryPage } from '../../packages/host/src/memory-query.ts'
import { WorkspaceApi } from '../../packages/web/src/client/api.ts'
import type {
  ChildRunView, DefinitionHistoryItem, MembershipMemoryStart, MemoryDefinitionRevision, MemoryPage,
  MemorySource, WorkspaceActivityBlock, WorkspaceActivitySnapshot, WorkspaceActivitySource,
  WorkspaceEventView, WorkspaceRpcError, WorkspaceSnapshot,
} from '../../packages/web/src/client/contracts.ts'

declare const hostSnapshot: WorkspaceState
declare const hostActivity: HostActivitySnapshot
declare const hostMemory: HostMemoryPage
declare const hostHistory: readonly HostDefinitionHistoryItem[]
const clientSnapshot: WorkspaceSnapshot = hostSnapshot
const clientActivity: WorkspaceActivitySnapshot = hostActivity
const clientMemory: MemoryPage = hostMemory
const clientHistory: readonly DefinitionHistoryItem[] = hostHistory

declare const api: WorkspaceApi
// @ts-expect-error Unknown mutation endpoints cannot enter the Browser transport.
void api.mutate('unknown', {}, 1)
// @ts-expect-error Endpoint payloads are paired with their exact request fields.
void api.mutate('task/cancel', { delegationGrantId: 'grant-1' }, 1)
// @ts-expect-error Browser callers cannot choose a forged mutation result type.
void api.mutate<{ forged: true }>('task/cancel', { taskId: 'task-1' }, 1)
// @ts-expect-error Human actor identity is owned by the Host RPC adapter.
void api.mutate('task/assign', { assigneeAgentId: 'agent-1', title: 'Review', humanId: 'forged' }, 1)

function eventExhaustive(event: WorkspaceEventView): void {
  switch (event.type) {
    case 'definition/created': case 'definition/revised': case 'agent/definition-revision-assigned': case 'agent/created':
    case 'agent/departed': case 'agent/employed': case 'room/created': case 'room/member-joined': case 'room/member-left':
    case 'room/message': case 'runtime/session-bound': case 'conversation/stopped': case 'task/assigned':
    case 'task/delegation-granted': case 'task/delegation-revoked': case 'task/delegated': case 'task/completed':
    case 'task/cancelled': case 'task/delivery-started': case 'task/delivery-accepted': case 'task/delivery-failed':
    case 'task/result': case 'task/result-after-cancel': case 'child/run-started': case 'child/run-finished': return
    default: return assertNever(event)
  }
}

function blockExhaustive(block: WorkspaceActivityBlock): void {
  switch (block.kind) {
    case 'text': case 'reasoning': case 'tool': case 'unknown': return
    default: return assertNever(block)
  }
}

function errorExhaustive(error: WorkspaceRpcError): void {
  switch (error.kind) {
    case 'business': case 'bad-request': case 'cancelled': case 'internal': return
    default: return assertNever(error)
  }
}

function businessErrorExhaustive(error: Extract<WorkspaceRpcError, { kind: 'business' }>): void {
  switch (error.code) {
    case 'reserved-direct-routing': case 'agent-missing': case 'agent-departed': case 'duplicate-membership':
    case 'stale-revision': case 'invalid-task-authority': case 'task-not-open': case 'task-not-assigned':
    case 'delegation-grant-missing': case 'delegation-grant-inactive': return
    default: return assertNever(error)
  }
}

function sourceExhaustive(source: WorkspaceActivitySource | MemorySource): void {
  switch (source.kind) {
    case 'room': case 'task': case 'child': return
    default: return assertNever(source)
  }
}

function memoryRevisionExhaustive(revision: MemoryDefinitionRevision): void {
  switch (revision.status) {
    case 'active': case 'unresolved': return
    default: return assertNever(revision)
  }
}

function memoryStartExhaustive(start: MembershipMemoryStart): void {
  switch (start.type) {
    case 'new-events': case 'event-range': return
    default: return assertNever(start)
  }
}

function childRunExhaustive(run: ChildRunView): void {
  switch (run.status) {
    case 'running': case 'completed': case 'failed': case 'cancelled': return
    default: return assertNever(run)
  }
}

function assertNever(value: never): never { throw new Error(String(value)) }
void [
  clientSnapshot, clientActivity, clientMemory, clientHistory, eventExhaustive, blockExhaustive,
  errorExhaustive, businessErrorExhaustive, sourceExhaustive, memoryRevisionExhaustive,
  memoryStartExhaustive, childRunExhaustive,
]
