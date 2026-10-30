// "Web Vitals": LCP, CLS and INP for this page, each pointed at the file and line that caused it.
//   • LCP — the element that was the largest paint (its file:line), the image URL, and where the time went
//           (server response, waiting to start loading, loading, rendering).
//   • CLS — the elements that moved, and the likely cause: what was inserted, loaded or grew just above them
//           right before the shift (a banner, an image without width/height, a late-loading list).
//   • INP — the slowest interactions: the element you clicked or typed in, the handler that ran (onClick={toggle}
//           → where `toggle` is declared, looked up in the source), and how the time splits into input delay,
//           processing and presentation. Long Animation Frame scripts are listed when the browser reports them.
// Chrome tells you these numbers but not which component caused them; Sourcepeek's tagging can.
// Recording starts when Sourcepeek loads; LCP, CLS and INP entries from before that are read from the browser's buffer.

import { el, api, copy, locate, resolveHit, fileLine, openSource, flashElement, getState } from './core.js';

const T = {
  lcp: { good: 2500, poor: 4000, unit: 'ms' },
  cls: { good: 0.1, poor: 0.25, unit: '' },
  inp: { good: 200, poor: 500, unit: 'ms' },
  fcp: { good: 1800, poor: 3000, unit: 'ms' },
  ttfb: { good: 800, poor: 1800, unit: 'ms' },
};

const MAX_SHIFTS = 300;
const MAX_INTERACTIONS = 400;
const RECENT_MS = 1000;

const V = {
  installed: false,
  observers: [],
  cleanup: [],
  lcp: null,
  fcp: null,
  shifts: [],
  interactions: new Map(),
  loafs: [],
  recent: [], // DOM nodes inserted / loaded just now: candidates for "what caused this layout shift"
  ownEvents: [], // timestamps of events that went to Sourcepeek itself (its panel, inspect mode) — not the app's INP
  ownIds: new Set(),
  listeners: new Set(),
  since: 0,
  supported: { lcp: false, cls: false, inp: false, loaf: false },
};

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const ours = (n) => n && n.nodeType === 1 && (n.tagName === 'SOURCEPEEK-ROOT' || (n.closest && n.closest('sourcepeek-root')));

function rating(metric, v) {
  if (v == null) return 'none';
  const t = T[metric];
  return v <= t.good ? 'good' : v <= t.poor ? 'needs-improvement' : 'poor';
}

function fmt(metric, v) {
  if (v == null) return '—';
  if (metric === 'cls') return v === 0 ? '0' : v < 0.001 ? '<0.001' : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
}

function changed() {
  if (V.timer) return;
  V.timer = setTimeout(() => {
    V.timer = null;
    for (const fn of V.listeners) {
      try {
        fn();
      } catch {}
    }
  }, 120);
}

export function onVitals(fn) {
  V.listeners.add(fn);
  return () => V.listeners.delete(fn);
}

// ---------- where is an element written ----------

function selectorOf(n) {
  if (!n || n.nodeType !== 1) return '';
  let s = n.tagName.toLowerCase();
  if (n.id && !/^[:«\d]/.test(n.id)) s += '#' + n.id;
  const cls = typeof n.className === 'string' ? n.className : '';
  const parts = cls.split(/\s+/).filter((c) => c && c.length < 30 && !/^(css-|sc-|jsx-|svelte-|ng-|_ngcontent)/.test(c)).slice(0, 2);
  if (parts.length) s += '.' + parts.join('.');
  return s;
}

/** { comp, file, line, tag, selector, ref } for a node, or null. Angular hits are completed later (async). */
function whereIs(node) {
  if (!node || node.nodeType !== 1 || ours(node)) return null;
  let hit = null;
  try {
    hit = locate(node);
  } catch {}
  const out = { tag: node.tagName.toLowerCase(), selector: selectorOf(node), ref: typeof WeakRef !== 'undefined' ? new WeakRef(node) : { deref: () => node } };
  if (hit) Object.assign(out, { comp: hit.comp, file: hit.file || null, line: hit.line || null, ng: Boolean(hit.ng), hitEl: hit.el === node ? null : hit.el });
  return out;
}

const deref = (w) => (w && w.ref ? w.ref.deref() : null);

// ---------- LCP ----------

function onLcp(list) {
  for (const e of list.getEntries()) {
    const value = e.renderTime || e.loadTime || e.startTime;
    V.lcp = { value, entry: { url: e.url || '', size: e.size, renderTime: e.renderTime, loadTime: e.loadTime, startTime: e.startTime }, where: whereIs(e.element), t: Date.now() };
  }
  changed();
}

function lcpBreakdown() {
  if (!V.lcp) return null;
  const nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
  const ttfb = nav ? Math.max(0, nav.responseStart - (nav.activationStart || 0)) : 0;
  let res = null;
  if (V.lcp.entry.url) {
    try {
      res = performance.getEntriesByType('resource').find((r) => r.name === V.lcp.entry.url) || null;
    } catch {}
  }
  const reqStart = Math.max(ttfb, res ? res.requestStart || res.startTime : 0);
  const resEnd = Math.max(reqStart, res ? res.responseEnd : 0);
  const v = V.lcp.value;
  return {
    ttfb,
    loadDelay: res ? reqStart - ttfb : 0,
    loadTime: res ? resEnd - reqStart : 0,
    renderDelay: Math.max(0, v - (res ? resEnd : ttfb)),
    resource: Boolean(res),
  };
}

