/** Additive Agent Workspace Browser surfaces. */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { WorkspaceApiError } from './api.ts'
import type { WorkspaceApiClient } from './api.ts'
import type {
  AgentDefinitionId,
  AgentId,
  DefinitionRevisionId,
  MembershipMemoryStart,
  MembershipId,
  RoomId,
  WorkspaceSnapshot,
  WorkspaceActivitySnapshot,
  WorkspaceTurnProjection,
  WorkspaceTurnBlock,
  WorkspaceTurnStreamSnapshot,
} from './contracts.ts'
import type { createWorkspaceUiStore, WorkspaceUiError } from './store.ts'
import { WorkspaceLiveTurn, WorkspaceMarkdownMessage } from './WorkspaceTurn.tsx'
import { WorkspaceTasks } from './WorkspaceTasks.tsx'
import { WorkspaceMemory } from './WorkspaceMemory.tsx'
import { WorkspaceDefinitionHistory } from './WorkspaceDefinitionHistory.tsx'
import { selectNewerActivitySnapshot } from './task-view-model.ts'
import { projectWorkspaceActivity } from './activity-view-model.ts'
import type { WorkspaceActivityProjection } from './activity-view-model.ts'
import { WorkspaceActivityBadges, WorkspaceActivityDrawer, WorkspaceAgentRuntimeBadges, WorkspaceRuntimeBadge } from './WorkspaceActivityDrawer.tsx'
import {
  activeRoomMembers,
  actorLabel,
  appendDisplayMention,
  formatMessageText,
  parseRoomMentionIds,
  roomLabel,
  roomMessageEvents,
} from './view-model.ts'

type WorkspaceStoreProps = PropsStore<ReturnType<typeof createWorkspaceUiStore>>

export type WorkspaceFooterActionProps = PropsRuntime<'sidebar.footer.action'> & WorkspaceStoreProps & PropsLocale<'agentWorkspace'>
export type WorkspaceOverlayProps = PropsRuntime<'shell.overlay'> & WorkspaceStoreProps & PropsLocale<'agentWorkspace'> & { readonly api: WorkspaceApiClient }

const EMPTY_TURN_STREAM: WorkspaceTurnStreamSnapshot = { version: 0, workspaceRevision: 0, turns: [] }
const EMPTY_ACTIVITY: WorkspaceActivitySnapshot = { version: 0, workspaceRevision: 0, activities: [], agents: [] }
type MutationOperation = (expectedRevision: number) => Promise<WorkspaceSnapshot>
type PendingMutation = { readonly kind: 'operation'; readonly operation: MutationOperation }

/** Additive sidebar footer action. It owns no DSH navigation state. */
export function WorkspaceFooterAction({ wide, actions, t }: WorkspaceFooterActionProps) {
  return (
    <button
      type="button"
      className="dsh-agent-group-footer-button"
      data-wide={wide ? 'true' : 'false'}
      onClick={() => actions.open()}
      title={t('workspace.title')}
      aria-label={t('workspace.open')}
    >
      <WorkspaceIcon />
      {wide ? <span>{t('workspace.title')}</span> : null}
    </button>
  )
}

