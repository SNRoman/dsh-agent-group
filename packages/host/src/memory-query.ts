/** Pure, snapshot-stable projection of one agent's durable personal memory. */

import { WorkspaceBusinessError } from './errors.ts'
import type {
  AgentDefinitionId,
  AgentId,
  AgentMemoryEntryId,
  ChildRunId,
  DefinitionRevisionId,
  DelegationGrantId,
  EmploymentPeriodId,
  MembershipId,
  RoomId,
  TaskAssignmentId,
  TaskId,
  WorkspaceEventId,
} from './ids.ts'
import type {
  AgentMemoryEntry,
  ChildRunTerminalStatus,
  WorkspaceActor,
  WorkspaceEvent,
  WorkspaceEventType,
  WorkspaceState,
  WorkspaceSubjectId,
} from './types.ts'

/** Durable context that owns a projected memory event. */
export type MemorySource =
  | { readonly kind: 'room'; readonly id: RoomId; readonly label: string }
  | { readonly kind: 'task'; readonly id: TaskId; readonly label: string }
  | {
    readonly kind: 'child'
    readonly id: ChildRunId
    readonly label: string
    readonly taskId: TaskId
    readonly taskLabel: string
  }

/** Display-safe label for an event actor. */
export type MemoryActor = WorkspaceActor & { readonly label: string }

/** Display-safe label for an event subject. */
export interface MemorySubject {
  readonly id: WorkspaceSubjectId
  readonly label: string
}

/** Recorded role revision for model-visible output, or explicit missing attribution. */
export type MemoryDefinitionRevision =
  | { readonly status: 'active'; readonly id: DefinitionRevisionId; readonly number: number }
  | { readonly status: 'unresolved' }

/** One canonical workspace event projected for personal-memory inspection. */
export interface MemoryItem {
  readonly eventId: WorkspaceEventId
  readonly sequence: number
  readonly type: WorkspaceEventType
  readonly provenance: AgentMemoryEntry['acquiredBy']
  readonly source?: MemorySource | undefined
  readonly actor?: MemoryActor | undefined
  readonly subject?: MemorySubject | undefined
  readonly text?: string | undefined
  readonly childStatus?: ChildRunTerminalStatus | undefined
  readonly definitionRevision: MemoryDefinitionRevision
}

/** Stable filters and snapshot checkpoint for one agent's memory timeline. */
export interface MemoryQuery {
  readonly agentId: AgentId
  readonly sourceKind?: MemorySource['kind'] | undefined
  readonly sourceId?: MemorySource['id'] | undefined
  readonly provenance?: AgentMemoryEntry['acquiredBy'] | undefined
  readonly eventTypes?: readonly WorkspaceEventType[] | undefined
  readonly minimumSequence?: number | undefined
  readonly maximumSequence?: number | undefined
  readonly text?: string | undefined
  readonly limit: number
  readonly cursor?: string | undefined
  readonly snapshotRevision: number
}

/** One newest-first page from an immutable aggregate revision. */
export interface MemoryPage {
  readonly snapshotRevision: number
  readonly items: readonly MemoryItem[]
  readonly nextCursor?: string | undefined
}

interface MemoryCursor {
  readonly version: 1
  readonly agentId: AgentId
  readonly beforeSequence: number
  readonly snapshotRevision: number
}

interface ProjectedMemoryItem {
  readonly item: MemoryItem
  readonly searchableText: string
}

/**
 * Query one departed or employed agent's durable memory without mutating the snapshot.
 * @param state Immutable aggregate snapshot that owns every projected record.
 * @param query Filters, page limit, cursor, and required snapshot revision.
 * @returns A detached newest-first page tied to the requested snapshot revision.
 * @throws {Error} When the query or opaque cursor is invalid, or its revision is stale.
 */
export function queryAgentMemory(state: WorkspaceState, query: MemoryQuery): MemoryPage {
  requireQuery(state, query)
  const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor)
  if (cursor !== undefined) {
    if (cursor.agentId !== query.agentId) throw new Error('memory cursor belongs to another agent')
    if (cursor.snapshotRevision !== query.snapshotRevision) throw staleRevision(query.snapshotRevision, cursor.snapshotRevision)
  }

  const beforeSequence = cursor?.beforeSequence
  const eventById = new Map(state.events.map(event => [event.id, event] as const))
  const projected: ProjectedMemoryItem[] = []
  const seenEventIds = new Set<WorkspaceEventId>()
  for (const entry of state.memoryEntries) {
    if (entry.agentId !== query.agentId || seenEventIds.has(entry.eventId)) continue
    seenEventIds.add(entry.eventId)
    const event = eventById.get(entry.eventId)
    if (event === undefined) continue
    const item = projectMemoryItem(state, event, entry)
    const searchableText = memorySearchText(item)
    if (matchesQuery(item, searchableText, query, beforeSequence)) projected.push({ item, searchableText })
  }
  projected.sort((left, right) => right.item.sequence - left.item.sequence || left.item.eventId.localeCompare(right.item.eventId))

  const items = projected.slice(0, query.limit).map(candidate => candidate.item)
  const last = items.at(-1)
  return {
    snapshotRevision: query.snapshotRevision,
    items,
    ...(projected.length > items.length && last !== undefined
      ? { nextCursor: encodeCursor({ version: 1, agentId: query.agentId, beforeSequence: last.sequence, snapshotRevision: query.snapshotRevision }) }
      : {}),
  }
}

