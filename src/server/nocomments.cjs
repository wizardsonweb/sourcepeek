'use strict';
// "Change with AI" must never add comments to the user's code or CSS. The prompts already forbid it; this is the
// guarantee. After the AI's edits are applied, every comment in the new file content that was not already in the
// file before is removed. Comments the developer wrote stay exactly where they are.
//
// Comments are found with real parsers where it matters (Babel for JS/TS, so strings, regexes, template literals
// and JSX text such as "http://…" are never mistaken for comments) and with small string-aware scanners for CSS,
// SCSS, Less, Sass and HTML. Vue / Svelte files are split into their <script>, <style> and markup parts.
// CSS inside styled-components / emotion templates and Angular inline templates / styles are covered too.

const { parse } = require('@babel/parser');

const STYLED_TAGS = new Set(['css', 'keyframes', 'createGlobalStyle', 'injectGlobal', 'tw', 'styled', 'global']);

function babelPlugins(file) {
  if (/\.tsx$/.test(file)) return ['jsx', 'typescript', 'decorators-legacy'];
  if (/\.(ts|mts|cts)$/.test(file)) return ['typescript', 'decorators-legacy'];
  return ['jsx', 'decorators-legacy'];
}

function isStyledTag(node) {
  if (!node) return false;
  if (node.type === 'Identifier') return STYLED_TAGS.has(node.name);
  if (node.type === 'MemberExpression') return isStyledTag(node.object);
  if (node.type === 'CallExpression') return isStyledTag(node.callee);
  return false;
}

const propName = (p) => p && p.key && (p.key.type === 'Identifier' ? p.key.name : p.key.type === 'StringLiteral' ? p.key.value : null);

/** Comment ranges [{start, end}] inside CSS / SCSS / Less / Sass text, offset by `base`. */
function cssComments(code, base = 0, lineComments = false) {
  const out = [];
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'") {
      const q = c;
      for (i++; i < code.length && code[i] !== q && code[i] !== '\n'; i++) if (code[i] === '\\') i++;
    } else if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      const stop = end === -1 ? code.length : end + 2;
      out.push({ start: base + i, end: base + stop });
      i = stop - 1;
    } else if (lineComments && c === '/' && code[i + 1] === '/' && code[i - 1] !== ':') {
      let end = code.indexOf('\n', i);
      if (end === -1) end = code.length;
      out.push({ start: base + i, end: base + end });
      i = end - 1;
    } else if ((c === 'u' || c === 'U') && /^url\(/i.test(code.slice(i, i + 4))) {
      // url(http://…) — unquoted URLs contain "//" that is not a comment
      const close = code.indexOf(')', i);
      if (close !== -1 && !/["']/.test(code.slice(i + 4, i + 5))) i = close;
    }
  }
  return out;
}

/** <!-- … --> ranges in markup, offset by `base`. */
function htmlComments(code, base = 0) {
  const out = [];
  const rx = /<!--[\s\S]*?(?:-->|$)/g;
  let m;
  while ((m = rx.exec(code))) {
    if (!m[0].length) break;
    out.push({ start: base + m.index, end: base + m.index + m[0].length });
  }
  return out;
}

/** JS/TS comments (+ CSS in styled templates, + Angular inline templates/styles), offset by `base`. */
function jsComments(code, file, base = 0) {
  let ast;
  try {
    ast = parse(code, {
      sourceType: 'module',
      errorRecovery: true,
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true,
      plugins: babelPlugins(file),
    });
  } catch {
    return null; // unparseable — the syntax check rejects it anyway
  }
  const out = (ast.comments || []).map((c) => ({ start: base + c.start, end: base + c.end, js: true }));
  const quasis = (tpl, kind) => {
    for (const q of tpl.quasis || []) {
      const text = code.slice(q.start, q.end);
      out.push(...(kind === 'html' ? htmlComments(text, base + q.start) : cssComments(text, base + q.start, true)));
    }
  };
  const visit = (node, parentProp) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'TaggedTemplateExpression' && isStyledTag(node.tag)) quasis(node.quasi, 'css');
    if (node.type === 'ObjectProperty' && node.value) {
      const name = propName(node);
      // Angular @Component({ template: `…`, styles: [`…`] | `…` })
      if (name === 'template' && node.value.type === 'TemplateLiteral') quasis(node.value, 'html');
      if (name === 'template' && node.value.type === 'StringLiteral') out.push(...htmlComments(code.slice(node.value.start, node.value.end), base + node.value.start));
      if (name === 'styles') {
        const items = node.value.type === 'ArrayExpression' ? node.value.elements : [node.value];
        for (const it of items) {
          if (it && it.type === 'TemplateLiteral') quasis(it, 'css');
          if (it && it.type === 'StringLiteral') out.push(...cssComments(code.slice(it.start, it.end), base + it.start, false));
        }
      }
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'leadingComments' || k === 'trailingComments' || k === 'innerComments') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach((x) => visit(x, k));
      else if (v && typeof v.type === 'string') visit(v, k);
    }
  };
  visit(ast.program);
  return out;
}

