/** Pure Workspace aggregate construction, mutations, and invariant checks. */

import {
  AgentDefinitionId,
  AgentId,
  AgentMemoryEntryId,
  DefinitionRevisionId,
  EmploymentPeriodId,
  MembershipId,
  RoomId,
  WorkspaceEventId,
} from './ids.ts'
import type {
  AgentDefinition,
  AgentMemoryAcquisition,
  AgentMemoryEntry,
  AgentInstance,
  CreateAgentCommand,
  CreateAgentResult,
  CreateDefinitionCommand,
  CreateDefinitionResult,
  CreateRoomCommand,
  CreateRoomResult,
  DefinitionRevision,
  MutationResult,
  RecordSessionBindingCommand,
  ReviseDefinitionCommand,
  ReviseDefinitionResult,
  RoomMessageCommand,
  RoomMessageResult,
  RoomMembership,
  SynchronizeDefinitionCommand,
  WorkspaceCommand,
  WorkspaceEvent,
  WorkspaceState,
  WorkspaceActor,
  WorkspaceSubjectId,
} from './types.ts'
import type { AgentDefinitionId as DefinitionId, AgentId as InstanceId, DefinitionRevisionId as RevisionId, MembershipId as RoomMembershipId, RoomId as WorkspaceRoomId, WorkspaceId } from './ids.ts'

/** Create an empty aggregate for one local workspace. */
export function createInitialState(workspaceId: WorkspaceId): WorkspaceState {
  return {
    workspaceId,
    revision: 0,
    nextId: 1,
    nextSequence: 1,
    definitions: {},
    definitionRevisions: {},
    agents: {},
    rooms: {},
    memberships: {},
    events: [],
    memoryEntries: [],
    tasks: {},
    taskAssignments: {},
    delegationGrants: {},
    childRuns: {},
    sessionBindings: {},
  }
}

/** Add durable memory associations while preserving the aggregate revision of the enclosing command. */
export function appendMemoryEntries(state: WorkspaceState, acquisitions: readonly AgentMemoryAcquisition[]): WorkspaceState {
  let changed = state
  const entries: AgentMemoryEntry[] = []
  for (const acquisition of acquisitions) {
    let memoryEntryId: ReturnType<typeof AgentMemoryEntryId>
    ;[changed, memoryEntryId] = mintWorkspaceId(changed, 'memory', AgentMemoryEntryId)
    entries.push({ id: memoryEntryId, ...acquisition })
  }
  return entries.length === 0 ? changed : { ...changed, memoryEntries: [...changed.memoryEntries, ...entries] }
}

/** Mutate the aggregate and expose the id minted by definition creation. */
export function mutateWorkspace(state: WorkspaceState, command: CreateDefinitionCommand): CreateDefinitionResult
/** Mutate the aggregate and expose the id minted by definition revision creation. */
export function mutateWorkspace(state: WorkspaceState, command: ReviseDefinitionCommand): ReviseDefinitionResult
/** Mutate the aggregate and expose the id minted by agent creation. */
export function mutateWorkspace(state: WorkspaceState, command: CreateAgentCommand): CreateAgentResult
/** Mutate the aggregate and expose the id minted by room creation. */
export function mutateWorkspace(state: WorkspaceState, command: CreateRoomCommand): CreateRoomResult
/** Mutate the aggregate and expose the event id minted by room message append. */
export function mutateWorkspace(state: WorkspaceState, command: RoomMessageCommand): RoomMessageResult
/** Mutate the aggregate for any command, returning only the common result. */
export function mutateWorkspace(state: WorkspaceState, command: WorkspaceCommand): MutationResult
/** Apply one invariant-preserving command without mutating its input aggregate. */
export function mutateWorkspace(state: WorkspaceState, command: WorkspaceCommand): MutationResult {
  switch (command.type) {
    case 'definition/create': return createDefinition(state, command)
    case 'definition/revise': return reviseDefinition(state, command)
    case 'definition/synchronize': return synchronizeDefinition(state, command)
    case 'agent/create': return createAgent(state, command)
    case 'agent/depart': return departAgent(state, command.agentId)
    case 'agent/employ': return employAgent(state, command.agentId)
    case 'room/create': return createRoom(state, command)
    case 'room/join': return joinRoom(state, command.roomId, command.agentId, command.memoryStart)
    case 'room/leave': return leaveRoom(state, command.membershipId)
    case 'room/message': return appendRoomMessageEvent(state, command)
    case 'runtime/session-bound': return recordSessionBinding(state, command)
  }
}