function lcpHints() {
  const out = [];
  const n = deref(V.lcp && V.lcp.where);
  const b = lcpBreakdown();
  if (n && n.tagName === 'IMG') {
    if (n.loading === 'lazy') out.push('The LCP image has loading="lazy" — load it eagerly (it is visible right away).');
    if (!n.getAttribute('fetchpriority')) out.push('Add fetchpriority="high" to the LCP image so the browser loads it first.');
  }
  if (b && b.resource && b.loadDelay > 500) out.push(`The image request started ${fmt('lcp', b.loadDelay)} after the HTML arrived — preload it, or render it in the HTML instead of after JavaScript.`);
  if (b && b.renderDelay > 1000) out.push(`${fmt('lcp', b.renderDelay)} between loading and painting — usually JavaScript blocking the main thread, or content that waits for data / fonts.`);
  if (b && b.ttfb > 800) out.push(`The server took ${fmt('lcp', b.ttfb)} to answer (TTFB).`);
  return out;
}

// ---------- CLS ----------

function remember(node, kind) {
  if (!node || node.nodeType !== 1 || ours(node)) return;
  V.recent.push({ node, kind, t: now() });
  const cutoff = now() - RECENT_MS * 2;
  while (V.recent.length && (V.recent[0].t < cutoff || V.recent.length > 400)) V.recent.shift();
}

function rectOf(r) {
  return r ? { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right } : null;
}

/**
 * The likely cause of a shift: something inserted / loaded right before it, sitting above (or left of) the moved
 * element, that is neither inside it nor containing it. An image without width/height that just loaded is its own cause.
 */
function causeOf(entry, sources) {
  const t0 = entry.startTime;
  const moved = sources.filter((s) => s.node && s.cur && s.prev);
  if (!moved.length) return null;
  const cands = V.recent.filter((r) => r.t >= t0 - RECENT_MS && r.t <= t0 + 50 && r.node.isConnected);
  let best = null;
  for (const c of cands) {
    if (moved.some((s) => s.node === c.node || s.node.contains(c.node) || c.node.contains(s.node))) continue;
    const r = c.node.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    for (const s of moved) {
      const down = s.cur.top - s.prev.top;
      const right = s.cur.left - s.prev.left;
      let dist = null;
      if (Math.abs(down) >= Math.abs(right) && r.bottom <= s.cur.top + 2 && r.top <= s.prev.top + 2) dist = s.cur.top - r.bottom;
      else if (r.right <= s.cur.left + 2 && Math.abs(r.top - s.cur.top) < s.cur.height + r.height) dist = s.cur.left - r.right;
      if (dist === null) continue;
      const score = dist - Math.min(r.height, 400) / 10 - (c.t - (t0 - RECENT_MS)) / 100;
      if (!best || score < best.score) best = { score, c };
    }
  }
  if (best) return { kind: best.c.kind, where: whereIs(best.c.node) };
  for (const s of moved) {
    const n = s.node;
    if (n.tagName === 'IMG' && !(n.getAttribute('width') && n.getAttribute('height')) && !/aspect-ratio/.test(n.getAttribute('style') || '')) return { kind: 'image without size', where: whereIs(n), self: true };
  }
  // A font swap moves text without any DOM change.
  const font = V.recent.find((r) => r.kind === 'font' && r.t >= t0 - RECENT_MS);
  if (font) return { kind: 'web font', where: null };
  return null;
}

function onShift(list) {
  for (const e of list.getEntries()) {
    if (e.hadRecentInput) continue;
    const sources = (e.sources || []).map((s) => ({ node: s.node && s.node.nodeType === 1 ? s.node : s.node && s.node.parentElement, prev: rectOf(s.previousRect), cur: rectOf(s.currentRect) }));
    const cause = causeOf(e, sources);
    V.shifts.push({
      value: e.value,
      startTime: e.startTime,
      t: Date.now(),
      moved: sources.filter((s) => s.node && !ours(s.node)).map((s) => ({ where: whereIs(s.node), dy: s.cur && s.prev ? Math.round(s.cur.top - s.prev.top) : 0, dx: s.cur && s.prev ? Math.round(s.cur.left - s.prev.left) : 0 })),
      cause,
    });
    if (V.shifts.length > MAX_SHIFTS) V.shifts.shift();
  }
  changed();
}

/** CLS = the worst session window (shifts less than 1 s apart, at most 5 s long). */
function clsWindow() {
  let best = { value: 0, shifts: [] };
  let cur = { value: 0, shifts: [] };
  for (const s of V.shifts) {
    const first = cur.shifts[0];
    const last = cur.shifts[cur.shifts.length - 1];
    if (cur.shifts.length && s.startTime - last.startTime < 1000 && s.startTime - first.startTime < 5000) {
      cur.value += s.value;
      cur.shifts.push(s);
    } else cur = { value: s.value, shifts: [s] };
    if (cur.value > best.value) best = { value: cur.value, shifts: cur.shifts.slice() };
  }
  return best;
}

function keyOf(w) {
  if (!w) return 'unknown';
  return w.file ? `${w.file}:${w.line}` : `${w.comp || ''} ${w.selector}`;
}

