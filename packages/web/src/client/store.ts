/** Shared root-scoped UI state for the footer entry and workspace overlay. */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { AgentDefinitionId, RoomId, WorkspaceSnapshot } from './contracts.ts'

export type WorkspaceViewMode = 'chat' | 'agents'

export interface WorkspaceUiState {
  open: boolean
  mode: WorkspaceViewMode
  selectedRoomId?: RoomId
  selectedDefinitionId?: AgentDefinitionId
  snapshot?: WorkspaceSnapshot
  busy: boolean
  error?: string
}

type WorkspaceUiActions = {
  open: (draft: WorkspaceUiState) => void
  close: (draft: WorkspaceUiState) => void
  setMode: (draft: WorkspaceUiState, mode: WorkspaceViewMode) => void
  selectRoom: (draft: WorkspaceUiState, roomId: RoomId | undefined) => void
  selectDefinition: (draft: WorkspaceUiState, definitionId: AgentDefinitionId | undefined) => void
  setSnapshot: (draft: WorkspaceUiState, snapshot: WorkspaceSnapshot) => void
  setBusy: (draft: WorkspaceUiState, busy: boolean) => void
  setError: (draft: WorkspaceUiState, error: string | undefined) => void
}

/** One handle is created inside apply and shared by the two additive slot entries. */
export function createWorkspaceUiStore(): EngineStoreHandle<WorkspaceUiState, WorkspaceUiActions> {
  return defineStore({
    init: (): WorkspaceUiState => ({ open: false, mode: 'chat', busy: false }),
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
      setSnapshot: (draft, snapshot) => { draft.snapshot = snapshot },
      setBusy: (draft, busy) => { draft.busy = busy },
      setError: (draft, error) => {
        if (error === undefined) delete draft.error
        else draft.error = error
      },
    },
  })
}
