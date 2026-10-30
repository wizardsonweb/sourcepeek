export const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }

.mf-toggles { position: fixed; bottom: 20px; right: 20px; z-index: 3; display: flex; align-items: center; gap: 8px; }
.mf-toggle:focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }
.mf-toggle {
  padding: 10px 18px; color: #e0d9ff; border: 1px solid #7c3aed; border-radius: 999px;
  font: 600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; cursor: pointer;
  background: linear-gradient(135deg, #0f0c29, #6a3093); box-shadow: 0 4px 16px rgba(124,58,237,.4);
}
.mf-toggle.on {
  background: linear-gradient(135deg, #4c1d95, #2563eb); border-color: #3b82f6; color: #fff;
  box-shadow: 0 4px 20px rgba(59,130,246,.6);
}

.mf-highlight {
  position: fixed; z-index: 1; pointer-events: none;
  border: 2px solid #7c3aed; background: rgba(124,58,237,.12); border-radius: 3px;
}
.mf-highlight-label {
  position: absolute; top: -22px; left: -2px; padding: 2px 6px; white-space: nowrap;
  background: #4c1d95; color: #fff; font: 600 11px ui-monospace, monospace; border-radius: 3px;
}

.mf-panel {
  position: fixed; z-index: 2; width: 340px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); overflow: auto;
  background: #0a0910;
  color: #e0d9ff; border: 1px solid #2a2540; border-radius: 10px;
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; text-align: left;
}
.mf-panel-header, .mf-detail-header {
  display: flex; justify-content: space-between; align-items: center;
  background: #100e19; border-bottom: 1px solid #2a2540; color: #c4b5fd;
}
.mf-panel-header { padding: 10px 12px; }
.mf-close { background: none; border: none; color: #a78bfa; font-size: 18px; cursor: pointer; line-height: 1; }
.mf-close:hover { color: #3b82f6; }
.mf-panel-body { padding: 12px; display: flex; flex-direction: column; gap: 6px; word-break: break-all; }
.mf-label { color: #8b5cf6; margin-right: 4px; font-weight: 600; }

.mf-git { margin-top: 6px; padding-top: 10px; border-top: 1px solid #312e81; display: flex; flex-direction: column; gap: 6px; }
.mf-section-title { color: #a78bfa; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
.mf-muted { color: #8b83b8; font-size: 12px; }
.mf-commit { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; padding: 6px 0; border-bottom: 1px solid #1e1b4b; }
.mf-hash { color: #3b82f6; font: 12px ui-monospace, monospace; }
.mf-subject { flex: 1; min-width: 0; word-break: normal; overflow-wrap: anywhere; }
.mf-commit .mf-muted { flex-basis: 100%; }
.mf-link { color: #60a5fa; text-decoration: none; font-weight: 600; }
.mf-link:hover { color: #93c5fd; text-decoration: underline; }

.mf-ide { margin-top: 6px; padding-top: 10px; border-top: 1px solid #312e81; }
.mf-ide-toggle, .mf-copy-btn {
  padding: 8px 12px; background: linear-gradient(135deg, #4c1d95, #2563eb); color: #fff;
  border: 1px solid #3b82f6; border-radius: 6px; font: 600 13px inherit; font-family: inherit; cursor: pointer;
}
.mf-ide-toggle { width: 100%; text-align: left; }
.mf-ide-toggle:hover, .mf-copy-btn:hover { box-shadow: 0 0 12px rgba(59,130,246,.5); }
.mf-ide-menu { display: flex; flex-direction: column; margin-top: 6px; background: #07060b; border: 1px solid #4c1d95; border-radius: 6px; overflow: hidden; }
.mf-ide-item { padding: 8px 12px; background: none; border: none; border-bottom: 1px solid #1e1b4b; color: #e0d9ff; font: 13px inherit; font-family: inherit; text-align: left; cursor: pointer; }
.mf-ide-item:last-child { border-bottom: none; }
.mf-ide-item:hover { background: linear-gradient(90deg, #312e81, #1d4ed8); color: #fff; }

.mf-more-btn {
  margin-top: 6px; padding: 8px 12px; background: transparent; color: #a78bfa;
  border: 1px solid #4c1d95; border-radius: 6px; font: 600 13px inherit; font-family: inherit; cursor: pointer;
}
.mf-more-btn:hover { background: rgba(124,58,237,.15); color: #fff; }

.mf-overlay {
  position: fixed; inset: 0; z-index: 4; background: rgba(0,0,0,.72);
  display: flex; align-items: center; justify-content: center; padding: 5vh 5vw;
}
.mf-detail {
  width: 100%; height: 100%; display: flex; flex-direction: column; overflow: hidden;
  background: #0a0910;
  border: 1px solid #2a2540; border-radius: 14px;
  color: #e0d9ff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.mf-detail-header { padding: 16px 20px; font-size: 16px; }
.mf-detail-close { font-size: 26px; }
.mf-detail-body { padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 20px; font-size: 14px; line-height: 1.6; }
.mf-detail-info { display: flex; flex-direction: column; gap: 4px; word-break: break-all; padding-bottom: 12px; border-bottom: 1px solid #221e33; }
.mf-detail-section { display: flex; flex-direction: column; gap: 8px; }
.mf-ai-refactor { position: relative; }
.mf-refactor-output {
  white-space: pre-wrap; word-break: break-word; background: #07060b; border: 1px solid #221e33;
  border-radius: 8px; padding: 12px; margin: 0; font: 12.5px ui-monospace, monospace; color: #d9d2ff;
}
.mf-copy-btn { position: absolute; top: 12px; right: 12px; }

.mf-overlay { padding-top: max(5vh, 60px); }
.mf-overlay--docked { background: transparent; pointer-events: none; padding: 0; display: block; }
.mf-overlay--docked .mf-detail {
  pointer-events: auto; position: fixed; top: 60px; right: 16px; bottom: 68px;
  width: min(440px, calc(100vw - 32px)); height: auto; /* bottom: 68px keeps the Sourcepeek buttons below it clickable */
}
.mf-overlay--docked .mf-detail-body { padding: 16px; gap: 16px; font-size: 13px; }
.mf-detail-header-right { display: flex; align-items: center; gap: 10px; }
.mf-dock-btn, .mf-style-mini {
  padding: 4px 10px; background: transparent; color: #a78bfa; border: 1px solid #4c1d95; border-radius: 6px;
  font: 600 12px inherit; font-family: inherit; cursor: pointer;
}
.mf-dock-btn:hover, .mf-style-mini:hover { background: rgba(124,58,237,.2); color: #fff; }
.mf-view-switch { display: inline-flex; border: 1px solid #4c1d95; border-radius: 6px; overflow: hidden; }
.mf-view-switch .mf-dock-btn { border: none; border-radius: 0; }
.mf-view-switch .mf-dock-btn + .mf-dock-btn { border-left: 1px solid #4c1d95; }
.mf-view-switch .mf-dock-btn--active { background: rgba(124,58,237,.35); color: #fff; cursor: default; }
.mf-view-switch .mf-dock-btn:focus-visible { outline: 2px solid #3b82f6; outline-offset: -2px; }
.mf-style-section { display: flex; flex-direction: column; gap: 8px; }
.mf-detail-header { position: relative; }
.mf-usage { display: inline-flex; }
.mf-usage-btn {
  width: 26px; height: 26px; padding: 0; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
  background: transparent; color: #a78bfa; border: 1px solid #4c1d95; font: 700 13px inherit; font-family: inherit; cursor: pointer;
}
.mf-usage-btn:hover, .mf-usage-btn--active { background: rgba(124,58,237,.3); color: #fff; }
.mf-usage-btn:focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }
.mf-usage-pop {
  position: absolute; top: calc(100% - 6px); right: 16px; z-index: 5; width: 260px; max-width: calc(100% - 32px);
  padding: 12px 14px; background: #100e18; border: 1px solid #3b2f63; border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0,0,0,.5); display: flex; flex-direction: column; gap: 8px; font-size: 12px; font-weight: 400; text-align: left;
}
.mf-usage-pop[hidden] { display: none; }
.mf-usage-model { color: #a78bfa; font-weight: 600; word-break: break-all; }
.mf-usage-amount { font-size: 24px; font-weight: 700; color: #fff; font-variant-numeric: tabular-nums; }
.mf-usage-note { color: #8b84b0; font-size: 11px; line-height: 1.4; }
.mf-usage-stats { display: flex; flex-direction: column; gap: 4px; padding-top: 8px; border-top: 1px solid #221e33; }
.mf-usage-stat { display: flex; justify-content: space-between; gap: 12px; font-variant-numeric: tabular-nums; }
.mf-usage-actions { display: flex; gap: 8px; }

.mf-acc-list { display: flex; flex-direction: column; gap: 10px; }
.mf-acc { border: 1px solid #221e33; border-radius: 10px; background: #100e18; overflow: hidden; }
.mf-acc--open { border-color: #3b2f63; }
.mf-acc-head {
  width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 12px 14px; background: transparent; border: none; cursor: pointer; text-align: left;
  font-family: inherit; color: inherit;
}
.mf-acc-head:hover { background: rgba(124,58,237,.12); }
.mf-acc-head:focus-visible { outline: 2px solid #3b82f6; outline-offset: -2px; }
.mf-acc-icon { color: #a78bfa; font-size: 12px; transition: transform .15s ease; }
.mf-acc--open .mf-acc-icon { transform: rotate(90deg); }
.mf-acc--open .mf-acc-head { border-bottom: 1px solid #221e33; }
.mf-acc-body { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 8px; }
.mf-missing-key { color: #fcd34d; }
.mf-ai-via { margin-top: 8px; color: #6b648f; font-size: 11px; }
.mf-subsection-title { margin-top: 8px; padding-top: 12px; border-top: 1px solid #312e81; color: #a78bfa; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
.mf-style-btn {
  align-self: flex-start; padding: 10px 16px; background: linear-gradient(135deg, #4c1d95, #2563eb); color: #fff;
  border: 1px solid #3b82f6; border-radius: 6px; font: 600 13px inherit; font-family: inherit; cursor: pointer;
}
.mf-style-btn:hover { box-shadow: 0 0 12px rgba(59,130,246,.5); }
.mf-style-btn:disabled { opacity: .6; cursor: progress; box-shadow: none; }
.mf-style-editor { display: flex; flex-direction: column; gap: 10px; }
.mf-style-input {
  width: 100%; min-height: 90px; resize: vertical; padding: 10px 12px;
  background: #07060b; color: #e0d9ff; border: 1px solid #2f2950; border-radius: 8px;
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; outline: none;
}
.mf-style-input:focus { border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59,130,246,.25); }
.mf-style-input::placeholder { color: #6b648f; }
.mf-style-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.mf-style-actions .mf-style-btn { white-space: nowrap; }
.mf-style-status { padding: 8px 10px; border-radius: 6px; font-size: 12.5px; background: rgba(124,58,237,.12); color: #c4b5fd; }
.mf-style-status--ok { background: rgba(16,185,129,.12); color: #6ee7b7; }
.mf-style-status--warn { background: rgba(245,158,11,.12); color: #fcd34d; }
.mf-style-status--error { background: rgba(239,68,68,.12); color: #fca5a5; }
.mf-style-list { display: flex; flex-direction: column; gap: 8px; }
.mf-style-item { display: flex; flex-direction: column; gap: 6px; padding: 10px; background: #0c0b13; border: 1px solid #221e33; border-radius: 8px; }
.mf-style-item-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.mf-spacer { flex: 1; }
.mf-list-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.mf-style-item-req { flex: 1; min-width: 0; overflow-wrap: anywhere; color: #e0d9ff; font-weight: 600; }
.mf-style-warn { color: #fcd34d; font-size: 12px; }
.mf-style-css { font-size: 12px; max-height: 260px; overflow: auto; }

.mf-stylebar-reset {
  padding: 6px 14px; border-radius: 999px; font: 600 12px inherit; font-family: inherit; cursor: pointer;
}
.mf-stylebar-reset { background: transparent; color: #a78bfa; border: 1px solid #4c1d95; }
.mf-stylebar-reset:hover { color: #fca5a5; border-color: #ef4444; }
.mf-row { overflow-wrap: anywhere; }
.mf-classes-row { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 0; }
.mf-classes { overflow-wrap: anywhere; word-break: break-word; min-width: 0; max-width: 100%; }
.mf-classes--clamped { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; }
.mf-classes-more {
  padding: 0; background: none; border: none; color: #60a5fa; font: 600 11.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  cursor: pointer; text-decoration: underline; text-underline-offset: 2px;
}
.mf-classes-more:hover { color: #93c5fd; }
.mf-classes-more[hidden] { display: none; }
.mf-file-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; }
.mf-linkbtn {
  padding: 0; background: none; border: none; color: #93c5fd; font: 12.5px ui-monospace, monospace;
  cursor: pointer; text-align: left; overflow-wrap: anywhere; word-break: break-all;
}
.mf-linkbtn:hover { color: #bfdbfe; text-decoration: underline; }
.mf-mini-btn {
  margin-left: auto; padding: 2px 8px; background: transparent; color: #a78bfa; border: 1px solid #4c1d95;
  border-radius: 999px; font: 600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; cursor: pointer; white-space: nowrap;
}
.mf-mini-btn:hover { background: rgba(124,58,237,.2); color: #fff; }

.mf-crumbs {
  display: flex; flex-wrap: wrap; align-items: center; gap: 2px 4px; padding-bottom: 8px; margin-bottom: 2px;
  border-bottom: 1px solid #312e81; word-break: normal;
}
.mf-crumb {
  padding: 2px 6px; background: rgba(124,58,237,.12); border: 1px solid transparent; border-radius: 5px;
  color: #c4b5fd; font: 600 11.5px ui-monospace, monospace; cursor: pointer;
}
.mf-crumb:hover { border-color: #7c3aed; color: #fff; }
.mf-crumb--current { background: linear-gradient(135deg, #4c1d95, #2563eb); color: #fff; cursor: default; }
.mf-crumb-sep { color: #6b648f; font-size: 11px; }

.mf-i18n, .mf-kv-wrap { margin-top: 4px; padding-top: 8px; border-top: 1px solid #312e81; display: flex; flex-direction: column; gap: 4px; word-break: normal; }
.mf-i18n-row { font-size: 12px; overflow-wrap: anywhere; }
.mf-i18n-key { color: #fcd34d; font: 12px ui-monospace, monospace; margin-right: 6px; }
.mf-i18n-row .mf-linkbtn { font-size: 12px; }
.mf-kv summary { cursor: pointer; list-style: none; padding: 2px 0; }
.mf-kv summary::-webkit-details-marker { display: none; }
.mf-kv summary::before { content: '▸ '; }
.mf-kv[open] summary::before { content: '▾ '; }
.mf-kv-list { display: flex; flex-direction: column; gap: 3px; max-height: 300px; overflow: auto; padding: 4px 0 2px; }
.mf-kv-row { display: flex; gap: 8px; font-size: 12px; align-items: baseline; min-width: 0; }
.mf-kv-tree { flex: 1; }
.mf-kv-full { flex: none; padding: 0 4px; background: none; border: 1px solid transparent; border-radius: 4px; color: #8b5cf6; font-size: 12px; cursor: pointer; }
.mf-kv-full:hover { border-color: #4c1d95; color: #fff; }
.mf-kv-key { color: #a78bfa; flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mf-kv-val { color: #d9d2ff; font: 11.5px ui-monospace, monospace; overflow-wrap: anywhere; word-break: break-all; }

.mf-ide-split { display: flex; gap: 0; }
.mf-ide-split .mf-ide-toggle { border-top-right-radius: 0; border-bottom-right-radius: 0; flex: 1; }
.mf-ide-caret {
  padding: 8px 10px; background: linear-gradient(135deg, #312e81, #1d4ed8); color: #fff; border: 1px solid #3b82f6; border-left: none;
  border-radius: 0 6px 6px 0; cursor: pointer; font: 600 12px inherit; font-family: inherit;
}
.mf-ide-caret:hover { box-shadow: 0 0 12px rgba(59,130,246,.5); }

.mf-toast {
  position: fixed; bottom: 72px; right: 20px; z-index: 6; max-width: min(420px, calc(100vw - 40px));
  padding: 8px 14px; border-radius: 8px; background: #1e1b4b; border: 1px solid #4c1d95; color: #e0d9ff;
  font: 600 12.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; box-shadow: 0 6px 24px rgba(0,0,0,.35);
  overflow-wrap: anywhere;
}
.mf-toast--ok { border-color: #10b981; color: #a7f3d0; }
.mf-toast--error { border-color: #ef4444; color: #fecaca; }

.mf-edit-off { color: #fcd34d; }
.mf-style-mini--accent { color: #93c5fd; border-color: #2563eb; }
.mf-style-mini:disabled { opacity: .45; cursor: not-allowed; }
.mf-style-item--undone { opacity: .6; }
.mf-badge { padding: 2px 8px; border-radius: 999px; background: #312e81; color: #c4b5fd; font-size: 11px; font-weight: 600; }
.mf-undo { display: inline-flex; }
.mf-item-actions { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.mf-badge--preview { background: rgba(37,99,235,.18); color: #93c5fd; }
.mf-badge--applied { background: rgba(16,185,129,.16); color: #6ee7b7; }
.mf-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.mf-chip {
  padding: 2px 8px; background: #0f0c29; border: 1px solid #312e81; border-radius: 999px; color: #c4b5fd;
  font: 11.5px ui-monospace, monospace; cursor: pointer;
}
.mf-chip:hover { border-color: #3b82f6; color: #fff; }
.mf-chip-add, .mf-diff-add { color: #6ee7b7; }
.mf-chip-del, .mf-diff-del { color: #fca5a5; }
.mf-diffs { display: flex; flex-direction: column; gap: 8px; }
.mf-diff {
  margin: 0; padding: 10px; max-height: 320px; overflow: auto; background: #07060b; border: 1px solid #221e33; border-radius: 8px;
  font: 12px/1.5 ui-monospace, monospace; color: #b8b0e0; white-space: pre; tab-size: 2;
}
.mf-diff-add { display: block; background: rgba(16,185,129,.12); }
.mf-diff-del { display: block; background: rgba(239,68,68,.12); }
.mf-diff-hunk { color: #818cf8; }
.mf-diff-meta { color: #6b648f; }

.mf-kind {
  padding: 5px 8px; background: #0f0c29; border: 1px solid #312e81; border-radius: 6px; color: #c4b5fd;
  font: 600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; cursor: pointer;
}
.mf-kind:focus-visible { outline: 2px solid #7c3aed; outline-offset: 1px; }
.mf-kind:disabled { opacity: .5; cursor: wait; }
.mf-detected-wrap { display: flex; flex-direction: column; gap: 4px; }
.mf-detected { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12px; }
.mf-detected .mf-muted { min-width: 0; overflow-wrap: anywhere; }
.mf-notice { color: #fcd34d; }
.mf-kind-badge {
  flex: none; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: .01em;
  background: #312e81; color: #c4b5fd;
}
.mf-kind-badge--style { background: rgba(236,72,153,.16); color: #f9a8d4; }
.mf-kind-badge--code { background: rgba(59,130,246,.18); color: #93c5fd; }
.mf-kind-badge--mixed { background: rgba(168,85,247,.2); color: #d8b4fe; }
.mf-kind-badge--component { background: rgba(16,185,129,.16); color: #6ee7b7; }
.mf-kind-badge--page { background: rgba(245,158,11,.16); color: #fcd34d; }
.mf-kind-badge--theme { background: rgba(14,165,233,.18); color: #7dd3fc; }
.mf-styling-chip {
  flex: none; padding: 2px 8px; border: 1px solid #312e81; border-radius: 999px; background: #0f0c29; color: #c4b5fd;
  font: 11.5px ui-monospace, monospace;
}
.mf-styling-chip--link { cursor: pointer; }
.mf-styling-chip--link:hover { border-color: #3b82f6; color: #fff; }
.mf-chip-new { color: #6ee7b7; font-weight: 700; }

.mf-bars {
  position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); z-index: 5;
  display: flex; flex-direction: column; align-items: center; gap: 8px; pointer-events: none;
}
.mf-bars > * { pointer-events: auto; }
.mf-editbar {
  display: flex; align-items: center; gap: 8px;
  max-width: min(520px, calc(100vw - 32px)); padding: 6px 6px 6px 14px; border: 1px solid #10b981; border-radius: 999px;
  background: linear-gradient(135deg, #0f0c29, #064e3b); box-shadow: 0 4px 20px rgba(16,185,129,.35);
  color: #a7f3d0; font: 600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.mf-editbar--error { border-color: #ef4444; background: linear-gradient(135deg, #0f0c29, #7f1d1d); color: #fecaca; box-shadow: 0 4px 20px rgba(239,68,68,.4); }
.mf-editbar-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mf-editbar .mf-stylebar-reset { padding: 6px 14px; border-radius: 999px; font: 600 12px inherit; font-family: inherit; cursor: pointer; }
.mf-editbar-revert {
  padding: 6px 14px; border-radius: 999px; background: #ef4444; color: #fff; border: 1px solid #f87171;
  font: 600 12px inherit; font-family: inherit; cursor: pointer; white-space: nowrap;
}
.mf-editbar-x { background: none; border: none; color: inherit; font-size: 16px; cursor: pointer; padding: 0 8px 0 2px; opacity: .7; }
.mf-editbar-x:hover { opacity: 1; }

.mf-subtitle { color: #8b83b8; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }

/* Network */
.mf-net-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.mf-net-summary { flex: 1; min-width: 0; }
.mf-net-check { display: inline-flex; align-items: center; gap: 4px; color: #8b83b8; font-size: 12px; cursor: pointer; white-space: nowrap; }
.mf-net-check input { margin: 0; accent-color: #7c3aed; }
.mf-net-list, .mf-net-others { display: flex; flex-direction: column; gap: 6px; }
.mf-net-empty { padding: 4px 0; }
.mf-net-item { border: 1px solid #221e33; border-radius: 8px; background: #0c0b13; overflow: hidden; }
.mf-net-item[open] { border-color: #3b2f63; }
.mf-net-head {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: pointer; list-style: none; min-width: 0;
}
.mf-net-head::-webkit-details-marker { display: none; }
.mf-net-head:hover { background: rgba(124,58,237,.08); }
.mf-net-method {
  flex: none; min-width: 52px; padding: 2px 6px; border-radius: 4px; text-align: center;
  font: 700 10.5px ui-monospace, monospace; letter-spacing: .03em;
}
.mf-net-method--get { background: rgba(16,185,129,.14); color: #6ee7b7; }
.mf-net-method--post { background: rgba(59,130,246,.16); color: #93c5fd; }
.mf-net-method--put { background: rgba(245,158,11,.14); color: #fcd34d; }
.mf-net-method--delete { background: rgba(239,68,68,.14); color: #fca5a5; }
.mf-net-method--other { background: #1c1930; color: #c4b5fd; }
.mf-net-url { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #e0d9ff; font: 12px ui-monospace, monospace; }
.mf-net-status { flex: none; font: 600 11px ui-monospace, monospace; color: #8b83b8; white-space: nowrap; }
.mf-net-status--ok { color: #6ee7b7; }
.mf-net-status--warn { color: #fcd34d; }
.mf-net-status--err { color: #fca5a5; }
.mf-net-status--idle { color: #5f5880; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-weight: 500; }
.mf-net-body { display: flex; flex-direction: column; gap: 10px; padding: 10px; border-top: 1px solid #221e33; }
.mf-net-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 12px; }
.mf-net-meta .mf-linkbtn { font-size: 12px; }
.mf-net-fn { color: #c4b5fd; font: 12px ui-monospace, monospace; }
.mf-net-sec { display: flex; flex-direction: column; gap: 6px; }
.mf-net-sec-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.mf-net-tag { padding: 1px 8px; border-radius: 999px; background: #1c1930; color: #8b83b8; font-size: 11px; font-weight: 600; }
.mf-net-tabs { display: inline-flex; border: 1px solid #2a2540; border-radius: 6px; overflow: hidden; }
.mf-net-tab { padding: 2px 10px; background: transparent; border: none; color: #8b83b8; font: 600 11px inherit; font-family: inherit; cursor: pointer; }
.mf-net-tab + .mf-net-tab { border-left: 1px solid #2a2540; }
.mf-net-tab--on { background: #1c1930; color: #e0d9ff; }
.mf-net-pre {
  margin: 0; padding: 10px; max-height: 280px; overflow: auto; background: #07060b; border: 1px solid #221e33; border-radius: 6px;
  font: 12px/1.5 ui-monospace, monospace; color: #d9d2ff; white-space: pre; tab-size: 2;
}
.mf-net-hint { color: #5f5880; font-size: 11px; }
.mf-net-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.mf-net-btn {
  padding: 4px 10px; background: transparent; color: #a78bfa; border: 1px solid #2f2950; border-radius: 6px;
  font: 600 12px inherit; font-family: inherit; cursor: pointer; white-space: nowrap;
}
.mf-net-btn:hover { background: rgba(124,58,237,.15); color: #fff; }
.mf-net-btn:disabled { opacity: .45; cursor: not-allowed; background: transparent; color: #a78bfa; }
.mf-net-btn--primary { background: #4c1d95; border-color: #6d28d9; color: #fff; }
.mf-net-btn--primary:hover { background: #5b21b6; }
.mf-net-more { align-self: flex-start; margin-top: 2px; border-style: dashed; color: #8b83b8; }

/* Storage */
.mf-st-switch { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.mf-st-filter { flex: 1 1 140px; width: auto; min-width: 0; min-height: 0; height: 26px; resize: none; padding: 3px 8px; border-radius: 6px; font-size: 12px; }
.mf-st-area {
  flex: none; min-width: 58px; padding: 2px 6px; border-radius: 4px; text-align: center;
  font: 700 10px ui-monospace, monospace; letter-spacing: .04em;
}
.mf-st-area--local { background: rgba(16,185,129,.14); color: #6ee7b7; }
.mf-st-area--session { background: rgba(59,130,246,.16); color: #93c5fd; }
.mf-st-area--cache { background: rgba(245,158,11,.14); color: #fcd34d; }
.mf-st-secret { flex: none; padding: 1px 6px; border-radius: 4px; background: rgba(239,68,68,.12); color: #fca5a5; font: 700 10px ui-monospace, monospace; letter-spacing: .04em; }
.mf-st-group { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin-top: 8px; padding-bottom: 2px; border-bottom: 1px solid #221e33; font-size: 12px; }
.mf-st-group:first-child { margin-top: 0; }
.mf-st-group-actions { display: inline-flex; gap: 6px; margin-left: auto; }
.mf-st-group-actions .mf-net-btn { padding: 2px 8px; font-size: 11px; }
.mf-st-none { font-size: 12px; padding: 2px 0 4px; }
.mf-st-ref { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; width: 100%; }
.mf-st-url { color: #e0d9ff; font: 12px ui-monospace, monospace; }
.mf-st-masked-row { display: flex; align-items: center; gap: 8px; }
.mf-st-masked { flex: 1; padding: 8px 10px; background: #07060b; border: 1px solid #221e33; border-radius: 6px; color: #5f5880; font: 12px ui-monospace, monospace; letter-spacing: .1em; }
.mf-st-reload { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 8px; background: rgba(124,58,237,.1); border: 1px solid #3b2f63; color: #c4b5fd; font-size: 12px; }
.mf-st-reload span { flex: 1 1 200px; }
.mf-st-editor { border-color: #3b2f63; background: #0c0b13; }
.mf-st-entries { display: flex; flex-direction: column; gap: 4px; }
.mf-st-entry { border: 1px solid #221e33; border-radius: 6px; }
.mf-st-entry-head { display: flex; align-items: center; gap: 8px; padding: 5px 8px; cursor: pointer; list-style: none; min-width: 0; }
.mf-st-entry-head::-webkit-details-marker { display: none; }
.mf-st-entry-head:hover { background: rgba(124,58,237,.08); }
.mf-st-method { flex: none; color: #8b83b8; font: 700 10px ui-monospace, monospace; }
.mf-st-entry-body { display: flex; flex-direction: column; gap: 6px; padding: 8px; border-top: 1px solid #221e33; }

/* Report */
.mf-rep-shot { display: flex; flex-direction: column; gap: 6px; }
.mf-rep-img {
  display: block; align-self: flex-start; width: auto; max-width: 100%; max-height: 260px;
  background: #07060b; border: 1px solid #221e33; border-radius: 8px; cursor: zoom-in;
}
.mf-rep-status { font-size: 11.5px; }
.mf-rep-notes { min-height: 54px; }
.mf-rep-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.mf-rep-chip { padding: 2px 9px; border-radius: 999px; background: #1c1930; color: #a59cd3; font-size: 11.5px; font-weight: 600; }
.mf-rep-chip--ok { background: rgba(16,185,129,.14); color: #6ee7b7; }
.mf-rep-chip--warn { background: rgba(245,158,11,.14); color: #fcd34d; }
.mf-rep-chip--err { background: rgba(239,68,68,.14); color: #fca5a5; }
.mf-rep-main { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
.mf-rep-copy:disabled { opacity: .6; cursor: progress; box-shadow: none; }
.mf-rep-preview summary { cursor: pointer; padding: 2px 0; }
.mf-rep-pre { margin-top: 6px; max-height: 360px; white-space: pre-wrap; word-break: break-word; }

/* Collapsed-accordion extra text ("· 3 issues") */
.mf-acc-title { display: inline-flex; align-items: baseline; gap: 2px; min-width: 0; }
.mf-acc-extra { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: #8b83b8; }
.mf-acc-extra--warn { color: #fcd34d; }
.mf-acc-extra--ok { color: #6ee7b7; }
.mf-acc-extra--units { text-transform: none; letter-spacing: .02em; }

/* Mocks */
.mf-mockbar {
  display: flex; flex-direction: column; align-items: stretch; gap: 6px; max-width: min(560px, calc(100vw - 32px));
  font: 600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #fde68a;
}
.mf-mockbar-row {
  align-self: center; display: flex; align-items: center; gap: 8px; padding: 5px 6px 5px 12px; border-radius: 999px;
  border: 1px solid #f59e0b; background: linear-gradient(135deg, #1c1408, #78350f); box-shadow: 0 4px 20px rgba(245,158,11,.35);
}
.mf-mockbar-dot { width: 8px; height: 8px; border-radius: 50%; background: #fbbf24; box-shadow: 0 0 0 3px rgba(251,191,36,.25); flex: none; }
.mf-mockbar-text { background: none; border: none; padding: 2px 4px; color: #fde68a; font: inherit; cursor: pointer; text-decoration: underline dotted; text-underline-offset: 3px; }
.mf-mockbar-text:hover { color: #fff; }
.mf-mockbar-clear {
  padding: 5px 12px; border-radius: 999px; background: #f59e0b; color: #1c1408; border: 1px solid #fbbf24;
  font: 700 12px inherit; font-family: inherit; cursor: pointer; white-space: nowrap;
}
.mf-mockbar-clear:hover { background: #fbbf24; }
.mf-mockbar-reload {
  padding: 5px 12px; border-radius: 999px; background: transparent; color: #fcd34d; border: 1px solid #f59e0b;
  font: 600 12px inherit; font-family: inherit; cursor: pointer; white-space: nowrap;
}
.mf-mockbar-reload:hover { background: rgba(245,158,11,.2); color: #fff; }
.mf-mock-pending { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 6px; color: #fcd34d; font-size: 12px; }
.mf-net-tag--mock { background: rgba(245,158,11,.18); color: #fcd34d; }
.mf-mockbar-list {
  display: flex; flex-direction: column; gap: 2px; padding: 6px; border-radius: 10px; max-height: 40vh; overflow: auto;
  background: #0a0910; border: 1px solid #78350f; box-shadow: 0 6px 24px rgba(0,0,0,.45);
}
.mf-mockbar-item { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 6px; color: #e0d9ff; font-weight: 500; }
.mf-mockbar-item:hover { background: rgba(245,158,11,.08); }
.mf-mockbar-url { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12px ui-monospace, monospace; }
.mf-mockbar-res { color: #fcd34d; font: 600 11.5px ui-monospace, monospace; white-space: nowrap; }
.mf-mockbar-hits { color: #8b83b8; font-size: 11px; white-space: nowrap; }
.mf-mockbar-x { background: none; border: none; color: #a78bfa; font-size: 16px; line-height: 1; cursor: pointer; padding: 0 4px; }
.mf-mockbar-x:hover { color: #fca5a5; }
.mf-mock-badge {
  flex: none; padding: 1px 6px; border-radius: 4px; background: rgba(245,158,11,.18); color: #fcd34d;
  font: 700 10px ui-monospace, monospace; letter-spacing: .06em; border: 1px solid rgba(245,158,11,.45);
}
.mf-net-btn--mock { color: #fcd34d; border-color: rgba(245,158,11,.4); }
.mf-net-btn--mock:hover { background: rgba(245,158,11,.12); color: #fde68a; }
.mf-net-btn--danger { color: #fca5a5; border-color: rgba(239,68,68,.4); }
.mf-net-btn--danger:hover { background: rgba(239,68,68,.12); color: #fecaca; }
.mf-mock-editor { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px dashed rgba(245,158,11,.45); border-radius: 8px; background: #0c0a08; }
.mf-mock-match { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
.mf-mock-match .mf-net-url { flex: 1 1 200px; }
.mf-mock-row { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px 12px; }
.mf-mock-field { display: flex; flex-direction: column; gap: 2px; color: #8b83b8; font-size: 11px; font-weight: 600; }
.mf-mock-input {
  width: 84px; padding: 4px 6px; background: #07060b; color: #e0d9ff; border: 1px solid #2f2950; border-radius: 6px;
  font: 12px ui-monospace, monospace; outline: none;
}
.mf-mock-input--wide { width: 170px; }
.mf-mock-input:focus { border-color: #f59e0b; }
.mf-mock-body { min-height: 120px; font: 12px/1.5 ui-monospace, monospace; }

/* Renders & state */
.mf-rs-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
.mf-rs-stats { flex: 1; min-width: 0; font-size: 12.5px; color: #c4b5fd; }
.mf-rs-stats strong { color: #fff; }
.mf-rs-wasted { color: #fcd34d; cursor: help; }
.mf-rs-mode { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; font-size: 12px; }
.mf-rs-kind { color: #e0d9ff; font-weight: 700; }
.mf-rs-note { flex-basis: 100%; line-height: 1.45; }
.mf-rs-mode--exact { background: rgba(16,185,129,.16); color: #6ee7b7; }
.mf-rs-mode--sampled, .mf-rs-mode--rough { background: rgba(245,158,11,.14); color: #fcd34d; }
.mf-rs-mode--off { background: rgba(239,68,68,.14); color: #fca5a5; }
.mf-rs-src { color: #6b648f; font: 600 10px ui-monospace, monospace; text-transform: uppercase; letter-spacing: .04em; flex: none; }
.mf-rs-cv-list { display: flex; flex-direction: column; gap: 6px; padding-top: 6px; max-height: 60vh; overflow: auto; }
.mf-rs-cv { display: flex; flex-direction: column; gap: 4px; padding: 7px 9px; border: 1px solid #221e33; border-radius: 8px; background: #0c0b13; min-width: 0; }
.mf-rs-cv--changed { animation: mf-rs-flash 1.2s ease-out; }
@keyframes mf-rs-flash { from { border-color: #7c3aed; background: rgba(124,58,237,.14); } to { border-color: #221e33; background: #0c0b13; } }
.mf-rs-cv-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-width: 0; }
.mf-rs-cv-key { color: #e0d9ff; font: 700 12px ui-monospace, monospace; overflow-wrap: anywhere; }
.mf-rs-cv-kind { color: #8b83b8; font: 11px ui-monospace, monospace; }
.mf-rs-mini { padding: 1px 8px; font-size: 11px; }
.mf-rs-tl-title { margin-top: 4px; }
.mf-rs-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; max-height: 420px; overflow: auto; border: 1px solid #221e33; border-radius: 8px; background: #07060b; }
.mf-rs-item { border-bottom: 1px solid #16131f; }
.mf-rs-item:last-child { border-bottom: none; }
.mf-rs-row { display: flex; align-items: baseline; gap: 8px; padding: 6px 8px; border-bottom: 1px solid #16131f; font-size: 12px; min-width: 0; }
.mf-rs-item .mf-rs-row { border-bottom: none; }
.mf-rs-row:last-child { border-bottom: none; }
.mf-rs-row--click { cursor: pointer; list-style: none; }
.mf-rs-row--click::-webkit-details-marker { display: none; }
.mf-rs-row--click::before { content: '▸'; flex: none; width: 8px; color: #6b648f; font-size: 10px; }
.mf-rs-entry[open] > .mf-rs-row--click::before { content: '▾'; color: #a78bfa; }
.mf-rs-row--click:hover { background: rgba(124,58,237,.08); }
.mf-rs-entry[open] > .mf-rs-row--click { background: rgba(124,58,237,.1); }
.mf-rs-row--nothing { background: rgba(245,158,11,.05); }
.mf-rs-row--end { color: #fca5a5; }
.mf-rs-empty { padding: 10px; }
.mf-rs-n { flex: none; min-width: 34px; color: #a78bfa; font: 700 11.5px ui-monospace, monospace; }
.mf-rs-time { flex: none; color: #6b648f; font: 11px ui-monospace, monospace; }
.mf-rs-nothing { color: #fcd34d; font-style: italic; }
.mf-rs-changes { flex: 1; display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
.mf-rs-change {
  display: inline; max-width: 100%; padding: 1px 7px; border-radius: 5px; overflow-wrap: anywhere; word-break: break-word;
  background: #1c1930; color: #d9d2ff; font: 11.5px/1.6 ui-monospace, monospace;
}
.mf-rs-change b { color: #fff; font-weight: 700; }
.mf-rs-change .mf-rs-src { margin-left: 6px; }
.mf-rs-change--prop { background: rgba(59,130,246,.14); }
.mf-rs-change--state { background: rgba(168,85,247,.16); }
.mf-rs-change--dom { background: rgba(16,185,129,.12); }
.mf-rs-change--ref { background: rgba(245,158,11,.10); color: #fcd34d; }
.mf-rs-change--more { background: transparent; color: #8b83b8; border: 1px dashed #2f2950; }
.mf-rs-from { color: #fca5a5; }
.mf-rs-to { color: #86efac; }
.mf-rs-arrow { color: #6b648f; }
.mf-rs-detail { display: flex; flex-direction: column; gap: 10px; padding: 8px 10px 12px 26px; border-top: 1px dashed #221e33; background: #0a0910; }
.mf-rs-dblock { display: flex; flex-direction: column; gap: 6px; }
.mf-rs-dtitle { display: flex; align-items: baseline; gap: 8px; font: 12px ui-monospace, monospace; color: #e0d9ff; }
.mf-rs-dpath { display: flex; flex-direction: column; gap: 4px; }
.mf-rs-dpath-name { color: #c4b5fd; font: 600 11.5px ui-monospace, monospace; overflow-wrap: anywhere; }
.mf-rs-ba { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 6px; }
.mf-rs-ba-col { display: flex; flex-direction: column; gap: 3px; min-width: 0; padding: 6px 8px; border: 1px solid #221e33; border-radius: 6px; background: #07060b; max-height: 320px; overflow: auto; }
.mf-rs-ba-lbl { color: #6b648f; font: 700 9.5px ui-monospace, monospace; text-transform: uppercase; letter-spacing: .06em; }
.mf-rs-full { color: #d9d2ff; font: 11.5px/1.5 ui-monospace, monospace; overflow-wrap: anywhere; word-break: break-word; }
.mf-rs-full--str { color: #86efac; white-space: pre-wrap; }
.mf-rs-whole summary { cursor: pointer; padding: 2px 0; }
.mf-rs-whole .mf-rs-ba { margin-top: 6px; }

/* Value trees (Renders & state, props, value source) */
.mf-vt { font: 11.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; color: #d9d2ff; min-width: 0; word-break: normal; }
.mf-vt-line { display: flex; align-items: baseline; gap: 4px; min-width: 0; padding: 0 2px; border-radius: 4px; }
.mf-vt-line--click { cursor: pointer; }
.mf-vt-line--click:hover { background: rgba(124,58,237,.12); }
.mf-vt-line:focus-visible { outline: 1px solid #7c3aed; }
.mf-vt-caret { flex: none; width: 10px; color: #8b5cf6; font-size: 10px; }
.mf-vt-key { flex: none; max-width: 45%; color: #a78bfa; overflow-wrap: anywhere; }
.mf-vt-idx { flex: none; color: #6b648f; }
.mf-vt-colon { flex: none; color: #4b4570; margin-left: -3px; }
.mf-vt-prev { min-width: 0; overflow-wrap: anywhere; word-break: break-word; }
.mf-vt-prev--label { color: #8b83b8; }
.mf-vt-kids { margin-left: 5px; padding-left: 9px; border-left: 1px solid #221e33; }
.mf-vt-str { color: #86efac; }
.mf-vt-str--raw { white-space: pre-wrap; }
.mf-vt-strwrap { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 0; }
.mf-vt-clamp { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; line-clamp: 4; overflow: hidden; }
.mf-vt-num { color: #93c5fd; }
.mf-vt-bool { color: #f0abfc; }
.mf-vt-nil { color: #6b648f; }
.mf-vt-fn { color: #c4b5fd; font-style: italic; }
.mf-vt-lbl { color: #d9d2ff; }
.mf-vt-more {
  padding: 0; background: none; border: none; color: #60a5fa; font: 600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  cursor: pointer; text-decoration: underline; text-underline-offset: 2px;
}
.mf-vt-page { display: block; margin: 2px 0 2px 14px; }
.mf-vt-note { color: #6b648f; font-size: 11px; margin-left: 14px; }

/* Full-value overlay */
.mf-vmodal { position: fixed; inset: 0; z-index: 7; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; padding: 4vh 3vw; }
.mf-vmodal-card {
  width: min(1100px, 100%); height: 100%; display: flex; flex-direction: column; overflow: hidden;
  background: #0a0910; border: 1px solid #3b2f63; border-radius: 12px; color: #e0d9ff;
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; box-shadow: 0 20px 60px rgba(0,0,0,.6);
}
.mf-vmodal-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 12px 16px; border-bottom: 1px solid #2a2540; background: #100e19; }
.mf-vmodal-title { flex: 1; min-width: 0; overflow-wrap: anywhere; color: #c4b5fd; }
.mf-vmodal-body { flex: 1; overflow: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.mf-vmodal-sum { color: #8b83b8; font: 12px ui-monospace, monospace; overflow-wrap: anywhere; }
.mf-vmodal-tree .mf-vt { font-size: 12.5px; }
.mf-vmodal-json { margin: 0; font: 12px/1.5 ui-monospace, monospace; color: #d9d2ff; white-space: pre; tab-size: 2; }

/* Accessibility */
.mf-a11y-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.mf-a11y-summary { flex: 1; min-width: 0; }
.mf-a11y-list { display: flex; flex-direction: column; gap: 6px; }
.mf-a11y-item { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border: 1px solid #221e33; border-left: 3px solid #f59e0b; border-radius: 8px; background: #0c0b13; }
.mf-a11y-item--error { border-left-color: #ef4444; }
.mf-a11y-top { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.mf-a11y-sev { padding: 1px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
.mf-a11y-sev--error { background: rgba(239,68,68,.16); color: #fca5a5; }
.mf-a11y-sev--warn { background: rgba(245,158,11,.14); color: #fcd34d; }
.mf-a11y-rule { color: #8b83b8; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
.mf-a11y-msg { color: #e0d9ff; font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
.mf-a11y-swatch { padding: 0 6px; border-radius: 4px; border: 1px solid #2f2950; font: 700 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.mf-a11y-tag { color: #c4b5fd; font: 11.5px ui-monospace, monospace; overflow-wrap: anywhere; word-break: break-all; }
.mf-a11y-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
.mf-a11y-actions .mf-linkbtn { margin-right: auto; font-size: 12px; }
.mf-a11y-actions .mf-linkbtn:disabled { color: #5f5880; cursor: default; text-decoration: none; }

/* Moving panels by their header */
.mf-drag-handle { cursor: grab; user-select: none; -webkit-user-select: none; touch-action: none; }
.mf-overlay:not(.mf-overlay--docked) .mf-drag-handle { cursor: auto; }
.mf-dragging, .mf-dragging .mf-drag-handle { cursor: grabbing; }
.mf-dragging { box-shadow: 0 18px 50px rgba(0,0,0,.6), 0 0 0 1px #7c3aed; }
.mf-overlay--docked .mf-detail.mf-moved { bottom: auto; max-height: calc(100vh - 16px); height: calc(100vh - 128px); }
/* Meta tags */
.mf-pagecheck-body { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.mf-pc-row { display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; border: 1px solid #221e33; border-radius: 8px; background: #0c0b13; }
.mf-pc-row .mf-net-btn { align-self: flex-start; margin-top: 2px; }
.mf-pc-top { display: flex; align-items: baseline; gap: 8px; }
.mf-pc-icon { flex: none; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; font-size: 11px; font-weight: 800; }
.mf-pc-icon--ok { background: rgba(16,185,129,.18); color: #6ee7b7; }
.mf-pc-icon--warn { background: rgba(245,158,11,.18); color: #fcd34d; }
.mf-pc-icon--fail { background: rgba(239,68,68,.18); color: #fca5a5; }
.mf-pc-name { font-weight: 700; color: #fff; }
.mf-pc-status { margin-left: auto; color: #a59cd3; font-size: 12px; text-align: right; }
.mf-pc-row--fail .mf-pc-status { color: #fca5a5; }
.mf-pc-row--warn .mf-pc-status { color: #fcd34d; }
.mf-pc-value { color: #d9d2ff; font: 12px ui-monospace, monospace; overflow-wrap: anywhere; }
.mf-pc-server { color: #fcd34d; font-size: 12px; }

/* Production unlock */
.mf-unlock {
  position: fixed; right: 20px; bottom: 72px; z-index: 6; width: min(320px, calc(100vw - 40px)); padding: 14px;
  display: flex; flex-direction: column; gap: 8px; background: #0a0910; border: 1px solid #3b2f63; border-radius: 10px;
  color: #e0d9ff; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; box-shadow: 0 10px 30px rgba(0,0,0,.5);
}
.mf-unlock-title { font-weight: 700; color: #fff; }
.mf-unlock-input {
  width: 100%; padding: 7px 10px; background: #07060b; color: #e0d9ff; border: 1px solid #2f2950; border-radius: 6px;
  font: 13px ui-monospace, monospace; outline: none;
}
.mf-unlock-input:focus { border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59,130,246,.25); }
.mf-unlock-row { display: flex; gap: 8px; }
.mf-unlock-err { color: #fca5a5; font-size: 12px; min-height: 1em; }
.mf-lock-btn {
  width: 34px; height: 34px; border-radius: 50%; border: 1px solid #4c1d95; background: #0f0c29; cursor: pointer; font-size: 14px;
  box-shadow: 0 4px 16px rgba(124,58,237,.3);
}
.mf-lock-btn:hover { border-color: #3b82f6; }

/* Web Vitals */
.mf-wv { display: flex; flex-direction: column; gap: 10px; }
.mf-wv-card { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 1px solid #221e33; border-left: 3px solid #4b4570; border-radius: 8px; background: #0c0b13; min-width: 0; }
.mf-wv-card--good { border-left-color: #10b981; }
.mf-wv-card--needs-improvement { border-left-color: #f59e0b; }
.mf-wv-card--poor { border-left-color: #ef4444; }
.mf-wv-top { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; }
.mf-wv-name { font-weight: 800; color: #fff; letter-spacing: .02em; }
.mf-wv-value { font: 700 18px ui-monospace, monospace; color: #fff; font-variant-numeric: tabular-nums; }
.mf-wv-rating { padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: capitalize; }
.mf-wv-rating--good { background: rgba(16,185,129,.16); color: #6ee7b7; }
.mf-wv-rating--needs-improvement { background: rgba(245,158,11,.16); color: #fcd34d; }
.mf-wv-rating--poor { background: rgba(239,68,68,.16); color: #fca5a5; }
.mf-wv-rating--none { background: #1c1930; color: #8b83b8; }
.mf-wv-sub { flex-basis: 100%; color: #6b648f; font-size: 11px; }
.mf-wv-line { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 12px; min-width: 0; }
.mf-wv-lbl { color: #8b83b8; font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
.mf-wv-where { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; min-width: 0; }
.mf-wv-where .mf-linkbtn { font-size: 12px; }
.mf-wv-tag { color: #e0d9ff; font: 12px ui-monospace, monospace; overflow-wrap: anywhere; }
.mf-wv-comp { padding: 0 6px; border-radius: 4px; background: rgba(124,58,237,.16); color: #c4b5fd; font: 600 11px ui-monospace, monospace; }
.mf-wv-show { padding: 0 8px; font-size: 11px; }
.mf-wv-url { color: #a59cd3; font: 11.5px ui-monospace, monospace; overflow-wrap: anywhere; word-break: break-all; }
.mf-wv-fn { color: #fde68a; font: 12px ui-monospace, monospace; }
.mf-wv-attr { color: #8b83b8; font: 11px ui-monospace, monospace; overflow-wrap: anywhere; }
.mf-wv-bars { display: flex; flex-direction: column; gap: 4px; }
.mf-wv-bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: #1c1930; }
.mf-wv-seg { display: block; height: 100%; }
.mf-wv-seg--0 { background: #6366f1; }
.mf-wv-seg--1 { background: #f59e0b; }
.mf-wv-seg--2 { background: #10b981; }
.mf-wv-seg--3 { background: #ec4899; }
.mf-wv-legend { display: flex; flex-wrap: wrap; gap: 2px 12px; color: #a59cd3; font-size: 11px; }
.mf-wv-leg { display: inline-flex; align-items: center; gap: 4px; }
.mf-wv-dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; }
.mf-wv-hint { color: #fcd34d; font-size: 12px; line-height: 1.45; }
.mf-wv-hint::before { content: '→ '; color: #8b83b8; }
.mf-wv-item { display: flex; flex-direction: column; gap: 5px; padding-top: 8px; border-top: 1px dashed #221e33; }
.mf-wv-item--worst .mf-wv-amount { text-decoration: underline; text-underline-offset: 3px; }
.mf-wv-amount { flex: none; color: #fff; font: 700 12px ui-monospace, monospace; }
.mf-wv-amount--poor { color: #fca5a5; }
.mf-wv-amount--needs-improvement { color: #fcd34d; }
.mf-wv-amount--good { color: #6ee7b7; }
.mf-wv-moved { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; font-size: 12px; padding-left: 12px; }
.mf-wv-moved-one { display: inline-flex; align-items: center; gap: 4px; }
.mf-wv-mine { color: #6ee7b7; font-size: 11.5px; font-weight: 600; }
.mf-wv-scripts { display: flex; flex-direction: column; gap: 2px; padding-left: 12px; }
.mf-wv-script { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 11.5px; }
.mf-wv-warn { color: #fca5a5; font-size: 11px; }
.mf-wv-extra { font-size: 11.5px; }

/* Value source */
.mf-prov { margin-top: 4px; padding-top: 8px; border-top: 1px solid #312e81; display: flex; flex-direction: column; gap: 4px; word-break: normal; }
.mf-prov-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.mf-prov-head .mf-linkbtn { font: 600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #60a5fa; }
.mf-prov-list { list-style: none; margin: 0; padding: 0 0 0 2px; display: flex; flex-direction: column; gap: 3px; }
.mf-prov-step { position: relative; display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; padding-left: 14px; font-size: 12px; overflow-wrap: anywhere; }
.mf-prov-step::before { content: '←'; position: absolute; left: 0; color: #6b648f; }
.mf-prov-step--shown::before { content: '•'; color: #a78bfa; }
.mf-prov-val { color: #fff; font-weight: 700; }
.mf-prov-kind { flex: none; padding: 0 6px; border-radius: 4px; background: rgba(168,85,247,.16); color: #d8b4fe; font: 700 10px ui-monospace, monospace; text-transform: uppercase; letter-spacing: .04em; }
.mf-prov-step--prop .mf-prov-kind { background: rgba(59,130,246,.16); color: #93c5fd; }
.mf-prov-kind--call { background: #1c1930; color: #c4b5fd; }
.mf-prov-kind--code { background: rgba(236,72,153,.16); color: #f9a8d4; }
.mf-prov-kind--net { background: rgba(16,185,129,.16); color: #6ee7b7; }
.mf-prov-path { color: #e0d9ff; font: 12px ui-monospace, monospace; }
.mf-prov-url { color: #a5f3fc; font: 12px ui-monospace, monospace; word-break: break-all; }
.mf-prov-alt { color: #fcd34d; font-size: 11px; cursor: help; }
.mf-prov-note { line-height: 1.4; }
.mf-prov .mf-linkbtn { font-size: 12px; }
.mf-agent-note { margin-top: 4px; padding: 5px 8px; border-radius: 6px; background: rgba(16,185,129,.08); border: 1px solid rgba(16,185,129,.25); color: #6ee7b7; font-size: 11.5px; }
`;