/** Shifts of the worst window grouped by what caused them (or what moved, when the cause is unknown). */
function clsContributors(win) {
  const groups = new Map();
  for (const s of win.shifts) {
    const w = s.cause && s.cause.where ? s.cause.where : s.moved[0] ? s.moved[0].where : null;
    const k = (s.cause ? 'cause:' : 'moved:') + (s.cause && !s.cause.where ? s.cause.kind : keyOf(w));
    let g = groups.get(k);
    if (!g) {
      g = { value: 0, count: 0, cause: s.cause, where: w, moved: [] };
      groups.set(k, g);
    }
    g.value += s.value;
    g.count++;
    for (const m of s.moved) if (g.moved.length < 4 && !g.moved.some((x) => keyOf(x.where) === keyOf(m.where))) g.moved.push(m);
  }
  return [...groups.values()].sort((a, b) => b.value - a.value);
}

// ---------- INP ----------

const REACT_PROPS = {
  click: ['onClick', 'onClickCapture', 'onDoubleClick'],
  pointerdown: ['onPointerDown', 'onMouseDown', 'onTouchStart'],
  pointerup: ['onPointerUp', 'onMouseUp', 'onTouchEnd'],
  mousedown: ['onMouseDown'],
  mouseup: ['onMouseUp'],
  keydown: ['onKeyDown', 'onChange', 'onInput', 'onBeforeInput'],
  keyup: ['onKeyUp', 'onChange', 'onInput'],
  keypress: ['onKeyPress', 'onChange', 'onInput'],
};

function reactProps(n) {
  for (const k in n) if (k.startsWith('__reactProps$')) return n[k];
  return null;
}

/** The element (target or an ancestor) that has a handler for one of these events, and the handler's name. */
function handlerFor(target, types) {
  const order = ['click', 'keydown', 'keypress', 'keyup', 'pointerup', 'pointerdown', 'mouseup', 'mousedown'].filter((t) => types.includes(t));
  for (let n = target, depth = 0; n && n.nodeType === 1 && depth < 25; n = n.parentElement, depth++) {
    if (ours(n)) return null;
    for (const type of order) {
      // React
      const rp = reactProps(n);
      if (rp) {
        const names = [...(REACT_PROPS[type] || [])];
        // A click on a checkbox, radio or select runs its onChange.
        if (type === 'click' && /^(INPUT|SELECT)$/.test(n.tagName) && (n.tagName === 'SELECT' || /^(checkbox|radio)$/i.test(n.type))) names.push('onChange');
        for (const p of names) if (typeof rp[p] === 'function') return { el: n, event: type, name: rp[p].name || '', framework: 'react' };
      }
      // Vue
      const vei = n._vei;
      if (vei) {
        const key = 'on' + type[0].toUpperCase() + type.slice(1);
        const inv = vei[key] || (type === 'pointerup' || type === 'pointerdown' ? vei.onClick : null);
        if (inv) {
          const fn = Array.isArray(inv.value) ? inv.value[0] : inv.value;
          return { el: n, event: type, name: (fn && fn.name) || '', framework: 'vue' };
        }
      }
      // Svelte 5 delegated events
      if (typeof n['__' + type] === 'function') return { el: n, event: type, name: n['__' + type].name || '', framework: 'svelte' };
      // Angular
      const ng = typeof window !== 'undefined' ? window.ng : null;
      if (ng && typeof ng.getListeners === 'function') {
        try {
          const ls = ng.getListeners(n).filter((l) => l.element === n && (l.name === type || (type.startsWith('pointer') && l.name === 'click')));
          if (ls.length) return { el: n, event: ls[0].name, name: '', framework: 'angular' };
        } catch {}
      }
      // A plain onclick — but not React's empty one on the root container (it only makes iOS Safari send clicks).
      const plainFn = n['on' + type];
      if (typeof plainFn === 'function' && !/^noop/.test(plainFn.name) && !Object.keys(n).some((k) => k.startsWith('__reactContainer$'))) return { el: n, event: type, name: plainFn.name || '', framework: 'dom' };
    }
  }
  return null;
}

/** Clicks and keys that went to Sourcepeek (its panels, or the page while inspect mode is on) are not the app's. */
function onAnyInput(e) {
  let mine = false;
  try {
    const st = getState();
    mine = (st && st.inspect) || e.altKey || (typeof e.composedPath === 'function' && e.composedPath().some((n) => n && n.tagName === 'SOURCEPEEK-ROOT'));
  } catch {}
  if (!mine) return;
  V.ownEvents.push(e.timeStamp);
  if (V.ownEvents.length > 200) V.ownEvents.shift();
}

const isOwn = (entry) => V.ownEvents.some((t) => Math.abs(t - entry.startTime) < 1);

