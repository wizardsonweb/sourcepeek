// "Change with AI": one prompt box, one button. The backend first works out WHAT kind of change was asked
// for (visual, code, new component, both) and HOW the element is styled (styled-components, Sass, CSS Modules,
// Tailwind, …), then previews it:
//  • visual change          – AI writes CSS, injected live, source untouched.
//  • code / new component   – CSS can't show it, so you get the diff instead — nothing written.
// Every preview sits in the Changes list with Diff · Apply to code · Undo. Apply to code edits the real file(s)
// where that element is styled / written (or creates the files of a new component), the dev server hot-reloads
// it, with one-click Undo and an offer to revert if the dev server shows an error.

import { el, api, toast, getState, closePanelPublic, commitStyles, openSource, releaseIfOrphaned } from './core.js';
import { buildOutline, uniqueSelector, prepareCss, countMatches, exportCss } from './styleLab.js';

const EDITS_KEY = 'sourcepeek:code-edits';
const WATCH_KEY = 'sourcepeek:edit-watch';
const WATCH_MS = 10000;

const ss = {
  get(k, d) {
    try {
      const v = sessionStorage.getItem(k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      if (v === null || v === undefined) sessionStorage.removeItem(k);
      else sessionStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};
const ls = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : v;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

const fileBase = (f) => String(f).split('/').pop();

/** Code changes of this tab — only those made while the current dev server run was up. */
export function loadEdits(runId) {
  const v = ss.get(EDITS_KEY, []);
  const all = Array.isArray(v) ? v.filter((e) => e && e.id && Array.isArray(e.files)) : [];
  const mine = runId ? all.filter((e) => e.run === runId) : all;
  if (mine.length !== all.length) ss.set(EDITS_KEY, mine.length ? mine : null);
  return mine;
}

function saveEdits() {
  const st = getState();
  st.edits = st.edits.slice(0, 20);
  ss.set(EDITS_KEY, st.edits);
}

function editsChanged() {
  const st = getState();
  if (!st) return;
  saveEdits();
  renderEditBar();
  if (st.onEditsChanged) st.onEditsChanged();
}

// ---------- diff rendering ----------

function renderDiff(text) {
  const pre = el('pre', 'mf-diff');
  for (const line of String(text).split('\n')) {
    const cls = line.startsWith('@@') ? 'hunk' : line.startsWith('+++') || line.startsWith('---') ? 'meta' : line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx';
    pre.appendChild(el('span', 'mf-diff-' + cls, line + '\n'));
  }
  return pre;
}

function firstChangedLine(diff) {
  const m = String(diff || '').match(/^@@ -\d+(?:,\d+)? \+(\d+)/m);
  return m ? Number(m[1]) + 3 : 1;
}

const KIND_TEXT = { style: 'Style', theme: 'Theme', code: 'Code', component: 'New component', page: 'New page', mixed: 'Style + code' };

// ---------- placement: the boxes around the click, with the source that writes each ----------
//
// "Add a card here" needs to know more than the clicked node: is it a layout wrapper around the page, a leaf, one
// item of a list? Which file writes the box next to the click? This collects that from the live DOM.

const PL_TEXTY = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'button', 'label', 'span', 'strong', 'em', 'small', 'img', 'input', 'textarea', 'select', 'svg', 'i', 'b', 'code']);
const PL_SEMANTIC = new Set(['main', 'section', 'article', 'header', 'footer', 'nav', 'aside', 'form', 'ul', 'ol', 'li', 'table', 'figure']);

function plSrc(n) {
  const d = n.dataset || {};
  if (d.mfFile) return { src: `${d.mfFile}:${d.mfLine || 1}`, comp: d.mfComp || null };
  if (d.mfCall) return { src: d.mfCall, comp: null };
  const meta = n.__svelte_meta;
  if (meta && meta.loc && meta.loc.file) return { src: `${meta.loc.file}:${meta.loc.line || 1}`, comp: null };
  const inst = n.__vueParentComponent;
  if (inst && inst.type && inst.type.__file) return { src: inst.type.__file, comp: inst.type.__name || null };
  return null;
}

function plClasses(n) {
  const raw = typeof n.className === 'string' ? n.className : n.getAttribute('class') || '';
  return raw
    .split(/\s+/)
    .filter((c) => c && c.length <= 40 && !/^(sc-|css-[a-z0-9]{4,}|svelte-|ng-|jsx-\d)/.test(c) && !/^[A-Za-z]{5,8}$/.test(c.replace(/[a-z]/g, '').length > 1 ? c : '-'))
    .slice(0, 6)
    .join(' ');
}

function plOwnText(n) {
  if (n.children.length && !PL_TEXTY.has(n.tagName.toLowerCase())) return '';
  const t = (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim();
  return t.length > 60 ? t.slice(0, 59) + '…' : t;
}

function plDescribe(n, extra) {
  const r = n.getBoundingClientRect();
  const cs = getComputedStyle(n);
  const tag = n.tagName.toLowerCase();
  const src = plSrc(n);
  const out = {
    tag,
    cls: plClasses(n),
    src: src ? src.src : null,
    comp: src ? src.comp : null,
    w: Math.round(r.width),
    h: Math.round(r.height),
    display: cs.display === 'flex' || cs.display === 'inline-flex' ? `${cs.display} ${cs.flexDirection}` : cs.display === 'grid' ? `grid ${cs.gridTemplateColumns.split(' ').length} cols` : cs.display,
    kids: n.children.length,
    text: plOwnText(n),
  };
  if (!n.children.length || PL_TEXTY.has(tag)) out.leaf = true;
  if (cs.display === 'inline') out.inline = true;
  const p = n.parentElement;
  if (p) {
    const key = tag + '|' + plClasses(n);
    const same = Array.from(p.children).filter((c) => c.tagName === n.tagName && c.tagName.toLowerCase() + '|' + plClasses(c) === key).length;
    if (same >= 3) out.repeated = same;
  }
  return Object.assign(out, extra || {});
}

const plVisible = (n) => n.getClientRects().length > 0 && !/^(script|style|template|noscript|link|meta|sourcepeek-root)$/i.test(n.tagName);

/** Where the click was relative to the clicked element's children (page coordinates). */
function plPoint(target, point) {
  if (!point) return null;
  const sx = window.scrollX || 0;
  const sy = window.scrollY || 0;
  const kids = Array.from(target.children).filter(plVisible).slice(0, 40);
  const cs = getComputedStyle(target);
  const horizontal = /flex/.test(cs.display) && /row/.test(cs.flexDirection);
  const pos = horizontal ? point.x : point.y;
  const box = (k) => {
    const r = k.getBoundingClientRect();
    return horizontal ? [r.left + sx, r.right + sx] : [r.top + sy, r.bottom + sy];
  };
  if (!kids.length) {
    const [a, b] = box(target);
    return `on the clicked element itself, in its ${pos < (a + b) / 2 ? (horizontal ? 'left' : 'upper') : horizontal ? 'right' : 'lower'} half`;
  }
  for (let i = 0; i < kids.length; i++) {
    const [a, b] = box(kids[i]);
    if (pos >= a && pos <= b) return `on child ${i + 1} (<${kids[i].tagName.toLowerCase()}>), in its ${pos < (a + b) / 2 ? (horizontal ? 'left' : 'upper') : horizontal ? 'right' : 'lower'} half`;
    if (pos < a) return i === 0 ? `${horizontal ? 'left of' : 'above'} child 1` : `between child ${i} and child ${i + 1}`;
  }
  return `${horizontal ? 'right of' : 'below'} the last child (${kids.length})`;
}

/** The structure around `target` for the AI's placement decision. */
export function buildPlacement(target, point) {
  if (!target || !target.isConnected) return null;
  try {
    const ancestors = [];
    for (let a = target.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const tag = a.tagName.toLowerCase();
      if (plSrc(a) || PL_SEMANTIC.has(tag) || a.id || a.children.length >= 2) ancestors.push(plDescribe(a));
      if (ancestors.length >= 10) break;
    }
    ancestors.reverse();
    const children = Array.from(target.children).filter(plVisible).slice(0, 16).map((c) => plDescribe(c));
    const parent = target.parentElement;
    const siblings = parent ? Array.from(parent.children).filter(plVisible).slice(0, 16).map((c) => plDescribe(c, c === target ? { self: true } : null)) : [];
    return {
      path: location.pathname,
      clicked: plDescribe(target),
      ancestors,
      children,
      siblings: siblings.length > 1 ? siblings : [],
      point: plPoint(target, point),
    };
  } catch {
    return null;
  }
}

/** A previewed stylesheet that targets the page as a whole (theme) rather than one component. */
const GLOBAL_SELECTOR = /(^|[\s,}])(:root|html|body|\*)(?=[\s,{.:[>~+#]|$)/m;

function fileChips(entry) {
  const wrap = el('div', 'mf-chips');
  for (const f of entry.files) {
    const b = el('button', 'mf-chip');
    b.type = 'button';
    b.title = f.created ? `New file — open ${f.rel} in your editor` : `Open ${f.rel} in your editor`;
    if (f.created) b.appendChild(el('span', 'mf-chip-new', 'new '));
    b.append(document.createTextNode(fileBase(f.rel) + ' '), el('span', 'mf-chip-add', `+${f.added}`));
    if (!f.created) b.appendChild(el('span', 'mf-chip-del', ` −${f.removed}`));
    b.onclick = () => openSource(f.rel, f.created ? 1 : firstChangedLine(f.diff));
    wrap.appendChild(b);
  }
  return wrap;
}

/** "Detected: Style change — visual only (“red”) · styled-components · Card.styles.ts" */
function detectedLine(intent, styling) {
  const row = el('div', 'mf-detected');
  if (intent) {
    row.appendChild(el('span', 'mf-kind-badge mf-kind-badge--' + intent.kind, intent.label || KIND_TEXT[intent.kind] || intent.kind));
    const why = intent.reason ? `${intent.source === 'ai' ? 'AI: ' : ''}${intent.reason}` : '';
    if (why) row.appendChild(el('span', 'mf-muted', why));
  }
  if (!intent && styling && styling.label) {
    const s = el('span', 'mf-styling-chip', styling.label);
    s.title = styling.element ? styling.element.note : 'How this component is styled';
    if (styling.element && styling.element.file) {
      s.classList.add('mf-styling-chip--link');
      s.onclick = () => openSource(styling.element.file, styling.element.line || 1);
    }
    row.appendChild(s);
  }
  return row;
}

// ---------- undo ----------

async function undoEdit(entry, force) {
  const res = await api('/edit/undo', { id: entry.id, force: Boolean(force) });
  if (res.ok) {
    entry.undone = true;
    const st = getState();
    if (st && st.watchError && st.watchError.id === entry.id) st.watchError = null;
    stopWatch();
    editsChanged();
    toast('Change undone — file restored', 'ok');
    releaseIfOrphaned();
  }
  return res;
}

function undoControls(entry, onDone) {
  const wrap = el('span', 'mf-undo');
  const btn = el('button', 'mf-style-mini', 'Undo');
  btn.title = 'Restore the file(s) exactly as they were before this change';
  const msg = el('div', 'mf-style-warn');
  msg.hidden = true;
  btn.onclick = async () => {
    btn.disabled = true;
    const res = await undoEdit(entry, btn.dataset.force === '1');
    btn.disabled = false;
    if (res.ok) return onDone && onDone();
    msg.hidden = false;
    msg.textContent = res.error;
    if (/changed after this edit/.test(res.error || '')) {
      btn.textContent = 'Undo anyway';
      btn.dataset.force = '1';
    }
  };
  wrap.append(btn);
  return { wrap, msg };
}

// ---------- floating bar (last code change / error after change) ----------

export function renderEditBar() {
  const st = getState();
  if (!st || !st.ui) return;
  const bar = st.ui.editBar;
  const last = st.edits.find((e) => !e.undone);
  bar.textContent = '';
  if (!last || st.editBarDismissed === last.id) return (bar.hidden = true);
  const err = st.watchError && st.watchError.id === last.id ? st.watchError : null;
  bar.hidden = false;
  bar.className = 'mf-editbar' + (err ? ' mf-editbar--error' : '');
  const label = el('span', 'mf-editbar-text', err ? `Error after AI change: ${err.message}` : `Code changed: ${last.files.map((f) => fileBase(f.rel)).join(', ')}`);
  label.title = err ? err.message : last.summary || last.request;
  const undo = el('button', err ? 'mf-editbar-revert' : 'mf-stylebar-reset', err ? 'Revert change' : 'Undo');
  undo.onclick = async () => {
    undo.disabled = true;
    let res = await undoEdit(last, false);
    if (!res.ok && /changed after this edit/.test(res.error || '')) {
      undo.disabled = false;
      undo.textContent = 'Overwrite?';
      undo.onclick = async () => {
        res = await undoEdit(last, true);
        if (!res.ok) toast(res.error, 'error');
      };
      return toast(res.error, 'error');
    }
    undo.disabled = false;
    if (!res.ok) toast(res.error, 'error');
  };
  const dismiss = el('button', 'mf-editbar-x', '×');
  dismiss.title = 'Hide';
  dismiss.onclick = () => {
    st.editBarDismissed = last.id;
    if (err) st.watchError = null;
    renderEditBar();
    releaseIfOrphaned();
  };
  bar.append(label, undo, dismiss);
}

// ---------- watching the dev server after a write ----------

function overlayError() {
  const vite = document.querySelector('vite-error-overlay');
  if (vite) {
    const root = vite.shadowRoot || vite;
    const msg = root.querySelector('.message-body, .message');
    return ((msg && msg.textContent) || 'Vite reported an error').trim().split('\n')[0].slice(0, 200);
  }
  const portal = document.querySelector('nextjs-portal');
  if (portal && portal.shadowRoot) {
    const dlg = portal.shadowRoot.querySelector('[data-nextjs-dialog], [role="dialog"]');
    if (dlg && /build error|failed to compile|runtime error|syntax error|module not found|unhandled|error:/i.test(dlg.textContent || '')) {
      return (dlg.textContent || 'Next.js reported an error').replace(/\s+/g, ' ').trim().slice(0, 200);
    }
  }
  return null;
}

function stopWatch() {
  const st = getState();
  if (st && st.watchTimer) clearInterval(st.watchTimer);
  if (st && st.watchListener) {
    window.removeEventListener('error', st.watchListener);
    window.removeEventListener('unhandledrejection', st.watchListener);
  }
  if (st) {
    st.watchTimer = null;
    st.watchListener = null;
  }
  ss.set(WATCH_KEY, null);
}

function runWatch(w) {
  const st = getState();
  stopWatch();
  ss.set(WATCH_KEY, w);
  const errors = [];
  st.watchListener = (ev) => {
    const m = ev.reason ? String((ev.reason && ev.reason.message) || ev.reason) : ev.message;
    if (m && !/ResizeObserver loop/.test(m)) errors.push(m);
  };
  window.addEventListener('error', st.watchListener);
  window.addEventListener('unhandledrejection', st.watchListener);
  st.watchTimer = setInterval(() => {
    const msg = overlayError() || errors[0];
    if (msg) {
      st.watchError = { id: w.id, message: msg };
      st.editBarDismissed = null;
      stopWatch();
      renderEditBar();
      if (st.onEditsChanged) st.onEditsChanged();
      return;
    }
    if (Date.now() > w.until) {
      stopWatch();
      releaseIfOrphaned();
    }
  }, 400);
}

function startErrorWatch(id) {
  const st = getState();
  st.watchError = null;
  runWatch({ id, until: Date.now() + WATCH_MS });
}

/** After a full page reload caused by an edit, keep watching for the remaining time. */
export function resumeErrorWatch() {
  const w = ss.get(WATCH_KEY, null);
  if (w && w.id && w.until > Date.now()) runWatch(w);
  else ss.set(WATCH_KEY, null);
}


// ---------- pending code proposals (previewed, not written yet) ----------

const KIND_KEY = 'sourcepeek:ai-kind';
const PROPOSALS_KEY = 'sourcepeek:proposals';
const PROPOSAL_TTL = 12 * 60 * 60 * 1000; // the server keeps previews on disk for 24 h

/** Code previews of this tab that have not been applied or undone yet. */
export function loadProposals(runId) {
  const v = ss.get(PROPOSALS_KEY, []);
  const now = Date.now();
  const all = Array.isArray(v) ? v.filter((p) => p && p.id && p.entry && Array.isArray(p.entry.files)) : [];
  const mine = all.filter((p) => (!runId || p.run === runId) && now - (p.at || 0) < PROPOSAL_TTL);
  if (mine.length !== all.length) ss.set(PROPOSALS_KEY, mine.length ? mine : null);
  return mine;
}

function proposalsChanged() {
  const st = getState();
  if (!st) return;
  st.proposals = (st.proposals || []).slice(0, 10);
  ss.set(PROPOSALS_KEY, st.proposals.length ? st.proposals : null);
  if (st.onEditsChanged) st.onEditsChanged();
}

// ---------- the section ----------
//
// One prompt, one button. Sourcepeek detects the kind of change: visual ones are previewed live as CSS, code /
// new-component ones are previewed as a diff. Every result lands in the Changes list with the same controls:
//   Diff · Apply to code · Undo
// Apply to code writes it into the real source; Undo removes a preview or restores the files of an applied change.

export function buildAiSection(ctx, overlay, view) {
  const st = getState();
  if (!st.proposals) st.proposals = [];
  const s = el('div', 'mf-style-section');

  const styling = el('div', 'mf-detected mf-styling-row');
  styling.hidden = true;
  const help = el('div', 'mf-muted');
  help.textContent = `Describe any change in plain words — styling, the theme of the whole app, text, layout, a loading state, logic, a new component, or a whole new page / route. Sourcepeek reads your project (CSS, SCSS, Less, CSS Modules, Tailwind, styled-components…) and detects what kind of change it is: visual changes are previewed live, code changes are previewed as a diff. Nothing is written until you click “Apply to code”.`;
  const ta = el('textarea', 'mf-style-input');
  ta.rows = 4;
  ta.placeholder = 'e.g. make the main title bigger · change the entire theme to dark navy · add a component here with title, text and image · add a loading state while it submits · add a new page /hello';
  const actions = el('div', 'mf-style-actions');
  const GO = 'Preview';
  const go = el('button', 'mf-style-btn', GO);
  const kindSel = el('select', 'mf-kind');
  kindSel.title = 'What kind of change is this? Auto lets Sourcepeek work it out from your request.';
  for (const [v, t] of [
    ['auto', 'Auto-detect'],
    ['style', 'Style only'],
    ['theme', 'Theme / whole app'],
    ['code', 'Code'],
    ['mixed', 'Style + code'],
    ['component', 'New component'],
    ['page', 'New page / route'],
  ]) {
    const o = el('option', null, t);
    o.value = v;
    kindSel.appendChild(o);
  }
  kindSel.value = ls.get(KIND_KEY, 'auto');
  if (![...kindSel.options].some((o) => o.value === kindSel.value)) kindSel.value = 'auto';
  kindSel.onchange = () => ls.set(KIND_KEY, kindSel.value);
  ['keydown', 'keyup', 'keypress'].forEach((t) => kindSel.addEventListener(t, (e) => e.stopPropagation()));
  actions.append(go, kindSel, el('span', 'mf-muted', '⌘/Ctrl + Enter'));
  const detected = el('div', 'mf-detected-wrap');
  detected.hidden = true;
  const status = el('div', 'mf-style-status');
  status.hidden = true;
  const list = el('div', 'mf-style-list');
  s.append(styling, help, ta, actions, detected, status, list);
  if (!st.canEdit && st.editReason) help.after(el('div', 'mf-muted mf-edit-off', `Apply to code is off: ${st.editReason}`));

  const setStatus = (text, kind) => {
    status.hidden = !text;
    status.textContent = text || '';
    status.className = 'mf-style-status' + (kind ? ' mf-style-status--' + kind : '');
  };
  const showDetected = (intent, _styling, notice) => {
    detected.textContent = '';
    detected.hidden = !intent && !notice;
    if (intent) detected.appendChild(detectedLine(intent, null));
    if (notice) detected.appendChild(el('div', 'mf-muted mf-notice', notice));
  };

  // Running a change docks the panel so the page (and the live preview) stays visible.
  const dock = () => {
    if (overlay.classList.contains('mf-overlay--docked')) return;
    if (view && typeof view.dock === 'function') return view.dock();
    closePanelPublic();
    overlay.classList.add('mf-overlay--docked');
  };

  // ----- what the element is styled with (shown before anything is asked) -----
  const selectedEl = () => (ctx.el && ctx.el.isConnected ? ctx.el : null);
  // `target` (from "Fix with AI" in Accessibility) points the change at another element and its own file:line.
  const baseBody = (target) => {
    if (target && target.file) {
      const n = target.el && target.el.isConnected ? target.el : null;
      const cls = n ? (typeof n.className === 'string' ? n.className : n.getAttribute('class') || '') : '';
      const own = n ? Array.from(n.childNodes).filter((c) => c.nodeType === 3).map((c) => c.textContent).join(' ').replace(/\s+/g, ' ').trim() : '';
      return {
        componentName: target.comp || ctx.componentName,
        file: target.file,
        line: target.line,
        callSite: target.file === ctx.file ? ctx.callSite || null : null,
        props: target.file === ctx.file ? ctx.props || null : null,
        selected: {
          selector: n ? uniqueSelector(n) : null,
          tag: n ? n.tagName.toLowerCase() : ctx.tagName,
          classes: cls,
          text: own.slice(0, 300),
          html: n ? n.outerHTML.slice(0, 1500) : '',
        },
      };
    }
    const selected = selectedEl();
    return {
      componentName: ctx.componentName,
      file: ctx.file,
      line: ctx.line,
      callSite: ctx.callSite || null,
      props: ctx.props || null,
      selected: {
        selector: selected ? uniqueSelector(selected) : null,
        tag: ctx.tagName,
        classes: ctx.cssClasses || '',
        text: ctx.text || '',
        html: selected ? selected.outerHTML.slice(0, 1500) : '',
      },
    };
  };
  api('/styling', baseBody()).then((res) => {
    if (!res.ok || !res.data.styling || !alive()) return;
    const sty = res.data.styling;
    styling.textContent = '';
    styling.appendChild(el('span', 'mf-muted', 'Styled with'));
    const chip = detectedLine(null, sty).firstChild;
    if (chip) styling.appendChild(chip);
    if (sty.element && sty.element.note) styling.appendChild(el('span', 'mf-muted', sty.element.note));
    styling.hidden = false;
  });

  // ----- the Changes list: previews (CSS or diff) and applied changes, same controls on each -----
  const mini = (text, title, cls) => {
    const b = el('button', 'mf-style-mini' + (cls ? ' ' + cls : ''), text);
    b.type = 'button';
    if (title) b.title = title;
    return b;
  };
  const applyBtn = (title) => {
    const b = mini('Apply to code', st.canEdit ? title : st.editReason || 'Apply to code is not available', 'mf-style-mini--accent');
    b.disabled = !st.canEdit;
    return b;
  };
  /** Item shell: [kind] [state] ······ Diff · Apply to code · Undo */
  const itemShell = (kind, stateText, stateCls, request) => {
    const item = el('div', 'mf-style-item');
    const head = el('div', 'mf-style-item-head');
    if (kind) head.appendChild(el('span', 'mf-kind-badge mf-kind-badge--' + kind, KIND_TEXT[kind] || kind));
    if (stateText) head.appendChild(el('span', 'mf-badge' + (stateCls ? ' ' + stateCls : ''), stateText));
    head.appendChild(el('span', 'mf-spacer'));
    const btns = el('span', 'mf-item-actions');
    head.appendChild(btns);
    item.append(head, el('div', 'mf-style-item-req', request));
    return { item, btns };
  };

  const renderCssPreview = (c) => {
    const { item, btns } = itemShell(c.kind === 'theme' ? 'theme' : 'style', 'Preview', 'mf-badge--preview', c.request);
    const diff = mini('Diff', 'Show the CSS this preview injects');
    const apply = applyBtn('Make this preview permanent: the AI writes it into your source, in the styling system this component uses');
    const undo = mini('Undo', 'Remove this live preview');
    btns.append(diff, apply, undo);
    if (c.summary) item.appendChild(el('div', 'mf-muted', c.summary));
    if (c.matched === 0) item.appendChild(el('div', 'mf-style-warn', 'Warning: these selectors matched no elements on this page.'));
    const pre = el('pre', 'mf-refactor-output mf-style-css', c.css);
    pre.hidden = true;
    item.appendChild(pre);
    diff.onclick = () => (pre.hidden = !pre.hidden);
    undo.onclick = () => {
      st.styles = st.styles.filter((x) => x !== c);
      commitStyles();
    };
    apply.onclick = async () => {
      const theme = c.kind === 'theme' || GLOBAL_SELECTOR.test(c.css || '');
      const instruction = theme
        ? `Make this previewed SITE-WIDE visual change permanent in the source code: "${c.request}".
The developer approved the live preview below, so the whole app must look exactly like it: same colours, fonts, sizes, radii and spacing as the preview CSS, on every page.
Its selectors target the rendered DOM — implement it in the project's theme layer described under THEME (design tokens / CSS variables, Tailwind theme or @theme, theme object, global styles); do not paste DOM selectors or generated class names into the source. Change existing token values instead of adding conflicting ones.
PREVIEW CSS:
${c.css}`
        : `Make this previewed visual change permanent in the source code: "${c.request}".
The developer approved the live preview below, so the result in the browser must look exactly like it: use the same property values (colours, sizes, spacing, fonts…) as the preview CSS, on the same elements, and change nothing else.
Its selectors target the rendered DOM — translate the change into the styling approach described under STYLING (styled-components template, Sass/CSS module rule, Tailwind classes, <style> block…); do not paste DOM selectors or generated class names into the source. If the element already has a value for one of these properties, change that value instead of adding a second, conflicting one.
PREVIEW CSS:
${c.css}`;
      apply.disabled = true;
      const ok = await runChange('code', instruction, {
        label: `Apply preview: ${c.request}`,
        kind: theme ? 'theme' : 'style',
        extra: { previewCss: c.css, scope: theme ? 'global' : null },
      });
      if (ok) {
        st.styles = st.styles.filter((x) => x !== c);
        commitStyles();
      } else apply.disabled = !st.canEdit;
    };
    return item;
  };

  const renderProposal = (p) => {
    const entry = p.entry;
    const { item, btns } = itemShell(entry.kind || p.kind, 'Preview', 'mf-badge--preview', entry.request || p.request);
    const diff = mini('Diff', 'Show what would change in your code');
    const apply = applyBtn('Write this change into your source files. Undo is one click.');
    const undo = mini('Undo', 'Discard this preview. Nothing was written.');
    btns.append(diff, apply, undo);
    if (entry.summary) item.appendChild(el('div', 'mf-muted', entry.summary));
    item.appendChild(fileChips(entry));
    const msg = el('div', 'mf-style-warn');
    msg.hidden = true;
    item.appendChild(msg);
    const diffs = el('div', 'mf-diffs');
    diffs.hidden = !p.open;
    entry.files.forEach((f) => diffs.appendChild(renderDiff(f.diff)));
    diff.onclick = () => {
      diffs.hidden = !diffs.hidden;
      p.open = !diffs.hidden;
    };
    item.appendChild(diffs);
    const drop = () => {
      st.proposals = st.proposals.filter((x) => x !== p);
      proposalsChanged();
    };
    undo.onclick = () => {
      api('/edit/discard', { id: p.id });
      drop();
      setStatus('Preview discarded. Nothing was written.', null);
    };
    apply.onclick = async () => {
      apply.disabled = undo.disabled = true;
      const res = await api('/edit/commit', { id: p.id });
      if (!alive()) return;
      if (!res.ok) {
        undo.disabled = false;
        msg.hidden = false;
        msg.textContent = res.error;
        const d = res.data || {};
        if (d.already) {
          // The change is already in the file: nothing to do but clear the preview.
          api('/edit/discard', { id: p.id });
          drop();
          setStatus('That change is already in your code — nothing was written.', 'ok');
          return;
        }
        if (d.regenerate) {
          // The preview can't be written as it is (expired, or the file changed under it): offer a fresh one.
          apply.disabled = true;
          const again = mini('Generate again', 'Ask the AI for this change again, against your current code', 'mf-style-mini--accent');
          again.onclick = async () => {
            again.disabled = true;
            const ok = await runChange('preview', p.request || entry.request, { kind: entry.kind || p.kind || null, kindSource: entry.kind || p.kind ? 'user' : null });
            if (ok) {
              api('/edit/discard', { id: p.id });
              drop();
            } else again.disabled = false;
          };
          msg.appendChild(document.createTextNode(' '));
          msg.appendChild(again);
          return;
        }
        apply.disabled = !st.canEdit;
        return;
      }
      st.proposals = st.proposals.filter((x) => x !== p);
      ss.set(PROPOSALS_KEY, st.proposals.length ? st.proposals : null);
      written({ entry: res.data.entry, unchecked: p.unchecked, rebased: res.data.rebased });
    };
    return item;
  };

  const renderApplied = (entry) => {
    const { item, btns } = itemShell(entry.kind, entry.undone ? 'Undone' : 'Applied', entry.undone ? null : 'mf-badge--applied', entry.request);
    if (entry.undone) item.classList.add('mf-style-item--undone');
    const diff = mini('Diff', 'Show what changed in your code');
    btns.appendChild(diff);
    const { wrap, msg } = undoControls(entry);
    if (!entry.undone) btns.appendChild(wrap);
    if (entry.summary) item.appendChild(el('div', 'mf-muted', entry.summary));
    item.appendChild(fileChips(entry));
    if (st.watchError && st.watchError.id === entry.id && !entry.undone) {
      item.appendChild(el('div', 'mf-style-status mf-style-status--error', `Your dev server reported an error after this change: ${st.watchError.message}. Undo restores the previous version.`));
    }
    item.appendChild(msg);
    const diffs = el('div', 'mf-diffs');
    diffs.hidden = true;
    entry.files.forEach((f) => diffs.appendChild(renderDiff(f.diff)));
    diff.onclick = () => (diffs.hidden = !diffs.hidden);
    item.appendChild(diffs);
    return item;
  };

  const renderList = () => {
    list.textContent = '';
    const applied = st.edits.slice(0, 8);
    const n = st.proposals.length + st.styles.length + st.edits.length;
    if (!n) return;
    const title = el('div', 'mf-list-title');
    title.appendChild(el('div', 'mf-section-title', `Changes (${n})`));
    if (st.edits.length) {
      const clear = mini('Clear applied', 'Remove applied changes from this list. Your files are not changed.');
      clear.onclick = () => {
        st.edits = [];
        st.editBarDismissed = null;
        editsChanged();
      };
      title.appendChild(clear);
    }
    list.appendChild(title);
    st.proposals.forEach((p) => list.appendChild(renderProposal(p)));
    st.styles.slice().reverse().forEach((c) => list.appendChild(renderCssPreview(c)));
    applied.forEach((e) => list.appendChild(renderApplied(e)));
  };
  st.onStylesChanged = renderList;
  st.onEditsChanged = renderList;
  renderList();

  // ----- running -----
  let busy = false;
  const lock = (on, label) => {
    busy = on;
    go.disabled = on;
    kindSel.disabled = on;
    go.textContent = on ? label : GO;
  };
  const alive = () => st === getState() && st.alive && st.detail === overlay;

  const applyCss = (instruction, data) => {
    const prepared = prepareCss(data.css);
    if (prepared.ruleCount === 0) return setStatus('The AI returned CSS the browser could not parse. Try rephrasing.', 'error');
    const matched = prepared.ruleCount > 0 ? countMatches(prepared.selectors) : null;
    st.styles.push({ request: instruction, css: data.css, summary: data.summary || '', matched, kind: data.intent && data.intent.kind === 'theme' ? 'theme' : 'style' });
    commitStyles();
    ta.value = '';
    setStatus(
      matched === 0
        ? 'Previewing, but the selectors matched nothing — try naming the element differently.'
        : `Previewing ✓${matched ? ` (${matched} element${matched === 1 ? '' : 's'})` : ''}. Like it? “Apply to code” makes it permanent.`,
      matched === 0 ? 'warn' : 'ok'
    );
  };

  const addProposal = (instruction, data) => {
    const entry = data.entry;
    st.proposals = [
      { id: data.id, entry, unchecked: data.unchecked || [], kind: entry.kind || (data.intent && data.intent.kind) || null, request: instruction, run: st.runId || null, at: Date.now(), open: true },
      ...st.proposals.filter((p) => p.id !== data.id),
    ];
    proposalsChanged();
    setStatus('Preview ready — nothing written yet. Check the diff, then “Apply to code” or “Undo”.', null);
  };

  const written = (data) => {
    const entry = data.entry;
    entry.run = st.runId || null;
    st.edits = [entry, ...st.edits.filter((e) => e.id !== entry.id)];
    st.editBarDismissed = null;
    editsChanged();
    startErrorWatch(entry.id);
    const files = entry.files.map((f) => `${f.created ? 'new ' : ''}${fileBase(f.rel)} +${f.added}${f.created ? '' : ` −${f.removed}`}`).join(', ');
    if (data.fallback && entry.summary) toast(entry.summary, 'ok');
    const warn = data.unchecked && data.unchecked.length ? ` (could not syntax-check ${data.unchecked.join(', ')})` : '';
    const merged = data.rebased && data.rebased.length ? ` ${data.rebased.map(fileBase).join(', ')} had changed since the preview — the change was merged into the current version.` : '';
    setStatus(`Applied ✓ ${files}. Your dev server is reloading it.${merged}${warn}`, warn ? 'warn' : 'ok');
    toast(`Changed ${files}`, 'ok');
  };

  /**
   * 'preview' — the server classifies the change (unless `kind` is forced) and answers with
   *             action: 'css' (inject live) or 'proposal' (diff, nothing written).
   * 'code'    — used by "Apply to code" on a CSS preview: writes straight to the source.
   */
  const runChange = async (runMode, instruction, opts = {}) => {
    if (busy) return false;
    const forced = opts.kind || (kindSel.value !== 'auto' ? kindSel.value : null);
    lock(true, runMode === 'code' ? 'Applying…' : 'Working…');
    showDetected(null);
    setStatus(
      runMode === 'code'
        ? forced === 'theme'
          ? 'Writing the change into your theme files… (syntax is checked before anything is written)'
          : `Writing the change into ${fileBase(ctx.file)}… (syntax is checked before anything is written)`
        : 'Reading your project, working out the kind of change and preparing a preview…'
    );
    const targetEl = opts.target && opts.target.el && opts.target.el.isConnected ? opts.target.el : selectedEl();
    // Measured before docking: the panel moving aside can reflow the page.
    const placement = buildPlacement(targetEl, opts.target ? null : ctx.point || null);
    dock();
    const body = {
      ...baseBody(opts.target),
      instruction,
      mode: runMode,
      kind: forced,
      kindSource: opts.kindSource || (opts.kind ? 'preview' : null),
      label: opts.label || null,
      placement,
      ...(opts.extra || {}),
    };
    if (runMode === 'code') body.review = false;
    else {
      body.domOutline = buildOutline(targetEl);
      body.existingCss = exportCss(st.styles);
    }
    const res = await api('/ai/change', body);
    lock(false);
    if (!alive()) return false;
    if (!res.ok) {
      setStatus(res.error, 'error');
      return false;
    }
    const data = res.data;
    showDetected(data.intent, data.styling, data.notice);
    if (data.action === 'css') {
      applyCss(instruction, data);
      return true;
    }
    ta.value = '';
    if (data.pending) addProposal(instruction, data);
    else written(data);
    return true;
  };

  const run = () => {
    const instruction = ta.value.trim();
    if (busy || !instruction) return;
    runChange('preview', instruction);
  };
  go.onclick = run;
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      run();
    }
  });
  ['keyup', 'keypress'].forEach((t) => ta.addEventListener(t, (e) => e.stopPropagation()));
  // "Fix with AI" from Accessibility: fills the prompt and previews the fix for that element.
  s.mfFix = (instruction, target, kind) => {
    ta.value = instruction;
    if (busy) return setStatus('Busy with another change — the fix is in the box above; press Preview when it’s done.', 'warn');
    runChange('preview', instruction, { target, kind: kind || null, kindSource: kind ? 'a11y' : null, label: instruction.length > 160 ? instruction.slice(0, 157) + '…' : instruction }).then((ok) => {
      if (ok) ta.value = '';
    });
  };
  setTimeout(() => ta.focus(), 0);
  return s;
}
