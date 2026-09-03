/** Pure validation of relationships owned by one durable workspace aggregate. */

import type { WorkspaceEvent, WorkspaceState } from './types.ts'
import type { WorkspaceId } from './ids.ts'

/**
 * Assert all relationships and counters owned by one durable workspace record.
 * @param state Candidate workspace aggregate.
 * @param expectedWorkspaceId Table key under which the aggregate is stored.
 * @returns Nothing; throws on the first violation.
 */
export function assertWorkspaceInvariants(state: WorkspaceState, expectedWorkspaceId: WorkspaceId): void {
  if (state.workspaceId !== expectedWorkspaceId) {
    throw new Error(`workspace id '${state.workspaceId}' does not match table key '${expectedWorkspaceId}'`)
  }

  assertRecordKeys('definition', state.definitions)
  assertRecordKeys('definition revision', state.definitionRevisions)
  assertRecordKeys('agent', state.agents)
  assertRecordKeys('room', state.rooms)
  assertRecordKeys('membership', state.memberships)
  assertRecordKeys('task', state.tasks)
  assertRecordKeys('task assignment', state.taskAssignments)
  assertRecordKeys('delegation grant', state.delegationGrants)
  assertRecordKeys('child run', state.childRuns)

  const events = new Map<string, WorkspaceEvent>()
  for (const event of state.events) {
    if (events.has(event.id)) throw new Error(`duplicate event id '${event.id}'`)
    events.set(event.id, event)
  }

  for (const definition of Object.values(state.definitions)) {
    if (definition.revisionIds.length === 0) throw new Error(`definition '${definition.id}' has no revisions`)
    if (new Set(definition.revisionIds).size !== definition.revisionIds.length) {
      throw new Error(`definition '${definition.id}' lists a duplicate revision`)
    }
    for (const [index, revisionId] of definition.revisionIds.entries()) {
      const revision = state.definitionRevisions[revisionId]
      if (revision === undefined) throw new Error(`definition '${definition.id}' references missing revision '${revisionId}'`)
      if (revision.definitionId !== definition.id) {
        throw new Error(`definition revision '${revision.id}' belongs to definition '${revision.definitionId}', not '${definition.id}'`)
      }
      if (revision.number !== index + 1) {
        throw new Error(`definition revision '${revision.id}' has revision number ${revision.number}, expected ${index + 1}`)
      }
    }
    if (!definition.revisionIds.includes(definition.currentRevisionId)) {
      throw new Error(`definition '${definition.id}' current revision '${definition.currentRevisionId}' is not in its revision list`)
    }
  }
  for (const revision of Object.values(state.definitionRevisions)) {
    const definition = state.definitions[revision.definitionId]
    if (definition === undefined) {
      throw new Error(`definition revision '${revision.id}' references missing definition '${revision.definitionId}'`)
    }
    if (!definition.revisionIds.includes(revision.id)) {
      throw new Error(`definition revision '${revision.id}' is not owned by definition '${definition.id}'`)
    }
  }

  const employmentPeriodIds = new Set<string>()
  for (const agent of Object.values(state.agents)) {
    const definition = state.definitions[agent.definitionId]
    if (definition === undefined) throw new Error(`agent '${agent.id}' references missing definition '${agent.definitionId}'`)
    const revision = state.definitionRevisions[agent.definitionRevisionId]
    if (revision === undefined) throw new Error(`agent '${agent.id}' references missing definition revision '${agent.definitionRevisionId}'`)
    if (revision.definitionId !== definition.id) {
      throw new Error(`agent '${agent.id}' definition revision '${revision.id}' belongs to another definition`)
    }
    if (agent.employmentPeriods.length === 0) throw new Error(`agent '${agent.id}' has no employment periods`)
    for (const [index, period] of agent.employmentPeriods.entries()) {
      if (employmentPeriodIds.has(period.id)) throw new Error(`duplicate employment period id '${period.id}'`)
      employmentPeriodIds.add(period.id)
      const started = events.get(period.startedEventId)
      const expectedStartType = index === 0 ? 'agent/created' : 'agent/employed'
      if (started?.type !== expectedStartType || started.subjectId !== agent.id) {
        throw new Error(`agent '${agent.id}' employment period '${period.id}' has invalid start event '${period.startedEventId}'`)
      }
      if (period.endedEventId !== undefined) {
        const ended = events.get(period.endedEventId)
        if (ended?.type !== 'agent/departed' || ended.subjectId !== agent.id || ended.sequence <= started.sequence) {
          throw new Error(`agent '${agent.id}' employment period '${period.id}' has invalid end event '${period.endedEventId}'`)
        }
      }
      const isLast = index === agent.employmentPeriods.length - 1
      if (!isLast && period.endedEventId === undefined) {
        throw new Error(`agent '${agent.id}' has an open employment period before its latest period`)
      }
    }
    const latest = agent.employmentPeriods.at(-1)!
    const expectedStatus = latest.endedEventId === undefined ? 'employed' : 'departed'
    if (agent.employmentStatus !== expectedStatus) {
      throw new Error(`agent '${agent.id}' employment status '${agent.employmentStatus}' disagrees with its latest employment period`)
    }
  }

  const activeMemberships = new Set<string>()
  for (const membership of Object.values(state.memberships)) {
    const room = state.rooms[membership.roomId]
    if (room === undefined) throw new Error(`membership '${membership.id}' references missing room '${membership.roomId}'`)
    const agent = state.agents[membership.agentId]
    if (agent === undefined) throw new Error(`membership '${membership.id}' references missing agent '${membership.agentId}'`)
    const joined = events.get(membership.joinedEventId)
    if (joined?.type !== 'room/member-joined' || joined.subjectId !== membership.id) {
      throw new Error(`membership '${membership.id}' has invalid join event '${membership.joinedEventId}'`)
    }
    if (membership.leftEventId !== undefined) {
      const left = events.get(membership.leftEventId)
      if (left?.type !== 'room/member-left' || left.subjectId !== membership.id || left.sequence <= joined.sequence) {
        throw new Error(`membership '${membership.id}' has invalid leave event '${membership.leftEventId}'`)
      }
    } else {
      if (agent.employmentStatus !== 'employed') {
        throw new Error(`active membership '${membership.id}' belongs to departed agent '${agent.id}'`)
      }
      const pair = `${membership.roomId}\u0000${membership.agentId}`
      if (activeMemberships.has(pair)) {
        throw new Error(`room '${membership.roomId}' has duplicate active membership for agent '${membership.agentId}'`)
      }
      activeMemberships.add(pair)
    }
    if (membership.memoryStart.type === 'event-range') {
      if (membership.memoryStart.startSequence > membership.memoryStart.endSequence) {
        throw new Error(`membership '${membership.id}' has an invalid memory event range`)
      }
      if (membership.memoryStart.endSequence >= joined.sequence) {
        throw new Error(`membership '${membership.id}' memory event range reaches its join event`)
      }
    }
    if (room.kind === 'direct') {
      const active = Object.values(state.memberships)
        .filter(candidate => candidate.roomId === room.id && candidate.leftEventId === undefined)
      if (active.length > 1) throw new Error(`direct room '${room.id}' cannot have more than one active member`)
    }
  }

  for (const task of Object.values(state.tasks)) {
    const root = state.tasks[task.rootTaskId]
    if (root === undefined) throw new Error(`task '${task.id}' references missing root task '${task.rootTaskId}'`)
    if (root.id !== root.rootTaskId) throw new Error(`task '${task.id}' root '${root.id}' is not a root task`)
  }
  const assignmentsByTask = new Map<string, number>()
  for (const assignment of Object.values(state.taskAssignments)) {
    const task = state.tasks[assignment.taskId]
    if (task === undefined) throw new Error(`task assignment '${assignment.id}' references missing task '${assignment.taskId}'`)
    if (assignment.rootTaskId !== task.rootTaskId) {
      throw new Error(`task assignment '${assignment.id}' root task '${assignment.rootTaskId}' does not match task '${task.id}'`)
    }
    if (state.agents[assignment.assigneeAgentId] === undefined) {
      throw new Error(`task assignment '${assignment.id}' references missing assignee '${assignment.assigneeAgentId}'`)
    }
    if (assignment.grantId !== undefined) {
      const grant = state.delegationGrants[assignment.grantId]
      if (grant === undefined) throw new Error(`task assignment '${assignment.id}' references missing delegation grant '${assignment.grantId}'`)
      if (grant.rootTaskId !== assignment.rootTaskId) {
        throw new Error(`task assignment '${assignment.id}' and grant '${grant.id}' reference different root tasks`)
      }
    }
    assignmentsByTask.set(task.id, (assignmentsByTask.get(task.id) ?? 0) + 1)
  }
  for (const task of Object.values(state.tasks)) {
    if (assignmentsByTask.get(task.id) !== 1) throw new Error(`task '${task.id}' must have exactly one assignment`)
  }
  for (const grant of Object.values(state.delegationGrants)) {
    const task = state.tasks[grant.rootTaskId]
    if (task === undefined || task.id !== task.rootTaskId) {
      throw new Error(`delegation grant '${grant.id}' references missing root task '${grant.rootTaskId}'`)
    }
    if (state.agents[grant.granteeAgentId] === undefined) {
      throw new Error(`delegation grant '${grant.id}' references missing grantee '${grant.granteeAgentId}'`)
    }
    if (grant.status === 'active' && task.status !== 'open') {
      throw new Error(`active grant '${grant.id}' references non-open root task '${grant.rootTaskId}'`)
    }
  }

  for (const childRun of Object.values(state.childRuns)) {
    if (state.agents[childRun.parentAgentId] === undefined) {
      throw new Error(`child run '${childRun.id}' references missing parent '${childRun.parentAgentId}'`)
    }
    if (state.tasks[childRun.taskId] === undefined) {
      throw new Error(`child run '${childRun.id}' references missing task '${childRun.taskId}'`)
    }
    const starts = state.events.filter(event => event.type === 'child/run-started' && event.subjectId === childRun.id)
    if (starts.length !== 1) throw new Error(`child run '${childRun.id}' must have exactly one start event`)
    const finishes = state.events.filter(event => event.type === 'child/run-finished' && event.subjectId === childRun.id)
    if (childRun.status === 'running') {
      if (finishes.length !== 0) throw new Error(`running child run '${childRun.id}' has a finish event`)
    } else {
      if (finishes.length !== 1) throw new Error(`terminal child run '${childRun.id}' must have exactly one finish event`)
      if (finishes[0]!.childRunStatus !== childRun.status) {
        throw new Error(`child run '${childRun.id}' terminal status disagrees with its finish event`)
      }
    }
  }

  const memoryIds = new Set<string>()
  const memoryAssociations = new Set<string>()
  for (const entry of state.memoryEntries) {
    if (memoryIds.has(entry.id)) throw new Error(`duplicate memory entry id '${entry.id}'`)
    memoryIds.add(entry.id)
    if (!events.has(entry.eventId)) throw new Error(`memory entry '${entry.id}' references missing event '${entry.eventId}'`)
    if (state.agents[entry.agentId] === undefined) throw new Error(`memory entry '${entry.id}' references missing agent '${entry.agentId}'`)
    const association = `${entry.agentId}\u0000${entry.eventId}`
    if (memoryAssociations.has(association)) {
      throw new Error(`duplicate memory association for agent '${entry.agentId}' and event '${entry.eventId}'`)
    }
    memoryAssociations.add(association)
  }

  const sessionIds = new Set<string>()
  for (const [agentId, sessionId] of Object.entries(state.sessionBindings)) {
    if (state.agents[agentId as keyof typeof state.agents] === undefined) {
      throw new Error(`session binding references missing agent '${agentId}'`)
    }
    if (sessionIds.has(sessionId)) throw new Error(`session '${sessionId}' is bound to more than one agent`)
    sessionIds.add(sessionId)
  }

  for (const event of state.events) assertEventRelationships(state, event)
  let lastSequence = 0
  const sequences = new Set<number>()
  for (const event of state.events) {
    if (sequences.has(event.sequence)) throw new Error(`duplicate event sequence '${event.sequence}'`)
    if (event.sequence <= lastSequence) throw new Error(`event sequence '${event.sequence}' is not ordered after '${lastSequence}'`)
    sequences.add(event.sequence)
    lastSequence = event.sequence
  }
  if (state.nextSequence <= lastSequence) {
    throw new Error(`nextSequence ${state.nextSequence} is not above the last event sequence ${lastSequence}`)
  }
  const greatestId = greatestDurableId(state)
  if (state.nextId <= greatestId) throw new Error(`nextId ${state.nextId} is not above the greatest durable id ${greatestId}`)
}