/**
 * Start one immutable aggregate mutation and advance its revision exactly once.
 * @param state Immutable workspace state.
 * @returns The next aggregate revision.
 */
export function beginWorkspaceMutation(state: WorkspaceState): WorkspaceState {
  return { ...state, revision: state.revision + 1 }
}

/**
 * Mint one branded aggregate identifier without changing event sequence.
 * @param state Immutable workspace state.
 * @param prefix Durable identifier prefix.
 * @param brand Branded identifier constructor.
 * @returns State with the next identifier consumed and the minted identifier.
 */
export function mintWorkspaceId<T extends string>(state: WorkspaceState, prefix: string, brand: (value: string) => T): readonly [WorkspaceState, T] {
  const value = brand(`${prefix}-${state.nextId}`)
  return [{ ...state, nextId: state.nextId + 1 }, value]
}

/**
 * Append one sequence-ordered canonical workspace event.
 * @param state Immutable workspace state.
 * @param type Event discriminator.
 * @param subjectId Optional aggregate record identified by the event.
 * @param details Additional canonical event fields.
 * @returns State with the next sequence consumed and the appended event.
 */
export function appendWorkspaceEvent(
  state: WorkspaceState,
  type: string,
  subjectId?: WorkspaceSubjectId,
  details?: Pick<WorkspaceEvent, 'actor' | 'childRunStatus' | 'definitionRevisionId' | 'text' | 'mentions'>,
): readonly [WorkspaceState, WorkspaceEvent] {
  const base = {
    id: WorkspaceEventId(`event-${state.nextSequence}`),
    sequence: state.nextSequence,
    ...(subjectId === undefined ? {} : { subjectId }),
  }
  const { childRunStatus, ...eventDetails } = details ?? {}
  if (type === 'child/run-finished') {
    if (childRunStatus === undefined) throw new Error('child/run-finished event requires a terminal status')
    const event: WorkspaceEvent = { ...base, type: 'child/run-finished', childRunStatus, ...eventDetails }
    return [{ ...state, nextSequence: state.nextSequence + 1, events: [...state.events, event] }, event]
  }
  if (childRunStatus !== undefined) throw new Error(`workspace event '${type}' cannot carry a child-run status`)
  const event: WorkspaceEvent = { ...base, type, ...eventDetails }
  return [{ ...state, nextSequence: state.nextSequence + 1, events: [...state.events, event] }, event]
}

function createDefinition(state: WorkspaceState, command: CreateDefinitionCommand): CreateDefinitionResult {
  requireText('definition name', command.name)
  let changed = beginWorkspaceMutation(state)
  let definitionId: DefinitionId
  ;[changed, definitionId] = mintWorkspaceId(changed, 'definition', AgentDefinitionId)
  let definitionRevisionId: RevisionId
  ;[changed, definitionRevisionId] = mintWorkspaceId(changed, 'definition-revision', DefinitionRevisionId)
  ;[changed] = appendWorkspaceEvent(changed, 'definition/created', definitionId)
  const definition: AgentDefinition = { id: definitionId, name: command.name, revisionIds: [definitionRevisionId], currentRevisionId: definitionRevisionId }
  const revision: DefinitionRevision = { id: definitionRevisionId, definitionId, number: 1, description: command.description, instructions: command.instructions }
  return {
    state: {
      ...changed,
      definitions: { ...changed.definitions, [definitionId]: definition },
      definitionRevisions: { ...changed.definitionRevisions, [definitionRevisionId]: revision },
    },
    definitionId,
    definitionRevisionId,
  }
}

