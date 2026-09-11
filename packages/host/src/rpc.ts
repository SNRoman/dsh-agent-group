/** Plugin-owned RPC contract for the browser workspace UI. */

import { z } from 'zod'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceBusinessError } from './errors.ts'
import type { WorkspaceBusinessErrorCode, WorkspaceBusinessErrorDetailsMap } from './errors.ts'
import {
  AgentDefinitionId,
  AgentId,
  ChildRunId,
  DelegationGrantId,
  DefinitionRevisionId,
  HumanId,
  MembershipId,
  RoomId,
  TaskId,
  WorkspaceActivityId,
} from './ids.ts'
import type { WorkspaceActivitySnapshot } from './activity-stream.ts'
import type { WorkspaceActivityIdentity } from './activity-stream.ts'
import type { WorkspaceStopResult } from './activity-controller.ts'
import type { DefinitionHistoryItem } from './definition-history.ts'
import type { MemoryPage, MemoryQuery } from './memory-query.ts'
import { WORKSPACE_EVENT_TYPES } from './types.ts'
import type { WorkspaceCommand, WorkspaceState } from './types.ts'
import type { AssignHumanTaskResult, GrantTaskDelegationResult } from './tasks.ts'

/** Logical Connection channel owned exclusively by this plugin. */
export const AGENT_WORKSPACE_RPC_CHANNEL = '/agent-workspace'
/** Stable browser-side human identity used for workspace room messages. */
export const WEB_WORKSPACE_HUMAN_ID = HumanId('web-user')

/** Ephemeral execution state for one room; never persisted in WorkspaceState. */
export interface WorkspaceRoomRuntimeStatus {
  readonly pending: number
  readonly error?: string
}

/** Browser-visible execution state keyed by room id. */
export interface WorkspaceRuntimeStatus {
  readonly rooms: Readonly<Record<string, WorkspaceRoomRuntimeStatus>>
}

/** Result of opening or reusing one stable human-to-agent direct room. */
export interface WorkspaceDirectRoomResult {
  readonly state: WorkspaceState
  readonly roomId: RoomId
}

/** Common response for a mutation committed at one aggregate revision. */
export interface WorkspaceMutationResult<Value> {
  readonly revision: number
  readonly value: Value
}

/** Minimal service face required by the transport adapter. */
export interface WorkspaceRpcService {
  snapshot(): WorkspaceState
  runtimeStatus(): WorkspaceRuntimeStatus
  activitySnapshot(): WorkspaceActivitySnapshot
  waitForActivity(afterVersion: number, signal: AbortSignal): Promise<WorkspaceActivitySnapshot>
  execute(expectedRevision: number, command: WorkspaceCommand, signal?: AbortSignal): Promise<WorkspaceMutationResult<WorkspaceState>>
  openDirectRoom(expectedRevision: number, agentId: AgentId, signal?: AbortSignal): Promise<WorkspaceMutationResult<WorkspaceDirectRoomResult>>
  postHumanMessage(expectedRevision: number, roomId: RoomId, humanId: HumanId, text: string, mentions: readonly AgentId[], signal?: AbortSignal): Promise<WorkspaceMutationResult<WorkspaceState>>
  assignTask(expectedRevision: number, humanId: HumanId, assigneeAgentId: AgentId, title: string, signal?: AbortSignal): Promise<WorkspaceMutationResult<AssignHumanTaskResult>>
  grantTaskDelegation(expectedRevision: number, humanId: HumanId, granteeAgentId: AgentId, rootTaskId: TaskId, signal?: AbortSignal): Promise<WorkspaceMutationResult<GrantTaskDelegationResult>>
  revokeTaskDelegation(expectedRevision: number, humanId: HumanId, delegationGrantId: DelegationGrantId, signal?: AbortSignal): Promise<WorkspaceMutationResult<WorkspaceState>>
  cancelTask(expectedRevision: number, humanId: HumanId, taskId: TaskId, signal?: AbortSignal): Promise<WorkspaceMutationResult<WorkspaceState>>
  retryTaskDelivery(expectedRevision: number, taskId: TaskId, signal?: AbortSignal): Promise<WorkspaceMutationResult<string>>
  queryMemory(query: MemoryQuery): MemoryPage
  definitionHistory(definitionId: AgentDefinitionId): readonly DefinitionHistoryItem[]
  stopActivity(expectedRevision: number, identity: WorkspaceActivityIdentity, signal?: AbortSignal): Promise<WorkspaceMutationResult<WorkspaceStopResult>>
  stopChildRun(expectedRevision: number, childRunId: ChildRunId, signal?: AbortSignal): Promise<WorkspaceMutationResult<WorkspaceStopResult>>
  acknowledgeAgentFailure(expectedRevision: number, agentId: AgentId, signal?: AbortSignal): Promise<WorkspaceMutationResult<void>>
}

