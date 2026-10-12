/** Pure communication validation and effective input projections over preserved raw audit records. */
import type { AgentId, ChildRunId, TaskId, WorkspaceEventId } from './ids.ts'
import type { WorkspaceEvent, WorkspaceState } from './types.ts'
import type { TaskArtifactId, TaskDraftId, TaskTemplateRevisionId } from './workflow-contract.ts'
import type { ChatSource, CommunicationInputId, CommunicationInputTarget, CommunicationInvalidation, CommunicationState, CommunicationWorkflowReferences, ContextResetOperation } from './communication-contract.ts'

/**
 * Upgrade historical records without inventing message sources or execution dependencies.
 * @returns Empty successor metadata.
 */
export function createInitialCommunicationState(): CommunicationState {
  return { revision: 0, nextCheckpointOrder: 1, messages: {}, taskSources: {}, draftSources: {}, inputs: {}, contexts: {}, resets: {}, fileCheckpoints: {} }
}

/**
 * Validate same-record communication references after strict persistence parsing.
 * @param raw Complete audit aggregate; never an effective input projection.
 * @param communication Strictly parsed successor metadata.
 * @param workflow Workflow identifiers required when metadata references drafts, templates or artifacts.
 * @returns Nothing; throws when a persisted reference or reset admission differs.
 */
