/** Pure formal-task, delegation, and one-shot child-run mutations. */

import {
  ChildRunId,
  DelegationGrantId,
  TaskAssignmentId,
  TaskId,
} from './ids.ts'
import {
  appendMemoryEntries,
  appendWorkspaceEvent,
  beginWorkspaceMutation,
  mintWorkspaceId,
} from './state.ts'
import type {
  AgentInstance,
  ChildRun,
  DelegationGrant,
  TaskAssignment,
  WorkspaceEvent,
  WorkspaceState,
  WorkspaceTask,
} from './types.ts'
import type { AgentId, ChildRunId as ChildId, DelegationGrantId as GrantId, HumanId, TaskAssignmentId as AssignmentId, TaskId as WorkspaceTaskId } from './ids.ts'

/** Fields required for a human to assign a root task to an employed agent. */
export interface AssignHumanTaskRequest {
  readonly humanId: HumanId
  readonly assigneeAgentId: AgentId
  readonly title: string
}

/** Result of a human root-task assignment. */
export interface AssignHumanTaskResult {
  readonly state: WorkspaceState
  readonly taskId: WorkspaceTaskId
  readonly taskAssignmentId: AssignmentId
}

/** Fields required to create human-controlled task delegation authority. */
export interface GrantTaskDelegationRequest {
  readonly humanId: HumanId
  readonly granteeAgentId: AgentId
  readonly rootTaskId: WorkspaceTaskId
}

/** Result of granting an employed agent task-scoped delegation authority. */
export interface GrantTaskDelegationResult {
  readonly state: WorkspaceState
  readonly delegationGrantId: GrantId
}

/** Fields required for a granted agent to assign a peer subtask. */
export interface AssignDelegatedTaskRequest {
  readonly actorAgentId: AgentId
  readonly assigneeAgentId: AgentId
  readonly rootTaskId: WorkspaceTaskId
  readonly title: string
}

/** Result of an agent-created, grant-backed derived task assignment. */
export interface AssignDelegatedTaskResult {
  readonly state: WorkspaceState
  readonly taskId: WorkspaceTaskId
  readonly taskAssignmentId: AssignmentId
}

/** Fields required for an assigned employed agent to complete one task. */
export interface CompleteTaskRequest {
  readonly actorAgentId: AgentId
  readonly taskId: WorkspaceTaskId
}

/** Fields required to record a one-shot child run. */
export interface RecordChildRunStartedRequest {
  readonly parentAgentId: AgentId
  readonly taskId: WorkspaceTaskId
}

/** Result of recording a child run start. */
export interface RecordChildRunStartedResult {
  readonly state: WorkspaceState
  readonly childRunId: ChildId
}

/** Fields required to terminally record a child run result. */
export interface RecordChildRunFinishedRequest {
  readonly childRunId: ChildId
  readonly status: Exclude<ChildRun['status'], 'running'>
  readonly result: string
}

/**
 * Assign a new root task from a human to an employed top-level agent.
 * @param state Immutable workspace state.
 * @param request Human assignment fields.
 * @returns The updated state and durable task identifiers.
 * @throws {Error} When the assignee is not employed or the title is blank.
 */
export function assignHumanTask(state: WorkspaceState, request: AssignHumanTaskRequest): AssignHumanTaskResult {
  requireText('task title', request.title)
  requireEmployedAgent(state, request.assigneeAgentId)
  let changed = beginWorkspaceMutation(state)
  let taskId: WorkspaceTaskId
  ;[changed, taskId] = mintWorkspaceId(changed, 'task', TaskId)
  let taskAssignmentId: AssignmentId
  ;[changed, taskAssignmentId] = mintWorkspaceId(changed, 'task-assignment', TaskAssignmentId)
  let event: WorkspaceEvent
  ;[changed, event] = appendWorkspaceEvent(changed, 'task/assigned', taskAssignmentId, { actor: { type: 'human', id: request.humanId }, text: request.title })
  const task: WorkspaceTask = { id: taskId, rootTaskId: taskId, title: request.title, status: 'open' }
  const assignment: TaskAssignment = {
    id: taskAssignmentId,
    taskId,
    rootTaskId: taskId,
    assigneeAgentId: request.assigneeAgentId,
  }
  changed = withTaskAndAssignment(changed, task, assignment)
  changed = appendMemoryEntries(changed, [{ agentId: request.assigneeAgentId, eventId: event.id, acquiredBy: 'task' }])
  return { state: changed, taskId, taskAssignmentId }
}

/**
 * Grant an employed agent human-created authority for one active root task.
 * @param state Immutable workspace state.
 * @param request Human grant fields.
 * @returns The updated state and durable grant identifier.
 * @throws {Error} When the root task is not open or the grantee is not employed.
 */
