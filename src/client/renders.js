// "Renders & state": a timeline of one component's renders and what changed in each.
//
// Only the component you opened is tracked, starting when you open the section, and only the last 100 entries
// are kept. "Render" means something different per framework, so each one is labelled for what it really is:
//   • React   — re-renders, from the React DevTools commit hook (exact). Without the hook: sampled.
//   • Vue     — component updates (Vue re-ran the component's render function).
//   • Angular — change detection checks. Angular checks a component on every cycle; that doesn't mean the DOM changed.
//   • Svelte  — changes that reached the component's DOM. Svelte 5 has no runtime component instance to read
//               state from, so this is a rough render count.
//
// Values are compared as frozen copies (valueView.freeze), so a change deep inside an object that is mutated in place
// (Angular reactive forms, Vue reactive objects) is still seen, and named by its path: `form.value.title "a" → "ab"`.

import { el, api, copy, getState } from './core.js';
import { findCurrentFiber, readReact, readVue } from './inspect.js';
import { ngRead } from './angular.js';
import { describe, freeze, fingerprintOf, changes as pathChanges, previewOf, frozenDescriptor, labelOf, valueTree, openValueModal, toJson } from './valueView.js';

const MAX_ENTRIES = 100;
const SAMPLE_MS = 250;
const KEY_BUDGET = 2000;
const SNAP_BUDGET = 8000;
const MAX_CHIPS = 3;

const KINDS = {
  react: { title: 'Re-renders', unit: 'render', verb: 'rendered' },
  vue: { title: 'Component updates', unit: 'update', verb: 'updated' },
  angular: { title: 'Change detection checks', unit: 'check', verb: 'checked' },
  svelte: { title: 'DOM updates', unit: 'DOM update', verb: 'DOM updated' },
  dom: { title: 'DOM updates', unit: 'DOM update', verb: 'DOM updated' },
};

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function hhmmss(t) {
  const d = new Date(t);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':');
}

// ---------- React commit hook (shared, installed once) ----------

const reactBus = { listeners: new Set(), seen: false };

function reactDispatcher() {
  const hook = typeof window !== 'undefined' ? window.__REACT_DEVTOOLS_GLOBAL_HOOK__ : null;
  if (!hook || typeof hook !== 'object') return false;
  const cur = hook.onCommitFiberRoot;
  if (cur && cur.__sourcepeek) return true;
  const wrapped = function onCommitFiberRoot() {
    reactBus.seen = true;
    if (reactBus.listeners.size) {
      for (const fn of reactBus.listeners) {
        try {
          fn();
        } catch {}
      }
    }
    return typeof cur === 'function' ? cur.apply(this, arguments) : undefined;
  };
  wrapped.__sourcepeek = true;
  try {
    hook.onCommitFiberRoot = wrapped;
  } catch {
    return false;
  }
  return true;
}

// ---------- snapshots and diffs ----------
// Each value is kept as a frozen copy (what changed, and at which path) plus the live value itself (so a prop that
// arrives as a new object or function with the same contents — the usual reason a memoised child re-renders — shows up).

const isObj = (v) => v !== null && (typeof v === 'object' || typeof v === 'function');

function toMap(rows, budget) {
  const m = new Map();
  for (const [k, v] of rows || []) {
    const frozen = freeze(v, Math.max(200, Math.min(KEY_BUDGET, budget.n)));
    const fp = fingerprintOf(frozen);
    budget.n -= fp.length / 40;
    m.set(k, { frozen, fp, ref: v });
  }
  return m;
}

function snap(props, state) {
  const budget = { n: SNAP_BUDGET };
  return { props: toMap(props, budget), state: toMap(state, budget) };
}

/** Comparable text of a snapshot (no object references), for the sampled trackers. */
function snapKey(s) {
  return JSON.stringify([[...s.props].map(([k, e]) => [k, e.fp]), [...s.state].map(([k, e]) => [k, e.fp])]);
}

