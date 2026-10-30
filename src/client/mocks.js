// Request mocks, created with "Mock this" on a request in Network.
//
// Mocks are answered by the fetch / XMLHttpRequest wrappers in network.js, so they keep working after the panel
// is closed. That is easy to forget, so while any mock is active a bar at the bottom of the page says so, with
// "Clear all", plus "Reload to apply" while a mock waits on the page. Removing a mock that already answered reloads the page, so the real data comes back.
// Mocks live in sessionStorage: they survive a reload of this tab, but a new tab starts clean.

import { el, getState } from './core.js';

const KEY = 'sourcepeek:mocks';
// `waiting`: GET mocks saved for data the page already loaded, that no request has used yet (id → saved at).
// The page only shows the mock once it asks again, so the bar offers a reload until then.
const store = { list: load(), listeners: new Set(), barOpen: false, waiting: new Map() };
const GRACE = 1500;

function load() {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter((m) => m && m.id && m.method && m.url) : [];
  } catch {
    return [];
  }
}

function save() {
  try {
    if (store.list.length) sessionStorage.setItem(KEY, JSON.stringify(store.list));
    else sessionStorage.removeItem(KEY);
  } catch {}
}

function changed() {
  save();
  for (const fn of store.listeners) {
    try {
      fn();
    } catch {}
  }
  renderMockBar();
}

export function onMocksChange(fn) {
  store.listeners.add(fn);
  return () => store.listeners.delete(fn);
}

export function mocks() {
  return store.list.slice();
}

export function getMock(id) {
  return store.list.find((m) => m.id === id) || null;
}

/** Add or replace (same method + URL + query) a mock. */
export function saveMock(m) {
  const mock = {
    id: m.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    method: String(m.method || 'GET').toUpperCase(),
    url: m.url,
    query: m.query || '',
    status: Number(m.status) || 200,
    body: m.body == null ? '' : String(m.body),
    contentType: m.contentType || 'application/json',
    delay: Math.max(0, Math.min(60000, Number(m.delay) || 0)),
    networkError: Boolean(m.networkError),
    hits: m.hits || 0,
    created: m.created || Date.now(),
    updated: Date.now(),
  };
  store.list = [mock, ...store.list.filter((x) => x.id !== mock.id && !(x.method === mock.method && x.url === mock.url && x.query === mock.query))];
  if (m.refetch) store.waiting.set(mock.id, Date.now());
  changed();
  if (m.refetch) nudgeRefetch();
  return mock;
}

/** True while a mock was saved for data the page already has and no request has picked it up yet. */
export function isWaiting(id) {
  return store.waiting.has(id);
}

/**
 * Ask the page to load its data again, so a new mock shows without a reload. Data libraries refetch when the
 * tab regains focus (SWR, TanStack Query, Apollo, RTK Query…), so that is what we signal. Code that fetches only
 * once on mount won't react; for that the bar offers "Reload to apply" (mocks survive the reload).
 */
export function nudgeRefetch() {
  try {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  } catch {}
  setTimeout(renderMockBar, GRACE + 50);
}

/**
 * Get a just-saved mock onto the page: ask the page to load again, and reload it if it hasn't asked within the
 * grace period (code that fetches once on mount). Mocks survive the reload.
 */
export function applyMock(id) {
  nudgeRefetch();
  setTimeout(() => {
    if (store.waiting.has(id) && store.list.some((m) => m.id === id)) reloadPage();
  }, GRACE + 100);
}

export function reloadPage() {
  location.reload();
}

/**
 * Data a mock already answered is on the page; removing the mock doesn't take it back off. So once a mock that
 * answered requests is removed, reload the page so it loads the real data again (mocks left in place survive).
 */
function reloadIfServed(removed, opts) {
  if (opts && opts.reload === false) return;
  if (removed.some((m) => (m.hits || 0) > 0)) setTimeout(reloadPage, 60);
}

export function removeMock(id, opts) {
  const removed = store.list.filter((m) => m.id === id);
  store.list = store.list.filter((m) => m.id !== id);
  store.waiting.delete(id);
  changed();
  reloadIfServed(removed, opts);
}

