// Sharing with coding agents (Claude Code, Cursor, VS Code… through `npx sourcepeek mcp`).
//
// When you inspect an element, the page sends what Sourcepeek knows about it — file and line, component chain,
// call-site, props and state, where the shown value comes from, the element's HTML — to the local dev backend, which
// keeps it for the MCP server. While an agent is connected, the page also keeps a snapshot of its console errors,
// requests and Web Vitals there. "Fix this" in your agent then knows which element you mean.
// Dev server only, requests from this computer only; secrets (password, token, apiKey… fields, JWTs) are redacted.

import { api, getState, fileLine, absPath } from './core.js';
import { requestLog } from './network.js';
import { errorLog, initiator, isSecretKey, redactText, redactInline } from './report.js';
import { toJson } from './valueView.js';
import { vitalsSnapshot, completeVitals } from './vitals.js';
import { mocks } from './mocks.js';

const VALUE_CHARS = 6000;
const BODY_CHARS = 4000;
const PAGE_MS = 2000;
const STATUS_MS = 10000;

let selSeq = 0;
const share = { timer: null, statusTimer: null, lastKey: '', active: false, listeners: new Set() };

function redactDeep(v, depth = 0) {
  if (depth > 12 || v === null || typeof v !== 'object') return typeof v === 'string' && /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(v) ? '[redacted]' : v;
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, depth + 1));
  const out = {};
  for (const k of Object.keys(v)) out[k] = isSecretKey(k) ? '[redacted]' : redactDeep(v[k], depth + 1);
  return out;
}

/** A value as JSON-safe data the agent can read: complete up to a size, secrets redacted. */
function plain(key, value) {
  if (isSecretKey(key)) return '[redacted]';
  let text = toJson(value, { indent: 0, maxChars: VALUE_CHARS * 4 });
  let data;
  try {
    data = redactDeep(JSON.parse(text));
  } catch {
    data = text;
  }
  const out = JSON.stringify(data);
  if (out && out.length > VALUE_CHARS) return { truncated: true, preview: out.slice(0, VALUE_CHARS) + '…', size: out.length };
  return data;
}

function rows(list) {
  const out = {};
  for (const [k, v] of list || []) out[k] = plain(k, v);
  return out;
}

function clipHtml(node) {
  try {
    const html = node.outerHTML.replace(/\s(data-mf-(?:file|line|comp|call))="[^"]*"/g, '');
    return html.length > 3000 ? html.slice(0, 3000) + '…' : html;
  } catch {
    return '';
  }
}

function selectorOf(n) {
  let s = n.tagName.toLowerCase();
  if (n.id && !/^[:«\d]/.test(n.id)) s += '#' + n.id;
  const cls = typeof n.className === 'string' ? n.className.trim().split(/\s+/).filter((c) => c && c.length < 40).slice(0, 4) : [];
  if (cls.length) s += '.' + cls.join('.');
  return s;
}

/**
 * Share the inspected element. ctx: what the inspect panel knows (hit, chain, current, callSite, raw props/state).
 * Called once when the panel opens, and again when the value trace is ready. Never throws.
 */
export function shareSelection(ctx) {
  const st = getState();
  if (!st || !st.share) return;
  try {
    if (!ctx.id) ctx.id = `${Date.now().toString(36)}-${++selSeq}`;
    const node = ctx.el;
    const r = node.getBoundingClientRect();
    const sel = {
      id: ctx.id,
      at: new Date().toISOString(),
      url: location.href,
      title: document.title,
      framework: ctx.framework || null,
      component: ctx.comp,
      file: ctx.file,
      line: ctx.line,
      absPath: absPath(ctx.file),
      classFile: ctx.classFile || null,
      classLine: ctx.classLine || null,
      usedIn: ctx.callSite && ctx.callSite.file ? { file: ctx.callSite.file, line: ctx.callSite.line || null } : null,
      chain: (ctx.chain || []).map((c) => ({ name: c.name, file: c.file || null, line: c.line || null, usedIn: c.callSite && c.callSite.file ? fileLine(c.callSite.file, c.callSite.line) : null })),
      element: {
        tag: node.tagName.toLowerCase(),
        selector: selectorOf(node),
        text: redactInline((node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500)),
        html: redactInline(clipHtml(node)),
        rect: { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), width: Math.round(r.width), height: Math.round(r.height) },
        classes: typeof node.className === 'string' ? node.className : node.getAttribute('class') || '',
      },
      props: rows(ctx.propsRaw),
      state: rows(ctx.stateRaw),
      stateOwner: ctx.stateOwner || ctx.comp,
      valueSource: ctx.trace ? { text: ctx.traceText, steps: ctx.trace.steps, found: ctx.trace.found } : null,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio || 1 },
    };
    api('/mcp/selection', { selection: sel }).then((res) => {
      if (res.ok && res.data && res.data.agent) setActive(res.data.agent.active);
    });
  } catch {}
}

