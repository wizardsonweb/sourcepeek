// "Report": a one-click bug report for the clicked element, as one copyable Markdown block.
//   screenshot (element outlined) · component, file and line · props and state · page URL
//   failed requests with payloads · console errors · browser and viewport · the clicks that led here
// Clicks and console errors are recorded from the moment Sourcepeek loads (like Network), so the report
// can show what happened before you opened the inspector.

import { el, copy, toast, fileLine, getState, locate } from './core.js';
import { componentChain } from './inspect.js';
import { requestLog } from './network.js';
import { captureDom, captureScreen } from './screenshot.js';

const CLICK_WINDOW = 30_000;
const MAX_CLICKS = 120;
const MAX_ERRORS = 60;
const SESSION_KEY = 'sourcepeek:clicks';

// ---------- live capture: clicks + console errors ----------

const rec = { installed: false, clicks: [], errors: [], takeoverAt: null, origError: null, wrappedError: null, handlers: [] };

const ours = (e) => typeof e.composedPath === 'function' && e.composedPath().some((n) => n && n.tagName === 'SOURCEPEEK-ROOT');

const INTERACTIVE = 'a,button,input,select,textarea,label,summary,option,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[role=option],[onclick],[tabindex]';

function clip(s, n) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function describeTarget(t) {
  const node = (t.closest && t.closest(INTERACTIVE)) || t;
  const tag = node.tagName ? node.tagName.toLowerCase() : 'node';
  let what = tag;
  const type = node.getAttribute && node.getAttribute('type');
  if (tag === 'input' && type) what += `[type=${type}]`;
  const testid = node.getAttribute && (node.getAttribute('data-testid') || node.getAttribute('data-test-id') || node.getAttribute('data-cy'));
  if (testid) what += `[data-testid=${testid}]`;
  else if (node.id && !/^[:«]|^\d/.test(node.id)) what += `#${node.id}`;
  let label = '';
  if (node.getAttribute) label = node.getAttribute('aria-label') || '';
  if (!label && tag !== 'input' && tag !== 'textarea' && tag !== 'select') label = node.innerText || node.textContent || '';
  if (!label && node.getAttribute) label = node.getAttribute('placeholder') || node.getAttribute('title') || node.getAttribute('name') || node.getAttribute('alt') || '';
  if (tag === 'a' && node.getAttribute('href')) what += ` → ${clip(node.getAttribute('href'), 60)}`;
  return { node, what, label: clip(label, 60) };
}

function onAppClick(e) {
  if (!e.isTrusted) return;
  const st = getState();
  if (ours(e) || (st && st.inspect) || e.altKey) {
    // Sourcepeek took over: the report's click window ends here.
    if (rec.takeoverAt == null) rec.takeoverAt = Date.now();
    return;
  }
  rec.takeoverAt = null;
  try {
    const { node, what, label } = describeTarget(e.target);
    let src = null;
    try {
      const hit = locate(node);
      if (hit && hit.file) src = { comp: hit.comp, file: hit.file, line: hit.line };
      else if (hit) src = { comp: hit.comp };
    } catch {}
    rec.clicks.push({ t: Date.now(), x: Math.round(e.clientX), y: Math.round(e.clientY), what, label, src, path: location.pathname + location.search });
    if (rec.clicks.length > MAX_CLICKS) rec.clicks.shift();
  } catch {}
}

function fmtArg(a) {
  if (a instanceof Error) return a.stack && a.stack.includes(a.message) ? a.stack : `${a.name}: ${a.message}${a.stack ? '\n' + a.stack : ''}`;
  if (typeof a === 'string') return a;
  if (a === undefined) return 'undefined';
  try {
    const s = JSON.stringify(a, (k, v) => (typeof v === 'bigint' ? String(v) : v));
    return s === undefined ? String(a) : s;
  } catch {
    return String(a);
  }
}