const MISSING = { frozen: { k: 'undefined' }, fp: '{"k":"undefined"}', ref: undefined };

function diff(a, b) {
  const out = [];
  for (const src of ['props', 'state']) {
    const before = a ? a[src] : new Map();
    const after = b[src];
    const keys = new Set([...before.keys(), ...after.keys()]);
    const kind = src === 'props' ? 'prop' : 'state';
    for (const k of keys) {
      const x = before.has(k) ? before.get(k) : MISSING;
      const y = after.has(k) ? after.get(k) : MISSING;
      if (x.fp !== y.fp) {
        const pc = pathChanges(x.frozen, y.frozen, '', 40);
        out.push({ key: k, src: kind, from: x.frozen, to: y.frozen, paths: pc.list.length ? pc.list : [{ path: '', from: x.frozen, to: y.frozen }], more: pc.more });
      } else if (x.ref !== y.ref && isObj(x.ref) && isObj(y.ref)) {
        out.push({ key: k, src: kind, from: x.frozen, to: y.frozen, ref: true, fn: typeof y.ref === 'function' });
      }
    }
  }
  return out;
}

// ---------- per-framework trackers ----------
// Each returns { mode, note, stop } and calls emit(snapshot | { dom: changes }) per render.

function trackReact(fiber, emit, setMode) {
  let last = null;
  const take = (cur) => {
    last = { fiber: cur, props: cur.memoizedProps, state: cur.memoizedState };
    const { props, state } = readReact(cur, true);
    return snap(props, state);
  };
  const start = findCurrentFiber(fiber);
  if (!start) return null;
  const baseline = take(start);
  let gone = false;
  const check = () => {
    if (gone) return;
    let cur = null;
    try {
      cur = findCurrentFiber(fiber);
    } catch {}
    if (!cur) {
      gone = true;
      emit({ unmounted: true });
      return;
    }
    const flags = (cur.flags !== undefined ? cur.flags : cur.effectTag) || 0;
    // PerformedWork (1) is set on a fiber that actually ran this commit; a bailed-out clone has it cleared.
    const rendered = cur.memoizedProps !== last.props || cur.memoizedState !== last.state || (cur !== last.fiber && (flags & 1) === 1);
    if (rendered) emit(take(cur));
  };
  let timer = null;
  const hooked = reactDispatcher();
  const exact = () => {
    clearInterval(timer);
    timer = null;
    setMode('exact', 'Exact: every React commit is checked through the React DevTools hook.');
  };
  const onCommit = () => {
    if (timer) exact();
    check();
  };
  if (hooked) reactBus.listeners.add(onCommit);
  if (hooked && reactBus.seen) exact();
  else {
    timer = setInterval(check, SAMPLE_MS);
    setMode(
      'sampled',
      hooked
        ? 'Waiting for the first React commit… Until then the component is sampled every 250 ms.'
        : 'Sampled every 250 ms — renders between two samples show as one. For exact counts, import "sourcepeek/react-hook" before React (see the README).'
    );
  }
  return {
    baseline,
    live: () => {
      const cur = findCurrentFiber(fiber);
      return cur ? readReact(cur, true) : null;
    },
    stop() {
      clearInterval(timer);
      reactBus.listeners.delete(onCommit);
    },
  };
}

function trackVue(inst, emit, setMode) {
  const take = () => {
    const { props, state } = readVue(inst, true);
    return snap(props, state);
  };
  const baseline = take();
  const fn = () => {
    if (inst.isUnmounted) return emit({ unmounted: true });
    emit(take());
  };
  // `u` holds the instance's `updated` lifecycle hooks; Vue runs them after every update of this component.
  if (!Array.isArray(inst.u)) inst.u = inst.u ? [inst.u] : [];
  inst.u.push(fn);
  setMode('exact', 'Each entry is one update: Vue re-ran this component’s render because something it uses changed.');
  return {
    baseline,
    live: () => readVue(inst, true),
    stop() {
      if (Array.isArray(inst.u)) {
        const i = inst.u.indexOf(fn);
        if (i >= 0) inst.u.splice(i, 1);
      }
    },
  };
}

