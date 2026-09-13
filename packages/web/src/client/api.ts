/** Browser adapter over this plugin's isolated Connection RPC channel. */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { WORKSPACE_EVENT_TYPES } from './contracts.ts'
import type {
  AgentDefinitionId, AgentId, AssignHumanTaskResultView, ChildRunId, CreateDefinitionInput,
  DefinitionHistoryItem, DefinitionRevisionId, DelegationGrantId, GrantTaskDelegationResultView,
  MembershipId, MembershipMemoryStart, MemoryPage, MemoryQuery, ReviseDefinitionInput, RoomId,
  TaskId, WorkspaceActivityIdentity, WorkspaceActivitySnapshot, WorkspaceDirectRoomResult,
  WorkspaceMutationEndpoint, WorkspaceMutationRequestMap, WorkspaceMutationResult,
  WorkspaceMutationValueMap, WorkspaceRpcError, WorkspaceRuntimeStatus, WorkspaceSnapshot,
  WorkspaceStopResult,
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
  async mutate<Endpoint extends WorkspaceMutationEndpoint>(
    endpoint: Endpoint,
    payload: WorkspaceMutationRequestMap[Endpoint],
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<WorkspaceMutationResult<WorkspaceMutationValueMap[Endpoint]>> {
    requireNonNegativeInteger('expected revision', expectedRevision)
    if ('expectedRevision' in payload || 'actorAgentId' in payload || 'humanId' in payload || 'actor' in payload) {
      throw new Error('Agent Workspace mutation payload contains a client-owned actor or revision field')
    }
    return assertMutationResult(endpoint, await this.invoke(endpoint, { expectedRevision, ...payload }, signal))
  }

  createDefinition(input: CreateDefinitionInput, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.mutate('definition/create', input, expectedRevision, signal).then(result => result.value)
  }

  reviseDefinition(input: ReviseDefinitionInput, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.mutate('definition/revise', input, expectedRevision, signal).then(result => result.value)
  }

  synchronizeDefinition(definitionId: AgentDefinitionId, definitionRevisionId: DefinitionRevisionId, agentIds: readonly AgentId[], expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.mutate('definition/synchronize', { definitionId, definitionRevisionId, agentIds }, expectedRevision, signal).then(result => result.value)
  }

  createAgent(definitionId: AgentDefinitionId, name: string, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.mutate('agent/create', { definitionId, name }, expectedRevision, signal).then(result => result.value)
  }

  setEmployment(agentId: AgentId, employed: boolean, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.mutate(employed ? 'agent/employ' : 'agent/depart', { agentId }, expectedRevision, signal).then(result => result.value)
  }

  createGroup(name: string, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.mutate('room/create', { kind: 'group', name }, expectedRevision, signal).then(result => result.value)
  }

  async openDirect(agentId: AgentId, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceDirectRoomResult> {
    const { value } = await this.mutate('room/direct/open', { agentId }, expectedRevision, signal)
    return { snapshot: value.state, roomId: value.roomId }
  }

  async joinRoom(roomId: RoomId, agentId: AgentId, memoryStart: MembershipMemoryStart, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    assertMemoryStart(memoryStart)
    const result = await this.mutate('room/join', { roomId, agentId, memoryStart }, expectedRevision, signal)
    return result.value
  }

  leaveRoom(membershipId: MembershipId, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.mutate('room/leave', { membershipId }, expectedRevision, signal).then(result => result.value)
  }

  postMessage(roomId: RoomId, text: string, mentions: readonly AgentId[], expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.mutate('room/post', { roomId, text, mentions }, expectedRevision, signal).then(result => result.value)
  }

  assignTask(assigneeAgentId: AgentId, title: string, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceMutationResult<AssignHumanTaskResultView>> {
    return this.mutate('task/assign', { assigneeAgentId, title }, expectedRevision, signal)
  }

  grantTask(granteeAgentId: AgentId, rootTaskId: TaskId, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceMutationResult<GrantTaskDelegationResultView>> {
    return this.mutate('task/grant', { granteeAgentId, rootTaskId }, expectedRevision, signal)
  }

  revokeTask(delegationGrantId: DelegationGrantId, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.mutate('task/revoke', { delegationGrantId }, expectedRevision, signal).then(result => result.value)
  }

  cancelTask(taskId: TaskId, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.mutate('task/cancel', { taskId }, expectedRevision, signal).then(result => result.value)
  }

  retryTaskDelivery(taskId: TaskId, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceMutationResult<string>> {
    return this.mutate('task/retry-delivery', { taskId }, expectedRevision, signal)
  }

  stopActivity(identity: WorkspaceActivityIdentity, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceMutationResult<WorkspaceStopResult>> {
    return this.mutate('runtime/activity/stop', identity, expectedRevision, signal)
  }

  stopChildRun(childRunId: ChildRunId, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceMutationResult<WorkspaceStopResult>> {
    return this.mutate('runtime/child/stop', { childRunId }, expectedRevision, signal)
  }

  acknowledgeAgentFailure(agentId: AgentId, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceMutationResult<void>> {
    return this.mutate('runtime/failure/acknowledge', { agentId }, expectedRevision, signal)
  }

  private async invoke(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const result = await this.connection.rpc.call(CHANNEL, endpoint, payload, signal)
    if (!result.ok) throw new WorkspaceApiError(assertWorkspaceRpcError(result.error))
    return result.value
  }
}

/** Compatibility name retained for existing Browser registration imports. */
export class WorkspaceApiClient extends WorkspaceApi {}

function assertMutationResult<Endpoint extends WorkspaceMutationEndpoint>(
  endpoint: Endpoint,
  value: unknown,
): WorkspaceMutationResult<WorkspaceMutationValueMap[Endpoint]> {
  if (!isRecord(value) || !isNonNegativeInteger(value['revision'])
    || (endpoint === 'runtime/failure/acknowledge'
      ? !hasExactKeys(value, ['revision'])
      : !hasExactKeys(value, ['revision', 'value']))) {
    throw invalid('mutation result')
  }
  const revision = value['revision']
  const parsed = assertMutationValue(endpoint, value['value'], revision)
  return { revision, value: parsed as WorkspaceMutationValueMap[Endpoint] }
}

function assertMutationValue(endpoint: WorkspaceMutationEndpoint, value: unknown, revision: number): WorkspaceMutationValueMap[WorkspaceMutationEndpoint] {
  switch (endpoint) {
    case 'definition/create':
    case 'definition/revise':
    case 'definition/synchronize':
    case 'agent/create':
    case 'agent/depart':
    case 'agent/employ':
    case 'room/create':
    case 'room/join':
    case 'room/leave':
    case 'room/post':
    case 'task/revoke':
    case 'task/cancel':
      return assertCommittedSnapshot(value, revision)
    case 'room/direct/open': {
      if (!isRecord(value) || !hasExactKeys(value, ['state', 'roomId']) || !isNonEmptyString(value['roomId'])) throw invalid('direct-room result')
      return { state: assertCommittedSnapshot(value['state'], revision), roomId: value['roomId'] }
    }
    case 'task/assign': {
      if (!isRecord(value) || !hasExactKeys(value, ['state', 'taskId', 'taskAssignmentId'])
        || !isNonEmptyString(value['taskId']) || !isNonEmptyString(value['taskAssignmentId'])) throw invalid('task assignment result')
      return { state: assertCommittedSnapshot(value['state'], revision), taskId: value['taskId'], taskAssignmentId: value['taskAssignmentId'] }
    }
    case 'task/grant': {
      if (!isRecord(value) || !hasExactKeys(value, ['state', 'delegationGrantId']) || !isNonEmptyString(value['delegationGrantId'])) throw invalid('task delegation result')
      return { state: assertCommittedSnapshot(value['state'], revision), delegationGrantId: value['delegationGrantId'] }
    }
    case 'task/retry-delivery':
      if (typeof value !== 'string') throw invalid('task retry result')
      return value
    case 'runtime/activity/stop':
    case 'runtime/child/stop':
      return assertStopResult(value)
    case 'runtime/failure/acknowledge':
      if (value !== undefined) throw invalid('failure acknowledgement result')
      return undefined
  }
}

function assertCommittedSnapshot(value: unknown, revision: number): WorkspaceSnapshot {
  const snapshot = assertWorkspaceSnapshot(value)
  if (snapshot.revision !== revision) throw invalid('mutation revision')
  return snapshot
}

function assertWorkspaceSnapshot(value: unknown): WorkspaceSnapshot {
  if (!isRecord(value)
    || !hasExactKeys(value, ['workspaceId', 'revision', 'nextId', 'nextSequence', 'definitions', 'definitionRevisions', 'agents', 'rooms', 'memberships', 'events', 'memoryEntries', 'tasks', 'taskAssignments', 'delegationGrants', 'childRuns', 'sessionBindings'])
    || !isNonEmptyString(value['workspaceId']) || !isNonNegativeInteger(value['revision'])
    || !isPositiveInteger(value['nextId']) || !isPositiveInteger(value['nextSequence'])
    || !isRecordMap(value['definitions'], isAgentDefinition)
    || !isRecordMap(value['definitionRevisions'], isDefinitionRevision)
    || !isRecordMap(value['agents'], isAgent)
    || !isRecordMap(value['rooms'], isRoom)
    || !isRecordMap(value['memberships'], isMembership)
    || !Array.isArray(value['events']) || !value['events'].every(isWorkspaceEvent)
    || !Array.isArray(value['memoryEntries']) || !value['memoryEntries'].every(isMemoryEntry)
    || !isRecordMap(value['tasks'], isTask)
    || !isRecordMap(value['taskAssignments'], isTaskAssignment)
    || !isRecordMap(value['delegationGrants'], isDelegationGrant)
    || !isRecordMap(value['childRuns'], isChildRun)
    || !isRecordMap(value['sessionBindings'], isNonEmptyString)) throw invalid('snapshot')
  return structuredClone(value) as unknown as WorkspaceSnapshot
}

function isAgentDefinition(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['id', 'name', 'revisionIds', 'currentRevisionId'])
    && isNonEmptyString(value['id']) && typeof value['name'] === 'string'
    && isStringArray(value['revisionIds']) && isNonEmptyString(value['currentRevisionId'])
}

function isDefinitionRevision(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['id', 'definitionId', 'number', 'description', 'instructions'])
    && isNonEmptyString(value['id']) && isNonEmptyString(value['definitionId']) && isPositiveInteger(value['number'])
    && typeof value['description'] === 'string' && typeof value['instructions'] === 'string'
}

function isAgent(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['id', 'name', 'definitionId', 'definitionRevisionId', 'employmentStatus', 'employmentPeriods'])
    && isNonEmptyString(value['id']) && typeof value['name'] === 'string' && isNonEmptyString(value['definitionId'])
    && isNonEmptyString(value['definitionRevisionId']) && isOneOf(value['employmentStatus'], ['employed', 'departed'])
    && Array.isArray(value['employmentPeriods']) && value['employmentPeriods'].every(isEmploymentPeriod)
}

function isEmploymentPeriod(value: unknown): boolean {
  return isRecord(value) && hasRequiredAndOnlyKeys(value, ['id', 'startedEventId'], ['endedEventId'])
    && isNonEmptyString(value['id']) && isNonEmptyString(value['startedEventId'])
    && isOptionalNonEmptyString(value['endedEventId'])
}

function isRoom(value: unknown): boolean {
  return isRecord(value) && hasRequiredAndOnlyKeys(value, ['id', 'kind'], ['name'])
    && isNonEmptyString(value['id']) && isOneOf(value['kind'], ['group', 'direct']) && isOptionalString(value['name'])
}

function isMembership(value: unknown): boolean {
  return isRecord(value) && hasRequiredAndOnlyKeys(value, ['id', 'roomId', 'agentId', 'memoryStart', 'joinedEventId'], ['leftEventId'])
    && isNonEmptyString(value['id']) && isNonEmptyString(value['roomId']) && isNonEmptyString(value['agentId'])
    && isMemoryStart(value['memoryStart']) && isNonEmptyString(value['joinedEventId']) && isOptionalNonEmptyString(value['leftEventId'])
}

function isMemoryStart(value: unknown): boolean {
  if (!isRecord(value) || typeof value['type'] !== 'string') return false
  if (value['type'] === 'new-events') return hasExactKeys(value, ['type'])
  return value['type'] === 'event-range' && hasExactKeys(value, ['type', 'startSequence', 'endSequence'])
    && isPositiveInteger(value['startSequence']) && isPositiveInteger(value['endSequence'])
    && value['startSequence'] <= value['endSequence']
}

function isWorkspaceActor(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['type', 'id'])
    && isOneOf(value['type'], ['human', 'agent']) && isNonEmptyString(value['id'])
}

function isWorkspaceEvent(value: unknown): boolean {
  if (!isRecord(value) || !isNonEmptyString(value['id']) || !isPositiveInteger(value['sequence'])
    || !isOneOf(value['type'], WORKSPACE_EVENT_TYPES)
    || !isOptionalNonEmptyString(value['subjectId']) || !isOptionalNonEmptyString(value['definitionRevisionId'])
    || (value['actor'] !== undefined && !isWorkspaceActor(value['actor']))
    || !isOptionalString(value['text']) || (value['mentions'] !== undefined && !isStringArray(value['mentions']))) return false
  const base = ['id', 'sequence', 'type', 'subjectId', 'definitionRevisionId', 'actor', 'text', 'mentions']
  switch (value['type']) {
    case 'child/run-finished':
      return hasRequiredAndOnlyKeys(value, ['id', 'sequence', 'type', 'childRunStatus'], base.slice(3))
        && isOneOf(value['childRunStatus'], ['completed', 'failed', 'cancelled'])
    case 'task/delivery-started':
    case 'task/delivery-accepted':
      return hasRequiredAndOnlyKeys(value, ['id', 'sequence', 'type', 'taskId', 'taskDeliveryAttemptId', 'messageId'], [...base.slice(3), 'failureCode', 'failureSummary'])
        && isNonEmptyString(value['taskId']) && isNonEmptyString(value['taskDeliveryAttemptId']) && isNonEmptyString(value['messageId'])
        && value['failureCode'] === undefined && value['failureSummary'] === undefined
    case 'task/delivery-failed':
      return hasRequiredAndOnlyKeys(value, ['id', 'sequence', 'type', 'taskId', 'taskDeliveryAttemptId', 'messageId', 'failureCode', 'failureSummary'], base.slice(3))
        && isNonEmptyString(value['taskId']) && isNonEmptyString(value['taskDeliveryAttemptId']) && isNonEmptyString(value['messageId'])
        && typeof value['failureCode'] === 'string' && typeof value['failureSummary'] === 'string'
    case 'task/result':
    case 'task/result-after-cancel':
      return hasRequiredAndOnlyKeys(value, ['id', 'sequence', 'type', 'taskId', 'taskDeliveryAttemptId', 'definitionRevisionId', 'text'], ['subjectId', 'actor', 'mentions'])
        && isNonEmptyString(value['taskId']) && isNonEmptyString(value['taskDeliveryAttemptId'])
    case 'task/cancelled':
      return hasRequiredAndOnlyKeys(value, ['id', 'sequence', 'type', 'subjectId'], ['definitionRevisionId', 'actor', 'text', 'mentions', 'cancellationScope'])
        && (value['cancellationScope'] === undefined || isOneOf(value['cancellationScope'], ['root-cascade', 'derived-only']))
    case 'task/delegation-revoked':
      return hasRequiredAndOnlyKeys(value, ['id', 'sequence', 'type', 'subjectId'], ['definitionRevisionId', 'actor', 'text', 'mentions'])
    default:
      return hasRequiredAndOnlyKeys(value, ['id', 'sequence', 'type'], base.slice(3))
        && value['childRunStatus'] === undefined
  }
}

function isMemoryEntry(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['id', 'agentId', 'eventId', 'acquiredBy'])
    && isNonEmptyString(value['id']) && isNonEmptyString(value['agentId']) && isNonEmptyString(value['eventId'])
    && isOneOf(value['acquiredBy'], ['room-membership', 'history-sync', 'task', 'child-result'])
}

function isTask(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['id', 'rootTaskId', 'title', 'status'])
    && isNonEmptyString(value['id']) && isNonEmptyString(value['rootTaskId']) && typeof value['title'] === 'string'
    && isOneOf(value['status'], ['open', 'completed', 'cancelled'])
}

function isTaskAssignment(value: unknown): boolean {
  return isRecord(value) && hasRequiredAndOnlyKeys(value, ['id', 'taskId', 'rootTaskId', 'assigneeAgentId'], ['grantId'])
    && isNonEmptyString(value['id']) && isNonEmptyString(value['taskId']) && isNonEmptyString(value['rootTaskId'])
    && isNonEmptyString(value['assigneeAgentId']) && isOptionalNonEmptyString(value['grantId'])
}

function isDelegationGrant(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['id', 'rootTaskId', 'granteeAgentId', 'grantedByHumanId', 'status'])
    && isNonEmptyString(value['id']) && isNonEmptyString(value['rootTaskId']) && isNonEmptyString(value['granteeAgentId'])
    && isNonEmptyString(value['grantedByHumanId']) && isOneOf(value['status'], ['active', 'expired'])
}

function isChildRun(value: unknown): boolean {
  if (!isRecord(value) || !hasRequiredAndOnlyKeys(value, ['id', 'parentAgentId', 'taskId', 'status'], ['result'])
    || !isNonEmptyString(value['id']) || !isNonEmptyString(value['parentAgentId']) || !isNonEmptyString(value['taskId'])) return false
  if (value['status'] === 'running') return value['result'] === undefined
  return isOneOf(value['status'], ['completed', 'failed', 'cancelled']) && typeof value['result'] === 'string'
}

function assertWorkspaceRuntimeStatus(value: unknown): WorkspaceRuntimeStatus {
  if (!isRecord(value) || !hasExactKeys(value, ['rooms']) || !isRecord(value['rooms'])) throw invalid('runtime status')
  for (const room of Object.values(value['rooms'])) {
    if (!isRecord(room) || !hasRequiredAndOnlyKeys(room, ['pending'], ['error'])
      || !isNonNegativeInteger(room['pending']) || !isOptionalString(room['error'])) throw invalid('runtime status')
  }
  return structuredClone(value) as unknown as WorkspaceRuntimeStatus
}

function assertWorkspaceActivitySnapshot(value: unknown): WorkspaceActivitySnapshot {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'workspaceRevision', 'activities', 'agents'])
    || !isNonNegativeInteger(value['version']) || !isNonNegativeInteger(value['workspaceRevision'])
    || !Array.isArray(value['activities']) || !Array.isArray(value['agents'])) throw invalid('activity snapshot')
  const activityIds = new Set<string>()
  for (const activity of value['activities']) {
    if (!isActivity(activity) || activityIds.has(activity['activityId'])) throw invalid('activity snapshot')
    activityIds.add(activity['activityId'])
  }
  const agentIds = new Set<string>()
  for (const agent of value['agents']) {
    if (!isAgentActivitySummary(agent) || agentIds.has(agent['agentId'])) throw invalid('activity snapshot')
    agentIds.add(agent['agentId'])
  }
  return structuredClone(value) as unknown as WorkspaceActivitySnapshot
}

