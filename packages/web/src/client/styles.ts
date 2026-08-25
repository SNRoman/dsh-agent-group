/** Plugin-scoped stylesheet. No selector or custom property escapes `.dsh-agent-group-*`. */

export const WORKSPACE_UI_STYLE_ID = 'dsh-agent-group/workspace-ui'

export const WORKSPACE_UI_CSS = `
.dsh-agent-group-footer-button {
  width: 100%; min-height: 36px; display: flex; align-items: center; justify-content: center; gap: 8px;
  padding: 7px 10px; border: 0; border-radius: 10px; background: transparent;
  color: var(--dsw-alias-label-secondary); cursor: pointer; font: inherit;
}
.dsh-agent-group-footer-button:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-agent-group-footer-button[data-wide="true"] { justify-content: flex-start; }
.dsh-agent-group-footer-icon { width: 18px; height: 18px; flex: none; }

.dsh-agent-group-overlay-root { position: fixed; inset: 0; pointer-events: auto; display: flex; align-items: stretch; justify-content: stretch; padding: 18px; box-sizing: border-box; background: color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent); }
.dsh-agent-group-workbench { width: 100%; height: 100%; min-width: 0; min-height: 0; display: grid; grid-template-rows: 56px minmax(0, 1fr); overflow: hidden; border: 1px solid var(--dsw-alias-border-l2); border-radius: 18px; background: var(--dsw-alias-button-elevated-fill); color: var(--dsw-alias-label-primary); }
.dsh-agent-group-topbar { display: flex; align-items: center; gap: 12px; padding: 0 18px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.dsh-agent-group-title { font-size: 16px; font-weight: 600; white-space: nowrap; }
.dsh-agent-group-tabs { display: flex; gap: 4px; margin-left: 12px; }
.dsh-agent-group-tab, .dsh-agent-group-icon-button, .dsh-agent-group-button, .dsh-agent-group-chip { border: 0; font: inherit; color: inherit; cursor: pointer; }
.dsh-agent-group-tab { padding: 7px 12px; border-radius: 9px; background: transparent; color: var(--dsw-alias-label-secondary); }
.dsh-agent-group-tab:hover, .dsh-agent-group-tab[data-active="true"] { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-agent-group-spacer { flex: 1; }
.dsh-agent-group-icon-button { width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center; border-radius: 10px; background: transparent; }
.dsh-agent-group-icon-button:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-agent-group-icon-button svg { width: 18px; height: 18px; }

.dsh-agent-group-body { min-width: 0; min-height: 0; display: grid; grid-template-columns: 230px minmax(0, 1fr) 260px; }
.dsh-agent-group-body[data-mode="agents"] { grid-template-columns: 260px minmax(0, 1fr); }
.dsh-agent-group-panel { min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; border-right: 1px solid var(--dsw-alias-border-l2); }
.dsh-agent-group-panel:last-child { border-right: 0; }
.dsh-agent-group-section-head { flex: none; display: flex; align-items: center; gap: 8px; min-height: 48px; padding: 0 14px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.dsh-agent-group-section-title { font-size: 13px; font-weight: 600; }
.dsh-agent-group-scroll { flex: 1; min-height: 0; overflow: auto; padding: 10px; }
.dsh-agent-group-list { display: flex; flex-direction: column; gap: 4px; }
.dsh-agent-group-list-button { width: 100%; display: flex; align-items: center; gap: 9px; padding: 9px 10px; border: 0; border-radius: 10px; background: transparent; color: inherit; text-align: left; cursor: pointer; font: inherit; }
.dsh-agent-group-list-button:hover, .dsh-agent-group-list-button[data-active="true"] { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-agent-group-list-button small { color: var(--dsw-alias-label-secondary); margin-left: auto; }
.dsh-agent-group-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-secondary); flex: none; }
.dsh-agent-group-dot[data-employed="true"] { background: var(--dsw-alias-label-primary); }

.dsh-agent-group-chat { min-width: 0; min-height: 0; display: grid; grid-template-rows: 48px minmax(0, 1fr) auto; }
.dsh-agent-group-messages { min-height: 0; overflow: auto; padding: 16px 18px; display: flex; flex-direction: column; gap: 14px; }
.dsh-agent-group-message { display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 10px; }
.dsh-agent-group-avatar { width: 34px; height: 34px; border-radius: 10px; display: flex; align-items: center; justify-content: center; background: var(--dsw-alias-interactive-bg-hover); font-weight: 600; }
.dsh-agent-group-message-meta { display: flex; align-items: baseline; gap: 8px; margin-bottom: 3px; }
.dsh-agent-group-message-meta strong { font-size: 13px; }
.dsh-agent-group-message-meta span { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-agent-group-message-text { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 1.55; }
.dsh-agent-group-composer { padding: 10px 14px 14px; border-top: 1px solid var(--dsw-alias-border-l2); }
.dsh-agent-group-mention-row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 7px; }
.dsh-agent-group-chip { padding: 4px 8px; border-radius: 8px; background: var(--dsw-alias-interactive-bg-hover); font-size: 12px; }
.dsh-agent-group-compose-row { display: flex; gap: 8px; align-items: flex-end; }

.dsh-agent-group-input, .dsh-agent-group-textarea, .dsh-agent-group-select { width: 100%; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; outline: none; }
.dsh-agent-group-input, .dsh-agent-group-select { height: 36px; padding: 0 10px; }
.dsh-agent-group-textarea { min-height: 72px; resize: vertical; padding: 9px 10px; line-height: 1.45; }
.dsh-agent-group-input:focus, .dsh-agent-group-textarea:focus, .dsh-agent-group-select:focus { border-color: var(--dsw-alias-label-secondary); }
.dsh-agent-group-button { min-height: 34px; padding: 7px 12px; border-radius: 9px; background: var(--dsw-alias-label-primary); color: var(--dsw-alias-label-primary-inverted); }
.dsh-agent-group-button[data-variant="ghost"] { background: transparent; color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l2); }
.dsh-agent-group-button:disabled, .dsh-agent-group-icon-button:disabled, .dsh-agent-group-chip:disabled { opacity: .45; cursor: default; }

.dsh-agent-group-form { display: flex; flex-direction: column; gap: 10px; }
.dsh-agent-group-field { display: flex; flex-direction: column; gap: 5px; }
.dsh-agent-group-field label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-agent-group-card { padding: 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; }
.dsh-agent-group-card + .dsh-agent-group-card { margin-top: 8px; }
.dsh-agent-group-card-head { display: flex; align-items: center; gap: 8px; }
.dsh-agent-group-card-head strong { font-size: 13px; }
.dsh-agent-group-muted { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.45; }
.dsh-agent-group-empty { margin: auto; max-width: 360px; padding: 30px; text-align: center; color: var(--dsw-alias-label-secondary); line-height: 1.6; }
.dsh-agent-group-error { flex: none; margin: 8px 14px 0; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 9px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); font-size: 12px; }
.dsh-agent-group-busy { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-agent-group-inline { display: flex; align-items: center; gap: 8px; }
.dsh-agent-group-right { margin-left: auto; }

@media (max-width: 980px) {
  .dsh-agent-group-overlay-root { padding: 8px; }
  .dsh-agent-group-workbench { border-radius: 14px; }
  .dsh-agent-group-body { grid-template-columns: 190px minmax(0, 1fr); }
  .dsh-agent-group-body[data-mode="chat"] > .dsh-agent-group-panel:last-child { display: none; }
}
@media (max-width: 720px) {
  .dsh-agent-group-body, .dsh-agent-group-body[data-mode="agents"] { grid-template-columns: 1fr; }
  .dsh-agent-group-body > .dsh-agent-group-panel:first-child { display: none; }
  .dsh-agent-group-tabs { margin-left: 0; }
  .dsh-agent-group-title { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-agent-group-workbench, .dsh-agent-group-overlay-root { scroll-behavior: auto; }
}
`