export function assertCommunicationRelationships(raw: WorkspaceState, communication: CommunicationState, workflow?: CommunicationWorkflowReferences): void {
  const events = new Map(raw.events.map(event => [event.id, event]))
  const requireEvent = (eventId: WorkspaceEventId): WorkspaceEvent => {
    const event = events.get(eventId)
    if (event === undefined) throw new Error(`communication event '${eventId}' does not exist`)
    return event
  }
  const requireSource = (source: ChatSource): WorkspaceEvent => {
    const event = requireEvent(source.eventId)
    if (!Object.hasOwn(raw.rooms, source.roomId) || event.type !== 'room/message' || event.subjectId !== source.roomId || event.actor === undefined || event.text === undefined || event.text.trim() === '') throw new Error('communication source is not a real message in its room')
    return event
  }
  const requireWorkflow = (kind: 'drafts' | 'taskTemplateRevisions' | 'artifacts', key: string): void => {
    if (workflow === undefined || !Object.hasOwn(workflow[kind], key)) throw new Error(`communication ${kind} reference '${key}' does not exist`)
  }
  const requireTarget = (target: CommunicationInputTarget): void => {
    switch (target.kind) {
      case 'event': requireEvent(target.eventId); return
      case 'task': requireOwn(raw.tasks, target.taskId, 'task'); return
      case 'draft': requireWorkflow('drafts', target.draftId); return
      case 'template': requireWorkflow('taskTemplateRevisions', target.templateRevisionId); return
      case 'artifact': requireWorkflow('artifacts', target.artifactId); return
      default: return assertNever(target)
    }
  }
  for (const [key, source] of Object.entries(communication.taskSources)) { requireOwn(raw.tasks, key, 'task'); requireSource(source) }
  for (const [key, source] of Object.entries(communication.draftSources)) { requireWorkflow('drafts', key); requireSource(source) }
  for (const [key, message] of Object.entries(communication.messages)) {
    if (key !== message.eventId) throw new Error('communication message key differs from event id')
    const event = requireEvent(message.eventId)
    if (event.type !== 'room/message' || event.actor === undefined || event.subjectId === undefined) throw new Error('communication metadata does not reference a room message')
    requireSource({ roomId: requireOwn(raw.rooms, event.subjectId, 'room').id, eventId: event.id })
    if (message.contextGeneration !== undefined && (event.actor.type !== 'agent' || message.contextGeneration > (own(communication.contexts, event.actor.id)?.generation ?? 0))) throw new Error('communication message generation is invalid')
    if (message.withdrawnBy !== undefined) {
      const reset = requireOwn(communication.resets, message.withdrawnBy, 'reset')
      if (reset.source.eventId !== event.id || event.actor.type !== 'human' || event.actor.id !== reset.requestedByHumanId) throw new Error('communication withdrawal author or source differs')
    }
  }
  const unfinishedByAgent = new Map<AgentId, string>()
  for (const [key, reset] of Object.entries(communication.resets)) {
    if (key !== reset.id) throw new Error('communication reset key differs from id')
    const source = requireSource(reset.source)
    if (source.actor?.type !== 'human' || source.actor.id !== reset.requestedByHumanId || own(communication.messages, source.id)?.withdrawnBy !== reset.id) throw new Error('communication reset does not own its human withdrawal')
    if (reset.fromSequence !== source.sequence || reset.throughSequence < reset.fromSequence || reset.throughSequence >= raw.nextSequence) throw new Error('communication reset window is invalid')
    assertUnique(reset.affectedAgentIds, 'reset agents')
    const expectedAgents = Object.values(raw.agents).filter(agent => {
      const started = requireEvent(agent.employmentPeriods[0]!.startedEventId)
      return started.sequence <= reset.throughSequence
    }).map(agent => agent.id)
    if (reset.affectedAgentIds.length !== expectedAgents.length || expectedAgents.some(agentId => !reset.affectedAgentIds.includes(agentId))) throw new Error('communication reset does not cover its organization')
    if (Object.keys(reset.previousGenerations).length !== reset.affectedAgentIds.length) throw new Error('communication reset generation ownership differs')
    for (const agentId of reset.affectedAgentIds) {
      requireOwn(raw.agents, agentId, 'agent')
      const previous = requireOwn(reset.previousGenerations, agentId, 'reset generation')
      const context = requireOwn(communication.contexts, agentId, 'context')
      if (context.generation <= previous) throw new Error('communication reset did not advance context generation')
      if (reset.status !== 'completed') {
        if (context.blockedBy !== reset.id || unfinishedByAgent.has(agentId)) throw new Error('communication unfinished reset must block each old context')
        unfinishedByAgent.set(agentId, reset.id)
      } else if (context.blockedBy === reset.id) throw new Error('communication completed reset still blocks its context')
    }
    for (const id of reset.invalidatedEventIds) requireEvent(id)
    for (const id of reset.invalidatedTaskIds) requireOwn(raw.tasks, id, 'task')
    for (const id of reset.invalidatedDraftIds) requireWorkflow('drafts', id)
    for (const id of reset.invalidatedTemplateRevisionIds) requireWorkflow('taskTemplateRevisions', id)
    for (const id of reset.invalidatedArtifactIds) requireWorkflow('artifacts', id)
    assertUnique(reset.invalidatedEventIds, 'invalidated events')
    assertUnique(reset.invalidatedTaskIds, 'invalidated tasks')
    assertUnique(reset.invalidatedDraftIds, 'invalidated drafts')
    assertUnique(reset.invalidatedTemplateRevisionIds, 'invalidated template revisions')
    assertUnique(reset.invalidatedArtifactIds, 'invalidated artifacts')
  }
  for (const [agentId, context] of Object.entries(communication.contexts)) {
    const agent = requireOwn(raw.agents, agentId, 'agent')
    const previousGenerations = Object.values(communication.resets).flatMap(reset => {
      const previous = own(reset.previousGenerations, agentId)
      return previous === undefined ? [] : [previous]
    }).sort((left, right) => left - right)
    if (context.generation !== previousGenerations.length || previousGenerations.some((generation, index) => generation !== index)) throw new Error('communication context generations do not start at zero and advance once per reset')
    if (context.blockedBy !== undefined) {
      const reset = requireOwn(communication.resets, context.blockedBy, 'reset')
      if (reset.status === 'completed' || !reset.affectedAgentIds.includes(agent.id) || context.sessionId !== undefined) throw new Error('communication context block is invalid')
    }
    if (context.sessionId !== undefined && own(raw.sessionBindings, agentId) !== context.sessionId) throw new Error('communication context session differs from local binding')
  }
  const inputGenerations = new Map<WorkspaceEventId, number>()
  for (const [key, input] of Object.entries(communication.inputs)) {
    if (key !== input.id) throw new Error('communication input key differs from id')
    requireOwn(raw.agents, input.agentId, 'agent')
    requireTarget(input.target)
    if (input.contextGeneration > (own(communication.contexts, input.agentId)?.generation ?? 0) || input.recordedAtSequence >= raw.nextSequence) throw new Error('communication input generation or sequence is invalid')
    for (const ids of [input.directEventIds, input.recalledEventIds, input.sessionEventIds]) {
      assertUnique(ids, 'input events')
      for (const id of ids) if (requireEvent(id).sequence > input.recordedAtSequence) throw new Error('communication input precedes its source')
    }
    if (input.target.kind === 'event') {
      const target = requireEvent(input.target.eventId)
      if (target.sequence > input.recordedAtSequence) throw new Error('communication input precedes its target')
      const author = generatedBy(raw, target)
      if (author !== undefined) {
        const messageGeneration = own(communication.messages, target.id)?.contextGeneration
        const previousInputGeneration = inputGenerations.get(target.id)
        if (author !== input.agentId || (messageGeneration !== undefined && messageGeneration !== input.contextGeneration) || (previousInputGeneration !== undefined && previousInputGeneration !== input.contextGeneration)) throw new Error('communication generated input author or generation differs from its target')
        inputGenerations.set(target.id, input.contextGeneration)
      }
    }
  }
  const checkpointOrders = new Set<number>()
  for (const [key, checkpoint] of Object.entries(communication.fileCheckpoints)) {
    if (key !== checkpoint.id) throw new Error('communication checkpoint key differs from id')
    if (checkpoint.order >= communication.nextCheckpointOrder || checkpointOrders.has(checkpoint.order)) throw new Error('communication checkpoint order must be unique and precede its next counter')
    checkpointOrders.add(checkpoint.order)
    const input = requireOwn(communication.inputs, checkpoint.inputId, 'checkpoint input')
    if (input.agentId !== checkpoint.agentId || input.contextGeneration !== checkpoint.contextGeneration) throw new Error('communication checkpoint does not belong to its managed input')
  }
}