function isActivity(value: unknown): value is Record<string, unknown> & { activityId: string } {
  return isRecord(value) && hasRequiredAndOnlyKeys(value, ['activityId', 'agentId', 'source', 'messageId', 'startOrder', 'status', 'blocks'], ['claimed', 'terminalReason', 'error'])
    && isNonEmptyString(value['activityId']) && isNonEmptyString(value['agentId']) && isActivitySource(value['source'])
    && isNonEmptyString(value['messageId']) && isPositiveInteger(value['startOrder'])
    && isOneOf(value['status'], ['queued', 'responding', 'stopping', 'settled'])
    && (value['claimed'] === undefined || isClaimedActivity(value['claimed']))
    && Array.isArray(value['blocks']) && value['blocks'].every(isActivityBlock)
    && isOptionalString(value['terminalReason']) && (value['error'] === undefined || isActivityError(value['error']))
}

function isActivitySource(value: unknown): boolean {
  if (!isRecord(value)) return false
  return value['kind'] === 'room'
    ? hasExactKeys(value, ['kind', 'roomId']) && isNonEmptyString(value['roomId'])
    : value['kind'] === 'task' && hasExactKeys(value, ['kind', 'taskId', 'attemptId'])
      && isNonEmptyString(value['taskId']) && isNonEmptyString(value['attemptId'])
}