export function grantTaskDelegation(state: WorkspaceState, request: GrantTaskDelegationRequest): GrantTaskDelegationResult {
  const rootTask = requireRootTask(state, request.rootTaskId)
  requireOpenTask(rootTask)
  requireEmployedAgent(state, request.granteeAgentId)
  let changed = beginWorkspaceMutation(state)
  let delegationGrantId: GrantId
  ;[changed, delegationGrantId] = mintWorkspaceId(changed, 'delegation-grant', DelegationGrantId)
  ;[changed] = appendWorkspaceEvent(changed, 'task/delegation-granted', delegationGrantId, { actor: { type: 'human', id: request.humanId } })
  const grant: DelegationGrant = {
    id: delegationGrantId,
    rootTaskId: rootTask.id,
    granteeAgentId: request.granteeAgentId,
    grantedByHumanId: request.humanId,
    status: 'active',
  }
  return { state: { ...changed, delegationGrants: { ...changed.delegationGrants, [delegationGrantId]: grant } }, delegationGrantId }
}

/**
 * Assign a peer subtask when the acting agent holds active human authority for the root task.
 * @param state Immutable workspace state.
 * @param request Delegated assignment fields.
 * @returns The updated state and durable task identifiers.
 * @throws {Error} When either agent is not employed or no matching active human grant exists.
 */
export function assignDelegatedTask(state: WorkspaceState, request: AssignDelegatedTaskRequest): AssignDelegatedTaskResult {
  requireText('task title', request.title)
  requireEmployedAgent(state, request.actorAgentId)
  requireEmployedAgent(state, request.assigneeAgentId)
  const rootTask = requireRootTask(state, request.rootTaskId)
  const grant = activeGrantFor(state, rootTask.id, request.actorAgentId)
  if (grant === undefined) {
    throw new Error(`agent '${request.actorAgentId}' needs an active human delegation grant for root task '${rootTask.id}'`)
  }
  requireOpenTask(rootTask)
  let changed = beginWorkspaceMutation(state)
  let taskId: WorkspaceTaskId
  ;[changed, taskId] = mintWorkspaceId(changed, 'task', TaskId)
  let taskAssignmentId: AssignmentId
  ;[changed, taskAssignmentId] = mintWorkspaceId(changed, 'task-assignment', TaskAssignmentId)
  let event: WorkspaceEvent
  ;[changed, event] = appendWorkspaceEvent(changed, 'task/delegated', taskAssignmentId, { actor: { type: 'agent', id: request.actorAgentId }, text: request.title })
  const task: WorkspaceTask = { id: taskId, rootTaskId: rootTask.id, title: request.title, status: 'open' }
  const assignment: TaskAssignment = {
    id: taskAssignmentId,
    taskId,
    rootTaskId: rootTask.id,
    assigneeAgentId: request.assigneeAgentId,
    grantId: grant.id,
  }
  changed = withTaskAndAssignment(changed, task, assignment)
  changed = appendMemoryEntries(changed, [{ agentId: request.assigneeAgentId, eventId: event.id, acquiredBy: 'task' }])
  return { state: changed, taskId, taskAssignmentId }
}

/**
 * Complete an assigned task and expire every active grant when its root task ends.
 * @param state Immutable workspace state.
 * @param request Completion fields.
 * @returns The updated workspace state.
 * @throws {Error} When the agent is not employed, is not assigned the task, or it is terminal.
 */
export function completeTask(state: WorkspaceState, request: CompleteTaskRequest): { readonly state: WorkspaceState } {
  requireEmployedAgent(state, request.actorAgentId)
  const task = requireTask(state, request.taskId)
  requireOpenTask(task)
  requireAssignmentFor(state, task.id, request.actorAgentId)
  let changed = beginWorkspaceMutation(state)
  let event: WorkspaceEvent
  ;[changed, event] = appendWorkspaceEvent(changed, 'task/completed', task.id, { actor: { type: 'agent', id: request.actorAgentId }, text: task.title })
  const delegationGrants = { ...changed.delegationGrants }
  if (task.id === task.rootTaskId) {
    for (const grant of Object.values(delegationGrants)) {
      if (grant.rootTaskId === task.id && grant.status === 'active') {
        delegationGrants[grant.id] = { ...grant, status: 'expired' }
      }
    }
  }
  changed = {
    ...changed,
    tasks: { ...changed.tasks, [task.id]: { ...task, status: 'completed' } },
    delegationGrants,
  }
  changed = appendMemoryEntries(changed, [{ agentId: request.actorAgentId, eventId: event.id, acquiredBy: 'task' }])
  return { state: changed }
}

