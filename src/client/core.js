import { CSS } from './styles.js';
import {
  injectChanges,
  removeInjected,
  loadChanges,
  saveChanges,
} from './styleLab.js';
import { componentChain, ownText, componentRoots, findCurrentFiber, readReact, readVue, setProductionNames } from './inspect.js';
import { buildAiSection, loadEdits, loadProposals, resumeErrorWatch, renderEditBar } from './codeEdit.js';
import { installCapture, uninstallCapture, buildNetwork } from './network.js';
import { installStorageCapture, uninstallStorageCapture, buildStorage } from './storage.js';
import { ngLocate, ngResolve, ngRead } from './angular.js';
import { installReportCapture, uninstallReportCapture, buildReport } from './report.js';
import { buildRenders } from './renders.js';
import { buildA11y } from './a11y.js';
import { buildMetaTags } from './pageCheck.js';
import { renderMockBar } from './mocks.js';
import { closeValueModal, valueTree, describe as describeValue, openValueModal } from './valueView.js';
import { installVitals, uninstallVitals, buildVitals, vitalsSummary, onVitals } from './vitals.js';
import { traceValue, traceText, shownValue } from './provenance.js';
import { shareSelection, startSharing, stopSharing } from './mcp.js';

const API = '/__sourcepeek';
let state = null;

// Record fetch / XHR from the moment the Sourcepeek module loads, so requests fired during the first render
// show up in the Network section. Clicks and console errors are recorded the same way, for the bug report.
// localStorage / sessionStorage / Cache Storage reads and writes too, for the Storage section.
// Removed again if there is no Sourcepeek backend (e.g. a production build).
if (typeof window !== 'undefined') {
  installCapture();
  installReportCapture();
  installStorageCapture();
  installVitals();
}
let refCount = 0;
let teardownTimer = null;

export function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  for (const [name, secs] of [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
    const n = Math.floor(s / secs);
    if (n >= 1) return `${n} ${name}${n > 1 ? 's' : ''} ago`;
  }
  return 'just now';
}