function requireQuery(state: WorkspaceState, query: MemoryQuery): void {
  if (state.agents[query.agentId] === undefined) {
    throw new WorkspaceBusinessError('agent-missing', { agentId: query.agentId }, `agent '${query.agentId}' does not exist`)
  }
  if (!Number.isSafeInteger(query.snapshotRevision) || query.snapshotRevision < 0) throw new Error('memory snapshot revision must be a non-negative safe integer')
  if (state.revision !== query.snapshotRevision) throw staleRevision(query.snapshotRevision, state.revision)
  if (!Number.isSafeInteger(query.limit) || query.limit < 1) throw new Error('memory page limit must be a positive safe integer')
  requireSequence('minimum', query.minimumSequence)
  requireSequence('maximum', query.maximumSequence)
  if (query.minimumSequence !== undefined && query.maximumSequence !== undefined && query.minimumSequence > query.maximumSequence) {
    throw new Error('memory minimum sequence must not exceed maximum sequence')
  }
}

function requireSequence(name: string, sequence: number | undefined): void {
  if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 0)) {
    throw new Error(`memory ${name} sequence must be a non-negative safe integer`)
  }
}

function staleRevision(expected: number, actual: number): WorkspaceBusinessError<'stale-revision'> {
  return new WorkspaceBusinessError(
    'stale-revision',
    { expectedRevision: expected, actualRevision: actual },
    `memory snapshot revision '${expected}' does not match '${actual}'`,
  )
}

function projectMemoryItem(state: WorkspaceState, event: WorkspaceEvent, entry: AgentMemoryEntry): MemoryItem {
  const source = resolveSource(state, event)
  const actor = event.actor === undefined ? undefined : resolveActor(state, event.actor)
  const subject = event.subjectId === undefined ? undefined : {
    id: event.subjectId,
    label: resolveSubjectLabel(state, event.subjectId),
  }
  const revision = event.definitionRevisionId === undefined ? undefined : state.definitionRevisions[event.definitionRevisionId]
  return {
    eventId: event.id,
    sequence: event.sequence,
    type: event.type,
    provenance: entry.acquiredBy,
    ...(source === undefined ? {} : { source }),
    ...(actor === undefined ? {} : { actor }),
    ...(subject === undefined ? {} : { subject }),
    ...(event.text === undefined ? {} : { text: event.text }),
    ...(event.type === 'child/run-finished' ? { childStatus: event.childRunStatus } : {}),
    definitionRevision: revision === undefined
      ? { status: 'unresolved' }
      : { status: 'active', id: revision.id, number: revision.number },
  }
}

function resolveSource(state: WorkspaceState, event: WorkspaceEvent): MemorySource | undefined {
  if (event.subjectId !== undefined) {
    const room = state.rooms[event.subjectId as RoomId]
    if (room !== undefined) return { kind: 'room', id: room.id, label: room.name ?? room.id }
    const child = state.childRuns[event.subjectId as ChildRunId]
    if (child !== undefined) {
      const task = state.tasks[child.taskId]
      return {
        kind: 'child',
        id: child.id,
        label: child.status === 'running' ? task?.title ?? child.id : child.result,
        taskId: child.taskId,
        taskLabel: task?.title ?? child.taskId,
      }
    }
    const task = state.tasks[event.subjectId as TaskId]
    if (task !== undefined) return { kind: 'task', id: task.id, label: task.title }
    const assignment = state.taskAssignments[event.subjectId as TaskAssignmentId]
    if (assignment !== undefined) return taskSource(state, assignment.taskId)
    const grant = state.delegationGrants[event.subjectId as DelegationGrantId]
    if (grant !== undefined) return taskSource(state, grant.rootTaskId)
    const membership = state.memberships[event.subjectId as MembershipId]
    if (membership !== undefined) {
      const membershipRoom = state.rooms[membership.roomId]
      return { kind: 'room', id: membership.roomId, label: membershipRoom?.name ?? membership.roomId }
    }
  }
  if ('taskId' in event) {
    return taskSource(state, event.taskId)
  }
  return undefined
}

function taskSource(state: WorkspaceState, taskId: TaskId): MemorySource {
  const task = state.tasks[taskId]
  return { kind: 'task', id: taskId, label: task?.title ?? taskId }
}

