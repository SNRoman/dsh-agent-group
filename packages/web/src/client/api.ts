/** Browser adapter over this plugin's isolated Connection RPC channel. */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {
  AgentDefinitionId, AgentId, AssignHumanTaskResultView, ChildRunId, CreateDefinitionInput,
  DefinitionHistoryItem, DefinitionRevisionId, DelegationGrantId, GrantTaskDelegationResultView,
  MembershipId, MembershipMemoryStart, MemoryPage, MemoryQuery, ReviseDefinitionInput, RoomId,
  TaskId, WorkspaceActivityIdentity, WorkspaceActivitySnapshot, WorkspaceDirectRoomResult,
  WorkspaceDirectRoomValue, WorkspaceMutationResult, WorkspaceRpcError, WorkspaceRuntimeStatus,
  WorkspaceSnapshot, WorkspaceStopResult,
} from './contracts.ts'

const CHANNEL = '/agent-workspace'

/** Typed RPC failure retained for Browser presentation and locale mapping. */
export class WorkspaceApiError extends Error {
  override readonly name = 'WorkspaceApiError'
  readonly error: WorkspaceRpcError
  readonly kind: WorkspaceRpcError['kind']
  readonly code: WorkspaceRpcError['code']
  readonly details: WorkspaceRpcError['details']

  /** @param error Machine-readable Host failure. */
  constructor(error: WorkspaceRpcError) {
    super(error.message)
    this.error = structuredClone(error)
    this.kind = this.error.kind
    this.code = this.error.code
    this.details = this.error.details
  }
}

/** Strict Browser client for Agent Workspace reads and CAS mutations. */
export class WorkspaceApi {
  constructor(private readonly connection: Pick<ConnectionHandle, 'rpc'>) {}

  snapshot(signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.invoke('snapshot', {}, signal).then(assertWorkspaceSnapshot)
  }

  runtimeStatus(signal?: AbortSignal): Promise<WorkspaceRuntimeStatus> {
    return this.invoke('runtime/status', {}, signal).then(assertWorkspaceRuntimeStatus)
  }

  activitySnapshot(signal?: AbortSignal): Promise<WorkspaceActivitySnapshot> {
    return this.invoke('runtime/activity/snapshot', {}, signal).then(assertWorkspaceActivitySnapshot)
  }

  waitForActivity(afterVersion: number, signal?: AbortSignal): Promise<WorkspaceActivitySnapshot> {
    requireNonNegativeInteger('activity version', afterVersion)
    return this.invoke('runtime/activity/wait', { afterVersion }, signal).then(assertWorkspaceActivitySnapshot)
  }

  queryMemory(query: MemoryQuery, signal?: AbortSignal): Promise<MemoryPage> {
    return this.invoke('memory/query', query, signal).then(assertMemoryPage)
  }

  definitionHistory(definitionId: AgentDefinitionId, signal?: AbortSignal): Promise<readonly DefinitionHistoryItem[]> {
    return this.invoke('definition/history', { definitionId }, signal).then(assertDefinitionHistory)
  }

