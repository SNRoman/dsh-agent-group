/** Locale-owned rendering for stable Host runtime codes. */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceActivityError } from './contracts.ts'

/** Render a stable Host error code without exposing provider-owned English prose. */
export function workspaceRuntimeErrorText(error: WorkspaceActivityError, t: TranslateNS<'agentWorkspace'>): string {
  switch (error.code) {
    case 'interrupted': return t('activity.error.interrupted')
    case 'delivery-rejected': return t('activity.error.deliveryRejected')
    case 'tool-failed': return t('activity.error.toolFailed')
    case 'agent-turn-failed': return t('activity.error.agentTurnFailed')
    default: return t('activity.error.unknown', { code: error.code })
  }
}

/** Render the finite DSH turn-end reasons through the active locale. */
export function workspaceTerminalReasonText(reason: string, t: TranslateNS<'agentWorkspace'>): string {
  switch (reason) {
    case 'completed': return t('activity.terminal.completed')
    case 'cancelled': return t('activity.terminal.cancelled')
    case 'aborted': return t('activity.terminal.aborted')
    case 'error': return t('activity.terminal.error')
    default: return t('activity.terminal.unknown', { reason })
  }
}