function isClaimedActivity(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['sessionId', 'turn'])
    && isNonEmptyString(value['sessionId']) && isNonNegativeInteger(value['turn'])
}

function isActivityBlock(value: unknown): boolean {
  if (!isRecord(value) || !isNonNegativeInteger(value['index'])) return false
  switch (value['kind']) {
    case 'text':
    case 'reasoning':
      return hasExactKeys(value, ['kind', 'index', 'text']) && typeof value['text'] === 'string'
    case 'tool':
      return hasRequiredAndOnlyKeys(value, ['kind', 'index', 'callId', 'name', 'arguments', 'status'], ['resultText', 'error'])
        && isNonEmptyString(value['callId']) && typeof value['name'] === 'string' && typeof value['arguments'] === 'string'
        && isOneOf(value['status'], ['running', 'completed', 'failed']) && isOptionalString(value['resultText'])
        && (value['error'] === undefined || isActivityError(value['error']))
    case 'unknown':
      return hasExactKeys(value, ['kind', 'index', 'label', 'value']) && typeof value['label'] === 'string' && isJsonSafe(value['value'])
    default:
      return false
  }
}

function isActivityError(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['code', 'summary'])
    && typeof value['code'] === 'string' && typeof value['summary'] === 'string'
}

function isAgentActivitySummary(value: unknown): value is Record<string, unknown> & { agentId: string } {
  return isRecord(value) && hasRequiredAndOnlyKeys(value, ['agentId', 'status', 'usingTool'], ['error'])
    && isNonEmptyString(value['agentId']) && isOneOf(value['status'], ['idle', 'active', 'failed'])
    && typeof value['usingTool'] === 'boolean' && (value['error'] === undefined || isActivityError(value['error']))
}