function formatConsole(args) {
  if (!args.length) return '';
  let [first, ...rest] = args;
  if (typeof first === 'string' && /%[sdifoOc]/.test(first)) {
    first = first.replace(/%([sdifoOc])/g, (m, k) => {
      if (!rest.length) return m;
      const v = rest.shift();
      return k === 'c' ? '' : fmtArg(v);
    });
  }
  return [first, ...rest].map(fmtArg).join(' ');
}

function pushError(kind, message, extra) {
  message = String(message || '').trim();
  if (!message || message.startsWith('[sourcepeek]')) return;
  const last = rec.errors[rec.errors.length - 1];
  if (last && last.message === message && last.kind === kind) {
    last.count++;
    last.t = Date.now();
    return;
  }
  rec.errors.push({ t: Date.now(), kind, message: message.length > 4000 ? message.slice(0, 4000) + '…' : message, count: 1, ...extra });
  if (rec.errors.length > MAX_ERRORS) rec.errors.shift();
}

function onWindowError(e) {
  if (e instanceof ErrorEvent || e.error || e.message) {
    const err = e.error;
    pushError('uncaught', err ? fmtArg(err) : `${e.message}${e.filename ? `\n    at ${e.filename}:${e.lineno}:${e.colno}` : ''}`);
    return;
  }
  // Resource that failed to load (capture phase): <img>, <script>, <link>
  const t = e.target;
  if (t && t !== window && t.tagName) {
    const url = t.currentSrc || t.src || t.href;
    if (url && !/\/__sourcepeek\//.test(url)) pushError('resource', `Failed to load <${t.tagName.toLowerCase()}> ${url}`);
  }
}

function onRejection(e) {
  const r = e.reason;
  pushError('promise', `Unhandled promise rejection: ${r instanceof Error ? fmtArg(r) : fmtArg(r)}`);
}

function saveClicks() {
  try {
    const keep = rec.clicks.filter((c) => Date.now() - c.t < CLICK_WINDOW * 2);
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ at: Date.now(), clicks: keep }));
  } catch {}
}

function restoreClicks() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_KEY);
    if (!raw) return;
    const { at, clicks } = JSON.parse(raw);
    if (!Array.isArray(clicks) || Date.now() - at > CLICK_WINDOW * 2) return;
    rec.clicks = clicks.map((c) => ({ ...c, beforeReload: true })).concat(rec.clicks);
  } catch {}
}

/** Start recording clicks and console errors (called at module load, like the network capture). */
export function installReportCapture() {
  if (rec.installed || typeof window === 'undefined') return;
  rec.installed = true;
  restoreClicks();
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    rec.handlers.push(() => target.removeEventListener(type, fn, opts));
  };
  on(window, 'click', onAppClick, true);
  on(window, 'error', onWindowError, true);
  on(window, 'unhandledrejection', onRejection);
  on(window, 'pagehide', saveClicks);
  if (typeof console !== 'undefined' && typeof console.error === 'function') {
    const orig = console.error;
    const wrapped = function error(...args) {
      try {
        pushError('console', formatConsole(args));
      } catch {}
      return orig.apply(this, args);
    };
    rec.origError = orig;
    rec.wrappedError = wrapped;
    console.error = wrapped;
  }
}

export function uninstallReportCapture() {
  if (!rec.installed) return;
  rec.installed = false;
  rec.handlers.forEach((fn) => fn());
  rec.handlers = [];
  if (rec.origError && console.error === rec.wrappedError) console.error = rec.origError;
  rec.origError = rec.wrappedError = null;
  rec.clicks = [];
  rec.errors = [];
}

// ---------- privacy: never put secrets into a ticket ----------

const SECRET = /(password|passwd|pwd|secret|token|apikey|authorization|cookie|sessionid|creditcard|cardnumber|cvv|cvc|ssn|iban|privatekey)/;
export const isSecretKey = (k) => SECRET.test(String(k).toLowerCase().replace(/[-_\s]/g, ''));

