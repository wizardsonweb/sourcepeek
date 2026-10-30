// "Storage": what a component keeps in the browser, and everything the page keeps there.
//  • From the code — the backend scans the component and the hooks / modules it imports for localStorage /
//    sessionStorage keys (getItem, useLocalStorage, zustand persist, redux-persist …) and Cache Storage caches.
//  • Live — Storage.prototype and the Cache Storage API are wrapped from the moment Sourcepeek loads, so every read and
//    write is recorded with its call stack. A key counts for the component when a stack goes through its file.
// Values can be viewed, copied, edited and removed. Sourcepeek's own keys ("sourcepeek:…") are never shown or touched.
// Values that look like secrets (key names like token / password, JWTs) are masked until "Show secrets" is on.

import { el, api, copy, openSource, fileLine } from './core.js';
import { stackHasFile } from './network.js';
import { isSecretKey, redactText } from './report.js';
import { reloadPage } from './mocks.js';

const OWN = /^sourcepeek[:\-]/;
const MAX_STACKS = 6;
const STACK_EVERY_MS = 250; // a key read in a render loop gets a fresh stack at most this often
const MAX_LINES = 400;
const MAX_ROWS = 200;
const MAX_BODY = 64 * 1024;
const TEXTUAL = /json|text|xml|javascript|csv|yaml|svg/i;
const JWT = /^(Bearer\s+)?eyJ[\w-]+\.[\w-]+\.[\w-]*$/;
const AREAS = { local: 'Local storage', session: 'Session storage', cache: 'Cache Storage' };

// ---------- live capture ----------

const cap = { installed: false, orig: {}, entries: new Map(), listeners: new Set(), names: new WeakMap(), local: null, session: null };

function notify(entry) {
  for (const fn of cap.listeners) {
    try {
      fn(entry);
    } catch {}
  }
}

function onStorageOp(fn) {
  cap.listeners.add(fn);
  return () => cap.listeners.delete(fn);
}

function areaOf(store) {
  if (store && store === cap.local) return 'local';
  if (store && store === cap.session) return 'session';
  return null;
}

/** Remember one operation: counts per op, the last few distinct call stacks (for attribution), and for caches the URLs. */
function record(area, key, op, url) {
  if (!area || key == null) return;
  key = String(key);
  if (OWN.test(key)) return;
  const id = area + '\u0000' + key;
  let e = cap.entries.get(id);
  if (!e) {
    e = { id, area, key, ops: { read: 0, write: 0, remove: 0, clear: 0 }, last: 0, lastOp: null, stacks: [], stackAt: 0, urls: [] };
    cap.entries.set(id, e);
  }
  e.ops[op] = (e.ops[op] || 0) + 1;
  const now = Date.now();
  e.last = now;
  e.lastOp = op;
  if (url && !e.urls.includes(url)) {
    e.urls.push(url);
    if (e.urls.length > 30) e.urls.shift();
  }
  if (now - e.stackAt > STACK_EVERY_MS || e.stacks.length < 2) {
    e.stackAt = now;
    let s = '';
    try {
      s = new Error().stack || '';
    } catch {}
    if (s && !e.stacks.includes(s)) {
      e.stacks.push(s);
      if (e.stacks.length > MAX_STACKS) e.stacks.shift();
    }
  }
  notify(e);
}

function urlOfRequest(r) {
  try {
    const u = typeof Request !== 'undefined' && r instanceof Request ? r.url : String(r);
    return new URL(u, location.href).href;
  } catch {
    return String(r);
  }
}

function wrap(proto, name, store, make) {
  const orig = proto[name];
  if (typeof orig !== 'function' || orig.__sourcepeek) return;
  const w = make(orig);
  w.__sourcepeek = true;
  store[name] = orig;
  proto[name] = w;
}

function installWebStorage() {
  const S = window.Storage;
  if (!S || !S.prototype) return;
  try {
    cap.local = window.localStorage;
  } catch {}
  try {
    cap.session = window.sessionStorage;
  } catch {}
  const o = (cap.orig.storage = {});
  const ops = { getItem: 'read', setItem: 'write', removeItem: 'remove' };
  for (const [name, op] of Object.entries(ops)) {
    wrap(S.prototype, name, o, (orig) =>
      function (key) {
        try {
          record(areaOf(this), key, op);
        } catch {}
        return orig.apply(this, arguments);
      }
    );
  }
  wrap(S.prototype, 'clear', o, (orig) =>
    function () {
      try {
        record(areaOf(this), '*', 'clear');
      } catch {}
      return orig.apply(this, arguments);
    }
  );
}