export type WorkspaceRpcValue =
  | WorkspaceState
  | WorkspaceRuntimeStatus
  | WorkspaceActivitySnapshot
  | MemoryPage
  | readonly DefinitionHistoryItem[]
  | WorkspaceMutationResult<unknown>

type WorkspaceRpcBusinessErrorFor<Code extends WorkspaceBusinessErrorCode> = {
  readonly kind: 'business'
  readonly code: Code
  readonly message: string
  readonly details: WorkspaceBusinessErrorDetailsMap[Code]
}

type WorkspaceRpcBusinessError = {
  readonly [Code in WorkspaceBusinessErrorCode]: WorkspaceRpcBusinessErrorFor<Code>
}[WorkspaceBusinessErrorCode]

type AnyWorkspaceBusinessError = {
  readonly [Code in WorkspaceBusinessErrorCode]: WorkspaceBusinessError<Code>
}[WorkspaceBusinessErrorCode]

/** Connection-compatible result subset used by this plugin. */
export type WorkspaceRpcResult =
  | { readonly ok: true; readonly value: WorkspaceRpcValue }
  | {
    readonly ok: false
    readonly error:
      | WorkspaceRpcBusinessError
      | {
        readonly kind: 'bad-request'
        readonly code: 'bad-request'
        readonly message: string
        readonly details: { readonly issues: readonly unknown[] }
      }
      | {
        readonly kind: 'cancelled'
        readonly code: 'cancelled'
        readonly message: string
        readonly details: Record<string, never>
      }
      | {
        readonly kind: 'internal'
        readonly code: 'internal'
        readonly message: string
        readonly details: Record<string, never>
      }
  }

/** Structural Connection handler shape so the Host remains usable without the web stack. */
export type WorkspaceRpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<WorkspaceRpcResult>

const id = z.string().trim().min(1)
const text = z.string().trim().min(1)
const expectedRevision = z.number().int().nonnegative()
const emptyPayload = z.object({}).strict()
const streamWaitPayload = z.object({ afterVersion: z.number().int().nonnegative() }).strict()
const createDefinitionPayload = z.object({
  expectedRevision,
  name: text,
  description: z.string(),
  instructions: z.string(),
}).strict()
const reviseDefinitionPayload = z.object({
  expectedRevision,
  definitionId: id,
  description: z.string(),
  instructions: z.string(),
  synchronizeAgentIds: z.array(id).optional(),
}).strict()
const synchronizeDefinitionPayload = z.object({
  expectedRevision,
  definitionId: id,
  definitionRevisionId: id,
  agentIds: z.array(id).min(1),
}).strict()
const createAgentPayload = z.object({ expectedRevision, definitionId: id, name: text }).strict()
const agentPayload = z.object({ expectedRevision, agentId: id }).strict()
const createRoomPayload = z.object({
  expectedRevision,
  kind: z.enum(['group', 'direct']),
  name: text.optional(),
}).strict()
const membershipMemoryStart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('new-events') }).strict(),
  z.object({
    type: z.literal('event-range'),
    startSequence: z.number().int().positive(),
    endSequence: z.number().int().positive(),
  }).strict(),
])
const joinRoomPayload = z.object({ expectedRevision, roomId: id, agentId: id, memoryStart: membershipMemoryStart }).strict()
const leaveRoomPayload = z.object({ expectedRevision, membershipId: id }).strict()
const postRoomPayload = z.object({ expectedRevision, roomId: id, text, mentions: z.array(id) }).strict()
const taskAssignPayload = z.object({ expectedRevision, assigneeAgentId: id, title: text }).strict()
const taskGrantPayload = z.object({ expectedRevision, granteeAgentId: id, rootTaskId: id }).strict()
const taskRevokePayload = z.object({ expectedRevision, delegationGrantId: id }).strict()
const taskPayload = z.object({ expectedRevision, taskId: id }).strict()
const childPayload = z.object({ expectedRevision, childRunId: id }).strict()
const activityIdentityPayload = z.object({
  expectedRevision,
  activityId: id,
  agentId: id,
  messageId: id,
  sessionId: id,
  turn: z.number().int().nonnegative(),
}).strict()
const definitionHistoryPayload = z.object({ definitionId: id }).strict()
const memoryQueryPayload = z.object({
  agentId: id,
  sourceKind: z.enum(['room', 'task', 'child']).optional(),
  sourceId: id.optional(),
  provenance: z.enum(['room-membership', 'history-sync', 'task', 'child-result']).optional(),
  eventTypes: z.array(z.enum(WORKSPACE_EVENT_TYPES)).optional(),
  minimumSequence: z.number().int().nonnegative().optional(),
  maximumSequence: z.number().int().nonnegative().optional(),
  text: z.string().optional(),
  limit: z.number().int().positive(),
  cursor: z.string().min(1).optional(),
  snapshotRevision: expectedRevision,
}).strict()