function assertMemoryPage(value: unknown): MemoryPage {
  if (!isRecord(value) || !hasRequiredAndOnlyKeys(value, ['snapshotRevision', 'items'], ['nextCursor'])
    || !isNonNegativeInteger(value['snapshotRevision']) || !Array.isArray(value['items']) || !value['items'].every(isMemoryItem)
    || !isOptionalNonEmptyString(value['nextCursor'])) throw invalid('memory page')
  return structuredClone(value) as unknown as MemoryPage
}

function isMemoryItem(value: unknown): boolean {
  return isRecord(value) && hasRequiredAndOnlyKeys(value, ['eventId', 'sequence', 'type', 'provenance', 'definitionRevision'], ['source', 'actor', 'subject', 'text', 'childStatus'])
    && isNonEmptyString(value['eventId']) && isPositiveInteger(value['sequence']) && isOneOf(value['type'], WORKSPACE_EVENT_TYPES)
    && isOneOf(value['provenance'], ['room-membership', 'history-sync', 'task', 'child-result'])
    && (value['source'] === undefined || isMemorySource(value['source']))
    && (value['actor'] === undefined || isMemoryActor(value['actor']))
    && (value['subject'] === undefined || isLabelledId(value['subject'])) && isOptionalString(value['text'])
    && (value['childStatus'] === undefined || isOneOf(value['childStatus'], ['completed', 'failed', 'cancelled']))
    && isMemoryDefinitionRevision(value['definitionRevision'])
}

