/** Plugin-owned RPC contract for the browser workspace UI. */

import { z } from 'zod'
import {
  AgentDefinitionId,
  AgentId,
  DefinitionRevisionId,
  HumanId,
  MembershipId,
  RoomId,
} from './ids.ts'
import type { WorkspaceTurnStreamSnapshot } from './turn-stream.ts'
import type { WorkspaceCommand, WorkspaceState } from './types.ts'

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

/** Minimal service face required by the transport adapter. */
export interface WorkspaceRpcService {
  snapshot(): WorkspaceState
  runtimeStatus(): WorkspaceRuntimeStatus
  turnStreamSnapshot(): WorkspaceTurnStreamSnapshot
  waitForTurnStream(afterVersion: number, signal: AbortSignal): Promise<WorkspaceTurnStreamSnapshot>
  execute(command: WorkspaceCommand): Promise<WorkspaceState>
  openDirectRoom(agentId: AgentId): Promise<WorkspaceDirectRoomResult>
  postHumanMessage(roomId: RoomId, humanId: HumanId, text: string, mentions: readonly AgentId[]): Promise<WorkspaceState>
}

export type WorkspaceRpcValue = WorkspaceState | WorkspaceRuntimeStatus | WorkspaceDirectRoomResult | WorkspaceTurnStreamSnapshot

/** Connection-compatible result subset used by this plugin. */
export type WorkspaceRpcResult =
  | { readonly ok: true; readonly value: WorkspaceRpcValue }
  | {
    readonly ok: false
    readonly error:
      | { readonly code: 'bad-request'; readonly message: string; readonly details: { readonly issues: readonly unknown[] } }
      | { readonly code: 'cancelled'; readonly message: string; readonly details: Record<string, never> }
      | { readonly code: 'internal'; readonly message: string; readonly details: Record<string, never> }
  }

/** Structural Connection handler shape so the Host remains usable without the web stack. */
export type WorkspaceRpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<WorkspaceRpcResult>

const id = z.string().trim().min(1)
const text = z.string().trim().min(1)
const emptyPayload = z.object({}).strict()
const streamWaitPayload = z.object({ afterVersion: z.number().int().nonnegative() }).strict()
const createDefinitionPayload = z.object({
  name: text,
  description: z.string(),
  instructions: z.string(),
}).strict()
const reviseDefinitionPayload = z.object({
  definitionId: id,
  description: z.string(),
  instructions: z.string(),
  synchronizeAgentIds: z.array(id).optional(),
}).strict()
const synchronizeDefinitionPayload = z.object({
  definitionId: id,
  definitionRevisionId: id,
  agentIds: z.array(id).min(1),
}).strict()
const createAgentPayload = z.object({ definitionId: id, name: text }).strict()
const agentPayload = z.object({ agentId: id }).strict()
const createRoomPayload = z.object({
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
const joinRoomPayload = z.object({ roomId: id, agentId: id, memoryStart: membershipMemoryStart.optional() }).strict()
const leaveRoomPayload = z.object({ membershipId: id }).strict()
const postRoomPayload = z.object({ roomId: id, text, mentions: z.array(id) }).strict()

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
          return success(service.turnStreamSnapshot())
        }
        case 'stream/wait': {
          const parsed = streamWaitPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          signal.throwIfAborted()
          return success(await service.waitForTurnStream(parsed.data.afterVersion, signal))
        }
        case 'definition/create': {
          const parsed = createDefinitionPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          return success(await service.execute({ type: 'definition/create', ...parsed.data }))
        }
        case 'definition/revise': {
          const parsed = reviseDefinitionPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          return success(await service.execute({
            type: 'definition/revise',
            definitionId: AgentDefinitionId(parsed.data.definitionId),
            description: parsed.data.description,
            instructions: parsed.data.instructions,
            ...(parsed.data.synchronizeAgentIds === undefined
              ? {}
              : { synchronizeAgentIds: parsed.data.synchronizeAgentIds.map(AgentId) }),
          }))
        }
        case 'definition/synchronize': {
          const parsed = synchronizeDefinitionPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          return success(await service.execute({
            type: 'definition/synchronize',
            definitionId: AgentDefinitionId(parsed.data.definitionId),
            definitionRevisionId: DefinitionRevisionId(parsed.data.definitionRevisionId),
            agentIds: parsed.data.agentIds.map(AgentId),
          }))
        }
        case 'agent/create': {
          const parsed = createAgentPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          return success(await service.execute({
            type: 'agent/create',
            definitionId: AgentDefinitionId(parsed.data.definitionId),
            name: parsed.data.name,
          }))
        }
        case 'agent/depart':
        case 'agent/employ': {
          const parsed = agentPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          return success(await service.execute({ type: endpoint, agentId: AgentId(parsed.data.agentId) }))
        }
        case 'room/create': {
          const parsed = createRoomPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          return success(await service.execute({
            type: 'room/create',
            kind: parsed.data.kind,
            ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
          }))
        }
        case 'room/direct/open': {
          const parsed = agentPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          signal.throwIfAborted()
          return success(await service.openDirectRoom(AgentId(parsed.data.agentId)))
        }
        case 'room/join': {
          const parsed = joinRoomPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          return success(await service.execute({
            type: 'room/join',
            roomId: RoomId(parsed.data.roomId),
            agentId: AgentId(parsed.data.agentId),
            memoryStart: parsed.data.memoryStart ?? { type: 'new-events' },
          }))
        }
        case 'room/leave': {
          const parsed = leaveRoomPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          return success(await service.execute({ type: 'room/leave', membershipId: MembershipId(parsed.data.membershipId) }))
        }
        case 'room/post': {
          const parsed = postRoomPayload.safeParse(payload)
          if (!parsed.success) return invalid(parsed.error.issues)
          signal.throwIfAborted()
          const state = await service.postHumanMessage(
            RoomId(parsed.data.roomId),
            WEB_WORKSPACE_HUMAN_ID,
            parsed.data.text,
            parsed.data.mentions.map(AgentId),
          )
          return success(state)
        }
        default:
          return invalid([], `unknown agent workspace endpoint '${endpoint}'`)
      }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return cancelled()
      return {
        ok: false,
        error: {
          code: 'bad-request',
          message: error instanceof Error ? error.message : String(error),
          details: { issues: [] },
        },
      }
    }
  }
}

function success(value: WorkspaceRpcValue): WorkspaceRpcResult {
  return { ok: true, value: structuredClone(value) }
}

function invalid(issues: readonly unknown[], message = 'invalid agent workspace request'): WorkspaceRpcResult {
  return { ok: false, error: { code: 'bad-request', message, details: { issues } } }
}

function cancelled(): WorkspaceRpcResult {
  return { ok: false, error: { code: 'cancelled', message: 'agent workspace request cancelled', details: {} } }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
