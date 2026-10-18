/** Additive Agent Workspace Browser surfaces. */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent, ReactNode } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { WorkspaceApiError } from './api.ts'
import { WorkspaceCommunicationApi } from './communication-api.ts'
import type { TaskBrief } from './workflow-contracts.ts'
import type { WorkspaceApiClient } from './api.ts'
import type {
  AgentDefinitionId,
  AgentId,
  DefinitionRevisionId,
  MembershipId,
  WorkspaceEventId,
  RoomId,
  WorkspaceSnapshot,
  WorkspaceActivitySnapshot,
  WorkspaceTurnProjection,
  WorkspaceTurnBlock,
  WorkspaceTurnStreamSnapshot,
} from './contracts.ts'
import type { createWorkspaceUiStore, WorkspaceUiError } from './store.ts'
import { WorkspaceLiveTurn } from './WorkspaceTurn.tsx'
import { WorkspaceChatMessage } from './WorkspaceChatMessage.tsx'
import { WorkspaceRecallDialog, useCommunicationMetadata } from './WorkspaceRecall.tsx'
import { WorkspaceColleagueProfile } from './WorkspaceColleagueProfile.tsx'
import { WorkspaceAddColleague } from './WorkspaceAddColleague.tsx'
import { WorkspaceRemoveColleague } from './WorkspaceRemoveColleague.tsx'
import { WorkspacePeople } from './WorkspacePeople.tsx'
import { WorkspacePersonIdentity } from './WorkspacePersonIdentity.tsx'
import { WorkspaceTasks } from './WorkspaceTasks.tsx'
import { WorkspacePendingWork, type BringWorkToChat } from './WorkspacePendingWork.tsx'
import { useConversationScroll } from './use-conversation-scroll.ts'
import { WorkspaceMemory } from './WorkspaceMemory.tsx'
import { WorkspaceDefinitionHistory } from './WorkspaceDefinitionHistory.tsx'
import { selectNewerActivitySnapshot } from './task-view-model.ts'
import { projectWorkspaceActivity } from './activity-view-model.ts'
import type { WorkspaceActivityProjection } from './activity-view-model.ts'
import { WorkspaceActivityBadges, WorkspaceActivityDrawer, WorkspaceAgentRuntimeBadges, WorkspaceRuntimeBadge } from './WorkspaceActivityDrawer.tsx'
import {
  activeRoomMembers,
  appendDisplayMention,
  canonicalRoomMessageText,
  directRoomForAgent,
  parseRoomMentionIds,
  roomLabel,
  roomMessageEvents,
} from './view-model.ts'

type WorkspaceStoreProps = PropsStore<ReturnType<typeof createWorkspaceUiStore>>

export type WorkspaceFooterActionProps = PropsRuntime<'sidebar.footer.action'> & WorkspaceStoreProps & PropsLocale<'agentWorkspace'>
export type WorkspaceOverlayProps = PropsRuntime<'shell.overlay'> & WorkspaceStoreProps & PropsLocale<'agentWorkspace'> & { readonly api: WorkspaceApiClient; readonly embedded?: boolean; readonly readOnly?: boolean; readonly headerLeading?: ReactNode; readonly headerNotices?: ReactNode }