function resolveActor(state: WorkspaceState, actor: WorkspaceActor): MemoryActor {
  if (actor.type === 'human') return { ...actor, label: actor.id }
  return { ...actor, label: state.agents[actor.id]?.name ?? actor.id }
}

function resolveSubjectLabel(state: WorkspaceState, subjectId: WorkspaceSubjectId): string {
  const assignment = state.taskAssignments[subjectId as TaskAssignmentId]
  if (assignment !== undefined) return state.tasks[assignment.taskId]?.title ?? assignment.taskId
  const grant = state.delegationGrants[subjectId as DelegationGrantId]
  if (grant !== undefined) return state.tasks[grant.rootTaskId]?.title ?? grant.rootTaskId
  const revision = state.definitionRevisions[subjectId as DefinitionRevisionId]
  if (revision !== undefined) {
    const definitionName = state.definitions[revision.definitionId]?.name ?? revision.definitionId
    return `${definitionName} revision ${revision.number}`
  }
  const membership = state.memberships[subjectId as MembershipId]
  if (membership !== undefined) return state.rooms[membership.roomId]?.name ?? membership.roomId
  const employmentAgent = Object.values(state.agents).find(agent => (
    agent.employmentPeriods.some(period => period.id === subjectId as EmploymentPeriodId)
  ))
  if (employmentAgent !== undefined) return employmentAgent.name
  const memoryEntry = state.memoryEntries.find(entry => entry.id === subjectId as AgentMemoryEntryId)
  if (memoryEntry !== undefined) return state.agents[memoryEntry.agentId]?.name ?? memoryEntry.agentId
  return state.rooms[subjectId as RoomId]?.name
    ?? state.tasks[subjectId as TaskId]?.title
    ?? state.childRuns[subjectId as ChildRunId]?.result
    ?? state.agents[subjectId as AgentId]?.name
    ?? state.definitions[subjectId as AgentDefinitionId]?.name
    ?? subjectId
}

function memorySearchText(item: MemoryItem): string {
  const revision = item.definitionRevision.status === 'active'
    ? `${item.definitionRevision.id} ${item.definitionRevision.number}`
    : item.definitionRevision.status
  const childTask = item.source?.kind === 'child'
    ? `${item.source.taskId} ${item.source.taskLabel}`
    : undefined
  return [
    item.eventId,
    item.sequence,
    item.type,
    item.provenance,
    item.source?.kind,
    item.source?.id,
    item.source?.label,
    childTask,
    item.actor?.type,
    item.actor?.id,
    item.actor?.label,
    item.subject?.id,
    item.subject?.label,
    item.text,
    item.childStatus,
    revision,
  ].filter(value => value !== undefined).join(' ').toLocaleLowerCase('en-US')
}

function matchesQuery(
  item: MemoryItem,
  searchableText: string,
  query: MemoryQuery,
  beforeSequence: number | undefined,
): boolean {
  if (beforeSequence !== undefined && item.sequence >= beforeSequence) return false
  if (query.sourceKind !== undefined && item.source?.kind !== query.sourceKind) return false
  if (query.sourceId !== undefined && item.source?.id !== query.sourceId) return false
  if (query.provenance !== undefined && item.provenance !== query.provenance) return false
  if (query.eventTypes !== undefined && !query.eventTypes.includes(item.type)) return false
  if (query.minimumSequence !== undefined && item.sequence < query.minimumSequence) return false
  if (query.maximumSequence !== undefined && item.sequence > query.maximumSequence) return false
  const text = query.text?.toLocaleLowerCase('en-US')
  return text === undefined || searchableText.includes(text)
}

function encodeCursor(cursor: MemoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeCursor(encoded: string): MemoryCursor {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('memory cursor is malformed or non-canonical')
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    throw new Error('memory cursor is malformed')
  }
  const keys = isRecord(parsed) ? Object.keys(parsed).sort() : []
  if (!isRecord(parsed)
    || keys.length !== 4
    || keys[0] !== 'agentId'
    || keys[1] !== 'beforeSequence'
    || keys[2] !== 'snapshotRevision'
    || keys[3] !== 'version'
    || parsed.version !== 1
    || typeof parsed.agentId !== 'string'
    || parsed.agentId.length === 0
    || !Number.isSafeInteger(parsed.beforeSequence)
    || (parsed.beforeSequence as number) < 0
    || !Number.isSafeInteger(parsed.snapshotRevision)
    || (parsed.snapshotRevision as number) < 0) {
    throw new Error('memory cursor is malformed or unsupported')
  }
  const cursor: MemoryCursor = {
    version: 1,
    agentId: parsed.agentId as AgentId,
    beforeSequence: parsed.beforeSequence as number,
    snapshotRevision: parsed.snapshotRevision as number,
  }
  if (encodeCursor(cursor) !== encoded) throw new Error('memory cursor is malformed or non-canonical')
  return cursor
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