function installCacheStorage() {
  const CS = window.CacheStorage;
  const C = window.Cache;
  if (!CS || !C || typeof window.caches === 'undefined') return;
  const o = (cap.orig.caches = {});
  wrap(CS.prototype, 'open', o, (orig) =>
    function (name) {
      try {
        record('cache', name, 'read');
      } catch {}
      return orig.apply(this, arguments).then((cache) => {
        try {
          cap.names.set(cache, String(name));
        } catch {}
        return cache;
      });
    }
  );
  wrap(CS.prototype, 'delete', o, (orig) =>
    function (name) {
      try {
        record('cache', name, 'remove');
      } catch {}
      return orig.apply(this, arguments);
    }
  );
  wrap(CS.prototype, 'match', o, (orig) =>
    function (req, opts) {
      try {
        record('cache', (opts && opts.cacheName) || '*', 'read', urlOfRequest(req));
      } catch {}
      return orig.apply(this, arguments);
    }
  );
  const co = (cap.orig.cache = {});
  const cacheOps = { match: 'read', matchAll: 'read', put: 'write', add: 'write', addAll: 'write', delete: 'remove' };
  for (const [name, op] of Object.entries(cacheOps)) {
    wrap(C.prototype, name, co, (orig) =>
      function (req) {
        try {
          const cacheName = cap.names.get(this) || '?';
          const urls = name === 'addAll' && Array.isArray(req) ? req.map(urlOfRequest) : req != null ? [urlOfRequest(req)] : [];
          if (!urls.length) record('cache', cacheName, op);
          for (const u of urls) record('cache', cacheName, op, u);
        } catch {}
        return orig.apply(this, arguments);
      }
    );
  }
}

/** Start recording as early as possible (module load), so keys read on first render are caught. */
export function installStorageCapture() {
  if (cap.installed || typeof window === 'undefined') return;
  cap.installed = true;
  try {
    installWebStorage();
  } catch {}
  try {
    installCacheStorage();
  } catch {}
}

/** Put the original methods back (no backend, or Sourcepeek unmounted). */
export function uninstallStorageCapture() {
  if (!cap.installed || typeof window === 'undefined') return;
  cap.installed = false;
  const restore = (proto, store) => {
    if (!proto || !store) return;
    for (const [k, fn] of Object.entries(store)) if (proto[k] && proto[k].__sourcepeek) proto[k] = fn;
  };
  try {
    restore(window.Storage && window.Storage.prototype, cap.orig.storage);
    restore(window.CacheStorage && window.CacheStorage.prototype, cap.orig.caches);
    restore(window.Cache && window.Cache.prototype, cap.orig.cache);
  } catch {}
  cap.orig = {};
  cap.entries.clear();
}

// ---------- raw access (never recorded) ----------

const rawFn = (proto, store, name) => (store && store[name]) || (proto && proto[name]);

const raw = {
  store(area) {
    try {
      return area === 'session' ? window.sessionStorage : window.localStorage;
    } catch {
      return null;
    }
  },
  get(area, key) {
    const s = raw.store(area);
    if (!s) return null;
    try {
      return rawFn(Storage.prototype, cap.orig.storage, 'getItem').call(s, key);
    } catch {
      return null;
    }
  },
  set(area, key, value) {
    const s = raw.store(area);
    const old = raw.get(area, key);
    rawFn(Storage.prototype, cap.orig.storage, 'setItem').call(s, key, value);
    announce(s, key, old, value);
  },
  remove(area, key) {
    const s = raw.store(area);
    const old = raw.get(area, key);
    rawFn(Storage.prototype, cap.orig.storage, 'removeItem').call(s, key);
    announce(s, key, old, null);
  },
  keys(area) {
    const s = raw.store(area);
    const out = [];
    if (!s) return out;
    try {
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k != null && !OWN.test(k)) out.push(k);
      }
    } catch {}
    return out.sort((a, b) => a.localeCompare(b));
  },
  async cacheNames() {
    if (typeof caches === 'undefined') return [];
    try {
      return await rawFn(CacheStorage.prototype, cap.orig.caches, 'keys').call(caches);
    } catch {
      return [];
    }
  },
  async open(name) {
    return rawFn(CacheStorage.prototype, cap.orig.caches, 'open').call(caches, name);
  },
  async cacheEntries(name) {
    try {
      const c = await raw.open(name);
      const reqs = await rawFn(Cache.prototype, null, 'keys').call(c);
      return reqs.map((r) => ({ url: r.url, method: r.method, req: r }));
    } catch {
      return [];
    }
  },
  async cacheMatch(name, req) {
    const c = await raw.open(name);
    return rawFn(Cache.prototype, cap.orig.cache, 'match').call(c, req);
  },
  async cacheDeleteEntry(name, req) {
    const c = await raw.open(name);
    return rawFn(Cache.prototype, cap.orig.cache, 'delete').call(c, req);
  },
  async cacheDelete(name) {
    return rawFn(CacheStorage.prototype, cap.orig.caches, 'delete').call(caches, name);
  },
};