function assertRecordKeys<T extends { readonly id: string }>(label: string, records: Readonly<Record<string, T>>): void {
  for (const [key, value] of Object.entries(records)) {
    if (key !== value.id) throw new Error(`${label} map key '${key}' does not match record id '${value.id}'`)
  }
}

function assertEventRelationships(state: WorkspaceState, event: WorkspaceEvent): void {
  if (event.actor?.type === 'agent' && state.agents[event.actor.id] === undefined) {
    throw new Error(`event '${event.id}' actor references missing agent '${event.actor.id}'`)
  }
  for (const agentId of event.mentions ?? []) {
    if (state.agents[agentId] === undefined) throw new Error(`event '${event.id}' mentions missing agent '${agentId}'`)
  }
  switch (event.type) {
    case 'definition/created':
    case 'definition/revised':
      requireEventSubject(event, state.definitions, 'definition')
      return
    case 'agent/definition-revision-assigned': {
      const agent = requireEventSubject(event, state.agents, 'agent')
      const revisionId = event.definitionRevisionId
      if (revisionId === undefined || state.definitionRevisions[revisionId]?.definitionId !== agent.definitionId) {
        throw new Error(`event '${event.id}' references an invalid assigned definition revision`)
      }
      return
    }
    case 'agent/created':
    case 'agent/departed':
    case 'agent/employed':
    case 'runtime/session-bound':
      requireEventSubject(event, state.agents, 'agent')
      return
    case 'room/created':
    case 'room/message':
    case 'conversation/stopped':
      requireEventSubject(event, state.rooms, 'room')
      return
    case 'room/member-joined':
    case 'room/member-left':
      requireEventSubject(event, state.memberships, 'membership')
      return
    case 'task/assigned':
    case 'task/delegated':
      requireEventSubject(event, state.taskAssignments, 'task assignment')
      return
    case 'task/delegation-granted':
      requireEventSubject(event, state.delegationGrants, 'delegation grant')
      return
    case 'task/completed':
      requireEventSubject(event, state.tasks, 'task')
      return
    case 'child/run-started':
    case 'child/run-finished':
      requireEventSubject(event, state.childRuns, 'child run')
      return
  }
}

function requireEventSubject<T>(event: WorkspaceEvent, records: Readonly<Record<string, T>>, label: string): T {
  if (event.subjectId === undefined || records[event.subjectId] === undefined) {
    throw new Error(`${event.type} event '${event.id}' references missing ${label} '${event.subjectId ?? ''}'`)
  }
  return records[event.subjectId]!
}

function greatestDurableId(state: WorkspaceState): number {
  const ids = [
    ...Object.keys(state.definitions),
    ...Object.keys(state.definitionRevisions),
    ...Object.keys(state.agents),
    ...Object.values(state.agents).flatMap(agent => agent.employmentPeriods.map(period => period.id)),
    ...Object.keys(state.rooms),
    ...Object.keys(state.memberships),
    ...state.memoryEntries.map(entry => entry.id),
    ...Object.keys(state.tasks),
    ...Object.keys(state.taskAssignments),
    ...Object.keys(state.delegationGrants),
    ...Object.keys(state.childRuns),
  ]
  let greatest = 0
  for (const id of ids) {
    const match = /-(\d+)$/.exec(id)
    if (match === null) throw new Error(`durable id '${id}' has no numeric workspace suffix`)
    greatest = Math.max(greatest, Number(match[1]))
  }
  return greatest
}