const EMPTY_TURN_STREAM: WorkspaceTurnStreamSnapshot = { version: 0, workspaceRevision: 0, turns: [] }
const EMPTY_ACTIVITY: WorkspaceActivitySnapshot = { version: 0, workspaceRevision: 0, activities: [], agents: [] }
type MutationOperation = (expectedRevision: number, snapshot: WorkspaceSnapshot) => Promise<WorkspaceSnapshot>
type PendingMutation = { readonly kind: 'operation'; readonly operation: MutationOperation }
interface ChatWorkSeed { readonly brief: TaskBrief; readonly draftId?: string; readonly draftRevision?: number }

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
export function WorkspaceOverlay({ useStore, actions, api, t, embedded = false, readOnly = false, headerLeading, headerNotices }: WorkspaceOverlayProps) {
  const ui = useStore(state => state)
  const [creatingRoom, setCreatingRoom] = useState(false)
  const [roomName, setRoomName] = useState('')
  const [draft, setDraft] = useState('')
  const [workSeed, setWorkSeed] = useState<ChatWorkSeed>()
  const chatWorkOperations = useRef(new Map<string, string>())
  useEffect(() => { setWorkSeed(undefined); setDraft(''); chatWorkOperations.current.clear() }, [api])
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
  const [profileOpen, setProfileOpen] = useState(false)
  const [roleManagementOpen, setRoleManagementOpen] = useState(false)
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
      if (event.key !== 'Escape' || event.defaultPrevented || (event.target instanceof Element && event.target.closest('[role="dialog"][data-colleague-id],[role="dialog"][data-message-recall],[role="dialog"][data-add-colleague],[role="dialog"][data-remove-colleague]'))) return
      if (profileOpen) { setProfileOpen(false); return }
      if (ui.activityDrawerOpen === true) {
        actions.closeActivityDrawer()
        activityTriggerRef.current?.focus()
      } else closeWorkspace()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [ui.open, ui.activityDrawerOpen, profileOpen, actions, closeWorkspace])

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
    if (ui.selectedAgentId === undefined || snapshot.agents[ui.selectedAgentId] === undefined) {
      actions.selectAgent(Object.values(snapshot.agents)[0]?.id)
    }
  }, [snapshot, ui.selectedRoomId, ui.selectedDefinitionId, ui.selectedAgentId, rooms, definitions, actions])

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
    if (readOnly || revision === undefined || snapshot === undefined) return false
    actions.setBusy(true)
    actions.setError(undefined)
    try {
      const committed = await operation(revision, snapshot)
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
    setProfileOpen(false)
    actions.selectAgent(agentId)
    const existing = snapshot === undefined ? undefined : directRoomForAgent(snapshot, agentId)
    if (existing !== undefined) {
      actions.selectRoom(existing)
      actions.setMode('conversations')
      return
    }
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

  const openColleague = (agentId: AgentId): void => { actions.selectAgent(agentId); setProfileOpen(true) }
  const bringWorkToChat: BringWorkToChat = (brief, pendingDraft, source) => {
    if (source !== undefined) actions.selectRoom(source.roomId as RoomId)
    setDraft(brief.instructions)
    setWorkSeed({ brief, ...(pendingDraft === undefined ? {} : { draftId: pendingDraft.id, draftRevision: pendingDraft.revision }) })
    actions.setMode('conversations')
  }
  const profileProps = snapshot === undefined || ui.selectedAgentId === undefined ? undefined : {
    snapshot, agentId: ui.selectedAgentId, busy: ui.busy || readOnly, t,
    onRename: (agentId: AgentId, name: string) => commit(revision => api.renameAgent(agentId, name, revision)),
    onSetEmployment: (agentId: AgentId, employed: boolean) => commit(revision => api.setEmployment(agentId, employed, revision)).then(() => undefined),
    onOpenDirect: openDirect,
    onView: (mode: 'tasks' | 'memory', agentId: AgentId): void => { actions.selectAgent(agentId); actions.setMode(mode); setProfileOpen(false) },
    onEditRole: (definitionId: AgentDefinitionId): void => { actions.selectDefinition(definitionId); resetRevisionDraft(snapshot, definitionId); actions.setMode('colleagues'); setRoleManagementOpen(true); setProfileOpen(false) },
  }

  return (
    <div className={embedded ? 'dsh-agent-group-organization-workspace' : 'dsh-agent-group-overlay-root'} role={embedded ? undefined : 'dialog'} aria-modal={embedded ? undefined : true} aria-label={t('workspace.title')}>
      <section className="dsh-agent-group-workbench">
        <header className="dsh-agent-group-topbar">
          {headerLeading ?? <WorkspaceIcon />}
          {!embedded ? <span className="dsh-agent-group-title">{t('workspace.title')}</span> : null}
          <nav className="dsh-agent-group-tabs" aria-label={t('workspace.views')}>
            <button type="button" className="dsh-agent-group-tab" aria-label={t('workspace.conversations')} aria-current={ui.mode === 'conversations' ? 'page' : undefined} data-active={ui.mode === 'conversations'} onClick={() => actions.setMode('conversations')}>{t('workspace.conversations')}</button>
            <button type="button" className="dsh-agent-group-tab" aria-label={t('workspace.colleagues')} aria-current={ui.mode === 'colleagues' ? 'page' : undefined} data-active={ui.mode === 'colleagues'} onClick={() => actions.setMode('colleagues')}>{t('workspace.colleagues')}</button>
            <button type="button" className="dsh-agent-group-tab" aria-label={t('workspace.tasks')} aria-current={ui.mode === 'tasks' ? 'page' : undefined} data-active={ui.mode === 'tasks'} onClick={() => actions.setMode('tasks')}>{t('workspace.tasks')}</button>
            <button type="button" className="dsh-agent-group-tab" aria-label={t('workspace.memory')} aria-current={ui.mode === 'memory' ? 'page' : undefined} data-active={ui.mode === 'memory'} onClick={() => actions.setMode('memory')}>{t('workspace.memory')}</button>
          </nav>
          <span className="dsh-agent-group-spacer" />
          <div className="dsh-agent-group-shell-actions">
          {ui.busy
            ? <span className="dsh-agent-group-busy">{t('workspace.processing')}</span>
            : pendingDispatches > 0
              ? <span className="dsh-agent-group-busy">{t('workspace.agentsProcessing')}</span>
              : null}
          <button ref={activityTriggerRef} type="button" className="dsh-agent-group-icon-button dsh-agent-group-activity-trigger" onClick={() => actions.openActivityDrawer(activity?.activities[0]?.activityId)} aria-label={t('activity.open')} title={t('activity.open')}>
            <span className="dsh-agent-group-status-indicator" data-status={activity?.summary.status ?? 'idle'} aria-hidden="true" />
            <WorkspaceRuntimeBadge value={t(`activity.status.${activity?.summary.status ?? 'idle'}`)} />
            {activity?.summary.usingTool ? <WorkspaceRuntimeBadge value={t('activity.usingTool')} /> : null}
            <span className="dsh-agent-group-activity-count">{activity?.activities.length ?? 0}</span>
          </button>
          <button type="button" className="dsh-agent-group-icon-button" onClick={() => void refreshWorkspace()} aria-label={t('workspace.refresh')} title={t('workspace.refresh')}><RefreshIcon /></button>
          <button type="button" className="dsh-agent-group-icon-button" onClick={closeWorkspace} aria-label={t('workspace.close')} title={t('workspace.close')}><CloseIcon /></button>
          </div>
        </header>
        {headerNotices}

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
                api={api}
                onRecallChanged={refreshWorkspace}
                onSnapshot={actions.setSnapshot}
                onBringToChat={bringWorkToChat}
                onOpenSource={(roomId, eventId) => { actions.selectRoom(roomId); actions.selectMessage(eventId) }}
                liveTurns={visibleWorkspaceTurns(snapshot.revision, turnStream)}
                activity={activity!}
                selectedRoomId={ui.selectedRoomId}
                selectedEventId={ui.selectedEventId}
                busy={ui.busy || readOnly}
                draft={draft}
                workSeed={workSeed}
                creatingRoom={creatingRoom}
                roomName={roomName}
                onSelectRoom={roomId => { setWorkSeed(undefined); setDraft(''); actions.selectRoom(roomId) }}
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
                  const mentions = parseRoomMentionIds(snapshot, roomId, text)
                  if (await commit(revision => api.postMessage(roomId, canonicalRoomMessageText(snapshot, text, mentions), mentions, revision))) setDraft('')
                }}
                onAssign={async (brief, assigneeAgentId, allowDelegation) => {
                  if (ui.selectedRoomId === undefined) return false
                  const client = new WorkspaceCommunicationApi(api)
                  const roomId = ui.selectedRoomId
                  const seed = workSeed
                  const fields = { roomId, assigneeAgentId, allowDelegation }
                  const fingerprint = JSON.stringify({ ...fields, brief, seed })
                  const operationId = chatWorkOperations.current.get(fingerprint) ?? crypto.randomUUID()
                  chatWorkOperations.current.set(fingerprint, operationId)
                  const saved = await commit(async revision => {
                    const metadata = await client.snapshot()
                    const expected = { operationId, expectedAggregateRevision: revision, expectedWorkflowRevision: metadata.workflowRevision }
                    if (seed?.draftId !== undefined && seed.draftRevision !== undefined) await client.confirm({ ...fields, ...expected, draftId: seed.draftId, expectedDraftRevision: seed.draftRevision })
                    else await client.assign({ ...fields, ...expected, brief: { ...brief, expectedArtifacts: [...brief.expectedArtifacts], acceptanceCriteria: [...brief.acceptanceCriteria] } })
                    return api.snapshot()
                  })
                  if (saved) { setDraft(''); setWorkSeed(undefined); chatWorkOperations.current.delete(fingerprint) }
                  return saved
                }}
                onJoin={agentIds => {
                  const roomId = ui.selectedRoomId
                  if (roomId === undefined) return Promise.resolve(false)
                  return commit(async (revision, currentSnapshot) => {
                    let joined = currentSnapshot
                    let expectedRevision = revision
                    try {
                      for (const agentId of agentIds) {
                        if (activeRoomMembers(joined, roomId).some(agent => agent.id === agentId)) continue
                        joined = await api.joinRoom(roomId, agentId, { type: 'event-range', startSequence: 1, endSequence: joined.events.at(-1)!.sequence }, expectedRevision)
                        expectedRevision = joined.revision
                      }
                    } catch (error) {
                      if (joined !== currentSnapshot) actions.setSnapshot(joined)
                      throw error
                    }
                    return joined
                  })
                }}
                onLeave={(membershipId, forgetMemory, operationId) => commit(revision => forgetMemory ? api.leaveRoomAndForget(membershipId, operationId, revision) : api.leaveRoom(membershipId, revision))}
                onOpenDirect={openDirect}
                onOpenColleague={openColleague}
                onRenameRoom={name => ui.selectedRoomId === undefined ? Promise.resolve(false) : commit(revision => api.renameRoom(ui.selectedRoomId as RoomId, name, revision))}
                t={t}
              />
            : ui.mode === 'colleagues' ? <WorkspacePeople
                snapshot={snapshot}
                selectedAgentId={ui.selectedAgentId}
                busy={ui.busy || readOnly}
                roleManagementOpen={roleManagementOpen}
                onRoleManagementOpen={setRoleManagementOpen}
                onSelect={actions.selectAgent}
                onCreate={(definitionId, name) => commit(revision => api.createAgent(definitionId, name, revision))}
                activity={activity!}
                onCreateRole={async (name, description, instructions) => {
                  let createdId: AgentDefinitionId | undefined
                  const saved = await commit(async revision => {
                    const next = await api.createDefinition({ name, description, instructions }, revision)
                    createdId = Object.keys(next.definitions).find(id => snapshot.definitions[id] === undefined)
                    return next
                  })
                  return saved ? createdId : undefined
                }}
                profile={profileProps === undefined ? null : <WorkspaceColleagueProfile key={profileProps.agentId} {...profileProps} />}
                t={t}
                roleManagement={<AgentWorkspace
                snapshot={snapshot}
                activity={activity!}
                selectedDefinitionId={ui.selectedDefinitionId}
                busy={ui.busy || readOnly}
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
              />} /> : ui.mode === 'tasks' ? <WorkspaceTasks
                snapshot={snapshot}
                activity={activitySnapshot}
                api={api}
                onSnapshot={actions.setSnapshot}
                onActivity={adoptActivity}
                selectedAgentId={ui.selectedAgentId}
                onSelectAgent={actions.selectAgent}
                onOpenSource={(roomId, eventId) => { actions.selectRoom(roomId); actions.selectMessage(eventId); actions.setMode('conversations') }}
                onBringToChat={bringWorkToChat}
                t={t}
              /> : <WorkspaceMemory snapshot={snapshot} api={api} onSnapshot={actions.setSnapshot} selectedAgentId={ui.selectedAgentId} onSelectAgent={actions.selectAgent} onOpenSource={(roomId, eventId) => { actions.selectRoom(roomId); actions.selectMessage(eventId); actions.setMode('conversations') }} t={t} />}
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
        {profileOpen && profileProps !== undefined ? <WorkspaceColleagueProfile key={`modal:${profileProps.agentId}`} {...profileProps} modal onClose={() => setProfileOpen(false)} /> : null}
      </section>
    </div>
  )
}