function onEvent(list) {
  for (const e of list.getEntries()) {
    const id = e.interactionId;
    if (!id) continue;
    if (V.ownIds.has(id)) continue;
    if (isOwn(e) || (e.target && ours(e.target))) {
      V.ownIds.add(id);
      V.interactions.delete(id);
      continue;
    }
    let it = V.interactions.get(id);
    if (!it) {
      if (V.interactions.size >= MAX_INTERACTIONS) {
        // keep the slow ones
        const fastest = [...V.interactions.values()].sort((a, b) => a.duration - b.duration)[0];
        if (fastest && fastest.duration < e.duration) V.interactions.delete(fastest.id);
        else continue;
      }
      it = { id, duration: 0, startTime: e.startTime, processingStart: e.processingStart, processingEnd: e.processingEnd, types: [], target: null, handler: null, t: Date.now() };
      V.interactions.set(id, it);
    }
    it.duration = Math.max(it.duration, e.duration);
    it.startTime = Math.min(it.startTime, e.startTime);
    it.processingStart = Math.min(it.processingStart, e.processingStart);
    it.processingEnd = Math.max(it.processingEnd, e.processingEnd);
    if (!it.types.includes(e.name)) it.types.push(e.name);
    if (!it.targetNode && e.target) it.targetNode = e.target;
    // Work out the element and handler while it is still in the page.
    if (it.targetNode && it.targetNode.isConnected) {
      const node = it.targetNode.nodeType === 1 ? it.targetNode : it.targetNode.parentElement;
      if (!it.target) it.target = whereIs(node);
      if (!it.handler || it.handler.event !== 'click') {
        const h = handlerFor(node, it.types);
        if (h && (!it.handler || h.event === 'click')) it.handler = { event: h.event, name: h.name, framework: h.framework, where: whereIs(h.el) };
      }
      // No handler visible at runtime (Svelte, some Angular listeners): the source of the element and its nearest
      // tagged parents is checked for an onclick / (click) / @click instead.
      if (!it.handler && !it.guesses) {
        it.guesses = [];
        for (let n = node, i = 0; n && n.nodeType === 1 && i < 6 && it.guesses.length < 3; n = n.parentElement, i++) {
          const w = whereIs(n);
          if (w && (w.file || w.ng) && !it.guesses.some((g) => g.file === w.file && g.line === w.line)) it.guesses.push(w);
        }
      }
    }
  }
  changed();
}

function inpValue() {
  const all = [...V.interactions.values()].sort((a, b) => b.duration - a.duration);
  if (!all.length) return { value: null, list: all };
  // web-vitals: the worst interaction, ignoring one in every 50 (p98) on pages with many interactions.
  const idx = Math.min(all.length - 1, Math.floor(V.interactions.size / 50));
  return { value: all[idx].duration, worst: all[idx], list: all };
}

function phases(it) {
  const inputDelay = Math.max(0, it.processingStart - it.startTime);
  const processing = Math.max(0, it.processingEnd - it.processingStart);
  const presentation = Math.max(0, it.startTime + it.duration - it.processingEnd);
  return { inputDelay, processing, presentation };
}

// ---------- Long Animation Frames (Chrome 123+) ----------

function onLoaf(list) {
  for (const e of list.getEntries()) {
    V.loafs.push({
      startTime: e.startTime,
      duration: e.duration,
      blocking: e.blockingDuration || 0,
      scripts: (e.scripts || []).map((s) => ({
        invoker: s.invoker || '',
        type: s.invokerType || '',
        url: s.sourceURL || '',
        fn: s.sourceFunctionName || '',
        duration: s.duration || 0,
        layout: s.forcedStyleAndLayoutDuration || 0,
      })),
    });
    if (V.loafs.length > 200) V.loafs.shift();
  }
}

/** Scripts that ran during an interaction, longest first. Vite serves your files under their own path (/src/…). */
function scriptsFor(it) {
  const end = it.startTime + it.duration;
  const out = [];
  for (const f of V.loafs) {
    if (f.startTime > end || f.startTime + f.duration < it.startTime) continue;
    for (const s of f.scripts) out.push(s);
  }
  return out
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 4)
    .map((s) => {
      let file = null;
      try {
        const u = new URL(s.url, location.href);
        if (u.origin === location.origin && /^\/(src|app|pages|components|lib)\//.test(u.pathname)) file = u.pathname.slice(1);
      } catch {}
      return { ...s, file };
    });
}

// ---------- install ----------

function observe(type, fn, opts = {}) {
  try {
    if (typeof PerformanceObserver === 'undefined' || !(PerformanceObserver.supportedEntryTypes || []).includes(type)) return false;
    const o = new PerformanceObserver(fn);
    o.observe({ type, buffered: true, ...opts });
    V.observers.push(o);
    return true;
  } catch {
    return false;
  }
}

export function installVitals() {
  if (V.installed || typeof window === 'undefined') return;
  V.installed = true;
  V.since = Date.now();
  V.supported.lcp = observe('largest-contentful-paint', onLcp);
  V.supported.cls = observe('layout-shift', onShift);
  V.supported.inp = observe('event', onEvent, { durationThreshold: 16 });
  observe('first-input', onEvent);
  V.supported.loaf = observe('long-animation-frame', onLoaf);
  for (const type of ['pointerdown', 'pointerup', 'click', 'keydown', 'keyup', 'mousedown', 'mouseup']) {
    window.addEventListener(type, onAnyInput, true);
    V.cleanup.push(() => window.removeEventListener(type, onAnyInput, true));
  }
  observe('paint', (list) => {
    for (const e of list.getEntries()) if (e.name === 'first-contentful-paint') V.fcp = e.startTime;
    changed();
  });
  if (V.supported.cls && typeof MutationObserver !== 'undefined') {
    const mo = new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) remember(n, 'inserted');
    });
    const start = () => mo.observe(document.documentElement, { childList: true, subtree: true });
    document.documentElement ? start() : window.addEventListener('DOMContentLoaded', start, { once: true });
    V.cleanup.push(() => mo.disconnect());
    const onLoad = (e) => {
      const n = e.target;
      if (n && n.nodeType === 1 && /^(IMG|IFRAME|VIDEO|EMBED|OBJECT)$/.test(n.tagName)) remember(n, 'loaded');
    };
    window.addEventListener('load', onLoad, true);
    V.cleanup.push(() => window.removeEventListener('load', onLoad, true));
    if (document.fonts && document.fonts.addEventListener) {
      const onFont = () => V.recent.push({ node: document.body, kind: 'font', t: now() });
      document.fonts.addEventListener('loadingdone', onFont);
      V.cleanup.push(() => document.fonts.removeEventListener('loadingdone', onFont));
    }
  }
}