// ---------- page snapshot (only while an agent is connected) ----------

function requestRow(e) {
  let reqBody = e.reqBody && e.reqBody.text ? redactText(e.reqBody.text, e.reqBody.kind) : null;
  let resBody = e.resBody ? redactText(e.resBody) : null;
  if (reqBody && reqBody.length > BODY_CHARS) reqBody = reqBody.slice(0, BODY_CHARS) + '…';
  if (resBody && resBody.length > BODY_CHARS) resBody = resBody.slice(0, BODY_CHARS) + '…';
  return {
    id: e.id,
    method: e.method,
    url: e.url,
    status: e.status,
    ok: e.ok,
    error: e.error,
    pending: Boolean(e.pending),
    durationMs: e.duration,
    at: new Date(e.start).toISOString(),
    mocked: Boolean(e.mocked),
    from: initiator(e.stack),
    contentType: e.resType || null,
    requestBody: reqBody,
    responseBody: resBody,
  };
}

function pageSnapshot() {
  const reqs = requestLog();
  return {
    at: new Date().toISOString(),
    url: location.href,
    title: document.title,
    viewport: { width: innerWidth, height: innerHeight },
    userAgent: navigator.userAgent,
    errors: errorLog()
      .slice(-30)
      .map((e) => ({ kind: e.kind, at: new Date(e.t).toISOString(), count: e.count, message: redactInline(e.message) })),
    requests: reqs.slice(-60).map(requestRow),
    requestCount: reqs.length,
    vitals: vitalsSnapshot(),
    mocks: mocks().map((m) => ({ method: m.method, url: m.url, status: m.status, hits: m.hits || 0 })),
  };
}

function pageKey() {
  const reqs = requestLog();
  const last = reqs[reqs.length - 1];
  const errs = errorLog();
  const le = errs[errs.length - 1];
  const v = vitalsSnapshot();
  return [location.href, reqs.length, last && last.id, last && last.pending, errs.length, le && le.t, le && le.count, v.lcp && v.lcp.value, v.cls.value, v.inp.value, mocks().length].join('|');
}

async function pushPage(force) {
  const st = getState();
  if (!st || !st.share || !share.active || document.hidden) return;
  const key = pageKey();
  if (!force && key === share.lastKey) return;
  share.lastKey = key;
  try {
    await completeVitals();
  } catch {}
  const res = await api('/mcp/page', { page: pageSnapshot() });
  if (res.ok && res.data && res.data.agent) setActive(res.data.agent.active);
}

function setActive(on) {
  const was = share.active;
  share.active = Boolean(on);
  const st = getState();
  if (st) st.mcp = share.active;
  if (share.active && !share.timer) share.timer = setInterval(() => pushPage(false), PAGE_MS);
  if (!share.active && share.timer) {
    clearInterval(share.timer);
    share.timer = null;
  }
  if (share.active && !was) pushPage(true);
  if (was !== share.active) for (const fn of share.listeners) fn(share.active);
}

export function onAgentChange(fn) {
  share.listeners.add(fn);
  return () => share.listeners.delete(fn);
}

export const agentActive = () => share.active;

/** Start sharing (dev server, this computer): check every 10 s whether an agent is connected. */
export function startSharing(initialActive) {
  stopSharing();
  setActive(initialActive);
  share.statusTimer = setInterval(async () => {
    if (document.hidden) return;
    const res = await api('/mcp/status');
    if (res.ok && res.data) setActive(res.data.active);
  }, STATUS_MS);
}

export function stopSharing() {
  clearInterval(share.statusTimer);
  clearInterval(share.timer);
  share.statusTimer = share.timer = null;
  share.active = false;
}
