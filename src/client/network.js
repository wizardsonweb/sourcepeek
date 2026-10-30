// "Network": which requests a component makes or can make.
//  • From the code — the backend scans the component and the hooks / API modules it imports
//    (method, URL, example payload, expected response from TypeScript types).
//  • Live — fetch() and XMLHttpRequest are recorded on this page, so real payloads and responses show up
//    next to the endpoint that sent them. Requests whose call stack goes through the component's file count too.
// Every request can be copied as a cURL command, and answered with a fake response ("Mock this", see mocks.js) —
// or with realistic data the AI writes in the shape of the real response ("Randomise"; random values from
// randomData.js when no AI key is set).

import { el, api, copy, openSource, fileLine, getState } from './core.js';
import { findMock, mockFetchResponse, mockXhr, mocksFor, saveMock, removeMock, getMock, onMocksChange, splitUrl, isWaiting, reloadPage, applyMock } from './mocks.js';
import { randomLike, parseJson } from './randomData.js';

const MAX_ENTRIES = 200;
const MAX_BODY = 64 * 1024;
const MAX_LINES = 400;
const IGNORE = /\/(__sourcepeek|api\/sourcepeek)(\/|$|\?)|\/@vite\/|\/@react-refresh|\/__vite_ping|\/@id\/|\/_next\/(webpack-hmr|static\/)|\.hot-update\.|\/__nextjs_|\/__webpack_hmr|\/node_modules\/|sockjs-node|\/__turbopack/;
const TEXTUAL = /json|text|xml|javascript|graphql|x-www-form-urlencoded|csv|yaml/i;
const BODY_METHODS = /^(POST|PUT|PATCH|DELETE)$/;

// ---------- live capture ----------

const cap = { installed: false, entries: [], listeners: new Set(), seq: 0, orig: {}, tag: null };

function notify(entry) {
  for (const fn of cap.listeners) {
    try {
      fn(entry);
    } catch {}
  }
}

function onRequest(fn) {
  cap.listeners.add(fn);
  return () => cap.listeners.delete(fn);
}

const clip = (t) => (t.length > MAX_BODY ? t.slice(0, MAX_BODY) : t);

function absUrl(u) {
  try {
    return new URL(u, location.href).href;
  } catch {
    return String(u);
  }
}

function headersToObject(h) {
  const out = {};
  if (!h) return out;
  try {
    if (typeof Headers !== 'undefined' && h instanceof Headers) h.forEach((v, k) => (out[k] = v));
    else if (Array.isArray(h)) for (const [k, v] of h) out[k] = String(v);
    else if (typeof h === 'object') for (const k of Object.keys(h)) if (h[k] != null) out[k] = String(h[k]);
  } catch {}
  return out;
}

function describeBody(b) {
  if (b == null) return null;
  try {
    if (typeof b === 'string') {
      let kind = 'text';
      try {
        JSON.parse(b);
        kind = 'json';
      } catch {}
      return { kind, text: clip(b), size: b.length };
    }
    if (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) return { kind: 'form', text: b.toString() };
    if (typeof FormData !== 'undefined' && b instanceof FormData) {
      const fields = [];
      b.forEach((v, k) => fields.push([k, typeof File !== 'undefined' && v instanceof File ? `@${v.name || 'file'}` : String(v)]));
      return { kind: 'multipart', fields, text: fields.map(([k, v]) => `${k}=${v}`).join('\n') };
    }
    if (typeof Blob !== 'undefined' && b instanceof Blob) return { kind: 'binary', text: `<Blob ${b.size} bytes${b.type ? ', ' + b.type : ''}>` };
    if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return { kind: 'binary', text: `<binary ${b.byteLength} bytes>` };
    if (typeof ReadableStream !== 'undefined' && b instanceof ReadableStream) return { kind: 'binary', text: '<stream>' };
    return { kind: 'text', text: clip(String(b)) };
  } catch {
    return null;
  }
}

function newEntry(method, url, headers, body) {
  const href = absUrl(url);
  if (IGNORE.test(href) || /[?&]_rsc=/.test(href)) return null;
  // Next.js router navigations (React Server Component payloads) are not API calls.
  if (headers && Object.keys(headers).some((k) => k.toLowerCase() === 'rsc')) return null;
  const e = {
    id: ++cap.seq,
    method: String(method || 'GET').toUpperCase(),
    url: href,
    reqHeaders: headers || {},
    reqBody: body,
    status: null,
    ok: null,
    error: null,
    resType: null,
    resBody: null,
    truncated: false,
    start: Date.now(),
    duration: null,
    pending: true,
    stack: '',
    tag: cap.tag,
    mocked: null,
  };
  cap.tag = null;
  try {
    e.stack = new Error().stack || '';
  } catch {}
  cap.entries.push(e);
  if (cap.entries.length > MAX_ENTRIES) cap.entries.shift();
  notify(e);
  return e;
}

function finish(e, patch) {
  Object.assign(e, patch, { pending: false, duration: Date.now() - e.start });
  notify(e);
}

function readResponse(e, res) {
  const type = (res.headers && res.headers.get('content-type')) || '';
  const len = Number((res.headers && res.headers.get('content-length')) || 0);
  const base = { status: res.status, ok: res.ok, resType: type };
  if (e.method === 'HEAD' || !TEXTUAL.test(type) || /event-stream/i.test(type) || len > 5e6 || res.bodyUsed) return finish(e, base);
  res
    .clone()
    .text()
    .then(
      (t) => finish(e, { ...base, resBody: clip(t), truncated: t.length > MAX_BODY }),
      () => finish(e, base)
    );
}