/**
 * Build the isolated endpoint dispatcher consumed by `ctx.connection.rpc.handle`.
 * No arbitrary aggregate mutation is exposed: every browser capability maps to
 * an explicit existing domain command or the dispatcher-facing room post API.
 */
export function createWorkspaceRpcHandler(service: WorkspaceRpcService): WorkspaceRpcHandler {
  return async (endpoint, payload, signal) => {
    if (signal.aborted) return cancelled()
    try {
      switch (endpoint) {
        case 'snapshot': {
          const parsed = emptyPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          return success(service.snapshot())
        }
        case 'runtime/status': {
          const parsed = emptyPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          return success(service.runtimeStatus())
        }
        case 'stream/snapshot': {
          const parsed = emptyPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          return success(service.activitySnapshot())
        }
        case 'runtime/activity/snapshot': {
          const parsed = emptyPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          return success(service.activitySnapshot())
        }
        case 'stream/wait': {
          const parsed = streamWaitPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          signal.throwIfAborted()
          return success(await service.waitForActivity(parsed.data.afterVersion, signal))
        }
        case 'runtime/activity/wait': {
          const parsed = streamWaitPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          signal.throwIfAborted()
          return success(await service.waitForActivity(parsed.data.afterVersion, signal))
        }
        case 'definition/create': {
          const parsed = createDefinitionPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          return success(await service.execute(parsed.data.expectedRevision, {
            type: 'definition/create',
            name: parsed.data.name,
            description: parsed.data.description,
            instructions: parsed.data.instructions,
          }, signal))
        }
        case 'definition/revise': {
          const parsed = reviseDefinitionPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          return success(await service.execute(parsed.data.expectedRevision, {
            type: 'definition/revise',
            definitionId: AgentDefinitionId(parsed.data.definitionId),
            description: parsed.data.description,
            instructions: parsed.data.instructions,
            ...(parsed.data.synchronizeAgentIds === undefined
              ? {}
              : { synchronizeAgentIds: parsed.data.synchronizeAgentIds.map(AgentId) }),
          }, signal))
        }
        case 'definition/synchronize': {
          const parsed = synchronizeDefinitionPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          return success(await service.execute(parsed.data.expectedRevision, {
            type: 'definition/synchronize',
            definitionId: AgentDefinitionId(parsed.data.definitionId),
            definitionRevisionId: DefinitionRevisionId(parsed.data.definitionRevisionId),
            agentIds: parsed.data.agentIds.map(AgentId),
          }, signal))
        }
        case 'agent/create': {
          const parsed = createAgentPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          return success(await service.execute(parsed.data.expectedRevision, {
            type: 'agent/create',
            definitionId: AgentDefinitionId(parsed.data.definitionId),
            name: parsed.data.name,
          }, signal))
        }
        case 'agent/depart':
        case 'agent/employ': {
          const parsed = agentPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          return success(await service.execute(parsed.data.expectedRevision, { type: endpoint, agentId: AgentId(parsed.data.agentId) }, signal))
        }
        case 'room/create': {
          const parsed = createRoomPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          return success(await service.execute(parsed.data.expectedRevision, {
            type: 'room/create',
            kind: parsed.data.kind,
            ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
          }, signal))
        }
        case 'room/direct/open': {
          const parsed = agentPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          signal.throwIfAborted()
          return success(await service.openDirectRoom(parsed.data.expectedRevision, AgentId(parsed.data.agentId), signal))
        }
        case 'room/join': {
          const parsed = joinRoomPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          return success(await service.execute(parsed.data.expectedRevision, {
            type: 'room/join',
            roomId: RoomId(parsed.data.roomId),
            agentId: AgentId(parsed.data.agentId),
            memoryStart: parsed.data.memoryStart,
          }, signal))
        }
        case 'room/leave': {
          const parsed = leaveRoomPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          return success(await service.execute(parsed.data.expectedRevision, { type: 'room/leave', membershipId: MembershipId(parsed.data.membershipId) }, signal))
        }
        case 'room/post': {
          const parsed = postRoomPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          signal.throwIfAborted()
          const state = await service.postHumanMessage(
            parsed.data.expectedRevision,
            RoomId(parsed.data.roomId),
            WEB_WORKSPACE_HUMAN_ID,
            parsed.data.text,
            parsed.data.mentions.map(AgentId),
            signal,
          )
          return success(state)
        }
        case 'task/assign': {
          const parsed = taskAssignPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          return success(await service.assignTask(
            parsed.data.expectedRevision,
            WEB_WORKSPACE_HUMAN_ID,
            AgentId(parsed.data.assigneeAgentId),
            parsed.data.title,
            signal,
          ))
        }
        case 'task/grant': {
          const parsed = taskGrantPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          return success(await service.grantTaskDelegation(
            parsed.data.expectedRevision,
            WEB_WORKSPACE_HUMAN_ID,
            AgentId(parsed.data.granteeAgentId),
            TaskId(parsed.data.rootTaskId),
            signal,
          ))
        }
        case 'task/revoke': {
          const parsed = taskRevokePayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          return success(await service.revokeTaskDelegation(
            parsed.data.expectedRevision,
            WEB_WORKSPACE_HUMAN_ID,
            DelegationGrantId(parsed.data.delegationGrantId),
            signal,
          ))
        }
        case 'task/cancel': {
          const parsed = taskPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          return success(await service.cancelTask(
            parsed.data.expectedRevision,
            WEB_WORKSPACE_HUMAN_ID,
            TaskId(parsed.data.taskId),
            signal,
          ))
        }
        case 'task/retry-delivery': {
          const parsed = taskPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          return success(await service.retryTaskDelivery(parsed.data.expectedRevision, TaskId(parsed.data.taskId), signal))
        }
        case 'memory/query': {
          const parsed = memoryQueryPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          const { agentId, sourceId, ...fields } = parsed.data
          const query: MemoryQuery = {
            ...fields,
            agentId: AgentId(agentId),
            ...(sourceId === undefined ? {} : { sourceId: sourceId as MemoryQuery['sourceId'] }),
          }
          return success(service.queryMemory(query))
        }
        case 'definition/history': {
          const parsed = definitionHistoryPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          return success(service.definitionHistory(AgentDefinitionId(parsed.data.definitionId)))
        }
        case 'runtime/activity/stop': {
          const parsed = activityIdentityPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          return success(await service.stopActivity(parsed.data.expectedRevision, {
            activityId: WorkspaceActivityId(parsed.data.activityId),
            agentId: AgentId(parsed.data.agentId),
            messageId: MessageId(parsed.data.messageId),
            sessionId: SessionId(parsed.data.sessionId),
            turn: parsed.data.turn,
          }, signal))
        }
        case 'runtime/child/stop': {
          const parsed = childPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          return success(await service.stopChildRun(parsed.data.expectedRevision, ChildRunId(parsed.data.childRunId), signal))
        }
        case 'runtime/failure/acknowledge': {
          const parsed = agentPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          return success(await service.acknowledgeAgentFailure(parsed.data.expectedRevision, AgentId(parsed.data.agentId), signal))
        }
        default:
          return invalid([], `unknown agent workspace endpoint '${endpoint}'`)
      }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return cancelled()
      if (isWorkspaceBusinessError(error)) return business(error)
      return internal()
    }
  }
}

