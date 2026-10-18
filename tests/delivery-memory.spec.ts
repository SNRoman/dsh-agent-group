import { describe, expect, test } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createDeliveryMemory } from '../packages/host/src/delivery-memory.ts'
import AgentWorkspaceDomainService from '../packages/host/src/index.ts'
import { HumanId, WorkspaceId } from '../packages/host/src/ids.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'

function fixture() {
  const definition = mutateWorkspace(createInitialState(WorkspaceId('local')), {
    type: 'definition/create', name: 'Engineer', description: '', instructions: '',
  })
  const employee = mutateWorkspace(definition.state, { type: 'agent/create', definitionId: definition.definitionId, name: 'Alice' })
  const room = mutateWorkspace(employee.state, { type: 'room/create', kind: 'group', name: 'Requirements' })
  const joined = mutateWorkspace(room.state, { type: 'room/join', roomId: room.roomId, agentId: employee.agentId, memoryStart: { type: 'new-events' } })
  const state = mutateWorkspace(joined.state, {
    type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: HumanId('owner') },
    text: 'EXPORT requirement: use UTF-8 and do not include credentials.', mentions: [],
  }).state
  return { state, agentId: employee.agentId }
}

describe('formal delivery personal memory', () => {
  test('resolves bounded memory settings and rejects invalid limits at plugin load', () => {
    expect(AgentWorkspaceDomainService.Config({})).toMatchObject({ memoryCharacterBudget: 4000, memorySearchResultLimit: 10 })
    for (const value of [0, -1, 1.5]) {
      expect(() => AgentWorkspaceDomainService.Config({ memoryCharacterBudget: value })).toThrow()
      expect(() => AgentWorkspaceDomainService.Config({ memorySearchResultLimit: value })).toThrow()
    }
  })
  test('recalls acquired silent room history after a persisted-state reload', () => {
    const { state, agentId } = fixture()
    const delivery = createUserMessage({ content: [{ type: 'text', text: 'Implement EXPORT requirement' }] })
    const recall = createDeliveryMemory(structuredClone(state), agentId, delivery, 4000)
    expect(recall?.source).toMatchObject({ kind: 'agent-workspace-recall', eventIds: expect.arrayContaining([state.events.at(-1)!.id]) })
    expect(JSON.stringify(recall?.content)).toContain('UTF-8')
    expect(JSON.stringify(recall?.content)).toContain('room-membership')
    expect(JSON.stringify(recall?.content)).toContain(state.events.at(-1)!.id)
  })

  test('does not supply inaccessible events or mutate recorded history', () => {
    const { state, agentId } = fixture()
    const original = structuredClone(state)
    const delivery = createUserMessage({ content: [{ type: 'text', text: 'EXPORT' }] })
    expect(createDeliveryMemory({ ...state, memoryEntries: [] }, agentId, delivery, 4000)).toBeUndefined()
    createDeliveryMemory(state, agentId, delivery, 100)
    expect(state).toEqual(original)
  })
})
