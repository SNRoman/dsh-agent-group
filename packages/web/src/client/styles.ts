/** Plugin-scoped stylesheet. No selector or custom property escapes `.dsh-agent-group-*`. */

export const WORKSPACE_UI_STYLE_ID = 'dsh-agent-group/workspace-ui'

export const WORKSPACE_UI_CSS = `
.dsh-agent-group-workflow { flex: none; max-height: none; min-height: 0; overflow: visible; padding: 24px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.dsh-agent-group-workflow h3 { margin: 0; font-size: 18px; font-weight: 650; letter-spacing: -.02em; }
.dsh-agent-group-workflow-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
.dsh-agent-group-workflow-head p { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-agent-group-workflow details { margin-top: 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); }
.dsh-agent-group-workflow summary { padding: 14px 16px; cursor: pointer; font-size: 14px; font-weight: 600; }
.dsh-agent-group-workflow details[open] > summary { border-bottom: 1px solid var(--dsw-alias-border-l2); }
.dsh-agent-group-workflow summary:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-agent-group-workflow pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; line-height: 1.65; padding: 12px; border-radius: 8px; background: var(--dsw-alias-bg-module-platform); }
.dsh-agent-group-workflow .dsh-agent-group-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; padding: 18px; }
.dsh-agent-group-workflow .dsh-agent-group-form > p, .dsh-agent-group-workflow .dsh-agent-group-form > div, .dsh-agent-group-workflow .dsh-agent-group-field:has(textarea) { grid-column: 1 / -1; }
.dsh-agent-group-workflow .dsh-agent-group-form > p { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.dsh-agent-group-workflow-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.dsh-agent-group-workflow label:has(> input[type="checkbox"]) { display: inline-flex; align-items: center; gap: 8px; margin: 6px 12px 6px 0; font-size: 13px; }
.dsh-agent-group-organizations { flex-direction: column; gap: 12px; overflow: hidden; }
.dsh-agent-group-organization-directory { position: relative; z-index: 2; flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 16px; padding: 12px 18px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.dsh-agent-group-organization-heading { min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px; }
.dsh-agent-group-organization-name { font-size: 16px; font-weight: 650; overflow-wrap: anywhere; }
.dsh-agent-group-organization-counts { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-agent-group-organization-directory > .dsh-agent-group-field { width: 220px; max-width: 100%; }
.dsh-agent-group-organization-directory > p { margin: 0; flex-basis: 100%; font-size: 12px; line-height: 1.5; }
.dsh-agent-group-organization-management { margin-left: auto; }
.dsh-agent-group-organization-management > summary { padding: 9px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 9px; font-size: 13px; cursor: pointer; }
.dsh-agent-group-organization-management > summary:hover, .dsh-agent-group-organization-management[open] > summary { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-agent-group-management-form { position: absolute; z-index: 1; top: calc(100% + 8px); right: 16px; width: min(420px, calc(100vw - 40px)); max-height: min(640px, 72dvh); overflow: auto; box-sizing: border-box; display: grid; gap: 14px; padding: 20px; border: 1px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: var(--dsw-elevation-panel); }
.dsh-agent-group-management-form > p { margin: 0; font-size: 12px; line-height: 1.6; }
.dsh-agent-group-organization-workspace { flex: 1; min-width: 0; min-height: 0; }
.dsh-agent-group-organization-confirm { flex: none; max-height: 45dvh; overflow: auto; padding: 18px 20px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.dsh-agent-group-organization-confirm .dsh-agent-group-button { margin-top: 8px; margin-right: 8px; }
.dsh-agent-group-footer-button {
  width: 100%; min-height: 36px; display: flex; align-items: center; justify-content: center; gap: 8px;
  padding: 7px 10px; border: 0; border-radius: 10px; background: transparent;
  color: var(--dsw-alias-label-secondary); cursor: pointer; font: inherit;
}
.dsh-agent-group-footer-button:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-agent-group-footer-button[data-wide="true"] { justify-content: flex-start; }
.dsh-agent-group-footer-icon { width: 18px; height: 18px; flex: none; }

.dsh-agent-group-overlay-root { position: fixed; inset: 0; pointer-events: auto; display: flex; align-items: stretch; justify-content: stretch; padding: 20px; box-sizing: border-box; background: var(--dsw-alias-bg-mask-1); font-size: 14px; line-height: 1.5; }
.dsh-agent-group-workbench { position: relative; width: 100%; height: 100%; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--dsw-alias-border-l2); border-radius: 18px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: var(--dsw-elevation-panel); }
.dsh-agent-group-topbar { position: sticky; z-index: 1; top: 0; flex: none; min-height: 64px; display: flex; align-items: center; gap: 12px; padding: 0 20px; border-bottom: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
.dsh-agent-group-title { font-size: 16px; font-weight: 650; white-space: nowrap; letter-spacing: -.02em; }
.dsh-agent-group-tabs { min-width: 0; display: flex; gap: 4px; margin-left: 8px; padding: 4px; border-radius: 10px; background: var(--dsw-alias-bg-module-platform); }
.dsh-agent-group-tab, .dsh-agent-group-icon-button, .dsh-agent-group-button, .dsh-agent-group-chip { border: 0; font: inherit; color: inherit; cursor: pointer; }
.dsh-agent-group-tab { padding: 7px 12px; border-radius: 7px; background: transparent; color: var(--dsw-alias-label-secondary); white-space: nowrap; font-size: 13px; }
.dsh-agent-group-tab:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-agent-group-tab[data-active="true"] { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-state-business-primary); font-weight: 600; box-shadow: 0 1px 3px var(--dsw-alias-border-l2); }
.dsh-agent-group-spacer { flex: 1; }
.dsh-agent-group-icon-button { width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center; border-radius: 10px; background: transparent; }
.dsh-agent-group-icon-button:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-agent-group-icon-button svg { width: 18px; height: 18px; }
.dsh-agent-group-activity-trigger { width: auto; min-width: 44px; gap: 5px; padding: 0 7px; }
.dsh-agent-group-activity-count { min-width: 1ch; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-agent-group-activity-drawer { position: absolute; z-index: 2; top: 64px; right: 0; bottom: 0; width: min(640px, 100%); display: flex; flex-direction: column; overflow: auto; border-left: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-panel); }
.dsh-agent-group-activity-layout { min-height: 0; display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 10px; padding: 10px; }
.dsh-agent-group-activity-detail { min-width: 0; overflow: auto; }
.dsh-agent-group-runtime-badges { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; }

.dsh-agent-group-body { flex: 1; min-width: 0; min-height: 0; display: grid; grid-template-columns: 230px minmax(0, 1fr) 260px; background: var(--dsw-alias-bg-module-platform); }
.dsh-agent-group-body[data-mode="colleagues"] { grid-template-columns: 260px minmax(0, 1fr); }
.dsh-agent-group-body[data-mode="tasks"] { grid-template-columns: 280px minmax(0, 1fr); }
.dsh-agent-group-foundation { display: flex; grid-template-columns: 1fr; }
.dsh-agent-group-panel { min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; border-right: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
.dsh-agent-group-panel:last-child { border-right: 0; }
.dsh-agent-group-body[data-mode="tasks"] > main { display: block; overflow: auto; background: var(--dsw-alias-bg-module-platform); }
.dsh-agent-group-body[data-mode="tasks"] > main > .dsh-agent-group-scroll { overflow: visible; min-height: auto; }
.dsh-agent-group-section-head { flex: none; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-height: 50px; padding: 0 18px; border-bottom: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
.dsh-agent-group-body[data-mode="tasks"] > main > .dsh-agent-group-section-head { position: sticky; top: 0; z-index: 1; }
.dsh-agent-group-section-title { font-size: 13px; font-weight: 600; }
.dsh-agent-group-scroll { flex: 1; min-height: 0; overflow: auto; padding: 16px; }
.dsh-agent-group-list { display: flex; flex-direction: column; gap: 4px; }
.dsh-agent-group-list-button { min-width: 0; width: 100%; display: flex; align-items: center; flex-wrap: wrap; gap: 9px; padding: 11px 12px; border: 1px solid transparent; border-radius: 10px; background: transparent; color: inherit; text-align: left; cursor: pointer; font: inherit; overflow-wrap: anywhere; }
.dsh-agent-group-list-button:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-agent-group-list-button[data-active="true"] { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, var(--dsw-alias-bg-layer-1)); border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 24%, transparent); color: var(--dsw-alias-state-business-primary); }
.dsh-agent-group-list-button small { color: var(--dsw-alias-label-secondary); margin-left: auto; }
.dsh-agent-group-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-secondary); flex: none; }
.dsh-agent-group-dot[data-employed="true"] { background: var(--dsw-alias-state-success-primary); }

.dsh-agent-group-chat { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.dsh-agent-group-messages { flex: 1; min-height: 0; overflow: auto; padding: 22px 18px; display: flex; flex-direction: column; gap: 20px; }
.dsh-agent-group-message { display: flex; gap: 10px; align-items: flex-start; max-width: 88%; min-width: 0; }
.dsh-agent-group-message-body { min-width: 0; padding: 11px 15px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 4px 16px 16px; background: var(--dsw-alias-bg-layer-1); }
.dsh-agent-group-message[data-author="human"] { align-self: flex-end; flex-direction: row-reverse; }
.dsh-agent-group-message[data-author="human"] .dsh-agent-group-message-body { border-radius: 16px 4px 16px 16px; border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, var(--dsw-alias-bg-layer-1)); }
.dsh-agent-group-avatar { flex: none; width: 34px; height: 34px; border: 0; border-radius: 11px; display: flex; align-items: center; justify-content: center; background: var(--dsw-alias-interactive-bg-hover); color: inherit; font: inherit; font-weight: 600; }
button.dsh-agent-group-avatar { cursor: pointer; }
.dsh-agent-group-identity { border: 0; padding: 0; background: transparent; color: inherit; font: inherit; font-weight: 600; cursor: pointer; }
.dsh-agent-group-mention, .dsh-agent-group-message-text a[href^="#dsh-agent-group-person/"] { display: inline; padding: 1px 4px; border: 0; border-radius: 5px; background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent); color: var(--dsw-alias-state-business-primary); font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
.dsh-agent-group-mention:hover, .dsh-agent-group-identity:hover { text-decoration: underline; }
.dsh-agent-group-member-card { min-width: 0; display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; }
.dsh-agent-group-member-identity { min-width: 0; display: flex; align-items: center; gap: 9px; border: 0; padding: 0; text-align: left; color: inherit; background: transparent; font: inherit; cursor: pointer; }
.dsh-agent-group-member-identity > span:last-child { min-width: 0; overflow-wrap: anywhere; }
.dsh-agent-group-member-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.dsh-agent-group-member-actions .dsh-agent-group-button { margin-left: 0; flex: 1; padding: 6px 10px; }
.dsh-agent-group-member-toggle { display: none; }
.dsh-agent-group-rename { padding: 10px 14px; }
.dsh-agent-group-rename .dsh-agent-group-input { flex: 1; }
.dsh-agent-group-people-body { flex: 1; min-width: 0; min-height: 0; display: grid; grid-template-columns: 300px minmax(0, 1fr); }
.dsh-agent-group-people-body > aside > .dsh-agent-group-field { padding: 12px 16px 0; }
.dsh-agent-group-person-label { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.dsh-agent-group-person-label small { margin-left: 0; }
.dsh-agent-group-profile { max-width: 860px; margin: 0 auto; }
.dsh-agent-group-profile-content { display: flex; flex-direction: column; gap: 18px; }
.dsh-agent-group-profile-head { display: flex; align-items: center; gap: 12px; }
.dsh-agent-group-profile-head h2 { margin: 0; font-size: 21px; }
.dsh-agent-group-profile-prose { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7; }
.dsh-agent-group-profile-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.dsh-agent-group-profile-modal { max-width: none; z-index: 4; }
.dsh-agent-group-profile-modal .dsh-agent-group-profile { display: flex; flex-direction: column; gap: 18px; }
.dsh-agent-group-profile summary, .dsh-agent-group-role-management > summary { cursor: pointer; font-weight: 600; }
.dsh-agent-group-role-management { max-width: 1000px; margin: 24px auto 0; padding-top: 16px; border-top: 1px solid var(--dsw-alias-border-l2); }
.dsh-agent-group-role-body { grid-template-columns: 220px minmax(0, 1fr); min-height: 400px; }
.dsh-agent-group-card-head { flex-wrap: wrap; }
.dsh-agent-group-message-meta { display: flex; align-items: baseline; gap: 8px; margin-bottom: 3px; }
.dsh-agent-group-message-meta strong { font-size: 13px; }
.dsh-agent-group-message-meta span { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-agent-group-message-text { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 1.55; }
.dsh-agent-group-composer { padding: 10px 14px 14px; border-top: 1px solid var(--dsw-alias-border-l2); }
.dsh-agent-group-composer { flex: none; }
.dsh-agent-group-mention-row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 7px; }
.dsh-agent-group-chip { padding: 4px 8px; border-radius: 8px; background: var(--dsw-alias-interactive-bg-hover); font-size: 12px; }
.dsh-agent-group-compose-row { display: flex; gap: 8px; align-items: flex-end; }

.dsh-agent-group-input, .dsh-agent-group-textarea, .dsh-agent-group-select, .dsh-agent-group-field > input:not([type="checkbox"]), .dsh-agent-group-field > select, .dsh-agent-group-field > textarea { min-width: 0; width: 100%; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l4); border-radius: 9px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; }
.dsh-agent-group-input:not(textarea), .dsh-agent-group-select, .dsh-agent-group-field > input:not([type="checkbox"]), .dsh-agent-group-field > select { height: 38px; padding: 0 11px; }
.dsh-agent-group-textarea, textarea.dsh-agent-group-input, .dsh-agent-group-field > textarea { height: auto; min-height: 96px; resize: vertical; padding: 11px 12px; line-height: 1.6; }
.dsh-agent-group-input:focus, .dsh-agent-group-textarea:focus, .dsh-agent-group-select:focus, .dsh-agent-group-field > input:focus, .dsh-agent-group-field > select:focus, .dsh-agent-group-field > textarea:focus { border-color: var(--dsw-alias-state-business-primary); }
.dsh-agent-group-button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 36px; padding: 8px 14px; border: 1px solid transparent; border-radius: 9px; background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); font-size: 13px; font-weight: 550; }
.dsh-agent-group-button:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.dsh-agent-group-button[data-variant="ghost"] { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.dsh-agent-group-button[data-variant="ghost"]:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); border-color: var(--dsw-alias-border-l4); }
.dsh-agent-group-button[data-variant="danger"] { color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-bg-layer-1); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent); }
.dsh-agent-group-button[data-variant="danger"]:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
.dsh-agent-group-button:disabled, .dsh-agent-group-icon-button:disabled, .dsh-agent-group-chip:disabled { opacity: .45; cursor: default; }
.dsh-agent-group-overlay-root :is(button, input, select, textarea, summary):focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 3px; }
.dsh-agent-group-overlay-root input[type="checkbox"] { accent-color: var(--dsw-alias-state-business-primary); }
.dsh-agent-group-field > input[type="file"] { height: auto; min-height: 38px; padding: 7px; font-size: 12px; }
.dsh-agent-group-field > input[type="file"]::file-selector-button { margin-right: 8px; padding: 5px 8px; border: 0; border-radius: 5px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); font: inherit; cursor: pointer; }

.dsh-agent-group-form { display: flex; flex-direction: column; gap: 16px; }
.dsh-agent-group-field { min-width: 0; display: flex; flex-direction: column; gap: 7px; }
.dsh-agent-group-field > label, .dsh-agent-group-field > span { font-size: 12px; font-weight: 550; color: var(--dsw-alias-label-secondary); }
.dsh-agent-group-card { padding: 18px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); }
.dsh-agent-group-card + .dsh-agent-group-card { margin-top: 12px; }
.dsh-agent-group-card-head { display: flex; align-items: center; gap: 8px; }
.dsh-agent-group-card-head strong { font-size: 13px; }
.dsh-agent-group-muted { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.45; }
.dsh-agent-group-empty { margin: auto; max-width: 360px; padding: 30px; text-align: center; color: var(--dsw-alias-label-secondary); line-height: 1.6; }
.dsh-agent-group-error { flex: none; margin: 10px 16px; padding: 11px 13px; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 24%, transparent); border-radius: 9px; color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 5%, var(--dsw-alias-bg-layer-1)); font-size: 12px; line-height: 1.6; }
.dsh-agent-group-retry { flex: none; margin: 8px 14px 0; padding: 8px 10px; display: flex; align-items: center; justify-content: space-between; gap: 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 9px; background: var(--dsw-alias-interactive-bg-hover); font-size: 12px; }
.dsh-agent-group-busy { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-agent-group-inline { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.dsh-agent-group-right { margin-left: auto; }
.dsh-agent-group-task-list { display: flex; flex-direction: column; gap: 10px; }
.dsh-agent-group-task-root > section { margin-top: 10px; }
.dsh-agent-group-task-root h4 { margin: 0 0 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-agent-group-task-facts { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin-top: 8px; font-size: 12px; }
.dsh-agent-group-task-actions { margin-top: 9px; flex-wrap: wrap; }
.dsh-agent-group-task-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-height: 34px; padding: 6px 0; font-size: 12px; overflow-wrap: anywhere; }
.dsh-agent-group-task-row .dsh-agent-group-button { margin-left: auto; }
.dsh-agent-group-task-badge { display: inline-flex; align-items: center; min-height: 22px; padding: 1px 7px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dsh-agent-group-task-child { margin-top: 7px; padding: 7px 0; font-size: 12px; }
.dsh-agent-group-task-child summary { cursor: pointer; }
.dsh-agent-group-body[data-mode="memory"] { grid-template-columns: 300px minmax(0, 1fr); }
.dsh-agent-group-memory-filters .dsh-agent-group-form { gap: 12px; }
.dsh-agent-group-fieldset { min-width: 0; max-height: 180px; overflow: auto; margin: 0; padding: 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; }
.dsh-agent-group-check { display: flex; align-items: center; gap: 7px; min-height: 28px; font-size: 12px; }
.dsh-agent-group-memory-list, .dsh-agent-group-history-list { display: flex; flex-direction: column; gap: 8px; }
.dsh-agent-group-memory-meta { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 10px; margin: 10px 0; font-size: 12px; }
.dsh-agent-group-memory-meta dt { color: var(--dsw-alias-label-secondary); }
.dsh-agent-group-memory-meta dd { margin: 0; overflow-wrap: anywhere; }
.dsh-agent-group-history-item { padding: 10px 0; border-top: 1px solid var(--dsw-alias-border-l2); }
.dsh-agent-group-history-item:first-child { border-top: 0; }
.dsh-agent-group-modal { position: fixed; inset: 0; z-index: 2; display: grid; place-items: center; padding: 18px; background: rgb(0 0 0 / .38); }
.dsh-agent-group-modal-card { width: min(520px, 100%); max-height: min(680px, 90vh); overflow: auto; box-sizing: border-box; padding: 22px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: var(--dsw-elevation-panel); }
.dsh-agent-group-modal-card h2 { margin: 0 0 12px; font-size: 16px; }

@media (max-width: 980px) {
  .dsh-agent-group-overlay-root { padding: 8px; }
  .dsh-agent-group-workbench { border-radius: 14px; }
  .dsh-agent-group-body { grid-template-columns: 190px minmax(0, 1fr); }
  .dsh-agent-group-body[data-mode="conversations"] { grid-template-rows: minmax(0, 1fr) auto; }
  .dsh-agent-group-body[data-mode="conversations"] > .dsh-agent-group-panel:last-child { grid-column: 1 / -1; max-height: 170px; border-right: 0; border-top: 1px solid var(--dsw-alias-border-l2); }
  .dsh-agent-group-member-toggle { display: inline-flex; }
  .dsh-agent-group-body[data-mode="conversations"] > .dsh-agent-group-member-panel { display: none; }
  .dsh-agent-group-body[data-mode="conversations"] > .dsh-agent-group-member-panel[data-open="true"] { display: flex; position: absolute; top: 64px; right: 0; bottom: 0; width: min(320px, 90%); max-height: none; z-index: 2; box-shadow: var(--dsw-elevation-panel); }
}
@media (max-width: 720px) {
  .dsh-agent-group-body, .dsh-agent-group-body[data-mode="tasks"], .dsh-agent-group-body[data-mode="colleagues"], .dsh-agent-group-body[data-mode="memory"] { display: flex; flex-direction: column; grid-template-columns: minmax(0, 1fr); overflow: auto; }
  .dsh-agent-group-body > .dsh-agent-group-panel { flex: none; width: 100%; max-height: none; overflow: visible; border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-l2); }
  .dsh-agent-group-body > .dsh-agent-group-panel:first-child > .dsh-agent-group-scroll { flex: none; max-height: 210px; overflow: auto; }
  .dsh-agent-group-body > main.dsh-agent-group-panel { min-height: 360px; }
  .dsh-agent-group-body[data-mode="tasks"] > main { overflow: visible; }
  .dsh-agent-group-body > .dsh-agent-group-chat { flex: none; height: 65dvh; min-height: 400px; }
  .dsh-agent-group-topbar { min-height: 92px; flex-wrap: wrap; gap: 6px; padding: 10px 12px; }
  .dsh-agent-group-tabs { order: 1; width: 100%; overflow-x: auto; margin-left: 0; }
  .dsh-agent-group-tab { flex: 1; padding: 7px 8px; }
  .dsh-agent-group-title { display: none; }
  .dsh-agent-group-activity-drawer { top: 0; }
  .dsh-agent-group-activity-layout { grid-template-columns: minmax(0, 1fr); }
  .dsh-agent-group-workflow { padding: 16px 12px; }
  .dsh-agent-group-workflow .dsh-agent-group-form { grid-template-columns: minmax(0, 1fr); gap: 14px; padding: 14px; }
  .dsh-agent-group-organization-directory { gap: 10px; padding: 10px 12px; }
  .dsh-agent-group-organization-heading { flex: 1; }
  .dsh-agent-group-organization-directory > .dsh-agent-group-field { order: 1; width: 100%; }
  .dsh-agent-group-management-form { right: 12px; width: min(420px, calc(100vw - 32px)); max-height: 64dvh; }
  .dsh-agent-group-card { padding: 14px; }
  .dsh-agent-group-people-body { display: flex; flex-direction: column; overflow: auto; }
  .dsh-agent-group-people-body > aside { flex: none; max-height: 260px; }
  .dsh-agent-group-people-main { flex: none; overflow: visible; }
  .dsh-agent-group-people-main > .dsh-agent-group-scroll { overflow: visible; }
  .dsh-agent-group-role-body { display: flex; flex-direction: column; }
  .dsh-agent-group-message { max-width: 95%; }
  .dsh-agent-group-body[data-mode="conversations"] > .dsh-agent-group-member-panel[data-open="true"] { top: 92px; }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-agent-group-workbench, .dsh-agent-group-overlay-root { scroll-behavior: auto; }
}
`