export function clearMocks(opts) {
  const removed = store.list;
  store.list = [];
  store.waiting.clear();
  changed();
  reloadIfServed(removed, opts);
}

// ---------- matching ----------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function urlRe(url) {
  let src = '';
  let rest = url;
  let prefix = '^';
  // `{API_URL}/users`: unknown base, match on what follows
  if (/^\{[^}]+\}/.test(rest)) {
    rest = rest.replace(/^\{[^}]+\}/, '');
    prefix = '^.*?';
  }
  for (const part of rest.split(/(\{[^}]*\})/)) src += /^\{.*\}$/.test(part) ? '[^/?#]+' : escapeRe(part);
  return new RegExp(prefix + src.replace(/\/$/, '') + '/?$');
}

/** origin + path of a URL, and its query string. */
export function splitUrl(href) {
  try {
    const u = new URL(href, location.href);
    return { base: u.origin + u.pathname, query: u.search };
  } catch {
    const [base, q] = String(href).split('?');
    return { base, query: q ? '?' + q : '' };
  }
}

export function mockMatches(m, method, href) {
  if (m.method !== '*' && m.method !== String(method || 'GET').toUpperCase()) return false;
  const { base, query } = splitUrl(href);
  if (m.query && m.query !== query) return false;
  if (m.url.includes('{')) {
    if (!m._re) Object.defineProperty(m, '_re', { value: urlRe(m.url), enumerable: false });
    return m._re.test(base);
  }
  return base.replace(/\/$/, '') === m.url.replace(/\/$/, '');
}

/** The mock that answers this request, if any. Counts the hit. */
export function findMock(method, href) {
  if (!store.list.length) return null;
  const m = store.list.find((x) => mockMatches(x, method, href)) || null;
  if (m) {
    m.hits = (m.hits || 0) + 1;
    save();
    if (store.waiting.delete(m.id)) {
      // The page picked the mock up: let Network show the new answer.
      setTimeout(() => {
        for (const fn of store.listeners) {
          try {
            fn();
          } catch {}
        }
      }, 0);
    }
    scheduleBar();
  }
  return m;
}

/** Mocks that would answer an endpoint shown in Network (no hit counted). */
export function mocksFor(method, href) {
  return store.list.filter((x) => mockMatches(x, method, href) || (x.method === String(method).toUpperCase() && x.url === splitUrl(href).base));
}

// ---------- answering ----------

const STATUS_TEXT = { 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 422: 'Unprocessable Entity', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };
const noBody = (s) => s === 204 || s === 205 || s === 304;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fetch() answer for a mock. Rejects like a real network failure when the mock says so. */
export async function mockFetchResponse(m, href) {
  if (m.delay) await wait(m.delay);
  if (m.networkError) throw new TypeError('Failed to fetch (mocked network error)');
  const status = Math.min(599, Math.max(200, m.status || 200));
  const res = new Response(noBody(status) ? null : m.body, {
    status,
    statusText: STATUS_TEXT[status] || '',
    headers: { 'content-type': m.contentType || 'text/plain', 'x-sourcepeek-mock': '1' },
  });
  try {
    Object.defineProperty(res, 'url', { value: href });
  } catch {}
  return res;
}