function isMemorySource(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value['kind'] === 'room' || value['kind'] === 'task') {
    return hasExactKeys(value, ['kind', 'id', 'label']) && isNonEmptyString(value['id']) && typeof value['label'] === 'string'
  }
  return value['kind'] === 'child' && hasExactKeys(value, ['kind', 'id', 'label', 'taskId', 'taskLabel'])
    && isNonEmptyString(value['id']) && typeof value['label'] === 'string'
    && isNonEmptyString(value['taskId']) && typeof value['taskLabel'] === 'string'
}

function isMemoryActor(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['type', 'id', 'label'])
    && isOneOf(value['type'], ['human', 'agent']) && isNonEmptyString(value['id']) && typeof value['label'] === 'string'
}

function isLabelledId(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['id', 'label'])
    && isNonEmptyString(value['id']) && typeof value['label'] === 'string'
}

function isMemoryDefinitionRevision(value: unknown): boolean {
  if (!isRecord(value)) return false
  return value['status'] === 'unresolved'
    ? hasExactKeys(value, ['status'])
    : value['status'] === 'active' && hasExactKeys(value, ['status', 'id', 'number'])
      && isNonEmptyString(value['id']) && isPositiveInteger(value['number'])
}

function assertDefinitionHistory(value: unknown): readonly DefinitionHistoryItem[] {
  if (!Array.isArray(value) || !value.every(isDefinitionHistoryItem)) throw invalid('definition history')
  return structuredClone(value) as readonly DefinitionHistoryItem[]
}

