/** Pending proposals retain their saved revisions until a human confirms them in chat. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceApiClient } from './api.ts'
import type { AgentId, RoomId, WorkspaceEventId, WorkspaceSnapshot } from './contracts.ts'
import type { ChatSource, CommunicationState } from './communication-api.ts'
import { WorkflowApiError, WorkspaceWorkflowApi } from './workflow-api.ts'
import type { TaskBrief, TaskDraft, WorkflowSnapshot, WorkflowCommandMap } from './workflow-contracts.ts'
import { roomLabel, roomMessageMentionSpans } from './view-model.ts'

/** A proposal is brought to its persisted source chat, or the user chooses a chat for old records. */
export type BringWorkToChat = (brief: TaskBrief, draft?: { readonly id: string; readonly revision: number }, source?: ChatSource) => void

interface Props {
  readonly api: WorkspaceApiClient
  readonly snapshot: WorkspaceSnapshot
  readonly communication?: CommunicationState | undefined
  readonly sourceState: 'loading' | 'ready' | 'error'
  readonly selectedAgentId?: AgentId | undefined
  readonly roomId?: RoomId | undefined
  readonly onSnapshot: (snapshot: WorkspaceSnapshot) => void
  readonly onOpenSource?: ((roomId: RoomId, eventId: WorkspaceEventId) => void) | undefined
  readonly onBringToChat?: BringWorkToChat | undefined
  readonly t: TranslateNS<'agentWorkspace'>
}
interface Pair { readonly aggregate: WorkspaceSnapshot; readonly workflow: WorkflowSnapshot }
type DraftEndpoint = 'workflow/draft/edit' | 'workflow/draft/discard'
type DraftPayload = WorkflowCommandMap[DraftEndpoint]