/** Full workbench rendered only while the plugin-local open flag is true. */
export function WorkspaceOverlay({ useStore, actions, api, t }: WorkspaceOverlayProps) {
  const ui = useStore(state => state)
  const [creatingRoom, setCreatingRoom] = useState(false)
  const [roomName, setRoomName] = useState('')
  const [draft, setDraft] = useState('')
  const [creatingDefinition, setCreatingDefinition] = useState(false)
  const [definitionName, setDefinitionName] = useState('')
  const [definitionDescription, setDefinitionDescription] = useState('')
  const [definitionInstructions, setDefinitionInstructions] = useState('')
  const [agentName, setAgentName] = useState('')
  const [revisionDescription, setRevisionDescription] = useState('')
  const [revisionInstructions, setRevisionInstructions] = useState('')
  const [revisionDraftDefinitionId, setRevisionDraftDefinitionId] = useState<AgentDefinitionId | undefined>()
  const [revisionDraftRevisionId, setRevisionDraftRevisionId] = useState<DefinitionRevisionId | undefined>()
  const [revisionDraftDirty, setRevisionDraftDirty] = useState(false)
  const [revisionDraftReserved, setRevisionDraftReserved] = useState(false)
  const [turnStream, setTurnStream] = useState<WorkspaceTurnStreamSnapshot>(EMPTY_TURN_STREAM)
  const [activitySnapshot, setActivitySnapshot] = useState<WorkspaceActivitySnapshot>(EMPTY_ACTIVITY)
  const [streamError, setStreamError] = useState<WorkspaceUiError | undefined>()
  const [pendingMutation, setPendingMutation] = useState<PendingMutation | undefined>()
  const [reconnectAttempt, setReconnectAttempt] = useState(0)
  const activityTriggerRef = useRef<HTMLButtonElement>(null)
  const activityVersionRef = useRef(0)
  const refreshControllerRef = useRef<AbortController>()
  const refreshGenerationRef = useRef(0)

  const adoptActivity = useMemo(() => (next: WorkspaceActivitySnapshot): void => {
    if (next.version < activityVersionRef.current) return
    activityVersionRef.current = next.version
    setTurnStream(current => next.version < current.version ? current : activityTurnStream(next))
    setActivitySnapshot(current => selectNewerActivitySnapshot(current, next))
  }, [])

  const cancelRefresh = useMemo(() => (): void => {
    refreshGenerationRef.current += 1
    refreshControllerRef.current?.abort()
    refreshControllerRef.current = undefined
  }, [])

  const refreshWorkspace = useMemo(() => async (): Promise<void> => {
    cancelRefresh()
    const controller = new AbortController()
    const generation = refreshGenerationRef.current
    refreshControllerRef.current = controller
    const live = (): boolean => !controller.signal.aborted
      && refreshControllerRef.current === controller
      && refreshGenerationRef.current === generation
    actions.setBusy(true)
    actions.setError(undefined)
    try {
      const [nextSnapshot, nextActivity] = await Promise.all([
        api.snapshot(controller.signal),
        api.activitySnapshot(controller.signal),
      ])
      if (!live()) return
      actions.setSnapshot(nextSnapshot)
      adoptActivity(nextActivity)
    } catch (error) {
      if (live()) actions.setError(toUiError(error))
    } finally {
      if (live()) {
        refreshControllerRef.current = undefined
        actions.setBusy(false)
      }
    }
  }, [actions, adoptActivity, api, cancelRefresh])

  const closeWorkspace = useMemo(() => (): void => {
    cancelRefresh()
    actions.close()
  }, [actions, cancelRefresh])

  // One cancellation-aware long-poll subscription replaces the former timer
  // polling. Stream versions wake the Browser only when authoritative Session
  // output or the durable workspace revision actually changes.
  useEffect(() => {
    if (!ui.open) {
      cancelRefresh()
      setTurnStream(EMPTY_TURN_STREAM)
      setActivitySnapshot(EMPTY_ACTIVITY)
      activityVersionRef.current = 0
      setStreamError(undefined)
      return
    }
    const controller = new AbortController()
    const subscribe = async (): Promise<void> => {
      actions.setBusy(true)
      actions.setError(undefined)
      try {
        let [initialSnapshot, initialStream] = await Promise.all([
          api.snapshot(controller.signal),
          api.activitySnapshot(controller.signal),
        ])
        if (controller.signal.aborted) return
        if (initialStream.workspaceRevision > initialSnapshot.revision) {
          initialSnapshot = await api.snapshot(controller.signal)
          if (controller.signal.aborted) return
        }
        actions.setSnapshot(initialSnapshot)
        adoptActivity(initialStream)
        setStreamError(undefined)
        actions.setBusy(false)

        let durableRevision = initialSnapshot.revision
        while (!controller.signal.aborted) {
          const requestedVersion = activityVersionRef.current
          const next = await api.waitForActivity(requestedVersion, controller.signal)
          if (controller.signal.aborted) return
          if (next.version <= requestedVersion) {
            if (next.version === requestedVersion) adoptActivity(next)
            setStreamError({ kind: 'unexpected' })
            return
          }
          if (next.version < activityVersionRef.current) continue
          adoptActivity(next)
          setStreamError(undefined)
          if (next.workspaceRevision > durableRevision) {
            const durable = await api.snapshot(controller.signal)
            if (controller.signal.aborted) return
            durableRevision = durable.revision
            actions.setSnapshot(durable)
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setStreamError(toUiError(error))
        }
      } finally {
        if (!controller.signal.aborted) actions.setBusy(false)
      }
    }
    void subscribe()
    return () => {
      controller.abort()
      cancelRefresh()
    }
  }, [ui.open, api, actions, reconnectAttempt, adoptActivity, cancelRefresh])

  useEffect(() => {
    if (!ui.open) return
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (ui.activityDrawerOpen === true) {
        actions.closeActivityDrawer()
        activityTriggerRef.current?.focus()
      } else closeWorkspace()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [ui.open, ui.activityDrawerOpen, actions, closeWorkspace])

  const snapshot = ui.snapshot
  const rooms = useMemo(() => snapshot === undefined ? [] : Object.values(snapshot.rooms), [snapshot])
  const definitions = useMemo(() => snapshot === undefined ? [] : Object.values(snapshot.definitions), [snapshot])
  const activity = useMemo(() => snapshot === undefined ? undefined : projectWorkspaceActivity(snapshot, activitySnapshot), [snapshot, activitySnapshot])

  useEffect(() => {
    if (snapshot === undefined) return
    if (ui.selectedRoomId === undefined || snapshot.rooms[ui.selectedRoomId] === undefined) {
      actions.selectRoom(rooms[0]?.id)
    }
    if (ui.selectedDefinitionId === undefined || snapshot.definitions[ui.selectedDefinitionId] === undefined) {
      actions.selectDefinition(definitions[0]?.id)
    }
  }, [snapshot, ui.selectedRoomId, ui.selectedDefinitionId, rooms, definitions, actions])

  const selectedDefinition = snapshot === undefined || ui.selectedDefinitionId === undefined
    ? undefined
    : snapshot.definitions[ui.selectedDefinitionId]
  const selectedRevision = snapshot === undefined || selectedDefinition === undefined
    ? undefined
    : snapshot.definitionRevisions[selectedDefinition.currentRevisionId]
  const pendingDispatches = activity?.activities.filter(item => item.status !== 'settled').length ?? 0

  const resetRevisionDraft = (source: WorkspaceSnapshot, definitionId: AgentDefinitionId): void => {
    const definition = source.definitions[definitionId]
    const revision = definition === undefined ? undefined : source.definitionRevisions[definition.currentRevisionId]
    setRevisionDescription(revision?.description ?? '')
    setRevisionInstructions(revision?.instructions ?? '')
    setRevisionDraftDefinitionId(definitionId)
    setRevisionDraftRevisionId(revision?.id)
    setRevisionDraftDirty(false)
  }

  useEffect(() => {
    if (snapshot === undefined || selectedDefinition === undefined) return
    const ownsSelection = revisionDraftDefinitionId === selectedDefinition.id
    if (!ownsSelection || (!revisionDraftDirty && !revisionDraftReserved && revisionDraftRevisionId !== selectedRevision?.id)) {
      resetRevisionDraft(snapshot, selectedDefinition.id)
    }
  }, [snapshot, selectedDefinition, selectedRevision, revisionDraftDefinitionId, revisionDraftRevisionId, revisionDraftDirty, revisionDraftReserved])

  useEffect(() => {
    if (activity === undefined || !ui.activityDrawerOpen) return
    if (ui.selectedActivityId === undefined || !activity.activities.some(item => item.activityId === ui.selectedActivityId)) {
      actions.selectActivity(activity.activities[0]?.activityId)
    }
  }, [activity, ui.activityDrawerOpen, ui.selectedActivityId, actions])

  if (!ui.open) return null

  const commit = async (
    operation: MutationOperation,
    revision = snapshot?.revision,
    retry: PendingMutation = { kind: 'operation', operation },
  ): Promise<boolean> => {
    if (revision === undefined) return false
    actions.setBusy(true)
    actions.setError(undefined)
    try {
      const committed = await operation(revision)
      actions.setSnapshot(committed)
      actions.setRetry(undefined)
      setPendingMutation(undefined)
      return true
    } catch (error) {
      if (isStaleRevision(error)) {
        setPendingMutation(retry)
        try {
          const authoritative = await api.snapshot()
          actions.setSnapshot(authoritative)
          actions.setRetry({ stale: true, refreshed: true })
        } catch (refreshError) {
          actions.setError(toUiError(refreshError))
          actions.setRetry({ stale: true, refreshed: false })
        }
      } else {
        actions.setError(toUiError(error))
      }
      return false
    } finally {
      actions.setBusy(false)
    }
  }

  const openDirect = async (agentId: AgentId): Promise<void> => {
    let roomId: RoomId | undefined
    const committed = await commit(async revision => {
      const result = await api.openDirect(agentId, revision)
      roomId = result.roomId
      return result.snapshot
    })
    if (committed && roomId !== undefined) {
      actions.selectRoom(roomId)
      actions.setMode('conversations')
    }
  }

  return (
    <div className="dsh-agent-group-overlay-root" role="dialog" aria-modal="true" aria-label={t('workspace.title')}>
      <section className="dsh-agent-group-workbench">
        <header className="dsh-agent-group-topbar">
          <WorkspaceIcon />
          <span className="dsh-agent-group-title">{t('workspace.title')}</span>
          <nav className="dsh-agent-group-tabs" aria-label={t('workspace.views')}>
            <button type="button" className="dsh-agent-group-tab" aria-label={t('workspace.conversations')} aria-current={ui.mode === 'conversations' ? 'page' : undefined} data-active={ui.mode === 'conversations'} onClick={() => actions.setMode('conversations')}>{t('workspace.conversations')}</button>
            <button type="button" className="dsh-agent-group-tab" aria-label={t('workspace.colleagues')} aria-current={ui.mode === 'colleagues' ? 'page' : undefined} data-active={ui.mode === 'colleagues'} onClick={() => actions.setMode('colleagues')}>{t('workspace.colleagues')}</button>
            <button type="button" className="dsh-agent-group-tab" aria-label={t('workspace.tasks')} aria-current={ui.mode === 'tasks' ? 'page' : undefined} data-active={ui.mode === 'tasks'} onClick={() => actions.setMode('tasks')}>{t('workspace.tasks')}</button>
            <button type="button" className="dsh-agent-group-tab" aria-label={t('workspace.memory')} aria-current={ui.mode === 'memory' ? 'page' : undefined} data-active={ui.mode === 'memory'} onClick={() => actions.setMode('memory')}>{t('workspace.memory')}</button>
          </nav>
          <span className="dsh-agent-group-spacer" />
          {ui.busy
            ? <span className="dsh-agent-group-busy">{t('workspace.processing')}</span>
            : pendingDispatches > 0
              ? <span className="dsh-agent-group-busy">{t('workspace.agentsProcessing')}</span>
              : null}
          <button ref={activityTriggerRef} type="button" className="dsh-agent-group-icon-button dsh-agent-group-activity-trigger" onClick={() => actions.openActivityDrawer(activity?.activities[0]?.activityId)} aria-label={t('activity.open')} title={t('activity.open')}>
            <WorkspaceRuntimeBadge value={t(`activity.status.${activity?.summary.status ?? 'idle'}`)} />
            {activity?.summary.usingTool ? <WorkspaceRuntimeBadge value={t('activity.usingTool')} /> : null}
            <span className="dsh-agent-group-activity-count">{activity?.activities.length ?? 0}</span>
          </button>
          <button type="button" className="dsh-agent-group-icon-button" onClick={() => void refreshWorkspace()} aria-label={t('workspace.refresh')} title={t('workspace.refresh')}><RefreshIcon /></button>
          <button type="button" className="dsh-agent-group-icon-button" onClick={closeWorkspace} aria-label={t('workspace.close')} title={t('workspace.close')}><CloseIcon /></button>
        </header>

        {ui.error !== undefined ? <div className="dsh-agent-group-error">{errorMessage(ui.error, t)}</div> : null}
        {ui.retry !== undefined && pendingMutation !== undefined && snapshot !== undefined
          ? <div className="dsh-agent-group-retry" role="status"><span>{t('workspace.staleRetry')}</span><button type="button" className="dsh-agent-group-button" onClick={() => {
              if (ui.retry?.refreshed === true) {
                void commit(pendingMutation.operation, snapshot.revision, pendingMutation)
              }
              else void refreshStale(api, actions)
            }}>{t('workspace.retry')}</button></div>
          : null}
        {streamError !== undefined ? <div className="dsh-agent-group-retry" role="status"><span className="dsh-agent-group-error">{errorMessage(streamError, t, 'workspace.streamFailed')}</span><button type="button" className="dsh-agent-group-button" onClick={() => { setStreamError(undefined); setReconnectAttempt(value => value + 1) }}>{t('workspace.retry')}</button></div> : null}
        {snapshot === undefined
          ? <div className="dsh-agent-group-empty">{t('workspace.loading')}</div>
          : ui.mode === 'conversations'
            ? <ChatWorkspace
                key={ui.selectedRoomId ?? 'no-room'}
                snapshot={snapshot}
                liveTurns={visibleWorkspaceTurns(snapshot.revision, turnStream)}
                activity={activity!}
                selectedRoomId={ui.selectedRoomId}
                busy={ui.busy}
                draft={draft}
                creatingRoom={creatingRoom}
                roomName={roomName}
                onSelectRoom={roomId => actions.selectRoom(roomId)}
                onDraftChange={setDraft}
                onCreatingRoomChange={setCreatingRoom}
                onRoomNameChange={setRoomName}
                onCreateRoom={async () => {
                  const name = roomName.trim()
                  if (name === '') return
                  if (await commit(revision => api.createGroup(name, revision))) {
                    setRoomName('')
                    setCreatingRoom(false)
                  }
                }}
                onPost={async () => {
                  const text = draft.trim()
                  if (ui.selectedRoomId === undefined || text === '') return
                  const roomId = ui.selectedRoomId as RoomId
                  if (await commit(revision => api.postMessage(roomId, text, parseRoomMentionIds(snapshot, roomId, text), revision))) setDraft('')
                }}
                onJoin={(agentId, memoryStart) => ui.selectedRoomId === undefined ? Promise.resolve() : commit(revision => api.joinRoom(ui.selectedRoomId as RoomId, agentId, memoryStart, revision)).then(() => undefined)}
                onLeave={membershipId => commit(revision => api.leaveRoom(membershipId, revision)).then(() => undefined)}
                onOpenDirect={openDirect}
                t={t}
              />
            : ui.mode === 'colleagues' ? <AgentWorkspace
                snapshot={snapshot}
                activity={activity!}
                selectedDefinitionId={ui.selectedDefinitionId}
                busy={ui.busy}
                creatingDefinition={creatingDefinition}
                definitionName={definitionName}
                definitionDescription={definitionDescription}
                definitionInstructions={definitionInstructions}
                revisionDescription={revisionDescription}
                revisionInstructions={revisionInstructions}
                agentName={agentName}
                api={api}
                onSnapshot={actions.setSnapshot}
                onSelectDefinition={definitionId => {
                  actions.selectDefinition(definitionId)
                  setCreatingDefinition(false)
                  resetRevisionDraft(snapshot, definitionId)
                  setRevisionDraftReserved(false)
                  setPendingMutation(undefined)
                  actions.setRetry(undefined)
                }}
                onCreatingDefinitionChange={setCreatingDefinition}
                onDefinitionNameChange={setDefinitionName}
                onDefinitionDescriptionChange={setDefinitionDescription}
                onDefinitionInstructionsChange={setDefinitionInstructions}
                onRevisionDescriptionChange={value => {
                  setRevisionDescription(value)
                  setRevisionDraftDirty(true)
                }}
                onRevisionInstructionsChange={value => {
                  setRevisionInstructions(value)
                  setRevisionDraftDirty(true)
                }}
                onCancelRevision={definitionId => {
                  resetRevisionDraft(snapshot, definitionId)
                  setRevisionDraftReserved(false)
                  setPendingMutation(undefined)
                  actions.setRetry(undefined)
                }}
                onAgentNameChange={setAgentName}
                onCreateDefinition={async () => {
                  if (definitionName.trim() === '') return
                  if (await commit(revision => api.createDefinition({
                    name: definitionName.trim(),
                    description: definitionDescription,
                    instructions: definitionInstructions,
                  }, revision))) {
                    setDefinitionName('')
                    setDefinitionDescription('')
                    setDefinitionInstructions('')
                    setCreatingDefinition(false)
                  }
                }}
                onRevisionSaved={() => {
                  setRevisionDraftDefinitionId(undefined)
                  setRevisionDraftDirty(false)
                  setRevisionDraftReserved(false)
                  setPendingMutation(undefined)
                  actions.setRetry(undefined)
                }}
                onDraftReservationChange={setRevisionDraftReserved}
                onCreateAgent={async definitionId => {
                  const name = agentName.trim()
                  if (name === '') return
                  if (await commit(revision => api.createAgent(definitionId, name, revision))) setAgentName('')
                }}
                onSetEmployment={(agentId, employed) => commit(revision => api.setEmployment(agentId, employed, revision)).then(() => undefined)}
                onOpenDirect={openDirect}
                t={t}
              /> : ui.mode === 'tasks' ? <WorkspaceTasks
                snapshot={snapshot}
                activity={activitySnapshot}
                api={api}
                onSnapshot={actions.setSnapshot}
                onActivity={adoptActivity}
                t={t}
              /> : <WorkspaceMemory snapshot={snapshot} api={api} onSnapshot={actions.setSnapshot} t={t} />}
        {ui.activityDrawerOpen === true && activity !== undefined ? <WorkspaceActivityDrawer
          projection={activity}
          snapshot={snapshot!}
          api={api}
          selectedActivityId={ui.selectedActivityId}
          onSelectActivity={actions.selectActivity}
          onSnapshot={actions.setSnapshot}
          onActivity={adoptActivity}
          onClose={actions.closeActivityDrawer}
          returnFocusRef={activityTriggerRef}
          t={t}
        /> : null}
      </section>
    </div>
  )
}

interface ChatWorkspaceProps {
  readonly snapshot: WorkspaceSnapshot
  readonly activity: WorkspaceActivityProjection
  readonly liveTurns: readonly WorkspaceTurnProjection[]
  readonly selectedRoomId: RoomId | undefined
  readonly busy: boolean
  readonly draft: string
  readonly creatingRoom: boolean
  readonly roomName: string
  readonly onSelectRoom: (roomId: RoomId) => void
  readonly onDraftChange: (value: string) => void
  readonly onCreatingRoomChange: (value: boolean) => void
  readonly onRoomNameChange: (value: string) => void
  readonly onCreateRoom: () => Promise<void>
  readonly onPost: () => Promise<void>
  readonly onJoin: (agentId: AgentId, memoryStart: MembershipMemoryStart) => Promise<void>
  readonly onLeave: (membershipId: MembershipId) => Promise<void>
  readonly onOpenDirect: (agentId: AgentId) => Promise<void>
  readonly t: TranslateNS<'agentWorkspace'>
}

function ChatWorkspace(props: ChatWorkspaceProps) {
  const { snapshot, selectedRoomId } = props
  const rooms = Object.values(snapshot.rooms)
  const selectedRoom = selectedRoomId === undefined ? undefined : snapshot.rooms[selectedRoomId]
  const members = selectedRoomId === undefined ? [] : activeRoomMembers(snapshot, selectedRoomId)
  const memberIds = new Set(members.map(agent => agent.id))
  const candidates = selectedRoom?.kind === 'group'
    ? Object.values(snapshot.agents).filter(agent => agent.employmentStatus === 'employed' && !memberIds.has(agent.id))
    : []
  const messages = selectedRoomId === undefined ? [] : roomMessageEvents(snapshot, selectedRoomId)
  const liveTurns = selectedRoomId === undefined
    ? []
    : props.liveTurns.filter(turn => turn.roomId === selectedRoomId)
  const [candidate, setCandidate] = useState('')
  const [memoryStartType, setMemoryStartType] = useState<'' | MembershipMemoryStart['type']>('')
  const [startSequence, setStartSequence] = useState('')
  const [endSequence, setEndSequence] = useState('')
  const latestSequence = snapshot.events.at(-1)?.sequence ?? 0
  const parsedStartSequence = Number(startSequence)
  const parsedEndSequence = Number(endSequence)
  const memoryStart: MembershipMemoryStart | undefined = memoryStartType === 'new-events'
    ? { type: 'new-events' }
    : Number.isSafeInteger(parsedStartSequence)
        && parsedStartSequence > 0
        && Number.isSafeInteger(parsedEndSequence)
        && parsedEndSequence >= parsedStartSequence
        && parsedEndSequence <= latestSequence
      ? { type: 'event-range', startSequence: parsedStartSequence, endSequence: parsedEndSequence }
      : undefined

  useEffect(() => {
    if (!candidates.some(agent => agent.id === candidate)) {
      setCandidate(candidates[0]?.id ?? '')
      setMemoryStartType('')
      setStartSequence('')
      setEndSequence('')
    }
  }, [snapshot.revision, selectedRoomId])

  useEffect(() => {
    setMemoryStartType('')
    setStartSequence('')
    setEndSequence('')
  }, [selectedRoomId])

  const appendMention = (name: string): void => {
    props.onDraftChange(appendDisplayMention(props.draft, name))
  }

  const composerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      void props.onPost()
    }
  }

  return (
    <div className="dsh-agent-group-body" data-mode="conversations">
      <aside className="dsh-agent-group-panel">
        <div className="dsh-agent-group-section-head">
          <span className="dsh-agent-group-section-title">{props.t('room.conversations')}</span>
          <button type="button" className="dsh-agent-group-icon-button dsh-agent-group-right" onClick={() => props.onCreatingRoomChange(!props.creatingRoom)} aria-label={props.t('room.newGroup')}><PlusIcon /></button>
        </div>
        {props.creatingRoom ? <form className="dsh-agent-group-card" onSubmit={(event) => { event.preventDefault(); void props.onCreateRoom() }}>
          <div className="dsh-agent-group-form">
            <input className="dsh-agent-group-input" value={props.roomName} onChange={event => props.onRoomNameChange(event.target.value)} placeholder={props.t('room.name')} autoFocus />
            <div className="dsh-agent-group-inline">
              <button type="submit" className="dsh-agent-group-button" disabled={props.busy || props.roomName.trim() === ''}>{props.t('room.create')}</button>
              <button type="button" className="dsh-agent-group-button" data-variant="ghost" onClick={() => props.onCreatingRoomChange(false)}>{props.t('room.cancel')}</button>
            </div>
          </div>
        </form> : null}
        <div className="dsh-agent-group-scroll dsh-agent-group-list">
          {rooms.map(room => (
            <button key={room.id} type="button" className="dsh-agent-group-list-button" data-active={room.id === selectedRoomId} onClick={() => props.onSelectRoom(room.id)}>
              <ChatIcon />
              <span>{roomLabel(snapshot, room.id, props.t)}</span>
              <WorkspaceActivityBadges activities={props.activity.rooms[room.id] ?? []} t={props.t} />
              <small>{room.kind === 'direct' ? props.t('room.direct') : activeRoomMembers(snapshot, room.id).length}</small>
            </button>
          ))}
          {rooms.length === 0 ? <div className="dsh-agent-group-empty">{props.t('room.empty')}</div> : null}
        </div>
      </aside>

      <main className="dsh-agent-group-chat">
        {selectedRoomId === undefined || selectedRoom === undefined
          ? <div className="dsh-agent-group-empty">{props.t('room.select')}</div>
          : <>
            <div className="dsh-agent-group-section-head">
              <span className="dsh-agent-group-section-title">{selectedRoom.kind === 'group' ? '# ' : ''}{roomLabel(snapshot, selectedRoomId, props.t)}</span>
              <span className="dsh-agent-group-muted">{selectedRoom.kind === 'direct' ? props.t('room.direct') : props.t('room.members', { count: members.length })}</span>
            </div>
            <div className="dsh-agent-group-messages">
              {messages.map(event => {
                const name = actorLabel(snapshot, event.actor, props.t)
                const text = formatMessageText(snapshot, event.text ?? '')
                return <article className="dsh-agent-group-message" key={event.id}>
                  <div className="dsh-agent-group-avatar">{name.slice(0, 1).toUpperCase()}</div>
                  <div className="dsh-agent-group-message-body">
                    <div className="dsh-agent-group-message-meta"><strong>{name}</strong><span>#{event.sequence}</span></div>
                    <div className="dsh-agent-group-message-text">
                      {event.actor?.type === 'agent' ? <WorkspaceMarkdownMessage text={text} t={props.t} /> : text}
                    </div>
                  </div>
                </article>
              })}
              {liveTurns.map(turn => (
                <WorkspaceLiveTurn
                  key={turn.activityId}
                  turn={turn}
                  agentName={snapshot.agents[turn.agentId]?.name ?? turn.agentId}
                  t={props.t}
                />
              ))}
              {messages.length === 0 && liveTurns.length === 0
                ? <div className="dsh-agent-group-empty">{props.t('room.noMessages')}</div>
                : null}
            </div>
            <div className="dsh-agent-group-composer">
              {selectedRoom.kind === 'group' ? <div className="dsh-agent-group-mention-row">
                <button type="button" className="dsh-agent-group-chip" onClick={() => appendMention('all')} disabled={props.busy}>@all</button>
                {members.map(agent => <button key={agent.id} type="button" className="dsh-agent-group-chip" onClick={() => appendMention(agent.name)} disabled={props.busy}>@{agent.name}</button>)}
              </div> : null}
              <div className="dsh-agent-group-compose-row">
                <textarea
                  className="dsh-agent-group-textarea"
                  value={props.draft}
                  onChange={event => props.onDraftChange(event.target.value)}
                  onKeyDown={composerKeyDown}
                  placeholder={selectedRoom.kind === 'group' ? props.t('room.groupPlaceholder') : props.t('room.directPlaceholder')}
                />
                <button type="button" className="dsh-agent-group-button" disabled={props.busy || props.draft.trim() === ''} onClick={() => void props.onPost()}>{props.t('room.send')}</button>
              </div>
            </div>
          </>}
      </main>

      <aside className="dsh-agent-group-panel" aria-label={selectedRoom?.kind === 'direct' ? props.t('room.directTarget') : props.t('room.groupMembers')}>
        <div className="dsh-agent-group-section-head"><span className="dsh-agent-group-section-title">{selectedRoom?.kind === 'direct' ? props.t('room.directTarget') : props.t('room.groupMembers')}</span></div>
        <div className="dsh-agent-group-scroll">
          {selectedRoom?.kind === 'group' && candidates.length > 0 ? <div className="dsh-agent-group-card">
            <div className="dsh-agent-group-field">
              <label>{props.t('room.addAgent')}</label>
              <select className="dsh-agent-group-select" aria-label={props.t('room.addAgent')} value={candidate} onChange={event => {
                setCandidate(event.target.value)
                setMemoryStartType('')
                setStartSequence('')
                setEndSequence('')
              }}>
                {candidates.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select>
            </div>
            <div className="dsh-agent-group-field">
              <label>{props.t('room.memoryStart')}</label>
              <select className="dsh-agent-group-select" aria-label={props.t('room.memoryStart')} value={memoryStartType} onChange={event => setMemoryStartType(event.target.value as '' | MembershipMemoryStart['type'])}>
                <option value="" disabled>{props.t('room.selectMemoryStart')}</option>
                <option value="new-events">{props.t('room.memoryNewEvents')}</option>
                <option value="event-range">{props.t('room.memoryEventRange')}</option>
              </select>
            </div>
            {memoryStartType === 'event-range' ? <div className="dsh-agent-group-inline">
              <input
                className="dsh-agent-group-input"
                type="number"
                min={1}
                max={latestSequence}
                step={1}
                value={startSequence}
                onChange={event => setStartSequence(event.target.value)}
                aria-label={props.t('room.startSequence')}
              />
              <input
                className="dsh-agent-group-input"
                type="number"
                min={1}
                max={latestSequence}
                step={1}
                value={endSequence}
                onChange={event => setEndSequence(event.target.value)}
                aria-label={props.t('room.endSequence')}
              />
            </div> : null}
            <button type="button" className="dsh-agent-group-button" disabled={props.busy || candidate === '' || memoryStart === undefined} onClick={() => { if (memoryStart !== undefined) void props.onJoin(candidate, memoryStart) }}>{props.t('room.join')}</button>
          </div> : null}
          <div className="dsh-agent-group-list">
            {members.map(agent => {
              const membership = Object.values(snapshot.memberships).find(item => item.roomId === selectedRoomId && item.agentId === agent.id && item.leftEventId === undefined)
              return <div className="dsh-agent-group-list-button" key={agent.id} role="group" aria-label={agent.name}>
                <span className="dsh-agent-group-dot" data-employed="true" />
                <span>{agent.name}</span>
                <WorkspaceAgentRuntimeBadges agent={props.activity.agents[agent.id]} t={props.t} />
                {selectedRoom?.kind === 'group'
                  ? <button type="button" className="dsh-agent-group-button dsh-agent-group-right" data-variant="ghost" disabled={props.busy} onClick={() => void props.onOpenDirect(agent.id)}>{props.t('room.direct')}</button>
                  : null}
                {selectedRoom?.kind === 'group' && membership !== undefined
                  ? <button type="button" className="dsh-agent-group-button" data-variant="ghost" disabled={props.busy} onClick={() => void props.onLeave(membership.id)}>{props.t('room.remove')}</button>
                  : null}
              </div>
            })}
          </div>
        </div>
      </aside>
    </div>
  )
}

interface AgentWorkspaceProps {
  readonly snapshot: WorkspaceSnapshot
  readonly activity: WorkspaceActivityProjection
  readonly selectedDefinitionId: AgentDefinitionId | undefined
  readonly busy: boolean
  readonly creatingDefinition: boolean
  readonly definitionName: string
  readonly definitionDescription: string
  readonly definitionInstructions: string
  readonly revisionDescription: string
  readonly revisionInstructions: string
  readonly agentName: string
  readonly api: WorkspaceApiClient
  readonly onSnapshot: (snapshot: WorkspaceSnapshot) => void
  readonly onSelectDefinition: (id: AgentDefinitionId) => void
  readonly onCreatingDefinitionChange: (value: boolean) => void
  readonly onDefinitionNameChange: (value: string) => void
  readonly onDefinitionDescriptionChange: (value: string) => void
  readonly onDefinitionInstructionsChange: (value: string) => void
  readonly onRevisionDescriptionChange: (value: string) => void
  readonly onRevisionInstructionsChange: (value: string) => void
  readonly onCancelRevision: (id: AgentDefinitionId) => void
  readonly onAgentNameChange: (value: string) => void
  readonly onCreateDefinition: () => Promise<void>
  readonly onRevisionSaved: () => void
  readonly onDraftReservationChange: (reserved: boolean) => void
  readonly onCreateAgent: (id: AgentDefinitionId) => Promise<void>
  readonly onSetEmployment: (agentId: AgentId, employed: boolean) => Promise<void>
  readonly onOpenDirect: (agentId: AgentId) => Promise<void>
  readonly t: TranslateNS<'agentWorkspace'>
}

function AgentWorkspace(props: AgentWorkspaceProps) {
  const definitions = Object.values(props.snapshot.definitions)
  const selected = props.selectedDefinitionId === undefined ? undefined : props.snapshot.definitions[props.selectedDefinitionId]
  const revision = selected === undefined ? undefined : props.snapshot.definitionRevisions[selected.currentRevisionId]
  const agents = selected === undefined ? [] : Object.values(props.snapshot.agents).filter(agent => agent.definitionId === selected.id)

  return (
    <div className="dsh-agent-group-body" data-mode="colleagues">
      <aside className="dsh-agent-group-panel">
        <div className="dsh-agent-group-section-head">
          <span className="dsh-agent-group-section-title">{props.t('agent.definitions')}</span>
          <button type="button" className="dsh-agent-group-icon-button dsh-agent-group-right" onClick={() => props.onCreatingDefinitionChange(true)} aria-label={props.t('agent.newDefinition')}><PlusIcon /></button>
        </div>
        <div className="dsh-agent-group-scroll dsh-agent-group-list">
          {definitions.map(definition => {
            const count = Object.values(props.snapshot.agents).filter(agent => agent.definitionId === definition.id).length
            return <button key={definition.id} type="button" className="dsh-agent-group-list-button" data-active={!props.creatingDefinition && definition.id === props.selectedDefinitionId} onClick={() => props.onSelectDefinition(definition.id)}>
              <BotIcon /><span>{definition.name}</span><small>{count}</small>
            </button>
          })}
          {definitions.length === 0 ? <div className="dsh-agent-group-empty">{props.t('agent.noDefinitions')}</div> : null}
        </div>
      </aside>

      <main className="dsh-agent-group-panel">
        <div className="dsh-agent-group-section-head">
          <span className="dsh-agent-group-section-title">{props.creatingDefinition ? props.t('agent.newDefinitionTitle') : selected?.name ?? props.t('agent.fallbackTitle')}</span>
          {revision !== undefined && !props.creatingDefinition ? <span className="dsh-agent-group-muted">{props.t('agent.revision', { number: revision.number })}</span> : null}
        </div>
        <div className="dsh-agent-group-scroll">
          {props.creatingDefinition
            ? <form className="dsh-agent-group-form" onSubmit={(event: FormEvent) => { event.preventDefault(); void props.onCreateDefinition() }}>
                <Field label={props.t('agent.name')}><input className="dsh-agent-group-input" value={props.definitionName} onChange={event => props.onDefinitionNameChange(event.target.value)} placeholder={props.t('agent.namePlaceholder')} autoFocus /></Field>
                <Field label={props.t('agent.description')}><textarea className="dsh-agent-group-textarea" value={props.definitionDescription} onChange={event => props.onDefinitionDescriptionChange(event.target.value)} placeholder={props.t('agent.descriptionPlaceholder')} /></Field>
                <Field label={props.t('agent.instructions')}><textarea className="dsh-agent-group-textarea" value={props.definitionInstructions} onChange={event => props.onDefinitionInstructionsChange(event.target.value)} placeholder={props.t('agent.instructionsPlaceholder')} /></Field>
                <div className="dsh-agent-group-inline">
                  <button type="submit" className="dsh-agent-group-button" disabled={props.busy || props.definitionName.trim() === ''}>{props.t('agent.createDefinition')}</button>
                  <button type="button" className="dsh-agent-group-button" data-variant="ghost" onClick={() => props.onCreatingDefinitionChange(false)}>{props.t('room.cancel')}</button>
                </div>
              </form>
            : selected === undefined || revision === undefined
              ? <div className="dsh-agent-group-empty">{props.t('agent.selectDefinition')}</div>
              : <>
                  <WorkspaceDefinitionHistory
                    snapshot={props.snapshot}
                    definitionId={selected.id}
                    description={props.revisionDescription}
                    instructions={props.revisionInstructions}
                    api={props.api}
                    onDescriptionChange={props.onRevisionDescriptionChange}
                    onInstructionsChange={props.onRevisionInstructionsChange}
                    onSnapshot={props.onSnapshot}
                    onSaveSuccess={props.onRevisionSaved}
                    onEditorCancel={() => props.onCancelRevision(selected.id)}
                    onDraftReservationChange={props.onDraftReservationChange}
                    t={props.t}
                  />

                  <section className="dsh-agent-group-card">
                    <div className="dsh-agent-group-card-head"><strong>{props.t('agent.instances')}</strong><span className="dsh-agent-group-muted">{props.t('agent.instancesHint')}</span></div>
                    <form className="dsh-agent-group-inline" onSubmit={(event) => { event.preventDefault(); void props.onCreateAgent(selected.id) }}>
                      <input className="dsh-agent-group-input" value={props.agentName} onChange={event => props.onAgentNameChange(event.target.value)} placeholder={props.t('agent.instanceNamePlaceholder')} />
                      <button type="submit" className="dsh-agent-group-button" disabled={props.busy || props.agentName.trim() === ''}>{props.t('agent.createInstance')}</button>
                    </form>
                    <div className="dsh-agent-group-list">
                      {agents.map(agent => <div className="dsh-agent-group-list-button" key={agent.id} role="group" aria-label={agent.name}>
                        <span className="dsh-agent-group-dot" data-employed={agent.employmentStatus === 'employed'} />
                        <span>{agent.name}</span>
                        <WorkspaceAgentRuntimeBadges agent={props.activity.agents[agent.id]} t={props.t} />
                        <small>{agent.employmentStatus === 'employed' ? props.t('agent.employed') : props.t('agent.departed')}</small>
                        <button
                          type="button"
                          className="dsh-agent-group-button"
                          data-variant="ghost"
                          disabled={props.busy || agent.employmentStatus !== 'employed'}
                          onClick={() => void props.onOpenDirect(agent.id)}
                        >{props.t('room.direct')}</button>
                        <button type="button" className="dsh-agent-group-button" data-variant="ghost" disabled={props.busy} onClick={() => void props.onSetEmployment(agent.id, agent.employmentStatus !== 'employed')}>
                          {agent.employmentStatus === 'employed' ? props.t('agent.depart') : props.t('agent.reemploy')}
                        </button>
                      </div>)}
                    </div>
                  </section>
                </>}
        </div>
      </main>
    </div>
  )
}

function Field({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return <div className="dsh-agent-group-field"><label>{label}</label>{children}</div>
}

function activityTurnStream(activity: WorkspaceActivitySnapshot): WorkspaceTurnStreamSnapshot {
  return {
    version: activity.version,
    workspaceRevision: activity.workspaceRevision,
    turns: activity.activities.flatMap(item => {
      if (item.source.kind !== 'room' || item.claimed === undefined) return []
      return [{
        activityId: item.activityId,
        roomId: item.source.roomId,
        agentId: item.agentId,
        sessionId: item.claimed.sessionId,
        turn: item.claimed.turn,
        status: item.status === 'settled' ? 'settled' as const : 'running' as const,
        blocks: item.blocks.map(activityTurnBlock),
        ...(item.terminalReason === undefined ? {} : { stopReason: item.terminalReason }),
        ...(item.error === undefined ? {} : { error: item.error.summary }),
      }]
    }),
  }
}

function activityTurnBlock(block: WorkspaceActivitySnapshot['activities'][number]['blocks'][number]): WorkspaceTurnBlock {
  if (block.kind !== 'tool') return block
  return {
    kind: 'tool', index: block.index, callId: block.callId, name: block.name,
    arguments: block.arguments, status: block.status,
    ...(block.resultText === undefined ? {} : { resultText: block.resultText }),
    ...(block.error === undefined ? {} : { error: block.error.summary }),
  }
}

function visibleWorkspaceTurns(
  durableRevision: number,
  stream: WorkspaceTurnStreamSnapshot,
): readonly WorkspaceTurnProjection[] {
  if (durableRevision <= stream.workspaceRevision) return stream.turns
  return stream.turns.filter(turn => turn.status === 'running')
}

function isStaleRevision(error: unknown): error is WorkspaceApiError {
  return error instanceof WorkspaceApiError && error.kind === 'business' && error.code === 'stale-revision'
}

function toUiError(error: unknown): WorkspaceUiError {
  return error instanceof WorkspaceApiError ? error : { kind: 'unexpected' }
}

function errorMessage(
  error: unknown,
  t: TranslateNS<'agentWorkspace'>,
  fallback: 'workspace.requestFailed' | 'workspace.streamFailed' = 'workspace.requestFailed',
): string {
  if (error instanceof WorkspaceApiError && error.error.kind === 'business') {
    const failure = error.error
    switch (failure.code) {
      case 'reserved-direct-routing': return t('error.reservedDirectRouting', failure.details)
      case 'agent-missing': return t('error.agentMissing', failure.details)
      case 'agent-departed': return t('error.agentDeparted', failure.details)
      case 'duplicate-membership': return t('error.duplicateMembership', failure.details)
      case 'stale-revision': return 'expectedRevision' in failure.details
        ? t('error.staleWorkspaceRevision', failure.details)
        : t('error.staleRevision', failure.details)
      case 'invalid-task-authority': return t('error.invalidTaskAuthority', failure.details)
      case 'task-not-open': return t('error.taskNotOpen', failure.details)
      case 'task-not-assigned': return t('error.taskNotAssigned', failure.details)
      case 'delegation-grant-missing': return failure.details.lookup === 'id'
        ? t('error.delegationGrantMissingById', failure.details)
        : t('error.delegationGrantMissingByTask', failure.details)
      case 'delegation-grant-inactive': return t('error.delegationGrantInactive', failure.details)
    }
  }
  return t(fallback)
}

async function refreshStale(api: WorkspaceApiClient, actions: WorkspaceStoreProps['actions']): Promise<void> {
  actions.setBusy(true)
  actions.setError(undefined)
  try {
    actions.setSnapshot(await api.snapshot())
    actions.setRetry({ stale: true, refreshed: true })
  } catch (error) {
    actions.setError(toUiError(error))
    actions.setRetry({ stale: true, refreshed: false })
  } finally {
    actions.setBusy(false)
  }
}

function WorkspaceIcon() {
  return <svg className="dsh-agent-group-footer-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="8" cy="8" r="3"/><circle cx="16.5" cy="9.5" r="2.5"/><path d="M3.5 19c.5-3.2 2.1-5 4.5-5s4 1.8 4.5 5M13 18.5c.4-2.4 1.6-3.8 3.6-3.8 1.9 0 3.1 1.4 3.5 3.8"/></svg>
}
function ChatIcon() { return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M5 5.5h14v10H9l-4 3v-13Z"/></svg> }
function BotIcon() { return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="5" y="7" width="14" height="11" rx="3"/><path d="M12 4v3M9 12h.01M15 12h.01M9 15h6"/></svg> }
function PlusIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg> }
function CloseIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg> }
function RefreshIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M19 8a7 7 0 1 0 1 6M19 4v4h-4"/></svg> }