function isDefinitionHistoryItem(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['id', 'definitionId', 'number', 'description', 'instructions', 'creationEvent', 'status', 'agentIds'])
    && isNonEmptyString(value['id']) && isNonEmptyString(value['definitionId']) && isPositiveInteger(value['number'])
    && typeof value['description'] === 'string' && typeof value['instructions'] === 'string'
    && isDefinitionCreationEvent(value['creationEvent']) && isOneOf(value['status'], ['current', 'previous'])
    && isStringArray(value['agentIds'])
}

function isDefinitionCreationEvent(value: unknown): boolean {
  if (!isRecord(value)) return false
  return value['status'] === 'unresolved'
    ? hasExactKeys(value, ['status'])
    : isOneOf(value['status'], ['exact', 'derived']) && hasExactKeys(value, ['status', 'sequence'])
      && isPositiveInteger(value['sequence'])
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
  if (!isRecord(value) || !hasExactKeys(value, ['kind', 'code', 'message', 'details'])
    || typeof value['message'] !== 'string' || !isRecord(value['details']) || !isWorkspaceRpcErrorDetails(value)) return internalError()
  return structuredClone(value) as WorkspaceRpcError
}

function isWorkspaceRpcErrorDetails(value: Record<string, unknown>): boolean {
  const details = value['details']
  if (!isRecord(details)) return false
  if (value['kind'] === 'bad-request') {
    return value['code'] === 'bad-request' && hasExactKeys(details, ['issues']) && Array.isArray(details['issues'])
  }
  if (value['kind'] === 'cancelled' || value['kind'] === 'internal') {
    return value['code'] === value['kind'] && hasExactKeys(details, [])
  }
  if (value['kind'] !== 'business') return false
  switch (value['code']) {
    case 'reserved-direct-routing':
      return hasExactKeys(details, ['roomId', 'token']) && isNonEmptyString(details['roomId']) && details['token'] === '@all'
    case 'agent-missing':
    case 'agent-departed':
      return hasExactKeys(details, ['agentId']) && isNonEmptyString(details['agentId'])
    case 'duplicate-membership':
      return hasExactKeys(details, ['roomId', 'agentId']) && isNonEmptyString(details['roomId']) && isNonEmptyString(details['agentId'])
    case 'stale-revision':
      return hasExactKeys(details, ['definitionId', 'revisionId'])
        ? isNonEmptyString(details['definitionId']) && isNonEmptyString(details['revisionId'])
        : hasExactKeys(details, ['expectedRevision', 'actualRevision'])
          && isNonNegativeInteger(details['expectedRevision']) && isNonNegativeInteger(details['actualRevision'])
    case 'invalid-task-authority':
    case 'task-not-assigned':
      return hasExactKeys(details, ['taskId', 'agentId']) && isNonEmptyString(details['taskId']) && isNonEmptyString(details['agentId'])
    case 'task-not-open':
      return hasExactKeys(details, ['taskId', 'status']) && isNonEmptyString(details['taskId'])
        && isOneOf(details['status'], ['completed', 'cancelled'])
    case 'delegation-grant-missing':
      return details['lookup'] === 'id'
        ? hasExactKeys(details, ['lookup', 'delegationGrantId']) && isNonEmptyString(details['delegationGrantId'])
        : details['lookup'] === 'root-agent' && hasExactKeys(details, ['lookup', 'rootTaskId', 'agentId'])
          && isNonEmptyString(details['rootTaskId']) && isNonEmptyString(details['agentId'])
    case 'delegation-grant-inactive':
      return hasExactKeys(details, ['delegationGrantId']) && isNonEmptyString(details['delegationGrantId'])
    default:
      return false
  }
}

