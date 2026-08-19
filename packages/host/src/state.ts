/** Pure Workspace aggregate construction, mutations, and invariant checks. */

import {
  AgentDefinitionId,
  AgentId,
  DefinitionRevisionId,
  EmploymentPeriodId,
  MembershipId,
  RoomId,
  WorkspaceEventId,
} from './ids.ts'
import type {
  AgentDefinition,
  AgentInstance,
  CreateAgentCommand,
  CreateAgentResult,
  CreateDefinitionCommand,
  CreateDefinitionResult,
  CreateRoomCommand,
  CreateRoomResult,
  DefinitionRevision,
  MutationResult,
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
  }
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
/** Mutate the aggregate for all commands that mint no externally needed id. */
export function mutateWorkspace(state: WorkspaceState, command: Exclude<WorkspaceCommand, CreateDefinitionCommand | ReviseDefinitionCommand | CreateAgentCommand | CreateRoomCommand | RoomMessageCommand>): MutationResult
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
  }
}

function beginMutation(state: WorkspaceState): WorkspaceState {
  return { ...state, revision: state.revision + 1 }
}

function mintId<T extends string>(state: WorkspaceState, prefix: string, brand: (value: string) => T): readonly [WorkspaceState, T] {
  const value = brand(`${prefix}-${state.nextId}`)
  return [{ ...state, nextId: state.nextId + 1 }, value]
}

function appendEvent(
  state: WorkspaceState,
  type: string,
  subjectId?: WorkspaceSubjectId,
  details?: Pick<WorkspaceEvent, 'actor' | 'text' | 'mentions'>,
): readonly [WorkspaceState, WorkspaceEvent] {
  const event: WorkspaceEvent = {
    id: WorkspaceEventId(`event-${state.nextSequence}`),
    sequence: state.nextSequence,
    type,
    ...(subjectId === undefined ? {} : { subjectId }),
    ...(details ?? {}),
  }
  return [{ ...state, nextSequence: state.nextSequence + 1, events: [...state.events, event] }, event]
}

function createDefinition(state: WorkspaceState, command: CreateDefinitionCommand): CreateDefinitionResult {
  requireText('definition name', command.name)
  let changed = beginMutation(state)
  let definitionId: DefinitionId
  ;[changed, definitionId] = mintId(changed, 'definition', AgentDefinitionId)
  let definitionRevisionId: RevisionId
  ;[changed, definitionRevisionId] = mintId(changed, 'definition-revision', DefinitionRevisionId)
  ;[changed] = appendEvent(changed, 'definition/created', definitionId)
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
  let changed = beginMutation(state)
  let definitionRevisionId: RevisionId
  ;[changed, definitionRevisionId] = mintId(changed, 'definition-revision', DefinitionRevisionId)
  ;[changed] = appendEvent(changed, 'definition/revised', command.definitionId)
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
  return { state: assignRevision(beginMutation(state), command.definitionId, command.definitionRevisionId, command.agentIds) }
}

function assignRevision(state: WorkspaceState, definitionId: DefinitionId, revisionId: RevisionId, agentIds: readonly InstanceId[]): WorkspaceState {
  let changed = state
  for (const agentId of agentIds) {
    const agent = requireAgent(changed, agentId)
    if (agent.definitionId !== definitionId) {
      throw new Error(`agent '${agentId}' does not use definition '${definitionId}'`)
    }
    ;[changed] = appendEvent(changed, 'agent/definition-revision-assigned', agentId)
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
  let changed = beginMutation(state)
  let agentId: InstanceId
  ;[changed, agentId] = mintId(changed, 'agent', AgentId)
  let employmentPeriodId: ReturnType<typeof EmploymentPeriodId>
  ;[changed, employmentPeriodId] = mintId(changed, 'employment', EmploymentPeriodId)
  let event: WorkspaceEvent
  ;[changed, event] = appendEvent(changed, 'agent/created', agentId)
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
  let changed = beginMutation(state)
  let event: WorkspaceEvent
  ;[changed, event] = appendEvent(changed, 'agent/departed', agentId)
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
  let changed = beginMutation(state)
  let employmentPeriodId: ReturnType<typeof EmploymentPeriodId>
  ;[changed, employmentPeriodId] = mintId(changed, 'employment', EmploymentPeriodId)
  let event: WorkspaceEvent
  ;[changed, event] = appendEvent(changed, 'agent/employed', agentId)
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
  let changed = beginMutation(state)
  let roomId: WorkspaceRoomId
  ;[changed, roomId] = mintId(changed, 'room', RoomId)
  ;[changed] = appendEvent(changed, 'room/created', roomId)
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
  let changed = beginMutation(state)
  let membershipId: RoomMembershipId
  ;[changed, membershipId] = mintId(changed, 'membership', MembershipId)
  let event: WorkspaceEvent
  ;[changed, event] = appendEvent(changed, 'room/member-joined', membershipId)
  const membership: RoomMembership = { id: membershipId, roomId, agentId, memoryStart, joinedEventId: event.id }
  return { state: { ...changed, memberships: { ...changed.memberships, [membershipId]: membership } } }
}

function leaveRoom(state: WorkspaceState, membershipId: RoomMembershipId): MutationResult {
  const membership = state.memberships[membershipId]
  if (membership === undefined) throw new Error(`room membership '${membershipId}' does not exist`)
  if (membership.leftEventId !== undefined) throw new Error(`room membership '${membershipId}' has already ended`)
  let changed = beginMutation(state)
  let event: WorkspaceEvent
  ;[changed, event] = appendEvent(changed, 'room/member-left', membershipId)
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
  let changed = beginMutation(state)
  let event: WorkspaceEvent
  ;[changed, event] = appendEvent(changed, 'room/message', command.roomId, {
    actor: command.actor,
    text: command.text,
    mentions: command.mentions,
  })
  return { state: changed, eventId: event.id }
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

function normalizeName(value: string): string {
  return value.toLocaleLowerCase('en-US')
}