/**
 * Resolve withdrawals, bounded old generations and their recorded dependencies for all consumers.
 * @param raw Complete preserved audit aggregate.
 * @param communication Validated communication metadata.
 * @returns Identifiers forbidden as model input or as a source for work application.
 */
export function getCommunicationInvalidation(raw: WorkspaceState, communication: CommunicationState): CommunicationInvalidation {
  const inputIds = new Set<CommunicationInputId>()
  const eventIds = new Set<WorkspaceEventId>()
  const taskIds = new Set<TaskId>()
  const draftIds = new Set<TaskDraftId>()
  const templateRevisionIds = new Set<TaskTemplateRevisionId>()
  const artifactIds = new Set<TaskArtifactId>()
  const childRunIds = new Set<ChildRunId>()
  const resets = Object.values(communication.resets)
  const events = new Map(raw.events.map(event => [event.id, event]))
  const eventGenerations = new Map<WorkspaceEventId, number>()
  for (const message of Object.values(communication.messages)) if (message.contextGeneration !== undefined) eventGenerations.set(message.eventId, message.contextGeneration)
  for (const input of Object.values(communication.inputs)) if (input.target.kind === 'event') eventGenerations.set(input.target.eventId, input.contextGeneration)
  for (const message of Object.values(communication.messages)) if (message.withdrawnBy !== undefined) eventIds.add(message.eventId)
  for (const reset of resets) {
    eventIds.add(reset.source.eventId)
    for (const id of reset.invalidatedEventIds) eventIds.add(id)
    for (const id of reset.invalidatedTaskIds) taskIds.add(id)
    for (const id of reset.invalidatedDraftIds) draftIds.add(id)
    for (const id of reset.invalidatedTemplateRevisionIds) templateRevisionIds.add(id)
    for (const id of reset.invalidatedArtifactIds) artifactIds.add(id)
    for (const event of raw.events) {
      const agentId = generatedBy(raw, event)
      if (agentId !== undefined && inResetGeneration(reset, agentId, eventGenerations.get(event.id), event.sequence)) eventIds.add(event.id)
    }
    for (const task of Object.values(raw.tasks)) {
      if (own(communication.taskSources, task.id) !== undefined) continue
      const assignmentIds = new Set<string>(Object.values(raw.taskAssignments).filter(assignment => assignment.taskId === task.id).map(assignment => assignment.id))
      const created = raw.events.find(event => (event.type === 'task/assigned' || event.type === 'task/delegated') && event.subjectId !== undefined && assignmentIds.has(event.subjectId))
      if (created !== undefined && created.sequence >= reset.fromSequence && created.sequence <= reset.throughSequence) taskIds.add(task.id)
    }
  }
  let previousCount = -1
  const total = (): number => inputIds.size + eventIds.size + taskIds.size + draftIds.size + templateRevisionIds.size + artifactIds.size + childRunIds.size
  while (previousCount !== total()) {
    previousCount = total()
    for (const [taskId, source] of Object.entries(communication.taskSources)) if (eventIds.has(source.eventId)) taskIds.add(taskId as TaskId)
    for (const [draftId, source] of Object.entries(communication.draftSources)) if (eventIds.has(source.eventId)) draftIds.add(draftId as TaskDraftId)
    for (const input of Object.values(communication.inputs)) {
      const dependsOnInvalidEvent = [...input.directEventIds, ...input.recalledEventIds, ...input.sessionEventIds].some(id => eventIds.has(id))
      const oldGeneration = resets.some(reset => inResetGeneration(reset, input.agentId, input.contextGeneration, input.recordedAtSequence))
      if (dependsOnInvalidEvent || oldGeneration) {
        inputIds.add(input.id)
        switch (input.target.kind) {
          case 'event': {
            const event = events.get(input.target.eventId)
            if (event?.actor?.type !== 'human') eventIds.add(input.target.eventId)
            break
          }
          case 'task': taskIds.add(input.target.taskId); break
          case 'draft': draftIds.add(input.target.draftId); break
          case 'template': templateRevisionIds.add(input.target.templateRevisionId); break
          case 'artifact': artifactIds.add(input.target.artifactId); break
          default: assertNever(input.target)
        }
      }
    }
    for (const task of Object.values(raw.tasks)) if (taskIds.has(task.rootTaskId)) taskIds.add(task.id)
    for (const child of Object.values(raw.childRuns)) {
      if (taskIds.has(child.taskId) || raw.events.some(event => event.subjectId === child.id && eventIds.has(event.id))) childRunIds.add(child.id)
    }
    for (const event of raw.events) {
      const taskId = eventTaskId(raw, event)
      if ((taskId !== undefined && taskIds.has(taskId)) || (event.subjectId !== undefined && childRunIds.has(event.subjectId as ChildRunId))) eventIds.add(event.id)
    }
  }
  return { inputIds, eventIds, taskIds, draftIds, templateRevisionIds, artifactIds, childRunIds }
}

