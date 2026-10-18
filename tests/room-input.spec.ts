import { expect, test } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { EmployeeAgentPool } from '../packages/host/src/runtime.ts'
import { mutateWorkspace } from '../packages/host/src/state.ts'
import { workflowRuntime } from './workflow-test-support.ts'
import { WEB_WORKSPACE_HUMAN_ID } from '../packages/host/src/rpc.ts'
import { prepareMessageRecall } from '../packages/host/src/message-recall.ts'
import { assertCommunicationRelationships, getCommunicationInvalidation } from '../packages/host/src/communication.ts'
import { communicationStateSchema } from '../packages/host/src/communication-schema.ts'
import type { CommunicationInput, CommunicationInputId, ContextResetId } from '../packages/host/src/communication-contract.ts'

test('admits Alice’s room mention to Bob without assigning Bob authorship of Alice’s message', async () => {
  const f = await workflowRuntime()
  const alice = f.runtime.snapshot().agents[f.agentId]!
  const bob = mutateWorkspace(f.runtime.snapshot(), { type: 'agent/create', definitionId: alice.definitionId, name: 'Bob' })
  const room = mutateWorkspace(bob.state, { type: 'room/create', kind: 'group', name: 'Team' })
  const joinedAlice = mutateWorkspace(room.state, { type: 'room/join', roomId: room.roomId, agentId: alice.id, memoryStart: { type: 'new-events' } })
  const joinedBob = mutateWorkspace(joinedAlice.state, { type: 'room/join', roomId: room.roomId, agentId: bob.agentId, memoryStart: { type: 'new-events' } })
  const source = mutateWorkspace(joinedBob.state, { type: 'room/message', roomId: room.roomId, actor: { type: 'agent', id: alice.id }, text: 'Please ask Bob.', mentions: [bob.agentId] })
  await f.directory.updateAggregate(f.runtime.workspaceId, () => source.state)
  const pool = new EmployeeAgentPool({ create: async options => ({
    agent: { id: options.sessionId!, ctx: new Context(), session: Session.create(options.sessionId!), whenIdle: async () => {} } as Agent,
    dispose: async () => {},
  }), resume: async () => { throw new Error('Unexpected resume.') } }, f.runtime)
  Object.assign(f.runtime, { pool, trackers: new Map([[bob.agentId, {
    deliver: async () => ({ output: [], stopReason: { kind: 'completed' }, interrupted: false }),
  }]]) })
  try {
    const delivery = createUserMessage({ content: [{ type: 'text', text: 'Please ask Bob.' }], source: { kind: 'agent-workspace-delivery', workspaceId: f.runtime.workspaceId, source: { kind: 'room', roomId: room.roomId }, sourceEventId: source.eventId } })
    await f.runtime.deliver(bob.agentId, delivery, undefined, { kind: 'room', roomId: room.roomId })
    expect(Object.values(f.runtime.communicationSnapshot().communication.inputs)).toMatchObject([{
      agentId: bob.agentId, target: { kind: 'room-input', eventId: source.eventId }, directEventIds: [source.eventId],
    }])
  } finally { await pool.disposeAll() }
})

test('isolates an affected recipient input while retaining its independently authored earlier source', async () => {
  const f = await workflowRuntime()
  const alice = f.runtime.snapshot().agents[f.agentId]!
  const bob = mutateWorkspace(f.runtime.snapshot(), { type: 'agent/create', definitionId: alice.definitionId, name: 'Bob' })
  const room = mutateWorkspace(bob.state, { type: 'room/create', kind: 'group', name: 'Team' })
  const earlier = mutateWorkspace(room.state, { type: 'room/message', roomId: room.roomId, actor: { type: 'agent', id: alice.id }, text: 'Earlier independent reply.', mentions: [bob.agentId] })
  const withdrawn = mutateWorkspace(earlier.state, { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: WEB_WORKSPACE_HUMAN_ID }, text: 'WITHDRAWN_ROOM_INPUT', mentions: [] })
  await f.directory.updateAggregate(f.runtime.workspaceId, () => withdrawn.state)
  const record = f.directory.record(f.runtime.workspaceId)
  const input: CommunicationInput = { id: 'bob-room' as CommunicationInputId, agentId: bob.agentId, contextGeneration: 0, recordedAtSequence: withdrawn.state.nextSequence - 1,
    target: { kind: 'room-input', eventId: earlier.eventId }, directEventIds: [earlier.eventId], recalledEventIds: [withdrawn.eventId], sessionEventIds: [] }
  const communication = { ...record.communication, inputs: { [input.id]: input } }
  expect(communicationStateSchema.safeParse(communication).success).toBe(true)
  assertCommunicationRelationships(record.aggregate, communication, record.workflow)
  const prepared = prepareMessageRecall({ ...record, communication }, { operationId: 'recall' as ContextResetId, roomId: room.roomId, eventId: withdrawn.eventId, humanId: WEB_WORKSPACE_HUMAN_ID, requestedAt: '2026-10-13T00:00:00.000Z', restoreFiles: false })
  const invalid = getCommunicationInvalidation(prepared.aggregate, prepared.communication)
  expect(invalid.inputIds.has(input.id)).toBe(true)
  expect(invalid.eventIds.has(earlier.eventId)).toBe(false)
  expect(invalid.eventIds.has(withdrawn.eventId)).toBe(true)
  expect(() => assertCommunicationRelationships(record.aggregate, { ...communication, inputs: { [input.id]: { ...input, directEventIds: [] } } }, record.workflow)).toThrow('direct source')
  expect(() => assertCommunicationRelationships(record.aggregate, { ...communication, inputs: { [input.id]: { ...input, target: { kind: 'event', eventId: earlier.eventId } } } }, record.workflow)).toThrow('author or generation')
})
