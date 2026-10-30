// "Where does this value come from?" — click "€120" and follow it back:
//
//   "€120" in <span> ProductCard.tsx:14
//     ← prop price of <ProductCard>
//     ← passed at Page.tsx:42 as price={item.price}  (item from data.items.map)
//     ← state data.items[3].price of <Page>
//     ← GET /api/products → items[3].price
//
// Sourcepeek already has every piece: the props and state of each component in the chain, the call-site of each
// component, and the response bodies of the page's requests. This matches the displayed value across them:
// exact strings first, then numbers inside formatted text ("€1,299.00" → 1299), preferring the paths the
// call-site expression points at (price={item.price} inside data.items.map → data.items[n].price).

import { api } from './core.js';
import { findCurrentFiber, readReact, readVue, ownText } from './inspect.js';
import { ngRead } from './angular.js';
import { requestLog } from './network.js';
import { describe, pathJoin, preview } from './valueView.js';

const MAX_HOPS = 8;
const NODE_BUDGET = 6000;
const MAX_RESPONSES = 80;
const SKIP_PROPS = new Set(['data-mf-call', 'key', 'ref', 'className', 'style']);

// ---------- what is shown ----------

/** The value the element displays: an input's value, else its own text (or all its text when short). */
export function shownValue(node) {
  if (!node || node.nodeType !== 1) return '';
  const tag = node.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    const t = String(node.type || '').toLowerCase();
    if (t === 'checkbox' || t === 'radio') return node.checked ? 'true' : 'false';
    if (t === 'password') return '';
    return String(node.value || '');
  }
  if (tag === 'IMG') return node.getAttribute('alt') || '';
  let t = ownText(node);
  if (!t) {
    const all = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (all.length <= 160) t = all;
  }
  return t;
}

