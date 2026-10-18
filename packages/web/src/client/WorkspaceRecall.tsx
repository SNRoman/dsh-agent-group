/** Author-owned withdrawal preview, durable retry and separately opted-in byte recovery. */
import { useEffect, useRef, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceApiClient } from './api.ts'
import type { WorkspaceSnapshot, WorkspaceEventView } from './contracts.ts'
import { WorkspaceCommunicationApi } from './communication-api.ts'
import type { CommunicationState, CommunicationSnapshot, RecallPreview, RecallReset } from './communication-api.ts'

/** @param api Organization-scoped transport. @param revision Aggregate update checkpoint. @returns Metadata, load failure and a local retry control. */
export function useCommunicationMetadata(api: WorkspaceApiClient, revision: number) {
  const [value, setValue] = useState<CommunicationSnapshot>()
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (typeof api.callCommunication !== 'function') return
    const controller = new AbortController()
    setFailed(false)
    void new WorkspaceCommunicationApi(api).snapshot(controller.signal).then(result => {
      if (!controller.signal.aborted) setValue(result)
    }).catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => controller.abort()
  }, [api, revision, retry])
  return { value: value !== undefined && value.workspaceId === api.workspaceId && value.aggregateRevision >= revision ? value.communication : undefined, failed, refresh: () => setRetry(current => current + 1) }
}