/**
 * Record an employed agent starting one internal child run for an open task.
 * @param state Immutable workspace state.
 * @param request Child-run start fields.
 * @returns The updated state and durable child-run identifier.
 * @throws {Error} When the parent is not employed or the task is not open.
 */
export function recordChildRunStarted(state: WorkspaceState, request: RecordChildRunStartedRequest): RecordChildRunStartedResult {
  requireEmployedAgent(state, request.parentAgentId)
  requireOpenTask(requireTask(state, request.taskId))
  let changed = beginWorkspaceMutation(state)
  let childRunId: ChildId
  ;[changed, childRunId] = mintWorkspaceId(changed, 'child-run', ChildRunId)
  let event: WorkspaceEvent
  ;[changed, event] = appendWorkspaceEvent(changed, 'child/run-started', childRunId, { actor: { type: 'agent', id: request.parentAgentId } })
  const childRun: ChildRun = { id: childRunId, parentAgentId: request.parentAgentId, taskId: request.taskId, status: 'running' }
  changed = { ...changed, childRuns: { ...changed.childRuns, [childRunId]: childRun } }
  changed = appendMemoryEntries(changed, [{ agentId: request.parentAgentId, eventId: event.id, acquiredBy: 'task' }])
  return { state: changed, childRunId }
}

/**
 * Record a terminal child result once and acquire its canonical event into parent memory.
 * @param state Immutable workspace state.
 * @param request Terminal child-run fields.
 * @returns The updated workspace state.
 * @throws {Error} When the parent is departed, the run is missing or terminal, or the result is blank.
 */
export function recordChildRunFinished(state: WorkspaceState, request: RecordChildRunFinishedRequest): { readonly state: WorkspaceState } {
  const childRun = state.childRuns[request.childRunId]
  if (childRun === undefined) throw new Error(`child run '${request.childRunId}' does not exist`)
  if (childRun.status !== 'running') throw new Error(`child run '${request.childRunId}' is already terminal`)
  requireEmployedAgent(state, childRun.parentAgentId)
  requireText('child run result', request.result)
  let changed = beginWorkspaceMutation(state)
  let event: WorkspaceEvent
  ;[changed, event] = appendWorkspaceEvent(changed, 'child/run-finished', childRun.id, {
    childRunStatus: request.status,
    text: request.result,
  })
  changed = {
    ...changed,
    childRuns: {
      ...changed.childRuns,
      [childRun.id]: { ...childRun, status: request.status, result: request.result },
    },
  }
  changed = appendMemoryEntries(changed, [{ agentId: childRun.parentAgentId, eventId: event.id, acquiredBy: 'child-result' }])
  return { state: changed }
}

function withTaskAndAssignment(state: WorkspaceState, task: WorkspaceTask, assignment: TaskAssignment): WorkspaceState {
  return {
    ...state,
    tasks: { ...state.tasks, [task.id]: task },
    taskAssignments: { ...state.taskAssignments, [assignment.id]: assignment },
  }
}

function requireEmployedAgent(state: WorkspaceState, agentId: AgentId): AgentInstance {
  const agent = state.agents[agentId]
  if (agent === undefined) throw new Error(`agent '${agentId}' does not exist`)
  if (agent.employmentStatus !== 'employed') throw new Error(`agent '${agentId}' is departed and cannot handle tasks`)
  return agent
}

function requireTask(state: WorkspaceState, taskId: WorkspaceTaskId): WorkspaceTask {
  const task = state.tasks[taskId]
  if (task === undefined) throw new Error(`task '${taskId}' does not exist`)
  return task
}

function requireRootTask(state: WorkspaceState, taskId: WorkspaceTaskId): WorkspaceTask {
  const task = requireTask(state, taskId)
  if (task.id !== task.rootTaskId) throw new Error(`task '${taskId}' is not a root task`)
  return task
}

function requireOpenTask(task: WorkspaceTask): void {
  if (task.status !== 'open') throw new Error(`task '${task.id}' is ${task.status}`)
}

function requireAssignmentFor(state: WorkspaceState, taskId: WorkspaceTaskId, agentId: AgentId): void {
  if (!Object.values(state.taskAssignments).some(assignment => assignment.taskId === taskId && assignment.assigneeAgentId === agentId)) {
    throw new Error(`agent '${agentId}' is not assigned task '${taskId}'`)
  }
}

function activeGrantFor(state: WorkspaceState, rootTaskId: WorkspaceTaskId, agentId: AgentId): DelegationGrant | undefined {
  return Object.values(state.delegationGrants).find(grant => (
    grant.rootTaskId === rootTaskId
    && grant.granteeAgentId === agentId
    && grant.status === 'active'
  ))
}

function requireText(subject: string, value: string): void {
  if (value.trim() === '') throw new Error(`${subject} must not be empty`)
}
