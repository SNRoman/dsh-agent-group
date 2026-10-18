/** Browser adapter over this plugin's isolated Connection RPC channel. */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { WorkflowApiError, assertWorkflowRpcError } from './workflow-api.ts'
import type { WorkflowEndpoint } from './workflow-contracts.ts'
import { WORKSPACE_EVENT_TYPES } from './contracts.ts'
import type {
  AgentDefinitionId, AgentId, AssignHumanTaskResultView, ChildRunId, CreateDefinitionInput,
  DefinitionHistoryItem, DefinitionRevisionId, DelegationGrantId, GrantTaskDelegationResultView,
  MembershipId, MembershipMemoryStart, MemoryPage, MemoryQuery, ReviseDefinitionInput, RoomId,
  TaskId, WorkspaceActivityIdentity, WorkspaceActivitySnapshot, WorkspaceDirectRoomResult,
  WorkspaceMutationEndpoint, WorkspaceMutationRequestMap, WorkspaceMutationResult,
  WorkspaceMutationValueMap, WorkspaceRpcError, WorkspaceRuntimeStatus, WorkspaceSnapshot,
  WorkspaceStopResult,
  WorkspaceDescriptor, WorkspaceDirectoryEntry, WorkspaceImportPreview, WorkspaceExportResult,
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
  constructor(private readonly connection: Pick<ConnectionHandle, 'rpc'>, readonly workspaceId?: string, readonly readOnly = false) {}

  /** @param id Explicit directory identity. @param readOnly Whether aggregate mutations are disabled. @returns Immutable scoped client. */
  forWorkspace(id: string, readOnly = false): WorkspaceApiClient {
    requireWorkspaceId(id)
    const scoped = new WorkspaceApiClient(this.connection, id, readOnly)
    Object.freeze(scoped)
    return scoped
  }

  /** @param signal Cancellation signal. @returns Validated organization directory. */
  async listOrganizations(signal?: AbortSignal): Promise<readonly WorkspaceDirectoryEntry[]> {
    const value = await this.invoke('organization/list', {}, signal)
    if (!Array.isArray(value)) throw invalid('organization directory')
    const entries = value.map(assertDirectoryEntry)
    if (new Set(entries.map(entry => entry.descriptor.id)).size !== entries.length) throw invalid('organization directory')
    return entries
  }

  /** @param label Organization label. @param operationId Stable retry identity. @param signal Cancellation signal. @returns Created descriptor. */
  async createOrganization(label: string, operationId: string = crypto.randomUUID(), signal?: AbortSignal): Promise<WorkspaceDescriptor> {
    requireOperationId(operationId)
    return assertDescriptor(await this.invoke('organization/create', { operationId, label }, signal))
  }
  /** @param workspaceId Organization identity. @param label New label. @param signal Cancellation signal. @returns Renamed descriptor. */
  async renameOrganization(workspaceId: string, label: string, signal?: AbortSignal): Promise<WorkspaceDescriptor> {
    requireWorkspaceId(workspaceId)
    return assertDescriptor(await this.invoke('organization/rename', { workspaceId, label }, signal), workspaceId)
  }
  /** @param workspaceId Organization identity. @param mode Stop current work or wait for it. @param signal Cancellation signal. @returns Archived descriptor. */
  async archiveOrganization(workspaceId: string, mode: 'stop' | 'wait', signal?: AbortSignal): Promise<WorkspaceDescriptor> {
    requireWorkspaceId(workspaceId)
    return assertDescriptor(await this.invoke('organization/archive', { workspaceId, mode }, signal), workspaceId)
  }
  /** @param workspaceId Organization identity. @param signal Cancellation signal. @returns Reopened descriptor. */
  async reopenOrganization(workspaceId: string, signal?: AbortSignal): Promise<WorkspaceDescriptor> {
    requireWorkspaceId(workspaceId)
    return assertDescriptor(await this.invoke('organization/reopen', { workspaceId }, signal), workspaceId)
  }
  /** @param workspaceId Organization identity. @param confirmed Human confirmation of sensitive portable data. @param signal Cancellation signal. @returns Portable JSON. */
  async exportOrganization(workspaceId: string, confirmed: true, signal?: AbortSignal): Promise<WorkspaceExportResult> {
    requireWorkspaceId(workspaceId)
    const value = await this.invoke('organization/export', { workspaceId, confirmed }, signal)
    if (!isRecord(value) || !hasExactKeys(value, ['json', 'document']) || typeof value['json'] !== 'string' || !isJsonSafe(value['document'])) throw invalid('organization export')
    return { json: value['json'], document: structuredClone(value['document']) }
  }
  /** @param json Selected file contents. @param signal Cancellation signal. @returns Read-only import preview. */
  async previewImport(json: string, signal?: AbortSignal): Promise<WorkspaceImportPreview> {
    return assertImportPreview(await this.invoke('organization/import-preview', { json }, signal))
  }
  /** @param operationId Preview operation identity. @param json Previewed file. @param label Import label. @param confirmed Explicit human confirmation. @param signal Cancellation signal. @returns New organization descriptor. */
  async confirmImport(operationId: string, json: string, label: string, confirmed: true, signal?: AbortSignal): Promise<WorkspaceDescriptor> {
    requireOperationId(operationId)
    return assertDescriptor(await this.invoke('organization/import-confirm', { operationId, json, label, confirmed }, signal))
  }

  snapshot(signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.invoke('snapshot', {}, signal).then(value => {
      const snapshot = assertWorkspaceSnapshot(value)
      if (snapshot.workspaceId !== this.workspaceId) throw invalid('organization scope')
      return snapshot
    })
  }

  /** @param endpoint Workflow command or read. @param payload Caller fields. @param signal Cancellation. @returns Raw scoped value for workflow validation. */
  async callWorkflow(endpoint: WorkflowEndpoint | 'workflow/snapshot' | 'workflow/company-template/preview', payload: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown> {
    if (this.workspaceId === undefined) throw new Error('Agent Workspace requires a selected organization')
    if (Object.keys(payload).some(key => ['workspaceId', 'actor', 'actorAgentId', 'humanId', 'occurredAt', 'source'].includes(key))) throw new Error('Agent Workspace workflow payload contains Host-owned fields')
    const result = await this.connection.rpc.call(CHANNEL, endpoint, { ...payload, workspaceId: this.workspaceId }, signal)
    if (!result.ok) throw new WorkflowApiError(assertWorkflowRpcError(result.error))
    return result.value
  }

  /** @param endpoint Human chat work command or metadata read. @param payload Actor-free request. @param signal Cancellation. @returns Raw scoped value decoded by the communication API. */
  async callCommunication(endpoint: 'communication/snapshot' | 'communication/assign' | 'communication/confirm' | 'communication/recall-preview' | 'communication/recall' | 'communication/recall-files', payload: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown> {
    if (this.workspaceId === undefined) throw new Error('Agent Workspace requires a selected organization')
    if (Object.keys(payload).some(key => ['workspaceId', 'actor', 'actorAgentId', 'humanId', 'occurredAt', 'source'].includes(key))) throw new Error('Agent Workspace communication payload contains Host-owned fields')
    const result = await this.connection.rpc.call(CHANNEL, endpoint, { ...payload, workspaceId: this.workspaceId }, signal)
    if (!result.ok) throw new WorkflowApiError(assertWorkflowRpcError(result.error))
    return result.value
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
    if (this.readOnly) throw new Error('Agent Workspace selected organization is read-only')
    requireNonNegativeInteger('expected revision', expectedRevision)
    if ('expectedRevision' in payload || 'actorAgentId' in payload || 'humanId' in payload || 'actor' in payload) {
      throw new Error('Agent Workspace mutation payload contains a client-owned actor or revision field')
    }
    const result = assertMutationResult(endpoint, await this.invoke(endpoint, { expectedRevision, ...payload }, signal))
    const value = result.value
    const state = isRecord(value) && 'state' in value ? value['state'] : value
    if (isRecord(state) && 'workspaceId' in state && state['workspaceId'] !== this.workspaceId) throw invalid('organization scope')
    return result
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

  /** @param roomId Group identity. @param name Display name. @param expectedRevision CAS revision. @param signal Cancellation. @returns Committed snapshot with unchanged room identity. */
  renameRoom(roomId: RoomId, name: string, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.mutate('room/rename', { roomId, name }, expectedRevision, signal).then(result => result.value)
  }

  /** @param agentId Colleague identity. @param name Display name. @param expectedRevision CAS revision. @param signal Cancellation. @returns Committed snapshot with unchanged role and personal memory. */
  renameAgent(agentId: AgentId, name: string, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.mutate('agent/rename', { agentId, name }, expectedRevision, signal).then(result => result.value)
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

  /** @param membershipId Group membership. @param operationId Stable retry identity. @param expectedRevision Displayed revision. @param signal Precommit cancellation. @returns Snapshot after personal memory and native context reset. */
  leaveRoomAndForget(membershipId: MembershipId, operationId: string, expectedRevision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.mutate('room/leave-and-forget', { membershipId, operationId }, expectedRevision, signal).then(result => result.value)
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
    if (!endpoint.startsWith('organization/')) {
      if (this.workspaceId === undefined) throw new Error('Agent Workspace requires a selected organization')
      if (!isRecord(payload)) throw new Error('Agent Workspace requires a request object')
      payload = { ...payload, workspaceId: this.workspaceId }
    }
    const result = await this.connection.rpc.call(CHANNEL, endpoint, payload, signal)
    if (!result.ok) throw new WorkspaceApiError(assertWorkspaceRpcError(result.error))
    return result.value
  }
}

/** Compatibility name retained for existing Browser registration imports. */
export class WorkspaceApiClient extends WorkspaceApi {}

function assertDescriptor(value: unknown, expectedId?: string): WorkspaceDescriptor {
  if (!isRecord(value) || !hasRequiredAndOnlyKeys(value, ['id', 'label', 'lifecycle'], ['creation'])
    || !isWorkspaceId(value['id']) || !isNonEmptyString(value['label']) || /[\ud800-\udfff]/u.test(value['label'])
    || !isOneOf(value['lifecycle'], ['active', 'archived']) || (value['creation'] !== undefined && !isCreation(value['creation']))) throw invalid('organization descriptor')
  if (expectedId !== undefined && value['id'] !== expectedId) throw invalid('organization scope')
  return { id: value['id'], label: value['label'], lifecycle: value['lifecycle'] }
}
function isCreation(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['kind', 'createdAt', 'operationId', 'requestDigest'])
    && isOneOf(value['kind'], ['created', 'imported']) && isTimestamp(value['createdAt'])
    && isNonEmptyString(value['operationId']) && !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value['operationId'])
    && typeof value['requestDigest'] === 'string' && /^[0-9a-f]{64}$/u.test(value['requestDigest'])
}
function assertDirectoryEntry(value: unknown): WorkspaceDirectoryEntry {
  if (!isRecord(value) || !hasExactKeys(value, ['descriptor', 'revision', 'eventCount', 'agentCount'])
    || !isNonNegativeInteger(value['revision']) || !isNonNegativeInteger(value['eventCount']) || !isNonNegativeInteger(value['agentCount'])) throw invalid('organization directory entry')
  return { descriptor: assertDescriptor(value['descriptor']), revision: value['revision'], eventCount: value['eventCount'], agentCount: value['agentCount'] }
}
function assertImportPreview(value: unknown): WorkspaceImportPreview {
  if (!isRecord(value) || !hasExactKeys(value, ['operationId', 'sourceWorkspaceId', 'sourcePluginVersion', 'exportedAt', 'label', 'lifecycle', 'eventCount', 'agentCount', 'taskCount', 'sessionBindingsExcluded'])
    || !isWorkspaceId(value['operationId']) || !isWorkspaceId(value['sourceWorkspaceId']) || typeof value['sourcePluginVersion'] !== 'string'
    || !isTimestamp(value['exportedAt']) || !isNonEmptyString(value['label']) || !isOneOf(value['lifecycle'], ['active', 'archived'])
    || !isNonNegativeInteger(value['eventCount']) || !isNonNegativeInteger(value['agentCount']) || !isNonNegativeInteger(value['taskCount']) || value['sessionBindingsExcluded'] !== true) throw invalid('organization import preview')
  return { operationId: value['operationId'], sourceWorkspaceId: value['sourceWorkspaceId'], sourcePluginVersion: value['sourcePluginVersion'], exportedAt: value['exportedAt'], label: value['label'], lifecycle: value['lifecycle'], eventCount: value['eventCount'], agentCount: value['agentCount'], taskCount: value['taskCount'], sessionBindingsExcluded: true }
}
function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const date = new Date(value)
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value
}
function isWorkspaceId(value: unknown): value is string { return isNonEmptyString(value) && !/[\s:\u0000-\u001f\u007f-\u009f]/u.test(value) }
function requireWorkspaceId(value: string): void { if (!isWorkspaceId(value)) throw new Error('Agent Workspace organization id is invalid') }
function requireOperationId(value: string): void { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) throw new Error('Agent Workspace operation id must be a UUID') }

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
    case 'agent/rename':
    case 'agent/depart':
    case 'agent/employ':
    case 'room/create':
    case 'room/rename':
    case 'room/join':
    case 'room/leave':
    case 'room/leave-and-forget':
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
  return isRecord(value) && hasRequiredAndOnlyKeys(value, ['eventId', 'sequence', 'type', 'provenance', 'definitionRevision'], ['source', 'actor', 'subject', 'text', 'childStatus', 'processing'])
    && isNonEmptyString(value['eventId']) && isPositiveInteger(value['sequence']) && isOneOf(value['type'], WORKSPACE_EVENT_TYPES)
    && isOneOf(value['provenance'], ['room-membership', 'history-sync', 'task', 'child-result'])
    && (value['source'] === undefined || isMemorySource(value['source']))
    && (value['actor'] === undefined || isMemoryActor(value['actor']))
    && (value['subject'] === undefined || isLabelledId(value['subject'])) && isOptionalString(value['text'])
    && (value['childStatus'] === undefined || isOneOf(value['childStatus'], ['completed', 'failed', 'cancelled']))
    && isMemoryDefinitionRevision(value['definitionRevision'])
    && (value['processing'] === undefined || isMemoryProcessing(value['processing']))
}