/** @param props Organization reads, actual sources and chat navigation. @returns Readable proposals with revision-checked edits and rejection. */
export function WorkspacePendingWork(props: Props) {
  const client = useMemo(() => new WorkspaceWorkflowApi(props.api), [props.api])
  const [pair, setPair] = useState<Pair>()
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [refreshKey, setRefreshKey] = useState(0)
  const scope = useRef({ active: false, generation: 0, reads: 0, controllers: new Set<AbortController>() })
  const currentPair = useRef(pair); currentPair.current = pair
  const onSnapshot = useRef(props.onSnapshot); onSnapshot.current = props.onSnapshot
  const available = typeof props.api.callWorkflow === 'function'

  const refresh = async (): Promise<Pair> => {
    const lifecycle = scope.current; const generation = lifecycle.generation; const read = ++lifecycle.reads
    const controller = new AbortController(); lifecycle.controllers.add(controller)
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const [aggregate, workflow] = await Promise.all([props.api.snapshot(controller.signal), client.snapshot(controller.signal)])
        if (!lifecycle.active || generation !== lifecycle.generation || controller.signal.aborted) throw new Error('Cancelled proposal read')
        if (aggregate.revision !== workflow.aggregateRevision || aggregate.revision < props.snapshot.revision) continue
        const previous = currentPair.current
        if (previous && (aggregate.revision < previous.aggregate.revision || workflow.workflow.revision < previous.workflow.workflow.revision)) { if (read === lifecycle.reads) setState('ready'); return previous }
        const value = { aggregate, workflow }
        if (read === lifecycle.reads) { currentPair.current = value; setPair(value); setState('ready'); if (aggregate.revision > props.snapshot.revision) onSnapshot.current(aggregate) }
        return value
      }
      throw new Error('Incoherent proposal revisions')
    } catch (error) { controller.abort(); throw error } finally { lifecycle.controllers.delete(controller) }
  }
  useEffect(() => {
    const lifecycle = scope.current; lifecycle.active = true; lifecycle.generation++
    setPair(undefined); currentPair.current = undefined
    return () => { lifecycle.active = false; lifecycle.generation++; for (const controller of lifecycle.controllers) controller.abort(); lifecycle.controllers.clear() }
  }, [props.api])
  useEffect(() => {
    if (!available) return
    const lifecycle = scope.current; const generation = lifecycle.generation
    setState('loading')
    void refresh().catch(() => { if (lifecycle.active && generation === lifecycle.generation) setState('error') })
  }, [props.api, props.snapshot.revision, refreshKey])

  if (!available) return null
  const invalidDraftIds = new Set(Object.values(props.communication?.resets ?? {}).flatMap(reset => reset.invalidatedDraftIds))
  const drafts = Object.values(pair?.workflow.workflow.drafts ?? {}).filter(draft => draft.status === 'draft'
    && !invalidDraftIds.has(draft.id)
    && props.communication?.messages[props.communication.draftSources[draft.id]?.eventId ?? '']?.withdrawnBy === undefined
    && (props.roomId === undefined || props.communication?.draftSources[draft.id]?.roomId === props.roomId)
    && (props.selectedAgentId === undefined || draft.suggestedAssigneeAgentId === props.selectedAgentId || (draft.source.type === 'employee' && draft.source.id === props.selectedAgentId)))
  const mutate = async (endpoint: DraftEndpoint, payload: DraftPayload, operationId: string): Promise<void> => {
    const lifecycle = scope.current; const generation = lifecycle.generation
    const controller = new AbortController(); lifecycle.controllers.add(controller)
    try {
      const current = currentPair.current
      if (!current) throw new Error('Proposals not loaded')
      await client.mutate(endpoint, payload, { expectedAggregateRevision: current.aggregate.revision, expectedWorkflowRevision: current.workflow.workflow.revision }, operationId, controller.signal)
      if (!lifecycle.active || generation !== lifecycle.generation || controller.signal.aborted) throw new Error('Cancelled proposal mutation')
      await refresh()
    } finally { lifecycle.controllers.delete(controller) }
  }
  if (props.roomId !== undefined && state === 'ready' && drafts.length === 0) return null
  const empty = state === 'ready' && drafts.length === 0
  const reload = <button type="button" className="dsh-agent-group-button" data-variant="ghost" disabled={state === 'loading'} onClick={() => setRefreshKey(value => value + 1)}>{props.t('pending.reload')}</button>
  return <section aria-label={props.t('pending.heading')} className="dsh-agent-group-form dsh-agent-group-pending-work" data-state={empty ? 'empty' : state}>
    {empty ? <div className="dsh-agent-group-toolbar dsh-agent-group-pending-empty"><p className="dsh-agent-group-muted">{props.t('pending.empty')}</p>{reload}</div> : <div className="dsh-agent-group-section-head dsh-agent-group-toolbar"><h3 className="dsh-agent-group-section-title">{props.t('pending.heading')}</h3>{reload}</div>}
    {props.api.readOnly ? <p className="dsh-agent-group-muted">{props.t('pending.readOnly')}</p> : null}
    {state === 'loading' ? <p role="status">{props.t('pending.loading')}</p> : null}
    {state === 'error' ? <p className="dsh-agent-group-error" role="alert">{props.t('pending.loadFailed')}</p> : null}
    {empty ? null : props.sourceState === 'ready' ? drafts.map(draft => <PendingCard key={`${props.api.workspaceId}:${draft.id}`} {...props} snapshot={props.snapshot.revision >= pair!.aggregate.revision ? props.snapshot : pair!.aggregate} draft={draft} disabled={state !== 'ready'} mutate={mutate} refresh={refresh} />) : <p role="status">{props.t(props.sourceState === 'loading' ? 'work.sourceLoading' : 'work.sourceFailed')}</p>}
  </section>
}

interface Editor { readonly revision: number; readonly title: string; readonly instructions: string; readonly expectedArtifacts: string; readonly acceptanceCriteria: string; readonly assignee: string }
const editorFor = (draft: TaskDraft): Editor => ({ revision: draft.revision, ...draft.brief, expectedArtifacts: draft.brief.expectedArtifacts.join('\n'), acceptanceCriteria: draft.brief.acceptanceCriteria.join('\n'), assignee: draft.suggestedAssigneeAgentId ?? '' })
const lines = (value: string): string[] => value.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)