export async function api(route, body) {
  try {
    const res = await fetch(API + route, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json', 'x-sourcepeek': '1' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, data } : { ok: false, status: res.status, data, error: data.error || `HTTP ${res.status}` };
  } catch {
    return { ok: false, error: 'Sourcepeek backend unreachable — is your dev server running?' };
  }
}

const IDES = [
  { id: 'vscode', name: 'VS Code', url: (p, l) => `vscode://file${encodeURI(p)}:${l}` },
  { id: 'cursor', name: 'Cursor', url: (p, l) => `cursor://file${encodeURI(p)}:${l}` },
  { id: 'windsurf', name: 'Windsurf', url: (p, l) => `windsurf://file${encodeURI(p)}:${l}` },
  { id: 'vscode-insiders', name: 'VS Code Insiders', url: (p, l) => `vscode-insiders://file${encodeURI(p)}:${l}` },
  { id: 'zed', name: 'Zed', url: (p, l) => `zed://file${encodeURI(p)}:${l}` },
  { id: 'webstorm', name: 'WebStorm', url: (p, l) => `webstorm://open?file=${encodeURIComponent(p)}&line=${l}` },
  { id: 'idea', name: 'IntelliJ IDEA', url: (p, l) => `idea://open?file=${encodeURIComponent(p)}&line=${l}` },
];
const IDE_KEY = 'sourcepeek:ide';

function preferredIde() {
  let id = null;
  try {
    id = localStorage.getItem(IDE_KEY);
  } catch {}
  id = id || (state && state.defaultIde) || 'vscode';
  const want = String(id).toLowerCase().replace(/\s+/g, '');
  return IDES.find((i) => i.id === want || i.name.toLowerCase().replace(/\s+/g, '') === want) || IDES[0];
}

function setPreferredIde(ide) {
  try {
    localStorage.setItem(IDE_KEY, ide.id);
  } catch {}
}

function openInIde(ide, absPath, line) {
  const p = absPath.replace(/\\/g, '/');
  const a = document.createElement('a');
  a.href = ide.url(p.startsWith('/') ? p : '/' + p, line || 1);
  a.click();
}

const isAbs = (f) => /^(\/|[A-Za-z]:[\\/])/.test(f);

/** Absolute path on disk, computed from the project root the backend reported. */
export function absPath(file) {
  if (!file) return null;
  if (isAbs(file)) return file;
  const root = (state && state.root) || '';
  if (!root) return null;
  const sep = state.sep || '/';
  return root.replace(/[\\/]+$/, '') + sep + String(file).replace(/^\.?[\\/]/, '').split('/').join(sep);
}

/** Project-relative path, for copying and display. */
export function relPath(file) {
  const f = String(file || '').replace(/\\/g, '/');
  const root = ((state && state.root) || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (root && f.toLowerCase().startsWith(root.toLowerCase() + '/')) return f.slice(root.length + 1);
  return f.replace(/^\//, '');
}

export function openSource(file, line) {
  const abs = absPath(file);
  if (!abs) return false;
  openInIde(preferredIde(), abs, line);
  return true;
}

export function fileLine(file, line) {
  return line ? `${relPath(file)}:${line}` : relPath(file);
}

export function toast(text, kind) {
  if (!state || !state.ui) return;
  const t = state.ui.toast;
  t.textContent = text;
  t.className = 'mf-toast' + (kind ? ' mf-toast--' + kind : '');
  t.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

export function copy(text, button) {
  const original = button ? button.dataset.label || button.textContent : '';
  if (button) button.dataset.label = original;
  const flash = (msg) => {
    if (!button) return toast(msg === 'Copied ✓' ? `Copied ${text.length > 60 ? text.slice(0, 60) + '…' : text}` : msg, msg === 'Copied ✓' ? 'ok' : 'error');
    button.textContent = msg;
    setTimeout(() => (button.textContent = original), 1500);
  };
  const legacy = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {}
    ta.remove();
    flash(ok ? 'Copied ✓' : 'Copy failed');
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => flash('Copied ✓'), legacy);
  } else legacy();
}

function baseName(f) {
  return String(f).split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
}

export function locate(target) {
  let node = target;
  while (node && node.nodeType === 1) {
    const d = node.dataset;
    if (d && d.mfFile) {
      return { el: node, file: d.mfFile, line: Number(d.mfLine) || 1, comp: d.mfComp || baseName(d.mfFile) };
    }
    // A component usage that rendered straight to the DOM without a tagged element of its own:
    // styled-components / emotion (`<Title>` → <h1>), or a library component that forwards data-* props.
    // Its data-mf-call points at the `<Title …>` line in the user's file — the right place to edit.
    if (d && d.mfCall) {
      const m = String(d.mfCall).match(/^(.*):(\d+)$/);
      if (m) {
        let comp = null;
        for (let a = node.parentElement; a && !comp; a = a.parentElement) if (a.dataset && a.dataset.mfFile === m[1]) comp = a.dataset.mfComp;
        return { el: node, file: m[1], line: Number(m[2]), comp: comp || baseName(m[1]), viaCall: true };
      }
    }
    const meta = node.__svelte_meta;
    if (meta && meta.loc && meta.loc.file) {
      return { el: node, file: meta.loc.file, line: (meta.loc.line || 0) + ((state && state.svelteLineOffset) || 0), comp: baseName(meta.loc.file) };
    }
    node = node.parentElement;
  }
  node = target;
  while (node && node.nodeType === 1) {
    const inst = node.__vueParentComponent;
    if (inst && inst.type && inst.type.__file) {
      return { el: node, file: inst.type.__file, line: 1, comp: inst.type.__name || baseName(inst.type.__file) };
    }
    node = node.parentElement;
  }
  // Angular: no tags in the DOM; the owning component comes from the dev-mode debug API (file/line resolved async).
  return ngLocate(target);
}

/** Completes a hit that needs the backend to know its exact file and line (Angular templates). */
export async function resolveHit(hit) {
  if (!hit || !hit.ng) return hit;
  return ngResolve(hit, api);
}

function detectSvelteOffset() {
  const v = (typeof window !== 'undefined' && window.__svelte && window.__svelte.v) || null;
  if (v && [...v].some((x) => String(x).startsWith('5'))) return 0;
  if (v && [...v].some((x) => /^[34]/.test(String(x)))) return 1;
  return 0;
}

function buildUi() {
  const host = document.createElement('sourcepeek-root');
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0; width: 0; height: 0;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  shadow.appendChild(style);

  const highlight = el('div', 'mf-highlight');
  const label = el('div', 'mf-highlight-label');
  highlight.appendChild(label);
  highlight.hidden = true;

  const toggle = el('button', 'mf-toggle', 'Sourcepeek: OFF');
  toggle.title = 'Toggle inspect mode (Esc to exit). Alt+click any element to jump straight to its code.';
  const toggles = el('div', 'mf-toggles');
  toggles.append(toggle);

  // Bars that stay on screen with every panel closed: active mocks, and the last code change.
  const mockBar = el('div', 'mf-mockbar');
  mockBar.hidden = true;
  mockBar.setAttribute('role', 'status');
  const editBar = el('div', 'mf-editbar');
  editBar.hidden = true;
  const bars = el('div', 'mf-bars');
  bars.append(mockBar, editBar);

  const toastEl = el('div', 'mf-toast');
  toastEl.hidden = true;

  shadow.append(highlight, toggles, bars, toastEl);
  document.body.appendChild(host);
  return { host, shadow, highlight, label, toggle, mockBar, editBar, toast: toastEl };
}

function setInspect(on) {
  state.inspect = on;
  state.ui.toggle.textContent = on ? 'Sourcepeek: ON' : 'Sourcepeek: OFF';
  state.ui.toggle.classList.toggle('on', on);
  document.documentElement.style.cursor = on ? 'crosshair' : '';
  if (!on) state.ui.highlight.hidden = true;
}

function isOurs(e) {
  return e.composedPath().includes(state.ui.host);
}

function highlightEl(target, text) {
  const h = state.ui.highlight;
  if (!target || !target.isConnected) return (h.hidden = true);
  const r = target.getBoundingClientRect();
  Object.assign(h.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  state.ui.label.textContent = text;
  h.hidden = false;
}

/** Briefly outline an element on the page (Accessibility findings, Meta tags h1s). */
export function flashElement(target, text, hoverOnly) {
  if (!state || !state.ui || !target || !target.isConnected) return;
  highlightEl(target, text);
  clearTimeout(state.flashTimer);
  state.flashTimer = setTimeout(() => {
    if (state && state.ui && !state.inspect) state.ui.highlight.hidden = true;
  }, hoverOnly ? 900 : 1800);
}

function onMove(e) {
  state.lastPointer = { x: e.clientX, y: e.clientY, target: e.target };
  const altPeek = e.altKey && !state.inspect;
  if ((!state.inspect && !altPeek) || isOurs(e)) {
    if (!state.inspect) state.ui.highlight.hidden = true;
    return;
  }
  const hit = locate(e.target);
  if (!hit) return (state.ui.highlight.hidden = true);
  const tag = hit.el.tagName.toLowerCase();
  highlightEl(hit.el, altPeek ? `${hit.comp} · ${tag} — click: open in ${preferredIde().name}` : `${hit.comp} · ${tag}`);
}

// Alt+click opens the editor directly; Alt+Shift+click copies file:line. Works with inspect mode on or off.
const altAction = (e) => e.altKey && !e.ctrlKey && !e.metaKey && e.button === 0;

function swallow(e) {
  if (isOurs(e)) return;
  if (!state.inspect && !(altAction(e) && locate(e.target))) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}

function onClick(e) {
  if (isOurs(e)) return;
  if (altAction(e)) {
    const hit = locate(e.target);
    if (!hit) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const shift = e.shiftKey;
    const act = (h) => {
      if (!h.file) return toast(h.error || 'Could not resolve the file path', 'error');
      if (shift) return copy(fileLine(h.file, h.line));
      if (openSource(h.file, h.line)) toast(`Opening ${fileLine(h.file, h.line)} in ${preferredIde().name}`, 'ok');
      else toast('Could not resolve the file path', 'error');
    };
    if (hit.ng) resolveHit(hit).then(act);
    else act(hit);
    return;
  }
  if (!state.inspect) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const hit = locate(e.target);
  if (!hit) return;
  inspectHit(hit, e.clientX, e.clientY);
}

/** Show the panel for a hit, resolving its exact location first when the framework needs the backend for it. */
function inspectHit(hit, x, y) {
  if (!hit.ng) return showPanel(hit, x, y);
  const token = (state.inspectToken = (state.inspectToken || 0) + 1);
  highlightEl(hit.el, `${hit.comp} · ${hit.el.tagName.toLowerCase()} — locating…`);
  resolveHit(hit).then((h) => {
    if (!state || state.inspectToken !== token) return;
    if (!state.inspect) state.ui.highlight.hidden = true;
    else if (state.ui.label.textContent.endsWith('locating…')) state.ui.label.textContent = `${hit.comp} · ${hit.el.tagName.toLowerCase()}`;
    if (!h.file) return toast(h.error || 'Could not find the source of this element', 'error');
    showPanel(h, x, y);
  });
}

function onKeyUp(e) {
  if (e.key === 'Alt' && !state.inspect && state.ui) state.ui.highlight.hidden = true;
}

function onKey(e) {
  if (e.key === 'Alt' && !state.inspect && state.lastPointer && !isOurs(e)) {
    const hit = locate(state.lastPointer.target);
    if (hit) highlightEl(hit.el, `${hit.comp} · ${hit.el.tagName.toLowerCase()} — click: open in ${preferredIde().name}`);
  }
  if (e.key === 'Escape') {
    // The full-value overlay closes first.
    if (closeValueModal()) return;
    const t = e.composedPath()[0];
    if (state.ui && isOurs(e) && t && t.tagName === 'TEXTAREA') {
      t.blur();
      return;
    }
    // An open "$" popover closes first; the next Escape closes the More view.
    if (state.detail && state.closeUsage && state.closeUsage()) return;
    if (state.detail) return closeDetail();
    if (state.panel) return closePanel();
    if (state.inspect) setInspect(false);
  }
}

function closePanel() {
  if (state.panelMover) state.panelMover.destroy();
  state.panelMover = null;
  if (state.panelObserver) state.panelObserver.disconnect();
  if (state.panelResize) window.removeEventListener('resize', state.panelResize);
  state.panelObserver = null;
  state.panelResize = null;
  if (state.panel) state.panel.remove();
  state.panel = null;
}

const DRAG_KEY = 'sourcepeek:pos:';

function loadPos(key) {
  if (!key) return null;
  try {
    const v = JSON.parse(localStorage.getItem(DRAG_KEY + key) || 'null');
    return v && Number.isFinite(v.left) && Number.isFinite(v.top) ? v : null;
  } catch {
    return null;
  }
}

function savePos(key, pos) {
  if (!key) return;
  try {
    if (pos) localStorage.setItem(DRAG_KEY + key, JSON.stringify(pos));
    else localStorage.removeItem(DRAG_KEY + key);
  } catch {}
}

/**
 * Let a fixed-position card be moved around the page by dragging `handle` (its header).
 * Buttons and inputs inside the handle keep working; double-click the handle to put the card back.
 * `key` remembers the spot across panels and reloads. Returns { moved, reset, apply, destroy }.
 */
export function makeDraggable(card, handle, { key, enabled = () => true, onReset } = {}) {
  const keep = 48; // px of the card that must stay on screen
  let pos = loadPos(key);
  const clamp = (p) => {
    const w = card.offsetWidth || 300;
    const h = handle.offsetHeight || 40;
    return {
      left: Math.round(Math.min(Math.max(p.left, keep - w), window.innerWidth - keep)),
      top: Math.round(Math.min(Math.max(p.top, 0), window.innerHeight - Math.max(h, 120))),
    };
  };
  const apply = () => {
    if (!pos || !enabled()) {
      card.classList.remove('mf-moved');
      ['left', 'top', 'right', 'bottom', 'height', 'max-height'].forEach((k) => card.style.removeProperty(k));
      return false;
    }
    pos = clamp(pos);
    card.classList.add('mf-moved');
    // Lower down, the card gets shorter rather than running off the bottom of the window.
    Object.assign(card.style, { left: pos.left + 'px', top: pos.top + 'px', right: 'auto', bottom: 'auto', maxHeight: Math.max(120, window.innerHeight - pos.top - 8) + 'px' });
    return true;
  };
  const reset = () => {
    pos = null;
    savePos(key, null);
    apply();
    if (onReset) onReset();
  };
  const interactive = (t) => t && t.closest && t.closest('button, a, input, select, textarea, label, [role="button"]');
  let drag = null;
  const down = (e) => {
    if (e.button !== 0 || !enabled() || interactive(e.target)) return;
    const r = card.getBoundingClientRect();
    drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, height: r.height };
    // Fix the size where it is now, so a docked panel (top + bottom anchored) keeps its height while moving.
    card.style.height = r.height + 'px';
    pos = { left: r.left, top: r.top };
    apply();
    card.classList.add('mf-dragging');
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {}
    e.preventDefault();
  };
  const move = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    pos = { left: e.clientX - drag.dx, top: e.clientY - drag.dy };
    apply();
  };
  const up = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    card.classList.remove('mf-dragging');
    card.style.removeProperty('height');
    apply();
    savePos(key, pos);
  };
  const dbl = (e) => {
    if (!interactive(e.target) && pos) reset();
  };
  const onResize = () => pos && apply();
  handle.classList.add('mf-drag-handle');
  handle.title = handle.title || 'Drag to move · double-click to put it back';
  handle.addEventListener('pointerdown', down);
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', up);
  handle.addEventListener('dblclick', dbl);
  window.addEventListener('resize', onResize);
  apply();
  return {
    moved: () => Boolean(pos) && enabled(),
    reset,
    apply,
    destroy: () => window.removeEventListener('resize', onResize),
  };
}