function internalError(): WorkspaceRpcError {
  return { kind: 'internal', code: 'internal', message: 'Agent Workspace request failed', details: {} }
}

function requireNonNegativeInteger(name: string, value: number): void {
  if (!isNonNegativeInteger(value)) throw new Error(`Agent Workspace ${name} must be a non-negative safe integer`)
}
function invalid(subject: string): Error { return new Error(`Agent Workspace returned an invalid ${subject}`) }
function isPositiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }
function isNonNegativeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function isNonEmptyString(value: unknown): value is string { return typeof value === 'string' && value.trim() !== '' }
function isOptionalString(value: unknown): boolean { return value === undefined || typeof value === 'string' }
function isOptionalNonEmptyString(value: unknown): boolean { return value === undefined || isNonEmptyString(value) }
function isStringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every(isNonEmptyString) }
function isOneOf<const Value extends string>(value: unknown, values: readonly Value[]): value is Value { return typeof value === 'string' && values.includes(value as Value) }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value).toSorted(); return actual.length === keys.length && actual.every((key, index) => key === [...keys].toSorted()[index]) }
function hasRequiredAndOnlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  return required.every(key => key in value) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
}
function isRecordMap(value: unknown, predicate: (entry: unknown) => boolean): value is Record<string, unknown> {
  return isRecord(value) && Object.values(value).every(predicate)
}
function isJsonSafe(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  return Array.isArray(value)
    ? value.every(item => isJsonSafe(item, seen))
    : Object.values(value as Record<string, unknown>).every(item => isJsonSafe(item, seen))
}