function PendingCard(props: Props & { readonly draft: TaskDraft; readonly disabled: boolean; readonly mutate: (endpoint: DraftEndpoint, payload: DraftPayload, operationId: string) => Promise<void>; readonly refresh: () => Promise<Pair> }) {
  const { draft, t } = props
  const [editor, setEditor] = useState<Editor>()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<'action' | 'conflict'>()
  const [retry, setRetry] = useState<{ endpoint: DraftEndpoint; payload: DraftPayload; operationId: string }>()
  const mounted = useRef(true)
  const inFlight = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const source = props.communication?.draftSources[draft.id]
  const event = source && props.snapshot.events.find(item => item.id === source.eventId && item.type === 'room/message' && item.subjectId === source.roomId)
  const withdrawn = (source !== undefined && props.communication?.messages[source.eventId]?.withdrawnBy !== undefined) || Object.values(props.communication?.resets ?? {}).some(reset => reset.invalidatedDraftIds.includes(draft.id))
  const disabled = props.api.readOnly || props.disabled || busy
  const outdated = failure === 'conflict' || (editor !== undefined && editor.revision !== draft.revision)
  const sourceName = draft.source.type === 'employee' ? props.snapshot.agents[draft.source.id]?.name ?? t('actor.unavailable') : draft.source.type === 'human' ? t('pending.human') : draft.source.type === 'handoff' ? t('pending.handoff') : t('pending.changesRequested')
  const run = async (action: NonNullable<typeof retry>): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setFailure(undefined); setRetry(undefined)
    try {
      await props.mutate(action.endpoint, action.payload, action.operationId)
      if (mounted.current) setEditor(undefined)
    } catch (cause) {
      if (!mounted.current) return
      const conflict = cause instanceof WorkflowApiError && ['stale-draft-revision', 'draft-not-editable', 'stale-workflow-revision', 'stale-revision'].includes(cause.code)
      setFailure(conflict ? 'conflict' : 'action')
      if (conflict) { try { await props.refresh() } catch (error) { /* Keep local edits until the user can reload current revisions. */ } }
      else setRetry(action)
    } finally { inFlight.current = false; if (mounted.current) setBusy(false) }
  }
  const save = (): void => {
    if (!editor) return
    void run({ endpoint: 'workflow/draft/edit', operationId: crypto.randomUUID(), payload: { draftId: draft.id, expectedDraftRevision: editor.revision, brief: { title: editor.title.trim(), instructions: editor.instructions.trim(), expectedArtifacts: lines(editor.expectedArtifacts), acceptanceCriteria: lines(editor.acceptanceCriteria) }, ...(editor.assignee ? { suggestedAssigneeAgentId: editor.assignee } : {}) } })
  }
  const field = (key: 'title' | 'instructions' | 'expectedArtifacts' | 'acceptanceCriteria', label: 'workflow.title' | 'workflow.instructions' | 'workflow.expectedArtifacts' | 'workflow.acceptanceCriteria', multiline = false) => <label className="dsh-agent-group-field"><span>{t(label)}</span>{multiline ? <textarea className="dsh-agent-group-textarea" value={editor![key]} disabled={disabled} onChange={event => { setEditor(value => value ? { ...value, [key]: event.target.value } : value); setRetry(undefined) }} /> : <input className="dsh-agent-group-input" value={editor![key]} disabled={disabled} onChange={event => { setEditor(value => value ? { ...value, [key]: event.target.value } : value); setRetry(undefined) }} />}</label>
  let sourceText = event?.text ?? ''
  if (event) for (const span of roomMessageMentionSpans(props.snapshot, sourceText, event.mentions ?? []).reverse()) sourceText = `${sourceText.slice(0, span.start)}${span.label}${sourceText.slice(span.end)}`
  return <article className="dsh-agent-group-card dsh-agent-group-work-card" data-pending-work={draft.id}>
    <div className="dsh-agent-group-card-head dsh-agent-group-task-heading"><h3 className="dsh-agent-group-task-title">{draft.brief.title}</h3><span className="dsh-agent-group-task-badge">{t('pending.awaiting')}</span></div>
    <p className="dsh-agent-group-task-owner">{draft.suggestedAssigneeAgentId ? t('pending.proposedByAndOwner', { name: sourceName, owner: props.snapshot.agents[draft.suggestedAssigneeAgentId]?.name ?? t('actor.unavailable') }) : t('pending.proposedBy', { name: sourceName })}</p>
    {props.sourceState !== 'ready' ? <p className="dsh-agent-group-work-source-unavailable">{t(props.sourceState === 'loading' ? 'work.sourceLoading' : 'work.sourceFailed')}</p> : withdrawn ? <p className="dsh-agent-group-work-source-unavailable">{t('pending.withdrawn')}</p> : source && event ? <div className="dsh-agent-group-work-source"><button type="button" className="dsh-agent-group-identity" disabled={!props.onOpenSource} onClick={() => props.onOpenSource?.(source.roomId, source.eventId)}>{t('work.source', { room: roomLabel(props.snapshot, source.roomId, t) })}</button><p className="dsh-agent-group-work-source-text">{sourceText}</p></div> : <p className="dsh-agent-group-work-source-unavailable">{t('pending.sourceMissing')}</p>}
    {failure ? <p role="alert" className="dsh-agent-group-error">{t(failure === 'conflict' ? 'pending.conflict' : 'pending.actionFailed')}</p> : null}
    {outdated ? <button type="button" className="dsh-agent-group-button" disabled={disabled} onClick={() => { void props.refresh().then(value => { if (!mounted.current) return; const current = value.workflow.workflow.drafts[draft.id]; if (current?.status === 'draft') { setEditor(editorFor(current)); setFailure(undefined); setRetry(undefined) } }).catch(() => { if (mounted.current) setFailure('conflict') }) }}>{t('pending.reloadDraft')}</button> : null}
    {editor ? <div className="dsh-agent-group-form">
      {field('title', 'workflow.title')}{field('instructions', 'workflow.instructions', true)}{field('expectedArtifacts', 'workflow.expectedArtifacts', true)}{field('acceptanceCriteria', 'workflow.acceptanceCriteria', true)}
      <label className="dsh-agent-group-field"><span>{t('pending.owner')}</span><select className="dsh-agent-group-select" value={editor.assignee} disabled={disabled} onChange={event => { setEditor(value => value ? { ...value, assignee: event.target.value } : value); setRetry(undefined) }}><option value="">{t('pending.noOwner')}</option>{Object.values(props.snapshot.agents).filter(agent => agent.employmentStatus === 'employed').map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
      <div className="dsh-agent-group-inline"><button type="button" className="dsh-agent-group-button" disabled={disabled || outdated || !!withdrawn || editor.title.trim() === '' || editor.instructions.trim() === ''} onClick={save}>{t('pending.save')}</button><button type="button" className="dsh-agent-group-button" disabled={busy} onClick={() => { setEditor(undefined); setRetry(undefined); setFailure(undefined) }}>{t('pending.cancelEdit')}</button></div>
    </div> : <><p style={{ whiteSpace: 'pre-wrap' }}>{draft.brief.instructions}</p>{draft.brief.expectedArtifacts.length ? <p>{t('pending.artifacts', { value: draft.brief.expectedArtifacts.join(t('history.listSeparator')) })}</p> : null}{draft.brief.acceptanceCriteria.length ? <p>{t('pending.acceptance', { value: draft.brief.acceptanceCriteria.join(t('history.listSeparator')) })}</p> : null}</>}
    <div className="dsh-agent-group-inline dsh-agent-group-toolbar">
      {!editor ? <button type="button" className="dsh-agent-group-button" disabled={disabled || !!withdrawn} onClick={() => { setEditor(editorFor(draft)); setFailure(undefined); setRetry(undefined) }}>{t('pending.edit')}</button> : null}
      <button type="button" className="dsh-agent-group-button" disabled={disabled || editor !== undefined || outdated || !!withdrawn || props.sourceState !== 'ready' || !props.onBringToChat} onClick={() => props.onBringToChat?.(draft.brief, { id: draft.id, revision: draft.revision }, event ? source : undefined)}>{t('chat.confirmInChat')}</button>
      <button type="button" className="dsh-agent-group-button" disabled={disabled} onClick={() => { void run({ endpoint: 'workflow/draft/discard', payload: { draftId: draft.id, expectedDraftRevision: draft.revision }, operationId: crypto.randomUUID() }) }}>{t('pending.reject')}</button>
      {retry ? <button type="button" className="dsh-agent-group-button" disabled={disabled} onClick={() => { void run(retry) }}>{t('pending.retryAction')}</button> : null}
    </div>
    <details className="dsh-agent-group-record-details" data-work-details><summary>{t('pending.details')}</summary><p>{t('pending.identity', { id: draft.id, revision: draft.revision })}</p></details>
  </article>
}