function redactValue(v, depth = 0) {
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => redactValue(x, depth + 1));
  const out = {};
  for (const k of Object.keys(v)) out[k] = isSecretKey(k) ? '[redacted]' : redactValue(v[k], depth + 1);
  return out;
}

export function redactText(text, kind) {
  if (text == null) return '';
  const s = String(text);
  try {
    return JSON.stringify(redactValue(JSON.parse(s)), null, 2);
  } catch {}
  if (kind === 'form' || /^[\w.%-]+=[^&]*(&[\w.%-]+=[^&]*)*$/.test(s.trim())) {
    try {
      const p = new URLSearchParams(s);
      for (const k of [...p.keys()]) if (isSecretKey(k)) p.set(k, '[redacted]');
      return p.toString();
    } catch {}
  }
  return redactInline(s);
}

/** Secrets inside free text (console messages, non-JSON bodies): "token":"…", password=…, Authorization: Bearer … */
const INLINE_SECRET = /(["']?)([\w-]*(?:password|passwd|secret|token|api[-_]?key|authorization|cookie|session[-_]?id|card[-_]?number|cvv|cvc|iban)[\w-]*)\1(\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|(?:Bearer|Basic)\s+\S+|[^\s,&;}\]]+)/gi;

export function redactInline(text) {
  return String(text).replace(INLINE_SECRET, (m, q, key, sep, val) => `${q}${key}${q}${sep}${/^["']/.test(val) ? val[0] + '[redacted]' + val[0] : '[redacted]'}`);
}

function redactUrl(u) {
  try {
    const url = new URL(u, location.href);
    for (const k of [...url.searchParams.keys()]) if (isSecretKey(k)) url.searchParams.set(k, 'redacted');
    if (url.password) url.password = 'redacted';
    return url.href;
  } catch {
    return u;
  }
}

// ---------- environment ----------

async function browserInfo() {
  const ua = navigator.userAgent;
  let browser = 'Unknown browser';
  let m;
  if ((m = ua.match(/Edg\/(\d+)/))) browser = `Edge ${m[1]}`;
  else if ((m = ua.match(/OPR\/(\d+)/))) browser = `Opera ${m[1]}`;
  else if ((m = ua.match(/Firefox\/(\d+)/))) browser = `Firefox ${m[1]}`;
  else if ((m = ua.match(/Chrome\/(\d+)/))) browser = `Chrome ${m[1]}`;
  else if ((m = ua.match(/Version\/([\d.]+).*Safari/))) browser = `Safari ${m[1]}`;
  let os = 'Unknown OS';
  if ((m = ua.match(/Windows NT ([\d.]+)/))) os = 'Windows';
  else if ((m = ua.match(/(iPhone|iPad); CPU (?:iPhone )?OS (\d+)_(\d+)/))) os = `iOS ${m[2]}.${m[3]}`;
  else if ((m = ua.match(/Mac OS X (\d+)[._](\d+)/))) os = 'macOS';
  else if ((m = ua.match(/Android (\d+(?:\.\d+)?)/))) os = `Android ${m[1]}`;
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  try {
    const d = navigator.userAgentData;
    if (d && d.getHighEntropyValues) {
      const hi = await Promise.race([d.getHighEntropyValues(['fullVersionList', 'platformVersion']), new Promise((r) => setTimeout(() => r(null), 400))]);
      if (hi) {
        const brand = (hi.fullVersionList || []).find((b) => !/Not.?A.?Brand|Chromium/i.test(b.brand));
        if (brand) browser = `${brand.brand.replace(/^Google /, '')} ${brand.version}`;
        if (os === 'Windows' && hi.platformVersion) os = Number(hi.platformVersion.split('.')[0]) >= 13 ? 'Windows 11' : 'Windows 10';
        if (os === 'macOS' && hi.platformVersion) os = `macOS ${hi.platformVersion.split('.').slice(0, 2).join('.')}`;
      }
    }
  } catch {}
  const dpr = window.devicePixelRatio || 1;
  const dark = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
  const touch = window.matchMedia && matchMedia('(pointer: coarse)').matches;
  return {
    browser,
    os,
    viewport: `${innerWidth}×${innerHeight}`,
    dpr: Math.round(dpr * 100) / 100,
    screen: window.screen ? `${screen.width}×${screen.height}` : null,
    scheme: dark ? 'dark' : 'light',
    touch,
    language: navigator.language || '',
  };
}

// ---------- snapshot ----------

const pad = (n) => String(n).padStart(2, '0');
const clock = (t) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const stamp = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
};

/** Console errors, uncaught errors and failed resources recorded so far (oldest first). */
export function errorLog() {
  return rec.errors.slice();
}

/** Source file a request was sent from, read from its call stack (best effort, no line: stacks are not source-mapped). */
export function initiator(stack) {
  if (!stack) return null;
  let s = stack;
  try {
    s = decodeURIComponent(stack);
  } catch {}
  for (const line of s.split('\n').slice(1)) {
    if (/node_modules|\/@vite\/|sourcepeek|chunk-|\/_next\/static\/chunks\/(?!app|pages)/.test(line)) continue;
    const m = line.match(/(?:\/|\.\/)((?:src|app|pages|components|lib|features|modules|hooks|services|api|utils|views|routes)\/[^?:)\s]+\.(?:[cm]?[jt]sx?|vue|svelte))/);
    if (m) return m[1];
  }
  return null;
}

