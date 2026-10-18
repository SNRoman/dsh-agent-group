import { expect, it } from 'vitest'
import { WorkspaceApiClient } from '../packages/web/src/client/api.ts'
import { WorkspaceCommunicationApi } from '../packages/web/src/client/communication-api.ts'

const roomMemoryReset = {
  id: 'forget-1', kind: 'room-memory-forget', membershipId: 'membership-1',
  source: { roomId: 'group-1', eventId: 'member-left-1' }, requestedByHumanId: 'web-user',
  fromSequence: 5, throughSequence: 5, affectedAgentIds: ['agent-1'], previousGenerations: { 'agent-1': 0 },
  forgottenEventIds: ['group-message-1'], invalidatedEventIds: [], invalidatedTaskIds: [],
  invalidatedDraftIds: [], invalidatedTemplateRevisionIds: [], invalidatedArtifactIds: [],
  requestedAt: '2026-10-17T12:00:00.000Z', fileRestoreRequested: false, status: 'pending',
}

function snapshotWithReset(reset: unknown) {
  return { workspaceId: 'local', aggregateRevision: 5, workflowRevision: 0,
    communication: { revision: 1, nextCheckpointOrder: 1, messages: {}, taskSources: {}, draftSources: {},
      inputs: {}, contexts: { 'agent-1': { generation: 1, blockedBy: 'forget-1' } },
      resets: { 'forget-1': reset }, fileCheckpoints: {}, operations: {} },
  }
}

it('reads communication inputs with durable delivery attribution', async () => {
  const value = {
    workspaceId: 'local', aggregateRevision: 5, workflowRevision: 0,
    communication: {
      revision: 1, nextCheckpointOrder: 1, messages: {}, taskSources: {}, draftSources: {},
      inputs: {
        input: {
          id: 'input', target: { kind: 'room-input', eventId: 'event' }, deliveryMessageId: 'message',
          taskDeliveryAttemptId: 'attempt', agentId: 'agent', contextGeneration: 0,
          recordedAtSequence: 5, directEventIds: ['event'], recalledEventIds: [], sessionEventIds: [],
        },
      },
      contexts: {}, resets: {}, fileCheckpoints: {}, operations: {},
    },
  }
  const api = new WorkspaceApiClient({ rpc: { call: async () => ({ ok: true, value }) } } as never).forWorkspace('local')

  await expect(new WorkspaceCommunicationApi(api).snapshot()).resolves.toEqual(value)
})

it.each(['pending', 'failed'] as const)('reads %s group memory cleanup with its membership and stable retry identity', async status => {
  const reset = { ...roomMemoryReset, ...(status === 'failed' ? { status, error: 'context-reset-cleanup-failed' } : { status }) }
  const value = snapshotWithReset(reset)
  const api = new WorkspaceApiClient({ rpc: { call: async () => ({ ok: true, value }) } } as never).forWorkspace('local')

  await expect(new WorkspaceCommunicationApi(api).snapshot()).resolves.toEqual(value)
})

it.each([
  ['file recovery consent', { ...roomMemoryReset, fileRestoreRequested: true }],
  ['an unknown reset kind', { ...roomMemoryReset, kind: 'unknown-reset' }],
  ['a missing membership', Object.fromEntries(Object.entries(roomMemoryReset).filter(([key]) => key !== 'membershipId'))],
] as const)('rejects group memory cleanup with %s', async (_label, reset) => {
  const value = snapshotWithReset(reset)
  const api = new WorkspaceApiClient({ rpc: { call: async () => ({ ok: true, value }) } } as never).forWorkspace('local')

  await expect(new WorkspaceCommunicationApi(api).snapshot()).rejects.toMatchObject({ name: 'ZodError' })
})