function placePanel(panel, x, y) {
  const m = 8;
  const gap = 12;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = panel.offsetWidth;
  const h = panel.offsetHeight;
  let left = x + gap;
  if (left + w > vw - m) left = x - gap - w;
  left = Math.max(m, Math.min(left, vw - w - m));
  let top = y + gap;
  if (top + h > vh - m) top = y - gap - h >= m ? y - gap - h : vh - h - m;
  top = Math.max(m, Math.min(top, vh - h - m));
  panel.style.left = left + 'px';
  panel.style.top = top + 'px';
}

export function closeDetail() {
  closeValueModal();
  if (state.detailCleanup) state.detailCleanup.forEach((fn) => fn());
  state.detailCleanup = [];
  if (state.detail) state.detail.remove();
  state.detail = null;
  state.onStylesChanged = null;
  state.onEditsChanged = null;
}

export function getState() {
  return state;
}

export function closePanelPublic() {
  closePanel();
}

export function commitStyles() {
  saveChanges(state.styles);
  injectChanges(state.styles);
  if (state.onStylesChanged) state.onStylesChanged();
}

function row(labelText, value) {
  const d = el('div', 'mf-row');
  d.append(el('span', 'mf-label', labelText), document.createTextNode(String(value)));
  return d;
}

/**
 * "CSS: a b c …" — long class lists (Tailwind!) are clamped to two lines with a "more" toggle that shows all of them.
 * The toggle only appears when the list really overflows two lines.
 */
function classesRow(labelText, value) {
  const d = el('div', 'mf-row mf-classes-row');
  const text = String(value || '');
  const clamp = el('div', 'mf-classes mf-classes--clamped');
  clamp.append(el('span', 'mf-label', labelText), document.createTextNode(text));
  const toggle = el('button', 'mf-classes-more', 'more');
  toggle.type = 'button';
  const count = text.split(/\s+/).filter(Boolean).length;
  toggle.title = `Show all ${count} classes`;
  toggle.hidden = true;
  toggle.onclick = (e) => {
    e.stopPropagation();
    const clamped = clamp.classList.toggle('mf-classes--clamped');
    toggle.textContent = clamped ? 'more' : 'less';
    toggle.title = clamped ? `Show all ${count} classes` : 'Collapse to two lines';
  };
  d.append(clamp, toggle);
  // Overflow can only be measured once the row is laid out (the panel is attached after it is built), and it changes
  // when the panel is resized or docked.
  let tries = 0;
  const measure = () => {
    if (!d.isConnected) {
      if (tries++ < 20) requestAnimationFrame(measure);
      return;
    }
    if (!clamp.classList.contains('mf-classes--clamped')) return;
    toggle.hidden = clamp.scrollHeight <= clamp.clientHeight + 2;
  };
  requestAnimationFrame(measure);
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => measure());
    ro.observe(clamp);
  }
  return d;
}

function renderGit(box, data) {
  box.textContent = '';
  box.appendChild(el('div', 'mf-section-title', 'Git'));
  if (!data.git) {
    box.appendChild(el('div', 'mf-muted', 'Not inside a git repository.'));
    return;
  }
  box.appendChild(row('Branch:', data.branch || 'unknown'));
  if (data.blame) {
    box.appendChild(
      row('Line changed:', data.blame.uncommitted ? 'not committed yet' : `${data.blame.author}, ${timeAgo(data.blame.date)}`)
    );
  }
  box.appendChild(el('div', 'mf-section-title', 'Recent commits'));
  if (data.note) box.appendChild(el('div', 'mf-muted mf-missing-key', data.note));
  else if (!data.commits.length) box.appendChild(el('div', 'mf-muted', 'No commits for this file yet'));
  for (const c of data.commits) {
    const r = el('div', 'mf-commit');
    r.append(el('code', 'mf-hash', c.hash.slice(0, 7)), el('span', 'mf-subject', c.subject), el('div', 'mf-muted', `${c.author} · ${timeAgo(c.date)}`));
    box.appendChild(r);
  }
  if (data.githubUrl) {
    const a = el('a', 'mf-link', 'View on GitHub ↗');
    a.href = data.githubUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    box.appendChild(a);
  }
}


function linkButton(text, title, onClick) {
  const b = el('button', 'mf-linkbtn', text);
  b.type = 'button';
  if (title) b.title = title;
  b.onclick = onClick;
  return b;
}

function sourceLink(file, line) {
  return linkButton(fileLine(file, line), `Open in ${preferredIde().name}`, () => openSource(file, line));
}

function renderCrumbs(chain, current, x, y) {
  const wrap = el('nav', 'mf-crumbs');
  wrap.setAttribute('aria-label', 'Component chain');
  const shown = chain.length > 6 ? [chain[0], null, ...chain.slice(-4)] : chain;
  shown.forEach((c, i) => {
    if (i) wrap.appendChild(el('span', 'mf-crumb-sep', '›'));
    if (!c) return wrap.appendChild(el('span', 'mf-crumb-sep', '…'));
    const isCurrent = c === current;
    const b = el('button', 'mf-crumb' + (isCurrent ? ' mf-crumb--current' : ''), c.name);
    b.type = 'button';
    b.title = [c.file ? fileLine(c.file, c.line) : null, c.callSite ? `used at ${fileLine(c.callSite.file, c.callSite.line)}` : null, 'Alt+click: open in editor']
      .filter(Boolean)
      .join('\n');
    b.onmouseenter = () => c.el && highlightEl(c.el, c.name);
    b.onmouseleave = () => (state.ui.highlight.hidden = !state.inspect);
    b.onclick = (e) => {
      if (e.altKey) {
        if (c.file) openSource(c.file, c.line);
        else if (c.callSite) openSource(c.callSite.file, c.callSite.line);
        return;
      }
      if (isCurrent) return;
      const hit = c.el ? locate(c.el) : null;
      if (hit) inspectHit({ ...hit, comp: c.name }, x, y);
      else if (c.file) openSource(c.file, c.line);
    };
    wrap.appendChild(b);
  });
  return wrap;
}