function reviseDefinition(state: WorkspaceState, command: ReviseDefinitionCommand): ReviseDefinitionResult {
  const definition = requireDefinition(state, command.definitionId)
  let changed = beginWorkspaceMutation(state)
  let definitionRevisionId: RevisionId
  ;[changed, definitionRevisionId] = mintWorkspaceId(changed, 'definition-revision', DefinitionRevisionId)
  ;[changed] = appendWorkspaceEvent(changed, 'definition/revised', command.definitionId)
  const revision: DefinitionRevision = {
    id: definitionRevisionId,
    definitionId: command.definitionId,
    number: definition.revisionIds.length + 1,
    description: command.description,
    instructions: command.instructions,
  }
  changed = {
    ...changed,
    definitions: {
      ...changed.definitions,
      [definition.id]: { ...definition, revisionIds: [...definition.revisionIds, definitionRevisionId], currentRevisionId: definitionRevisionId },
    },
    definitionRevisions: { ...changed.definitionRevisions, [definitionRevisionId]: revision },
  }
  changed = assignRevision(changed, command.definitionId, definitionRevisionId, command.synchronizeAgentIds ?? [])
  return { state: changed, definitionRevisionId }
}

function synchronizeDefinition(state: WorkspaceState, command: SynchronizeDefinitionCommand): MutationResult {
  requireDefinition(state, command.definitionId)
  requireRevision(state, command.definitionId, command.definitionRevisionId)
  if (command.agentIds.length === 0) {
    throw new Error(`definition synchronization for '${command.definitionId}' needs at least one agent`)
  }
  return { state: assignRevision(beginWorkspaceMutation(state), command.definitionId, command.definitionRevisionId, command.agentIds) }
}

function assignRevision(state: WorkspaceState, definitionId: DefinitionId, revisionId: RevisionId, agentIds: readonly InstanceId[]): WorkspaceState {
  let changed = state
  for (const agentId of agentIds) {
    const agent = requireAgent(changed, agentId)
    if (agent.definitionId !== definitionId) {
      throw new Error(`agent '${agentId}' does not use definition '${definitionId}'`)
    }
    ;[changed] = appendWorkspaceEvent(changed, 'agent/definition-revision-assigned', agentId, { definitionRevisionId: revisionId })
    changed = { ...changed, agents: { ...changed.agents, [agentId]: { ...agent, definitionRevisionId: revisionId } } }
  }
  return changed
}

function createAgent(state: WorkspaceState, command: CreateAgentCommand): CreateAgentResult {
  const definition = requireDefinition(state, command.definitionId)
  requireText('agent name', command.name)
  const collision = Object.values(state.agents).find(agent => normalizeName(agent.name) === normalizeName(command.name))
  if (collision !== undefined) {
    throw new Error(`agent name '${command.name}' is already used in workspace '${state.workspaceId}'`)
  }
  let changed = beginWorkspaceMutation(state)
  let agentId: InstanceId
  ;[changed, agentId] = mintWorkspaceId(changed, 'agent', AgentId)
  let employmentPeriodId: ReturnType<typeof EmploymentPeriodId>
  ;[changed, employmentPeriodId] = mintWorkspaceId(changed, 'employment', EmploymentPeriodId)
  let event: WorkspaceEvent
  ;[changed, event] = appendWorkspaceEvent(changed, 'agent/created', agentId)
  const agent: AgentInstance = {
    id: agentId,
    name: command.name,
    definitionId: definition.id,
    definitionRevisionId: definition.currentRevisionId,
    employmentStatus: 'employed',
    employmentPeriods: [{ id: employmentPeriodId, startedEventId: event.id }],
  }
  return { state: { ...changed, agents: { ...changed.agents, [agentId]: agent } }, agentId }
}