/**
 * Select effective model inputs without deleting or overwriting raw audit records.
 * @param raw Complete preserved aggregate; use this for mutations and UI history.
 * @param communication Validated communication metadata.
 * @returns A read-only consumer projection. Event gaps make it unsuitable for persistence or mutation.
 */
export function effectiveWorkspaceState(raw: WorkspaceState, communication: CommunicationState): WorkspaceState {
  const invalid = getCommunicationInvalidation(raw, communication)
  const resetAgentIds = new Set(Object.values(communication.resets).flatMap(reset => reset.affectedAgentIds))
  return {
    ...raw,
    events: raw.events.filter(event => !invalid.eventIds.has(event.id)),
    memoryEntries: raw.memoryEntries.filter(entry => !invalid.eventIds.has(entry.eventId)),
    tasks: Object.fromEntries(Object.entries(raw.tasks).filter(([, task]) => !invalid.taskIds.has(task.id))),
    taskAssignments: Object.fromEntries(Object.entries(raw.taskAssignments).filter(([, assignment]) => !invalid.taskIds.has(assignment.taskId))),
    delegationGrants: Object.fromEntries(Object.entries(raw.delegationGrants).filter(([, grant]) => !invalid.taskIds.has(grant.rootTaskId))),
    childRuns: Object.fromEntries(Object.entries(raw.childRuns).filter(([, child]) => !invalid.childRunIds.has(child.id))),
    sessionBindings: Object.fromEntries(Object.entries(raw.sessionBindings).filter(([agentId, sessionId]) => {
      const context = own(communication.contexts, agentId)
      return context?.blockedBy === undefined && (!resetAgentIds.has(agentId as AgentId) || context?.sessionId === sessionId)
    })),
  }
}

function inResetGeneration(reset: ContextResetOperation, agentId: AgentId, generation: number | undefined, sequence: number): boolean {
  const previous = own(reset.previousGenerations, agentId)
  return previous !== undefined && sequence >= reset.fromSequence && (generation === undefined ? sequence <= reset.throughSequence : generation <= previous)
}

function generatedBy(raw: WorkspaceState, event: WorkspaceEvent): AgentId | undefined {
  if (event.actor?.type === 'agent') return event.actor.id
  if (event.type === 'child/run-finished' && event.subjectId !== undefined) return own(raw.childRuns, event.subjectId)?.parentAgentId
  return undefined
}

function eventTaskId(raw: WorkspaceState, event: WorkspaceEvent): TaskId | undefined {
  if ('taskId' in event) return event.taskId
  if (event.subjectId === undefined) return undefined
  if (event.type === 'task/assigned' || event.type === 'task/delegated') return own(raw.taskAssignments, event.subjectId)?.taskId
  if (event.type === 'task/completed' || event.type === 'task/cancelled') return own(raw.tasks, event.subjectId)?.id
  if (event.type === 'task/delegation-granted' || event.type === 'task/delegation-revoked') return own(raw.delegationGrants, event.subjectId)?.rootTaskId
  if (event.type === 'child/run-started' || event.type === 'child/run-finished') return own(raw.childRuns, event.subjectId)?.taskId
  return undefined
}

function own<T>(records: Readonly<Record<string, T>>, key: string): T | undefined { return Object.hasOwn(records, key) ? records[key] : undefined }
function requireOwn<T>(records: Readonly<Record<string, T>>, key: string, kind: string): T {
  const value = own(records, key)
  if (value === undefined) throw new Error(`communication ${kind} '${key}' does not exist`)
  return value
}
function assertUnique(values: readonly string[], kind: string): void { if (new Set(values).size !== values.length) throw new Error(`communication ${kind} contains duplicates`) }
function assertNever(value: never): never { throw new Error(`unexpected communication target: ${String(value)}`) }
