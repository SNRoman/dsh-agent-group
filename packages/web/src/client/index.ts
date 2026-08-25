/** Browser entry for the additive Agent Workspace UI. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { WorkspaceApiClient } from './api.ts'
import { createWorkspaceUiStore } from './store.ts'
import { WORKSPACE_UI_CSS, WORKSPACE_UI_STYLE_ID } from './styles.ts'
import { WorkspaceFooterAction, WorkspaceOverlay } from './WorkspaceUi.tsx'

/** Services used only by the Browser half. */
export const inject = ['slots', 'connection']

/**
 * Register two additive root-scoped entries. Nothing occupies the core
 * `sidebar`, `conversation`, or `details` single slots, so the existing DSH UI
 * keeps its render authority and unload restores the page exactly.
 */
export function apply(ctx: ClientContext): void {
  const store = createWorkspaceUiStore()
  const connection = ctx.get('connection') as ConnectionHandle
  const api = new WorkspaceApiClient(connection)

  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    // Each plugin fiber owns its own tag. A hot-reload overlap may briefly
    // duplicate equivalent scoped CSS, but disposing the old fiber can never
    // remove the new fiber's styles.
    const style = document.createElement('style')
    style.dataset.plugin = '@dsh-agent-group/web'
    style.dataset.pluginCss = WORKSPACE_UI_STYLE_ID
    style.textContent = WORKSPACE_UI_CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, 'agent-workspace: scoped styles')

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'agent-workspace',
    order: 40,
    store,
  }, WorkspaceFooterAction))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'agent-workspace',
    order: 40,
    store,
    inject: () => ({ api }),
  }, WorkspaceOverlay))
}