interface ChatWorkspaceProps {
  readonly api: WorkspaceApiClient
  readonly onRecallChanged: () => Promise<void>
  readonly onSnapshot: (snapshot: WorkspaceSnapshot) => void
  readonly onBringToChat: BringWorkToChat
  readonly onOpenSource: (roomId: RoomId, eventId: WorkspaceEventId) => void
  readonly snapshot: WorkspaceSnapshot
  readonly activity: WorkspaceActivityProjection
  readonly liveTurns: readonly WorkspaceTurnProjection[]
  readonly selectedRoomId: RoomId | undefined
  readonly selectedEventId: WorkspaceEventId | undefined
  readonly busy: boolean
  readonly draft: string
  readonly workSeed: ChatWorkSeed | undefined
  readonly creatingRoom: boolean
  readonly roomName: string
  readonly onSelectRoom: (roomId: RoomId) => void
  readonly onDraftChange: (value: string) => void
  readonly onCreatingRoomChange: (value: boolean) => void
  readonly onRoomNameChange: (value: string) => void
  readonly onCreateRoom: () => Promise<void>
  readonly onPost: () => Promise<void>
  readonly onAssign: (brief: TaskBrief, assigneeAgentId: AgentId, allowDelegation: boolean) => Promise<boolean>
  readonly onJoin: (agentIds: readonly AgentId[]) => Promise<boolean>
  readonly onLeave: (membershipId: MembershipId, forgetMemory: boolean, operationId: string) => Promise<boolean>
  readonly onOpenDirect: (agentId: AgentId) => Promise<void>
  readonly onOpenColleague: (agentId: AgentId) => void
  readonly onRenameRoom: (name: string) => Promise<boolean>
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
  const [addingColleague, setAddingColleague] = useState(false)
  const [removingColleague, setRemovingColleague] = useState<{ readonly membershipId: MembershipId; readonly name: string; readonly operationId?: string }>()
  const [renaming, setRenaming] = useState(false)
  const [renamedName, setRenamedName] = useState(selectedRoom?.name ?? '')
  const [membersOpen, setMembersOpen] = useState(false)
  const [assigning, setAssigning] = useState(props.workSeed !== undefined)
  const [assigneeId, setAssigneeId] = useState(selectedRoom?.kind === 'direct' ? members[0]?.id ?? '' : '')
  const [allowDelegation, setAllowDelegation] = useState(false)
  const [workTitle, setWorkTitle] = useState(props.workSeed?.brief.title ?? '')
  const [expectedArtifacts, setExpectedArtifacts] = useState(props.workSeed?.brief.expectedArtifacts.join('\n') ?? '')
  const [acceptanceCriteria, setAcceptanceCriteria] = useState(props.workSeed?.brief.acceptanceCriteria.join('\n') ?? '')
  const communication = useCommunicationMetadata(props.api, snapshot.revision)
  const [recallEventId, setRecallEventId] = useState<WorkspaceEventId>()
  const recallEvent = snapshot.events.find(event => event.id === recallEventId)
  const resets = Object.values(communication.value?.resets ?? {})
  const resetFor = (id: WorkspaceEventId) => resets.find(reset => reset.kind !== 'room-memory-forget' && reset.source.eventId === id)
  const pendingMemoryRemovals = resets.flatMap(reset => reset.kind === 'room-memory-forget' && reset.source.roomId === selectedRoomId && reset.status !== 'completed' ? [reset] : [])
  const invalidEvents = new Set(Object.values(communication.value?.resets ?? {}).flatMap(reset => reset.invalidatedEventIds))
  const leave = async (membershipId: MembershipId, forgetMemory: boolean, operationId: string): Promise<boolean> => {
    let saved = false
    try { saved = await props.onLeave(membershipId, forgetMemory, operationId) }
    finally {
      communication.refresh()
      if (!saved) {
        try { await props.onRecallChanged() }
        catch (_error) { /* The confirmation retains its cleanup identity when the snapshot refresh also fails. */ }
      }
    }
    return saved
  }
  useEffect(() => {
    setAssigning(props.workSeed !== undefined)
    setWorkTitle(props.workSeed?.brief.title ?? '')
    setExpectedArtifacts(props.workSeed?.brief.expectedArtifacts.join('\n') ?? '')
    setAcceptanceCriteria(props.workSeed?.brief.acceptanceCriteria.join('\n') ?? '')
    setAllowDelegation(false)
  }, [props.workSeed])
  const membersTriggerRef = useRef<HTMLButtonElement>(null)
  const closeMembers = (): void => { setMembersOpen(false); membersTriggerRef.current?.focus() }
  useEffect(() => {
    const workbench = membersTriggerRef.current?.closest('.dsh-agent-group-workbench')
    if (!membersOpen || workbench == null) return
    const surface = workbench.getRootNode()
    const closeOnEscape = (event: Event): void => {
      if (!(event instanceof KeyboardEvent) || event.key !== 'Escape' || event.defaultPrevented || (event.target instanceof Element && event.target.closest('[role="dialog"][data-colleague-id],[role="dialog"][data-message-recall],[role="dialog"][data-add-colleague],[role="dialog"][data-remove-colleague]'))) return
      if (workbench.querySelector('.dsh-agent-group-activity-drawer, .dsh-agent-group-organization-management[open]') !== null) return
      event.preventDefault()
      event.stopPropagation()
      closeMembers()
    }
    surface.addEventListener('keydown', closeOnEscape)
    return () => surface.removeEventListener('keydown', closeOnEscape)
  }, [membersOpen])
  const { messagesRef, onScroll, pauseFollowing, followLatest } = useConversationScroll({
    ready: communication.value !== undefined && !communication.failed,
    lastMessageId: messages.at(-1)?.id,
    liveTurns: props.liveTurns,
  })
  const focusedSource = useRef<WorkspaceEventId>()