/** "Props of X": each value is a tree you can open (raw values), or the plain preview when only that is known. */
function kvBlock(title, rows, raw) {
  const box = el('details', 'mf-kv');
  box.appendChild(el('summary', 'mf-section-title', `${title} (${rows.length})`));
  const list = el('div', 'mf-kv-list');
  const live = Array.isArray(raw) && raw.length === rows.length ? raw : null;
  rows.slice(0, 40).forEach(([k, v], i) => {
    const r = el('div', 'mf-kv-row');
    r.appendChild(el('span', 'mf-kv-key', k));
    if (live) {
      const value = live[i][1];
      const tree = valueTree(value);
      tree.classList.add('mf-kv-val', 'mf-kv-tree');
      r.appendChild(tree);
      if (describeValue(value).kids) {
        const full = el('button', 'mf-kv-full', '⤢');
        full.type = 'button';
        full.title = `Show all of ${k}`;
        full.onclick = (e) => {
          e.stopPropagation();
          openValueModal(state.ui.shadow, `${title.replace(/^Props of /, '')} · ${k}`, value, { onCopy: (text, b) => copy(text, b) });
        };
        r.appendChild(full);
      }
    } else r.appendChild(el('code', 'mf-kv-val', v));
    list.appendChild(r);
  });
  if (rows.length > 40) list.appendChild(el('div', 'mf-muted', `…${rows.length - 40} more`));
  box.appendChild(list);
  return box;
}

function renderI18n(box, data) {
  box.textContent = '';
  if (!data || !data.matches || !data.matches.length) return (box.hidden = true);
  box.hidden = false;
  box.appendChild(el('div', 'mf-section-title', 'Text from translations'));
  const seen = new Set();
  for (const m of data.matches) {
    if (seen.has(m.file + m.key)) continue;
    seen.add(m.file + m.key);
    if (seen.size > 4) break;
    const r = el('div', 'mf-i18n-row');
    const key = el('code', 'mf-i18n-key', m.key);
    const cp = linkButton('copy key', 'Copy translation key', () => copy(m.key));
    r.append(key, cp, el('span', 'mf-muted', ' in '), sourceLink(m.file, m.line));
    if (!m.exact) r.appendChild(el('span', 'mf-muted', ' (with placeholders)'));
    box.appendChild(r);
  }
  for (const u of (data.usage || []).slice(0, 2)) {
    const r = el('div', 'mf-i18n-row');
    r.append(el('span', 'mf-muted', u.exact ? `“${u.key}” used at ` : `probably used at `), sourceLink(u.file, u.line));
    box.appendChild(r);
  }
}

/** Live props and state of a chain item (React fiber, Vue instance, Angular component). */
function rawOf(item) {
  try {
    if (item && item._fiber) return readReact(findCurrentFiber(item._fiber) || item._fiber, true);
    if (item && item._inst) return readVue(item._inst, true);
    if (item && item._ngInst) return ngRead(item._ngInst, true);
  } catch {}
  return { props: [], state: [] };
}

const STEP_LABEL = { prop: 'prop', state: 'state', memo: 'useMemo', store: 'store', context: 'context', ref: 'ref' };

/** "Value source": the chain from the shown value back to its origin, one row per hop. */
function renderTrace(box, trace) {
  box.textContent = '';
  if (!trace || (!trace.found && !trace.note)) return (box.hidden = true);
  box.hidden = false;
  const head = el('div', 'mf-prov-head');
  head.append(el('span', 'mf-section-title', 'Value source'));
  const cp = linkButton('copy', 'Copy the chain as text', () => copy(traceText(trace, fileLine)));
  head.appendChild(cp);
  box.appendChild(head);
  const list = el('ol', 'mf-prov-list');
  for (const s of trace.steps) {
    const li = el('li', 'mf-prov-step mf-prov-step--' + s.kind);
    if (s.kind === 'shown') {
      li.append(el('span', 'mf-prov-val', `“${s.text.length > 60 ? s.text.slice(0, 60) + '…' : s.text}”`), el('span', 'mf-muted', ` in <${s.tag}>`));
    } else if (STEP_LABEL[s.kind]) {
      li.append(el('span', 'mf-prov-kind', STEP_LABEL[s.kind]), el('code', 'mf-prov-path', s.path), el('span', 'mf-muted', ` of <${s.comp}>`));
      if (s.alternatives) li.appendChild(el('span', 'mf-prov-alt', ` +${s.alternatives} similar`));
      li.title = `${s.path} = ${s.value}`;
    } else if (s.kind === 'passed') {
      li.append(el('span', 'mf-prov-kind mf-prov-kind--call', 'passed'));
      if (s.parent) li.appendChild(el('span', 'mf-muted', `by <${s.parent}> `));
      if (s.file) li.appendChild(sourceLink(s.file, s.line));
      if (s.text) li.appendChild(el('code', 'mf-prov-path', s.text));
      if (s.iterates) li.appendChild(el('span', 'mf-muted', ` · one item of ${s.iterates}`));
    } else if (s.kind === 'literal') {
      li.append(el('span', 'mf-prov-kind mf-prov-kind--code', 'code'), sourceLink(s.file, s.line), el('code', 'mf-prov-path', s.text));
    } else if (s.kind === 'network') {
      li.append(el('span', 'mf-prov-kind mf-prov-kind--net', s.method), el('code', 'mf-prov-url', s.url), el('span', 'mf-muted', ` ${s.status || ''}${s.mocked ? ' MOCK' : ''} → `), el('code', 'mf-prov-path', s.path));
      li.title = `${s.path} = ${s.value}`;
    } else if (s.kind === 'storage') {
      li.append(el('span', 'mf-prov-kind mf-prov-kind--net', s.area), el('code', 'mf-prov-path', `${s.key} → ${s.path}`));
    } else if (s.kind === 'url') {
      li.append(el('span', 'mf-prov-kind mf-prov-kind--net', 'URL'), el('code', 'mf-prov-path', s.where));
    } else if (s.kind === 'lost') {
      li.append(el('span', 'mf-muted', s.note));
    }
    list.appendChild(li);
  }
  box.appendChild(list);
  if (!trace.found && trace.note) box.appendChild(el('div', 'mf-muted mf-prov-note', trace.note));
}