  /** Add the aggregate CAS revision and return the validated committed result. */
  async mutate<Value>(endpoint: string, payload: object, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceMutationResult<Value>> {
    requireNonNegativeInteger('expected revision', expectedRevision)
    if ('expectedRevision' in payload || 'actorAgentId' in payload || 'humanId' in payload || 'actor' in payload) {
      throw new Error('Agent Workspace mutation payload contains a client-owned actor or revision field')
    }
    return assertMutationResult(await this.invoke(endpoint, { expectedRevision, ...payload }, signal)) as WorkspaceMutationResult<Value>
  }

  createDefinition(input: CreateDefinitionInput, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.mutate('definition/create', input, expectedRevision, signal).then(result => assertWorkspaceSnapshot(result.value))
  }

  reviseDefinition(input: ReviseDefinitionInput, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.mutate('definition/revise', input, expectedRevision, signal).then(result => assertWorkspaceSnapshot(result.value))
  }

  synchronizeDefinition(definitionId: AgentDefinitionId, definitionRevisionId: DefinitionRevisionId, agentIds: readonly AgentId[], expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.mutate('definition/synchronize', { definitionId, definitionRevisionId, agentIds }, expectedRevision, signal).then(result => assertWorkspaceSnapshot(result.value))
  }

  createAgent(definitionId: AgentDefinitionId, name: string, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.mutate('agent/create', { definitionId, name }, expectedRevision, signal).then(result => assertWorkspaceSnapshot(result.value))
  }

  setEmployment(agentId: AgentId, employed: boolean, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.mutate(employed ? 'agent/employ' : 'agent/depart', { agentId }, expectedRevision, signal).then(result => assertWorkspaceSnapshot(result.value))
  }

  createGroup(name: string, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.mutate('room/create', { kind: 'group', name }, expectedRevision, signal).then(result => assertWorkspaceSnapshot(result.value))
  }

  async openDirect(agentId: AgentId, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceDirectRoomResult> {
    const { value } = await this.mutate<WorkspaceDirectRoomValue>('room/direct/open', { agentId }, expectedRevision, signal)
    if (!isRecord(value) || typeof value['roomId'] !== 'string') throw invalid('direct-room result')
    return { snapshot: assertWorkspaceSnapshot(value['state']), roomId: value['roomId'] }
  }

  async joinRoom(roomId: RoomId, agentId: AgentId, memoryStart: MembershipMemoryStart, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    assertMemoryStart(memoryStart)
    const result = await this.mutate('room/join', { roomId, agentId, memoryStart }, expectedRevision, signal)
    return assertWorkspaceSnapshot(result.value)
  }

  leaveRoom(membershipId: MembershipId, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.mutate('room/leave', { membershipId }, expectedRevision, signal).then(result => assertWorkspaceSnapshot(result.value))
  }

  postMessage(roomId: RoomId, text: string, mentions: readonly AgentId[], expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.mutate('room/post', { roomId, text, mentions }, expectedRevision, signal).then(result => assertWorkspaceSnapshot(result.value))
  }

  assignTask(assigneeAgentId: AgentId, title: string, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceMutationResult<AssignHumanTaskResultView>> {
    return this.mutate('task/assign', { assigneeAgentId, title }, expectedRevision, signal).then(result => ({ ...result, value: assertAssignTaskResult(result.value) }))
  }

  grantTask(granteeAgentId: AgentId, rootTaskId: TaskId, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceMutationResult<GrantTaskDelegationResultView>> {
    return this.mutate('task/grant', { granteeAgentId, rootTaskId }, expectedRevision, signal).then(result => ({ ...result, value: assertGrantTaskResult(result.value) }))
  }

  revokeTask(delegationGrantId: DelegationGrantId, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.mutate('task/revoke', { delegationGrantId }, expectedRevision, signal).then(result => assertWorkspaceSnapshot(result.value))
  }

  cancelTask(taskId: TaskId, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.mutate('task/cancel', { taskId }, expectedRevision, signal).then(result => assertWorkspaceSnapshot(result.value))
  }

  retryTaskDelivery(taskId: TaskId, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceMutationResult<string>> {
    return this.mutate('task/retry-delivery', { taskId }, expectedRevision, signal).then(result => {
      if (typeof result.value !== 'string') throw invalid('task retry result')
      return result as WorkspaceMutationResult<string>
    })
  }

  stopActivity(identity: WorkspaceActivityIdentity, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceMutationResult<WorkspaceStopResult>> {
    return this.mutate('runtime/activity/stop', identity, expectedRevision, signal).then(result => ({ ...result, value: assertStopResult(result.value) }))
  }

  stopChildRun(childRunId: ChildRunId, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceMutationResult<WorkspaceStopResult>> {
    return this.mutate('runtime/child/stop', { childRunId }, expectedRevision, signal).then(result => ({ ...result, value: assertStopResult(result.value) }))
  }

  acknowledgeAgentFailure(agentId: AgentId, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceMutationResult<void>> {
    return this.mutate('runtime/failure/acknowledge', { agentId }, expectedRevision, signal).then(value => {
      if (value.value !== undefined) throw invalid('failure acknowledgement result')
      return value as WorkspaceMutationResult<void>
    })
  }

  private async invoke(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const result = await this.connection.rpc.call(CHANNEL, endpoint, payload, signal)
    if (!result.ok) throw new WorkspaceApiError(assertWorkspaceRpcError(result.error))
    return result.value
  }
}

/** Compatibility name retained for existing Browser registration imports. */
export class WorkspaceApiClient extends WorkspaceApi {}

function assertMutationResult(value: unknown): WorkspaceMutationResult<unknown> {
  if (!isRecord(value) || !hasExactKeys(value, ['revision', 'value']) || !isNonNegativeInteger(value['revision']) || !('value' in value)) {
    throw invalid('mutation result')
  }
  return value as unknown as WorkspaceMutationResult<unknown>
}

function assertWorkspaceSnapshot(value: unknown): WorkspaceSnapshot {
  if (!isRecord(value)
    || !hasKeys(value, ['workspaceId', 'revision', 'nextId', 'nextSequence', 'definitions', 'definitionRevisions', 'agents', 'rooms', 'memberships', 'events', 'memoryEntries', 'tasks', 'taskAssignments', 'delegationGrants', 'childRuns', 'sessionBindings'])
    || typeof value['workspaceId'] !== 'string' || !isNonNegativeInteger(value['revision'])
    || !isPositiveInteger(value['nextId']) || !isPositiveInteger(value['nextSequence'])
    || !['definitions', 'definitionRevisions', 'agents', 'rooms', 'memberships', 'tasks', 'taskAssignments', 'delegationGrants', 'childRuns', 'sessionBindings'].every(key => isRecord(value[key]))
    || !Array.isArray(value['events']) || !Array.isArray(value['memoryEntries'])) throw invalid('snapshot')
  return structuredClone(value) as unknown as WorkspaceSnapshot
}

function assertWorkspaceRuntimeStatus(value: unknown): WorkspaceRuntimeStatus {
  if (!isRecord(value) || !isRecord(value['rooms'])) throw invalid('runtime status')
  for (const room of Object.values(value['rooms'])) {
    if (!isRecord(room) || !isNonNegativeInteger(room['pending']) || (room['error'] !== undefined && typeof room['error'] !== 'string')) throw invalid('runtime status')
  }
  return structuredClone(value) as unknown as WorkspaceRuntimeStatus
}

function assertWorkspaceActivitySnapshot(value: unknown): WorkspaceActivitySnapshot {
  if (!isRecord(value) || !isNonNegativeInteger(value['version']) || !isNonNegativeInteger(value['workspaceRevision'])
    || !Array.isArray(value['activities']) || !Array.isArray(value['agents'])) throw invalid('activity snapshot')
  const activityIds = new Set<string>()
  for (const activity of value['activities']) {
    if (!isRecord(activity) || typeof activity['activityId'] !== 'string' || activityIds.has(activity['activityId'])
      || typeof activity['agentId'] !== 'string' || !isRecord(activity['source']) || typeof activity['messageId'] !== 'string'
      || !isPositiveInteger(activity['startOrder']) || !['queued', 'responding', 'stopping', 'settled'].includes(String(activity['status']))
      || !Array.isArray(activity['blocks'])) throw invalid('activity snapshot')
    activityIds.add(activity['activityId'])
  }
  return structuredClone(value) as unknown as WorkspaceActivitySnapshot
}

function assertMemoryPage(value: unknown): MemoryPage {
  if (!isRecord(value) || !isNonNegativeInteger(value['snapshotRevision']) || !Array.isArray(value['items'])
    || (value['nextCursor'] !== undefined && typeof value['nextCursor'] !== 'string')) throw invalid('memory page')
  return structuredClone(value) as unknown as MemoryPage
}

function assertDefinitionHistory(value: unknown): readonly DefinitionHistoryItem[] {
  if (!Array.isArray(value) || !value.every(item => isRecord(item) && typeof item['id'] === 'string'
    && (item['status'] === 'current' || item['status'] === 'previous') && isRecord(item['creationEvent']) && Array.isArray(item['agentIds']))) throw invalid('definition history')
  return structuredClone(value) as readonly DefinitionHistoryItem[]
}

function assertAssignTaskResult(value: unknown): AssignHumanTaskResultView {
  if (!isRecord(value) || typeof value['taskId'] !== 'string' || typeof value['taskAssignmentId'] !== 'string') throw invalid('task assignment result')
  return { ...value, state: assertWorkspaceSnapshot(value['state']) } as AssignHumanTaskResultView
}

function assertGrantTaskResult(value: unknown): GrantTaskDelegationResultView {
  if (!isRecord(value) || typeof value['delegationGrantId'] !== 'string') throw invalid('task delegation result')
  return { ...value, state: assertWorkspaceSnapshot(value['state']) } as GrantTaskDelegationResultView
}

function assertStopResult(value: unknown): WorkspaceStopResult {
  if (!isRecord(value) || !hasExactKeys(value, ['status']) || !['stopping', 'already-stopping', 'not-active'].includes(String(value['status']))) throw invalid('stop result')
  return structuredClone(value) as unknown as WorkspaceStopResult
}

function assertMemoryStart(value: MembershipMemoryStart): void {
  if (value.type === 'new-events') return
  if (!isPositiveInteger(value.startSequence) || !isPositiveInteger(value.endSequence) || value.endSequence < value.startSequence) {
    throw new Error('Agent Workspace membership event range must be a bounded ascending range')
  }
}

function assertWorkspaceRpcError(value: unknown): WorkspaceRpcError {
  if (!isRecord(value) || typeof value['kind'] !== 'string' || typeof value['code'] !== 'string'
    || typeof value['message'] !== 'string' || !isRecord(value['details'])) {
    return { kind: 'internal', code: 'internal', message: 'Agent Workspace request failed', details: {} }
  }
  return structuredClone(value) as WorkspaceRpcError
}

function requireNonNegativeInteger(name: string, value: number): void {
  if (!isNonNegativeInteger(value)) throw new Error(`Agent Workspace ${name} must be a non-negative safe integer`)
}
function invalid(subject: string): Error { return new Error(`Agent Workspace returned an invalid ${subject}`) }
function isPositiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }
function isNonNegativeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return keys.every(key => key in value) }
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value).toSorted(); return actual.length === keys.length && actual.every((key, index) => key === [...keys].toSorted()[index]) }