  useEffect(() => {
    if (props.selectedEventId === undefined) { focusedSource.current = undefined; return }
    if (focusedSource.current === props.selectedEventId) return
    const target = [...(messagesRef.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])].find(element => element.dataset.messageId === props.selectedEventId)
    if (target === undefined) return
    target.scrollIntoView?.({ block: 'center' })
    target.focus({ preventScroll: true })
    pauseFollowing()
    focusedSource.current = props.selectedEventId
  }, [props.selectedEventId, communication.value !== undefined])


  const appendMention = (name: string): void => {
    props.onDraftChange(appendDisplayMention(props.draft, name))
  }

  const composerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      void send()
    }
  }

  const send = async (): Promise<void> => {
    if (props.busy || !props.draft.trim()) return
    if (!assigning) { followLatest(); await props.onPost(); return }
    if (!members.some(agent => agent.id === assigneeId)) return
    followLatest()
    const instructions = props.draft.trim()
    if (await props.onAssign({ title: workTitle.trim() || instructions.split('\n')[0]!, instructions, expectedArtifacts: expectedArtifacts.split(/\r?\n/u).map(value => value.trim()).filter(Boolean), acceptanceCriteria: acceptanceCriteria.split(/\r?\n/u).map(value => value.trim()).filter(Boolean) }, assigneeId, allowDelegation)) { setAssigning(false); setAllowDelegation(false); setWorkTitle(''); setExpectedArtifacts(''); setAcceptanceCriteria('') }
  }

  return (
    <div className="dsh-agent-group-body" data-mode="conversations" data-members-open={membersOpen}>
      <aside className="dsh-agent-group-panel dsh-agent-group-room-sidebar">
        <div className="dsh-agent-group-section-head">
          <span className="dsh-agent-group-section-title">{props.t('room.conversations')}</span>
          <label className="dsh-agent-group-room-picker"><select className="dsh-agent-group-select" aria-label={props.t('room.conversations')} value={selectedRoomId ?? ''} onChange={event => props.onSelectRoom(event.target.value)}>
            <option value="" disabled>{props.t('room.select')}</option>
            {rooms.map(room => <option key={room.id} value={room.id}>{roomLabel(snapshot, room.id, props.t)}</option>)}
          </select></label>
          <button type="button" className="dsh-agent-group-icon-button dsh-agent-group-right" disabled={props.busy} onClick={() => props.onCreatingRoomChange(!props.creatingRoom)} aria-label={props.t('room.newGroup')}><PlusIcon /></button>
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
        <div className="dsh-agent-group-scroll dsh-agent-group-list dsh-agent-group-room-list">
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
              {selectedRoom.kind === 'group' ? <button type="button" className="dsh-agent-group-button" data-variant="ghost" disabled={props.busy} aria-label={props.t('room.rename')} onClick={() => { setRenamedName(selectedRoom.name ?? ''); setRenaming(true) }}>{props.t('room.rename')}</button> : null}
              <button ref={membersTriggerRef} type="button" className="dsh-agent-group-button dsh-agent-group-member-toggle" data-variant="ghost" aria-expanded={membersOpen} onClick={() => setMembersOpen(value => !value)}>{props.t('room.memberToggle')}</button>
            </div>
            {renaming ? <form className="dsh-agent-group-inline dsh-agent-group-rename" onSubmit={event => { event.preventDefault(); void props.onRenameRoom(renamedName.trim()).then(saved => { if (saved) setRenaming(false) }) }}>
              <input className="dsh-agent-group-input" aria-label={props.t('room.name')} value={renamedName} onChange={event => setRenamedName(event.target.value)} autoFocus />
              <button type="submit" className="dsh-agent-group-button" disabled={props.busy || !renamedName.trim()}>{props.t('room.saveName')}</button>
              <button type="button" className="dsh-agent-group-button" data-variant="ghost" onClick={() => setRenaming(false)}>{props.t('room.cancel')}</button>
            </form> : null}
            <div ref={messagesRef} className="dsh-agent-group-messages" onScroll={onScroll}>
              {communication.failed ? <div role="alert"><p>{props.t('recall.metadataFailed')}</p><button className="dsh-agent-group-button" type="button" onClick={communication.refresh}>{props.t('workspace.retry')}</button></div> : communication.value === undefined ? <p role="status">{props.t('workspace.loading')}</p> : messages.map(event => {
                const reset = resetFor(event.id)
                return <WorkspaceChatMessage key={event.id} snapshot={snapshot} event={event} highlighted={props.selectedEventId === event.id} withdrawn={communication.value?.messages[event.id]?.withdrawnBy !== undefined} invalidated={invalidEvents.has(event.id)} recallStatus={reset?.status} onRecall={event.actor?.type === 'human' && event.actor.id === 'web-user' && !props.api.readOnly ? () => setRecallEventId(event.id) : undefined} onOpenColleague={props.onOpenColleague} t={props.t} />
              })}
              {recallEvent !== undefined ? <WorkspaceRecallDialog api={props.api} snapshot={snapshot} event={recallEvent} reset={resetFor(recallEvent.id)} communication={communication.value} onClose={() => setRecallEventId(undefined)} onChanged={async () => { communication.refresh(); await props.onRecallChanged() }} t={props.t} /> : null}
              {liveTurns.filter(turn => communication.value !== undefined && !communication.failed && (communication.value.contexts[turn.agentId] === undefined || (communication.value.contexts[turn.agentId]?.blockedBy === undefined && communication.value.contexts[turn.agentId]?.sessionId === turn.sessionId))).map(turn => (
                <WorkspaceLiveTurn
                  key={turn.activityId}
                  turn={turn}
                  agentName={snapshot.agents[turn.agentId]?.name ?? turn.agentId}
                  t={props.t}
                />
              ))}
              {selectedRoomId !== undefined && communication.value !== undefined && !communication.failed && Object.values(communication.value.draftSources).some(source => source.roomId === selectedRoomId)
                ? <WorkspacePendingWork api={props.api} snapshot={snapshot} communication={communication.value} sourceState="ready" roomId={selectedRoomId} onSnapshot={props.onSnapshot} onOpenSource={props.onOpenSource} onBringToChat={props.onBringToChat} t={props.t} /> : null}
              {messages.length === 0 && liveTurns.length === 0
                ? <div className="dsh-agent-group-empty">{props.t('room.noMessages')}</div>
                : null}
            </div>
            <div className="dsh-agent-group-composer">
              <div className="dsh-agent-group-inline dsh-agent-group-compose-mode"><button type="button" className="dsh-agent-group-chip" aria-pressed={!assigning} disabled={props.busy} onClick={() => setAssigning(false)}>{props.t('chat.message')}</button><button type="button" data-compose-work className="dsh-agent-group-chip" aria-pressed={assigning} disabled={props.busy} onClick={() => setAssigning(true)}>{props.t('chat.assign')}</button></div>
              {assigning ? <div className="dsh-agent-group-work-compose" data-chat-work>
                <label className="dsh-agent-group-field"><span>{props.t('task.assignee')}</span><select className="dsh-agent-group-select" aria-label={props.t('task.assignee')} value={assigneeId} disabled={props.busy} onChange={event => setAssigneeId(event.target.value)}><option value="">{props.t('task.selectAssignee')}</option>{members.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
                <label className="dsh-agent-group-check"><input type="checkbox" data-allow-delegation checked={allowDelegation} disabled={props.busy} onChange={event => setAllowDelegation(event.target.checked)} />{props.t('chat.allowDelegation')}</label>
                <p className="dsh-agent-group-muted">{props.workSeed?.draftId !== undefined ? props.t('chat.confirmProposal') : props.t('chat.assignHint')}</p>
                <details><summary>{props.t('chat.briefDetails')}</summary><div className="dsh-agent-group-form">
                  <label className="dsh-agent-group-field"><span>{props.t('task.title')}</span><input className="dsh-agent-group-input" value={workTitle} disabled={props.workSeed?.draftId !== undefined || props.busy} onChange={event => setWorkTitle(event.target.value)} /></label>
                  <label className="dsh-agent-group-field"><span>{props.t('workflow.expectedArtifacts')}</span><textarea className="dsh-agent-group-textarea" value={expectedArtifacts} disabled={props.workSeed?.draftId !== undefined || props.busy} onChange={event => setExpectedArtifacts(event.target.value)} /></label>
                  <label className="dsh-agent-group-field"><span>{props.t('workflow.acceptanceCriteria')}</span><textarea className="dsh-agent-group-textarea" value={acceptanceCriteria} disabled={props.workSeed?.draftId !== undefined || props.busy} onChange={event => setAcceptanceCriteria(event.target.value)} /></label>
                </div></details>
              </div> : null}
              {selectedRoom.kind === 'group' ? <div className="dsh-agent-group-mention-row">
                <button type="button" className="dsh-agent-group-chip" onClick={() => appendMention('all')} disabled={props.busy}>@all</button>
                {members.map(agent => <button key={agent.id} type="button" className="dsh-agent-group-chip" onClick={() => appendMention(agent.name)} disabled={props.busy}>@{agent.name}</button>)}
              </div> : null}
              <div className="dsh-agent-group-compose-row">
                <textarea
                  className="dsh-agent-group-textarea"
                  aria-label={props.t('chat.message')}
                  value={props.draft}
                  readOnly={assigning && props.workSeed?.draftId !== undefined}
                  onChange={event => props.onDraftChange(event.target.value)}
                  onKeyDown={composerKeyDown}
                  placeholder={selectedRoom.kind === 'group' ? props.t('room.groupPlaceholder') : props.t('room.directPlaceholder')}
                />
                <div className="dsh-agent-group-compose-footer">
                  <span className="dsh-agent-group-compose-hint">{props.t('chat.sendShortcut')}</span>
                  <button type="button" data-send-work={assigning ? true : undefined} className="dsh-agent-group-button dsh-agent-group-send" disabled={props.busy || props.draft.trim() === '' || (assigning && !members.some(agent => agent.id === assigneeId))} onClick={() => void send()}>{assigning ? props.t('chat.assignSend') : props.t('room.send')}</button>
                </div>
              </div>
            </div>
          </>}
      </main>

      <aside className="dsh-agent-group-panel dsh-agent-group-member-panel" hidden={!membersOpen} data-open={membersOpen} aria-label={selectedRoom?.kind === 'direct' ? props.t('room.directTarget') : props.t('room.groupMembers')}>
        <div className="dsh-agent-group-section-head"><span className="dsh-agent-group-section-title">{selectedRoom?.kind === 'direct' ? props.t('room.directTarget') : props.t('room.groupMembers')}</span>{selectedRoom?.kind === 'group' ? <button type="button" className="dsh-agent-group-button" data-variant="ghost" aria-label={props.t('room.addAgent')} disabled={props.busy} onClick={() => setAddingColleague(true)}>{props.t('room.addAgent')}</button> : null}<button type="button" className="dsh-agent-group-button dsh-agent-group-member-toggle dsh-agent-group-right" data-variant="ghost" aria-label={props.t('room.hideMembers')} onClick={closeMembers}>{props.t('workspace.close')}</button></div>
        <div className="dsh-agent-group-scroll">
          <div className="dsh-agent-group-list">
            {pendingMemoryRemovals.map(reset => {
              const membership = snapshot.memberships[reset.membershipId]
              const name = membership === undefined ? reset.affectedAgentIds.map(id => snapshot.agents[id]?.name ?? id).join('、') : snapshot.agents[membership.agentId]?.name ?? membership.agentId
              return <button key={reset.id} type="button" className="dsh-agent-group-button" data-variant="ghost" data-retry-memory-removal disabled={props.busy} onClick={() => setRemovingColleague({ membershipId: reset.membershipId, name, operationId: reset.id })}>{props.t('room.retryMemoryRemoval', { name })}</button>
            })}
            {members.map(agent => {
              const membership = Object.values(snapshot.memberships).find(item => item.roomId === selectedRoomId && item.agentId === agent.id && item.leftEventId === undefined)
              return <div className="dsh-agent-group-member-card" key={agent.id} role="group" aria-label={agent.name}>
                <button type="button" className="dsh-agent-group-list-button dsh-agent-group-member-identity" data-agent-id={agent.id} onClick={() => props.onOpenColleague(agent.id)}><WorkspacePersonIdentity agent={agent} roleName={snapshot.definitions[agent.definitionId]?.name} activity={props.activity.agents[agent.id]} t={props.t} /></button>
                <div className="dsh-agent-group-member-actions">
                {selectedRoom?.kind === 'group'
                  ? <button type="button" className="dsh-agent-group-button dsh-agent-group-right" data-variant="ghost" disabled={props.busy} onClick={() => void props.onOpenDirect(agent.id)}>{props.t('room.direct')}</button>
                  : null}
                {selectedRoom?.kind === 'group' && membership !== undefined
                  ? <button type="button" className="dsh-agent-group-button" data-variant="ghost" disabled={props.busy} onClick={() => setRemovingColleague({ membershipId: membership.id, name: agent.name })}>{props.t('room.remove')}</button>
                  : null}
                </div>
              </div>
            })}
          </div>
        </div>
      </aside>
      {addingColleague && selectedRoom?.kind === 'group' ? <WorkspaceAddColleague snapshot={snapshot} candidates={candidates} busy={props.busy} onClose={() => setAddingColleague(false)} onJoin={props.onJoin} t={props.t} /> : null}
      {removingColleague !== undefined && selectedRoom?.kind === 'group' ? <WorkspaceRemoveColleague key={`${removingColleague.membershipId}:${removingColleague.operationId ?? ''}`} {...removingColleague} busy={props.busy} onClose={() => setRemovingColleague(undefined)} onLeave={leave} t={props.t} /> : null}
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
    <div className="dsh-agent-group-body dsh-agent-group-role-body">
      <aside className="dsh-agent-group-panel">
        <div className="dsh-agent-group-section-head">
          <span className="dsh-agent-group-section-title">{props.t('agent.definitions')}</span>
          <button type="button" className="dsh-agent-group-icon-button dsh-agent-group-right" disabled={props.busy} onClick={() => props.onCreatingDefinitionChange(true)} aria-label={props.t('agent.newDefinition')}><PlusIcon /></button>
        </div>
        <div className="dsh-agent-group-scroll dsh-agent-group-list">
          {definitions.map(definition => {
            const count = Object.values(props.snapshot.agents).filter(agent => agent.definitionId === definition.id).length
            return <button key={definition.id} type="button" className="dsh-agent-group-list-button" data-definition-id={definition.id} data-active={!props.creatingDefinition && definition.id === props.selectedDefinitionId} onClick={() => props.onSelectDefinition(definition.id)}>
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