/** @param props Authored source, current identities and an existing incomplete reset when retrying. @returns A local modal that never claims external effects were reversed. */
export function WorkspaceRecallDialog(props: {
  readonly api: WorkspaceApiClient
  readonly snapshot: WorkspaceSnapshot
  readonly event: WorkspaceEventView
  readonly reset?: RecallReset | undefined
  readonly communication?: CommunicationState | undefined
  readonly onChanged: () => Promise<void> | void
  readonly onClose: () => void
  readonly t: TranslateNS<'agentWorkspace'>
}) {
  const { t, reset } = props
  const [preview, setPreview] = useState<RecallPreview>()
  const [error, setError] = useState(false)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [restoreFiles, setRestoreFiles] = useState(reset?.fileRestoreRequested ?? false)
  const [loadRetry, setLoadRetry] = useState(0)
  const [completed, setCompleted] = useState<CommunicationSnapshot>()
  const operationId = useRef(reset?.id ?? crypto.randomUUID())
  const attempted = useRef(false)
  const modal = useRef<HTMLDivElement>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    const previous = document.activeElement
    modal.current?.focus()
    return () => { alive.current = false; if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  useEffect(() => {
    if (reset !== undefined) {
      setPreview({ affectedAgentIds: reset.affectedAgentIds, invalidatedEventIds: reset.invalidatedEventIds, invalidatedTaskIds: reset.invalidatedTaskIds, fileCheckpointIds: [], conservative: true })
    }
    const controller = new AbortController()
    setError(false)
    void new WorkspaceCommunicationApi(props.api).previewRecall({ roomId: props.event.subjectId!, eventId: props.event.id }, controller.signal)
      .then(value => { if (!controller.signal.aborted) setPreview(value) })
      .catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => controller.abort()
  }, [props.api, props.event.id, reset, loadRetry])
  const refresh = async () => {
    try { await props.onChanged(); if (alive.current) setRefreshFailed(false) }
    catch (_error) { if (alive.current) setRefreshFailed(true) }
  }
  const submit = async () => {
    if (busy || preview === undefined) return
    attempted.current = true
    setBusy(true); setError(false)
    try {
      const result = await new WorkspaceCommunicationApi(props.api).recall({ roomId: props.event.subjectId!, eventId: props.event.id, operationId: operationId.current, expectedRevision: props.snapshot.revision, restoreFiles })
      if (alive.current) setCompleted(result)
      await refresh()
    } catch (_error) {
      try { await props.onChanged() } catch (_refreshError) { /* Keep the stable retry identity after an ambiguous transport result. */ }
      if (alive.current) setError(true)
    } finally { if (alive.current) setBusy(false) }
  }
  const retryFiles = async () => {
    setBusy(true); setError(false)
    try { const result = await new WorkspaceCommunicationApi(props.api).retryFiles(operationId.current); if (alive.current) setCompleted(result); await refresh() }
    catch (_error) { if (alive.current) setError(true) }
    finally { if (alive.current) setBusy(false) }
  }
  const memoryComplete = completed !== undefined || reset?.status === 'completed'
  const metadata = completed?.communication ?? props.communication
  const outcomes = Object.values(metadata?.fileCheckpoints ?? {}).filter(checkpoint => preview?.fileCheckpointIds.includes(checkpoint.id))
  const files = preview?.files ?? []
  return <div className="dsh-agent-group-modal">
    <div className="dsh-agent-group-modal-card" role="dialog" aria-modal="true" aria-labelledby="workspace-recall-title" data-message-recall tabIndex={-1} ref={modal} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) props.onClose() }
      if (event.key !== 'Tab') return
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]'))
      const first = controls[0], last = controls.at(-1)
      if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) { event.preventDefault(); first?.focus() }
    }}>
      <h2 id="workspace-recall-title">{t('recall.title')}</h2>
      <p>{t(memoryComplete ? 'recall.memoryComplete' : 'recall.warning')}</p>
      {preview ? <>
        <p>{t('recall.people', { names: preview.affectedAgentIds.map(id => props.snapshot.agents[id]?.name ?? t('history.unknownPinned', { id })).join('、') })}</p>
        <p>{t('recall.impact', { messages: preview.invalidatedEventIds.length, tasks: preview.invalidatedTaskIds.length })}</p>
        <p className="dsh-agent-group-muted">{t('recall.untracked')}</p>
        {memoryComplete && restoreFiles ? <ul>{outcomes.map(file => <li key={file.id}>{file.path}{t('recall.separator')}{t(`recall.file.${file.restore.status}`)}</li>)}</ul> : files.length > 0 ? <ul>{files.map(file => <li key={file.id}>{file.path}{t('recall.separator')}{t(`recall.file.${file.status}`)}{file.text ? <details data-file-diff><summary>{t('recall.fileDiff')}</summary><h3>{t('recall.fileBefore')}</h3><pre>{file.text.before}</pre><h3>{t('recall.fileAfter')}</h3><pre>{file.text.after}</pre></details> : <p className="dsh-agent-group-muted">{t('recall.fileNoText')}</p>}</li>)}</ul> : null}
        {!memoryComplete && (files.some(file => file.status === 'restorable') || reset?.fileRestoreRequested) ? <label className="dsh-agent-group-field"><span><input type="checkbox" checked={restoreFiles} disabled={busy || attempted.current || reset !== undefined} onChange={event => setRestoreFiles(event.target.checked)} /> {t('recall.restoreFiles')}</span></label> : null}
      </> : !error ? <p role="status">{t('workspace.loading')}</p> : null}
      {error ? <div role="alert"><p>{t(memoryComplete ? 'workspace.requestFailed' : preview ? 'recall.failed' : 'workspace.requestFailed')}</p>{!preview || memoryComplete ? <button className="dsh-agent-group-button" type="button" onClick={() => setLoadRetry(value => value + 1)}>{t('workspace.retry')}</button> : null}</div> : null}
      {refreshFailed ? <p role="status">{t('recall.refreshFailed')} <button className="dsh-agent-group-button" type="button" onClick={() => void refresh()}>{t('workspace.retry')}</button></p> : null}
      <div className="dsh-agent-group-actions">
        <button className="dsh-agent-group-button" data-variant="ghost" type="button" disabled={busy} onClick={props.onClose}>{t('room.cancel')}</button>
        {!memoryComplete ? <button className="dsh-agent-group-button" type="button" data-confirm-recall disabled={busy || preview === undefined || props.api.readOnly} onClick={() => void submit()}>{t(busy ? 'recall.running' : attempted.current || reset !== undefined ? 'workspace.retry' : 'recall.confirm')}</button> : restoreFiles && outcomes.some(file => file.restore.status !== 'restored') ? <button className="dsh-agent-group-button" type="button" disabled={busy || props.api.readOnly} onClick={() => void retryFiles()}>{t('recall.retryFiles')}</button> : null}
      </div>
    </div>
  </div>
}