function failedRequests() {
  return requestLog().filter((e) => !e.pending && (e.error || (e.status && e.status >= 400)));
}

function cssSelector(node) {
  if (!node || !node.tagName) return '';
  let s = node.tagName.toLowerCase();
  const testid = node.getAttribute('data-testid') || node.getAttribute('data-test-id') || node.getAttribute('data-cy');
  if (testid) return `${s}[data-testid="${testid}"]`;
  if (node.id && !/^[:«]|^\d/.test(node.id)) s += `#${node.id}`;
  const cls = typeof node.className === 'string' ? node.className : node.getAttribute('class') || '';
  const parts = cls.split(/\s+/).filter((c) => c && !/^(mf-|css-|sc-|jsx-|svelte-|_ngcontent|ng-)/.test(c) && c.length < 40).slice(0, 3);
  if (parts.length) s += '.' + parts.join('.');
  return s;
}

/** Everything the report needs, frozen at this moment. */
async function snapshot(ctx) {
  const now = Date.now();
  const st = getState();
  const chain = ctx.el && ctx.el.isConnected ? componentChain(ctx.el, { lineOffset: (st && st.svelteLineOffset) || 0 }) : [];
  const current = [...chain].reverse().find((c) => c.name === ctx.componentName) || chain[chain.length - 1] || null;
  const anchor = rec.takeoverAt || now;
  let clicks = rec.clicks.filter((c) => c.t <= anchor && anchor - c.t <= CLICK_WINDOW);
  let clicksStale = false;
  if (!clicks.length && rec.clicks.length) {
    clicks = rec.clicks.slice(-5);
    clicksStale = true;
  }
  return {
    now,
    anchor,
    url: location.href,
    title: document.title,
    comp: ctx.componentName,
    file: ctx.file,
    line: ctx.line,
    tag: ctx.tagName,
    selector: cssSelector(ctx.el),
    text: ctx.text || '',
    callSite: ctx.callSite || null,
    chain: chain.length ? chain.map((c) => c.name) : ctx.chain || [],
    props: (current && current.props) || ctx.propsRows || [],
    state: (current && current.state) || (ctx.state && ctx.state.rows) || [],
    owner: (current && current.name) || ctx.componentName,
    git: ctx.gitContext || null,
    detached: !(ctx.el && ctx.el.isConnected),
    requests: failedRequests(),
    errors: rec.errors.slice(),
    clicks,
    clicksStale,
    env: await browserInfo(),
    stylePreviews: st && st.styles ? st.styles.length : 0,
    tz: (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        return '';
      }
    })(),
  };
}