export function uninstallVitals() {
  if (!V.installed) return;
  V.installed = false;
  V.observers.forEach((o) => o.disconnect());
  V.observers = [];
  V.cleanup.forEach((fn) => fn());
  V.cleanup = [];
  V.recent = [];
}

/** Clears CLS and INP (LCP and FCP are measured once per page load). */
export function resetVitals() {
  V.shifts = [];
  V.interactions.clear();
  V.ownIds.clear();
  V.loafs = [];
  V.since = Date.now();
  changed();
}

// ---------- snapshot (UI, report, MCP) ----------

const plainWhere = (w) => (w ? { component: w.comp || null, file: w.file || null, line: w.line || null, element: w.selector } : null);

/** Everything measured so far, as plain data. */
export function vitalsSnapshot() {
  const win = clsWindow();
  const inp = inpValue();
  const b = lcpBreakdown();
  return {
    url: typeof location !== 'undefined' ? location.href : '',
    since: new Date(V.since).toISOString(),
    supported: { ...V.supported },
    lcp: V.lcp
      ? { value: Math.round(V.lcp.value), rating: rating('lcp', V.lcp.value), element: plainWhere(V.lcp.where), url: V.lcp.entry.url || null, breakdown: b && Object.fromEntries(Object.entries(b).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v) : v])), hints: lcpHints() }
      : null,
    cls: {
      value: Math.round(win.value * 1000) / 1000,
      rating: rating('cls', win.value),
      shifts: V.shifts.length,
      contributors: clsContributors(win)
        .slice(0, 6)
        .map((g) => ({ value: Math.round(g.value * 1000) / 1000, shifts: g.count, cause: g.cause ? { kind: g.cause.kind, element: plainWhere(g.cause.where) } : null, moved: g.moved.map((m) => ({ ...plainWhere(m.where), dy: m.dy, dx: m.dx })) })),
    },
    inp: {
      value: inp.value == null ? null : Math.round(inp.value),
      rating: rating('inp', inp.value),
      interactions: V.interactions.size,
      slowest: inp.list.slice(0, 6).map((it) => ({
        duration: Math.round(it.duration),
        events: it.types,
        target: plainWhere(it.target),
        handler: it.handler ? { name: it.handler.name || null, element: plainWhere(it.handler.where), source: it.handler.source || null } : null,
        phases: Object.fromEntries(Object.entries(phases(it)).map(([k, v]) => [k, Math.round(v)])),
        scripts: scriptsFor(it).map((s) => ({ invoker: s.invoker, fn: s.fn || null, file: s.file, url: s.file ? null : s.url || null, duration: Math.round(s.duration), forcedLayout: Math.round(s.layout) })),
      })),
    },
    fcp: V.fcp == null ? null : Math.round(V.fcp),
    ttfb: (() => {
      const nav = typeof performance !== 'undefined' && performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
      return nav ? Math.round(nav.responseStart) : null;
    })(),
  };
}

/** Markdown for a ticket / AI chat. */
export function vitalsMarkdown(s = vitalsSnapshot()) {
  const loc = (w) => (w ? `${w.component ? `<${w.component}> ` : ''}\`${w.element}\`${w.file ? ` at \`${fileLine(w.file, w.line)}\`` : ''}` : 'unknown element');
  const L = [`## Web Vitals — ${s.url}`, ''];
  if (s.lcp) {
    L.push(`- **LCP ${fmt('lcp', s.lcp.value)}** (${s.lcp.rating}) — ${loc(s.lcp.element)}${s.lcp.url ? `, ${s.lcp.url}` : ''}`);
    const b = s.lcp.breakdown;
    if (b) L.push(`  - TTFB ${b.ttfb} ms · load delay ${b.loadDelay} ms · load ${b.loadTime} ms · render delay ${b.renderDelay} ms`);
    for (const h of s.lcp.hints) L.push(`  - ${h}`);
  } else L.push('- **LCP** not reported');
  L.push(`- **CLS ${fmt('cls', s.cls.value)}** (${s.cls.rating}), ${s.cls.shifts} shift${s.cls.shifts === 1 ? '' : 's'}`);
  for (const c of s.cls.contributors) {
    const cause = c.cause ? (c.cause.element ? `${c.cause.kind}: ${loc(c.cause.element)}` : c.cause.kind) : 'cause unknown';
    L.push(`  - ${fmt('cls', c.value)} — ${cause}; moved ${c.moved.map((m) => loc(m)).join(', ') || '—'}`);
  }
  L.push(`- **INP ${s.inp.value == null ? '—' : fmt('inp', s.inp.value)}** (${s.inp.rating}), ${s.inp.interactions} interaction${s.inp.interactions === 1 ? '' : 's'}`);
  for (const it of s.inp.slowest.slice(0, 4)) {
    const h = it.handler && it.handler.source ? ` → handler \`${it.handler.source.name}\` at \`${fileLine(it.handler.source.file, it.handler.source.line)}\`` : it.handler && it.handler.name ? ` → handler \`${it.handler.name}\`` : '';
    L.push(`  - ${it.duration} ms ${it.events.join('/')} on ${loc(it.target)}${h} (input delay ${it.phases.inputDelay} ms, processing ${it.phases.processing} ms, presentation ${it.phases.presentation} ms)`);
  }
  if (s.fcp != null || s.ttfb != null) L.push(`- FCP ${fmt('fcp', s.fcp)} · TTFB ${fmt('ttfb', s.ttfb)}`);
  return L.join('\n');
}

