/** Group membership removal with an explicit option to remove the colleague's group memory. */
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { MembershipId } from './contracts.ts'

/** @param props Selected membership, optional pending cleanup identity and the removal action. @returns A focus-contained confirmation that retains its selection and operation identity for retry. */
export function WorkspaceRemoveColleague(props: {
  readonly membershipId: MembershipId
  readonly name: string
  readonly operationId?: string
  readonly busy: boolean
  readonly onLeave: (membershipId: MembershipId, forgetMemory: boolean, operationId: string) => Promise<boolean>
  readonly onClose: () => void
  readonly t: TranslateNS<'agentWorkspace'>
}) {
  const { t } = props
  const [forgetMemory, setForgetMemory] = useState(props.operationId !== undefined)
  const [operationId] = useState(() => props.operationId ?? crypto.randomUUID())
  const [submitting, setSubmitting] = useState(false)
  const [attempted, setAttempted] = useState(props.operationId !== undefined)
  const [failed, setFailed] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const choice = useRef<HTMLInputElement>(null)
  const alive = useRef(true)
  const pending = useRef(false)
  const close = useRef(props.onClose)
  close.current = props.onClose
  useEffect(() => {
    alive.current = true
    const previous = document.activeElement
    if (choice.current?.disabled) root.current?.focus()
    else choice.current?.focus()
    return () => { alive.current = false; if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  const busy = props.busy || submitting
  const submit = async (): Promise<void> => {
    if (props.busy || pending.current) return
    pending.current = true
    setSubmitting(true)
    setAttempted(true)
    setFailed(false)
    root.current?.focus()
    let saved = false
    try { saved = await props.onLeave(props.membershipId, forgetMemory, operationId) }
    catch (_error) { /* An ambiguous result retains the original selection and cleanup identity for retry. */ }
    if (!alive.current) return
    pending.current = false
    setSubmitting(false)
    if (saved) close.current()
    else setFailed(true)
  }
  const keyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) close.current(); return }
    if (event.key !== 'Tab') return
    const controls = [...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)') ?? [])]
    const first = controls[0], last = controls.at(-1)
    if (first === undefined) { event.preventDefault(); root.current?.focus(); return }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === root.current)) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root.current)) { event.preventDefault(); first.focus() }
  }
  return <div className="dsh-agent-group-modal dsh-agent-group-remove-colleague-modal">
    <div ref={root} className="dsh-agent-group-modal-card" role="dialog" aria-modal="true" aria-label={t('room.removeTitle')} data-remove-colleague tabIndex={-1} onKeyDown={keyDown}>
      <h2>{t('room.removeTitle')}</h2>
      <p>{t('room.removeConfirm', { name: props.name })}</p>
      <label className="dsh-agent-group-check"><input ref={choice} type="checkbox" checked={forgetMemory} disabled={busy || attempted} onChange={event => setForgetMemory(event.target.checked)} />{t('room.removeMemory')}</label>
      <p className="dsh-agent-group-muted">{t('room.removeMemoryHint')}</p>
      <p className="dsh-agent-group-muted">{t('room.removeMemoryScope')}</p>
      <p className="dsh-agent-group-muted">{t('room.removePreserved')}</p>
      <p className="dsh-agent-group-muted">{t('room.rejoinHistory')}</p>
      {failed ? <p className="dsh-agent-group-error" role="alert">{t('room.removeFailed')}</p> : null}
      <div className="dsh-agent-group-inline">
        <button type="button" className="dsh-agent-group-button" data-variant="ghost" disabled={busy} onClick={() => close.current()}>{t('room.cancel')}</button>
        <button type="button" className="dsh-agent-group-button" data-confirm-remove disabled={busy} onClick={() => void submit()}>{t(busy ? 'workspace.processing' : attempted ? 'workspace.retry' : 'room.remove')}</button>
      </div>
    </div>
  </div>
}