// ---------- Markdown ----------

function fence(text, lang = '') {
  const runs = String(text).match(/`{3,}/g) || [];
  const n = Math.max(3, ...runs.map((r) => r.length + 1));
  const f = '`'.repeat(n);
  return `${f}${lang}\n${String(text).replace(/\n+$/, '')}\n${f}`;
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const code = (s) => {
  s = String(s);
  const ticks = (s.match(/`+/g) || []).reduce((m, r) => Math.max(m, r.length), 0);
  const f = '`'.repeat(ticks + 1);
  return ticks ? `${f} ${s} ${f}` : `${f}${s}${f}`;
};

function clipBlock(text, max) {
  const s = String(text);
  return s.length > max ? s.slice(0, max) + `\n… (${s.length - max} more characters)` : s;
}

function reqPath(u) {
  try {
    const url = new URL(u);
    return (url.origin === location.origin ? '' : url.origin) + url.pathname + url.search;
  } catch {
    return u;
  }
}

function langOf(text, type) {
  if (/json/i.test(type || '')) return 'json';
  try {
    JSON.parse(text);
    return 'json';
  } catch {}
  if (/html/i.test(type || '')) return 'html';
  if (/xml/i.test(type || '')) return 'xml';
  return 'text';
}

const sec = (ms) => (ms / 1000).toFixed(ms < 10_000 ? 1 : 0);

export function toMarkdown(s, opts = {}) {
  const { notes = '', shot = null } = opts;
  const L = [];
  const where = fileLine(s.file, s.line);
  L.push(`## Bug: ${code(`<${s.comp}>`)} in ${code(where)}`);
  L.push('');
  if (notes.trim()) {
    L.push(notes.trim());
    L.push('');
  }
  if (shot && shot.path) L.push(`**Screenshot:** [${shot.path}](${shot.path}) — ${code(`<${s.comp}>`)} outlined in red`);
  else if (shot && shot.name) L.push(`**Screenshot:** ${code(shot.name)} (attach it to this report) — ${code(`<${s.comp}>`)} outlined in red`);
  if (shot) L.push('');

  L.push('| | |');
  L.push('|---|---|');
  L.push(`| **Page** | ${cell(redactUrl(s.url))} |`);
  L.push(`| **Component** | ${code(s.comp)} — ${code(where)} |`);
  if (s.callSite) L.push(`| **Rendered from** | ${code(fileLine(s.callSite.replace(/:(\d+)$/, ''), Number((s.callSite.match(/:(\d+)$/) || [])[1]) || null))} |`);
  if (s.chain.length > 1) L.push(`| **Component chain** | ${cell(s.chain.join(' › '))} |`);
  L.push(`| **Element** | ${code(s.selector || s.tag)}${s.text ? ` “${cell(clip(s.text, 80))}”` : ''}${s.detached ? ' _(no longer on the page)_' : ''} |`);
  if (s.git && s.git.git) {
    const g = [];
    if (s.git.branch) g.push(`branch ${code(s.git.branch)}`);
    if (s.git.blame) {
      g.push(
        s.git.blame.uncommitted
          ? 'this line has uncommitted changes'
          : `line last changed by ${cell(s.git.blame.author)} on ${String(s.git.blame.date).slice(0, 10)} (${code(String(s.git.blame.hash).slice(0, 7))})`
      );
    }
    if (g.length) L.push(`| **Git** | ${g.join(', ')} |`);
  }
  const e = s.env;
  L.push(`| **Browser** | ${cell(e.browser)} on ${cell(e.os)}${e.language ? ` · ${cell(e.language)}` : ''} |`);
  L.push(`| **Viewport** | ${e.viewport} @${e.dpr}x · ${e.scheme} mode${e.touch ? ' · touch' : ''}${e.screen ? ` · screen ${e.screen}` : ''} |`);
  L.push(`| **Reported** | ${stamp(s.now).replace('_', ' ').replace(/-(\d\d)-(\d\d)$/, ':$1:$2')}${s.tz ? ` (${cell(s.tz)})` : ''} |`);
  if (s.stylePreviews) L.push(`| **Note** | ${s.stylePreviews} Sourcepeek CSS preview change${s.stylePreviews === 1 ? ' is' : 's are'} live on this page |`);
  L.push('');

  const kv = (rows) =>
    rows
      .slice(0, 40)
      .map(([k, v]) => `${k}: ${isSecretKey(k) ? '[redacted]' : v}`)
      .join('\n') + (rows.length > 40 ? `\n… ${rows.length - 40} more` : '');
  if (s.props.length) {
    L.push(`### Props of ${code(s.owner)}`);
    L.push(fence(kv(s.props), 'yaml'));
    L.push('');
  }
  if (s.state.length) {
    L.push(`### State of ${code(s.owner)}`);
    L.push(fence(kv(s.state), 'yaml'));
    L.push('');
  }

  if (s.requests.length) {
    const shown = s.requests.slice(-5);
    L.push(`### Failed requests (${s.requests.length})`);
    if (s.requests.length > shown.length) L.push(`_Showing the last ${shown.length}._`);
    for (const r of shown) {
      const status = (r.status ? `${r.status}` : 'network error') + (r.mocked ? ' (mocked by Sourcepeek — not a real server response)' : '');
      const from = initiator(r.stack);
      L.push('');
      L.push(`#### ${code(`${r.method} ${reqPath(redactUrl(r.url))}`)} → ${status}`);
      const meta = [`at ${clock(r.start)}`];
      if (r.duration != null) meta.push(`${r.duration} ms`);
      if (from) meta.push(`sent from ${code(from)}`);
      if (r.error && r.status) meta.push(cell(r.error));
      L.push(meta.join(' · '));
      if (r.reqBody && r.reqBody.text != null && r.reqBody.text !== '') {
        const body = r.reqBody.kind === 'multipart' && r.reqBody.fields ? r.reqBody.fields.map(([k, v]) => `${k}=${isSecretKey(k) ? '[redacted]' : v}`).join('\n') : redactText(r.reqBody.text, r.reqBody.kind);
        L.push('');
        L.push('Payload:');
        L.push(fence(clipBlock(body, 3000), langOf(body)));
      }
      if (r.resBody != null && r.resBody !== '') {
        const body = redactText(r.resBody);
        L.push('');
        L.push('Response:');
        L.push(fence(clipBlock(body, 3000), langOf(body, r.resType)));
      } else if (r.error && !r.status) {
        L.push('');
        L.push(`Error: ${cell(r.error)}`);
      }
    }
    L.push('');
  }

  if (s.errors.length) {
    const shown = s.errors.slice(-15);
    L.push(`### Console errors (${s.errors.reduce((n, x) => n + x.count, 0)})`);
    const lines = shown.map((x) => {
      const msg = x.message.split('\n');
      const head = msg[0];
      const stack = msg.slice(1).filter((l) => l.trim()).slice(0, 8);
      const label = x.kind === 'uncaught' ? ' [uncaught]' : x.kind === 'promise' ? ' [promise]' : x.kind === 'resource' ? ' [resource]' : '';
      return `${clock(x.t)}${label}${x.count > 1 ? ` (×${x.count})` : ''}  ${clip(redactInline(head), 500)}${stack.length ? '\n' + stack.map((l) => '    ' + l.trim()).join('\n') : ''}`;
    });
    L.push(fence(lines.join('\n'), 'text'));
    L.push('');
  }

  if (s.clicks.length) {
    L.push(s.clicksStale ? '### Last clicks (more than 30 s before Sourcepeek was opened)' : '### Clicks in the 30 s before Sourcepeek was opened');
    L.push('| When | Clicked | Source |');
    L.push('|---|---|---|');
    const here = location.pathname + location.search;
    for (const c of s.clicks) {
      const when = `−${sec(s.anchor - c.t)} s${c.beforeReload ? ' (before reload)' : ''}`;
      const what = `${code(c.what)}${c.label ? ` “${cell(c.label)}”` : ''}${c.path && c.path !== here ? ` on ${code(c.path)}` : ''}`;
      const src = c.src ? (c.src.file ? code(fileLine(c.src.file, c.src.line)) : code(c.src.comp)) : '';
      L.push(`| ${when} | ${redactInline(what)} | ${src} |`);
    }
    L.push('');
  }

  const none = [!s.requests.length && 'no failed requests', !s.errors.length && 'no console errors', !s.clicks.length && 'no clicks recorded'].filter(Boolean);
  if (none.length) L.push(`_${none.join(', ').replace(/^./, (c) => c.toUpperCase())}._`);
  return L.join('\n').replace(/\n+$/, '\n');
}

// ---------- UI ----------

function btn(text, cls, title, onClick) {
  const b = el('button', cls, text);
  b.type = 'button';
  if (title) b.title = title;
  b.onclick = onClick;
  return b;
}

function safeName(s) {
  return String(s || 'element').replace(/[^\w.-]+/g, '-').slice(0, 40);
}

/**
 * Fill the Report accordion body. ctx: the "More →" context (componentName, file, line, el, …).
 * Returns a cleanup function.
 */
export function buildReport(box, ctx) {
  let snap = null;
  let shot = null; // { blob, url, name, path, method }
  let busy = false;
  let notes = '';
  let mdTimer = null;

  const shotWrap = el('div', 'mf-rep-shot');
  const shotImg = el('img', 'mf-rep-img');
  shotImg.alt = 'Screenshot with the element outlined';
  shotImg.hidden = true;
  const shotStatus = el('div', 'mf-muted mf-rep-status', 'Capturing screenshot…');
  shotWrap.append(shotImg, shotStatus);
  shotImg.onclick = () => shot && window.open(shot.url, '_blank', 'noopener');
  shotImg.title = 'Open full size';

  const shotActions = el('div', 'mf-net-actions');
  const retake = btn('Retake', 'mf-net-btn', 'Capture the page and collect everything again', () => run('dom'));
  const screen = btn('Capture screen', 'mf-net-btn', 'Pixel-perfect screenshot through the browser’s screen-share prompt (pick “This tab”)', () => run('screen'));
  const copyImg = btn('Copy screenshot', 'mf-net-btn', 'Copy the image, to paste into GitHub, Jira or Slack', async () => {
    if (!shot) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': shot.blob })]);
      toast('Screenshot copied', 'ok');
    } catch {
      toast('This browser can’t copy images — use Download', 'error');
    }
  });
  const download = btn('Download', 'mf-net-btn', 'Save the screenshot as PNG', () => {
    if (!shot) return;
    const a = document.createElement('a');
    a.href = shot.url;
    a.download = shot.name;
    a.click();
  });
  shotActions.append(retake, screen, copyImg, download);
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) screen.hidden = true;

  const notesBox = el('textarea', 'mf-style-input mf-rep-notes');
  notesBox.placeholder = 'What went wrong, and what did you expect? (optional)';
  notesBox.rows = 2;
  notesBox.oninput = () => {
    notes = notesBox.value;
    clearTimeout(mdTimer);
    mdTimer = setTimeout(renderMd, 150);
  };

  const chips = el('div', 'mf-rep-chips');
  const main = el('div', 'mf-rep-main');
  const copyMd = btn('Preparing…', 'mf-style-btn mf-rep-copy', 'Copy the whole report as Markdown', () => {
    if (!snap) return;
    copy(markdown(), copyMd);
  });
  copyMd.disabled = true;
  const saved = el('div', 'mf-net-hint');
  main.append(copyMd, saved);

  const preview = el('details', 'mf-rep-preview');
  const sum = el('summary', 'mf-subtitle', 'Markdown');
  const pre = el('pre', 'mf-net-pre mf-rep-pre');
  preview.append(sum, pre);

  box.append(shotWrap, shotActions, notesBox, chips, main, preview);

  const markdown = () => toMarkdown(snap, { notes, shot: shot && { path: shot.path, name: shot.name } });

  function renderMd() {
    if (!snap) return;
    pre.textContent = markdown();
  }

  function renderChips() {
    chips.textContent = '';
    if (!snap) return;
    const chip = (text, kind) => chips.appendChild(el('span', 'mf-rep-chip' + (kind ? ' mf-rep-chip--' + kind : ''), text));
    chip(shot ? 'screenshot' : 'no screenshot', shot ? 'ok' : 'warn');
    chip(`${snap.props.length} props`);
    if (snap.state.length) chip(`${snap.state.length} state`);
    chip(`${snap.requests.length} failed request${snap.requests.length === 1 ? '' : 's'}`, snap.requests.length ? 'err' : null);
    const ne = snap.errors.reduce((n, x) => n + x.count, 0);
    chip(`${ne} console error${ne === 1 ? '' : 's'}`, ne ? 'err' : null);
    chip(`${snap.clicks.length} click${snap.clicks.length === 1 ? '' : 's'}`);
  }

  async function storeShot(result) {
    if (shot && shot.url) URL.revokeObjectURL(shot.url);
    const name = `sourcepeek-${safeName(ctx.componentName)}-${stamp(snap ? snap.now : Date.now())}.png`;
    shot = { blob: result.blob, url: URL.createObjectURL(result.blob), name, path: null, method: result.method };
    shotImg.src = shot.url;
    shotImg.hidden = false;
    shotStatus.textContent = result.method === 'screen' ? 'Captured from the screen.' : `Rendered from the page${result.ms ? ` in ${result.ms} ms` : ''}. Wrong? Try “Capture screen”.`;
    saved.textContent = '';
    // Not saved automatically — use “Copy screenshot” or “Download” to keep it.
  }

  async function run(mode) {
    if (busy) return;
    busy = true;
    copyMd.disabled = true;
    copyMd.textContent = 'Preparing…';
    retake.disabled = screen.disabled = true;
    const label = `${ctx.componentName} · ${ctx.tagName}`;
    const host = getState() && getState().ui ? getState().ui.host : null;
    try {
      if (mode === 'screen') {
        shotStatus.textContent = 'Pick “This tab” in the browser prompt…';
        const r = await captureScreen({ target: ctx.el, label, hide: host });
        snap = await snapshot(ctx);
        await storeShot(r);
      } else {
        shotStatus.textContent = 'Capturing screenshot…';
        if (ctx.el && ctx.el.isConnected) {
          const r = ctx.el.getBoundingClientRect();
          if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) ctx.el.scrollIntoView({ block: 'center', inline: 'nearest' });
        }
        snap = await snapshot(ctx);
        renderChips();
        renderMd();
        await new Promise((r) => requestAnimationFrame(() => r()));
        try {
          const r = await captureDom({ target: ctx.el, label, exclude: host, mount: getState() && getState().ui && getState().ui.shadow });
          await storeShot(r);
        } catch (err) {
          shotStatus.textContent = `${(err && err.message) || 'Screenshot failed.'}`;
        }
      }
    } catch (err) {
      shotStatus.textContent = err && err.name === 'NotAllowedError' ? 'Screen capture was cancelled.' : `${(err && err.message) || err}`;
      if (!snap) snap = await snapshot(ctx);
    } finally {
      busy = false;
      retake.disabled = screen.disabled = false;
      copyImg.disabled = download.disabled = !shot;
      copyMd.disabled = !snap;
      copyMd.textContent = 'Copy bug report';
      copyMd.dataset.label = 'Copy bug report';
      renderChips();
      renderMd();
    }
  }

  copyImg.disabled = download.disabled = true;
  run('dom');

  return () => {
    clearTimeout(mdTimer);
    if (shot && shot.url) setTimeout(() => URL.revokeObjectURL(shot.url), 1000);
  };
}