function showPanel(hit, x, y) {
  closePanel();
  const cssClasses = typeof hit.el.className === 'string' ? hit.el.className : hit.el.getAttribute('class') || '';
  const tagName = hit.el.tagName.toLowerCase();
  const chain = componentChain(hit.el, { lineOffset: state.svelteLineOffset || 0 });
  // The component that owns this element: last matching name in the chain (closest to the element).
  const current = [...chain].reverse().find((c) => c.name === hit.comp) || chain[chain.length - 1] || null;
  const callSite = hit.callSite || (current && current.callSite);
  const text = ownText(hit.el);
  // Where on the page the developer clicked (page coordinates) — Change with AI uses it to place new UI "here".
  const point = Number.isFinite(x) && Number.isFinite(y) ? { x: x + (window.scrollX || 0), y: y + (window.scrollY || 0) } : null;

  const panel = el('div', 'mf-panel');
  const header = el('div', 'mf-panel-header');
  const close = el('button', 'mf-close', '×');
  close.onclick = closePanel;
  header.append(el('strong', null, hit.comp), close);

  const body = el('div', 'mf-panel-body');
  if (chain.length > 1) body.appendChild(renderCrumbs(chain, current, x, y));

  const fileRow = el('div', 'mf-row mf-file-row');
  const copyBtn = el('button', 'mf-mini-btn', 'Copy file:line');
  copyBtn.title = 'Copy path:line (Alt+Shift+click an element does the same)';
  copyBtn.onclick = () => copy(fileLine(hit.file, hit.line), copyBtn);
  fileRow.append(el('span', 'mf-label', 'File:'), sourceLink(hit.file, hit.line), copyBtn);
  body.append(fileRow);
  if (hit.classFile && hit.classFile !== hit.file) {
    const r = el('div', 'mf-row');
    r.append(el('span', 'mf-label', 'Class:'), sourceLink(hit.classFile, hit.classLine || 1));
    r.title = 'The component class (inputs, state, handlers)';
    body.appendChild(r);
  }
  body.append(row('Tag:', tagName));
  if (cssClasses) body.append(classesRow('CSS:', cssClasses));
  if (callSite) {
    const r = el('div', 'mf-row');
    r.append(el('span', 'mf-label', 'Used in:'), sourceLink(callSite.file, callSite.line));
    r.title = `Where <${hit.comp}> is rendered on this page`;
    body.appendChild(r);
  }

  const i18nBox = el('div', 'mf-i18n');
  i18nBox.hidden = true;
  body.appendChild(i18nBox);

  // "Where does this value come from?" — traced right away (props, state, call-sites, responses), shown when done.
  const srcBox = el('div', 'mf-prov');
  srcBox.hidden = true;
  body.appendChild(srcBox);

  // Only props here; component state is shown in the "More →" view.
  if (current && current.props && current.props.length) {
    const kv = el('div', 'mf-kv-wrap');
    kv.appendChild(kvBlock(`Props of ${current.name}`, current.props, current.propsRaw));
    body.appendChild(kv);
  }

  const gitBox = el('div', 'mf-git');
  gitBox.appendChild(el('div', 'mf-muted', 'Loading git info…'));
  body.appendChild(gitBox);

  const ideWrap = el('div', 'mf-ide');
  const split = el('div', 'mf-ide-split');
  const ideOpen = el('button', 'mf-ide-toggle', `Open in ${preferredIde().name}`);
  ideOpen.title = 'Tip: Alt+click any element to skip this panel';
  ideOpen.onclick = () => openSource(hit.file, hit.line);
  const ideToggle = el('button', 'mf-ide-caret', '▾');
  ideToggle.title = 'Choose editor';
  const ideMenu = el('div', 'mf-ide-menu');
  ideMenu.hidden = true;
  ideToggle.onclick = () => (ideMenu.hidden = !ideMenu.hidden);
  for (const ide of IDES) {
    const b = el('button', 'mf-ide-item', ide.name + (ide.id === preferredIde().id ? '  ✓' : ''));
    b.onclick = () => {
      setPreferredIde(ide);
      ideOpen.textContent = `Open in ${ide.name}`;
      ideMenu.hidden = true;
      ideMenu.querySelectorAll('.mf-ide-item').forEach((n, i) => (n.textContent = IDES[i].name + (IDES[i].id === ide.id ? '  ✓' : '')));
      openSource(hit.file, hit.line);
    };
    ideMenu.appendChild(b);
  }
  split.append(ideOpen, ideToggle);
  ideWrap.append(split, ideMenu);
  ideWrap.hidden = !absPath(hit.file);
  body.appendChild(ideWrap);

  if (state.mcp) {
    const agent = el('div', 'mf-agent-note', 'Shared with your coding agent — ask it to “fix this”.');
    agent.title = 'Your agent reads this selection through the Sourcepeek MCP server (get_selection).';
    body.appendChild(agent);
  }

  const more = el('button', 'mf-more-btn', 'More →');
  body.appendChild(more);
  panel.append(header, body);

  panel.style.visibility = 'hidden';
  state.ui.shadow.appendChild(panel);
  state.panel = panel;
  let mover = null;
  const place = () => (mover && mover.moved() ? mover.apply() : placePanel(panel, x, y));
  mover = makeDraggable(panel, header, { key: 'panel', onReset: () => placePanel(panel, x, y) });
  place();
  panel.style.visibility = '';
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(place);
    ro.observe(panel);
    state.panelObserver = ro;
  }
  window.addEventListener('resize', place);
  state.panelResize = place;
  state.panelMover = mover;

  let gitContext = null;
  api('/context', { file: hit.file, line: hit.line }).then((res) => {
    if (state.panel !== panel) return;
    if (!res.ok) {
      gitBox.textContent = '';
      gitBox.appendChild(el('div', 'mf-muted', res.error));
      return;
    }
    gitContext = res.data;
    renderGit(gitBox, res.data);
    if (res.data.absPath && !absPath(hit.file)) {
      // Root unknown on the client (unusual): fall back to the server's absolute path.
      ideOpen.onclick = () => openInIde(preferredIde(), res.data.absPath, hit.line);
      ideWrap.hidden = false;
    }
  });

  // What coding agents see through `npx sourcepeek mcp` (dev server only).
  const raw = rawOf(current);
  const shareCtx = {
    el: hit.el,
    comp: hit.comp,
    file: hit.file,
    line: hit.line,
    classFile: hit.classFile,
    classLine: hit.classLine,
    callSite,
    chain,
    propsRaw: raw.props,
    stateRaw: raw.state,
    stateOwner: current && current.name,
    framework: current && current._fiber ? 'react' : current && current._inst ? 'vue' : current && current._ngInst ? 'angular' : hit.el.__svelte_meta ? 'svelte' : null,
  };
  shareSelection(shareCtx);

  const shown = shownValue(hit.el);
  if (shown) {
    const traceCtx = { el: hit.el, file: hit.file, line: hit.line, comp: hit.comp, chain, current, callSite };
    traceValue(traceCtx)
      .then((trace) => {
        if (state.panel !== panel) return;
        panel.mfTrace = trace;
        renderTrace(srcBox, trace);
        if (trace.found) shareSelection({ ...shareCtx, trace, traceText: traceText(trace, fileLine) });
      })
      .catch(() => {});
  }

  if (text && /\p{L}/u.test(text)) {
    api('/i18n', { text, files: [hit.file, callSite && callSite.file].filter(Boolean) }).then((res) => {
      if (state.panel === panel && res.ok) renderI18n(i18nBox, res.data);
    });
  }

  const propsText = current && current.props && current.props.length ? current.props.map(([k, v]) => `${k}=${v}`).join(', ') : '';
  more.onclick = () =>
    showDetail({
      componentName: hit.comp,
      file: hit.file,
      line: hit.line,
      tagName,
      cssClasses,
      gitContext,
      el: hit.el,
      text,
      callSite: callSite && callSite.line ? `${callSite.file}:${callSite.line}` : null,
      props: propsText,
      propsRows: current && current.props ? current.props : [],
      chain: chain.map((c) => c.name),
      point,
      state: current && current.state && current.state.length ? { owner: current.name, rows: current.state } : null,
      // What "Renders & state" follows and what "Accessibility" checks: the component instance itself.
      track: {
        fiber: (current && current._fiber) || null,
        vueInst: (current && current._inst) || null,
        ngInst: (current && current._ngInst) || null,
        el: hit.el,
        root: (current && current.el) || null,
        file: (current && current.file) || hit.file,
        name: (current && current.name) || hit.comp,
      },
    });
}

const MISSING_KEY = 'Missing AI key in .env (e.g. OPENAI_API_KEY, ANTHROPIC_API_KEY or GEMINI_API_KEY)';

function loadAi(route, payload, box, render) {
  box.textContent = '';
  box.appendChild(el('div', 'mf-muted', 'Loading…'));
  return api(route, payload).then((res) => {
    box.textContent = '';
    if (!res.ok) {
      box.appendChild(el('div', 'mf-muted', res.error));
      return false;
    }
    render(res.data.text);
    if (res.data.via) box.appendChild(el('div', 'mf-ai-via', `via ${res.data.via}`));
    return true;
  });
}

async function checkAiKey() {
  const res = await api('/health');
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: Boolean(res.data && res.data.ai) };
}

function showMissing(box, error) {
  box.textContent = '';
  box.appendChild(el('div', 'mf-muted mf-missing-key', error || MISSING_KEY));
}

function accordion(title, onOpen) {
  const s = el('div', 'mf-acc');
  const head = el('button', 'mf-acc-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', 'false');
  const titleEl = el('span', 'mf-section-title', title);
  const extra = el('span', 'mf-acc-extra');
  const left = el('span', 'mf-acc-title');
  left.append(titleEl, extra);
  head.append(left, el('span', 'mf-acc-icon', '▸'));
  const body = el('div', 'mf-acc-body');
  body.hidden = true;
  head.onclick = () => {
    const open = body.hidden;
    body.hidden = !open;
    s.classList.toggle('mf-acc--open', open);
    head.setAttribute('aria-expanded', String(open));
    if (open && onOpen) onOpen(body);
  };
  s.append(head, body);
  return {
    s,
    body,
    open: () => body.hidden && head.click(),
    /** Text after the title, visible while collapsed: "Accessibility · 3 issues". */
    setExtra: (text, kind) => {
      extra.textContent = text ? ` · ${text}` : '';
      extra.className = 'mf-acc-extra' + (kind ? ' mf-acc-extra--' + kind : '') + (extra.dataset.units ? ' mf-acc-extra--units' : '');
    },
  };
}

