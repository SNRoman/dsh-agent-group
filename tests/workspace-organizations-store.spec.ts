import { describe, expect, it } from 'vitest'
import { createWorkspaceUiStore, type WorkspaceUiState } from '../packages/web/src/client/store.ts'
import type { WorkspaceSnapshot } from '../packages/web/src/client/contracts.ts'

function snapshot(workspaceId: string, revision: number): WorkspaceSnapshot {
  return { workspaceId, revision, nextId: 1, nextSequence: 1, definitions: {}, definitionRevisions: {}, agents: {}, rooms: {}, memberships: {}, events: [], memoryEntries: [], tasks: {}, taskAssignments: {}, delegationGrants: {}, childRuns: {}, sessionBindings: {} }
}
function fixture() {
  const handle = createWorkspaceUiStore() as { definition: { init(): WorkspaceUiState; actions: Record<string, (draft: WorkspaceUiState, value?: never) => void> } }
  return { state: handle.definition.init(), actions: handle.definition.actions }
}
describe('organization UI store', () => {
  it('resets entity selections, snapshots, runtime selection and retry on an organization switch', () => {
    const { state, actions } = fixture()
    expect(actions['selectWorkspace']).toBeTypeOf('function')
    actions['selectWorkspace']!(state, 'alpha' as never)
    actions['setSnapshot']!(state, snapshot('alpha', 100) as never)
    state.selectedRoomId = 'same-room'; state.selectedDefinitionId = 'same-definition'; state.selectedAgentId = 'same-person'; state.activityDrawerOpen = true; state.selectedActivityId = 'same-activity'; state.retry = { stale: true, refreshed: true }; state.busy = true; state.error = { kind: 'unexpected' }
    actions['selectWorkspace']!(state, 'beta' as never)
    expect(state).toEqual({ open: false, mode: 'conversations', busy: false, selectedWorkspaceId: 'beta' })
    actions['setSnapshot']!(state, snapshot('beta', 1) as never)
    actions['setSnapshot']!(state, snapshot('alpha', 101) as never)
    expect(state.snapshot).toEqual(snapshot('beta', 1))
  })
})
