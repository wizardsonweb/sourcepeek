'use strict';
// Text → translation key. Given the visible text of an element, find which translation file
// (and key) it comes from, and where the component uses that key.

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.nuxt', '.svelte-kit', '.turbo', '.vercel', 'dist', 'build', 'out', 'coverage', '.cache']);
const LOCALE_DIR = /(^|[\\/])(locales?|i18n|lang|langs|languages|messages|translations?|intl|dictionar(y|ies))([\\/]|$)/i;
const LOCALE_FILE = /^(messages|translations?|strings|common|[a-z]{2}([-_][A-Za-z]{2,4})?)(\.[\w-]+)?\.(json|ya?ml)$/i;
const MAX_FILES = 400;
const MAX_SIZE = 1024 * 1024;
const TTL = 10000;

let cache = null;

function walk(dir, depth, out) {
  if (depth > 7 || out.length >= MAX_FILES) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(p, depth + 1, out);
    } else if (/\.(json|ya?ml)$/i.test(e.name) && (LOCALE_DIR.test(dir) || LOCALE_FILE.test(e.name)) && !/^(package|tsconfig|jsconfig|composer|components)(-lock)?\.json$/i.test(e.name)) {
      out.push(p);
    }
  }
}

function flatten(obj, prefix, out) {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (Array.isArray(obj)) {
    obj.forEach((v, i) => flatten(v, `${prefix}.${i}`, out));
  } else if (typeof obj === 'string') out.push([prefix, obj]);
}

// Minimal YAML reader: nested "key: value" maps, which covers most translation files.
function flattenYaml(text) {
  const out = [];
  const stack = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim() || /^\s*#/.test(raw)) return;
    const m = raw.match(/^(\s*)(["']?)([^"':#]+)\2\s*:\s*(.*)$/);
    if (!m) return;
    const indent = m[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const key = [...stack.map((s) => s.key), m[3].trim()].join('.');
    let v = m[4].trim();
    if (!v || v === '|' || v === '>') stack.push({ indent, key: m[3].trim() });
    else {
      const q = v.match(/^(["'])(.*)\1$/);
      if (q) v = q[2];
      out.push([key, v, i + 1]);
    }
  });
  return out;
}

function index(root) {
  if (cache && cache.root === root && Date.now() - cache.at < TTL) return cache.entries;
  const files = [];
  walk(root, 0, files);
  const entries = [];
  for (const file of files) {
    let text;
    try {
      if (fs.statSync(file).size > MAX_SIZE) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (/\.json$/i.test(file)) {
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        continue;
      }
      const flat = [];
      flatten(data, '', flat);
      for (const [key, value] of flat) {
        const needle = JSON.stringify(value).slice(1, -1);
        const at = text.indexOf(`"${needle}"`);
        entries.push({ file: rel, key, value, line: at === -1 ? 1 : text.slice(0, at).split('\n').length });
      }
    } else {
      for (const [key, value, line] of flattenYaml(text)) entries.push({ file: rel, key, value, line });
    }
  }
  cache = { root, at: Date.now(), entries };
  return entries;
}

const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
// "Hello {name}" / "Hello {{name}}" / "Hello %s" / "Hello $t(x)" → regexp that matches "Hello Ana"
function templateRe(value) {
  const parts = norm(value).split(/\{\{?\s*[\w.]+\s*\}?\}|%[sd]|\$t\([^)]*\)|<\/?\d+>/);
  if (parts.length < 2) return null;
  try {
    return new RegExp('^' + parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+?') + '$');
  } catch {
    return null;
  }
}

function usageInSource(root, file, key) {
  if (!file || !/\.(jsx|tsx|js|mjs|ts|vue|svelte|html)$/.test(file) || /[\\/]node_modules[\\/]/.test(file)) return null;
  try {
    const abs = path.isAbsolute(file) ? file : path.resolve(root, file);
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    const last = key.split('.').pop();
    const exact = lines.findIndex((l) => l.includes(`'${key}'`) || l.includes(`"${key}"`) || l.includes('`' + key + '`'));
    if (exact !== -1) return { line: exact + 1, exact: true };
    const partial = lines.findIndex((l) => new RegExp(`['"\`.]${last.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(l));
    return partial !== -1 ? { line: partial + 1, exact: false } : null;
  } catch {
    return null;
  }
}

function lookup(root, text, files) {
  const list = (Array.isArray(files) ? files : [files]).filter((f) => typeof f === 'string' && f).slice(0, 3);
  const t = norm(text);
  if (!t || t.length > 300) return { matches: [] };
  const entries = index(root);
  const matches = [];
  for (const e of entries) {
    const v = norm(e.value);
    if (!v) continue;
    if (v === t) matches.push({ ...e, exact: true });
    else if (/[{%$<]/.test(e.value)) {
      const re = templateRe(e.value);
      if (re && re.test(t)) matches.push({ ...e, exact: false });
    }
    if (matches.length >= 12) break;
  }
  const keys = [...new Set(matches.map((m) => m.key))];
  const usage = [];
  for (const k of keys) {
    const found = list.map((f) => ({ key: k, file: f, ...(usageInSource(root, f, k) || {}) })).filter((u) => u.line);
    const best = found.find((u) => u.exact) || found[0];
    if (best) usage.push(best);
  }
  return { matches, usage, scanned: entries.length };
}

module.exports = { lookup };
