'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const ai = require('./ai.cjs');
const { enabled, prodToken } = require('./env.cjs');
const auth = require('./auth.cjs');
const github = require('./github.cjs');
const edit = require('./edit.cjs');
const nocomments = require('./nocomments.cjs');
const intent = require('./intent.cjs');
const verify = require('./verify.cjs');
const i18n = require('./i18n.cjs');
const network = require('./network.cjs');
const storage = require('./storage.cjs');
const angular = require('./angular.cjs');
const routes = require('./routes.cjs');
const usage = require('./usage.cjs');
const providers = require('./providers.cjs');
const project = require('./project.cjs');
const placement = require('./placement.cjs');
const lookup = require('./lookup.cjs');
const mcpStore = require('./mcpStore.cjs');
const { readEnv } = require('./env.cjs');

const run = promisify(execFile);
const PREFIX = '/__sourcepeek';
// Changes another run of the dev server made are not listed in the panel (their undo history stays on disk).
const RUN_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const MAX_SOURCE_CHARS = 6000;

async function git(cwd, args) {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}
const safe = (p, fallback) => p.catch(() => fallback);

function parseRemote(url) {
  if (!url) return null;
  const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

async function blameLine(root, relPath, line) {
  if (!Number.isInteger(line) || line < 1) return null;
  const out = await git(root, ['blame', '-L', `${line},${line}`, '--porcelain', '--', relPath]);
  const lines = out.split('\n');
  const hash = lines[0].split(' ')[0];
  const pick = (prefix) => (lines.find((l) => l.startsWith(prefix)) || '').slice(prefix.length);
  return {
    hash,
    uncommitted: /^0+$/.test(hash),
    author: pick('author '),
    date: new Date(Number(pick('author-time ')) * 1000).toISOString(),
    summary: pick('summary '),
  };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function resolveSource(root, file) {
  if (typeof file !== 'string' || !file) throw httpError(400, 'file is required');
  const abs = path.isAbsolute(file) ? file : path.resolve(root, file);
  if (!edit.sourceExt(root).test(abs)) throw httpError(400, 'Not a source file');
  let real;
  try {
    real = fs.realpathSync(abs);
    if (!fs.statSync(real).isFile()) throw new Error();
  } catch {
    throw httpError(404, 'File not found on this machine');
  }
  if (/[\\/]node_modules[\\/]/.test(real)) throw httpError(400, 'node_modules files are not inspected');
  if (!insideSourceRoots(root, real)) throw httpError(403, 'Files outside the project are not inspected (SOURCEPEEK_SOURCE_ROOTS adds folders)');
  return real;
}

/**
 * Files the backend reads: inside the project, or inside a folder listed in SOURCEPEEK_SOURCE_ROOTS (comma separated,
 * relative to the project), e.g. "../../packages" for a monorepo whose components live in sibling packages.
 */
function insideSourceRoots(root, real) {
  if (edit.insideRoot(root, real)) return true;
  const extra = String(readEnv(root, 'SOURCEPEEK_SOURCE_ROOTS') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return extra.some((d) => edit.insideRoot(path.resolve(root, d), real));
}

/** The files a request names that resolveSource accepts, as given. */
function acceptedSources(root, files) {
  return files.filter((f) => {
    try {
      return Boolean(resolveSource(root, f));
    } catch {
      return false;
    }
  });
}

async function fileContext(root, file, line) {
  const abs = resolveSource(root, file);
  let gitRoot;
  try {
    gitRoot = await git(path.dirname(abs), ['rev-parse', '--show-toplevel']);
  } catch {
    const relPath = path.relative(root, abs).split(path.sep).join('/');
    const remote = await github.fileContext(root, relPath, Number(line) || 1);
    if (remote) return { absPath: abs, relPath, ...remote };
    return { absPath: abs, relPath, git: false, commits: [], blame: null };
  }
  const relPath = path.relative(gitRoot, abs).split(path.sep).join('/');
  const [branch, sha, remoteUrl, logOut, blame] = await Promise.all([
    safe(git(gitRoot, ['rev-parse', '--abbrev-ref', 'HEAD']), null),
    safe(git(gitRoot, ['rev-parse', 'HEAD']), null),
    safe(git(gitRoot, ['config', '--get', 'remote.origin.url']), null),
    safe(git(gitRoot, ['log', '--follow', '-n', '5', '--format=%H%x1f%an%x1f%aI%x1f%s', '--', relPath]), ''),
    safe(blameLine(gitRoot, relPath, Number(line)), null),
  ]);
  const commits = logOut
    ? logOut.split('\n').map((row) => {
        const [hash, author, date, subject] = row.split('\x1f');
        return { hash, author, date, subject };
      })
    : [];
  const remote = parseRemote(remoteUrl);
  const ref = branch && branch !== 'HEAD' ? branch : sha;
  const githubUrl =
    remote && ref
      ? `https://github.com/${remote.owner}/${remote.repo}/blob/${encPath(ref)}/${encPath(relPath)}#L${Number(line) || 1}`
      : null;
  return { absPath: abs, relPath, git: true, branch, remote, githubUrl, commits, blame };
}

function readSource(root, file) {
  try {
    const abs = resolveSource(root, file);
    let raw = fs.readFileSync(abs, 'utf8');
    // Angular: a template alone says little — add its component class.
    const owner = abs.endsWith('.html') ? angular.ownerOfTemplate(abs) : null;
    if (owner) raw = `<!-- ${path.basename(abs)} (template) -->\n${raw}\n\n// ${path.basename(owner.abs)} (component class)\n${owner.code}`;
    return raw.length > MAX_SOURCE_CHARS ? raw.slice(0, MAX_SOURCE_CHARS) + '\n/* ...truncated... */' : raw;
  } catch {
    return null;
  }
}

// ---------- code for "Randomise" (AI mock data) ----------

const MOCK_SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.nuxt', '.output', '.svelte-kit', 'dist', 'build', 'out', 'coverage', '.turbo', '.vercel', '.angular', '.sourcepeek', 'public', 'static']);
const MOCK_CODE = /\.(jsx?|tsx?|mjs|cjs|vue|svelte)$/;
const MOCK_FILE_CHARS = 5000;
const MOCK_MAX_FILES = 4;

function mockCandidates(root) {
  const out = [];
  const go = (dir, depth) => {
    if (out.length >= 1500 || depth > 7) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!MOCK_SKIP_DIRS.has(e.name)) go(abs, depth + 1);
      } else if (MOCK_CODE.test(e.name) && !/\.(test|spec|stories|min)\.\w+$/.test(e.name)) out.push(abs);
    }
  };
  go(root, 0);
  return out;
}

