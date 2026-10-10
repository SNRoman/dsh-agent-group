/** Organization directory shell around the existing organization workbench. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { WorkspaceOverlay, type WorkspaceOverlayProps } from './WorkspaceUi.tsx'
import type { WorkspaceDirectoryEntry, WorkspaceImportPreview } from './contracts.ts'

/** @param props Root-scoped overlay registration props. @returns Organization directory workbench. */
export function WorkspaceOrganizations({ api, useStore, actions, t, ...runtime }: WorkspaceOverlayProps) {
  const ui = useStore(state => state)
  const [directory, setDirectory] = useState<readonly WorkspaceDirectoryEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [label, setLabel] = useState('')
  const [archiveMode, setArchiveMode] = useState<'stop' | 'wait'>('stop')
  const [exportWarning, setExportWarning] = useState(false)
  const [importDraft, setImportDraft] = useState<{ readonly json: string; readonly preview: WorkspaceImportPreview }>()
  const [importLabel, setImportLabel] = useState('')
  const controllerRef = useRef<AbortController>()
  const directoryGeneration = useRef(0)
  const creationRef = useRef<{ readonly label: string; readonly operationId: string }>()
  const selected = loaded ? directory.find(entry => entry.descriptor.id === ui.selectedWorkspaceId)?.descriptor : undefined
  const scopeKey = selected === undefined ? undefined : `${selected.id}:${selected.lifecycle}`
  const scopeOwner = useMemo(() => ({ key: scopeKey }), [scopeKey])
  const currentScope = useRef<typeof scopeOwner | undefined>(scopeOwner)
  currentScope.current = scopeOwner
  const selectionRef = useRef(ui.selectedWorkspaceId)
  selectionRef.current = ui.selectedWorkspaceId
  const cancelOperation = useCallback((): void => {
    controllerRef.current?.abort()
    controllerRef.current = undefined
    setPending(false)
    setExportWarning(false)
    setImportDraft(undefined)
    setFailed(false)
  }, [])
  const scopedApi = useMemo(() => selected === undefined ? undefined : api.forWorkspace(selected.id, selected.lifecycle === 'archived'), [api, selected?.id, selected?.lifecycle])
  const scopedActions = useMemo(() => Object.fromEntries(Object.entries(actions).map(([name, action]) => [name, (...args: never[]) => {
    if (currentScope.current !== scopeOwner) return
    if (name === 'close') cancelOperation()
    Reflect.apply(action, undefined, args)
  }])) as typeof actions, [actions, scopeOwner, cancelOperation])

  useEffect(() => {
    if (!ui.open) { cancelOperation(); return }
    const controller = new AbortController()
    const generation = ++directoryGeneration.current
    setLoaded(false)
    setFailed(false)
    void api.listOrganizations(controller.signal).then(entries => {
      if (controller.signal.aborted || generation !== directoryGeneration.current) return
      setDirectory(entries)
      setLoaded(true)
      const chosen = entries.find(entry => entry.descriptor.id === selectionRef.current)?.descriptor.id ?? entries[0]?.descriptor.id
      if (chosen !== undefined) actions.selectWorkspace(chosen)
    }).catch(() => { if (!controller.signal.aborted && generation === directoryGeneration.current) setFailed(true) })
    return () => {
      controller.abort()
      controllerRef.current?.abort()
      directoryGeneration.current += 1
      currentScope.current = undefined
    }
  }, [ui.open, api, actions, cancelOperation])

  useEffect(() => { setLabel(selected?.label ?? '') }, [selected?.id, selected?.label])

  if (!ui.open) return null

  const switchOrganization = (id: string): void => {
    cancelOperation()
    currentScope.current = undefined
    actions.selectWorkspace(id)
  }
  const run = async (operation: (signal: AbortSignal, live: () => boolean) => Promise<void>): Promise<void> => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    const live = (): boolean => !controller.signal.aborted && controllerRef.current === controller
    setPending(true)
    setFailed(false)
    try { await operation(controller.signal, live) }
    catch (_error) { if (live()) setFailed(true) }
    finally { if (live()) { controllerRef.current = undefined; setPending(false) } }
  }
  const refreshDirectory = async (signal: AbortSignal, live: () => boolean): Promise<void> => {
    const generation = ++directoryGeneration.current
    const entries = await api.listOrganizations(signal)
    if (live() && generation === directoryGeneration.current) { setDirectory(entries); setLoaded(true) }
  }
  const createOrganization = (): void => {
    const name = label.trim()
    if (name === '') return
    if (creationRef.current?.label !== name) creationRef.current = { label: name, operationId: crypto.randomUUID() }
    const operationId = creationRef.current.operationId
    void run(async (signal, live) => {
      const created = await api.createOrganization(name, operationId, signal)
      if (!live()) return
      await refreshDirectory(signal, live)
      if (live()) { creationRef.current = undefined; actions.selectWorkspace(created.id) }
    })
  }
  const readImportFile = (file: File): void => {
    setImportDraft(undefined)
    void run(async (signal, live) => {
      const json = await file.text()
      if (!live()) return
      const preview = await api.previewImport(json, signal)
      if (live()) { setImportDraft({ json, preview }); setImportLabel(preview.label) }
    })
  }

  return <div className="dsh-agent-group-overlay-root dsh-agent-group-organizations" role="dialog" aria-modal="true" aria-label={t('workspace.title')}>
    <section className="dsh-agent-group-organization-directory" aria-label={t('organization.directory')}>
      <label className="dsh-agent-group-field"><span>{t('organization.select')}</span><select aria-label={t('organization.select')} value={selected?.id ?? ''} onChange={event => switchOrganization(event.target.value)} disabled={!loaded || directory.length === 0}>
        {directory.map(entry => <option key={entry.descriptor.id} value={entry.descriptor.id}>{entry.descriptor.label}</option>)}
      </select></label>
      <label className="dsh-agent-group-field"><span>{t('organization.label')}</span><input aria-label={t('organization.label')} value={label} onChange={event => setLabel(event.target.value)} /></label>
      <button type="button" className="dsh-agent-group-button" disabled={pending || label.trim() === ''} onClick={createOrganization}>{t('organization.create')}</button>
      {selected !== undefined ? <>
        <button type="button" className="dsh-agent-group-button" disabled={pending || label.trim() === '' || selected.lifecycle === 'archived'} onClick={() => void run(async (signal, live) => { await api.renameOrganization(selected.id, label.trim(), signal); if (live()) await refreshDirectory(signal, live) })}>{t('organization.rename')}</button>
        {selected.lifecycle === 'active' ? <>
          <label className="dsh-agent-group-field"><span>{t('organization.archiveMode')}</span><select aria-label={t('organization.archiveMode')} value={archiveMode} onChange={event => setArchiveMode(event.target.value === 'wait' ? 'wait' : 'stop')} disabled={pending}>
            <option value="stop">{t('organization.stop')}</option><option value="wait">{t('organization.wait')}</option>
          </select></label>
          <button type="button" className="dsh-agent-group-button" disabled={pending} onClick={() => void run(async (signal, live) => { await api.archiveOrganization(selected.id, archiveMode, signal); if (live()) await refreshDirectory(signal, live) })}>{t('organization.archive')}</button>
        </> : <button type="button" className="dsh-agent-group-button" disabled={pending} onClick={() => void run(async (signal, live) => { await api.reopenOrganization(selected.id, signal); if (live()) await refreshDirectory(signal, live) })}>{t('organization.reopen')}</button>}
        <button type="button" className="dsh-agent-group-button" disabled={pending} onClick={() => setExportWarning(true)}>{t('organization.export')}</button>
      </> : null}
      <label className="dsh-agent-group-field"><span>{t('organization.import')}</span><input type="file" accept=".json,application/json" aria-label={t('organization.import')} disabled={pending} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file !== undefined) readImportFile(file) }} /></label>
      <button type="button" className="dsh-agent-group-icon-button" aria-label={t('workspace.close')} onClick={() => { cancelOperation(); actions.close() }}>{t('workspace.close')}</button>
      {failed ? <p className="dsh-agent-group-error" role="alert">{t('workspace.requestFailed')}</p> : null}
      {!loaded && !failed ? <p role="status">{t('workspace.loading')}</p> : null}
      {loaded && directory.length === 0 ? <p>{t('organization.empty')}</p> : null}
      {pending ? <p role="status">{t('workspace.processing')}</p> : null}
      {selected?.lifecycle === 'archived' ? <p role="status">{t('organization.readOnly')}</p> : null}
    </section>
    {exportWarning && selected !== undefined ? <section className="dsh-agent-group-organization-confirm" aria-label={t('organization.export')}>
      <p>{t('organization.exportWarning')}</p>
      <button type="button" className="dsh-agent-group-button" disabled={pending} onClick={() => void run(async (signal, live) => {
        const result = await api.exportOrganization(selected.id, true, signal)
        if (!live()) return
        const url = URL.createObjectURL(new Blob([result.json], { type: 'application/json' }))
        try { const anchor = document.createElement('a'); anchor.href = url; anchor.download = `organization-${selected.id}.json`; anchor.click() }
        finally { URL.revokeObjectURL(url) }
        setExportWarning(false)
      })}>{t('organization.exportConfirm')}</button>
      <button type="button" className="dsh-agent-group-button" disabled={pending} onClick={() => setExportWarning(false)}>{t('room.cancel')}</button>
    </section> : null}
    {importDraft !== undefined ? <section className="dsh-agent-group-organization-confirm" aria-label={t('organization.preview')}>
      <h2>{t('organization.preview')}</h2>
      <p>{t('organization.previewSource', { label: importDraft.preview.label, version: importDraft.preview.sourcePluginVersion })}</p>
      <p>{t('organization.previewCounts', { events: importDraft.preview.eventCount, agents: importDraft.preview.agentCount, tasks: importDraft.preview.taskCount })}</p>
      <p>{t('organization.bindingsExcluded')}</p>
      <label className="dsh-agent-group-field"><span>{t('organization.importLabel')}</span><input aria-label={t('organization.importLabel')} value={importLabel} onChange={event => setImportLabel(event.target.value)} /></label>
      <button type="button" className="dsh-agent-group-button" disabled={pending || importLabel.trim() === ''} onClick={() => void run(async (signal, live) => {
        await api.confirmImport(importDraft.preview.operationId, importDraft.json, importLabel.trim(), true, signal)
        if (!live()) return
        await refreshDirectory(signal, live)
        if (live()) setImportDraft(undefined)
      })}>{t('organization.importConfirm')}</button>
      <button type="button" className="dsh-agent-group-button" disabled={pending} onClick={() => setImportDraft(undefined)}>{t('room.cancel')}</button>
    </section> : null}
    {scopedApi !== undefined && selected !== undefined ? <WorkspaceOverlay {...runtime} key={scopeKey} api={scopedApi} useStore={useStore} actions={scopedActions} t={t} embedded readOnly={selected.lifecycle === 'archived'} /> : null}
  </div>
}
