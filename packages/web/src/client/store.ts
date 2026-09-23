/** Shared root-scoped UI state for the footer entry and workspace overlay. */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceApiError } from './api.ts'
import type { AgentDefinitionId, RoomId, WorkspaceActivityId, WorkspaceSnapshot } from './contracts.ts'
import { selectNewerWorkspaceSnapshot } from './task-view-model.ts'

export type WorkspaceViewMode = 'conversations' | 'colleagues' | 'tasks' | 'memory'

export interface WorkspaceUiState {
  open: boolean
  mode: WorkspaceViewMode
  selectedRoomId?: RoomId
  selectedDefinitionId?: AgentDefinitionId
  activityDrawerOpen?: boolean
  selectedActivityId?: WorkspaceActivityId
  snapshot?: WorkspaceSnapshot
  busy: boolean
  error?: WorkspaceUiError
  retry?: WorkspaceRetryState
}

/** A stale write is retained for an explicit user retry after refresh. */
export interface WorkspaceRetryState { readonly stale: true; readonly refreshed: boolean }

/** Display-safe failure retained until the locale-owning overlay renders it. */
export type WorkspaceUiError = WorkspaceApiError | { readonly kind: 'unexpected' }

type WorkspaceUiActions = {
  open: (draft: WorkspaceUiState) => void
  close: (draft: WorkspaceUiState) => void
  setMode: (draft: WorkspaceUiState, mode: WorkspaceViewMode) => void
  selectRoom: (draft: WorkspaceUiState, roomId: RoomId | undefined) => void
  selectDefinition: (draft: WorkspaceUiState, definitionId: AgentDefinitionId | undefined) => void
  openActivityDrawer: (draft: WorkspaceUiState, activityId?: WorkspaceActivityId | undefined) => void
  closeActivityDrawer: (draft: WorkspaceUiState) => void
  selectActivity: (draft: WorkspaceUiState, activityId: WorkspaceActivityId | undefined) => void
  setSnapshot: (draft: WorkspaceUiState, snapshot: WorkspaceSnapshot) => void
  setBusy: (draft: WorkspaceUiState, busy: boolean) => void
  setError: (draft: WorkspaceUiState, error: WorkspaceUiError | undefined) => void
  setRetry: (draft: WorkspaceUiState, retry: WorkspaceRetryState | undefined) => void
}

/** One handle is created inside apply and shared by the two additive slot entries. */
export function createWorkspaceUiStore(): EngineStoreHandle<WorkspaceUiState, WorkspaceUiActions> {
  return defineStore({
    init: (): WorkspaceUiState => ({ open: false, mode: 'conversations', busy: false }),
    actions: {
      open: draft => { draft.open = true },
      close: draft => { draft.open = false },
      setMode: (draft, mode) => { draft.mode = mode },
      selectRoom: (draft, roomId) => {
        if (roomId === undefined) delete draft.selectedRoomId
        else draft.selectedRoomId = roomId
      },
      selectDefinition: (draft, definitionId) => {
        if (definitionId === undefined) delete draft.selectedDefinitionId
        else draft.selectedDefinitionId = definitionId
      },
      openActivityDrawer: (draft, activityId) => {
        draft.activityDrawerOpen = true
        if (activityId !== undefined) draft.selectedActivityId = activityId
      },
      closeActivityDrawer: draft => { draft.activityDrawerOpen = false },
      selectActivity: (draft, activityId) => {
        if (activityId === undefined) delete draft.selectedActivityId
        else draft.selectedActivityId = activityId
      },
      setSnapshot: (draft, snapshot) => {
        const selected = selectNewerWorkspaceSnapshot(draft.snapshot, snapshot)
        if (selected !== draft.snapshot) draft.snapshot = structuredClone(selected)
      },
      setBusy: (draft, busy) => { draft.busy = busy },
      setError: (draft, error) => {
        if (error === undefined) delete draft.error
        else draft.error = error
      },
      setRetry: (draft, retry) => {
        if (retry === undefined) delete draft.retry
        else draft.retry = retry
      },
    },
  })
}