function trackAngular(inst, emit, setMode) {
  let onPush = false;
  const take = () => {
    const r = ngRead(inst, true);
    onPush = r.onPush;
    return snap(r.props, r.state);
  };
  const baseline = take();
  const bridge = typeof window !== 'undefined' ? window.__SOURCEPEEK_NG__ : null;
  const pushNote = onPush ? ' This component is OnPush, so Angular may have skipped some of these cycles — treat the count as an upper bound.' : '';
  const live = () => ngRead(inst, true);
  if (bridge && bridge.listeners) {
    const fn = () => emit(take());
    bridge.listeners.add(fn);
    setMode('exact', `One entry per change detection cycle. Angular checks the component's bindings each cycle; a check doesn't mean anything re-rendered.${pushNote}`);
    return { baseline, live, stop: () => bridge.listeners.delete(fn) };
  }
  let last = null;
  const timer = setInterval(() => {
    const s = take();
    const key = snapKey(s);
    if (key !== last) {
      last = key;
      emit(s);
    }
  }, SAMPLE_MS);
  last = snapKey(baseline);
  setMode('sampled', 'Change detection cycles can’t be counted here (add provideSourcepeek() to your providers). Showing value changes, sampled every 250 ms.');
  return { baseline, live, stop: () => clearInterval(timer) };
}

function nodeLabel(n) {
  if (!n) return '';
  if (n.nodeType === 3) return 'text';
  return n.nodeType === 1 ? `<${n.tagName.toLowerCase()}>` : n.nodeName;
}

function trackDom(root, emit, setMode, svelte) {
  if (!root || typeof MutationObserver === 'undefined') return null;
  const str = (s) => ({ k: 'string', p: s });
  const mo = new MutationObserver((records) => {
    const out = [];
    let added = 0;
    let removed = 0;
    for (const r of records) {
      if (r.type === 'characterData') {
        const to = r.target.textContent;
        if (r.oldValue !== to) out.push({ key: `text in ${nodeLabel(r.target.parentElement)}`, src: 'dom', paths: [{ path: '', from: str(r.oldValue), to: str(to) }] });
      } else if (r.type === 'attributes') {
        if (/^data-mf-|^__/.test(r.attributeName)) continue;
        const to = r.target.getAttribute(r.attributeName);
        if (r.oldValue !== to) {
          out.push({
            key: `${nodeLabel(r.target)} ${r.attributeName}`,
            src: 'dom',
            paths: [{ path: '', from: r.oldValue == null ? { k: 'undefined' } : str(r.oldValue), to: to == null ? { k: 'undefined' } : str(to) }],
          });
        }
      } else {
        added += r.addedNodes.length;
        removed += r.removedNodes.length;
      }
    }
    if (added || removed) out.push({ key: 'nodes', src: 'dom', nodes: `+${added} / −${removed}` });
    if (!root.isConnected) return emit({ unmounted: true });
    if (out.length) emit({ dom: out.slice(0, 12) });
  });
  mo.observe(root, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true, characterDataOldValue: true });
  setMode(
    'rough',
    svelte
      ? 'Svelte 5 has no runtime component instance, so its state can’t be read from outside. Each entry is a change that reached this component’s DOM — a rough render count, and only renders that changed something.'
      : 'No framework instance found for this element. Each entry is a change in its DOM.'
  );
  return { baseline: null, stop: () => mo.disconnect() };
}

/** The outermost element written in the same Svelte file as `node`. */
function svelteRoot(node, file) {
  let top = node;
  for (let a = node; a && a.nodeType === 1; a = a.parentElement) {
    const m = a.__svelte_meta;
    if (m && m.loc && m.loc.file === file) top = a;
  }
  return top;
}