/** The part of a file around the first mention of `needle`, or the whole file when it is short. */
function around(content, needle, size = MOCK_FILE_CHARS) {
  if (content.length <= size) return content;
  const i = needle ? content.indexOf(needle) : -1;
  if (i < 0) return content.slice(0, size) + '\n/* ...truncated... */';
  const from = Math.max(0, i - Math.floor(size / 3));
  return (from ? '/* ... */\n' : '') + content.slice(from, from + size) + '\n/* ...truncated... */';
}

/**
 * Files that tell the AI what the response looks like: the server route that answers the URL (Next.js app/pages
 * API routes, or any file that mentions the path in a route definition), the code that calls it, and the clicked
 * component. Only files inside the project, a few KB each.
 */
function mockDataFiles(root, body) {
  let pathname = '';
  try {
    pathname = new URL(body.url, 'http://x').pathname;
  } catch {
    pathname = String(body.url).split('?')[0];
  }
  pathname = pathname.replace(/\/+$/, '') || '/';
  const files = [];
  const seen = new Set();
  const add = (abs, role, needle) => {
    if (files.length >= MOCK_MAX_FILES) return;
    const key = path.resolve(abs);
    if (seen.has(key)) return;
    try {
      if (fs.statSync(abs).size > 400000) return;
      const content = fs.readFileSync(abs, 'utf8');
      seen.add(key);
      files.push({ rel: toPosixRel(root, abs), role, content: around(content, needle) });
    } catch {}
  };
  const usable = pathname.length > 1 && !/^\{/.test(pathname);
  if (usable) {
    const segs = pathname.split('/').filter(Boolean);
    // file-based API routes: /api/cart → app/api/cart/route.ts, pages/api/cart.ts, server/api/cart.get.ts …
    const tail = segs.join('/');
    const routeRe = new RegExp(
      `(^|/)(app|pages|routes|server|api|src/app|src/pages|src/routes|src/server)/(.*/)?${tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/^api\//, '(api/)?')}(/(route|index|\\+server))?(\\.(get|post|put|patch|delete))?\\.(js|ts|mjs)$`
    );
    const all = mockCandidates(root);
    for (const abs of all) {
      if (routeRe.test(toPosixRel(root, abs))) add(abs, 'handler');
    }
    // code that mentions the path: a route definition (server) or a fetch / axios call (consumer)
    const needle = pathname;
    const mentions = [];
    for (const abs of all) {
      if (mentions.length >= 12) break;
      try {
        if (fs.statSync(abs).size > 400000) continue;
        const c = fs.readFileSync(abs, 'utf8');
        if (!c.includes(needle)) continue;
        const handler = new RegExp(`\\.(get|post|put|patch|delete|all|route)\\(\\s*['"\`]${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(c);
        mentions.push({ abs, role: handler ? 'handler' : 'consumer', needle });
      } catch {}
    }
    mentions.sort((a, b) => (a.role === 'handler' ? 0 : 1) - (b.role === 'handler' ? 0 : 1));
    for (const m of mentions) add(m.abs, m.role, m.needle);
  }
  if (typeof body.file === 'string' && body.file) {
    try {
      add(resolveSource(root, body.file), 'component');
    } catch {}
  }
  return files;
}

function toPosixRel(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

/** Angular template → its component class (network scan, AI context); anything else unchanged. */
// ---------- React hook names for "Renders & state" ----------
// At runtime React state hooks have no names, only an order. This reads the component's source and pairs that
// order with `const [name, setName] = useState(...)`. Custom hooks hold state of their own at unknown positions,
// so naming stops at the first one.
const NO_STATE_HOOKS = new Set(['useEffect', 'useLayoutEffect', 'useInsertionEffect', 'useMemo', 'useCallback', 'useRef', 'useContext', 'useImperativeHandle', 'useDebugValue', 'useId', 'useDeferredValue', 'useSyncExternalStore', 'useFormStatus', 'use']);
const STATE_HOOKS = new Set(['useState', 'useReducer']);

function componentSlice(code, name) {
  const esc = name.replace(/[$]/g, '\\$');
  const decl = new RegExp(`(?:function\\s+${esc}\\b|(?:const|let|var)\\s+${esc}\\b[^=\\n]*=)`).exec(code);
  if (!decl) return null;
  const rest = code.slice(decl.index + decl[0].length);
  // Ends where the next top-level declaration starts.
  const next = /\n(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\b|const\b|let\b|var\b|class\b)/.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

function hookNames(code, name) {
  const body = componentSlice(code, name);
  if (body == null) return { names: [], complete: false, found: false };
  const names = [];
  const re = /\b(?:React\.)?(use[A-Z]\w*|use)\s*(?:<[^>()]*>)?\s*\(/g;
  let m;
  while ((m = re.exec(body))) {
    const hook = m[1];
    if (NO_STATE_HOOKS.has(hook)) continue;
    if (!STATE_HOOKS.has(hook)) return { names, complete: false, found: true, stoppedAt: hook };
    const before = body.slice(Math.max(0, m.index - 200), m.index);
    const d = before.match(/(?:const|let|var)\s*\[\s*([A-Za-z_$][\w$]*)?[^\]]*\]\s*(?::[^=;]*)?=\s*$/);
    const plain = before.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*$/);
    names.push(d ? d[1] || null : plain ? plain[1] : null);
  }
  return { names, complete: true, found: true };
}

function scriptFile(root, abs) {
  if (!abs.endsWith('.html')) return abs;
  const owner = angular.ownerOfTemplate(abs);
  return owner ? owner.abs : abs;
}

/**
 * Angular: where the clicked element is written. The browser knows the owning component (class name and,
 * since Angular 17.1, its file); this finds the element's line in that component's template.
 */
function angularLocate(root, body) {
  let classAbs = null;
  if (typeof body.file === 'string' && body.file) {
    try {
      classAbs = resolveSource(root, body.file);
    } catch {}
  }
  if (!classAbs) classAbs = angular.findClassFile(root, body.className);
  if (!classAbs) throw httpError(404, `Could not find the file of ${body.className || 'this component'}.`);
  if (/[\\/]node_modules[\\/]/.test(classAbs)) throw httpError(400, 'node_modules files are not inspected');
  const res = angular.locate(classAbs, typeof body.className === 'string' ? body.className : null, body.element || null);
  if (!res) throw httpError(404, 'Component file not readable');
  const rel = (abs) => path.relative(root, abs).split(path.sep).join('/');
  return {
    file: rel(res.file),
    line: res.line,
    classFile: rel(res.classAbs),
    classLine: res.classLine,
    selector: res.meta ? res.meta.selector : null,
    matched: res.matched,
  };
}

function safeMcpStatus(root) {
  try {
    return mcpStore.status(root);
  } catch {
    return { active: false, clients: [] };
  }
}

function readBody(req, limit = 1e6) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) reject(httpError(413, 'Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(httpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, obj, extra) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  for (const [k, v] of Object.entries(extra || {})) res.setHeader(k, v);
  res.end(JSON.stringify(obj));
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+|localhost)$/;

function header(headers, name) {
  if (!headers) return undefined;
  return typeof headers.get === 'function' ? headers.get(name) : headers[name];
}

/** Every hop of the request comes from this machine (dev-server proxies put the browser's address in x-forwarded-for). */
function fromThisComputer(remote, headers) {
  // Behind a dev-server proxy (Next.js rewrites, the Angular CLI proxy) the socket is always local: the browser's
  // address is in x-forwarded-for. Every hop must be local, so a forged first entry can't pass as this computer.
  const fwd = String(header(headers, 'x-forwarded-for') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const from = [...fwd, remote].filter(Boolean);
  // No address known at all (an adapter that can't see the socket): not proven local.
  return from.length > 0 && from.every((a) => LOOPBACK.test(a));
}

const truthy = (v) => /^(1|true)$/i.test(String(v || ''));

/** Hostname of a Host / X-Forwarded-Host value ("localhost:5173", "[::1]:3000") in lower case, or null. */
function hostnameOf(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return null;
  const m = /^\[([0-9a-f:.]+)\](?::\d+)?$/.exec(v) || /^([^:\s/]+)(?::\d+)?$/.exec(v);
  return m ? m[1] : null;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-f:.]*:[0-9a-f:.]*$/;
const isLoopbackName = (h) => h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || h === '::1';

/**
 * Host names the dev backend answers to. DNS rebinding points an attacker's domain at 127.0.0.1, which makes their
 * page same-origin with the dev server, so the browser sends our x-sourcepeek header without a CORS check. Such a
 * request still carries the attacker's domain in Host. Allowed: localhost (and *.localhost), IP addresses (they
 * can't be rebound — `vite --host` on the LAN keeps working), and names listed in SOURCEPEEK_ALLOWED_HOSTS
 * (comma separated; a leading dot allows subdomains: ".example.test").
 */
function allowedHost(root, hostname) {
  if (!hostname) return false;
  if (isLoopbackName(hostname) || IPV4.test(hostname) || IPV6.test(hostname)) return true;
  const extra = String(readEnv(root, 'SOURCEPEEK_ALLOWED_HOSTS') || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return extra.some((e) => (e.startsWith('.') ? hostname === e.slice(1) || hostname.endsWith(e) : hostname === e));
}

/**
 * Dev requests must name an allowed host (Host and, behind a proxy, X-Forwarded-Host), and the page that sent them
 * (Origin, when the browser sets it) must be the dev server itself. Returns a reason when not, else null.
 */
function devHostProblem(root, headers) {
  const hosts = [header(headers, 'host'), ...String(header(headers, 'x-forwarded-host') || '').split(',')]
    .map((h) => String(h || '').trim().toLowerCase())
    .filter(Boolean);
  if (!hosts.length) return 'no Host header';
  for (const h of hosts) if (!allowedHost(root, hostnameOf(h))) return `host "${h}" is not allowed (add it to SOURCEPEEK_ALLOWED_HOSTS)`;
  const origin = header(headers, 'origin');
  if (origin === undefined || origin === null || origin === '') return null;
  let o;
  try {
    o = new URL(String(origin));
  } catch {
    return 'invalid Origin';
  }
  if (o.protocol !== 'http:' && o.protocol !== 'https:') return `origin "${origin}" is not allowed`;
  const oName = o.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!allowedHost(root, oName)) return `origin "${origin}" is not allowed`;
  // Same host as the request, or both on this computer (a dev-server proxy forwarding localhost:3000 → 127.0.0.1:41xxx).
  const oHost = o.host.toLowerCase();
  const same = hosts.some((h) => h === oHost || hostnameOf(h) === oName);
  if (!same && !(isLoopbackName(oName) && hosts.every((h) => isLoopbackName(hostnameOf(h))))) return `origin "${origin}" does not match the dev server`;
  return null;
}

/**
 * Other devices on the network (`vite --host`, `next dev` listening on all interfaces) may only use the dev backend
 * when SOURCEPEEK_ALLOW_REMOTE=1 (or SOURCEPEEK_ALLOW_REMOTE_EDITS=1) is set: it reads source files and spends
 * your AI credits.
 */
function remoteAllowed(root) {
  return truthy(readEnv(root, 'SOURCEPEEK_ALLOW_REMOTE')) || truthy(readEnv(root, 'SOURCEPEEK_ALLOW_REMOTE_EDITS'));
}

/**
 * Writing source code is only allowed on a local dev server: never in production builds,
 * never on Vercel/CI, and only for requests coming from this machine.
 */
function editPermission(root, dev, remote, headers) {
  if (!dev || process.env.NODE_ENV === 'production') return { ok: false, reason: 'Apply to code only works on your local dev server.' };
  if (process.env.VERCEL || process.env.NOW_REGION) return { ok: false, reason: 'Apply to code is disabled on Vercel.' };
  if (/^(0|false|off)$/i.test(String(readEnv(root, 'SOURCEPEEK_EDITS') || ''))) return { ok: false, reason: 'Apply to code is disabled (SOURCEPEEK_EDITS=0).' };
  const allowRemote = truthy(readEnv(root, 'SOURCEPEEK_ALLOW_REMOTE_EDITS'));
  if (!allowRemote && !fromThisComputer(remote, headers)) {
    return { ok: false, reason: 'Apply to code only accepts requests from this computer. Set SOURCEPEEK_ALLOW_REMOTE_EDITS=1 to allow other devices.' };
  }
  return { ok: true };
}

const REPORT_DIR = path.join('.sourcepeek', 'reports');
const MAX_REPORT_SHOTS = 50;
const MAX_SHOT_BYTES = 12 * 1024 * 1024;

/**
 * Bug report screenshot → <root>/.sourcepeek/reports/<name>.png, so the Markdown can link to it and an editor or AI
 * agent can open it. The folder ignores itself in git. Local dev server only; the 50 newest are kept.
 */
function saveReportShot(root, dev, remote, headers, body) {
  if (!dev || process.env.NODE_ENV === 'production') throw httpError(403, 'Screenshots are only saved by the local dev server.');
  if (!fromThisComputer(remote, headers)) throw httpError(403, 'Screenshots are only saved for requests from this computer.');
  if (typeof body.data !== 'string' || !body.data) throw httpError(400, 'data is required');
  const buf = Buffer.from(body.data, 'base64');
  if (buf.length > MAX_SHOT_BYTES) throw httpError(413, 'Screenshot too large');
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw httpError(400, 'Not a PNG image');
  const base = String(body.name || 'report').replace(/\.png$/i, '').replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '').slice(0, 80) || 'report';
  const dir = path.join(root, REPORT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(root, '.sourcepeek', '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '# Sourcepeek bug-report screenshots — local only\n*\n');
  let file = path.join(dir, base + '.png');
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${base}-${i}.png`);
  fs.writeFileSync(file, buf);
  try {
    const shots = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.png'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of shots.slice(MAX_REPORT_SHOTS)) fs.unlinkSync(path.join(dir, old.f));
  } catch {}
  return { path: path.relative(root, file).split(path.sep).join('/'), absPath: file };
}

function publicIntent(want) {
  return { kind: want.kind, label: want.reorder && want.kind === 'style' ? 'Reorder' : intent.KIND_LABEL[want.kind], reorder: Boolean(want.reorder), source: want.source, reason: want.reason || '' };
}

function editContextSafe(root, body) {
  try {
    return editContext(root, body).styling;
  } catch {
    return null;
  }
}

function parseCallSite(v) {
  const m = typeof v === 'string' && v.match(/^(.*):(\d+)$/);
  return m ? { file: m[1], line: Number(m[2]) } : null;
}

/**
 * Decide what kind of change was asked for: the user's explicit choice, then the rule-based classifier,
 * then (only when the rules are unsure) a small model call. Never throws.
 */
async function resolveIntent(root, body, mode) {
  const forced = typeof body.kind === 'string' && intent.KINDS.has(body.kind) ? body.kind : null;
  const rules = intent.classify(body.instruction);
  if (forced) {
    const from = { preview: ['preview', 'from the CSS preview'], a11y: ['a11y', 'accessibility fix'] }[body.kindSource] || ['user', 'chosen by you'];
    return { kind: forced, reorder: forced === 'style' && Boolean(rules.reorder), source: from[0], reason: from[1] };
  }
  if (rules.confident) return { kind: rules.kind, reorder: Boolean(rules.reorder), source: 'rules', reason: rules.reason };
  try {
    const guess = await ai.classify(root, body);
    if (guess) return { kind: guess.kind, reorder: Boolean(rules.reorder), source: 'ai', reason: guess.reason || rules.reason };
  } catch {}
  // Unsure and no model answer: preview stays visual; a code edit gets the permissive (no new files) kind.
  return { kind: rules.kind || (mode === 'preview' ? 'style' : 'mixed'), reorder: Boolean(rules.reorder), source: 'rules', reason: rules.reason };
}

/** Files + styling profile + new-file conventions for the clicked element. */
function editContext(root, body) {
  const call = parseCallSite(body.callSite);
  const files = edit.editableFiles(root, body.file, call && call.file);
  const styling = intent.detectStyling(root, files, { line: Number(body.line) || 1, tag: body.selected && body.selected.tag });
  return { files, styling };
}

function publicStyling(styling) {
  return styling
    ? {
        primary: styling.primary,
        label: styling.label,
        element: styling.element ? { kind: styling.element.kind, note: styling.element.note, file: styling.element.definedIn || null, line: styling.element.line || null } : null,
        systems: styling.systems,
      }
    : null;
}

async function runEdit(root, body, want) {
  if (typeof body.instruction !== 'string' || !body.instruction.trim()) throw httpError(400, 'Describe the change you want');
  const { files, styling } = editContext(root, body);
  const kind = want && want.kind ? want.kind : 'mixed';
  const allowCreate = kind === 'component' || kind === 'page';
  if (angular.isAngular(root)) await angular.prepare(root); // loads @angular/compiler for the template syntax check
  let conventions = { dirs: [], rules: [] };
  let routing = null;
  let maxDepth = 3;
  if (kind === 'page') {
    // A page lives where the router looks for pages (and may need a router entry), not next to the clicked component.
    routing = routes.detect(root);
    if (!routing.ok) throw httpError(422, routing.reason);
    for (const rf of routing.routerFiles) {
      const existing = files.find((f) => f.abs === rf);
      if (existing) {
        if (existing.role === 'component') continue;
        existing.role = 'router';
      } else {
        const f = edit.extraFile(root, rf, 'router');
        if (f) files.push(f);
      }
    }
    conventions = { dirs: routing.dirs, rules: [...routing.rules, ...intent.pageComponentRules(root, files, styling)] };
    maxDepth = 5;
  } else if (allowCreate) {
    conventions = intent.componentConventions(root, files, styling);
  }
  // Theme / site-wide: the files that define the look of the whole app become editable.
  let themeRules = null;
  const global = kind === 'theme' || (kind === 'style' && body.scope === 'global');
  if (global) {
    const theme = project.themeFiles(root);
    let total = files.reduce((n, f) => n + f.content.length, 0);
    for (const t of theme) {
      const existing = files.find((f) => f.abs === t.abs);
      if (existing) {
        if (existing.role === 'reference') existing.role = 'theme';
        continue;
      }
      const f = edit.extraFile(root, t.abs, 'theme');
      if (f && total + f.content.length <= 180000) {
        files.push(f);
        total += f.content.length;
      }
    }
    // The root layout / entry (body classes, global style imports, ThemeProvider) — when nothing else is there to edit,
    // or when the theme lives in a provider.
    for (const e of project.entryFiles(root).slice(0, 2)) {
      if (files.some((f) => f.abs === e)) continue;
      const f = edit.extraFile(root, e, 'entry');
      if (f && f.content.length < 30000 && total + f.content.length <= 190000) {
        files.push(f);
        total += f.content.length;
      }
    }
    themeRules = intent.themeRules(root, safeStats(root), theme, styling);
  }
  // New markup: work out WHERE it belongs (page vs layout, which box, which file).
  let placementText = null;
  if (['code', 'mixed', 'component'].includes(kind)) {
    try {
      placementText = placement.plan(root, body, files).text;
    } catch {}
  }
  const plan = {
    kind,
    reorder: Boolean(want && want.reorder),
    styling,
    conventions,
    allowCreate,
    routing,
    framework: verify.frameworkRules(root, files),
    theme: themeRules,
    placement: placementText,
    project: kind === 'style' ? null : projectSummary(root, routing),
  };
  let problem = null;
  let lastSummary = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await ai.edit(root, body, files, plan, problem);
    if (res.edits === null) {
      problem = res.truncated
        ? 'Your reply was cut off because it was too long. Use small, targeted edits (only the lines that change plus 1-2 lines of context) instead of rewriting large blocks.'
        : 'Your reply was not valid JSON. Reply with the JSON object only.';
      continue;
    }
    lastSummary = res.summary;
    const creates = allowCreate ? res.creates || [] : [];
    if (!res.edits.length && !creates.length) {
      if (res.creates && res.creates.length && !allowCreate) {
        problem = 'You may not create files for this change. Edit the existing files only.';
        continue;
      }
      throw httpError(422, res.summary || 'The AI did not propose any change. Try describing it differently.');
    }
    let changes;
    try {
      changes = [...(res.edits.length ? edit.applyEdits(files, res.edits, Number(body.line) || null) : []), ...edit.applyCreates(root, creates, conventions.dirs, maxDepth)];
      // Vue: a <style> block written inside <template> is moved out to the top level of the SFC.
      changes = edit.normalizeVueChanges(changes);
      // Change with AI never adds comments: drop any the model wrote (existing comments are kept).
      changes = nocomments.stripChanges(changes);
      if (!changes.length) throw httpError(422, 'The proposed edits would not change anything.');
    } catch (err) {
      problem = err.message;
      continue;
    }
    const unchecked = [];
    const broken = [];
    for (const c of changes) {
      const r = edit.syntaxCheck(root, c.abs, c.after);
      if (!r.checked) unchecked.push(c.rel);
      if (!r.ok) broken.push(`${c.rel}: ${r.error}`);
    }
    if (broken.length) {
      problem = `The edited code does not parse — ${broken.join('; ')}`;
      continue;
    }
    // Parses, but would it run? Missing imports, wrong export, 'use client', deleted markup.
    const issues = [...verify.verify(root, changes, { kind, instruction: body.instruction }), ...(routing ? routes.check(routing, changes) : [])];
    if (issues.length) {
      problem = `The change would break the app — ${issues.join(' ')}`;
      continue;
    }
    return { changes: edit.withDiffs(changes), summary: res.summary, unchecked, styling };
  }
  // "Apply to code" on a live CSS preview must land: when the AI could not map it onto the component's styling, the
  // exact previewed CSS goes into the app's global stylesheet (same look, plain CSS every bundler loads).
  const fallback = previewFallback(root, body, kind);
  if (fallback) return fallback;
  throw httpError(422, `Nothing was written. ${problem || 'The AI could not produce a valid change.'}${lastSummary ? ` (AI: ${lastSummary})` : ''}`);
}

function safeStats(root) {
  try {
    return project.stats(root);
  } catch {
    return null;
  }
}

/** Framework, styling and a compact tree of the project — so the model knows where things belong. */
function projectSummary(root, routing) {
  try {
    const st = project.stats(root);
    let router = routing;
    if (!router) {
      try {
        router = routes.detect(root);
      } catch {}
    }
    const comps = project.componentDirs(root).map((d) => path.relative(root, d).split(path.sep).join('/') + '/');
    return [
      `Routing: ${router && router.ok ? router.label : 'none detected (single page)'}.`,
      `Styling used across the project: ${st.summary}${st.tailwind ? ` (Tailwind v${st.tailwindMajor})` : ''}.`,
      comps.length ? `Shared components folder: ${comps.join(', ')}.` : '',
      'Tree (folder/  files):',
      project.tree(root, 110),
    ]
      .filter(Boolean)
      .join('\n');
  } catch {
    return null;
  }
}

/** Plain CSS from a live preview, appended to the global stylesheet. Returns a runEdit() result or null. */
function previewFallback(root, body, kind) {
  if (typeof body.previewCss !== 'string' || !body.previewCss.trim() || !['style', 'theme'].includes(kind)) return null;
  const css = nocomments.stripAll('x.css', String(body.previewCss).replace(/\s*!important/g, '')).replace(/\n{3,}/g, '\n\n').trim();
  if (!css) return null;
  const done = (changes, where) => {
    for (const c of changes) {
      const check = edit.syntaxCheck(root, c.abs, c.after);
      if (!check.ok) return null;
    }
    return {
      changes: edit.withDiffs(changes),
      summary: `The previewed CSS could not be mapped onto the component's own styling, so it was added as-is to ${where} — the page looks exactly like the preview.`,
      unchecked: [],
      styling: null,
      fallback: true,
    };
  };
  const withNl = (content, text) => {
    const crlf = /\r\n/.test(content);
    return crlf ? text.replace(/\r?\n/g, '\r\n') : text;
  };

  // 1. the global stylesheet the app loads
  const sheet = project.globalStylesheet(root);
  const f = sheet && edit.extraFile(root, sheet, 'theme');
  if (f) {
    const r = done([{ abs: f.abs, rel: f.rel, role: f.role, before: f.content, after: withNl(f.content, `${f.content.replace(/\s*$/, '')}\n\n${css}\n`) }], `the global stylesheet ${f.rel}`);
    if (r) return r;
  }

  // 2. styled-components / Emotion global styles: inside the createGlobalStyle`…` template
  const glob = project.themeFiles(root, 12).find((t) => t.kind === 'global-styles');
  const g = glob && edit.extraFile(root, glob.abs, 'theme');
  if (g) {
    const m = /createGlobalStyle\s*`/.exec(g.content);
    if (m) {
      const start = m.index + m[0].length;
      let i = start;
      for (; i < g.content.length; i++) {
        if (g.content[i] === '\\') i++;
        else if (g.content[i] === '`') break;
        else if (g.content[i] === '$' && g.content[i + 1] === '{') {
          let depth = 0;
          for (; i < g.content.length; i++) {
            if (g.content[i] === '{') depth++;
            else if (g.content[i] === '}' && --depth === 0) break;
          }
        }
      }
      if (i < g.content.length) {
        const inner = css.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
        const indented = inner.split('\n').map((l) => (l ? '  ' + l : l)).join('\n');
        const before = g.content.slice(0, i).replace(/\s*$/, '');
        const r = done([{ abs: g.abs, rel: g.rel, role: g.role, before: g.content, after: withNl(g.content, `${before}\n\n${indented}\n${g.content.slice(i)}`) }], `the global styles in ${g.rel}`);
        if (r) return r;
      }
    }
  }

  // 3. nothing global exists yet: a new global.css next to the app entry, imported by it
  const entry = project.entryFiles(root).find((e) => /\.(tsx|jsx|ts|js|mjs)$/.test(e) && !/_document\./.test(e));
  const e = entry && edit.extraFile(root, entry, 'entry');
  if (e) {
    const abs = path.join(path.dirname(e.abs), 'global.css');
    if (!fs.existsSync(abs)) {
      const imports = [...e.content.matchAll(/^import\b[^\n]*\n/gm)];
      const at = imports.length ? imports[imports.length - 1].index + imports[imports.length - 1][0].length : /^(['"])use client\1;?\n/.test(e.content) ? e.content.indexOf('\n') + 1 : 0;
      const after = `${e.content.slice(0, at)}import './global.css';\n${e.content.slice(at)}`;
      const relNew = path.relative(root, abs).split(path.sep).join('/');
      const r = done(
        [
          { abs, rel: relNew, role: 'new', created: true, before: null, after: `${css}\n` },
          { abs: e.abs, rel: e.rel, role: e.role, before: e.content, after: withNl(e.content, after) },
        ],
        `a new global stylesheet ${relNew} (imported by ${e.rel})`
      );
      if (r) return r;
    }
  }
  return null;
}

/** Run an edit and either write it or keep it as a proposal. Shared by /ai/edit and /ai/change. */
async function editAndMaybeWrite(root, body, want, review) {
  const { changes, summary, unchecked, styling, fallback } = await runEdit(root, body, want);
  const st = await ai.status(root);
  const via = st.ok ? `${st.label} · ${st.model}` : null;
  const request = String(typeof body.label === 'string' && body.label.trim() ? body.label : body.instruction).trim().slice(0, 500);
  const meta = { kind: want.kind, styling: want.kind === 'theme' ? 'theme files' : styling ? styling.label : null };
  const pubStyling = publicStyling(styling);
  if (review) {
    const id = edit.propose(request, summary, changes, meta, root);
    return { pending: true, id, via, unchecked, fallback: Boolean(fallback), styling: pubStyling, entry: edit.publicEntry({ id, at: new Date().toISOString(), request, summary, ...meta, files: changes }) };
  }
  // The AI call takes a while: if a file was saved in the meantime (editor, formatter, another change), rebase onto
  // it instead of overwriting it with the stale snapshot the AI worked on.
  const fresh = edit.rebaseOntoDisk(root, changes);
  edit.writeAll(fresh.changes);
  const entry = edit.record(root, request, summary, fresh.changes, meta);
  return { pending: false, via, unchecked, fallback: Boolean(fallback), styling: pubStyling, rebased: fresh.rebased, entry: edit.publicEntry(entry) };
}

/**
 * Request gate. Returns null when the request may go on, or the response to send instead.
 * Dev servers: the Host / Origin check (against DNS rebinding), and requests from other devices only when allowed.
 * Production: the token.
 */
async function gate({ method, route, headers, getBody, root, dev, remote, https }) {
  if (!enabled(root, { dev })) return [404, { error: 'Not found' }];
  if (dev) {
    const problem = devHostProblem(root, headers);
    if (problem) return [403, { error: `Forbidden: ${problem}.` }];
    // /health stays open (it tells the page what is allowed); it only shows details to this computer.
    if (route !== '/health' && !fromThisComputer(remote, headers) && !remoteAllowed(root)) {
      return [403, { error: 'Sourcepeek only answers requests from this computer. Set SOURCEPEEK_ALLOW_REMOTE=1 to allow other devices.', remote: true }];
    }
    return null;
  }
  const t = prodToken(root);
  if (!t.token) {
    auth.warnOnce(t.error);
    return [404, { error: 'Not found' }];
  }
  if (route === '/auth' || route === '/auth/logout') {
    if (method !== 'POST') return [405, { error: 'Method not allowed' }];
    if (header(headers, 'x-sourcepeek') !== '1') return [403, { error: 'Forbidden' }];
    if (route === '/auth/logout') return auth.logout(headers, https);
    let body = {};
    try {
      body = (await getBody(4096)) || {};
    } catch {}
    return auth.login(t.token, body, { remote, headers, https });
  }
  if (auth.authorized(t.token, headers)) return null;
  // Locked: say only that Sourcepeek is here and needs the token — no paths, no AI provider, nothing else.
  if (method === 'GET' && route === '/health') return [200, { ok: true, name: 'sourcepeek', locked: true }];
  return [401, { error: 'Sourcepeek is locked on this deployment. Unlock it with SOURCEPEEK_TOKEN.', locked: true }];
}

async function handle({ method, route, headers, getBody, root, dev = false, remote = null, https = false }) {
  try {
    const blocked = await gate({ method, route, headers, getBody, root, dev, remote, https });
    if (blocked) return blocked;

    if (method === 'GET' && route === '/health') {
      if (dev && !fromThisComputer(remote, headers) && !remoteAllowed(root)) {
        return [200, { ok: true, name: 'sourcepeek', prod: false, remoteBlocked: true, canEdit: false, editReason: 'Sourcepeek only answers requests from this computer. Set SOURCEPEEK_ALLOW_REMOTE=1 to allow other devices.' }];
      }
      const st = await ai.status(root);
      const perm = editPermission(root, dev, remote, headers);
      return [
        200,
        {
          ok: true,
          name: 'sourcepeek',
          root,
          sep: path.sep,
          ai: st.ok,
          aiProvider: st.ok ? st.label : null,
          aiModel: st.ok ? st.model : null,
          canEdit: perm.ok,
          editReason: perm.ok ? null : perm.reason,
          ide: readEnv(root, 'SOURCEPEEK_IDE') || null,
          runId: RUN_ID,
          prod: !dev,
          mcp: dev ? safeMcpStatus(root).active : false,
          share: dev && fromThisComputer(remote, headers),
        },
      ];
    }

    // Is a coding agent (npx sourcepeek mcp) running for this project? The page only shares its state while one is.
    if (method === 'GET' && route === '/mcp/status') {
      if (!dev) return [404, { error: 'Not found' }];
      return [200, safeMcpStatus(root)];
    }

    // "$" in the More view: what the current AI model has cost so far (tracked locally from token usage).
    if (method === 'GET' && route === '/ai/usage') {
      return [200, usage.summary(root, await providers.resolve(root))];
    }

    if (method !== 'POST') return [405, { error: 'Method not allowed' }];
    const h = headers && (typeof headers.get === 'function' ? headers.get('x-sourcepeek') : headers['x-sourcepeek']);
    if (h !== '1') return [403, { error: 'Forbidden' }];

    const body = (await getBody(route === '/report/screenshot' ? 20e6 : route.startsWith('/mcp/') ? 3e6 : undefined)) || {};

    if (route === '/report/screenshot') {
      return [200, saveReportShot(root, dev, remote, headers, body)];
    }

    // The browser shares what you inspected (and the page's errors / requests / vitals) with coding agents over MCP.
    if (route === '/mcp/selection' || route === '/mcp/page') {
      if (!dev) throw httpError(403, 'Sharing with coding agents only works on your local dev server.');
      if (!fromThisComputer(remote, headers)) throw httpError(403, 'Sharing with coding agents only accepts requests from this computer.');
      if (route === '/mcp/selection') return [200, { ok: true, saved: mcpStore.saveSelection(root, body.selection), agent: safeMcpStatus(root) }];
      mcpStore.savePage(root, body.page);
      return [200, { ok: true, agent: safeMcpStatus(root) }];
    }

    if (route === '/ai/usage/reset') {
      const p = await providers.resolve(root);
      usage.reset(root, p);
      return [200, usage.summary(root, p)];
    }

    if (route === '/context') {
      return [200, await fileContext(root, body.file, body.line)];
    }

    // Requests this component (and the hooks / API modules it imports) can make — found in the source code.
    if (route === '/network') {
      return [200, network.scan(root, scriptFile(root, resolveSource(root, body.file)))];
    }

    // localStorage / sessionStorage keys and Cache Storage caches this component (and what it imports) uses.
    if (route === '/storage') {
      return [200, storage.scan(root, scriptFile(root, resolveSource(root, body.file)))];
    }

    // Names of a React component's state hooks, in call order.
    if (route === '/state-names') {
      if (typeof body.componentName !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(body.componentName)) throw httpError(400, 'componentName is required');
      const abs = resolveSource(root, body.file);
      return [200, hookNames(fs.readFileSync(abs, 'utf8'), body.componentName)];
    }

    // Web Vitals: where the handler of a slow interaction (onClick={toggle} at file:line) is declared.
    if (route === '/lookup/handler') {
      const abs = resolveSource(root, body.file);
      const events = Array.isArray(body.events) ? body.events.filter((e) => typeof e === 'string' && /^[a-z]{2,20}$/.test(e)).slice(0, 6) : [];
      return [200, lookup.handlerAt(root, abs, Number(body.line) || 1, events)];
    }

    // Value provenance: the expression that feeds a prop at a call-site (price={item.price}).
    if (route === '/lookup/attr') {
      const abs = resolveSource(root, body.file);
      if (typeof body.prop !== 'string') throw httpError(400, 'prop is required');
      return [200, lookup.attrAt(root, abs, Number(body.line) || 0, body.prop, typeof body.tag === 'string' ? body.tag : null)];
    }

    if (route === '/angular/locate') {
      return [200, angularLocate(root, body)];
    }

    if (route === '/i18n') {
      if (typeof body.text !== 'string') throw httpError(400, 'text is required');
      const named = (Array.isArray(body.files) ? body.files : [body.file]).filter((f) => typeof f === 'string' && f).slice(0, 3);
      return [200, i18n.lookup(root, body.text, acceptedSources(root, named))];
    }

    if (route === '/ai/edit' || route.startsWith('/edit/')) {
      const perm = editPermission(root, dev, remote, headers);
      if (!perm.ok) throw httpError(403, perm.reason);

      if (route === '/edit/history') return [200, { entries: edit.history(root) }];
      if (route === '/edit/undo') return [200, { entry: edit.undo(root, body.id, Boolean(body.force)) }];
      if (route === '/edit/commit') {
        const entry = edit.commit(root, body.id);
        return [200, { entry: edit.publicEntry(entry), rebased: entry.rebased || [] }];
      }
      if (route === '/edit/discard') {
        edit.discard(body.id, root);
        return [200, { ok: true }];
      }
      if (route === '/ai/edit') {
        if (typeof body.instruction !== 'string' || !body.instruction.trim()) throw httpError(400, 'Describe the change you want');
        const want = await resolveIntent(root, body, 'code');
        return [200, { ...(await editAndMaybeWrite(root, body, want, Boolean(body.review))), intent: publicIntent(want) }];
      }
      return [404, { error: 'Not found' }];
    }

    // One entry point for both buttons. It works out what kind of change this is, then:
    //   Preview + style            → CSS injected live (nothing written)
    //   Preview + code/component   → a diff proposal (nothing written until "Apply to code")
    //   Apply to code + any kind   → edit in the right place for the project's styling system, new files for new components
    if (route === '/ai/change') {
      if (typeof body.instruction !== 'string' || !body.instruction.trim()) throw httpError(400, 'Describe the change you want');
      const mode = body.mode === 'code' ? 'code' : 'preview';
      const perm = editPermission(root, dev, remote, headers);
      if (mode === 'code' && !perm.ok) throw httpError(403, perm.reason);
      const want = await resolveIntent(root, body, mode);
      const pub = publicIntent(want);

      if (mode === 'preview' && (want.kind === 'style' || want.kind === 'theme' || !perm.ok)) {
        let styling = null;
        try {
          styling = editContext(root, body).styling;
        } catch {}
        const source = typeof body.file === 'string' && body.file ? readSource(root, body.file) : null;
        const { css, summary } = await ai.style(root, { ...body, scope: want.kind === 'theme' ? 'global' : body.scope, stylingLabel: styling ? styling.label : null }, source);
        if (!css) throw httpError(422, summary || 'The AI could not turn that request into CSS — try naming the element more specifically.');
        const notice =
          want.kind !== 'style' && want.kind !== 'theme'
            ? `This request needs code changes (${intent.KIND_LABEL[want.kind].toLowerCase()}), which a CSS preview can't show. Only the visual part is previewed. ${perm.reason || ''}`.trim()
            : null;
        return [200, { action: 'css', intent: pub, styling: publicStyling(styling), css, summary, notice }];
      }

      const result = await editAndMaybeWrite(root, body, want, mode === 'preview' ? true : Boolean(body.review));
      const notice =
        mode === 'preview'
          ? `${intent.KIND_LABEL[want.kind]} — CSS can't preview this, so here is the code change instead. Nothing is written until you apply it.`
          : null;
      return [200, { action: result.pending ? 'proposal' : 'written', intent: pub, notice, ...result }];
    }

    // Network → Randomise: realistic fake response data written by the AI, from the known shapes and the code that
    // calls / serves the endpoint. Nothing is written; the browser installs it as a mock.
    if (route === '/ai/mock-data') {
      if (typeof body.url !== 'string' || !body.url) throw httpError(400, 'url is required');
      const files = mockDataFiles(root, body);
      const { value, summary } = await ai.mockData(root, body, files);
      const st = await ai.status(root);
      return [200, { body: value, summary, files: files.map((f) => f.rel), via: st.ok ? `${st.label} · ${st.model}` : null }];
    }

    // How the clicked element is styled — shown in the panel so you know where changes will land.
    if (route === '/styling') {
      const styling = editContextSafe(root, body);
      return [200, { styling: publicStyling(styling) }];
    }

    if (route === '/ai/style') {
      if (typeof body.instruction !== 'string' || !body.instruction.trim()) {
        throw httpError(400, 'Describe the style change you want to try');
      }
      const source = typeof body.file === 'string' && body.file ? readSource(root, body.file) : null;
      const { css, summary } = await ai.style(root, body, source);
      if (!css) throw httpError(422, summary || 'The AI could not turn that request into CSS — try naming the element more specifically.');
      return [200, { css, summary }];
    }

    const aiRoute = route.match(/^\/ai\/(summarize|errors|refactor)$/);
    if (aiRoute) {
      if (typeof body.componentName !== 'string' || typeof body.file !== 'string') {
        throw httpError(400, 'componentName and file are required');
      }
      const source = readSource(root, body.file);
      const text = await ai[aiRoute[1]](root, body, source);
      const st = await ai.status(root);
      return [200, { text, usedSource: Boolean(source), via: st.ok ? `${st.label} · ${st.model}` : null }];
    }

    return [404, { error: 'Not found' }];
  } catch (err) {
    return [err.status || 500, { error: err.message || String(err), ...(err.extra || {}) }];
  }
}

function routeFromUrl(url) {
  const m = String(url || '').split('?')[0].match(/\/(?:__sourcepeek|api\/sourcepeek)(\/.*)$/);
  return m ? m[1] : null;
}

function createHandler(opts) {
  const getRoot = typeof opts.root === 'function' ? opts.root : () => opts.root;
  const dev = Boolean(opts.dev);

  return async function sourcepeekMiddleware(req, res, next) {
    const url = (req.url || '').split('?')[0];
    if (!url.startsWith(PREFIX + '/')) return next ? next() : send(res, 404, { error: 'Not found' });
    const [status, obj, extra] = await handle({
      method: req.method,
      route: url.slice(PREFIX.length),
      headers: req.headers,
      getBody: (limit) => readBody(req, limit),
      root: getRoot(),
      dev,
      remote: req.socket ? req.socket.remoteAddress : null,
      https: Boolean(req.socket && req.socket.encrypted),
    });
    return send(res, status, obj, extra);
  };
}

module.exports = { hookNames, createHandler, handle, routeFromUrl, readBody, send, PREFIX, _devHostProblem: devHostProblem, _fromThisComputer: fromThisComputer };
