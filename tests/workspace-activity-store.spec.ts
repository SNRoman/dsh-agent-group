import { describe, expect, it } from 'vitest'
import { createWorkspaceUiStore, type WorkspaceUiState } from '../packages/web/src/client/store.ts'

describe('workspace activity drawer store', () => {
  it('owns drawer visibility and durable-id selection across snapshot replacement', () => {
    const handle = createWorkspaceUiStore() as unknown as {
      readonly definition: {
        readonly init: () => WorkspaceUiState
        readonly actions: Record<string, (draft: WorkspaceUiState, value?: unknown) => void>
      }
    }
    const state = handle.definition.init()
    handle.definition.actions.openActivityDrawer!(state, 'activity-1')
    expect(state).toMatchObject({ activityDrawerOpen: true, selectedActivityId: 'activity-1' })
    handle.definition.actions.closeActivityDrawer!(state)
    expect(state.activityDrawerOpen).toBe(false)
    expect(state.selectedActivityId).toBe('activity-1')
    handle.definition.actions.openActivityDrawer!(state)
    expect(state).toMatchObject({ activityDrawerOpen: true, selectedActivityId: 'activity-1' })
  })
})