export function trackKind(track) {
  if (!track) return 'dom';
  if (track.fiber) return 'react';
  if (track.vueInst) return 'vue';
  if (track.ngInst) return 'angular';
  if (track.el && track.el.__svelte_meta) return 'svelte';
  return 'dom';
}

// ---------- text ----------

function fullPath(label, path) {
  if (!path) return label;
  return path.startsWith('[') ? label + path : `${label}.${path}`;
}

/** Short value text for a chip. */
const chipValue = (node) => previewOf(frozenDescriptor(node), 1, 60);

function pathText(label, p) {
  const where = fullPath(label, p.path);
  if (p.added) return `${where} added ${chipValue(p.to)}`;
  if (p.removed) return `${where} removed`;
  return `${where} ${chipValue(p.from)} → ${chipValue(p.to)}`;
}

// ---------- UI ----------

function smallBtn(text, title, onClick) {
  const b = el('button', 'mf-net-btn mf-rs-mini', text);
  b.type = 'button';
  if (title) b.title = title;
  b.onclick = (e) => {
    e.stopPropagation();
    e.preventDefault();
    onClick(b);
  };
  return b;
}

/**
 * Fill the "Renders & state" accordion body. ctx: { componentName, file, track: { fiber|vueInst|ngInst, el, file, name } }.
 * Returns a cleanup function that stops tracking.
 */