function success(value: WorkspaceRpcValue): WorkspaceRpcResult {
  return { ok: true, value: structuredClone(value) }
}

function invalid(issues: readonly unknown[], message = 'invalid agent workspace request'): WorkspaceRpcResult {
  return { ok: false, error: { kind: 'bad-request', code: 'bad-request', message, details: { issues } } }
}

function cancelled(): WorkspaceRpcResult {
  return { ok: false, error: { kind: 'cancelled', code: 'cancelled', message: 'agent workspace request cancelled', details: {} } }
}

function business(error: AnyWorkspaceBusinessError): WorkspaceRpcResult {
  switch (error.code) {
    case 'reserved-direct-routing':
      return businessFor(error)
    case 'agent-missing':
      return businessFor(error)
    case 'agent-departed':
      return businessFor(error)
    case 'duplicate-membership':
      return businessFor(error)
    case 'stale-revision':
      return businessFor(error)
    case 'invalid-task-authority':
      return businessFor(error)
    case 'task-not-open':
      return businessFor(error)
    case 'task-not-assigned':
      return businessFor(error)
    case 'delegation-grant-missing':
      return businessFor(error)
    case 'delegation-grant-inactive':
      return businessFor(error)
    default:
      return assertNever(error)
  }
}

function businessFor<Code extends WorkspaceBusinessErrorCode>(
  error: WorkspaceBusinessError<Code>,
): { readonly ok: false; readonly error: WorkspaceRpcBusinessErrorFor<Code> } {
  return {
    ok: false,
    error: {
      kind: 'business',
      code: error.code,
      message: error.message,
      details: structuredClone(error.details),
    },
  }
}

function isWorkspaceBusinessError(error: unknown): error is AnyWorkspaceBusinessError {
  return error instanceof WorkspaceBusinessError
}

function internal(): WorkspaceRpcResult {
  return {
    ok: false,
    error: { kind: 'internal', code: 'internal', message: 'agent workspace request failed', details: {} },
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function assertNever(value: never): never {
  throw new Error(`unexpected agent workspace business error: ${String(value)}`)
}