/**
 * Tell the app a key changed. Browsers only fire "storage" in *other* tabs; dispatching it here makes hooks that
 * listen for it (usehooks-ts, VueUse, @uidotdev, Mantine …) pick up an edit without a reload.
 */
function announce(storageArea, key, oldValue, newValue) {
  try {
    window.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue, storageArea, url: location.href }));
  } catch {}
}

// ---------- helpers ----------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `recent:{userId}` → /^recent:.+$/ */
function keyPattern(key) {
  let src = '';
  for (const part of String(key).split(/(\{[^}]*\})/)) src += /^\{.*\}$/.test(part) ? '.+?' : escapeRe(part);
  return new RegExp('^' + src + '$');
}

function size(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function pretty(text) {
  if (text == null) return '';
  try {
    const v = JSON.parse(text);
    if (v !== null && typeof v === 'object') return JSON.stringify(v, null, 2);
  } catch {}
  return String(text);
}

function describe(value) {
  if (value == null) return 'not set';
  try {
    const v = JSON.parse(value);
    if (Array.isArray(v)) return `JSON array · ${v.length} item${v.length === 1 ? '' : 's'}`;
    if (v !== null && typeof v === 'object') {
      const n = Object.keys(v).length;
      return `JSON object · ${n} key${n === 1 ? '' : 's'}`;
    }
    return `JSON ${v === null ? 'null' : typeof v}`;
  } catch {}
  return 'text';
}

function clipLines(text) {
  const lines = String(text).split('\n');
  return lines.length > MAX_LINES ? lines.slice(0, MAX_LINES).join('\n') + `\n… ${lines.length - MAX_LINES} more lines (copy to get everything)` : text;
}

function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/** Whole value is a secret (masked), or a JSON value with secret fields (those fields redacted), or nothing to hide. */
function secrecy(key, value) {
  if (value == null) return 'none';
  if (isSecretKey(key) || JWT.test(String(value).trim()) || JWT.test(String(value).replace(/^"|"$/g, '').trim())) return 'all';
  const red = redactText(value);
  return red !== pretty(value) && red !== value ? 'fields' : 'none';
}

function shortUrl(href) {
  try {
    const u = new URL(href);
    return (u.origin === location.origin ? '' : u.host) + u.pathname + u.search;
  } catch {
    return href;
  }
}

function smallBtn(text, title, onClick, cls) {
  const b = el('button', 'mf-net-btn' + (cls ? ' ' + cls : ''), text);
  b.type = 'button';
  if (title) b.title = title;
  b.onclick = onClick;
  return b;
}

function areaBadge(area) {
  return el('span', `mf-st-area mf-st-area--${area}`, area === 'local' ? 'LOCAL' : area === 'session' ? 'SESSION' : 'CACHE');
}

function opsText(e) {
  if (!e) return '';
  const parts = [];
  if (e.ops.read) parts.push(`read ${e.ops.read}×`);
  if (e.ops.write) parts.push(`written ${e.ops.write}×`);
  if (e.ops.remove) parts.push(`removed ${e.ops.remove}×`);
  if (e.ops.clear) parts.push(`cleared ${e.ops.clear}×`);
  return parts.join(' · ');
}

const keepKeys = (n) => ['keydown', 'keyup', 'keypress'].forEach((t) => n.addEventListener(t, (ev) => ev.stopPropagation()));

// ---------- UI ----------

/**
 * Fill the Storage accordion body. ctx: { file, componentName, onCount }.
 * Returns a cleanup function (stops live updates).
 */
export function buildStorage(box, ctx) {
  const ui = { open: new Set(), editors: new Map(), reveal: false, filter: '', dirty: false, confirm: null, cacheBodies: new Map() };
  const compFile = ctx.file;
  let scan = null;
  let scanError = null;
  let cacheSnap = []; // [{ name, entries: [{ url, method, req }] }]
  let estimate = null;
  let timer = null;

  // toolbar
  const toolbar = el('div', 'mf-net-toolbar');
  const summary = el('div', 'mf-muted mf-net-summary', 'Scanning the component…');
  const revealLabel = el('label', 'mf-net-check');
  const revealBox = el('input');
  revealBox.type = 'checkbox';
  revealBox.onchange = () => {
    ui.reveal = revealBox.checked;
    render();
  };
  revealLabel.title = 'Values that look like tokens, passwords or JWTs are hidden by default';
  revealLabel.append(revealBox, document.createTextNode(' show secrets'));
  const refresh = smallBtn('Refresh', 'Scan the source again and re-read storage', () => load());
  toolbar.append(summary, revealLabel, refresh);

  const switcher = el('div', 'mf-st-switch');
  const filter = el('input', 'mf-style-input mf-st-filter');
  filter.type = 'search';
  filter.placeholder = 'Filter keys…';
  filter.oninput = () => {
    ui.filter = filter.value.trim().toLowerCase();
    render();
  };
  keepKeys(filter);
  switcher.append(filter);

  const reloadBar = el('div', 'mf-st-reload');
  reloadBar.hidden = true;
  reloadBar.append(
    el('span', null, 'Storage changed. Apps that read it only on load need a reload to see it.'),
    smallBtn('Reload page', 'Storage survives the reload', reloadPage, 'mf-net-btn--primary')
  );

  const list = el('div', 'mf-net-list');
  box.append(toolbar, switcher, reloadBar, list);

  function changed() {
    ui.dirty = true;
    render();
  }

  // ----- model -----

  const fromComponent = (e) => e.stacks.some((s) => stackHasFile(s, compFile));

  /** Rows for the component view: keys from the code (patterns expanded to real keys) + keys captured live. */
  function componentRows() {
    const rows = new Map();
    const add = (area, key, patch) => {
      const id = area + '\u0000' + key;
      let r = rows.get(id);
      if (!r) {
        r = { id, area, key, refs: [], live: cap.entries.get(id) || null, pattern: null };
        rows.set(id, r);
      }
      if (patch) Object.assign(r, patch);
      return r;
    };
    const existing = { local: raw.keys('local'), session: raw.keys('session'), cache: cacheSnap.map((c) => c.name) };
    const groups = new Map();
    for (const k of scan ? scan.keys : []) {
      const gid = k.area + '\u0000' + k.key;
      if (!groups.has(gid)) groups.set(gid, { area: k.area, key: k.key, dynamic: k.dynamic, refs: [] });
      groups.get(gid).refs.push(k);
    }
    for (const g of groups.values()) {
      if (g.key === '*') {
        add(g.area, '*', { all: true }).refs.push(...g.refs);
        continue;
      }
      if (!g.dynamic) {
        add(g.area, g.key).refs.push(...g.refs);
        continue;
      }
      const re = keyPattern(g.key);
      const live = [...cap.entries.values()].filter((e) => e.area === g.area && re.test(e.key)).map((e) => e.key);
      const matches = [...new Set([...existing[g.area].filter((k) => re.test(k)), ...live])];
      if (!matches.length) add(g.area, g.key, { pattern: g.key }).refs.push(...g.refs);
      for (const m of matches) add(g.area, m, { pattern: g.key }).refs.push(...g.refs);
    }
    for (const e of cap.entries.values()) {
      if (e.key === '*' || !fromComponent(e)) continue;
      const r = add(e.area, e.key);
      r.live = e;
      r.liveFromHere = true;
    }
    for (const r of rows.values()) if (r.live && fromComponent(r.live)) r.liveFromHere = true;
    const order = { local: 0, session: 1, cache: 2 };
    return [...rows.values()].sort((a, b) => order[a.area] - order[b.area] || Number(Boolean(a.all)) - Number(Boolean(b.all)) || a.key.localeCompare(b.key));
  }

  function pageRows(area) {
    if (area === 'cache') return cacheSnap.map((c) => ({ id: 'cache\u0000' + c.name, area, key: c.name, refs: [], live: cap.entries.get('cache\u0000' + c.name) || null }));
    return raw.keys(area).map((k) => ({ id: area + '\u0000' + k, area, key: k, refs: [], live: cap.entries.get(area + '\u0000' + k) || null }));
  }

  const matchesFilter = (r) => !ui.filter || r.key.toLowerCase().includes(ui.filter) || (r.area !== 'cache' && String(raw.get(r.area, r.key) || '').toLowerCase().includes(ui.filter));

  // ----- render -----

  function render() {
    if (!box.isConnected && box.dataset.mfRendered) return cleanup();
    box.dataset.mfRendered = '1';
    list.textContent = '';
    reloadBar.hidden = !ui.dirty;
    if (!scan && !scanError) return;
    const comp = componentRows();
    const realComp = comp.filter((r) => !r.all);
    if (ctx.onCount) ctx.onCount(realComp.length);

    if (scanError) summary.textContent = scanError;
    else {
      const inCode = new Set((scan ? scan.keys : []).filter((k) => k.key !== '*').map((k) => k.area + k.key)).size;
      const used = realComp.filter((r) => r.liveFromHere).length;
      summary.textContent = `${inCode} in code · ${used} used live on this page`;
      summary.title = scan && scan.files.length ? 'Scanned:\n' + scan.files.join('\n') : '';
    }

    // Everything the page stores; keys the component's code uses (or that it touched live) come first in each area.
    const compById = new Map(comp.map((r) => [r.id, r]));
    if (estimate && estimate.usage != null) {
      const q = estimate.quota ? ` of ${size(estimate.quota)} available` : '';
      list.appendChild(el('div', 'mf-net-hint', `Cache Storage, IndexedDB and other origin storage: ${size(estimate.usage)} used${q}.`));
    }
    for (const area of ['local', 'session', 'cache']) {
      const stored = pageRows(area);
      const rows = [...comp.filter((r) => r.area === area), ...stored.filter((r) => !compById.has(r.id))];
      const shown = rows.filter(matchesFilter);
      // Counts, Copy as JSON and Clear all cover what is actually stored, not keys that only appear in the code.
      list.appendChild(groupHead(area, stored));
      if (!rows.length) list.appendChild(el('div', 'mf-muted mf-st-none', area === 'cache' ? 'No caches.' : 'Empty.'));
      else if (!shown.length) list.appendChild(el('div', 'mf-muted mf-st-none', 'Nothing matches the filter.'));
      for (const r of shown.slice(0, MAX_ROWS)) list.appendChild(area === 'cache' ? cacheCard(r) : keyCard(r));
      if (shown.length > MAX_ROWS) list.appendChild(el('div', 'mf-net-hint', `…${shown.length - MAX_ROWS} more — use the filter.`));
    }
  }

  function groupHead(area, rows) {
    const head = el('div', 'mf-st-group');
    let bytes = 0;
    if (area !== 'cache') for (const r of rows) bytes += r.key.length + String(raw.get(area, r.key) || '').length;
    const count = area === 'cache' ? `${rows.length} cache${rows.length === 1 ? '' : 's'}` : `${rows.length} key${rows.length === 1 ? '' : 's'} · ${size(bytes)}`;
    head.append(el('span', 'mf-subtitle', AREAS[area]), el('span', 'mf-muted', count));
    const actions = el('span', 'mf-st-group-actions');
    if (area !== 'cache' && rows.length) {
      actions.appendChild(
        smallBtn('Copy as JSON', ui.reveal ? 'All keys and values' : 'All keys and values — secrets redacted unless “show secrets” is on', (ev) => {
          const out = {};
          for (const r of rows) {
            const v = raw.get(area, r.key);
            const sec = secrecy(r.key, v);
            out[r.key] = !ui.reveal && sec === 'all' ? '[redacted]' : !ui.reveal && sec === 'fields' ? safeParse(redactText(v)) : safeParse(v);
          }
          copy(JSON.stringify(out, null, 2), ev.currentTarget);
        })
      );
    }
    if (rows.length) {
      const armed = ui.confirm === 'clear:' + area;
      const b = smallBtn(
        armed ? 'Click again to clear' : area === 'cache' ? 'Delete all' : 'Clear all',
        area === 'cache' ? 'Delete every cache of this origin' : `Remove every key from ${AREAS[area].toLowerCase()} (Sourcepeek’s own settings are kept)`,
        async () => {
          if (ui.confirm !== 'clear:' + area) {
            ui.confirm = 'clear:' + area;
            render();
            setTimeout(() => {
              if (ui.confirm === 'clear:' + area) {
                ui.confirm = null;
                render();
              }
            }, 4000);
            return;
          }
          ui.confirm = null;
          if (area === 'cache') {
            for (const c of cacheSnap) await raw.cacheDelete(c.name).catch(() => {});
            await loadCaches();
          } else for (const r of rows) raw.remove(area, r.key);
          changed();
        },
        'mf-net-btn--danger'
      );
      actions.appendChild(b);
    }
    head.appendChild(actions);
    return head;
  }

  function sourceRefs(r) {
    const meta = el('div', 'mf-net-meta');
    const seen = new Set();
    for (const ref of r.refs) {
      const k = ref.file + ':' + ref.line;
      if (seen.has(k)) continue;
      seen.add(k);
      const line = el('div', 'mf-st-ref');
      line.appendChild(el('code', 'mf-net-fn', ref.lib));
      if (ref.url) line.appendChild(el('code', 'mf-st-url', shortUrl(ref.url)));
      line.appendChild(el('span', 'mf-muted', ref.fn ? `in ${ref.fn}()` : ''));
      const src = el('button', 'mf-linkbtn', fileLine(ref.file, ref.line));
      src.type = 'button';
      src.title = 'Open in editor';
      src.onclick = () => openSource(ref.file, ref.line);
      line.appendChild(src);
      meta.appendChild(line);
    }
    if (r.pattern && r.pattern !== r.key) meta.appendChild(el('div', 'mf-net-hint', `Matches the key pattern ${r.pattern} from the code.`));
    if (r.live) {
      const where = r.liveFromHere ? `Captured live from ${ctx.componentName}` : r.refs.length ? 'Captured live (from elsewhere on the page)' : 'Captured live';
      meta.appendChild(el('div', 'mf-muted', `${where} · ${opsText(r.live)}, last ${ago(r.live.last)}`));
    } else if (r.refs.length && !r.all) meta.appendChild(el('div', 'mf-muted', 'Not touched on this page yet.'));
    return meta;
  }

  function keyCard(r) {
    const value = r.all ? null : raw.get(r.area, r.key);
    const d = el('details', 'mf-net-item');
    d.open = ui.open.has(r.id);
    d.ontoggle = () => (d.open ? ui.open.add(r.id) : ui.open.delete(r.id));
    const sum = el('summary', 'mf-net-head');
    const label = r.all ? (r.refs.some((x) => x.op === 'clear') ? 'all keys (clear)' : 'all keys') : r.key;
    const k = el('code', 'mf-net-url', label);
    k.title = r.key;
    const chip = el('span', 'mf-net-status' + (value == null && !r.all ? ' mf-net-status--idle' : ''), r.all ? '' : value == null ? 'not set' : size(r.key.length + value.length));
    sum.append(areaBadge(r.area), k);
    const sec = secrecy(r.key, value);
    if (sec !== 'none') {
      const s = el('span', 'mf-st-secret', 'secret');
      s.title = 'Looks like a token or password — masked unless “show secrets” is on';
      sum.appendChild(s);
    }
    sum.appendChild(chip);
    d.appendChild(sum);

    const body = el('div', 'mf-net-body');
    if (r.refs.length || r.live || r.pattern) body.appendChild(sourceRefs(r));
    if (r.all) {
      body.appendChild(el('div', 'mf-net-hint', r.refs.some((x) => x.op === 'clear') ? `Clears every key in ${AREAS[r.area].toLowerCase()}.` : `Reads keys by index (${AREAS[r.area].toLowerCase()}.key(i)) — which keys depends on what is stored.`));
      d.appendChild(body);
      return d;
    }

    // value
    const vs = el('div', 'mf-net-sec');
    const vh = el('div', 'mf-net-sec-head');
    vh.append(el('span', 'mf-subtitle', 'Value'), el('span', 'mf-net-tag', describe(value)));
    vs.appendChild(vh);
    if (value == null) vs.appendChild(el('div', 'mf-muted', r.pattern === r.key ? 'No key matching this pattern is stored right now.' : 'Not stored right now.'));
    else if (sec === 'all' && !ui.reveal) {
      const masked = el('div', 'mf-st-masked', '•'.repeat(Math.min(24, Math.max(8, value.length))));
      const show = smallBtn('Show', 'Reveal this value', () => {
        masked.replaceWith(el('pre', 'mf-net-pre', clipLines(pretty(value))));
        show.remove();
      });
      const row = el('div', 'mf-st-masked-row');
      row.append(masked, show);
      vs.appendChild(row);
    } else {
      vs.appendChild(el('pre', 'mf-net-pre', clipLines(sec === 'fields' && !ui.reveal ? redactText(value) : pretty(value))));
      if (sec === 'fields' && !ui.reveal) vs.appendChild(el('div', 'mf-net-hint', 'Fields that look like secrets are shown as [redacted].'));
    }
    body.appendChild(vs);

    // actions
    const actions = el('div', 'mf-net-actions');
    if (value != null) {
      const cb = smallBtn('Copy value', 'Copies the real value, secrets included', () => copy(pretty(value), cb));
      cb.classList.add('mf-net-btn--primary');
      actions.appendChild(cb);
    }
    const kb = smallBtn('Copy key', null, () => copy(r.key, kb));
    actions.appendChild(kb);
    const editable = !(r.pattern === r.key && /\{[^}]*\}/.test(r.key));
    if (editable) {
      actions.appendChild(
        smallBtn(value == null ? 'Set value' : 'Edit', value == null ? 'Store a value under this key' : 'Change the stored value', () => {
          const ed = ui.editors.get(r.id);
          if (ed && ed.isConnected) {
            ui.editors.delete(r.id);
            ed.remove();
            return;
          }
          const editor = valueEditor(r, value);
          ui.editors.set(r.id, editor);
          actions.after(editor);
          editor.querySelector('textarea').focus();
        })
      );
    }
    if (value != null) {
      actions.appendChild(
        smallBtn('Remove', `Delete this key from ${AREAS[r.area].toLowerCase()}`, () => {
          raw.remove(r.area, r.key);
          ui.editors.delete(r.id);
          changed();
        }, 'mf-net-btn--danger')
      );
    }
    body.appendChild(actions);
    const openEditor = ui.editors.get(r.id);
    if (openEditor) body.appendChild(openEditor);
    d.appendChild(body);
    return d;
  }

  function valueEditor(r, value) {
    const wrap = el('div', 'mf-mock-editor mf-st-editor');
    wrap.appendChild(el('div', 'mf-subtitle', value == null ? 'New value' : 'Edit value'));
    const ta = el('textarea', 'mf-style-input mf-mock-body');
    ta.rows = 8;
    ta.spellcheck = false;
    ta.value = value == null ? '' : pretty(value);
    keepKeys(ta);
    const warn = el('div', 'mf-style-warn');
    warn.hidden = true;
    const wasJson = value != null && safeParse(value) !== value;
    const btns = el('div', 'mf-net-actions');
    const save = smallBtn('Save', 'Writes the value and tells the page (a "storage" event); reload if the page doesn’t update', () => {
      let out = ta.value;
      if (wasJson) {
        try {
          // keep the compact form the app wrote, so nothing but the value changes
          out = JSON.stringify(JSON.parse(ta.value));
        } catch (err) {
          if (warn.hidden || warn.dataset.ok !== ta.value) {
            warn.hidden = false;
            warn.dataset.ok = ta.value;
            warn.textContent = `Not valid JSON (${err.message}) — the app may fail to parse it. Click Save again to store it anyway.`;
            return;
          }
        }
      }
      try {
        raw.set(r.area, r.key, out);
      } catch (err) {
        warn.hidden = false;
        warn.textContent = `Could not save: ${(err && err.message) || err}`;
        return;
      }
      ui.editors.delete(r.id);
      ui.open.add(r.id);
      changed();
    });
    save.classList.add('mf-net-btn--primary');
    btns.append(
      save,
      smallBtn('Cancel', null, () => {
        ui.editors.delete(r.id);
        wrap.remove();
      })
    );
    wrap.append(ta, warn, btns);
    return wrap;
  }

  function cacheCard(r) {
    const snap = cacheSnap.find((c) => c.name === r.key);
    const d = el('details', 'mf-net-item');
    d.open = ui.open.has(r.id);
    d.ontoggle = () => (d.open ? ui.open.add(r.id) : ui.open.delete(r.id));
    const sum = el('summary', 'mf-net-head');
    const label = r.all ? 'any cache' : r.key;
    sum.append(areaBadge('cache'), el('code', 'mf-net-url', label));
    sum.appendChild(el('span', 'mf-net-status' + (snap || r.all ? '' : ' mf-net-status--idle'), r.all ? '' : snap ? `${snap.entries.length} entr${snap.entries.length === 1 ? 'y' : 'ies'}` : 'not created'));
    d.appendChild(sum);
    const body = el('div', 'mf-net-body');
    if (r.refs.length || r.live) body.appendChild(sourceRefs(r));
    if (r.all) {
      body.appendChild(el('div', 'mf-net-hint', 'caches.match() looks in every cache of this origin.'));
      d.appendChild(body);
      return d;
    }
    if (!snap) {
      body.appendChild(el('div', 'mf-muted', 'This cache doesn’t exist right now (it is created by caches.open).'));
      d.appendChild(body);
      return d;
    }
    const touched = new Set(r.live ? r.live.urls : []);
    const entries = snap.entries.filter((x) => !ui.filter || x.url.toLowerCase().includes(ui.filter) || r.key.toLowerCase().includes(ui.filter));
    if (!snap.entries.length) body.appendChild(el('div', 'mf-muted', 'Empty cache.'));
    const elist = el('div', 'mf-st-entries');
    for (const x of entries.slice(0, MAX_ROWS)) elist.appendChild(cacheEntry(r.key, x, touched.has(x.url)));
    if (entries.length > MAX_ROWS) elist.appendChild(el('div', 'mf-net-hint', `…${entries.length - MAX_ROWS} more — use the filter.`));
    body.appendChild(elist);
    const actions = el('div', 'mf-net-actions');
    const armed = ui.confirm === 'cache:' + r.key;
    actions.appendChild(
      smallBtn(armed ? 'Click again to delete' : 'Delete cache', 'caches.delete() — a service worker may create it again', async () => {
        if (!armed) {
          ui.confirm = 'cache:' + r.key;
          render();
          return;
        }
        ui.confirm = null;
        await raw.cacheDelete(r.key).catch(() => {});
        await loadCaches();
        changed();
      }, 'mf-net-btn--danger')
    );
    body.appendChild(actions);
    d.appendChild(body);
    return d;
  }

  function cacheEntry(name, x, touched) {
    const id = 'entry\u0000' + name + '\u0000' + x.method + ' ' + x.url;
    const d = el('details', 'mf-st-entry');
    d.open = ui.open.has(id);
    const sum = el('summary', 'mf-st-entry-head');
    const u = el('code', 'mf-net-url', shortUrl(x.url));
    u.title = x.url;
    sum.append(el('span', 'mf-st-method', x.method), u);
    if (touched) {
      const t = el('span', 'mf-net-tag', 'used');
      t.title = 'Read or written on this page since it loaded';
      sum.appendChild(t);
    }
    d.appendChild(sum);
    const holder = el('div', 'mf-st-entry-body');
    d.appendChild(holder);
    const fill = () => {
      holder.textContent = '';
      const info = ui.cacheBodies.get(id);
      if (!info) return holder.appendChild(el('div', 'mf-muted', 'Loading…'));
      if (info.error) return holder.appendChild(el('div', 'mf-muted', info.error));
      holder.appendChild(el('div', 'mf-net-hint', [info.status, info.type, info.length != null ? size(info.length) : null, info.date ? `cached ${info.date}` : null].filter(Boolean).join(' · ')));
      if (info.body) holder.appendChild(el('pre', 'mf-net-pre', clipLines(info.body)));
      else holder.appendChild(el('div', 'mf-muted', info.body === '' || !info.type ? 'Empty body' : `${info.type} — not shown`));
      const a = el('div', 'mf-net-actions');
      if (info.body) {
        const cb = smallBtn('Copy response', null, () => copy(info.body, cb));
        a.appendChild(cb);
      }
      const op = smallBtn('Open', 'Open the URL in a new tab (goes to the network or service worker)', () => window.open(x.url, '_blank', 'noopener'));
      a.appendChild(op);
      a.appendChild(
        smallBtn('Delete entry', null, async () => {
          await raw.cacheDeleteEntry(name, x.req).catch(() => {});
          ui.cacheBodies.delete(id);
          await loadCaches();
          changed();
        }, 'mf-net-btn--danger')
      );
      holder.appendChild(a);
    };
    d.ontoggle = async () => {
      if (!d.open) return ui.open.delete(id);
      ui.open.add(id);
      fill();
      if (ui.cacheBodies.has(id)) return;
      try {
        const res = await raw.cacheMatch(name, x.req);
        if (!res) ui.cacheBodies.set(id, { error: 'Entry is gone.' });
        else {
          const type = res.headers.get('content-type') || '';
          const len = Number(res.headers.get('content-length')) || null;
          let body = null;
          let length = len;
          if (TEXTUAL.test(type) && (!len || len < 5e6)) {
            const t = await res.text();
            length = length || t.length;
            body = t.length > MAX_BODY ? t.slice(0, MAX_BODY) + '\n… truncated' : pretty(t);
          }
          ui.cacheBodies.set(id, { status: res.type === 'opaque' ? 'opaque (cross-origin)' : String(res.status), type, length, body, date: res.headers.get('date') });
        }
      } catch (err) {
        ui.cacheBodies.set(id, { error: `Could not read: ${(err && err.message) || err}` });
      }
      if (d.isConnected) fill();
    };
    if (d.open) fill();
    return d;
  }

  // ----- data -----

  async function loadCaches() {
    const names = await raw.cacheNames();
    const snap = [];
    for (const name of names) snap.push({ name, entries: await raw.cacheEntries(name) });
    cacheSnap = snap;
  }

  async function loadEstimate() {
    try {
      if (navigator.storage && navigator.storage.estimate) estimate = await navigator.storage.estimate();
    } catch {}
  }

  async function load() {
    summary.textContent = 'Scanning the component…';
    const [res] = await Promise.all([api('/storage', { file: ctx.file }), loadCaches(), loadEstimate()]);
    if (res.ok) {
      scan = res.data;
      scanError = null;
    } else {
      scan = { keys: [], files: [] };
      scanError = `Could not scan the source: ${res.error}. Showing live reads/writes only.`;
    }
    render();
  }

  // Throttled, not debounced: a key read on every frame must not keep pushing the update back.
  let needCaches = false;
  const schedule = (caches) => {
    needCaches = needCaches || caches;
    if (timer) return;
    timer = setTimeout(async () => {
      timer = null;
      if (needCaches) {
        needCaches = false;
        await loadCaches();
      }
      render();
    }, 150);
  };

  const unsubscribe = onStorageOp((e) => {
    if (!box.isConnected) return cleanup();
    // Re-render for writes anywhere (values change) and for anything this component does.
    if (e.lastOp !== 'read' || fromComponent(e)) schedule(e.area === 'cache' && e.lastOp !== 'read');
  });
  // Changes made in another tab of the same origin.
  const onOtherTab = () => schedule(false);
  window.addEventListener('storage', onOtherTab);

  function cleanup() {
    clearTimeout(timer);
    unsubscribe();
    window.removeEventListener('storage', onOtherTab);
  }

  load();
  return cleanup;
}

function safeParse(v) {
  if (v == null) return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}