function isMemoryProcessing(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['status', 'available', 'ranges', 'facts'])
    && isOneOf(value['status'], ['unprocessed', 'pending', 'partial', 'complete', 'failed', 'not-applicable'])
    && typeof value['available'] === 'boolean'
    && Array.isArray(value['ranges']) && value['ranges'].every(range => isRecord(range) && hasExactKeys(range, ['start', 'end'])
      && isNonNegativeInteger(range['start']) && isNonNegativeInteger(range['end']) && range['end'] >= range['start'])
    && Array.isArray(value['facts']) && value['facts'].every(isMemoryProcessingFact)
}

function isMemoryProcessingFact(value: unknown): boolean {
  if (!isRecord(value)) return false
  const common = ['id', 'kind', 'category', 'subject', 'key', 'value', 'scope', 'application', 'temporal', 'operation',
    'sourceEventIds', 'sourceQuote', 'assertionKind', 'validFromSequence', 'status', 'supersedesFactIds']
  const optional = ['validThroughSequence']
  const variant = value['kind'] === 'controlled'
    ? hasRequiredAndOnlyKeys(value, [...common, 'property'], [...optional, 'qualifier'])
      && isOneOf(value['property'], ['person.address', 'communication.language']) && value['key'] === value['property']
      && value['category'] === (value['property'] === 'person.address' ? 'address' : 'communication')
      && (value['qualifier'] === undefined || isRecord(value['qualifier']) && hasExactKeys(value['qualifier'], ['kind', 'tag', 'sourceQuote'])
        && value['qualifier']['kind'] === 'use-language' && isNonEmptyString(value['qualifier']['tag']) && isNonEmptyString(value['qualifier']['sourceQuote']))
    : value['kind'] === 'anchored'
      ? hasRequiredAndOnlyKeys(value, [...common, 'anchoredKind', 'conditions', 'alignment'], [...optional, 'topic', 'facet'])
        && isOneOf(value['anchoredKind'], ['preference', 'standing-agreement'])
        && value['category'] === (value['anchoredKind'] === 'preference' ? 'preference' : 'agreement')
        && isOptionalNonEmptyString(value['topic']) && isOptionalNonEmptyString(value['facet'])
        && Array.isArray(value['conditions']) && value['conditions'].every(isNonEmptyString)
        && isOneOf(value['alignment'], ['exact', 'unresolved'])
      : value['kind'] === 'context' && hasRequiredAndOnlyKeys(value, common, optional)
        && value['category'] === 'other' && value['key'] === 'context'
  return variant
    && isNonEmptyString(value['id']) && isOneOf(value['category'], ['address', 'communication', 'preference', 'agreement', 'task', 'other'])
    && isNonEmptyString(value['subject']) && isNonEmptyString(value['key']) && typeof value['value'] === 'string'
    && isRecord(value['scope']) && hasRequiredAndOnlyKeys(value['scope'], ['organizationId'], ['roomId', 'taskId'])
    && isNonEmptyString(value['scope']['organizationId']) && isOptionalNonEmptyString(value['scope']['roomId']) && isOptionalNonEmptyString(value['scope']['taskId'])
    && isOneOf(value['application'], ['organization', 'source-room', 'source-task', 'unresolved'])
    && isOneOf(value['temporal'], ['current', 'historical', 'unresolved'])
    && isOneOf(value['operation'], ['set', 'remove', 'clear'])
    && (value['operation'] === 'clear' ? value['value'] === '' : value['value'].length > 0)
    && Array.isArray(value['sourceEventIds']) && value['sourceEventIds'].every(isNonEmptyString)
    && isNonEmptyString(value['sourceQuote']) && isOneOf(value['assertionKind'], ['human-explicit', 'inferred'])
    && isNonNegativeInteger(value['validFromSequence'])
    && (value['validThroughSequence'] === undefined || isNonNegativeInteger(value['validThroughSequence']))
    && isOneOf(value['status'], ['candidate', 'current', 'default', 'conditional', 'historical', 'removed', 'unresolved'])
    && Array.isArray(value['supersedesFactIds']) && value['supersedesFactIds'].every(isNonEmptyString)
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

/** @param value Host error or Connection-decoded fields. @returns Validated classification, or a safe internal error. */
export function assertWorkspaceRpcError(value: unknown): WorkspaceRpcError {
  if (!isRecord(value) || !(hasExactKeys(value, ['kind', 'code', 'message', 'details']) || hasExactKeys(value, ['code', 'message', 'details']))
    || typeof value['message'] !== 'string' || !isRecord(value['details'])) return internalError()
  const kind = isOneOf(value['code'], ['bad-request', 'cancelled', 'internal']) ? value['code'] : 'business'
  if (Object.hasOwn(value, 'kind') && value['kind'] !== kind) return internalError()
  const error = { ...value, kind }
  if (!isWorkspaceRpcErrorDetails(error)) return internalError()
  return structuredClone(error) as WorkspaceRpcError
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