export function buildRenders(box, ctx) {
  const track = ctx.track || {};
  const kind = trackKind(track);
  const K = KINDS[kind];
  let timer = null;
  let seq = 0;
  const state = { n: 0, nothing: 0, entries: [], paused: false, names: null, since: Date.now(), current: null, mode: '', note: '', ended: false };

  const head = el('div', 'mf-rs-head');
  const stats = el('div', 'mf-rs-stats');
  const pauseBtn = el('button', 'mf-net-btn', 'Pause');
  pauseBtn.type = 'button';
  const clearBtn = el('button', 'mf-net-btn', 'Clear');
  clearBtn.type = 'button';
  const copyBtn = el('button', 'mf-net-btn', 'Copy');
  copyBtn.type = 'button';
  copyBtn.title = 'Copy the timeline as text';
  head.append(stats, pauseBtn, clearBtn, copyBtn);
  const modeLine = el('div', 'mf-rs-mode');
  const current = el('details', 'mf-kv mf-rs-current');
  current.open = true;
  const currentTitle = el('summary', 'mf-section-title', 'Current values');
  const currentList = el('div', 'mf-rs-cv-list');
  current.append(currentTitle, currentList);
  const timelineTitle = el('div', 'mf-section-title mf-rs-tl-title', 'Timeline · newest first · click a row for the full values');
  const list = el('ol', 'mf-rs-list');
  box.append(head, modeLine, current, timelineTitle, list);

  const setMode = (mode, note) => {
    state.mode = mode;
    state.note = note;
    schedule();
  };

  // React hooks have no names at runtime — ask the backend for `const [name, setName] = useState()` order.
  if (kind === 'react' && (track.file || ctx.file) && track.name) {
    api('/state-names', { file: track.file || ctx.file, componentName: track.name }).then((res) => {
      if (res.ok && res.data && res.data.names && res.data.names.length) {
        state.names = res.data.names;
        for (const e of state.entries) e.dirty = true;
        cvRows.clear();
        schedule();
      }
    });
  }
  const label = (key) => {
    const m = state.names && /^state\[(\d+)\]$/.exec(key);
    return m && state.names[Number(m[1])] ? state.names[Number(m[1])] : key;
  };

  const push = (entry) => {
    entry.id = ++seq;
    entry.dirty = true;
    state.entries.push(entry);
    if (state.entries.length > MAX_ENTRIES) state.entries.splice(0, state.entries.length - MAX_ENTRIES);
  };

  const emit = (s) => {
    if (state.ended) return;
    if (s.unmounted) {
      state.ended = true;
      push({ n: null, t: Date.now(), unmounted: true });
      stop();
      return schedule();
    }
    if (state.paused) {
      if (s.props) state.current = s;
      return;
    }
    state.n++;
    const t = Date.now();
    let ch;
    if (s.dom) ch = s.dom;
    else {
      ch = diff(state.current, s);
      state.current = s;
    }
    if (!ch.length) {
      state.nothing++;
      const last = state.entries[state.entries.length - 1];
      if (last && last.nothing && !last.unmounted) {
        last.count++;
        last.nTo = state.n;
        last.t = t;
        last.dirty = true;
      } else push({ n: state.n, nTo: state.n, t, nothing: true, count: 1 });
    } else {
      // Only new references (same values): the render could have been skipped, so it counts as "nothing changed".
      const refOnly = ch.every((c) => c.ref);
      if (refOnly) state.nothing++;
      push({ n: state.n, t, changes: ch, refOnly });
    }
    schedule();
  };

  let tracker = null;
  try {
    if (kind === 'react') tracker = trackReact(track.fiber, emit, setMode);
    else if (kind === 'vue') tracker = trackVue(track.vueInst, emit, setMode);
    else if (kind === 'angular') tracker = trackAngular(track.ngInst, emit, setMode);
    else tracker = trackDom(kind === 'svelte' ? svelteRoot(track.el, track.file || ctx.file) : track.el, emit, setMode, kind === 'svelte');
  } catch {
    tracker = null;
  }
  if (tracker && tracker.baseline) state.current = tracker.baseline;
  if (!tracker) setMode('off', `Couldn’t attach to ${ctx.componentName} — it may have unmounted. Inspect the element again.`);

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      render();
    }, 80);
  }

  function changeText(c) {
    if (c.nodes) return `nodes ${c.nodes}`;
    const tag = c.src === 'dom' ? '' : ` (${c.src})`;
    const name = label(c.key);
    if (c.ref) return `${name} new reference, same value${tag}`;
    const parts = c.paths.map((p) => pathText(name, p));
    if (c.more) parts.push(`…${c.more} more changes in ${name}`);
    return parts.join(' · ') + tag;
  }

  function lineText(e) {
    if (e.unmounted) return `${hhmmss(e.t)} · unmounted — tracking stopped`;
    if (e.nothing) {
      const range = e.count > 1 ? `#${e.n}–#${e.nTo}` : `#${e.n}`;
      return `${range} · ${hhmmss(e.t)} · ${e.count > 1 ? `${e.count}× ` : ''}${K.verb}, nothing changed`;
    }
    return [`#${e.n}`, hhmmss(e.t), ...e.changes.map(changeText)].join(' · ');
  }

  // ----- current values: one row per prop / state value, rebuilt only when that value changed -----

  const cvRows = new Map(); // key → { fp, row }
  const openPaths = new Map(); // key → Set of expanded paths (kept when the value changes)

  function liveRows() {
    let live = null;
    try {
      live = tracker && tracker.live ? tracker.live() : null;
    } catch {}
    const s = state.current;
    if (!s) return [];
    const liveMap = new Map();
    if (live) {
      for (const [k, v] of live.props || []) liveMap.set('prop:' + k, v);
      for (const [k, v] of live.state || []) liveMap.set('state:' + k, v);
    }
    const rows = [];
    for (const [k, e] of s.props) rows.push({ id: 'prop:' + k, src: 'prop', key: k, entry: e, live: liveMap.has('prop:' + k) ? liveMap.get('prop:' + k) : e.ref });
    for (const [k, e] of s.state) rows.push({ id: 'state:' + k, src: 'state', key: k, entry: e, live: liveMap.has('state:' + k) ? liveMap.get('state:' + k) : e.ref });
    return rows;
  }

  function currentRow(r) {
    const name = label(r.key);
    const row = el('div', 'mf-rs-cv');
    const top = el('div', 'mf-rs-cv-head');
    const d = describe(r.live);
    const kindText = d.kids ? labelOf(d) + (d.k === 'form' && d.status ? ` · ${d.status}` : '') : '';
    top.append(el('span', 'mf-rs-cv-key', name), el('span', 'mf-rs-src', r.src));
    if (kindText) top.appendChild(el('span', 'mf-rs-cv-kind', kindText));
    top.appendChild(el('span', 'mf-spacer'));
    top.appendChild(smallBtn('Copy', `Copy ${name} as JSON`, (b) => copy(toJson(r.live), b)));
    if (d.kids) {
      top.appendChild(
        smallBtn('Full view', `Show all of ${name}`, () => {
          const st = getState();
          if (st && st.ui) openValueModal(st.ui.shadow, `${ctx.componentName} · ${name} (${r.src})`, r.live, { onCopy: (text, b) => copy(text, b) });
        })
      );
    }
    if (!openPaths.has(r.id)) openPaths.set(r.id, new Set());
    const tree = valueTree(r.live, { open: openPaths.get(r.id) });
    tree.classList.add('mf-rs-cv-val');
    row.append(top, tree);
    return row;
  }

  function renderCurrent() {
    const rows = liveRows();
    currentTitle.textContent = `Current values (${rows.length})`;
    if (!rows.length) {
      cvRows.clear();
      currentList.textContent = '';
      currentList.appendChild(el('div', 'mf-muted', kind === 'svelte' || kind === 'dom' ? 'Not readable for this component.' : 'No props or state.'));
      return;
    }
    const seen = new Set();
    const nodes = [];
    for (const r of rows.slice(0, 80)) {
      seen.add(r.id);
      const have = cvRows.get(r.id);
      if (have && have.fp === r.entry.fp) {
        nodes.push(have.row);
        continue;
      }
      const row = currentRow(r);
      if (have) row.classList.add('mf-rs-cv--changed');
      cvRows.set(r.id, { fp: r.entry.fp, row });
      nodes.push(row);
    }
    for (const id of [...cvRows.keys()]) if (!seen.has(id)) cvRows.delete(id);
    if (rows.length > 80) nodes.push(el('div', 'mf-muted', `…${rows.length - 80} more`));
    currentList.replaceChildren(...nodes);
  }

  // ----- timeline rows (kept and only rebuilt when their entry changed, so opened rows stay open) -----

  const liOf = new WeakMap();

  function chip(c) {
    const name = label(c.key);
    const chipEl = el('span', 'mf-rs-change mf-rs-change--' + c.src + (c.ref ? ' mf-rs-change--ref' : ''));
    const srcTag = c.src === 'dom' ? null : el('span', 'mf-rs-src', c.src);
    if (c.nodes) {
      chipEl.textContent = `nodes ${c.nodes}`;
      return [chipEl];
    }
    if (c.ref) {
      chipEl.append(el('b', null, name), document.createTextNode(' new reference, same value'));
      if (srcTag) chipEl.appendChild(srcTag);
      chipEl.title = `${name} is a new ${c.fn ? 'function' : 'object'} with the same contents.\nThis alone re-renders memo() children — wrap it in useCallback / useMemo, or compare by value.`;
      return [chipEl];
    }
    const out = [];
    const shown = c.paths.slice(0, MAX_CHIPS);
    for (const p of shown) {
      const one = el('span', chipEl.className);
      one.appendChild(el('b', null, fullPath(name, p.path)));
      if (p.added) one.append(document.createTextNode(' added '), el('span', 'mf-rs-to', chipValue(p.to)));
      else if (p.removed) one.append(document.createTextNode(' removed'));
      else one.append(document.createTextNode(' '), el('span', 'mf-rs-from', chipValue(p.from)), el('span', 'mf-rs-arrow', ' → '), el('span', 'mf-rs-to', chipValue(p.to)));
      if (srcTag) one.appendChild(srcTag.cloneNode(true));
      out.push(one);
    }
    const rest = c.paths.length - shown.length + (c.more || 0);
    if (rest > 0) out.push(el('span', 'mf-rs-change mf-rs-change--more', `+${rest} more in ${name}`));
    return out;
  }

  function fullValue(node) {
    const d = frozenDescriptor(node);
    if (d.kids) return valueTree(node, { frozen: true });
    const box2 = el('div', 'mf-rs-full');
    if (d.k === 'string') {
      box2.classList.add('mf-rs-full--str');
      box2.textContent = d.p + (d.len ? ` … (${d.len.toLocaleString()} chars)` : '');
    } else box2.textContent = previewOf(d, 0);
    return box2;
  }

  function entryDetails(e) {
    const body = el('div', 'mf-rs-detail');
    for (const c of e.changes) {
      const name = label(c.key);
      const block = el('div', 'mf-rs-dblock');
      const title = el('div', 'mf-rs-dtitle');
      title.append(el('b', null, name), el('span', 'mf-rs-src', c.src === 'dom' ? 'dom' : c.src));
      block.appendChild(title);
      if (c.nodes) {
        block.appendChild(el('div', 'mf-muted', `Child nodes ${c.nodes}`));
        body.appendChild(block);
        continue;
      }
      if (c.ref) {
        block.appendChild(el('div', 'mf-muted', `A new ${c.fn ? 'function' : 'object'} with the same contents as before. memo() children re-render because of it — wrap it in useCallback / useMemo where it is created, or compare by value.`));
        block.appendChild(fullValue(c.to));
        body.appendChild(block);
        continue;
      }
      for (const p of c.paths) {
        const pc = el('div', 'mf-rs-dpath');
        if (p.path || c.paths.length > 1) pc.appendChild(el('code', 'mf-rs-dpath-name', fullPath(name, p.path)));
        const grid = el('div', 'mf-rs-ba');
        const before = el('div', 'mf-rs-ba-col');
        before.append(el('span', 'mf-rs-ba-lbl', 'before'), p.from && !p.added ? fullValue(p.from) : el('span', 'mf-muted', '— (not there)'));
        const after = el('div', 'mf-rs-ba-col');
        after.append(el('span', 'mf-rs-ba-lbl', 'after'), p.to && !p.removed ? fullValue(p.to) : el('span', 'mf-muted', '— (removed)'));
        grid.append(before, after);
        pc.appendChild(grid);
        block.appendChild(pc);
      }
      if (c.more) block.appendChild(el('div', 'mf-muted', `…and ${c.more} more changed paths — see the whole value below.`));
      if (c.from && c.to && c.paths.some((p) => p.path)) {
        const whole = el('details', 'mf-rs-whole');
        whole.appendChild(el('summary', 'mf-muted', `Whole ${name} before / after`));
        const g = el('div', 'mf-rs-ba');
        const b1 = el('div', 'mf-rs-ba-col');
        b1.append(el('span', 'mf-rs-ba-lbl', 'before'), fullValue(c.from));
        const b2 = el('div', 'mf-rs-ba-col');
        b2.append(el('span', 'mf-rs-ba-lbl', 'after'), fullValue(c.to));
        g.append(b1, b2);
        whole.appendChild(g);
        block.appendChild(whole);
      }
      body.appendChild(block);
    }
    return body;
  }

  function rowFor(e) {
    if (e.unmounted) {
      const li = el('li', 'mf-rs-row mf-rs-row--end');
      li.append(el('span', 'mf-rs-time', hhmmss(e.t)), el('span', null, 'Unmounted — tracking stopped. Inspect the element again to follow the new instance.'));
      return li;
    }
    if (e.nothing) {
      const li = el('li', 'mf-rs-row mf-rs-row--nothing');
      li.append(el('span', 'mf-rs-n', e.count > 1 ? `#${e.n}–${e.nTo}` : `#${e.n}`), el('span', 'mf-rs-time', hhmmss(e.t)), el('span', 'mf-rs-nothing', `${e.count > 1 ? `${e.count}× ` : ''}${K.verb}, nothing changed`));
      return li;
    }
    const li = el('li', 'mf-rs-item' + (e.refOnly ? ' mf-rs-row--nothing' : ''));
    const det = el('details', 'mf-rs-entry');
    const sum = el('summary', 'mf-rs-row mf-rs-row--click');
    sum.append(el('span', 'mf-rs-n', `#${e.n}`), el('span', 'mf-rs-time', hhmmss(e.t)));
    const chips = el('span', 'mf-rs-changes');
    for (const c of e.changes) chips.append(...chip(c));
    sum.appendChild(chips);
    det.appendChild(sum);
    let built = false;
    det.addEventListener('toggle', () => {
      if (det.open && !built) {
        built = true;
        det.appendChild(entryDetails(e));
      }
    });
    li.appendChild(det);
    return li;
  }

  function render() {
    if (!box.isConnected && box.dataset.mfRendered) return;
    box.dataset.mfRendered = '1';
    const nothing = state.nothing;
    stats.textContent = '';
    stats.append(el('strong', null, plural(state.n, K.unit)), document.createTextNode(` since ${hhmmss(state.since)}`));
    if (state.n) {
      const w = el('span', nothing ? 'mf-rs-wasted' : 'mf-muted', ` · ${nothing} with nothing changed`);
      if (nothing) w.title = kind === 'angular' ? 'Normal for Angular: every cycle checks the component.' : 'Renders where no prop or state value changed (at most new object/function references) — candidates for memo, useCallback / useMemo.';
      stats.appendChild(w);
    }
    modeLine.textContent = '';
    modeLine.append(el('span', 'mf-rs-kind', K.title), el('span', 'mf-badge mf-rs-mode--' + state.mode, state.mode === 'exact' ? 'exact' : state.mode === 'sampled' ? 'sampled' : state.mode === 'rough' ? 'rough' : 'off'));
    if (state.note) modeLine.appendChild(el('span', 'mf-muted mf-rs-note', state.note));
    renderCurrent();
    const items = [];
    if (!state.entries.length) {
      items.push(el('li', 'mf-muted mf-rs-empty', state.paused ? 'Paused.' : `No ${K.unit}s yet. Use the page — every ${K.unit} of ${ctx.componentName} shows up here.`));
    }
    for (const e of state.entries.slice().reverse()) {
      let li = liOf.get(e);
      if (!li || e.dirty) {
        const fresh = rowFor(e);
        // A merged "nothing changed" row that is already open keeps its place.
        li = fresh;
        liOf.set(e, li);
        e.dirty = false;
      }
      items.push(li);
    }
    if (state.n > MAX_ENTRIES && state.entries.length >= MAX_ENTRIES) items.push(el('li', 'mf-muted mf-rs-empty', `Only the last ${MAX_ENTRIES} entries are kept.`));
    const scroll = list.scrollTop;
    list.replaceChildren(...items);
    list.scrollTop = scroll;
  }

  pauseBtn.onclick = () => {
    state.paused = !state.paused;
    pauseBtn.textContent = state.paused ? 'Resume' : 'Pause';
    schedule();
  };
  clearBtn.onclick = () => {
    state.entries = [];
    state.n = 0;
    state.nothing = 0;
    state.since = Date.now();
    schedule();
  };
  copyBtn.onclick = () => {
    const lines = [`${ctx.componentName} — ${K.title} (${state.mode}), since ${hhmmss(state.since)}`, ...state.entries.map(lineText)];
    copy(lines.join('\n'), copyBtn);
  };

  function stop() {
    if (tracker) tracker.stop();
    tracker = null;
  }

  render();
  return () => {
    clearTimeout(timer);
    stop();
  };
}