/** Vue / Svelte single-file components: <script>, <style> and the markup around them. */
function sfcComments(code, file) {
  const out = [];
  const blocks = [];
  const rx = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  let m;
  while ((m = rx.exec(code))) {
    const innerStart = m.index + m[0].indexOf('>') + 1;
    blocks.push({ start: m.index, end: m.index + m[0].length });
    const attrs = m[2];
    const lang = (attrs.match(/\blang\s*=\s*["']([\w-]+)["']/) || [])[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;
    if (m[1].toLowerCase() === 'script') {
      const r = jsComments(m[3], /^tsx?$/.test(lang) ? (lang === 'tsx' ? 'x.tsx' : 'x.ts') : 'x.jsx', innerStart);
      if (r === null) return null;
      out.push(...r);
    } else {
      out.push(...cssComments(m[3], innerStart, /^(scss|sass|less)$/.test(lang)));
    }
  }
  let pos = 0;
  for (const b of [...blocks, { start: code.length, end: code.length }]) {
    if (b.start > pos) out.push(...htmlComments(code.slice(pos, b.start), pos));
    pos = b.end;
  }
  return out;
}

/** All comment ranges in a file, or null when the file type is unknown / it could not be parsed. */
function findComments(file, code) {
  const f = String(file || '');
  if (/\.(jsx|tsx|js|mjs|cjs|ts|mts|cts)$/.test(f)) return jsComments(code, f);
  if (/\.(vue|svelte)$/.test(f)) return sfcComments(code, f);
  if (/\.html?$/.test(f)) return htmlComments(code);
  if (/\.(scss|sass|less)$/.test(f)) return cssComments(code, 0, true);
  if (/\.css$/.test(f)) return cssComments(code, 0, false);
  return null;
}

const key = (s) => s.replace(/\s+/g, ' ').trim();

// Expand a comment range to what should be deleted: the whole line, a JSX {/* … */} container, or the comment plus the spaces before it.
function removalRange(code, r) {
  let { start, end } = r;
  if (r.js) {
    // JSX: {/* … */} — drop the braces too
    let a = start - 1;
    while (a >= 0 && /[ \t]/.test(code[a])) a--;
    let b = end;
    while (b < code.length && /[ \t]/.test(code[b])) b++;
    if (code[a] === '{' && code[b] === '}') {
      start = a;
      end = b + 1;
    }
  }
  const lineStart = code.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = code.indexOf('\n', end);
  if (lineEnd === -1) lineEnd = code.length;
  const before = code.slice(lineStart, start);
  const after = code.slice(end, lineEnd);
  if (!before.trim() && !after.trim()) {
    // the comment is alone on its line(s): remove the line(s) entirely
    return { start: lineStart, end: lineEnd < code.length ? lineEnd + 1 : lineEnd };
  }
  if (!after.trim()) {
    // trailing comment: also drop the whitespace in front of it
    let a = start;
    while (a > lineStart && /[ \t]/.test(code[a - 1])) a--;
    return { start: a, end };
  }
  // mid-line: don't leave a double space behind
  if (/[ \t]/.test(code[start - 1] || '') && /[ \t]/.test(code[end] || '')) {
    let a = start;
    while (a > lineStart && /[ \t]/.test(code[a - 1])) a--;
    return { start: a, end };
  }
  return { start, end };
}

/** Remove every comment from `code`. */
function stripAll(file, code) {
  return stripNew(file, null, code);
}

/**
 * Remove the comments in `after` that are not in `before` (null = new file: remove them all).
 * Existing comments are matched by their text, so moving code around keeps its comments.
 */
function stripNew(file, before, after) {
  if (typeof after !== 'string' || !after) return after;
  const crlf = /\r\n/.test(after);
  const code = after.replace(/\r\n/g, '\n');
  const found = findComments(file, code);
  if (!found || !found.length) return after;
  const keep = new Map();
  if (typeof before === 'string' && before) {
    for (const c of findComments(file, before.replace(/\r\n/g, '\n')) || []) {
      const k = key(before.replace(/\r\n/g, '\n').slice(c.start, c.end));
      keep.set(k, (keep.get(k) || 0) + 1);
    }
  }
  const drop = [];
  for (const c of found.sort((a, b) => a.start - b.start)) {
    const k = key(code.slice(c.start, c.end));
    const n = keep.get(k) || 0;
    if (n > 0) keep.set(k, n - 1);
    else drop.push(removalRange(code, c));
  }
  if (!drop.length) return after;
  // merge overlapping ranges, then cut from the end
  drop.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const r of drop) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  let out = code;
  for (let i = merged.length - 1; i >= 0; i--) out = out.slice(0, merged[i].start) + out.slice(merged[i].end);
  return crlf ? out.replace(/\n/g, '\r\n') : out;
}

/** Apply stripNew to edit.applyEdits / applyCreates change objects ({ abs, rel, before, after }). */
function stripChanges(changes) {
  return changes
    .map((c) => ({ ...c, after: stripNew(c.rel || c.abs, c.before, c.after) }))
    .filter((c) => c.before === null || c.after !== c.before);
}

module.exports = { findComments, stripNew, stripAll, stripChanges, cssComments };