/** The header text shown while the section is collapsed: "LCP 2.8 s · CLS 0.21 · INP 340 ms". */
export function vitalsSummary() {
  const s = vitalsSnapshot();
  const parts = [];
  if (s.lcp) parts.push(`LCP ${fmt('lcp', s.lcp.value)}`);
  if (s.supported.cls) parts.push(`CLS ${fmt('cls', s.cls.value)}`);
  if (s.inp.value != null) parts.push(`INP ${fmt('inp', s.inp.value)}`);
  const bad = [s.lcp && s.lcp.rating, s.supported.cls && s.cls.rating, s.inp.rating].some((r) => r === 'poor' || r === 'needs-improvement');
  return { text: parts.join(' · '), kind: parts.length ? (bad ? 'warn' : 'ok') : '' };
}

// ---------- handler source lookups (cached) ----------

const handlerCache = new Map();

/** For an interaction's handler element written at file:line, ask the backend where the handler is declared. */
async function resolveHandler(it) {
  if (!it.handler && it.guesses && !it.guessed) {
    it.guessed = true;
    for (const w of it.guesses) {
      if (w.ng && !w.resolved) await completeNg(w);
      if (!w.file) continue;
      const key = `${w.file}:${w.line}:${it.types.join(',')}`;
      if (!handlerCache.has(key)) handlerCache.set(key, api('/lookup/handler', { file: w.file, line: w.line, events: it.types }));
      const res = await handlerCache.get(key);
      if (res.ok && res.data && res.data.found) {
        it.handler = { event: it.types[0], name: res.data.name, framework: 'source', where: w, source: res.data };
        break;
      }
    }
    return;
  }
  const h = it.handler;
  if (!h || h.source !== undefined) return;
  let w = h.where;
  if (w && w.ng && !w.resolved) await completeNg(w);
  if (!w || !w.file) {
    h.source = null;
    return;
  }
  const key = `${w.file}:${w.line}:${it.types.join(',')}`;
  if (!handlerCache.has(key)) handlerCache.set(key, api('/lookup/handler', { file: w.file, line: w.line, events: it.types }));
  const res = await handlerCache.get(key);
  h.source = res.ok && res.data && res.data.found ? res.data : null;
}

/** Angular elements get their template file and line from the backend. */
async function completeNg(w) {
  if (!w || !w.ng || w.resolved) return;
  w.resolved = true;
  const node = deref(w);
  if (!node) return;
  try {
    const hit = await resolveHit({ el: node, file: w.file, line: w.line, comp: w.comp, ng: true });
    if (hit && hit.file) {
      w.file = hit.file;
      w.line = hit.line;
    }
  } catch {}
}

/** Resolve everything the UI is about to show (Angular locations, handler declarations). */
export async function completeVitals() {
  const ws = [];
  if (V.lcp) ws.push(V.lcp.where);
  for (const s of V.shifts) {
    if (s.cause) ws.push(s.cause.where);
    for (const m of s.moved) ws.push(m.where);
  }
  const inp = inpValue();
  for (const it of inp.list.slice(0, 6)) {
    ws.push(it.target);
    if (it.handler) ws.push(it.handler.where);
  }
  await Promise.all(ws.filter((w) => w && w.ng && !w.resolved).map(completeNg));
  await Promise.all(inp.list.slice(0, 6).map(resolveHandler));
}

// ---------- UI ----------

function whereLink(w, fallback) {
  const box = el('span', 'mf-wv-where');
  if (!w) {
    box.appendChild(el('span', 'mf-muted', fallback || 'element not in the page any more'));
    return box;
  }
  const tag = el('code', 'mf-wv-tag', w.selector || `<${w.tag}>`);
  box.appendChild(tag);
  if (w.comp) box.appendChild(el('span', 'mf-wv-comp', w.comp));
  if (w.file) {
    const b = el('button', 'mf-linkbtn', fileLine(w.file, w.line));
    b.type = 'button';
    b.title = 'Open in your editor';
    b.onclick = () => openSource(w.file, w.line);
    box.appendChild(b);
  } else if (!w.comp) box.appendChild(el('span', 'mf-muted', '(not written in a tagged file)'));
  const n = deref(w);
  if (n && n.isConnected) {
    const show = el('button', 'mf-net-btn mf-wv-show', 'Show');
    show.type = 'button';
    show.onclick = () => {
      n.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(() => flashElement(n, `${w.comp ? w.comp + ' · ' : ''}${w.selector}`), 250);
    };
    show.onmouseenter = () => flashElement(n, `${w.comp ? w.comp + ' · ' : ''}${w.selector}`, true);
    box.appendChild(show);
  }
  return box;
}

function card(metric, title, value, sub) {
  const r = rating(metric, value);
  const c = el('div', 'mf-wv-card mf-wv-card--' + r);
  const top = el('div', 'mf-wv-top');
  top.append(el('span', 'mf-wv-name', title), el('span', 'mf-wv-value', fmt(metric, value)), el('span', 'mf-wv-rating mf-wv-rating--' + r, r === 'none' ? 'not measured' : r.replace('-', ' ')));
  if (sub) top.appendChild(el('span', 'mf-wv-sub', sub));
  c.appendChild(top);
  return c;
}