function installFetch() {
  const orig = window.fetch;
  if (typeof orig !== 'function' || orig.__sourcepeek) return;
  const wrapped = function fetch(input, init) {
    let e = null;
    let mock = null;
    try {
      const isReq = typeof Request !== 'undefined' && input instanceof Request;
      const url = isReq ? input.url : input && typeof input === 'object' && input.href ? input.href : String(input);
      const method = (init && init.method) || (isReq && input.method) || 'GET';
      const headers = { ...(isReq ? headersToObject(input.headers) : {}), ...headersToObject(init && init.headers) };
      e = newEntry(method, url, headers, init && init.body != null ? describeBody(init.body) : null);
      if (e) {
        mock = findMock(e.method, e.url);
        if (mock) e.mocked = mock.id;
      }
      if (e && isReq && !(init && init.body != null) && !/^(GET|HEAD)$/.test(e.method)) {
        input
          .clone()
          .text()
          .then((t) => {
            e.reqBody = describeBody(t);
            notify(e);
          }, () => {});
      }
    } catch {}
    // A mocked request never reaches the network: it gets the response saved with "Mock this".
    const p = mock ? mockFetchResponse(mock, e.url) : orig.apply(typeof window !== 'undefined' && this === window ? this : undefined, arguments);
    if (!e) return p;
    return p.then(
      (res) => {
        try {
          readResponse(e, res);
        } catch {
          finish(e, { status: res && res.status });
        }
        return res;
      },
      (err) => {
        finish(e, { error: String((err && err.message) || err) });
        throw err;
      }
    );
  };
  wrapped.__sourcepeek = true;
  cap.orig.fetch = orig;
  cap.wrappedFetch = wrapped;
  window.fetch = wrapped;
}

function installXhr() {
  const X = window.XMLHttpRequest;
  if (!X || !X.prototype || X.prototype.send.__sourcepeek) return;
  const proto = X.prototype;
  const { open, send, setRequestHeader } = proto;
  cap.orig.xhr = { open, send, setRequestHeader };
  proto.open = function (method, url) {
    try {
      this.__mf = { method, url: String(url), headers: {} };
    } catch {}
    return open.apply(this, arguments);
  };
  proto.setRequestHeader = function (k, v) {
    try {
      if (this.__mf) this.__mf.headers[k] = String(v);
    } catch {}
    return setRequestHeader.apply(this, arguments);
  };
  proto.send = function (body) {
    let mock = null;
    let e = null;
    try {
      const m = this.__mf;
      e = m ? newEntry(m.method, m.url, m.headers, describeBody(body)) : null;
      if (e) {
        mock = findMock(e.method, e.url);
        if (mock) e.mocked = mock.id;
      }
      if (e) {
        const xhr = this;
        xhr.addEventListener('loadend', () => {
          let text = null;
          try {
            if (!xhr.responseType || xhr.responseType === 'text') text = xhr.responseText;
            else if (xhr.responseType === 'json') text = JSON.stringify(xhr.response);
          } catch {}
          finish(e, {
            status: xhr.status || null,
            ok: xhr.status >= 200 && xhr.status < 300,
            resType: (() => {
              try {
                return xhr.getResponseHeader('content-type') || '';
              } catch {
                return '';
              }
            })(),
            resBody: text != null ? clip(String(text)) : null,
            truncated: text != null && String(text).length > MAX_BODY,
            error: xhr.status === 0 ? 'Network error or request aborted' : null,
          });
        });
      }
    } catch {}
    if (mock) return mockXhr(this, mock, e.url);
    return send.apply(this, arguments);
  };
  proto.send.__sourcepeek = true;
}

/** Start recording as early as possible (module load), so requests fired on first render are caught. */
export function installCapture() {
  if (cap.installed || typeof window === 'undefined') return;
  cap.installed = true;
  try {
    installFetch();
  } catch {}
  try {
    installXhr();
  } catch {}
}

/** Every request captured on this page so far (oldest first). Used by the bug report. */
export function requestLog() {
  return cap.entries.slice();
}

/** The page's own fetch, without recording — for Sourcepeek's internal requests (screenshot images, fonts). */
export function nativeFetch(input, init) {
  const f = cap.orig.fetch || window.fetch;
  return f.call(window, input, init);
}

/** Put the original fetch / XHR back (no backend, or Sourcepeek unmounted). */
export function uninstallCapture() {
  if (!cap.installed || typeof window === 'undefined') return;
  cap.installed = false;
  if (cap.orig.fetch && window.fetch === cap.wrappedFetch) window.fetch = cap.orig.fetch;
  if (cap.orig.xhr && window.XMLHttpRequest) Object.assign(window.XMLHttpRequest.prototype, cap.orig.xhr);
  cap.orig = {};
  cap.entries = [];
}