/** Answer an XMLHttpRequest without sending it: same properties and events as a real response. */
export function mockXhr(xhr, m, href) {
  setTimeout(() => {
    const def = (k, v) => {
      try {
        Object.defineProperty(xhr, k, { configurable: true, get: () => v });
      } catch {}
    };
    const fire = (type) => {
      let ev;
      try {
        ev = type === 'readystatechange' ? new Event(type) : new ProgressEvent(type);
      } catch {
        ev = new Event(type);
      }
      xhr.dispatchEvent(ev);
    };
    def('readyState', 4);
    if (m.networkError) {
      def('status', 0);
      def('statusText', '');
      fire('readystatechange');
      fire('error');
      fire('loadend');
      return;
    }
    const status = m.status || 200;
    const text = noBody(status) ? '' : m.body || '';
    const ct = m.contentType || 'text/plain';
    const rt = xhr.responseType;
    let response = text;
    if (rt === 'json') {
      try {
        response = JSON.parse(text);
      } catch {
        response = null;
      }
    } else if (rt === 'blob') response = new Blob([text], { type: ct });
    else if (rt === 'arraybuffer') response = new TextEncoder().encode(text).buffer;
    else if (rt === 'document') response = null;
    def('status', status);
    def('statusText', STATUS_TEXT[status] || '');
    def('responseURL', href);
    def('response', response);
    if (!rt || rt === 'text') def('responseText', text);
    const headers = { 'content-type': ct, 'x-sourcepeek-mock': '1' };
    xhr.getAllResponseHeaders = () => Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';
    xhr.getResponseHeader = (n) => headers[String(n).toLowerCase()] || null;
    fire('readystatechange');
    fire('load');
    fire('loadend');
  }, m.delay || 0);
}

// ---------- the bar ----------

let barTimer = null;
function scheduleBar() {
  clearTimeout(barTimer);
  barTimer = setTimeout(renderMockBar, 100);
}

function shortUrl(m) {
  try {
    const u = new URL(m.url);
    return (u.origin === location.origin ? '' : u.host) + u.pathname + (m.query || '');
  } catch {
    return m.url + (m.query || '');
  }
}

/** "2 mocks active · Clear all" — shown whenever a mock is active, panel open or not. */
export function renderMockBar() {
  const st = getState();
  if (!st || !st.ui || !st.ui.mockBar) return;
  const bar = st.ui.mockBar;
  bar.textContent = '';
  const list = store.list;
  if (!list.length) {
    bar.hidden = true;
    store.barOpen = false;
    return;
  }
  bar.hidden = false;
  if (store.barOpen) {
    const pop = el('div', 'mf-mockbar-list');
    for (const m of list) {
      const r = el('div', 'mf-mockbar-item');
      const what = el('code', 'mf-mockbar-url', `${m.method} ${shortUrl(m)}`);
      what.title = m.url + (m.query || '');
      const res = el('span', 'mf-mockbar-res', m.networkError ? 'network error' : `→ ${m.status}${m.delay ? ` · ${m.delay}ms` : ''}`);
      const hits = el('span', 'mf-mockbar-hits', `${m.hits || 0} hit${m.hits === 1 ? '' : 's'}`);
      const x = el('button', 'mf-mockbar-x', '×');
      x.type = 'button';
      x.title = (m.hits || 0) > 0 ? 'Stop mocking this request — the page reloads to fetch the real data' : 'Stop mocking this request';
      x.onclick = () => removeMock(m.id);
      r.append(what, res, hits, x);
      pop.appendChild(r);
    }
    bar.appendChild(pop);
  }
  const row = el('div', 'mf-mockbar-row');
  const label = el('button', 'mf-mockbar-text', `${list.length} mock${list.length === 1 ? '' : 's'} active`);
  label.type = 'button';
  label.title = store.barOpen ? 'Hide the list' : 'These requests get fake responses, even with the panel closed. Click to see them.';
  label.setAttribute('aria-expanded', String(store.barOpen));
  label.onclick = () => {
    store.barOpen = !store.barOpen;
    renderMockBar();
  };
  const clear = el('button', 'mf-mockbar-clear', 'Clear all');
  clear.type = 'button';
  clear.title = 'Remove every mock — requests go to the real server again. The page reloads so the real data replaces the mocked data.';
  clear.onclick = () => clearMocks();
  row.append(el('span', 'mf-mockbar-dot'), label);
  const now = Date.now();
  const stale = [...store.waiting.values()].some((t) => now - t >= GRACE);
  // Only when a mock is waiting on a page that won't ask again — otherwise the mocks already apply.
  if (stale) {
    const reload = el('button', 'mf-mockbar-reload', 'Reload to apply');
    reload.type = 'button';
    reload.title = 'The page loaded this data before the mock existed and hasn’t asked for it again. Mocks survive the reload.';
    reload.onclick = reloadPage;
    row.appendChild(reload);
  }
  row.appendChild(clear);
  bar.appendChild(row);
}