/** "Summary": what the component does, with its potential issues inside — one accordion, both loaded on open. */
function summarySection(payload) {
  let done = false;
  let busy = false;
  return accordion('Summary', async (box) => {
    if (done || busy) return;
    busy = true;
    box.textContent = '';
    box.appendChild(el('div', 'mf-muted', 'Loading…'));
    const key = await checkAiKey();
    if (!key.ok) {
      busy = false;
      return showMissing(box, key.error);
    }
    box.textContent = '';
    const about = el('div', 'mf-summary-part');
    const issuesTitle = el('div', 'mf-subsection-title', 'Potential issues');
    const issues = el('div', 'mf-summary-part');
    box.append(about, issuesTitle, issues);
    const [a, b] = await Promise.all([
      loadAi('/ai/summarize', payload, about, (t) => (about.textContent = t || 'No summary available.')),
      loadAi('/ai/errors', payload, issues, (t) => (issues.textContent = t || 'No analysis available.')),
    ]);
    // Only cache once both parts loaded; a failed part is retried on the next open.
    done = a && b;
    busy = false;
  });
}

/** "Refactor": opening the accordion requests the refactor; a successful answer is kept for later opens. */
function refactorSection(payload) {
  let done = false;
  let busy = false;
  return accordion('Refactor', async (box) => {
    if (done || busy) return;
    busy = true;
    box.textContent = '';
    box.appendChild(el('div', 'mf-muted', 'Loading…'));
    const key = await checkAiKey();
    if (!key.ok) {
      busy = false;
      return showMissing(box, key.error);
    }
    const out = el('div', 'mf-ai-refactor');
    box.textContent = '';
    box.appendChild(out);
    // A failed request is retried the next time the accordion opens.
    done = await loadAi('/ai/refactor', payload, out, (t) => {
      if (!t) return out.appendChild(el('div', 'mf-muted', 'No refactor suggestion available.'));
      const pre = el('pre', 'mf-refactor-output', t);
      const cp = el('button', 'mf-copy-btn', 'Copy to clipboard');
      cp.onclick = () => copy(t, cp);
      out.append(pre, cp);
    });
    busy = false;
  });
}

function formatUsd(v) {
  if (!v) return '$0.00';
  if (v < 0.01) return '$' + v.toFixed(4);
  if (v < 1) return '$' + v.toFixed(3);
  return '$' + v.toFixed(2);
}

const formatPrice = (v) => '$' + (Math.round(v * 100) === v * 100 ? v.toFixed(2) : String(v));

const formatTokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0));

/** Round "$" button for the More view header: spend for the AI model in use, tracked from token usage. */
function usageButton(card) {
  const wrap = el('div', 'mf-usage');
  const btn = el('button', 'mf-usage-btn', '$');
  btn.type = 'button';
  btn.title = 'AI spend for the current model';
  btn.setAttribute('aria-label', 'AI spend for the current model');
  btn.setAttribute('aria-expanded', 'false');
  const pop = el('div', 'mf-usage-pop');
  pop.hidden = true;
  pop.setAttribute('role', 'dialog');
  wrap.append(btn, pop);

  const render = (data) => {
    pop.textContent = '';
    const c = data && data.current;
    if (!c) {
      pop.appendChild(el('div', 'mf-muted mf-missing-key', MISSING_KEY));
      return;
    }
    pop.appendChild(el('div', 'mf-usage-model', `${c.label} · ${c.model}`));
    const amount = el('div', 'mf-usage-amount', c.local ? '$0.00' : c.priced || c.calls === 0 ? formatUsd(c.cost) : '—');
    pop.appendChild(amount);
    const note = c.local
      ? 'Local model — free.'
      : c.reported
        ? 'Cost reported by the provider.'
        : !c.price
          ? 'No price known for this model — set SOURCEPEEK_AI_PRICE="input,output" (USD per 1M tokens) in .env.'
          : `Estimate at ${formatPrice(c.price.input)} in / ${formatPrice(c.price.output)} out per 1M tokens${c.price.source === 'env' ? ' (SOURCEPEEK_AI_PRICE)' : ''}.`;
    pop.appendChild(el('div', 'mf-usage-note', note));
    if (c.partial) pop.appendChild(el('div', 'mf-usage-note', 'Some earlier calls had no known price and are not included.'));
    const stats = el('div', 'mf-usage-stats');
    const stat = (label, value) => {
      const r = el('div', 'mf-usage-stat');
      r.append(el('span', 'mf-muted', label), el('span', null, value));
      stats.appendChild(r);
    };
    stat('Requests', String(c.calls));
    stat('Input tokens', formatTokens(c.input + (c.cacheRead || 0) + (c.cacheWrite || 0)));
    stat('Output tokens', formatTokens(c.output));
    if (c.since) stat('Since', new Date(c.since).toLocaleDateString());
    if (data.models > 1) stat('All models', formatUsd(data.total));
    pop.appendChild(stats);
    pop.appendChild(el('div', 'mf-usage-note', 'Counts requests made through Sourcepeek in this project, not your whole account.'));
    const actions = el('div', 'mf-usage-actions');
    const refresh = el('button', 'mf-dock-btn', 'Refresh');
    refresh.type = 'button';
    refresh.onclick = load;
    const reset = el('button', 'mf-dock-btn', 'Reset');
    reset.type = 'button';
    let armed = false;
    reset.onclick = async () => {
      if (!armed) {
        armed = true;
        reset.textContent = 'Click again to reset';
        return;
      }
      const res = await api('/ai/usage/reset', {});
      if (res.ok) render(res.data);
    };
    actions.append(refresh, reset);
    pop.appendChild(actions);
  };

  async function load() {
    pop.textContent = '';
    pop.appendChild(el('div', 'mf-muted', 'Loading…'));
    const res = await api('/ai/usage');
    if (!res.ok) {
      pop.textContent = '';
      pop.appendChild(el('div', 'mf-muted', res.error));
      return;
    }
    render(res.data);
  }

  const setOpen = (open) => {
    pop.hidden = !open;
    btn.classList.toggle('mf-usage-btn--active', open);
    btn.setAttribute('aria-expanded', String(open));
    if (open) load();
  };
  btn.onclick = (e) => {
    e.stopPropagation();
    setOpen(pop.hidden);
  };
  pop.onclick = (e) => e.stopPropagation();
  // Selecting text in the popover must not start dragging the docked panel by its header.
  pop.addEventListener('pointerdown', (e) => e.stopPropagation());
  pop.addEventListener('mousedown', (e) => e.stopPropagation());
  // Clicking anywhere else in the panel closes it; Escape is handled by onKey through state.closeUsage.
  card.addEventListener('click', () => !pop.hidden && setOpen(false));
  state.closeUsage = () => {
    if (pop.hidden || !pop.isConnected) return false;
    setOpen(false);
    btn.focus();
    return true;
  };
  return wrap;
}

function keyGatedSection(title, build) {
  let built = false;
  let busy = false;
  return accordion(title, async (box) => {
    if (built || busy) return;
    busy = true;
    box.textContent = '';
    box.appendChild(el('div', 'mf-muted', 'Checking…'));
    const key = await checkAiKey();
    busy = false;
    if (!key.ok) return showMissing(box, key.error);
    box.textContent = '';
    build(box);
    built = true;
  });
}


export { checkAiKey, showMissing };