// ---------- matching ----------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function patternRe(url) {
  const noQuery = url.split('?')[0].split('#')[0];
  const absolute = /^(https?:)?\/\//.test(noQuery);
  let src = '';
  let rest = noQuery;
  // `{API_URL}/users` — unknown base: match on the path that follows
  if (/^\{[^}]+\}/.test(rest)) rest = rest.replace(/^\{[^}]+\}/, '');
  for (const part of rest.split(/(\{[^}]*\})/)) src += /^\{.*\}$/.test(part) ? '[^/?#]+' : escapeRe(part);
  src = src.replace(/\/$/, '') + '/?';
  return { re: new RegExp((absolute ? '^' : '(?:^|/)') + src.replace(/^\//, '/?') + '$'), absolute };
}

function entryMatches(ep, e) {
  if (ep.method !== e.method && !/^\{/.test(ep.method)) return false;
  if (!ep._re) ep._re = patternRe(ep.url);
  let u;
  try {
    u = new URL(e.url);
  } catch {
    return false;
  }
  const target = ep._re.absolute ? u.origin + u.pathname : u.pathname;
  return ep._re.re.test(target);
}

export function stackHasFile(stack, rel) {
  if (!stack || !rel) return false;
  let s = stack;
  try {
    s = decodeURIComponent(stack);
  } catch {}
  s = s.replace(/\\/g, '/');
  const r = String(rel).replace(/\\/g, '/').replace(/^\.?\//, '');
  const re = new RegExp(`(^|[\\s(/@\\]])${escapeRe(r)}($|[?:\\s)])`, 'm');
  // Turbopack chunk names: src_components_Card_tsx
  return re.test(s) || s.includes(r.replace(/[/.\-[\]]/g, '_'));
}

// ---------- formatting ----------

function pretty(text) {
  if (text == null) return '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return String(text);
  }
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

function shortUrl(href) {
  try {
    const u = new URL(href);
    return (u.origin === location.origin ? '' : u.host) + u.pathname + u.search;
  } catch {
    return href;
  }
}

function withQuery(url, query) {
  if (!query || typeof query !== 'object' || !Object.keys(query).length) return url;
  const qs = Object.entries(query)
    .map(([k, v]) => `${encodeURIComponent(k)}=${typeof v === 'object' ? encodeURIComponent(JSON.stringify(v)) : encodeURIComponent(String(v))}`)
    .join('&');
  return url + (url.includes('?') ? '&' : '?') + qs;
}

function endpointUrl(ep) {
  const u = withQuery(ep.url, ep.query);
  if (/^\{/.test(u) || /^(https?:)?\/\//.test(u)) return u;
  try {
    return new URL(u, location.origin).href.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
  } catch {
    return u;
  }
}

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const SKIP_HEADERS = /^(content-length|host|connection|accept-encoding)$/i;

/** { method, url, headers, body: { kind, text, fields } } → a cURL command. */
export function toCurl(req, { cookies = false } = {}) {
  const first = ['curl'];
  if (/[{}[\]]/.test(req.url)) first.push('-g'); // keep {placeholders} literal
  if (req.method === 'HEAD') first.push('-I');
  else if (req.method !== 'GET' || req.body) first.push('-X', req.method);
  first.push(sq(req.url));
  const lines = [first.join(' ')];
  const headers = { ...(req.headers || {}) };
  const has = (n) => Object.keys(headers).some((k) => k.toLowerCase() === n);
  const body = req.body;
  if (body && body.kind === 'json' && !has('content-type')) headers['Content-Type'] = 'application/json';
  if (body && body.kind === 'form' && !has('content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  for (const [k, v] of Object.entries(headers)) {
    if (SKIP_HEADERS.test(k)) continue;
    if (body && body.kind === 'multipart' && /^content-type$/i.test(k)) continue; // curl sets the boundary
    lines.push(`-H ${sq(`${k}: ${v}`)}`);
  }
  if (cookies) {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(req.url, location.href).origin === location.origin;
    } catch {}
    if (sameOrigin && document.cookie) lines.push(`-b ${sq(document.cookie)}`);
  }
  if (body) {
    if (body.kind === 'multipart' && body.fields) for (const [k, v] of body.fields) lines.push(`-F ${sq(`${k}=${v}`)}`);
    else if (body.kind !== 'binary' && body.text != null) lines.push(`--data-raw ${sq(body.text)}`);
  }
  return lines.join(' \\\n  ');
}

function exampleBody(ep) {
  if (ep.payload == null) return null;
  const p = ep.payload;
  if (ep.payloadType === 'form' && p && typeof p === 'object') {
    return { kind: 'form', text: new URLSearchParams(Object.entries(p).map(([k, v]) => [k, String(v)])).toString(), display: JSON.stringify(p, null, 2) };
  }
  if (ep.payloadType === 'multipart' && p && typeof p === 'object') {
    const fields = Object.entries(p).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]);
    return { kind: 'multipart', fields, text: fields.map(([k, v]) => `${k}=${v}`).join('\n') };
  }
  if (ep.payloadType === 'text') return { kind: 'text', text: String(p) };
  return { kind: 'json', text: JSON.stringify(p), display: JSON.stringify(p, null, 2) };
}

// ---------- UI ----------

function badge(method) {
  const m = String(method).toUpperCase();
  const cls = m === 'GET' ? 'get' : m === 'POST' ? 'post' : m === 'DELETE' ? 'delete' : /^(PUT|PATCH)$/.test(m) ? 'put' : 'other';
  return el('span', `mf-net-method mf-net-method--${cls}`, m.replace(/[{}]/g, ''));
}

function statusChip(e) {
  if (!e) return el('span', 'mf-net-status mf-net-status--idle', 'not called yet');
  if (e.pending) return el('span', 'mf-net-status', e.mocked ? 'mocked · pending…' : 'pending…');
  if (e.error && !e.status) return el('span', 'mf-net-status mf-net-status--err', e.mocked ? 'mocked · failed' : 'failed');
  const cls = e.status >= 400 ? 'err' : e.status >= 300 ? 'warn' : 'ok';
  return el('span', `mf-net-status mf-net-status--${cls}`, `${e.status}${e.duration != null ? ` · ${e.duration}ms` : ''}`);
}

function mockBadge(title) {
  const b = el('span', 'mf-mock-badge', 'MOCK');
  b.title = title;
  return b;
}

function pre(text) {
  return el('pre', 'mf-net-pre', clipLines(text));
}

function tabs(options, initial, onChange) {
  const wrap = el('div', 'mf-net-tabs');
  const btns = options.map(([id, label]) => {
    const b = el('button', 'mf-net-tab' + (id === initial ? ' mf-net-tab--on' : ''), label);
    b.type = 'button';
    b.onclick = () => {
      btns.forEach((x) => x.classList.toggle('mf-net-tab--on', x === b));
      onChange(id);
    };
    return b;
  });
  wrap.append(...btns);
  return wrap;
}

/** True when the backend has an AI key configured (from /health). */
function hasAi() {
  const st = getState();
  return Boolean(st && st.ai);
}

function smallBtn(text, title, onClick) {
  const b = el('button', 'mf-net-btn', text);
  b.type = 'button';
  if (title) b.title = title;
  b.onclick = onClick;
  return b;
}

/**
 * Fill the Network accordion body. ctx: { file, componentName }.
 * Returns a cleanup function (stops live updates).
 */
export function buildNetwork(box, ctx) {
  const ui = { open: new Set(), payloadMode: new Map(), responseMode: new Map(), cookies: false, editors: new Map(), busy: new Set(), notes: new Map() };
  let scan = null;
  let scanError = null;
  let timer = null;

  const toolbar = el('div', 'mf-net-toolbar');
  const summary = el('div', 'mf-muted mf-net-summary', 'Scanning the component…');
  const cookieLabel = el('label', 'mf-net-check');
  const cookieBox = el('input');
  cookieBox.type = 'checkbox';
  cookieBox.onchange = () => (ui.cookies = cookieBox.checked);
  cookieLabel.title = 'Add this page’s cookies (-b) to copied cURL commands, for endpoints behind a session';
  cookieLabel.append(cookieBox, document.createTextNode(' cookies in cURL'));
  const refresh = smallBtn('Rescan', 'Scan the source code again', () => load());
  toolbar.append(summary, cookieLabel, refresh);
  const list = el('div', 'mf-net-list');
  const others = el('div', 'mf-net-others');
  box.append(toolbar, list, others);

  const compFile = ctx.file;

  /** Static endpoints with their latest live call + live-only requests from this component. */
  function model() {
    const eps = (scan ? scan.endpoints : []).map((ep) => ({ ...ep, key: 'code:' + ep.method + ' ' + ep.url, calls: [] }));
    const live = new Map();
    for (const e of cap.entries) {
      const owner = (e.tag && eps.find((x) => x.key === e.tag)) || eps.find((ep) => entryMatches(ep, e));
      if (owner) {
        owner.calls.push(e);
        continue;
      }
      const tagged = e.tag && live.get(e.tag);
      if (tagged) {
        tagged.calls.push(e);
        continue;
      }
      if (!stackHasFile(e.stack, compFile)) continue;
      let path = e.url;
      try {
        const u = new URL(e.url);
        path = u.origin + u.pathname;
      } catch {}
      const key = 'live:' + e.method + ' ' + path;
      if (!live.has(key)) live.set(key, { key, method: e.method, url: path, live: true, calls: [] });
      live.get(key).calls.push(e);
    }
    return [...eps, ...live.values()];
  }

  function render() {
    if (!box.isConnected && box.dataset.mfRendered) return cleanup();
    box.dataset.mfRendered = '1';
    list.textContent = '';
    others.textContent = '';
    if (scanError) {
      summary.textContent = scanError;
    }
    if (!scan && !scanError) return;
    const items = model();
    const codeCount = items.filter((x) => !x.live).length;
    const calledCount = items.filter((x) => x.calls.length).length;
    if (!scanError) {
      summary.textContent = items.length
        ? `${codeCount} in code · ${calledCount} called on this page`
        : 'No requests found';
      summary.title = scan && scan.files.length ? 'Scanned:\n' + scan.files.join('\n') : '';
    }
    if (!items.length) {
      const empty = el('div', 'mf-muted mf-net-empty');
      empty.textContent = `${ctx.componentName} and the files it imports don’t call fetch, axios or a similar client, and no request from it was captured on this page yet.`;
      list.appendChild(empty);
    }
    for (const it of items) list.appendChild(card(it));

    // Everything else this page requested — useful when the call happens somewhere Sourcepeek can't trace.
    const mine = new Set(items.flatMap((x) => x.calls));
    const rest = cap.entries.filter((e) => !mine.has(e));
    if (rest.length) {
      others.appendChild(el('div', 'mf-subsection-title', `Other requests on this page (${rest.length})`));
      const groups = new Map();
      for (const e of rest.slice().reverse()) {
        let path = e.url;
        try {
          const u = new URL(e.url);
          path = u.origin + u.pathname;
        } catch {}
        const key = 'page:' + e.method + ' ' + path;
        if (!groups.has(key)) groups.set(key, { key, method: e.method, url: path, live: true, page: true, calls: [] });
        groups.get(key).calls.unshift(e);
      }
      for (const g of groups.values()) others.appendChild(card(g));
    }
  }

  function card(it) {
    const last = it.calls[it.calls.length - 1] || null;
    const d = el('details', 'mf-net-item');
    d.open = ui.open.has(it.key);
    d.ontoggle = () => (d.open ? ui.open.add(it.key) : ui.open.delete(it.key));
    const sum = el('summary', 'mf-net-head');
    const urlText = last ? shortUrl(last.url) : it.url;
    const u = el('code', 'mf-net-url', urlText);
    u.title = last ? last.url : it.url;
    // Which mock answers this request: the one that answered its last call, or one saved for its URL.
    const mockUrl = last ? splitUrl(last.url).base : endpointUrl(it).split('?')[0];
    const active = mocksFor(last ? last.method : it.method, last ? last.url : mockUrl).concat(getMock(last && last.mocked) || []);
    const mock = active.find(Boolean) || null;
    sum.append(badge(it.method));
    if (mock) sum.appendChild(mockBadge(`Mocked — answered with ${mock.networkError ? 'a network error' : mock.status} by Sourcepeek, not your server`));
    else if (last && last.mocked) sum.appendChild(mockBadge('The last call was answered by a mock that has since been removed'));
    sum.append(u, statusChip(last));
    d.appendChild(sum);

    const body = el('div', 'mf-net-body');
    // where it comes from
    const meta = el('div', 'mf-net-meta');
    if (!it.live) {
      if (it.fn) meta.appendChild(el('code', 'mf-net-fn', `${it.fn}()`));
      const src = el('button', 'mf-linkbtn', fileLine(it.file, it.line));
      src.type = 'button';
      src.title = 'Open in editor';
      src.onclick = () => openSource(it.file, it.line);
      meta.appendChild(src);
      if (it.stream) meta.appendChild(el('span', 'mf-badge', 'event stream'));
    } else {
      meta.appendChild(el('span', 'mf-muted', it.page ? 'Captured on this page (not traced to this component)' : `Captured live — called from ${ctx.componentName}`));
    }
    if (it.calls.length) meta.appendChild(el('span', 'mf-muted', `· ${it.calls.length} call${it.calls.length === 1 ? '' : 's'}, last ${ago(last.start)}`));
    body.appendChild(meta);

    const isBodyMethod = BODY_METHODS.test(it.method) || /^\{/.test(it.method);
    const example = it.live ? null : exampleBody(it);
    const sent = last && last.reqBody ? last.reqBody : null;

    // request payload
    let payloadMode = ui.payloadMode.get(it.key) || (sent ? 'sent' : 'example');
    if (payloadMode === 'sent' && !sent) payloadMode = 'example';
    if (payloadMode === 'example' && !example && sent) payloadMode = 'sent';
    if (isBodyMethod || sent || example) {
      const sec = el('div', 'mf-net-sec');
      const head = el('div', 'mf-net-sec-head');
      head.appendChild(el('span', 'mf-subtitle', 'Payload'));
      const holder = el('div');
      const show = (mode, picked) => {
        if (picked) ui.payloadMode.set(it.key, mode);
        payloadMode = mode;
        holder.textContent = '';
        const b = mode === 'sent' ? sent : example;
        if (!b) {
          holder.appendChild(el('div', 'mf-muted', isBodyMethod ? 'No body found in the code for this request.' : 'No body.'));
          return;
        }
        holder.appendChild(pre(b.display || (b.kind === 'json' ? pretty(b.text) : b.text)));
        if (mode === 'example') holder.appendChild(el('div', 'mf-net-hint', it.payloadNote || 'Example inferred from the code — field values are placeholders.'));
      };
      if (sent && example) head.appendChild(tabs([['example', 'Example'], ['sent', 'Last sent']], payloadMode, (m) => show(m, true)));
      else head.appendChild(el('span', 'mf-net-tag', sent ? 'last sent' : 'example'));
      sec.append(head, holder);
      body.appendChild(sec);
      show(payloadMode);
    }

    // response
    const expected = !it.live && it.response != null ? it.response : null;
    const got = last && !last.pending && (last.resBody != null || last.status) ? last : null;
    // A mock saved (or changed) after the last call: show what the next call will get, not the stale answer.
    const upcoming = mock && (!last || last.mocked !== mock.id || last.start < (mock.updated || 0)) ? mock : null;
    let resMode = ui.responseMode.get(it.key) || (upcoming ? 'mock' : got ? 'live' : 'expected');
    if (resMode === 'mock' && !upcoming) resMode = got ? 'live' : 'expected';
    if (resMode === 'live' && !got) resMode = 'expected';
    if (resMode === 'expected' && expected == null && got) resMode = 'live';
    {
      const sec = el('div', 'mf-net-sec');
      const head = el('div', 'mf-net-sec-head');
      head.appendChild(el('span', 'mf-subtitle', it.method === 'GET' ? 'Response payload' : 'Response'));
      const holder = el('div');
      const show = (mode, picked) => {
        if (picked) ui.responseMode.set(it.key, mode);
        holder.textContent = '';
        if (mode === 'mock' && upcoming) {
          if (upcoming.networkError) holder.appendChild(el('div', 'mf-muted', 'Network error (mocked)'));
          else if (upcoming.body) holder.appendChild(pre(pretty(upcoming.body)));
          else holder.appendChild(el('div', 'mf-muted', 'Empty body'));
          const note = el('div', 'mf-mock-pending');
          if (isWaiting(upcoming.id)) {
            note.appendChild(el('span', null, 'The page loaded this before the mock existed and hasn’t asked again yet.'));
            const rl = smallBtn('Reload to apply', 'Mocks survive the reload', reloadPage);
            rl.classList.add('mf-net-btn--mock');
            note.appendChild(rl);
          } else note.appendChild(el('span', null, `The next ${upcoming.method} to this URL gets this ${upcoming.networkError ? 'error' : `(${upcoming.status})`}.`));
          holder.appendChild(note);
          return;
        }
        if (mode === 'live' && got) {
          if (got.resBody != null && got.resBody !== '') {
            holder.appendChild(pre(pretty(got.resBody)));
            if (got.truncated) holder.appendChild(el('div', 'mf-net-hint', `Truncated to ${Math.round(MAX_BODY / 1024)} KB.`));
          } else holder.appendChild(el('div', 'mf-muted', got.error || (got.resType ? `${got.resType} — not shown` : 'Empty body')));
          if (got.resType) holder.appendChild(el('div', 'mf-net-hint', got.resType));
          return;
        }
        if (expected != null) {
          holder.appendChild(pre(JSON.stringify(expected, null, 2)));
          holder.appendChild(el('div', 'mf-net-hint', `Expected shape from the type ${it.responseType || ''} — not a real response.`.replace('  ', ' ')));
          return;
        }
        holder.appendChild(
          el('div', 'mf-muted', it.method === 'GET' ? 'Not called on this page yet, and no response type found in the code. Send the request to see what comes back.' : 'Not called on this page yet.')
        );
      };
      const modes = [upcoming && ['mock', 'Mock'], got && ['live', upcoming ? 'Last call' : 'Live'], expected != null && ['expected', 'Expected']].filter(Boolean);
      if (modes.length > 1) head.appendChild(tabs(modes, resMode, (m) => show(m, true)));
      else if (modes.length) head.appendChild(el('span', 'mf-net-tag' + (modes[0][0] === 'mock' ? ' mf-net-tag--mock' : ''), modes[0][0]));
      sec.append(head, holder);
      body.appendChild(sec);
      show(resMode);
    }

    // actions
    const actions = el('div', 'mf-net-actions');
    const request = () => {
      const useSent = payloadMode === 'sent' && sent;
      if (last && (useSent || !example)) return { method: last.method, url: last.url, headers: last.reqHeaders, body: last.reqBody || null };
      return {
        method: /^\{/.test(it.method) ? 'POST' : it.method,
        url: last ? last.url : endpointUrl(it),
        headers: { ...(it.headers || {}), ...(last ? last.reqHeaders : {}) },
        body: isBodyMethod ? example : null,
      };
    };
    const cb = smallBtn('Copy cURL', null, () => copy(toCurl(request(), { cookies: ui.cookies }), cb));
    cb.classList.add('mf-net-btn--primary');
    cb.onmouseenter = () => {
      const r = request();
      cb.title = (r.url.includes('{') ? 'URL has placeholders like {id} — fill them in before running.\n' : '') + (last ? 'Uses the last captured request' : 'Built from the code');
    };
    actions.appendChild(cb);
    const payloadText = () => {
      const b = payloadMode === 'sent' ? sent : example;
      return b ? b.display || (b.kind === 'json' ? pretty(b.text) : b.text) : '';
    };
    if (sent || example) {
      const pb = smallBtn('Copy payload', null, () => copy(payloadText(), pb));
      actions.appendChild(pb);
    }
    if (got && got.resBody) {
      const rb = smallBtn('Copy response', null, () => copy(pretty(got.resBody), rb));
      actions.appendChild(rb);
    }
    // GET is safe to replay; anything else is left to the user's own cURL.
    if (it.method === 'GET' && !it.stream) {
      const target = last ? last.url : endpointUrl(it);
      const runnable = !/[{}]/.test(target);
      const sb = smallBtn(last ? 'Send again' : 'Send request', runnable ? `GET ${target}` : 'Fill in the {placeholders} first — copy the cURL and edit it', async () => {
        sb.disabled = true;
        sb.textContent = 'Sending…';
        ui.open.add(it.key);
        ui.responseMode.set(it.key, 'live');
        cap.tag = it.key;
        try {
          await window.fetch(target, { headers: request().headers, credentials: 'same-origin' });
        } catch {}
        cap.tag = null;
        render();
      });
      sb.disabled = !runnable;
      actions.appendChild(sb);
    }
    // Mock this: answer this request with a response you write, until you remove it (or close the tab).
    const mb = smallBtn(mock ? 'Edit mock' : 'Mock this', mock ? 'Change or remove the fake response' : 'Answer this request with a response you write — your server is not called', () => {
      const ed = ui.editors.get(it.key);
      if (ed && ed.isConnected) {
        ui.editors.delete(it.key);
        ed.remove();
        return;
      }
      const editor = mockEditor(it, { last, got, expected, mock, mockUrl });
      ui.editors.set(it.key, editor);
      actions.after(editor);
      const ta = editor.querySelector('textarea');
      if (ta) ta.focus();
    });
    mb.classList.add('mf-net-btn--mock');
    actions.appendChild(mb);
    // Randomise: ask the AI for realistic data in the shape this request answers with, mock the request with it and
    // put it on the page (click again for different data). Without an AI key: random values in the known shape.
    const shape = shapeFor(it, { got, expected, mock, sent, example });
    const aiOn = hasAi();
    const busy = ui.busy.has(it.key);
    const rnd = smallBtn(
      busy ? 'Generating…' : 'Randomise',
      aiOn
        ? `Ask the AI for realistic data for this request${shape ? ` (in the shape of ${shape.from})` : ''} and show it on the page — click again for different data. Your server is not called.`
        : shape
          ? `Mock this request with random data in the shape of ${shape.from} — click again for new values. Add an AI key (e.g. OPENAI_API_KEY) for realistic data.`
          : 'Nothing to base random data on yet: add an AI key (e.g. OPENAI_API_KEY), or send the request once so its shape is known',
      async () => {
        if (ui.busy.has(it.key)) return;
        const method = (last ? last.method : /^\{/.test(it.method) ? 'POST' : it.method).toUpperCase();
        const status = mock && !mock.networkError && mock.status < 400 ? mock.status : 200;
        let bodyText = null;
        let note = null;
        if (aiOn) {
          ui.busy.add(it.key);
          ui.notes.delete(it.key);
          render();
          const res = await aiMockData(it, { method, url: last ? last.url : mockUrl, status, shape, previous: mock && mock.body });
          ui.busy.delete(it.key);
          if (res.ok) {
            bodyText = JSON.stringify(res.value, null, 2);
            note = { kind: 'ok', text: `AI data${res.summary ? `: ${res.summary}` : ''}${res.via ? ` · via ${res.via}` : ''}` };
          } else if (shape) {
            bodyText = JSON.stringify(randomLike(shape.value, ...shape.templates), null, 2);
            note = { kind: 'warn', text: `AI failed (${res.error}) — used random values in the known shape instead.` };
          } else {
            ui.notes.set(it.key, { kind: 'warn', text: `AI failed: ${res.error}` });
            render();
            return;
          }
        } else {
          if (!shape) return;
          bodyText = JSON.stringify(randomLike(shape.value, ...shape.templates), null, 2);
        }
        const saved = saveMock({
          id: mock ? mock.id : null,
          method,
          url: mockUrl,
          query: mock ? mock.query : '',
          status,
          delay: mock ? mock.delay : 0,
          contentType: 'application/json',
          body: bodyText,
          networkError: false,
          hits: mock ? mock.hits : 0,
          created: mock ? mock.created : null,
          refetch: Boolean(last) && /^(GET|HEAD)$/.test(method),
        });
        // The page already loaded this data: make it load again so the new data shows (reloads if it won't ask).
        if (last && /^(GET|HEAD)$/.test(method)) applyMock(saved.id);
        if (note) ui.notes.set(it.key, note);
        ui.editors.delete(it.key);
        ui.open.add(it.key);
        ui.responseMode.delete(it.key);
        render();
      }
    );
    rnd.classList.add('mf-net-btn--mock');
    rnd.disabled = busy || (!aiOn && !shape);
    actions.appendChild(rnd);
    body.appendChild(actions);
    const n = ui.notes.get(it.key);
    if (n) body.appendChild(el('div', n.kind === 'warn' ? 'mf-style-warn' : 'mf-net-hint', n.text));
    // Keep an open editor (and what was typed in it) across re-renders.
    const openEditor = ui.editors.get(it.key);
    if (openEditor) body.appendChild(openEditor);
    d.appendChild(body);
    return d;
  }

  /**
   * What random data for this request should look like: a real (unmocked) response first, then the type from the
   * code, then whatever answered last, then the request payload. Returns { value, from, templates } or null.
   * `templates` are the other known response shapes: an empty list in `value` (an empty cart, say) takes its
   * items from them, so Randomise still fills it.
   */
  function shapeFor(it, { got, expected, mock, sent, example }) {
    const asObj = (v) => (v !== undefined && v !== null && typeof v === 'object' ? v : undefined);
    const found = [];
    for (let i = it.calls.length - 1; i >= 0; i--) {
      const c = it.calls[i];
      if (c.mocked || c.pending) continue;
      const v = asObj(parseJson(c.resBody));
      if (v) found.push({ value: v, from: 'the last real response' });
    }
    if (asObj(expected)) found.push({ value: expected, from: `the response type${it.responseType ? ' ' + it.responseType : ''}` });
    const g = asObj(got && parseJson(got.resBody));
    if (g) found.push({ value: g, from: 'the last response' });
    const m = asObj(mock && parseJson(mock.body));
    if (m) found.push({ value: m, from: 'the current mock' });
    // the request payload only describes the response when nothing else does
    if (!found.length) {
      for (const [b, from] of [[sent, 'the sent payload'], [example, 'the example payload']]) {
        const v = asObj(b && b.kind === 'json' ? parseJson(b.text) : undefined);
        if (v) found.push({ value: v, from });
      }
    }
    if (!found.length) return null;
    return { ...found[0], templates: found.slice(1).map((f) => f.value), all: found };
  }

  /** Ask the backend's AI for a response body for this request. Returns { ok, value, summary, via } or { ok: false, error }. */
  async function aiMockData(it, { method, url, status, shape, previous }) {
    const samples = shape && shape.all ? shape.all.slice(0, 4).map((f) => ({ from: f.from, value: f.value })) : [];
    const res = await api('/ai/mock-data', {
      method,
      url,
      status,
      componentName: ctx.componentName,
      file: it.file || compFile,
      responseType: it.responseType || null,
      samples,
      previous: previous ? String(previous).slice(0, 3000) : null,
    });
    if (!res.ok) return { ok: false, error: res.error };
    if (res.data.body === undefined) return { ok: false, error: 'empty answer' };
    return { ok: true, value: res.data.body, summary: res.data.summary, via: res.data.via };
  }

  function mockEditor(it, { last, got, expected, mock, mockUrl }) {
    const wrap = el('div', 'mf-mock-editor');
    const method = (last ? last.method : /^\{/.test(it.method) ? 'POST' : it.method).toUpperCase();
    const query = last ? splitUrl(last.url).query : '';
    wrap.appendChild(el('div', 'mf-subtitle', mock ? 'Mock' : 'New mock'));
    const match = el('div', 'mf-mock-match');
    match.append(el('code', 'mf-net-url', `${method} ${mockUrl}`));
    let qBox = null;
    if (query) {
      const l = el('label', 'mf-net-check');
      qBox = el('input');
      qBox.type = 'checkbox';
      qBox.checked = Boolean(mock && mock.query);
      l.append(qBox, document.createTextNode(` only with ${query.length > 40 ? query.slice(0, 40) + '…' : query}`));
      l.title = 'Without this, every query string on this path is mocked';
      match.appendChild(l);
    }
    if (/\{[^}]*\}/.test(mockUrl)) match.appendChild(el('div', 'mf-net-hint', '{placeholders} match any value.'));
    const row = el('div', 'mf-mock-row');
    const field = (label, input) => {
      const f = el('label', 'mf-mock-field');
      f.append(el('span', null, label), input);
      return f;
    };
    const status = el('input', 'mf-mock-input');
    status.type = 'number';
    status.min = '200';
    status.max = '599';
    status.value = String(mock ? mock.status : got && got.status >= 200 ? got.status : 200);
    const delay = el('input', 'mf-mock-input');
    delay.type = 'number';
    delay.min = '0';
    delay.step = '100';
    delay.value = String(mock ? mock.delay : 0);
    const ctype = el('input', 'mf-mock-input mf-mock-input--wide');
    const isJson = (t) => {
      try {
        JSON.parse(t);
        return true;
      } catch {
        return false;
      }
    };
    const failL = el('label', 'mf-net-check');
    const fail = el('input');
    fail.type = 'checkbox';
    fail.checked = Boolean(mock && mock.networkError);
    failL.append(fail, document.createTextNode(' network error'));
    failL.title = 'Fail as if the server were unreachable (fetch rejects, XHR fires "error")';
    row.append(field('Status', status), field('Delay ms', delay), field('Content-Type', ctype), failL);
    const ta = el('textarea', 'mf-style-input mf-mock-body');
    ta.rows = 8;
    ta.spellcheck = false;
    ta.value = mock ? mock.body : got && got.resBody ? pretty(got.resBody) : expected != null ? JSON.stringify(expected, null, 2) : '{}';
    // A JSON body gets a JSON type, even when the real answer was an HTML error or fallback page.
    ctype.value = mock ? mock.contentType : isJson(ta.value) ? 'application/json' : (got && got.resType && got.resType.split(';')[0]) || 'text/plain';
    const warn = el('div', 'mf-style-warn');
    warn.hidden = true;
    const btns = el('div', 'mf-net-actions');
    const saveB = smallBtn(mock ? 'Update mock' : 'Start mocking', 'Applies to every matching request from now on, with the panel open or closed', () => {
      if (/json/i.test(ctype.value) && ta.value.trim()) {
        try {
          JSON.parse(ta.value);
        } catch (err) {
          if (!warn.hidden && warn.dataset.ok === ta.value) warn.hidden = true;
          else {
            warn.hidden = false;
            warn.dataset.ok = ta.value;
            warn.textContent = `Not valid JSON (${err.message}). Click again to save it anyway.`;
            return;
          }
        }
      }
      saveMock({ id: mock ? mock.id : null, method, url: mockUrl, query: qBox && qBox.checked ? query : '', status: status.value, delay: delay.value, contentType: ctype.value.trim(), body: ta.value, networkError: fail.checked, hits: mock ? mock.hits : 0, created: mock ? mock.created : null, refetch: Boolean(last) && /^(GET|HEAD)$/.test(method) });
      ui.editors.delete(it.key);
      ui.open.add(it.key);
      ui.responseMode.delete(it.key);
      render();
    });
    saveB.classList.add('mf-net-btn--primary');
    btns.appendChild(saveB);
    // Fill the body with AI-written data shaped like what is in the box now (or the response shape); random values
    // in that shape without an AI key.
    const fill = smallBtn('Randomise', hasAi() ? 'Ask the AI for realistic data in the same shape (keys and types stay, values change)' : 'Replace the body with random data of the same shape (keys and types stay, values change)', async () => {
      const cur = parseJson(ta.value);
      const known = shapeFor(it, { got, expected, mock, sent: last && last.reqBody, example: it.live ? null : exampleBody(it) });
      const curObj = cur !== undefined && cur !== null && typeof cur === 'object';
      const base = curObj ? { value: cur, from: 'the body in the editor', templates: known ? [known.value, ...known.templates] : [], all: [{ value: cur, from: 'the body in the editor' }, ...(known ? known.all : [])] } : known;
      if (hasAi()) {
        fill.disabled = true;
        fill.textContent = 'Generating…';
        warn.hidden = true;
        const res = await aiMockData(it, { method, url: last ? last.url : mockUrl, status: Number(status.value) || 200, shape: base, previous: ta.value });
        fill.disabled = false;
        fill.textContent = 'Randomise';
        if (res.ok) {
          ta.value = JSON.stringify(res.value, null, 2);
          ctype.value = 'application/json';
          return;
        }
        warn.hidden = false;
        warn.textContent = `AI failed: ${res.error}${base ? ' — used random values in the same shape instead.' : ''}`;
        if (!base) return;
        ta.value = JSON.stringify(randomLike(base.value, ...base.templates), null, 2);
        ctype.value = 'application/json';
        return;
      }
      if (!base) {
        warn.hidden = false;
        warn.textContent = 'Write a JSON sample first (e.g. {"name": "", "count": 0}) — Randomise keeps its keys and types.';
        return;
      }
      ta.value = JSON.stringify(randomLike(base.value, ...base.templates), null, 2);
      ctype.value = 'application/json';
      warn.hidden = true;
    });
    fill.classList.add('mf-net-btn--mock');
    btns.appendChild(fill);
    if (mock) {
      const rm = smallBtn('Remove mock', (mock.hits || 0) > 0 ? 'Requests go to the real server again — the page reloads so the real data replaces the mocked data' : 'Requests go to the real server again', () => {
        removeMock(mock.id);
        ui.editors.delete(it.key);
        render();
      });
      rm.classList.add('mf-net-btn--danger');
      btns.appendChild(rm);
    }
    btns.appendChild(
      smallBtn('Cancel', null, () => {
        ui.editors.delete(it.key);
        wrap.remove();
      })
    );
    for (const n of [ta, status, delay, ctype]) ['keydown', 'keyup', 'keypress'].forEach((t) => n.addEventListener(t, (ev) => ev.stopPropagation()));
    wrap.append(match, row, ta, warn, btns, el('div', 'mf-net-hint', 'Mocks keep answering after you close this panel, and survive a reload of this tab. The bar at the bottom of the page shows how many are active.'));
    return wrap;
  }

  const unsubMocks = onMocksChange(() => {
    if (!box.isConnected && box.dataset.mfRendered) return cleanup();
    render();
  });

  const unsubscribe = onRequest((e) => {
    if (!box.isConnected) return cleanup();
    clearTimeout(timer);
    timer = setTimeout(render, 120);
  });

  function cleanup() {
    clearTimeout(timer);
    unsubscribe();
    unsubMocks();
  }

  async function load() {
    summary.textContent = 'Scanning the component…';
    const res = await api('/network', { file: ctx.file });
    if (res.ok) {
      scan = res.data;
      scanError = null;
    } else {
      scan = { endpoints: [], files: [] };
      scanError = `Could not scan the source: ${res.error}. Showing live requests only.`;
    }
    render();
  }

  load();
  return cleanup;
}
