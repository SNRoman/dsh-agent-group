/** Additive Agent Workspace Browser surfaces. */

import { useEffect, useMemo, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { WorkspaceApiClient } from './api.ts'
import type {
  AgentDefinitionId,
  AgentId,
  MembershipId,
  RoomId,
  WorkspaceSnapshot,
  WorkspaceTurnProjection,
  WorkspaceTurnStreamSnapshot,
} from './contracts.ts'
import type { createWorkspaceUiStore } from './store.ts'
import { WorkspaceLiveTurn, WorkspaceMarkdownMessage } from './WorkspaceTurn.tsx'
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

export type WorkspaceFooterActionProps = PropsRuntime<'sidebar.footer.action'> & WorkspaceStoreProps
export type WorkspaceOverlayProps = PropsRuntime<'shell.overlay'> & WorkspaceStoreProps & { readonly api: WorkspaceApiClient }

const EMPTY_TURN_STREAM: WorkspaceTurnStreamSnapshot = { version: 0, workspaceRevision: 0, turns: [] }

/** Additive sidebar footer action. It owns no DSH navigation state. */
export function WorkspaceFooterAction({ wide, actions }: WorkspaceFooterActionProps) {
  return (
    <button
      type="button"
      className="dsh-agent-group-footer-button"
      data-wide={wide ? 'true' : 'false'}
      onClick={() => actions.open()}
      title="智能体工作区"
      aria-label="打开智能体工作区"
    >
      <WorkspaceIcon />
      {wide ? <span>智能体工作区</span> : null}
    </button>
  )
}

/** Full workbench rendered only while the plugin-local open flag is true. */
export function WorkspaceOverlay({ useStore, actions, api }: WorkspaceOverlayProps) {
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
  const [syncExisting, setSyncExisting] = useState(true)
  const [turnStream, setTurnStream] = useState<WorkspaceTurnStreamSnapshot>(EMPTY_TURN_STREAM)
  const [streamError, setStreamError] = useState<string | undefined>()

  // One cancellation-aware long-poll subscription replaces the former timer
  // polling. Stream versions wake the Browser only when authoritative Session
  // output or the durable workspace revision actually changes.
  useEffect(() => {
    if (!ui.open) {
      setTurnStream(EMPTY_TURN_STREAM)
      setStreamError(undefined)
      return
    }
    const controller = new AbortController()
    const subscribe = async (): Promise<void> => {
      actions.setBusy(true)
      actions.setError(undefined)
      try {
        const [initialSnapshot, initialStream] = await Promise.all([
          api.snapshot(controller.signal),
          api.streamSnapshot(controller.signal),
        ])
        if (controller.signal.aborted) return
        actions.setSnapshot(initialSnapshot)
        setTurnStream(initialStream)
        setStreamError(undefined)
        actions.setBusy(false)

        let durableRevision = initialSnapshot.revision
        let currentVersion = initialStream.version
        while (!controller.signal.aborted) {
          const next = await api.waitForStream(currentVersion, controller.signal)
          if (controller.signal.aborted) return
          currentVersion = next.version
          setTurnStream(next)
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
          const message = errorMessage(error)
          setStreamError(message)
          actions.setError(message)
        }
      } finally {
        if (!controller.signal.aborted) actions.setBusy(false)
      }
    }
    void subscribe()
    return () => controller.abort()
  }, [ui.open, api, actions])

  useEffect(() => {
    if (!ui.open) return
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') actions.close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [ui.open, actions])

  const snapshot = ui.snapshot
  const rooms = useMemo(() => snapshot === undefined ? [] : Object.values(snapshot.rooms), [snapshot])
  const definitions = useMemo(() => snapshot === undefined ? [] : Object.values(snapshot.definitions), [snapshot])

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
  const pendingDispatches = turnStream.turns.filter(turn => turn.status === 'running').length

  useEffect(() => {
    setRevisionDescription(selectedRevision?.description ?? '')
    setRevisionInstructions(selectedRevision?.instructions ?? '')
  }, [selectedRevision?.id])

  if (!ui.open) return null

  const commit = async (operation: () => Promise<WorkspaceSnapshot>): Promise<boolean> => {
    actions.setBusy(true)
    actions.setError(undefined)
    try {
      actions.setSnapshot(await operation())
      return true
    } catch (error) {
      actions.setError(errorMessage(error))
      return false
    } finally {
      actions.setBusy(false)
    }
  }

  const openDirect = async (agentId: AgentId): Promise<void> => {
    actions.setBusy(true)
    actions.setError(undefined)
    try {
      const result = await api.openDirect(agentId)
      actions.setSnapshot(result.snapshot)
      actions.selectRoom(result.roomId)
      actions.setMode('chat')
    } catch (error) {
      actions.setError(errorMessage(error))
    } finally {
      actions.setBusy(false)
    }
  }

  return (
    <div className="dsh-agent-group-overlay-root" role="dialog" aria-modal="true" aria-label="智能体工作区">
      <section className="dsh-agent-group-workbench">
        <header className="dsh-agent-group-topbar">
          <WorkspaceIcon />
          <span className="dsh-agent-group-title">智能体工作区</span>
          <nav className="dsh-agent-group-tabs" aria-label="工作区视图">
            <button type="button" className="dsh-agent-group-tab" data-active={ui.mode === 'chat'} onClick={() => actions.setMode('chat')}>聊天</button>
            <button type="button" className="dsh-agent-group-tab" data-active={ui.mode === 'agents'} onClick={() => actions.setMode('agents')}>智能体</button>
          </nav>
          <span className="dsh-agent-group-spacer" />
          {ui.busy
            ? <span className="dsh-agent-group-busy">处理中…</span>
            : pendingDispatches > 0
              ? <span className="dsh-agent-group-busy">智能体处理中…</span>
              : null}
          <button type="button" className="dsh-agent-group-icon-button" onClick={() => void refresh(api, actions, setTurnStream)} aria-label="刷新" title="刷新"><RefreshIcon /></button>
          <button type="button" className="dsh-agent-group-icon-button" onClick={() => actions.close()} aria-label="关闭" title="关闭"><CloseIcon /></button>
        </header>

        {ui.error !== undefined ? <div className="dsh-agent-group-error">{ui.error}</div> : null}
        {streamError !== undefined && ui.error !== streamError ? <div className="dsh-agent-group-error">实时状态连接失败：{streamError}</div> : null}
        {snapshot === undefined
          ? <div className="dsh-agent-group-empty">正在读取智能体工作区…</div>
          : ui.mode === 'chat'
            ? <ChatWorkspace
                snapshot={snapshot}
                liveTurns={turnStream.turns}
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
                  if (await commit(() => api.createGroup(name))) {
                    setRoomName('')
                    setCreatingRoom(false)
                  }
                }}
                onPost={async () => {
                  const text = draft.trim()
                  if (ui.selectedRoomId === undefined || text === '') return
                  const roomId = ui.selectedRoomId as RoomId
                  if (await commit(() => api.postMessage(roomId, text, parseRoomMentionIds(snapshot, roomId, text)))) setDraft('')
                }}
                onJoin={agentId => ui.selectedRoomId === undefined ? Promise.resolve() : commit(() => api.joinRoom(ui.selectedRoomId as RoomId, agentId)).then(() => undefined)}
                onLeave={membershipId => commit(() => api.leaveRoom(membershipId)).then(() => undefined)}
                onOpenDirect={openDirect}
              />
            : <AgentWorkspace
                snapshot={snapshot}
                selectedDefinitionId={ui.selectedDefinitionId}
                busy={ui.busy}
                creatingDefinition={creatingDefinition}
                definitionName={definitionName}
                definitionDescription={definitionDescription}
                definitionInstructions={definitionInstructions}
                revisionDescription={revisionDescription}
                revisionInstructions={revisionInstructions}
                syncExisting={syncExisting}
                agentName={agentName}
                onSelectDefinition={definitionId => {
                  actions.selectDefinition(definitionId)
                  setCreatingDefinition(false)
                }}
                onCreatingDefinitionChange={setCreatingDefinition}
                onDefinitionNameChange={setDefinitionName}
                onDefinitionDescriptionChange={setDefinitionDescription}
                onDefinitionInstructionsChange={setDefinitionInstructions}
                onRevisionDescriptionChange={setRevisionDescription}
                onRevisionInstructionsChange={setRevisionInstructions}
                onSyncExistingChange={setSyncExisting}
                onAgentNameChange={setAgentName}
                onCreateDefinition={async () => {
                  if (definitionName.trim() === '') return
                  if (await commit(() => api.createDefinition({
                    name: definitionName.trim(),
                    description: definitionDescription,
                    instructions: definitionInstructions,
                  }))) {
                    setDefinitionName('')
                    setDefinitionDescription('')
                    setDefinitionInstructions('')
                    setCreatingDefinition(false)
                  }
                }}
                onReviseDefinition={async definitionId => {
                  const agentIds = Object.values(snapshot.agents)
                    .filter(agent => agent.definitionId === definitionId)
                    .map(agent => agent.id)
                  await commit(() => api.reviseDefinition({
                    definitionId,
                    description: revisionDescription,
                    instructions: revisionInstructions,
                    ...(syncExisting ? { synchronizeAgentIds: agentIds } : {}),
                  }))
                }}
                onCreateAgent={async definitionId => {
                  const name = agentName.trim()
                  if (name === '') return
                  if (await commit(() => api.createAgent(definitionId, name))) setAgentName('')
                }}
                onSetEmployment={(agentId, employed) => commit(() => api.setEmployment(agentId, employed)).then(() => undefined)}
                onOpenDirect={openDirect}
              />}
      </section>
    </div>
  )
}

interface ChatWorkspaceProps {
  readonly snapshot: WorkspaceSnapshot
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
  readonly onJoin: (agentId: AgentId) => Promise<void>
  readonly onLeave: (membershipId: MembershipId) => Promise<void>
  readonly onOpenDirect: (agentId: AgentId) => Promise<void>
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

  useEffect(() => {
    if (!candidates.some(agent => agent.id === candidate)) setCandidate(candidates[0]?.id ?? '')
  }, [snapshot.revision, selectedRoomId])

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
    <div className="dsh-agent-group-body" data-mode="chat">
      <aside className="dsh-agent-group-panel">
        <div className="dsh-agent-group-section-head">
          <span className="dsh-agent-group-section-title">会话</span>
          <button type="button" className="dsh-agent-group-icon-button dsh-agent-group-right" onClick={() => props.onCreatingRoomChange(!props.creatingRoom)} aria-label="新建群聊"><PlusIcon /></button>
        </div>
        {props.creatingRoom ? <form className="dsh-agent-group-card" onSubmit={(event) => { event.preventDefault(); void props.onCreateRoom() }}>
          <div className="dsh-agent-group-form">
            <input className="dsh-agent-group-input" value={props.roomName} onChange={event => props.onRoomNameChange(event.target.value)} placeholder="群聊名称" autoFocus />
            <div className="dsh-agent-group-inline">
              <button type="submit" className="dsh-agent-group-button" disabled={props.busy || props.roomName.trim() === ''}>创建</button>
              <button type="button" className="dsh-agent-group-button" data-variant="ghost" onClick={() => props.onCreatingRoomChange(false)}>取消</button>
            </div>
          </div>
        </form> : null}
        <div className="dsh-agent-group-scroll dsh-agent-group-list">
          {rooms.map(room => (
            <button key={room.id} type="button" className="dsh-agent-group-list-button" data-active={room.id === selectedRoomId} onClick={() => props.onSelectRoom(room.id)}>
              <ChatIcon />
              <span>{roomLabel(snapshot, room.id)}</span>
              <small>{room.kind === 'direct' ? '私聊' : activeRoomMembers(snapshot, room.id).length}</small>
            </button>
          ))}
          {rooms.length === 0 ? <div className="dsh-agent-group-empty">还没有会话，可以新建群聊或从智能体实例发起私聊。</div> : null}
        </div>
      </aside>

      <main className="dsh-agent-group-chat">
        {selectedRoomId === undefined || selectedRoom === undefined
          ? <div className="dsh-agent-group-empty">选择一个会话后开始协作。</div>
          : <>
            <div className="dsh-agent-group-section-head">
              <span className="dsh-agent-group-section-title">{selectedRoom.kind === 'group' ? '# ' : ''}{roomLabel(snapshot, selectedRoomId)}</span>
              <span className="dsh-agent-group-muted">{selectedRoom.kind === 'direct' ? '私聊' : `${members.length} 名成员`}</span>
            </div>
            <div className="dsh-agent-group-messages">
              {messages.map(event => {
                const name = actorLabel(snapshot, event.actor)
                const text = formatMessageText(snapshot, event.text ?? '')
                return <article className="dsh-agent-group-message" key={event.id}>
                  <div className="dsh-agent-group-avatar">{name.slice(0, 1).toUpperCase()}</div>
                  <div className="dsh-agent-group-message-body">
                    <div className="dsh-agent-group-message-meta"><strong>{name}</strong><span>#{event.sequence}</span></div>
                    <div className="dsh-agent-group-message-text">
                      {event.actor?.type === 'agent' ? <WorkspaceMarkdownMessage text={text} /> : text}
                    </div>
                  </div>
                </article>
              })}
              {liveTurns.map(turn => (
                <WorkspaceLiveTurn
                  key={`${turn.sessionId}:${turn.turn}:${turn.roomId}:${turn.agentId}`}
                  turn={turn}
                  agentName={snapshot.agents[turn.agentId]?.name ?? turn.agentId}
                />
              ))}
              {messages.length === 0 && liveTurns.length === 0
                ? <div className="dsh-agent-group-empty">这个会话还没有消息。</div>
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
                  placeholder={selectedRoom.kind === 'group' ? '输入消息；可 @all 或 @成员，Ctrl/⌘ + Enter 发送' : '输入私聊消息，Ctrl/⌘ + Enter 发送'}
                />
                <button type="button" className="dsh-agent-group-button" disabled={props.busy || props.draft.trim() === ''} onClick={() => void props.onPost()}>发送</button>
              </div>
            </div>
          </>}
      </main>

      <aside className="dsh-agent-group-panel">
        <div className="dsh-agent-group-section-head"><span className="dsh-agent-group-section-title">{selectedRoom?.kind === 'direct' ? '私聊对象' : '群成员'}</span></div>
        <div className="dsh-agent-group-scroll">
          {selectedRoom?.kind === 'group' && candidates.length > 0 ? <div className="dsh-agent-group-card">
            <div className="dsh-agent-group-field">
              <label>添加智能体</label>
              <select className="dsh-agent-group-select" value={candidate} onChange={event => setCandidate(event.target.value)}>
                {candidates.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select>
            </div>
            <button type="button" className="dsh-agent-group-button" disabled={props.busy || candidate === ''} onClick={() => void props.onJoin(candidate)}>加入群聊</button>
          </div> : null}
          <div className="dsh-agent-group-list">
            {members.map(agent => {
              const membership = Object.values(snapshot.memberships).find(item => item.roomId === selectedRoomId && item.agentId === agent.id && item.leftEventId === undefined)
              return <div className="dsh-agent-group-list-button" key={agent.id}>
                <span className="dsh-agent-group-dot" data-employed="true" />
                <span>{agent.name}</span>
                {selectedRoom?.kind === 'group'
                  ? <button type="button" className="dsh-agent-group-button dsh-agent-group-right" data-variant="ghost" disabled={props.busy} onClick={() => void props.onOpenDirect(agent.id)}>私聊</button>
                  : null}
                {selectedRoom?.kind === 'group' && membership !== undefined
                  ? <button type="button" className="dsh-agent-group-button" data-variant="ghost" disabled={props.busy} onClick={() => void props.onLeave(membership.id)}>移出</button>
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
  readonly selectedDefinitionId: AgentDefinitionId | undefined
  readonly busy: boolean
  readonly creatingDefinition: boolean
  readonly definitionName: string
  readonly definitionDescription: string
  readonly definitionInstructions: string
  readonly revisionDescription: string
  readonly revisionInstructions: string
  readonly syncExisting: boolean
  readonly agentName: string
  readonly onSelectDefinition: (id: AgentDefinitionId) => void
  readonly onCreatingDefinitionChange: (value: boolean) => void
  readonly onDefinitionNameChange: (value: string) => void
  readonly onDefinitionDescriptionChange: (value: string) => void
  readonly onDefinitionInstructionsChange: (value: string) => void
  readonly onRevisionDescriptionChange: (value: string) => void
  readonly onRevisionInstructionsChange: (value: string) => void
  readonly onSyncExistingChange: (value: boolean) => void
  readonly onAgentNameChange: (value: string) => void
  readonly onCreateDefinition: () => Promise<void>
  readonly onReviseDefinition: (id: AgentDefinitionId) => Promise<void>
  readonly onCreateAgent: (id: AgentDefinitionId) => Promise<void>
  readonly onSetEmployment: (agentId: AgentId, employed: boolean) => Promise<void>
  readonly onOpenDirect: (agentId: AgentId) => Promise<void>
}

function AgentWorkspace(props: AgentWorkspaceProps) {
  const definitions = Object.values(props.snapshot.definitions)
  const selected = props.selectedDefinitionId === undefined ? undefined : props.snapshot.definitions[props.selectedDefinitionId]
  const revision = selected === undefined ? undefined : props.snapshot.definitionRevisions[selected.currentRevisionId]
  const agents = selected === undefined ? [] : Object.values(props.snapshot.agents).filter(agent => agent.definitionId === selected.id)

  return (
    <div className="dsh-agent-group-body" data-mode="agents">
      <aside className="dsh-agent-group-panel">
        <div className="dsh-agent-group-section-head">
          <span className="dsh-agent-group-section-title">智能体定义</span>
          <button type="button" className="dsh-agent-group-icon-button dsh-agent-group-right" onClick={() => props.onCreatingDefinitionChange(true)} aria-label="新建定义"><PlusIcon /></button>
        </div>
        <div className="dsh-agent-group-scroll dsh-agent-group-list">
          {definitions.map(definition => {
            const count = Object.values(props.snapshot.agents).filter(agent => agent.definitionId === definition.id).length
            return <button key={definition.id} type="button" className="dsh-agent-group-list-button" data-active={!props.creatingDefinition && definition.id === props.selectedDefinitionId} onClick={() => props.onSelectDefinition(definition.id)}>
              <BotIcon /><span>{definition.name}</span><small>{count}</small>
            </button>
          })}
          {definitions.length === 0 ? <div className="dsh-agent-group-empty">先创建一个智能体定义，例如 Java 工程师、产品经理或架构师。</div> : null}
        </div>
      </aside>

      <main className="dsh-agent-group-panel">
        <div className="dsh-agent-group-section-head">
          <span className="dsh-agent-group-section-title">{props.creatingDefinition ? '新建智能体定义' : selected?.name ?? '智能体'}</span>
          {revision !== undefined && !props.creatingDefinition ? <span className="dsh-agent-group-muted">Revision {revision.number}</span> : null}
        </div>
        <div className="dsh-agent-group-scroll">
          {props.creatingDefinition
            ? <form className="dsh-agent-group-form" onSubmit={(event: FormEvent) => { event.preventDefault(); void props.onCreateDefinition() }}>
                <Field label="名称"><input className="dsh-agent-group-input" value={props.definitionName} onChange={event => props.onDefinitionNameChange(event.target.value)} placeholder="例如：Java 工程师" autoFocus /></Field>
                <Field label="职责说明"><textarea className="dsh-agent-group-textarea" value={props.definitionDescription} onChange={event => props.onDefinitionDescriptionChange(event.target.value)} placeholder="这个角色负责什么" /></Field>
                <Field label="Instructions"><textarea className="dsh-agent-group-textarea" value={props.definitionInstructions} onChange={event => props.onDefinitionInstructionsChange(event.target.value)} placeholder="给智能体的角色指令" /></Field>
                <div className="dsh-agent-group-inline">
                  <button type="submit" className="dsh-agent-group-button" disabled={props.busy || props.definitionName.trim() === ''}>创建定义</button>
                  <button type="button" className="dsh-agent-group-button" data-variant="ghost" onClick={() => props.onCreatingDefinitionChange(false)}>取消</button>
                </div>
              </form>
            : selected === undefined || revision === undefined
              ? <div className="dsh-agent-group-empty">从左侧选择一个定义。</div>
              : <>
                  <section className="dsh-agent-group-card">
                    <div className="dsh-agent-group-form">
                      <Field label="职责说明"><textarea className="dsh-agent-group-textarea" value={props.revisionDescription} onChange={event => props.onRevisionDescriptionChange(event.target.value)} /></Field>
                      <Field label="Instructions"><textarea className="dsh-agent-group-textarea" value={props.revisionInstructions} onChange={event => props.onRevisionInstructionsChange(event.target.value)} /></Field>
                      <label className="dsh-agent-group-inline dsh-agent-group-muted">
                        <input type="checkbox" checked={props.syncExisting} onChange={event => props.onSyncExistingChange(event.target.checked)} />
                        保存新 Revision 后同步到现有实例
                      </label>
                      <div><button type="button" className="dsh-agent-group-button" disabled={props.busy} onClick={() => void props.onReviseDefinition(selected.id)}>保存新 Revision</button></div>
                    </div>
                  </section>

                  <section className="dsh-agent-group-card">
                    <div className="dsh-agent-group-card-head"><strong>实例</strong><span className="dsh-agent-group-muted">每个实例拥有独立会话、记忆和群成员关系</span></div>
                    <form className="dsh-agent-group-inline" onSubmit={(event) => { event.preventDefault(); void props.onCreateAgent(selected.id) }}>
                      <input className="dsh-agent-group-input" value={props.agentName} onChange={event => props.onAgentNameChange(event.target.value)} placeholder="实例名称，例如：后端-Alice" />
                      <button type="submit" className="dsh-agent-group-button" disabled={props.busy || props.agentName.trim() === ''}>创建实例</button>
                    </form>
                    <div className="dsh-agent-group-list">
                      {agents.map(agent => <div className="dsh-agent-group-list-button" key={agent.id}>
                        <span className="dsh-agent-group-dot" data-employed={agent.employmentStatus === 'employed'} />
                        <span>{agent.name}</span>
                        <small>{agent.employmentStatus === 'employed' ? '在职' : '已离职'}</small>
                        <button
                          type="button"
                          className="dsh-agent-group-button"
                          data-variant="ghost"
                          disabled={props.busy || agent.employmentStatus !== 'employed'}
                          onClick={() => void props.onOpenDirect(agent.id)}
                        >私聊</button>
                        <button type="button" className="dsh-agent-group-button" data-variant="ghost" disabled={props.busy} onClick={() => void props.onSetEmployment(agent.id, agent.employmentStatus !== 'employed')}>
                          {agent.employmentStatus === 'employed' ? '离职' : '重新入职'}
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

async function refresh(
  api: WorkspaceApiClient,
  actions: WorkspaceStoreProps['actions'],
  setTurnStream: (snapshot: WorkspaceTurnStreamSnapshot) => void,
): Promise<void> {
  actions.setBusy(true)
  actions.setError(undefined)
  try {
    const [snapshot, stream] = await Promise.all([api.snapshot(), api.streamSnapshot()])
    actions.setSnapshot(snapshot)
    setTurnStream(stream)
  } catch (error) {
    actions.setError(errorMessage(error))
  } finally {
    actions.setBusy(false)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function WorkspaceIcon() {
  return <svg className="dsh-agent-group-footer-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="8" cy="8" r="3"/><circle cx="16.5" cy="9.5" r="2.5"/><path d="M3.5 19c.5-3.2 2.1-5 4.5-5s4 1.8 4.5 5M13 18.5c.4-2.4 1.6-3.8 3.6-3.8 1.9 0 3.1 1.4 3.5 3.8"/></svg>
}
function ChatIcon() { return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M5 5.5h14v10H9l-4 3v-13Z"/></svg> }
function BotIcon() { return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="5" y="7" width="14" height="11" rx="3"/><path d="M12 4v3M9 12h.01M15 12h.01M9 15h6"/></svg> }
function PlusIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg> }
function CloseIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg> }
function RefreshIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M19 8a7 7 0 1 0 1 6M19 4v4h-4"/></svg> }