function showDetail(ctx) {
  closeDetail();
  const overlay = el('div', 'mf-overlay');
  overlay.onclick = (e) => {
    // Must not return false: an onclick handler returning false cancels the default action (e.g. checkboxes).
    if (e.target === overlay) closeDetail();
  };
  const card = el('div', 'mf-detail');
  const header = el('div', 'mf-detail-header');
  const close = el('button', 'mf-close mf-detail-close', '×');
  close.onclick = closeDetail;
  // Both view buttons are always there; the current view is shown as pressed.
  const viewSwitch = el('div', 'mf-view-switch');
  viewSwitch.setAttribute('role', 'group');
  viewSwitch.setAttribute('aria-label', 'Panel layout');
  const expandBtn = el('button', 'mf-dock-btn', 'Expand');
  expandBtn.type = 'button';
  expandBtn.title = 'Full view';
  const dockBtn = el('button', 'mf-dock-btn', 'Dock to side');
  dockBtn.type = 'button';
  dockBtn.title = 'Side panel — the page stays visible and usable';
  let mover = null;
  const setDocked = (docked) => {
    const was = overlay.classList.contains('mf-overlay--docked');
    if (docked && !was) closePanel();
    overlay.classList.toggle('mf-overlay--docked', docked);
    if (mover) mover.apply();
    expandBtn.classList.toggle('mf-dock-btn--active', !docked);
    dockBtn.classList.toggle('mf-dock-btn--active', docked);
    expandBtn.setAttribute('aria-pressed', String(!docked));
    dockBtn.setAttribute('aria-pressed', String(docked));
  };
  expandBtn.onclick = () => setDocked(false);
  dockBtn.onclick = () => setDocked(true);
  viewSwitch.append(expandBtn, dockBtn);
  // Opens docked to the side so the page stays usable; "Expand" switches to the full view.
  setDocked(ctx.docked !== false);
  const headRight = el('div', 'mf-detail-header-right');
  headRight.append(usageButton(card), viewSwitch, close);
  header.append(el('strong', null, ctx.componentName), headRight);

  const body = el('div', 'mf-detail-body');
  const info = el('div', 'mf-detail-info');
  const fileRow = el('div', 'mf-row');
  fileRow.append(el('span', 'mf-label', 'File:'), sourceLink(ctx.file, ctx.line));
  info.append(fileRow, row('Tag:', ctx.tagName), ctx.cssClasses ? classesRow('CSS:', ctx.cssClasses) : row('CSS:', '—'));

  const payload = { componentName: ctx.componentName, file: ctx.file, cssClasses: ctx.cssClasses, gitContext: ctx.gitContext };

  const summary = summarySection(payload);

  // "Fix with AI" in Accessibility runs through Change with AI, which may not be built (or unlocked) yet.
  let aiSection = null;
  let pendingFix = null;
  const change = keyGatedSection('Change with AI', (box) => {
    aiSection = buildAiSection(ctx, overlay, { dock: () => setDocked(true) });
    box.appendChild(aiSection);
    if (pendingFix) {
      const f = pendingFix;
      pendingFix = null;
      aiSection.mfFix(...f);
    }
  });
  const fixWithAi = (instruction, target, kind) => {
    if (aiSection && aiSection.isConnected) {
      change.open();
      aiSection.mfFix(instruction, target, kind);
    } else {
      pendingFix = [instruction, target, kind];
      change.open();
    }
    setTimeout(() => change.s.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50);
  };

  // Renders & state: starts tracking when opened, stops when the More view closes.
  let rendersBuilt = false;
  const renders = accordion('Renders & state', (box) => {
    if (rendersBuilt) return;
    rendersBuilt = true;
    state.detailCleanup = state.detailCleanup || [];
    state.detailCleanup.push(buildRenders(box, { componentName: ctx.componentName, file: ctx.file, track: ctx.track }));
  });

  const refactor = refactorSection(payload);

  // Network needs no AI key: it reads the source and the requests captured on this page. Mocks are made here too.
  let networkBuilt = false;
  const network = accordion('Network', (box) => {
    if (networkBuilt) return;
    networkBuilt = true;
    state.detailCleanup = state.detailCleanup || [];
    state.detailCleanup.push(buildNetwork(box, { file: ctx.file, componentName: ctx.componentName }));
  });

  // Storage needs no AI key: keys from the source code plus reads/writes captured on this page.
  let storageBuilt = false;
  const storage = accordion('Storage', (box) => {
    if (storageBuilt) return;
    storageBuilt = true;
    state.detailCleanup = state.detailCleanup || [];
    state.detailCleanup.push(
      buildStorage(box, { file: ctx.file, componentName: ctx.componentName, onCount: (n) => storage.setExtra(n ? `${n} key${n === 1 ? '' : 's'}` : '') })
    );
  });

  // Report needs no AI key either: screenshot, source location, props/state, failed requests, console errors, clicks.
  let reportBuilt = false;
  const report = accordion('Report', (box) => {
    if (reportBuilt) return;
    reportBuilt = true;
    state.detailCleanup = state.detailCleanup || [];
    state.detailCleanup.push(buildReport(box, ctx));
  });

  // Accessibility runs right away (DOM only, no AI key) so its header shows the issue count while collapsed.
  const a11y = accordion('Accessibility');
  const a11yCount = (n) => a11y.setExtra(n ? `${n} issue${n === 1 ? '' : 's'}` : 'no issues', n ? 'warn' : 'ok');
  try {
    buildA11y(a11y.body, {
      roots: () => componentRoots(ctx.track || { el: ctx.el }),
      target: ctx.el,
      componentName: ctx.componentName,
      onCount: a11yCount,
      fix: fixWithAi,
    });
  } catch (err) {
    a11y.body.appendChild(el('div', 'mf-muted', `Accessibility check failed: ${(err && err.message) || err}`));
  }

  // Web Vitals: LCP / CLS / INP of this page, each pointed at a file and line. No AI key. The header shows the numbers.
  let vitalsBuilt = false;
  const vitals = accordion('Web Vitals', (box) => {
    if (vitalsBuilt) return;
    vitalsBuilt = true;
    state.detailCleanup = state.detailCleanup || [];
    state.detailCleanup.push(buildVitals(box, { file: ctx.file, componentName: ctx.componentName, onSummary: (t, k) => vitals.setExtra(t, k) }));
  });
  const showVitals = () => {
    const v = vitalsSummary();
    vitals.setExtra(v.text, v.kind);
  };
  const vitalsExtraEl = vitals.s.querySelector('.mf-acc-extra');
  if (vitalsExtraEl) vitalsExtraEl.dataset.units = '1';
  showVitals();
  state.detailCleanup = state.detailCleanup || [];
  state.detailCleanup.push(onVitals(showVitals));

  // Meta tags: SEO basics for the whole page (title, description, h1, canonical, Open Graph, lang). No AI key.
  let metaBuilt = false;
  const meta = accordion('Meta tags', (box) => {
    if (metaBuilt) return;
    metaBuilt = true;
    state.detailCleanup = state.detailCleanup || [];
    state.detailCleanup.push(
      buildMetaTags(box, {
        onCount: (fail, warn) =>
          meta.setExtra(
            fail ? `${fail} problem${fail === 1 ? '' : 's'}` : warn ? `${warn} warning${warn === 1 ? '' : 's'}` : 'all good',
            fail || warn ? 'warn' : 'ok'
          ),
      })
    );
  });

  const sections = el('div', 'mf-acc-list');
  sections.append(summary.s, change.s, renders.s, network.s, storage.s, a11y.s, vitals.s, meta.s, refactor.s, report.s);
  body.append(info, sections);
  card.append(header, body);
  overlay.appendChild(card);
  state.ui.shadow.appendChild(overlay);
  state.detail = overlay;
  // The docked panel can be dragged anywhere by its header; the full view stays centred.
  mover = makeDraggable(card, header, { key: 'docked', enabled: () => overlay.classList.contains('mf-overlay--docked') });
  state.detailCleanup = state.detailCleanup || [];
  state.detailCleanup.push(() => mover.destroy());
  if (ctx.openChange) change.open();
  if (ctx.openReport) report.open();
}

const CAPTURE = { capture: true };
const SWALLOWED = ['mousedown', 'mouseup', 'pointerdown', 'pointerup'];

