/** Human workflow controls hosted alongside the existing task tree. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceApiClient } from './api.ts'
import type { WorkspaceSnapshot } from './contracts.ts'
import { WorkflowApiError, WorkflowInputError, WorkspaceWorkflowApi } from './workflow-api.ts'
import { WorkspaceCommunicationApi } from './communication-api.ts'
import type { CommunicationSnapshot } from './communication-api.ts'
import type { CompanyTemplateConfig, CompanyTemplatePreview, TaskBrief, WorkflowCommandMap, WorkflowEndpoint, WorkflowSnapshot } from './workflow-contracts.ts'
import { projectWorkflowResults } from './workflow-view-model.ts'

interface Props { readonly api: WorkspaceApiClient; readonly snapshot: WorkspaceSnapshot; readonly onSnapshot: (value: WorkspaceSnapshot) => void; readonly onBringToChat?: ((brief: TaskBrief, draft?: { readonly id: string; readonly revision: number }) => void) | undefined; readonly t: TranslateNS<'agentWorkspace'> }
interface BriefEditor { readonly title: string; readonly instructions: string; readonly expectedArtifacts: string; readonly acceptanceCriteria: string }
const blankBrief = (): BriefEditor => ({ title: '', instructions: '', expectedArtifacts: '', acceptanceCriteria: '' })
const editBrief = (value: TaskBrief): BriefEditor => ({ ...value, expectedArtifacts: value.expectedArtifacts.join('\n'), acceptanceCriteria: value.acceptanceCriteria.join('\n') })
const submitBrief = (value: BriefEditor): TaskBrief => ({ title: value.title.trim(), instructions: value.instructions.trim(), expectedArtifacts: value.expectedArtifacts.split(/\r?\n/u).map(item => item.trim()).filter(Boolean), acceptanceCriteria: value.acceptanceCriteria.split(/\r?\n/u).map(item => item.trim()).filter(Boolean) })
interface CompanyEditor {
  readonly colleagues: readonly { readonly key: string; readonly name: string; readonly definitionRevisionId: string }[]
  readonly groups: readonly { readonly name: string; readonly memberKeys: readonly string[] }[]
}
const blankConfig = (): CompanyEditor => ({ colleagues: [], groups: [] })
const editCompanyConfig = (value: CompanyTemplateConfig): CompanyEditor => {
  const colleagues = value.colleagues.map(c => ({ ...c, key: crypto.randomUUID() }))
  return { colleagues, groups: value.groups.map(g => ({ name: g.name, memberKeys: g.memberNames.map(name => colleagues.find(c => c.name === name)!.key) })) }
}
const submitCompanyConfig = (value: CompanyEditor): CompanyTemplateConfig => ({ colleagues: value.colleagues.map(c => ({ name: c.name, definitionRevisionId: c.definitionRevisionId })), groups: value.groups.map(g => ({ name: g.name, memberNames: g.memberKeys.map(key => value.colleagues.find(c => c.key === key)!.name) })) })
interface Retry { readonly endpoint: WorkflowEndpoint; readonly payload: WorkflowCommandMap[WorkflowEndpoint]; readonly operationId: string; readonly roomId?: string | undefined }

/** Render drafts, immutable templates, exact result reviews and selected-artifact handoffs. */
export function WorkspaceWorkflow({ api, snapshot, onSnapshot, onBringToChat, t }: Props) {
  const client = useMemo(() => new WorkspaceWorkflowApi(api), [api])
  const communicationClient = useMemo(() => new WorkspaceCommunicationApi(api), [api])
  const [pair, setPair] = useState<{ aggregate: WorkspaceSnapshot; workflow: WorkflowSnapshot; communication: CommunicationSnapshot }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [retry, setRetry] = useState<Retry>()
  const [draftId, setDraftId] = useState('')
  const [draftRevision, setDraftRevision] = useState<number>()
  const [brief, setBrief] = useState<BriefEditor>(blankBrief)
  const editor = useRef({ draftId, brief }); editor.current = { draftId, brief }
  const [assignee, setAssignee] = useState('')
  const [templateName, setTemplateName] = useState('')
  const [taskTemplateId, setTaskTemplateId] = useState('')
  const [taskRevisionId, setTaskRevisionId] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [companyId, setCompanyId] = useState('')
  const [companyRevisionId, setCompanyRevisionId] = useState('')
  const [companyConfig, setCompanyConfig] = useState<CompanyEditor>(blankConfig)
  const [preview, setPreview] = useState<CompanyTemplatePreview>()
  const [newEvents, setNewEvents] = useState(false)
  const [resultId, setResultId] = useState('')
  const [continuationRoomId, setContinuationRoomId] = useState('')
  const [artifactLabel, setArtifactLabel] = useState('')
  const [artifactSummary, setArtifactSummary] = useState('')
  const [referenceKind, setReferenceKind] = useState<'none' | 'path' | 'url'>('none')
  const [referenceValue, setReferenceValue] = useState('')
  const [decision, setDecision] = useState<'accepted' | 'changes-requested'>('accepted')
  const [comment, setComment] = useState('')
  const [selectedArtifacts, setSelectedArtifacts] = useState<readonly string[]>([])
  const lifecycle = useRef({ generation: 0, active: false, controllers: new Set<AbortController>() })
  const operations = useRef(new Map<string, string>())
  const formGeneration = useRef(0)
  const currentPair = useRef(pair)
  currentPair.current = pair
  const callback = useRef(onSnapshot); callback.current = onSnapshot
  const invalidateRetry = (): void => { formGeneration.current++; setRetry(undefined) }
  const invalidateCompanyPreview = (): void => { invalidateRetry(); setPreview(undefined); setNewEvents(false) }
  const updateCompanyConfig = (update: (value: CompanyEditor) => CompanyEditor): void => { invalidateCompanyPreview(); setCompanyConfig(update) }
  const expected = (p: NonNullable<typeof pair>) => ({ expectedAggregateRevision: p.aggregate.revision, expectedWorkflowRevision: p.workflow.workflow.revision })
  const request = () => {
    const scope = lifecycle.current
    const controller = new AbortController(); scope.controllers.add(controller)
    const generation = scope.generation
    return { controller, live: () => scope.active && scope.generation === generation && !controller.signal.aborted, done: () => scope.controllers.delete(controller) }
  }
  const refresh = async (): Promise<NonNullable<typeof pair> | undefined> => {
    const flight = request()
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const [aggregate, workflow, communication] = await Promise.all([api.snapshot(flight.controller.signal), client.snapshot(flight.controller.signal), communicationClient.snapshot(flight.controller.signal)])
        if (!flight.live() || aggregate.workspaceId !== api.workspaceId || workflow.workspaceId !== api.workspaceId || communication.workspaceId !== api.workspaceId) return undefined
        if (aggregate.revision !== workflow.aggregateRevision || aggregate.revision !== communication.aggregateRevision || workflow.workflow.revision !== communication.workflowRevision) continue
        const current = currentPair.current
        if (current?.aggregate.workspaceId === aggregate.workspaceId && (aggregate.revision < current.aggregate.revision || workflow.workflow.revision < current.workflow.workflow.revision || communication.communication.revision < current.communication.communication.revision)) return current
        const value = { aggregate, workflow, communication }; currentPair.current = value; setPair(value); callback.current(aggregate); return value
      }
      throw new Error('Incoherent workflow snapshot')
    } catch (cause) {
      if (flight.live()) { currentPair.current = undefined; setPair(undefined) }
      throw cause
    } finally { flight.done() }
  }
  useEffect(() => {
    const scope = lifecycle.current; scope.generation++; scope.active = true
    setPair(undefined); setBusy(false); setError(undefined); setRetry(undefined); setPreview(undefined); setNewEvents(false)
    setDraftId(''); setDraftRevision(undefined); setBrief(blankBrief()); setAssignee(''); setTemplateName(''); setTaskTemplateId(''); setTaskRevisionId(''); setCompanyName(''); setCompanyId(''); setCompanyRevisionId(''); setCompanyConfig(blankConfig()); setResultId(''); setContinuationRoomId(''); setSelectedArtifacts([]); setArtifactLabel(''); setArtifactSummary(''); setReferenceKind('none'); setReferenceValue(''); setDecision('accepted'); setComment(''); operations.current.clear()
    const generation = scope.generation
    void refresh().catch(() => { if (scope.active && scope.generation === generation) setError(t('workflow.refreshFailed')) })
    return () => { scope.active = false; scope.generation++; for (const controller of scope.controllers) controller.abort(); scope.controllers.clear() }
  }, [api])
  useEffect(() => {
    if (pair !== undefined && snapshot.workspaceId === api.workspaceId && snapshot.revision > pair.aggregate.revision) {
      const generation = lifecycle.current.generation
      void refresh().catch(() => { if (lifecycle.current.active && lifecycle.current.generation === generation) setError(t('workflow.refreshFailed')) })
    }
  }, [snapshot.revision, snapshot.workspaceId, api])
  const failure = (cause: unknown): string => {
    if (cause instanceof WorkflowInputError) return t('workflow.invalidInput')
    if (cause instanceof WorkflowApiError) {
      const d = cause.details
      if (cause.code === 'stale-workflow-revision' && 'actualWorkflowRevision' in d) return t('workflow.staleWorkflow', { expected: d.expectedWorkflowRevision, actual: d.actualWorkflowRevision })
      if (cause.code === 'stale-draft-revision' && 'actualDraftRevision' in d) return t('workflow.staleDraft', { expected: d.expectedDraftRevision, actual: d.actualDraftRevision })
      if (cause.code === 'stale-revision' && 'actualRevision' in d) return t('workflow.staleAggregate', { expected: d.expectedRevision, actual: d.actualRevision })
      if (cause.code === 'workflow-read-only') return t('organization.readOnly')
      if (cause.code === 'draft-not-editable') return t('workflow.draftNotEditable')
      if (cause.code === 'workflow-operation-reused') return t('workflow.operationReused')
      if (cause.code === 'workflow-reference-invalid') return t('workflow.invalidReference')
    }
    return t('workflow.requestFailed')
  }
  const mutate = async <K extends WorkflowEndpoint>(endpoint: K, payload: WorkflowCommandMap[K], retainedId?: string, roomId?: string): Promise<void> => {
    const shown = currentPair.current
    if (shown === undefined || api.readOnly || busy) return
    if ('draftId' in payload && 'expectedDraftRevision' in payload) {
      const target = shown.workflow.workflow.drafts[payload.draftId]
      if (!target || target.revision !== payload.expectedDraftRevision || target.status !== 'draft') { invalidateRetry(); return }
    }
    const submittedGeneration = formGeneration.current
    const fingerprint = JSON.stringify([endpoint, payload, roomId])
    const operationId = retainedId ?? operations.current.get(fingerprint) ?? crypto.randomUUID()
    operations.current.set(fingerprint, operationId)
    const flight = request(); setBusy(true); setError(undefined); setRetry(undefined)
    let committed = false
    try {
      await client.mutate(endpoint, payload, expected(shown), operationId, flight.controller.signal, roomId)
      committed = true
      if (!flight.live()) return
      const refreshed = await refresh()
      if (!flight.live()) return
      if (endpoint === 'workflow/draft/edit' && 'draftId' in payload && 'brief' in payload && 'expectedDraftRevision' in payload) {
        const saved = refreshed?.workflow.workflow.drafts[payload.draftId]
        if (saved?.revision === payload.expectedDraftRevision + 1 && editor.current.draftId === payload.draftId && JSON.stringify(submitBrief(editor.current.brief)) === JSON.stringify(payload.brief)) {
          setDraftRevision(saved.revision); setBrief(editBrief(saved.brief))
        }
      }
      operations.current.delete(fingerprint)
      if (formGeneration.current === submittedGeneration) {
        setPreview(undefined); setNewEvents(false)
        if (endpoint === 'workflow/draft/create') { setBrief(blankBrief()); setAssignee('') }
        if (endpoint === 'workflow/artifact/register') { setArtifactLabel(''); setArtifactSummary(''); setReferenceValue('') }
      }
    } catch (cause) {
      if (!flight.live()) return
      const message = committed ? t('workflow.savedRefreshFailed') : cause instanceof WorkflowApiError || cause instanceof WorkflowInputError ? failure(cause) : t('workflow.outcomeUnknown')
      let refreshed: NonNullable<typeof pair> | undefined
      try { refreshed = await refresh() } catch { /* The existing pair remains visible until an explicit refresh succeeds. */ }
      if (!flight.live()) return
      setError(message)
      const draft = 'draftId' in payload && refreshed ? refreshed.workflow.workflow.drafts[payload.draftId] : undefined
      const changedDraft = 'expectedDraftRevision' in payload && (draft === undefined || draft.revision !== payload.expectedDraftRevision || draft.status !== 'draft')
      if (!changedDraft && refreshed !== undefined && formGeneration.current === submittedGeneration) setRetry({ endpoint, payload, operationId, roomId })
    } finally { flight.done(); if (flight.live()) setBusy(false) }
  }
  const doPreview = async (): Promise<void> => {
    const shown = currentPair.current; if (!shown || companyRevisionId === '' || busy) return
    const previewGeneration = formGeneration.current
    const flight = request(); setBusy(true); setError(undefined); setPreview(undefined); setNewEvents(false)
    try { const value = await client.previewCompanyTemplate(companyRevisionId, expected(shown), flight.controller.signal); if (flight.live() && formGeneration.current === previewGeneration) setPreview(value) }
    catch (cause) {
      if (!flight.live()) return
      try { await refresh() } catch { /* Preserve the displayed pair until the next explicit refresh. */ }
      if (flight.live()) setError(failure(cause))
    }
    finally { flight.done(); if (flight.live()) setBusy(false) }
  }
  const workflow = pair?.workflow.workflow
  const aggregate = pair?.aggregate ?? snapshot
  const draft = workflow?.drafts[draftId]
  const outdatedDraft = draft !== undefined && draftRevision !== draft.revision
  useEffect(() => {
    if (workflow === undefined) return
    if ((draftId !== '' && !Object.hasOwn(workflow.drafts, draftId)) || (taskTemplateId !== '' && !Object.hasOwn(workflow.taskTemplates, taskTemplateId)) || (taskRevisionId !== '' && !Object.hasOwn(workflow.taskTemplateRevisions, taskRevisionId))) {
      invalidateRetry(); setDraftId(''); setDraftRevision(undefined); setBrief(blankBrief()); setAssignee(''); setTaskTemplateId(''); setTaskRevisionId('')
    }
  }, [workflow, draftId, taskTemplateId, taskRevisionId])
  useEffect(() => {
    if (retry && 'draftId' in retry.payload && 'expectedDraftRevision' in retry.payload) {
      const target = workflow?.drafts[retry.payload.draftId]
      if (!target || target.revision !== retry.payload.expectedDraftRevision || target.status !== 'draft') setRetry(undefined)
    }
  }, [workflow, retry])
  const results = useMemo(() => {
    if (workflow === undefined || pair === undefined || pair.aggregate.revision < snapshot.revision) return []
    const resets = Object.values(pair.communication.communication.resets)
    const invalidEvents = new Set(resets.flatMap(reset => reset.invalidatedEventIds))
    const invalidTasks = new Set(resets.flatMap(reset => reset.invalidatedTaskIds))
    return projectWorkflowResults(aggregate, workflow).filter(result => !invalidEvents.has(result.result.eventId) && !invalidTasks.has(result.result.taskId))
  }, [aggregate, workflow, pair, snapshot.revision])
  const result = results.find(r => r.result.eventId === resultId)
  const disabled = api.readOnly || busy || !pair
  const validBrief = brief.title.trim() !== '' && brief.instructions.trim() !== ''
  const employed = Object.values(aggregate.agents).filter(a => a.employmentStatus === 'employed')
  const continuationRooms = Object.values(aggregate.rooms).filter(room => Object.values(aggregate.memberships).some(member => member.roomId === room.id && member.leftEventId === undefined && aggregate.agents[member.agentId]?.employmentStatus === 'employed'))
  const validContinuationRoom = continuationRooms.some(room => room.id === continuationRoomId)
  const field = (key: Parameters<typeof t>[0], value: string, update: (value: string) => void, multiline = false) => <label className="dsh-agent-group-field"><span>{t(key)}</span>{multiline ? <textarea className="dsh-agent-group-textarea" value={value} onChange={e => update(e.target.value)} /> : <input className="dsh-agent-group-input" value={value} onChange={e => update(e.target.value)} />}</label>
  const action = (key: Parameters<typeof t>[0], blocked: boolean, run: () => void) => <button type="button" className="dsh-agent-group-button" data-variant={key === 'workflow.discardDraft' ? 'danger' : key === 'workflow.createDraft' || key === 'workflow.confirmDraft' || key === 'workflow.confirmCompany' ? undefined : 'ghost'} disabled={disabled || blocked} onClick={run}>{t(key)}</button>
  const briefFields = <>
    {field('workflow.title', brief.title, value => setBrief(b => ({ ...b, title: value })))}
    {field('workflow.instructions', brief.instructions, value => setBrief(b => ({ ...b, instructions: value })), true)}
    {field('workflow.expectedArtifacts', brief.expectedArtifacts, value => setBrief(b => ({ ...b, expectedArtifacts: value })), true)}
    {field('workflow.acceptanceCriteria', brief.acceptanceCriteria, value => setBrief(b => ({ ...b, acceptanceCriteria: value })), true)}
  </>
  return <section className="dsh-agent-group-workflow" aria-label={t('workflow.titleSection')} onChangeCapture={invalidateRetry}>
    <div className="dsh-agent-group-workflow-head">
      <div><h3>{t('workflow.titleSection')}</h3>
        {pair ? <p className="dsh-agent-group-muted" role="status">{t('workflow.revisions', { aggregate: pair.aggregate.revision, workflow: pair.workflow.workflow.revision })}</p> : <p className="dsh-agent-group-muted">{t('workspace.loading')}</p>}
      </div>
      <button type="button" className="dsh-agent-group-button" data-variant="ghost" disabled={busy} onClick={() => { const generation = lifecycle.current.generation; void refresh().catch(() => { if (lifecycle.current.active && lifecycle.current.generation === generation) setError(t('workflow.refreshFailed')) }) }}>{t('workflow.refresh')}</button>
    </div>
    {error ? <p role="alert">{error}</p> : null}
    {retry ? action('workflow.retry', false, () => { void mutate(retry.endpoint, retry.payload, retry.operationId, retry.roomId) }) : null}
    <details open><summary>{t('workflow.drafts')}</summary><div className="dsh-agent-group-form">
      <label className="dsh-agent-group-field"><span>{t('workflow.draft')}</span><select value={draftId} onChange={e => { const value = e.target.value; const selected = workflow?.drafts[value]; setDraftId(value); setDraftRevision(selected?.revision); setAssignee(''); setRetry(undefined); setBrief(selected ? editBrief(selected.brief) : blankBrief()) }}><option value="">{t('workflow.newDraft')}</option>{Object.values(workflow?.drafts ?? {}).map(d => <option key={d.id} value={d.id}>{t('workflow.draftOption', { title: d.brief.title, id: d.id, status: t(`workflow.status.${d.status}`) })}</option>)}</select></label>
      {draft ? <p>{t('workflow.draftRevision', { revision: draft.revision })}</p> : null}
      {draft && outdatedDraft ? <div role="status"><p>{t('workflow.editorOutdated', { loaded: draftRevision ?? 0, current: draft.revision })}</p><button type="button" className="dsh-agent-group-button" disabled={busy} onClick={() => { invalidateRetry(); setDraftRevision(draft.revision); setBrief(editBrief(draft.brief)); setAssignee('') }}>{t('workflow.reloadDraft')}</button></div> : null}
      {draft ? <p>{t(`workflow.source.${draft.source.type}`, { id: 'id' in draft.source ? draft.source.id : draft.source.type === 'changes-requested' ? draft.source.reviewId : draft.source.result.eventId })}</p> : null}
      {draft?.templateRevisionId ? <p>{t('workflow.pinnedTaskRevision', { id: draft.templateRevisionId })}</p> : null}
      {draft?.handoff ? <div>
        <p>{t('workflow.resultIdentity', { task: draft.handoff.result.taskId, event: draft.handoff.result.eventId, attempt: draft.handoff.result.attemptId })}</p>
        <pre>{draft.handoff.text}</pre>
        {draft.handoff.type === 'task/result-after-cancel' ? <p>{t('workflow.cancelledHandoff')}</p> : null}
        {draft.handoff.reviewComment ? <p>{t('workflow.reviewContext', { comment: draft.handoff.reviewComment })}</p> : null}
        {draft.handoff.artifacts.map(a => <p key={a.id}>{t('workflow.artifactDisplay', { label: a.label, summary: a.summary })}{a.reference ? <span>{t('workflow.referenceDisplay', { notice: t('workflow.unverified'), value: a.reference.value })}</span> : null}</p>)}
      </div> : null}
      {draft ? briefFields : <p>{t('work.chatHint')}</p>}
      <label className="dsh-agent-group-field"><span>{t('workflow.assignee')}</span><select value={assignee} onChange={e => setAssignee(e.target.value)}><option value="">{t('task.selectAssignee')}</option>{employed.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      {draftId === '' ? null : <>
        {action('workflow.saveDraft', !validBrief || draft?.status !== 'draft' || outdatedDraft, () => { if (draft && draftRevision !== undefined && !outdatedDraft) void mutate('workflow/draft/edit', { draftId, expectedDraftRevision: draftRevision, brief: submitBrief(brief) }) })}
        {action('workflow.discardDraft', draft?.status !== 'draft' || outdatedDraft, () => { if (draft && draftRevision !== undefined && !outdatedDraft) void mutate('workflow/draft/discard', { draftId, expectedDraftRevision: draftRevision }) })}
        {action('chat.confirmInChat', draft?.status !== 'draft' || outdatedDraft || onBringToChat === undefined || JSON.stringify(submitBrief(brief)) !== JSON.stringify(draft?.brief), () => { if (draft && draftRevision !== undefined && !outdatedDraft) onBringToChat?.(draft.brief, { id: draft.id, revision: draftRevision }) })}
      </>}
      <p>{t('workflow.confirmHint')}</p>
    </div></details>
    <details><summary>{t('workflow.taskTemplates')}</summary><div className="dsh-agent-group-form">
      {field('workflow.templateName', templateName, setTemplateName)}
      <label className="dsh-agent-group-field"><span>{t('workflow.taskTemplate')}</span><select value={taskTemplateId} onChange={e => { const id = e.target.value; setTaskTemplateId(id); const root = workflow?.taskTemplates[id]; setTaskRevisionId(root?.currentRevisionId ?? ''); if (root) { setTemplateName(root.name); const revision = workflow?.taskTemplateRevisions[root.currentRevisionId]; setBrief(revision ? editBrief(revision.brief) : blankBrief()) } }}><option value="">{t('workflow.newTemplate')}</option>{Object.values(workflow?.taskTemplates ?? {}).map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
      <p>{t('workflow.templateBriefHint')}</p>
      {action('workflow.createTaskTemplate', !validBrief || templateName.trim() === '', () => { void mutate('workflow/task-template/create', { name: templateName, brief: submitBrief(brief) }) })}
      {action('workflow.reviseTaskTemplate', taskTemplateId === '' || !validBrief, () => { void mutate('workflow/task-template/revise', { templateId: taskTemplateId, brief: submitBrief(brief) }) })}
      <label className="dsh-agent-group-field"><span>{t('workflow.templateRevision')}</span><select value={taskRevisionId} onChange={e => setTaskRevisionId(e.target.value)}><option value="">{t('workflow.selectRevision')}</option>{Object.values(workflow?.taskTemplateRevisions ?? {}).map(v => <option key={v.id} value={v.id}>{t('workflow.revisionOption', { name: workflow?.taskTemplates[v.templateId]?.name ?? '', number: v.number, id: v.id })}</option>)}</select></label>
      {action('chat.templateToChat', taskRevisionId === '' || onBringToChat === undefined, () => { const revision = workflow?.taskTemplateRevisions[taskRevisionId]; if (revision) onBringToChat?.(revision.brief) })}
    </div></details>
    <details><summary>{t('workflow.companyTemplates')}</summary><div className="dsh-agent-group-form">
      {field('workflow.companyName', companyName, value => { invalidateCompanyPreview(); setCompanyName(value) })}
      <label className="dsh-agent-group-field"><span>{t('workflow.companyTemplate')}</span><select value={companyId} onChange={e => { const id = e.target.value; invalidateCompanyPreview(); setCompanyId(id); const root = workflow?.companyTemplates[id]; if (root) { setCompanyName(root.name); setCompanyRevisionId(root.currentRevisionId); const revision = workflow?.companyTemplateRevisions[root.currentRevisionId]; setCompanyConfig(revision ? editCompanyConfig(revision.config) : blankConfig()) } }}><option value="">{t('workflow.newTemplate')}</option>{Object.values(workflow?.companyTemplates ?? {}).map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
      {companyConfig.colleagues.map((c, index) => <div key={c.key}>
        {field('workflow.colleagueName', c.name, name => updateCompanyConfig(v => ({ ...v, colleagues: v.colleagues.map((entry, i) => i === index ? { ...entry, name } : entry) })))}
        <label className="dsh-agent-group-field"><span>{t('workflow.roleRevision')}</span><select value={c.definitionRevisionId} onChange={e => updateCompanyConfig(v => ({ ...v, colleagues: v.colleagues.map((entry, i) => i === index ? { ...entry, definitionRevisionId: e.target.value } : entry) }))}><option value="">{t('workflow.selectRevision')}</option>{Object.values(aggregate.definitionRevisions).map(v => <option key={v.id} value={v.id}>{t('workflow.revisionOption', { name: aggregate.definitions[v.definitionId]?.name ?? '', number: v.number, id: v.id })}</option>)}</select></label>
        {action('workflow.removeColleague', false, () => updateCompanyConfig(v => ({ ...v, colleagues: v.colleagues.filter(entry => entry.key !== c.key), groups: v.groups.map(g => ({ ...g, memberKeys: g.memberKeys.filter(key => key !== c.key) })) })))}
      </div>)}
      {action('workflow.addColleague', false, () => { const key = crypto.randomUUID(); updateCompanyConfig(v => ({ ...v, colleagues: [...v.colleagues, { key, name: '', definitionRevisionId: '' }] })) })}
      {companyConfig.groups.map((g, index) => <div key={index}>
        {field('workflow.groupName', g.name, name => updateCompanyConfig(v => ({ ...v, groups: v.groups.map((entry, i) => i === index ? { ...entry, name } : entry) })))}
        {companyConfig.colleagues.map(c => <label key={c.key}><input type="checkbox" checked={g.memberKeys.includes(c.key)} onChange={e => updateCompanyConfig(v => ({ ...v, groups: v.groups.map((entry, i) => i !== index ? entry : { ...entry, memberKeys: e.target.checked ? [...entry.memberKeys, c.key] : entry.memberKeys.filter(key => key !== c.key) }) }))} />{c.name}</label>)}
        {action('workflow.removeGroup', false, () => updateCompanyConfig(v => ({ ...v, groups: v.groups.filter((_, i) => i !== index) })))}
      </div>)}
      {action('workflow.addGroup', false, () => updateCompanyConfig(v => ({ ...v, groups: [...v.groups, { name: '', memberKeys: [] }] })))}
      {action('workflow.createCompanyTemplate', companyName.trim() === '', () => { void mutate('workflow/company-template/create', { name: companyName, config: submitCompanyConfig(companyConfig) }) })}
      {action('workflow.reviseCompanyTemplate', companyId === '', () => { void mutate('workflow/company-template/revise', { templateId: companyId, config: submitCompanyConfig(companyConfig) }) })}
      <label className="dsh-agent-group-field"><span>{t('workflow.companyRevision')}</span><select value={companyRevisionId} onChange={e => { setCompanyRevisionId(e.target.value); setPreview(undefined); setNewEvents(false) }}><option value="">{t('workflow.selectRevision')}</option>{Object.values(workflow?.companyTemplateRevisions ?? {}).map(v => <option key={v.id} value={v.id}>{t('workflow.revisionOption', { name: workflow?.companyTemplates[v.templateId]?.name ?? '', number: v.number, id: v.id })}</option>)}</select></label>
      <button type="button" className="dsh-agent-group-button" disabled={busy || !pair || companyRevisionId === ''} onClick={() => { void doPreview() }}>{t('workflow.previewCompany')}</button>
      {preview ? <div><p>{t('workflow.previewRevision', { revision: preview.templateRevisionId, aggregate: preview.aggregateRevision, workflow: preview.workflowRevision })}</p><ul>{preview.config.colleagues.map((c, i) => <li key={i}>{t('workflow.previewColleague', { name: c.name, revision: c.definitionRevisionId })}</li>)}{preview.config.groups.map((g, i) => <li key={i}>{t('workflow.previewGroup', { name: g.name, members: g.memberNames.join(t('history.listSeparator')) })}</li>)}</ul><label><input type="checkbox" checked={newEvents} disabled={disabled} onChange={e => setNewEvents(e.target.checked)} />{t('workflow.newEventsConfirm')}</label>{action('workflow.confirmCompany', !newEvents || preview.templateRevisionId !== companyRevisionId || preview.aggregateRevision !== pair?.aggregate.revision || preview.workflowRevision !== workflow?.revision, () => { void mutate('workflow/company-template/confirm', { templateRevisionId: preview.templateRevisionId, confirmed: true, memoryStart: { type: 'new-events' } }) })}</div> : null}
    </div></details>
    <details><summary>{t('workflow.results')}</summary><div className="dsh-agent-group-form">
      <label className="dsh-agent-group-field"><span>{t('workflow.result')}</span><select value={resultId} onChange={e => { setResultId(e.target.value); setSelectedArtifacts([]); setComment('') }}><option value="">{t('workflow.selectResult')}</option>{results.map(r => <option key={r.result.eventId} value={r.result.eventId}>{t('workflow.resultOption', { title: r.title, event: r.result.eventId, attempt: r.result.attemptId })}</option>)}</select></label>
      {result ? <>
        <p>{t('workflow.resultIdentity', { task: result.result.taskId, event: result.result.eventId, attempt: result.result.attemptId })}</p><pre>{result.text}</pre>
        {result.type === 'task/result-after-cancel' ? <p>{t('workflow.afterCancel', { origin: result.cancellation?.eventId ?? '', scope: result.cancellation ? t(`workflow.cancel.${result.cancellation.scope}`) : t('workflow.cancel.unknown') })}</p> : null}
        {result.reviews.map(r => <p key={r.id}>{t('workflow.reviewDisplay', { decision: t(`workflow.review.${r.decision}`), id: r.id, comment: r.comment })}</p>)}
        {result.artifacts.map(a => <label key={a.id}><input type="checkbox" checked={selectedArtifacts.includes(a.id)} disabled={disabled} onChange={e => setSelectedArtifacts(v => e.target.checked ? [...v, a.id] : v.filter(id => id !== a.id))} />{t('workflow.artifactDisplay', { label: a.label, summary: a.summary })}{a.reference ? <span>{t('workflow.referenceDisplay', { notice: t('workflow.unverified'), value: a.reference.value })}</span> : null}</label>)}
        {field('workflow.artifactLabel', artifactLabel, setArtifactLabel)}{field('workflow.artifactSummary', artifactSummary, setArtifactSummary, true)}
        <label className="dsh-agent-group-field"><span>{t('workflow.referenceKind')}</span><select value={referenceKind} onChange={e => setReferenceKind(e.target.value as typeof referenceKind)}><option value="none">{t('workflow.reference.none')}</option><option value="path">{t('workflow.reference.path')}</option><option value="url">{t('workflow.reference.url')}</option></select></label>
        {referenceKind !== 'none' ? field('workflow.referenceValue', referenceValue, setReferenceValue) : null}
        {action('workflow.registerArtifact', artifactLabel.trim() === '' || artifactSummary.trim() === '' || (referenceKind !== 'none' && referenceValue.trim() === ''), () => { void mutate('workflow/artifact/register', { result: result.result, label: artifactLabel, summary: artifactSummary, ...(referenceKind === 'none' ? {} : { reference: { kind: referenceKind, value: referenceValue } }) }) })}
        <label className="dsh-agent-group-field"><span>{t('workflow.decision')}</span><select value={decision} onChange={e => setDecision(e.target.value as typeof decision)}><option value="accepted">{t('workflow.review.accepted')}</option><option value="changes-requested">{t('workflow.review.changes-requested')}</option></select></label>
        {field('workflow.comment', comment, setComment, true)}
        <label className="dsh-agent-group-field"><span>{t('workflow.continuationRoom')}</span><select value={continuationRoomId} onChange={e => setContinuationRoomId(e.target.value)}><option value="">{t('workflow.selectContinuationRoom')}</option>{continuationRooms.map(room => <option key={room.id} value={room.id}>{room.name ?? room.id}</option>)}</select></label>
        {action('workflow.reviewResult', decision === 'changes-requested' && (comment.trim() === '' || !validContinuationRoom), () => { void mutate('workflow/result/review', { result: result.result, decision, comment }, undefined, decision === 'changes-requested' ? continuationRoomId : undefined) })}
        {action('workflow.handoff', !validContinuationRoom, () => { void mutate('workflow/result/handoff', { result: result.result, artifactIds: selectedArtifacts }, undefined, continuationRoomId) })}
        <p>{t('workflow.handoffHint')}</p>
      </> : null}
    </div></details>
  </section>
}