function bars(parts) {
  const total = parts.reduce((n, p) => n + p.v, 0) || 1;
  const wrap = el('div', 'mf-wv-bars');
  const bar = el('div', 'mf-wv-bar');
  const legend = el('div', 'mf-wv-legend');
  parts.forEach((p, i) => {
    const seg = el('span', 'mf-wv-seg mf-wv-seg--' + i);
    seg.style.width = `${Math.max(0.5, (p.v / total) * 100)}%`;
    seg.title = `${p.label}: ${Math.round(p.v)} ms`;
    bar.appendChild(seg);
    const item = el('span', 'mf-wv-leg');
    item.append(el('i', 'mf-wv-dot mf-wv-seg--' + i), document.createTextNode(`${p.label} ${Math.round(p.v)} ms`));
    legend.appendChild(item);
  });
  wrap.append(bar, legend);
  return wrap;
}

/** Fill the "Web Vitals" accordion. ctx: { file, componentName, onSummary(text, kind) }. Returns cleanup. */
export function buildVitals(box, ctx) {
  const head = el('div', 'mf-rs-head');
  const intro = el('div', 'mf-rs-stats mf-muted', '');
  const resetBtn = el('button', 'mf-net-btn', 'Reset CLS & INP');
  resetBtn.type = 'button';
  resetBtn.title = 'Start measuring layout shifts and interactions again from now — e.g. before trying one flow';
  const copyBtn = el('button', 'mf-net-btn', 'Copy');
  copyBtn.type = 'button';
  copyBtn.title = 'Copy as Markdown (for a ticket or an AI chat)';
  head.append(intro, resetBtn, copyBtn);
  const body = el('div', 'mf-wv');
  box.append(head, body);
  let alive = true;

  const mine = (w) => w && w.file && ctx.file && w.file.replace(/\\/g, '/').endsWith(String(ctx.file).replace(/\\/g, '/').replace(/^\.?\//, ''));

  const render = () => {
    if (!alive) return;
    const s = vitalsSnapshot();
    intro.textContent = `This page, since ${new Date(V.since).toLocaleTimeString()}. Use the page — clicks and typing add to INP.`;
    body.textContent = '';

    // LCP
    const lcp = card('lcp', 'LCP', s.lcp && s.lcp.value, 'Largest Contentful Paint · good ≤ 2.5 s');
    if (!V.supported.lcp) lcp.appendChild(el('div', 'mf-muted', 'This browser doesn’t report LCP (Chrome, Edge and Firefox do).'));
    else if (!V.lcp) lcp.appendChild(el('div', 'mf-muted', 'Not reported yet.'));
    else {
      const r = el('div', 'mf-wv-line');
      r.append(el('span', 'mf-wv-lbl', 'Element'), whereLink(V.lcp.where));
      lcp.appendChild(r);
      if (mine(V.lcp.where)) lcp.appendChild(el('div', 'mf-wv-mine', `This is ${ctx.componentName}.`));
      if (V.lcp.entry.url) {
        const u = el('div', 'mf-wv-line');
        u.append(el('span', 'mf-wv-lbl', 'Resource'), el('code', 'mf-wv-url', V.lcp.entry.url));
        lcp.appendChild(u);
      }
      const b = lcpBreakdown();
      if (b) lcp.appendChild(bars([{ label: 'TTFB', v: b.ttfb }, { label: 'load delay', v: b.loadDelay }, { label: 'load', v: b.loadTime }, { label: 'render delay', v: b.renderDelay }]));
      for (const h of lcpHints()) lcp.appendChild(el('div', 'mf-wv-hint', h));
    }
    body.appendChild(lcp);

    // CLS
    const win = clsWindow();
    const cls = card('cls', 'CLS', V.supported.cls ? win.value : null, `Cumulative Layout Shift · good ≤ 0.1 · ${V.shifts.length} shift${V.shifts.length === 1 ? '' : 's'}`);
    if (!V.supported.cls) cls.appendChild(el('div', 'mf-muted', 'This browser doesn’t report layout shifts (Chrome and Edge do).'));
    else if (!win.shifts.length) cls.appendChild(el('div', 'mf-muted', 'No unexpected layout shifts so far.'));
    else {
      for (const g of clsContributors(win).slice(0, 6)) {
        const item = el('div', 'mf-wv-item');
        const top = el('div', 'mf-wv-line');
        top.append(el('span', 'mf-wv-amount', fmt('cls', g.value)));
        if (g.cause && g.cause.where && !g.cause.self) top.append(el('span', 'mf-wv-lbl', `likely cause · ${g.cause.kind}`), whereLink(g.cause.where));
        else if (g.cause && g.cause.self) top.append(el('span', 'mf-wv-lbl', 'image without width/height'), whereLink(g.cause.where));
        else if (g.cause) top.append(el('span', 'mf-wv-lbl', `likely cause · ${g.cause.kind}`));
        else top.append(el('span', 'mf-wv-lbl', 'cause not found — moved'), whereLink(g.where));
        item.appendChild(top);
        if (g.cause && g.moved.length) {
          const mv = el('div', 'mf-wv-moved');
          mv.appendChild(el('span', 'mf-wv-lbl', 'moved'));
          for (const m of g.moved) {
            const one = el('span', 'mf-wv-moved-one');
            one.append(whereLink(m.where), el('span', 'mf-muted', m.dy ? `${m.dy > 0 ? '↓' : '↑'}${Math.abs(m.dy)}px` : m.dx ? `${m.dx > 0 ? '→' : '←'}${Math.abs(m.dx)}px` : ''));
            mv.appendChild(one);
          }
          item.appendChild(mv);
        }
        if (mine(g.cause && g.cause.where) || g.moved.some((m) => mine(m.where))) item.appendChild(el('div', 'mf-wv-mine', `${ctx.componentName} is involved.`));
        cls.appendChild(item);
      }
      cls.appendChild(el('div', 'mf-wv-hint', 'Reserve space for content that appears later (min-height, aspect-ratio, width/height on images), or put it below the fold.'));
    }
    body.appendChild(cls);

    // INP
    const inp = inpValue();
    const inpCard = card('inp', 'INP', inp.value, `Interaction to Next Paint · good ≤ 200 ms · ${V.interactions.size} interaction${V.interactions.size === 1 ? '' : 's'}`);
    if (!V.supported.inp) inpCard.appendChild(el('div', 'mf-muted', 'This browser doesn’t report interaction timing (Chrome, Edge and Firefox 144+ do).'));
    else if (!inp.list.length) inpCard.appendChild(el('div', 'mf-muted', 'No interactions yet — click, tap or type on the page.'));
    else {
      for (const it of inp.list.slice(0, 6)) {
        const item = el('div', 'mf-wv-item' + (it === inp.worst ? ' mf-wv-item--worst' : ''));
        const top = el('div', 'mf-wv-line');
        top.append(el('span', 'mf-wv-amount mf-wv-amount--' + rating('inp', it.duration), `${Math.round(it.duration)} ms`), el('span', 'mf-wv-lbl', it.types.join(' / ')), whereLink(it.target));
        item.appendChild(top);
        if (it.handler) {
          const hl = el('div', 'mf-wv-line');
          hl.appendChild(el('span', 'mf-wv-lbl', 'handler'));
          const src = it.handler.source;
          if (src) {
            const name = src.kind === 'inline' && src.calls ? `inline → ${src.calls.name}()` : src.kind === 'prop' ? `${src.name} (prop from the parent)` : src.name;
            hl.appendChild(el('code', 'mf-wv-fn', name));
            const target = src.calls && !src.calls.prop ? { file: src.file, line: src.calls.line } : { file: src.file, line: src.line };
            const b = el('button', 'mf-linkbtn', fileLine(target.file, target.line));
            b.type = 'button';
            b.onclick = () => openSource(target.file, target.line);
            hl.appendChild(b);
            if (src.attr) hl.appendChild(el('code', 'mf-wv-attr', src.attr));
          } else {
            hl.appendChild(el('code', 'mf-wv-fn', it.handler.name || '(anonymous)'));
            hl.appendChild(whereLink(it.handler.where));
          }
          item.appendChild(hl);
          if (mine(it.handler.where)) item.appendChild(el('div', 'mf-wv-mine', `The handler is in ${ctx.componentName}.`));
        }
        const p = phases(it);
        item.appendChild(bars([{ label: 'input delay', v: p.inputDelay }, { label: 'processing', v: p.processing }, { label: 'presentation', v: p.presentation }]));
        const scripts = scriptsFor(it);
        if (scripts.length) {
          const sl = el('div', 'mf-wv-scripts');
          for (const sc of scripts) {
            const row = el('div', 'mf-wv-script');
            row.append(el('span', 'mf-wv-amount', `${Math.round(sc.duration)} ms`), el('code', 'mf-wv-fn', sc.fn || sc.invoker || 'script'));
            if (sc.file) {
              const b = el('button', 'mf-linkbtn', sc.file);
              b.type = 'button';
              b.onclick = () => openSource(sc.file, 1);
              row.appendChild(b);
            } else if (sc.url) row.appendChild(el('span', 'mf-muted mf-wv-url', sc.url.split('/').pop().split('?')[0]));
            if (sc.layout > 5) row.appendChild(el('span', 'mf-wv-warn', `forced layout ${Math.round(sc.layout)} ms`));
            sl.appendChild(row);
          }
          item.appendChild(sl);
        }
        inpCard.appendChild(item);
      }
      const w = inp.worst ? phases(inp.worst) : null;
      if (w) {
        const big = w.processing >= w.inputDelay && w.processing >= w.presentation ? 'processing' : w.inputDelay >= w.presentation ? 'input delay' : 'presentation';
        const tip = {
          processing: 'Most time is spent in the event handlers — move heavy work out of the handler (defer it, split it up, or do less on each event).',
          'input delay': 'Most time is spent before the handler starts — something else was running on the main thread (a long task, a timer, hydration).',
          presentation: 'Most time is spent painting the result — the update re-renders or lays out a lot of the page.',
        }[big];
        inpCard.appendChild(el('div', 'mf-wv-hint', tip));
      }
    }
    body.appendChild(inpCard);

    const nav = performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
    const extra = el('div', 'mf-wv-extra mf-muted', `FCP ${fmt('fcp', V.fcp)} · TTFB ${fmt('ttfb', nav ? nav.responseStart : null)}`);
    body.appendChild(extra);
    const sum = vitalsSummary();
    if (ctx.onSummary) ctx.onSummary(sum.text, sum.kind);
  };

  let busy = false;
  const refresh = () => {
    render();
    if (busy) return;
    busy = true;
    completeVitals().then(() => {
      busy = false;
      render();
    });
  };
  const off = onVitals(refresh);
  resetBtn.onclick = () => {
    resetVitals();
    refresh();
  };
  copyBtn.onclick = async () => {
    await completeVitals();
    copy(vitalsMarkdown(), copyBtn);
  };
  refresh();
  return () => {
    alive = false;
    off();
  };
}