function departAgent(state: WorkspaceState, agentId: InstanceId): MutationResult {
  const agent = requireAgent(state, agentId)
  requireEmployment(agent, 'employed')
  let changed = beginWorkspaceMutation(state)
  let event: WorkspaceEvent
  ;[changed, event] = appendWorkspaceEvent(changed, 'agent/departed', agentId)
  const employmentPeriods = agent.employmentPeriods.map(period => period.endedEventId === undefined ? { ...period, endedEventId: event.id } : period)
  const memberships = Object.fromEntries(Object.entries(changed.memberships).map(([id, membership]) => [
    id,
    membership.agentId === agentId && membership.leftEventId === undefined ? { ...membership, leftEventId: event.id } : membership,
  ])) as WorkspaceState['memberships']
  return {
    state: {
      ...changed,
      agents: { ...changed.agents, [agentId]: { ...agent, employmentStatus: 'departed', employmentPeriods } },
      memberships,
    },
  }
}

function employAgent(state: WorkspaceState, agentId: InstanceId): MutationResult {
  const agent = requireAgent(state, agentId)
  requireEmployment(agent, 'departed')
  let changed = beginWorkspaceMutation(state)
  let employmentPeriodId: ReturnType<typeof EmploymentPeriodId>
  ;[changed, employmentPeriodId] = mintWorkspaceId(changed, 'employment', EmploymentPeriodId)
  let event: WorkspaceEvent
  ;[changed, event] = appendWorkspaceEvent(changed, 'agent/employed', agentId)
  return {
    state: {
      ...changed,
      agents: {
        ...changed.agents,
        [agentId]: { ...agent, employmentStatus: 'employed', employmentPeriods: [...agent.employmentPeriods, { id: employmentPeriodId, startedEventId: event.id }] },
      },
    },
  }
}

function createRoom(state: WorkspaceState, command: CreateRoomCommand): CreateRoomResult {
  if (command.kind === 'group') requireText('room name', command.name ?? '')
  let changed = beginWorkspaceMutation(state)
  let roomId: WorkspaceRoomId
  ;[changed, roomId] = mintWorkspaceId(changed, 'room', RoomId)
  ;[changed] = appendWorkspaceEvent(changed, 'room/created', roomId)
  return { state: { ...changed, rooms: { ...changed.rooms, [roomId]: { id: roomId, kind: command.kind, ...(command.name === undefined ? {} : { name: command.name }) } } }, roomId }
}

function joinRoom(state: WorkspaceState, roomId: WorkspaceRoomId, agentId: InstanceId, memoryStart: RoomMembership['memoryStart']): MutationResult {
  requireRoom(state, roomId)
  const agent = requireAgent(state, agentId)
  if (agent.employmentStatus === 'departed') {
    throw new Error(`agent '${agentId}' is departed and cannot join room '${roomId}'`)
  }
  if (Object.values(state.memberships).some(membership => membership.roomId === roomId && membership.agentId === agentId && membership.leftEventId === undefined)) {
    throw new Error(`agent '${agentId}' already has an active membership in room '${roomId}'`)
  }
  if (memoryStart.type === 'event-range' && memoryStart.startSequence > memoryStart.endSequence) {
    throw new Error(`room '${roomId}' membership history range is invalid`)
  }
  let changed = beginWorkspaceMutation(state)
  let membershipId: RoomMembershipId
  ;[changed, membershipId] = mintWorkspaceId(changed, 'membership', MembershipId)
  let event: WorkspaceEvent
  ;[changed, event] = appendWorkspaceEvent(changed, 'room/member-joined', membershipId)
  const membership: RoomMembership = { id: membershipId, roomId, agentId, memoryStart, joinedEventId: event.id }
  return { state: { ...changed, memberships: { ...changed.memberships, [membershipId]: membership } } }
}

