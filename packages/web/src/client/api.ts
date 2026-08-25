/** Browser adapter over this plugin's isolated Connection RPC channel. */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {
  AgentDefinitionId,
  AgentId,
  CreateDefinitionInput,
  MembershipId,
  ReviseDefinitionInput,
  RoomId,
  WorkspaceDirectRoomResult,
  WorkspaceRuntimeStatus,
  WorkspaceSnapshot,
  WorkspaceTurnBlock,
  WorkspaceTurnProjection,
  WorkspaceTurnStreamSnapshot,
} from './contracts.ts'

const CHANNEL = '/agent-workspace'

/** Narrow client used only by the Agent Workspace overlay. */
export class WorkspaceApiClient {
  constructor(private readonly connection: Pick<ConnectionHandle, 'rpc'>) {}

  snapshot(signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.callSnapshot('snapshot', {}, signal)
  }

  runtimeStatus(signal?: AbortSignal): Promise<WorkspaceRuntimeStatus> {
    return this.invoke('runtime/status', {}, signal).then(assertWorkspaceRuntimeStatus)
  }

  streamSnapshot(signal?: AbortSignal): Promise<WorkspaceTurnStreamSnapshot> {
    return this.invoke('stream/snapshot', {}, signal).then(assertWorkspaceTurnStreamSnapshot)
  }

  waitForStream(afterVersion: number, signal?: AbortSignal): Promise<WorkspaceTurnStreamSnapshot> {
    return this.invoke('stream/wait', { afterVersion }, signal).then(assertWorkspaceTurnStreamSnapshot)
  }

  createDefinition(input: CreateDefinitionInput, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.callSnapshot('definition/create', input, signal)
  }

  reviseDefinition(input: ReviseDefinitionInput, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.callSnapshot('definition/revise', input, signal)
  }

  createAgent(definitionId: AgentDefinitionId, name: string, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.callSnapshot('agent/create', { definitionId, name }, signal)
  }

  setEmployment(agentId: AgentId, employed: boolean, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.callSnapshot(employed ? 'agent/employ' : 'agent/depart', { agentId }, signal)
  }

  createGroup(name: string, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.callSnapshot('room/create', { kind: 'group', name }, signal)
  }

  async openDirect(agentId: AgentId, signal?: AbortSignal): Promise<WorkspaceDirectRoomResult> {
    const value = await this.invoke('room/direct/open', { agentId }, signal)
    if (!isRecord(value) || typeof value['roomId'] !== 'string') {
      throw new Error('Agent Workspace returned an invalid direct-room result')
    }
    return {
      snapshot: assertWorkspaceSnapshot(value['state']),
      roomId: value['roomId'],
    }
  }

  joinRoom(roomId: RoomId, agentId: AgentId, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.callSnapshot('room/join', { roomId, agentId, memoryStart: { type: 'new-events' } }, signal)
  }

  leaveRoom(membershipId: MembershipId, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.callSnapshot('room/leave', { membershipId }, signal)
  }

  postMessage(roomId: RoomId, text: string, mentions: readonly AgentId[], signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return this.callSnapshot('room/post', { roomId, text, mentions }, signal)
  }

  private async callSnapshot(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    return assertWorkspaceSnapshot(await this.invoke(endpoint, payload, signal))
  }

  private async invoke(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const result = await this.connection.rpc.call(CHANNEL, endpoint, payload, signal)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
}

function assertWorkspaceSnapshot(value: unknown): WorkspaceSnapshot {
  if (typeof value !== 'object' || value === null) throw new Error('Agent Workspace returned an invalid snapshot')
  const record = value as Record<string, unknown>
  if (typeof record['workspaceId'] !== 'string'
    || typeof record['revision'] !== 'number'
    || !isRecord(record['definitions'])
    || !isRecord(record['definitionRevisions'])
    || !isRecord(record['agents'])
    || !isRecord(record['rooms'])
    || !isRecord(record['memberships'])
    || !Array.isArray(record['events'])) {
    throw new Error('Agent Workspace returned an invalid snapshot')
  }
  return value as WorkspaceSnapshot
}

function assertWorkspaceRuntimeStatus(value: unknown): WorkspaceRuntimeStatus {
  if (!isRecord(value) || !isRecord(value['rooms'])) {
    throw new Error('Agent Workspace returned an invalid runtime status')
  }
  for (const room of Object.values(value['rooms'])) {
    if (!isRecord(room) || typeof room['pending'] !== 'number' || room['pending'] < 0
      || (room['error'] !== undefined && typeof room['error'] !== 'string')) {
      throw new Error('Agent Workspace returned an invalid runtime status')
    }
  }
  return value as unknown as WorkspaceRuntimeStatus
}

function assertWorkspaceTurnStreamSnapshot(value: unknown): WorkspaceTurnStreamSnapshot {
  if (!isRecord(value)
    || !isNonNegativeInteger(value['version'])
    || !isNonNegativeInteger(value['workspaceRevision'])
    || !Array.isArray(value['turns'])
    || !value['turns'].every(isWorkspaceTurnProjection)) {
    throw new Error('Agent Workspace returned an invalid turn stream')
  }
  return value as unknown as WorkspaceTurnStreamSnapshot
}

function isWorkspaceTurnProjection(value: unknown): value is WorkspaceTurnProjection {
  if (!isRecord(value)
    || typeof value['roomId'] !== 'string'
    || typeof value['agentId'] !== 'string'
    || typeof value['sessionId'] !== 'string'
    || !isNonNegativeInteger(value['turn'])
    || (value['status'] !== 'running' && value['status'] !== 'settled')
    || !Array.isArray(value['blocks'])
    || !value['blocks'].every(isWorkspaceTurnBlock)
    || (value['stopReason'] !== undefined && typeof value['stopReason'] !== 'string')
    || (value['error'] !== undefined && typeof value['error'] !== 'string')) {
    return false
  }
  return true
}

function isWorkspaceTurnBlock(value: unknown): value is WorkspaceTurnBlock {
  if (!isRecord(value) || !isNonNegativeInteger(value['index']) || typeof value['kind'] !== 'string') return false
  switch (value['kind']) {
    case 'text':
    case 'reasoning':
      return typeof value['text'] === 'string'
    case 'tool':
      return typeof value['callId'] === 'string'
        && typeof value['name'] === 'string'
        && typeof value['arguments'] === 'string'
        && (value['status'] === 'running' || value['status'] === 'completed' || value['status'] === 'failed')
        && (value['resultText'] === undefined || typeof value['resultText'] === 'string')
        && (value['error'] === undefined || typeof value['error'] === 'string')
    case 'unknown':
      return typeof value['label'] === 'string'
    default:
      return false
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