export function mount() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  refCount++;
  // A Fast Refresh / HMR remount (unmount immediately followed by mount) keeps the UI and its state.
  if (teardownTimer) {
    clearTimeout(teardownTimer);
    teardownTimer = null;
  }
  if (state) {
    state.orphaned = false;
    return;
  }
  installCapture();
  installReportCapture();
  installStorageCapture();
  installVitals();
  state = { inspect: false, panel: null, detail: null, ui: null, alive: true, styles: [], edits: [], proposals: [], onStylesChanged: null, onEditsChanged: null };
  const mine = state;

  api('/health').then((res) => {
    if (state !== mine || !mine.alive) return;
    if (res.ok && res.data && res.data.name === 'sourcepeek' && res.data.locked) return lockedUi(mine);
    const remoteBlocked = res.ok && res.data && res.data.remoteBlocked;
    if (remoteBlocked) console.info('[sourcepeek] this device is not this computer, so Sourcepeek stays off. Set SOURCEPEEK_ALLOW_REMOTE=1 to use it from other devices.');
    if (remoteBlocked || !res.ok || !res.data || res.data.name !== 'sourcepeek') {
      uninstallCapture();
      uninstallReportCapture();
      uninstallStorageCapture();
      uninstallVitals();
      if (/^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost)$/.test(location.hostname))
        console.info('[sourcepeek] backend not found at /__sourcepeek — run `npx sourcepeek setup` and restart your dev server.');
      return;
    }
    boot(mine, res.data);
  });
}

function boot(mine, health) {
  mine.root = health.root || '';
  mine.sep = health.sep || (/^[A-Za-z]:\\/.test(mine.root) ? '\\' : '/');
  mine.defaultIde = health.ide || null;
  mine.canEdit = Boolean(health.canEdit);
  mine.ai = Boolean(health.ai);
  mine.runId = health.runId || null;
  mine.editReason = health.editReason || null;
  mine.prod = Boolean(health.prod);
  setProductionNames(mine.prod);
  mine.mcp = Boolean(health.mcp);
  mine.share = Boolean(health.share);
  const start = () => {
    if (state !== mine || !mine.alive) return;
    mine.svelteLineOffset = detectSvelteOffset();
    mine.ui = buildUi();
    mine.ui.toggle.onclick = () => setInspect(!mine.inspect);
    if (mine.prod) addLockButton(mine);
    mine.styles = loadChanges();
    mine.edits = loadEdits(mine.runId);
    mine.proposals = loadProposals(mine.runId);
    commitStyles();
    renderEditBar();
    renderMockBar();
    resumeErrorWatch();
    window.addEventListener('click', onClick, CAPTURE);
    window.addEventListener('mousemove', onMove, CAPTURE);
    window.addEventListener('keydown', onKey, CAPTURE);
    window.addEventListener('keyup', onKeyUp, CAPTURE);
    SWALLOWED.forEach((t) => window.addEventListener(t, swallow, CAPTURE));
    if (mine.share) startSharing(mine.mcp);
    if (mine.onBoot) mine.onBoot.forEach((fn) => fn());
  };
  document.body ? start() : window.addEventListener('DOMContentLoaded', start, { once: true });
}

// ---------- production: locked until the SOURCEPEEK_TOKEN is entered ----------

const UNLOCK_HINT = 'sourcepeek:unlock';

/** On a deployment the backend answers nothing until unlocked. The button only shows with ?sourcepeek / #sourcepeek in
 *  the URL, or in a browser that unlocked before — visitors of the site never see it. Nothing is recorded meanwhile. */
function lockedUi(mine) {
  uninstallCapture();
  uninstallReportCapture();
  uninstallStorageCapture();
  uninstallVitals();
  let hinted = false;
  try {
    hinted = localStorage.getItem(UNLOCK_HINT) === '1';
  } catch {}
  if (!hinted && !/[?&#]sourcepeek\b/i.test(location.search + location.hash)) return;
  const show = () => {
    if (state !== mine || !mine.alive) return;
    const ui = buildUi();
    mine.ui = ui;
    ui.toggle.textContent = 'Sourcepeek 🔒';
    ui.toggle.title = 'Locked on this deployment — enter SOURCEPEEK_TOKEN to unlock';
    const pop = el('form', 'mf-unlock');
    pop.hidden = true;
    pop.setAttribute('aria-label', 'Unlock Sourcepeek');
    const title = el('div', 'mf-unlock-title', 'Unlock Sourcepeek');
    const note = el('div', 'mf-muted', 'This deployment is locked. Enter the SOURCEPEEK_TOKEN it was deployed with. The session lasts 12 hours in this browser.');
    const input = el('input', 'mf-unlock-input');
    input.type = 'password';
    input.autocomplete = 'current-password';
    input.placeholder = 'SOURCEPEEK_TOKEN';
    input.setAttribute('aria-label', 'SOURCEPEEK_TOKEN');
    const row = el('div', 'mf-unlock-row');
    const go = el('button', 'mf-net-btn mf-net-btn--primary', 'Unlock');
    go.type = 'submit';
    const cancel = el('button', 'mf-net-btn', 'Cancel');
    cancel.type = 'button';
    row.append(go, cancel);
    const err = el('div', 'mf-unlock-err');
    err.setAttribute('role', 'alert');
    pop.append(title, note, input, row, err);
    ui.shadow.appendChild(pop);
    ui.toggle.onclick = () => {
      pop.hidden = !pop.hidden;
      if (!pop.hidden) input.focus();
    };
    cancel.onclick = () => (pop.hidden = true);
    pop.onsubmit = async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return input.focus();
      go.disabled = true;
      err.textContent = '';
      const res = await api('/auth', { token: input.value });
      go.disabled = false;
      if (!res.ok) {
        err.textContent = res.status === 429 ? res.error : res.status === 401 ? 'Wrong token.' : res.error;
        input.select();
        return;
      }
      try {
        localStorage.setItem(UNLOCK_HINT, '1');
      } catch {}
      input.value = '';
      ui.host.remove();
      mine.ui = null;
      installCapture();
      installReportCapture();
      installStorageCapture();
      installVitals();
      const health = await api('/health');
      if (health.ok && health.data && !health.data.locked) boot(mine, health.data);
    };
  };
  document.body ? show() : window.addEventListener('DOMContentLoaded', show, { once: true });
}

/** Production, unlocked: a small button that ends the session (the cookie is HttpOnly, so only the server can clear it). */
function addLockButton(mine) {
  const b = el('button', 'mf-lock-btn', '🔓');
  b.type = 'button';
  b.title = 'Lock Sourcepeek again in this browser (ends the session)';
  b.setAttribute('aria-label', 'Lock Sourcepeek');
  b.onclick = async () => {
    await api('/auth/logout', {});
    location.reload();
  };
  mine.ui.toggle.parentElement.insertBefore(b, mine.ui.toggle);
}

function teardown() {
  const s = state;
  if (!s) return;
  s.alive = false;
  if (s.watchTimer) clearInterval(s.watchTimer);
  if (s.ui) {
    setInspect(false);
    window.removeEventListener('click', onClick, CAPTURE);
    window.removeEventListener('mousemove', onMove, CAPTURE);
    window.removeEventListener('keydown', onKey, CAPTURE);
    window.removeEventListener('keyup', onKeyUp, CAPTURE);
    SWALLOWED.forEach((t) => window.removeEventListener(t, swallow, CAPTURE));
    s.ui.host.remove();
    removeInjected();
  }
  uninstallCapture();
  uninstallReportCapture();
  uninstallStorageCapture();
  uninstallVitals();
  stopSharing();
  state = null;
}

export function unmount() {
  if (!state) return;
  refCount = Math.max(0, refCount - 1);
  if (refCount > 0) return;
  clearTimeout(teardownTimer);
  teardownTimer = setTimeout(() => {
    teardownTimer = null;
    if (refCount !== 0 || !state) return;
    // If an AI edit just crashed the app, React unmounted everything — including us. Stay alive so the
    // "Revert change" offer is still there; the app remounts us once the file is fixed.
    if (state.watchTimer || state.watchError) {
      state.orphaned = true;
      return;
    }
    teardown();
  }, 250);
}

/** Called when an edit watch ends or its error is resolved. */
export function releaseIfOrphaned() {
  if (!state || !state.orphaned) return;
  setTimeout(() => {
    if (state && state.orphaned && refCount === 0 && !state.watchTimer && !state.watchError) teardown();
  }, 4000);
}
