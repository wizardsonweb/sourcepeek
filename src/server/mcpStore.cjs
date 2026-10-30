'use strict';
// What the browser shares with coding agents (Claude Code, Cursor, VS Code…) through `npx sourcepeek mcp`.
//
// The dev backend and the MCP server are different processes — the dev server is started by you, the MCP server by
// your agent — so they meet in files:
//   <project>/node_modules/.cache/sourcepeek/mcp/selection.json   the element you inspected last (+ history.json)
//   <project>/node_modules/.cache/sourcepeek/mcp/page.json        console errors, requests, Web Vitals of that tab
//   <tmp>/sourcepeek-mcp-<uid>/projects.json                      which projects shared something, and when
//   <tmp>/sourcepeek-mcp-<uid>/agent-<pid>.json                   a running MCP server (so the page knows to share)
// The temp folders are per user, mode 0700 and owner-checked (see tmpdir.cjs): /tmp is shared on Linux.
// Only the local dev server writes them, only for requests from this computer. node_modules/.cache is ignored by git
// and by every dev-server file watcher.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { privateTmpDir } = require('./tmpdir.cjs');

const HISTORY = 20;
const MAX_BYTES = 2 * 1024 * 1024;

function dataDir(root) {
  const nm = path.join(root, 'node_modules');
  if (fs.existsSync(nm)) return path.join(nm, '.cache', 'sourcepeek', 'mcp');
  return privateTmpDir('sourcepeek-mcp', crypto.createHash('sha1').update(root).digest('hex').slice(0, 12));
}

const registryDir = () => privateTmpDir('sourcepeek-mcp');

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(data, null, 1);
  if (text.length > MAX_BYTES) throw Object.assign(new Error('Snapshot too large'), { status: 413 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function touchProject(root) {
  try {
    const f = path.join(registryDir(), 'projects.json');
    const all = readJson(f, {}) || {};
    all[root] = { at: new Date().toISOString(), dir: dataDir(root) };
    for (const k of Object.keys(all)) if (Date.now() - new Date(all[k].at).getTime() > 14 * 864e5) delete all[k];
    writeJson(f, all);
  } catch {}
}

/** The browser inspected an element: becomes the current selection; a new id also goes to the history. */
function saveSelection(root, selection) {
  if (!selection || typeof selection !== 'object') throw Object.assign(new Error('selection is required'), { status: 400 });
  const dir = dataDir(root);
  const sel = { ...selection, root, savedAt: new Date().toISOString() };
  writeJson(path.join(dir, 'selection.json'), sel);
  const histFile = path.join(dir, 'history.json');
  const hist = readJson(histFile, []) || [];
  const i = hist.findIndex((h) => h.id === sel.id);
  const brief = { id: sel.id, at: sel.at, component: sel.component, file: sel.file, line: sel.line, tag: sel.element && sel.element.tag, text: sel.element && sel.element.text, url: sel.url };
  if (i >= 0) hist[i] = sel;
  else hist.unshift(sel);
  writeJson(histFile, hist.slice(0, HISTORY));
  touchProject(root);
  return brief;
}

function savePage(root, page) {
  if (!page || typeof page !== 'object') throw Object.assign(new Error('page is required'), { status: 400 });
  writeJson(path.join(dataDir(root), 'page.json'), { ...page, root, savedAt: new Date().toISOString() });
  touchProject(root);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

const within = (a, b) => {
  const r = path.relative(a, b);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
};

/** Running MCP servers that serve this project (started in it, in a parent folder, or pointed at it). */
function agents(root) {
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(registryDir()).filter((n) => /^agent-\d+\.json$/.test(n));
  } catch {}
  for (const n of names) {
    const f = path.join(registryDir(), n);
    const a = readJson(f);
    if (!a || !alive(a.pid)) {
      try {
        fs.unlinkSync(f);
      } catch {}
      continue;
    }
    if (!root || (a.root && (within(a.root, root) || within(root, a.root))) || (a.cwd && (within(a.cwd, root) || within(root, a.cwd)))) out.push(a);
  }
  return out;
}

function status(root) {
  const list = agents(root);
  return { active: list.length > 0, clients: [...new Set(list.map((a) => a.client).filter(Boolean))] };
}

// ---------- read side (the MCP server) ----------

/** Project roots to read from: --root, then the cwd, then projects that shared something recently (inside cwd first). */
function candidateRoots(cwd, explicit) {
  if (explicit) return [explicit];
  let reg = {};
  try {
    reg = readJson(path.join(registryDir(), 'projects.json'), {}) || {};
  } catch {}
  const known = Object.entries(reg)
    .map(([r, v]) => ({ root: r, at: new Date(v.at).getTime() }))
    .sort((a, b) => b.at - a.at);
  const inside = known.filter((k) => within(cwd, k.root) || within(k.root, cwd)).map((k) => k.root);
  return [...new Set([cwd, ...inside, ...known.map((k) => k.root)])];
}

function readStore(root) {
  let dir;
  try {
    dir = dataDir(root);
  } catch {
    return { root, selection: null, history: [], page: null };
  }
  return {
    root,
    selection: readJson(path.join(dir, 'selection.json')),
    history: readJson(path.join(dir, 'history.json'), []) || [],
    page: readJson(path.join(dir, 'page.json')),
  };
}

/** The freshest data among the candidate roots. */
function load(cwd, explicit) {
  let best = null;
  for (const r of candidateRoots(cwd, explicit)) {
    const s = readStore(r);
    const t = Math.max(s.selection ? new Date(s.selection.savedAt).getTime() : 0, s.page ? new Date(s.page.savedAt).getTime() : 0);
    if (!best || t > best.t) best = { ...s, t };
    if (r === cwd && t) break; // the project you're in wins when it has data
  }
  return best || { root: explicit || cwd, selection: null, history: [], page: null, t: 0 };
}

function registerAgent(info) {
  const f = path.join(registryDir(), `agent-${process.pid}.json`);
  try {
    writeJson(f, { pid: process.pid, startedAt: new Date().toISOString(), ...info });
  } catch {}
  const bye = () => {
    try {
      fs.unlinkSync(f);
    } catch {}
  };
  process.on('exit', bye);
  return { update: (patch) => writeJson(f, { ...(readJson(f) || { pid: process.pid }), ...patch }), remove: bye };
}

module.exports = { saveSelection, savePage, status, load, registerAgent, dataDir, agents };