function leaveRoom(state: WorkspaceState, membershipId: RoomMembershipId): MutationResult {
  const membership = state.memberships[membershipId]
  if (membership === undefined) throw new Error(`room membership '${membershipId}' does not exist`)
  if (membership.leftEventId !== undefined) throw new Error(`room membership '${membershipId}' has already ended`)
  let changed = beginWorkspaceMutation(state)
  let event: WorkspaceEvent
  ;[changed, event] = appendWorkspaceEvent(changed, 'room/member-left', membershipId)
  return { state: { ...changed, memberships: { ...changed.memberships, [membershipId]: { ...membership, leftEventId: event.id } } } }
}

function appendRoomMessageEvent(state: WorkspaceState, command: RoomMessageCommand): RoomMessageResult {
  requireRoom(state, command.roomId)
  requireActor(state, command.actor)
  requireText('room message', command.text)
  for (const agentId of command.mentions) {
    const agent = requireAgent(state, agentId)
    if (agent.employmentStatus === 'departed') throw new Error(`mentioned agent '${agentId}' is departed`)
  }
  let changed = beginWorkspaceMutation(state)
  let event: WorkspaceEvent
  ;[changed, event] = appendWorkspaceEvent(changed, 'room/message', command.roomId, {
    actor: command.actor,
    text: command.text,
    mentions: command.mentions,
  })
  changed = appendMemoryEntries(changed, activeRoomMemberIds(changed, command.roomId).map(agentId => ({
    agentId,
    eventId: event.id,
    acquiredBy: 'room-membership',
  })))
  return { state: changed, eventId: event.id }
}

function activeRoomMemberIds(state: WorkspaceState, roomId: WorkspaceRoomId): readonly InstanceId[] {
  return Object.values(state.memberships)
    .filter(membership => membership.roomId === roomId && membership.leftEventId === undefined)
    .map(membership => membership.agentId)
}

function requireDefinition(state: WorkspaceState, definitionId: DefinitionId): AgentDefinition {
  const definition = state.definitions[definitionId]
  if (definition === undefined) throw new Error(`definition '${definitionId}' does not exist`)
  return definition
}

function requireRevision(state: WorkspaceState, definitionId: DefinitionId, revisionId: RevisionId): DefinitionRevision {
  const revision = state.definitionRevisions[revisionId]
  if (revision === undefined || revision.definitionId !== definitionId) {
    throw new Error(`definition revision '${revisionId}' does not exist for definition '${definitionId}'`)
  }
  return revision
}

function requireAgent(state: WorkspaceState, agentId: InstanceId): AgentInstance {
  const agent = state.agents[agentId]
  if (agent === undefined) throw new Error(`agent '${agentId}' does not exist`)
  return agent
}

function requireRoom(state: WorkspaceState, roomId: WorkspaceRoomId): void {
  if (state.rooms[roomId] === undefined) throw new Error(`room '${roomId}' does not exist`)
}

function requireActor(state: WorkspaceState, actor: WorkspaceActor): void {
  if (actor.type === 'agent') {
    const agent = requireAgent(state, actor.id)
    if (agent.employmentStatus === 'departed') throw new Error(`agent '${actor.id}' is departed and cannot create room events`)
  }
}

function requireEmployment(agent: AgentInstance, expected: AgentInstance['employmentStatus']): void {
  if (agent.employmentStatus !== expected) throw new Error(`agent '${agent.id}' is already ${agent.employmentStatus}`)
}

function requireText(subject: string, value: string): void {
  if (value.trim() === '') throw new Error(`${subject} must not be empty`)
}

function recordSessionBinding(state: WorkspaceState, command: RecordSessionBindingCommand): MutationResult {
  const agent = requireAgent(state, command.agentId)
  requireEmployment(agent, 'employed')
  let changed = beginWorkspaceMutation(state)
  ;[changed] = appendWorkspaceEvent(changed, 'runtime/session-bound', command.agentId)
  return {
    state: {
      ...changed,
      sessionBindings: { ...changed.sessionBindings, [command.agentId]: command.sessionId },
    },
  }
}

function normalizeName(value: string): string {
  return value.toLocaleLowerCase('en-US')
}