/** Numbers inside formatted text: "€1,299.00" → 1299, "1.299,50 €" → 1299.5, "45%" → 45 and 0.45. */
export function numbersIn(text) {
  const out = [];
  for (const m of String(text).matchAll(/-?\d[\d.,'   ]*\d|-?\d/g)) {
    let raw = m[0].replace(/[   ']/g, '');
    const lastDot = raw.lastIndexOf('.');
    const lastComma = raw.lastIndexOf(',');
    let n;
    if (lastDot >= 0 && lastComma >= 0) {
      // the later one is the decimal separator
      n = lastDot > lastComma ? Number(raw.replace(/,/g, '')) : Number(raw.replace(/\./g, '').replace(',', '.'));
    } else if (lastComma >= 0) {
      // "1,299" (thousands) vs "12,5" (decimal)
      n = /,\d{3}$/.test(raw) && !/,\d{3},?\d{1,2}$/.test(raw) ? Number(raw.replace(/,/g, '')) : Number(raw.replace(/,(?=\d{1,2}$)/, '.').replace(/,/g, ''));
    } else if (lastDot >= 0 && /\.\d{3}$/.test(raw) && (raw.match(/\./g) || []).length > 1) n = Number(raw.replace(/\./g, ''));
    else n = Number(raw);
    if (!Number.isFinite(n)) continue;
    out.push({ n, digits: raw.replace(/\D/g, '').length });
    if (/%/.test(text.slice(m.index + m[0].length, m.index + m[0].length + 2))) out.push({ n: n / 100, digits: raw.length, pct: true });
  }
  return out.sort((a, b) => b.digits - a.digits).slice(0, 4);
}

/** How well a stored value explains the displayed text. 0 = not at all. */
function matcher(text) {
  const s = String(text).trim();
  const lower = s.toLowerCase();
  const nums = numbersIn(s);
  const onlyNumber = /^[^\p{L}]*-?\d[\d.,'   ]*[^\p{L}]*$/u.test(s);
  return (v, key) => {
    const k = String(key || '');
    if (typeof v === 'string') {
      const t = v.trim();
      if (!t) return 0;
      if (t === s) return 10;
      if (t.toLowerCase() === lower) return 8;
      if (t.length >= 3 && s.includes(t)) return 3 + Math.min(4, (t.length / Math.max(1, s.length)) * 4);
      if (s.length >= 4 && t.includes(s)) return 2.5; // the page shows a clipped version
      if (nums.length && /^-?\d+(\.\d+)?$/.test(t)) {
        const n = Number(t);
        for (const x of nums) if (Math.abs(x.n - n) < 1e-9) return onlyNumber ? 7 : 4;
      }
      return 0;
    }
    if (typeof v === 'number' && Number.isFinite(v)) {
      for (const x of nums) {
        if (Math.abs(x.n - v) < 1e-9 || (Math.abs(v) >= 1 && Math.abs(Math.round(v * 100) / 100 - x.n) < 1e-9)) {
          let score = onlyNumber ? 7 : 4 + Math.min(2, x.digits / 3);
          // small integers match ids, indexes and counts everywhere
          if (Math.abs(v) < 10 && Number.isInteger(v) && !onlyNumber) score -= 3;
          if (/^(id|key|index|idx|userId|.*Id)$/.test(k) && !onlyNumber) score -= 2;
          return Math.max(0.5, score);
        }
      }
      return 0;
    }
    if (typeof v === 'boolean') return s === String(v) ? 6 : 0;
    return 0;
  };
}

// ---------- searching a value ----------

/** Every path inside `root` whose value matches, best first. Walks forms, signals, maps… the way the value viewer shows them. */
function search(root, match, base, budget = { n: NODE_BUDGET }) {
  const hits = [];
  const seen = new WeakSet();
  const walk = (v, path, key, depth) => {
    if (--budget.n < 0 || depth > 10) return;
    const t = typeof v;
    if (v === null || v === undefined || t === 'string' || t === 'number' || t === 'boolean') {
      const sc = match(v, key);
      if (sc > 0) hits.push({ path, value: v, score: sc - depth * 0.05 });
      return;
    }
    if (t === 'function' && !v.__v_isRef) {
      const d = describe(v);
      if (d.k !== 'signal') return;
    }
    if (t === 'object' || t === 'function') {
      if (seen.has(v)) return;
      seen.add(v);
    }
    const d = describe(v);
    if (!d.kids || d.k === 'react' || d.k === 'element' || d.k === 'error') return;
    let kids = [];
    try {
      kids = d.kids();
    } catch {}
    for (const [k, c] of kids.slice(0, 400)) {
      if (d.k === 'form' && k === 'controls') continue;
      const p = d.k === 'signal' || (d.k === 'observable' && k === 'value') ? path + '()' : pathJoin(path, d.k === 'array' || d.k === 'set' ? Number(k) : k);
      walk(c, p, k, depth + 1);
    }
  };
  walk(root, base, base, 0);
  return hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
}

// ---------- what a component holds ----------

function reactExtras(fiber) {
  const out = [];
  let h = fiber.memoizedState;
  let i = 0;
  if (fiber.tag !== 1) {
    while (h && i < 80) {
      const ms = h.memoizedState;
      if (h.queue && typeof h.queue === 'object' && typeof h.queue.getSnapshot === 'function') out.push(['store', `store#${i}`, ms]);
      else if (!(h.queue && 'lastRenderedReducer' in h.queue)) {
        if (Array.isArray(ms) && ms.length === 2 && (Array.isArray(ms[1]) || ms[1] === null) && typeof ms[0] !== 'function') out.push(['memo', `useMemo#${i}`, ms[0]]);
        else if (ms && typeof ms === 'object' && !Array.isArray(ms) && Object.keys(ms).length === 1 && 'current' in ms) out.push(['ref', `useRef#${i}`, ms.current]);
      }
      h = h.next;
      i++;
    }
  }
  let ctx = fiber.dependencies && (fiber.dependencies.firstContext || fiber.dependencies.first);
  for (let n = 0; ctx && n < 20; ctx = ctx.next, n++) {
    const c = ctx.context || ctx;
    out.push(['context', (c && c.displayName) || 'Context', ctx.memoizedValue]);
  }
  return out;
}

const stateNames = new Map();

async function namesFor(item) {
  if (!item._fiber) return null;
  const file = item.file || (item.el && item.el.dataset && item.el.dataset.mfFile);
  if (!file) return null;
  const key = `${file}#${item.name}`;
  if (!stateNames.has(key)) stateNames.set(key, api('/state-names', { file, componentName: item.name }).then((r) => (r.ok && r.data ? r.data.names || [] : [])));
  return stateNames.get(key);
}

/** [{ src: 'prop'|'state'|'memo'|'store'|'context'|'ref', key, value }] for a chain item. */
async function holdings(item) {
  const out = [];
  try {
    if (item._fiber) {
      const cur = findCurrentFiber(item._fiber) || item._fiber;
      const { props, state } = readReact(cur, true);
      const names = (await namesFor(item)) || [];
      for (const [k, v] of props) if (!SKIP_PROPS.has(k)) out.push({ src: 'prop', key: k, value: v });
      for (const [k, v] of state) {
        const m = /^state\[(\d+)\]$/.exec(k);
        out.push({ src: 'state', key: m && names[Number(m[1])] ? names[Number(m[1])] : k, value: v });
      }
      for (const [src, k, v] of reactExtras(cur)) out.push({ src, key: k, value: v });
    } else if (item._inst) {
      const { props, state } = readVue(item._inst, true);
      for (const [k, v] of props) out.push({ src: 'prop', key: k, value: v });
      for (const [k, v] of state) out.push({ src: 'state', key: k, value: v });
    } else if (item._ngInst) {
      const { props, state } = ngRead(item._ngInst, true);
      for (const [k, v] of props) out.push({ src: 'prop', key: k, value: v });
      for (const [k, v] of state) out.push({ src: 'state', key: k, value: v });
    }
  } catch {}
  return out;
}

const readable = (item) => Boolean(item && (item._fiber || item._inst || item._ngInst));

/** Best match inside a component, preferring paths that end the way `want` says (from the call-site expression). */
function bestIn(hold, match, want) {
  let all = [];
  for (const h of hold) {
    const hits = search(h.value, match, h.key);
    for (const x of hits.slice(0, 20)) all.push({ ...x, src: h.src, key: h.key });
  }
  if (!all.length) return null;
  if (want) {
    for (const x of all) {
      if (want.exact && x.path === want.exact) x.score += 6;
      else if (want.tail && want.tail.test(x.path)) x.score += 3;
      if (want.root && (x.key === want.root || x.path.startsWith(want.root + '.') || x.path.startsWith(want.root + '['))) x.score += 2;
    }
  }
  // Values a component received are less interesting than where they live, at equal score.
  const rank = { state: 0.3, store: 0.25, memo: 0.15, context: 0.2, prop: 0, ref: -0.2 };
  all.forEach((x) => (x.score += rank[x.src] || 0));
  all.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  const best = all[0];
  const alternatives = all.filter((x) => x !== best && x.score >= best.score - 0.5).length;
  return { ...best, alternatives };
}

/** From a call-site expression, what the matching path in the parent probably looks like. */
function expectation(attr, prop) {
  if (!attr || !attr.found) return null;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expr = String(attr.expr || '').replace(/\?\./g, '.').replace(/!/g, '');
  const want = {};
  if (attr.kind === 'expression' && /^[\w$.[\]'"]+$/.test(expr)) {
    want.exact = expr.replace(/\['([^']+)'\]|\["([^"]+)"\]/g, (m, a, b) => '.' + (a || b));
    if (attr.iterates && attr.root) {
      // price={item.price} inside data.items.map(item => …) → data.items[n].price
      const coll = attr.iterates.collection.replace(/\?\./g, '.').replace(/\(\)$/, '');
      const rest = expr.slice(attr.root.length);
      const tail = attr.iterates.destructured ? `.${attr.root}` : rest;
      if (/^[\w$.]+$/.test(coll)) {
        want.tail = new RegExp(`(^|\\.)${esc(coll)}(\\(\\))?\\[\\d+\\]${esc(tail)}$`);
        want.root = coll.split('.')[0];
        want.exact = null;
      }
    } else {
      want.root = attr.root || expr.split(/[.[]/)[0];
    }
  } else if (attr.kind === 'spread' && attr.root) {
    want.root = attr.root;
    if (attr.iterates) {
      const coll = attr.iterates.collection.replace(/\?\./g, '.');
      if (/^[\w$.]+$/.test(coll)) {
        want.tail = new RegExp(`(^|\\.)${esc(coll)}(\\(\\))?\\[\\d+\\]\\.${esc(prop)}$`);
        want.root = coll.split('.')[0];
      }
    }
  }
  return want;
}

function selectorOfNg(inst) {
  try {
    const sel = inst.constructor['ɵcmp'].selectors[0][0];
    return typeof sel === 'string' ? sel : null;
  } catch {
    return null;
  }
}

// ---------- network and storage ----------

function jsonOf(entry) {
  if (entry._json !== undefined) return entry._json;
  entry._json = null;
  if (entry.resBody && /^\s*[[{]/.test(entry.resBody) && !entry.truncated) {
    try {
      entry._json = JSON.parse(entry.resBody);
    } catch {}
  }
  return entry._json;
}

/** The most likely response field: same value, and — when we know the component path — the longest matching path end. */
function inResponses(match, statePath) {
  const log = requestLog().filter((e) => !e.pending && e.ok !== false && e.resBody).slice(-MAX_RESPONSES).reverse();
  const tail = statePath ? statePath.replace(/\(\)/g, '').split(/\.|(?=\[)/).filter(Boolean) : [];
  let best = null;
  for (const e of log) {
    const json = jsonOf(e);
    if (json === null) continue;
    for (const h of search(json, match, '', { n: 8000 }).slice(0, 10)) {
      const segs = h.path.split(/\.|(?=\[)/).filter(Boolean);
      let common = 0;
      while (common < segs.length && common < tail.length && segs[segs.length - 1 - common] === tail[tail.length - 1 - common]) common++;
      const score = h.score + common * 1.5 + (e.mocked ? -0.1 : 0);
      if (!best || score > best.score) best = { score, entry: e, path: h.path || '(the whole response)', value: h.value, common };
    }
  }
  return best;
}

function inStorage(match) {
  const out = [];
  for (const [area, store] of [
    ['localStorage', safeStore('localStorage')],
    ['sessionStorage', safeStore('sessionStorage')],
  ]) {
    if (!store) continue;
    for (let i = 0; i < Math.min(store.length, 200); i++) {
      const key = store.key(i);
      if (!key || key.startsWith('sourcepeek:')) continue;
      const raw = store.getItem(key) || '';
      if (raw.length > 200000) continue;
      let val = raw;
      if (/^\s*[[{"]/.test(raw)) {
        try {
          val = JSON.parse(raw);
        } catch {}
      }
      const hits = search(val, match, '', { n: 3000 });
      if (hits.length) out.push({ area, key, path: hits[0].path, score: hits[0].score });
    }
  }
  return out.sort((a, b) => b.score - a.score)[0] || null;
}

function safeStore(name) {
  try {
    return window[name];
  } catch {
    return null;
  }
}

function inUrl(match) {
  try {
    const u = new URL(location.href);
    for (const [k, v] of u.searchParams) if (match(v, k) >= 6) return { where: `?${k}=`, value: v };
    for (const seg of u.pathname.split('/').filter(Boolean)) {
      const d = decodeURIComponent(seg);
      if (match(d, 'segment') >= 6) return { where: `path segment “${d}”`, value: d };
    }
  } catch {}
  return null;
}

// ---------- the trace ----------

/**
 * Follow the shown value back to where it comes from.
 * ctx: { el, file, line, comp, chain (outermost first, with _fiber/_inst/_ngInst), current, callSite }
 * Returns { text, steps: [...], found, note } — steps go from the element towards the origin.
 */
export async function traceValue(ctx) {
  const text = shownValue(ctx.el);
  if (!text || text.length > 400) return { text, steps: [], found: false, note: text ? 'Text too long to trace.' : 'No value shown in this element.' };
  const match = matcher(text);
  const steps = [{ kind: 'shown', text, file: ctx.file, line: ctx.line, comp: ctx.comp, tag: ctx.el.tagName.toLowerCase() }];
  const chain = ctx.chain || [];
  let idx = chain.indexOf(ctx.current);
  if (idx < 0) idx = chain.length - 1;
  // Start at the component that owns the element (or the nearest readable one above it).
  while (idx >= 0 && !readable(chain[idx])) idx--;
  let want = null;
  let lastPath = null;
  let found = false;
  let hops = 0;
  let callSite = ctx.callSite || (chain[idx] && chain[idx].callSite) || null;
  while (idx >= 0 && hops++ < MAX_HOPS) {
    const item = chain[idx];
    const hit = bestIn(await holdings(item), match, want);
    if (!hit) {
      if (want) steps.push({ kind: 'lost', comp: item.name, note: `not found in the props or state of <${item.name}> — computed or formatted there` });
      break;
    }
    found = true;
    lastPath = hit.path;
    steps.push({ kind: hit.src, comp: item.name, path: hit.path, value: preview(hit.value, 80), alternatives: hit.alternatives, file: item.file || null });
    if (hit.src !== 'prop') break;
    // It arrived as a prop: who passed it, and as what?
    let parentIdx = idx - 1;
    while (parentIdx >= 0 && !readable(chain[parentIdx])) parentIdx--;
    const prop = hit.key;
    const cs = callSite || item.callSite;
    let attr = null;
    if (cs && cs.file) {
      const tag = item._ngInst ? selectorOfNg(item._ngInst) : item._inst ? item.name : null;
      const res = await api('/lookup/attr', { file: cs.file, line: cs.line || 0, prop, tag });
      attr = res.ok ? res.data : null;
    }
    steps.push({
      kind: 'passed',
      comp: item.name,
      prop,
      file: (attr && attr.file) || (cs && cs.file) || null,
      line: (attr && attr.line) || (cs && cs.line) || null,
      text: attr && attr.found ? attr.text : null,
      iterates: attr && attr.iterates ? attr.iterates.collection : null,
      parent: parentIdx >= 0 ? chain[parentIdx].name : null,
    });
    if (attr && attr.found && attr.kind === 'literal') {
      steps.push({ kind: 'literal', file: attr.file, line: attr.line, text: attr.text });
      return { text, steps, found: true, origin: 'code' };
    }
    want = expectation(attr, prop);
    if (parentIdx < 0) break;
    callSite = chain[parentIdx].callSite || null;
    idx = parentIdx;
  }
  const net = inResponses(match, lastPath);
  if (net && (net.common > 0 || net.score >= 6 || !found)) {
    const e = net.entry;
    let url = e.url;
    try {
      const u = new URL(e.url);
      url = (u.origin === location.origin ? '' : u.origin) + u.pathname + u.search;
    } catch {}
    steps.push({ kind: 'network', method: e.method, url, status: e.status, path: net.path, value: preview(net.value, 80), mocked: Boolean(e.mocked), t: e.start, id: e.id });
    found = true;
  } else {
    const st = inStorage(match);
    if (st && (st.score >= 6 || !found)) {
      steps.push({ kind: 'storage', area: st.area, key: st.key, path: st.path || '(the whole value)' });
      found = true;
    } else {
      const u = inUrl(match);
      if (u) {
        steps.push({ kind: 'url', where: u.where });
        found = true;
      }
    }
  }
  if (!found && !chain.some(readable)) {
    // Svelte 5 and plain DOM: there is no component state to look in, so there is nothing useful to say.
    return { text, steps, found: false, note: null };
  }
  if (!found) {
    return { text, steps, found: false, note: `“${text.length > 40 ? text.slice(0, 40) + '…' : text}” isn’t in the props or state of these components, in a response, storage or the URL — it is probably written in the markup or computed.` };
  }
  return { text, steps, found };
}

/** One line per step, for Copy and for agents. */
export function traceText(trace, fileLine) {
  const L = [];
  for (const s of trace.steps) {
    switch (s.kind) {
      case 'shown':
        L.push(`"${s.text}" shown in <${s.tag}> of <${s.comp}> at ${fileLine(s.file, s.line)}`);
        break;
      case 'prop':
      case 'state':
      case 'memo':
      case 'store':
      case 'context':
      case 'ref':
        L.push(`← ${s.kind} ${s.path} of <${s.comp}> = ${s.value}${s.alternatives ? ` (${s.alternatives} other field${s.alternatives === 1 ? '' : 's'} match too)` : ''}`);
        break;
      case 'passed':
        L.push(`← passed${s.parent ? ` by <${s.parent}>` : ''}${s.file ? ` at ${fileLine(s.file, s.line)}` : ''}${s.text ? ` as ${s.text}` : ''}${s.iterates ? ` (one item of ${s.iterates})` : ''}`);
        break;
      case 'literal':
        L.push(`← written in the code at ${fileLine(s.file, s.line)}: ${s.text}`);
        break;
      case 'lost':
        L.push(`← ${s.note}`);
        break;
      case 'network':
        L.push(`← ${s.method} ${s.url}${s.status ? ` (${s.status}${s.mocked ? ', mocked' : ''})` : ''} → ${s.path}`);
        break;
      case 'storage':
        L.push(`← ${s.area}["${s.key}"] → ${s.path}`);
        break;
      case 'url':
        L.push(`← the URL: ${s.where}`);
        break;
      default:
        break;
    }
  }
  if (!trace.found && trace.note) L.push(trace.note);
  return L.join('\n');
}


