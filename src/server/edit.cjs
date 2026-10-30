'use strict';
// "Apply to code": applies AI-proposed find/replace edits to real source files, dev only.
// Safety net: edits are limited to a small allow-list of files, every result is syntax-checked
// before anything is written, the previous content is kept on disk for one-click undo, and
// undo refuses to clobber a file that changed after the edit.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createRequire } = require('module');
const { parse } = require('@babel/parser');
const angular = require('./angular.cjs');
const { privateTmpDir } = require('./tmpdir.cjs');

const SOURCE_EXT = /\.(jsx|tsx|js|mjs|ts|vue|svelte)$/;
const SOURCE_EXT_NG = /\.(jsx|tsx|js|mjs|ts|vue|svelte|html)$/;
/** Angular templates (.html) are source files too, in Angular projects only. */
const sourceExt = (root) => (angular.isAngular(root) ? SOURCE_EXT_NG : SOURCE_EXT);
const STYLE_EXT = /\.(css|scss|sass|less)$/;
const MAX_FILE_CHARS = 80000;
const MAX_TOTAL_CHARS = 140000;
const HISTORY_LIMIT = 50;
const PENDING_TTL = 15 * 60 * 1000;

function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) e.extra = extra;
  return e;
}

const toPosix = (p) => p.split(path.sep).join('/');

function realRoot(root) {
  try {
    return fs.realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

function insideRoot(root, abs) {
  const rel = path.relative(realRoot(root), abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Resolve a file the client named into an absolute path we are willing to write.
function resolveWritable(root, file, extRe) {
  if (typeof file !== 'string' || !file) throw httpError(400, 'file is required');
  const abs = path.isAbsolute(file) ? file : path.resolve(root, file);
  let real;
  try {
    real = fs.realpathSync(abs);
    if (!fs.statSync(real).isFile()) throw new Error();
  } catch {
    throw httpError(404, `File not found: ${file}`);
  }
  if (!extRe.test(real)) throw httpError(400, `Not an editable file: ${file}`);
  if (/[\\/](node_modules|\.git|\.next|dist|build)[\\/]/.test(real)) throw httpError(400, `Refusing to edit generated or vendored file: ${file}`);
  if (!insideRoot(root, real)) throw httpError(400, `Refusing to edit a file outside the project: ${file}`);
  return real;
}

// Stylesheets imported with a relative path by the component (CSS modules, plain CSS, Sass, Less),
// including Vue's <style src="./x.scss">.
function styleImports(abs, code) {
  const out = [];
  const re = /(?:import\s+(?:[\w*{}\s,]+\s+from\s+)?|@import\s+|require\(\s*|<style\b[^>]*\bsrc\s*=\s*)['"](\.{1,2}\/[^'"]+\.(?:css|scss|sass|less))['"]/g;
  let m;
  while ((m = re.exec(code))) {
    const p = path.resolve(path.dirname(abs), m[1]);
    if (fs.existsSync(p) && !out.includes(p)) out.push(p);
  }
  // Angular: styleUrl: './x.scss' / styleUrls: ['./a.css', 'b.scss'] (relative to the component file)
  if (/\bstyleUrls?\s*:/.test(code) && /@Component\s*\(/.test(code)) {
    for (const meta of angular.componentsIn(code)) {
      for (const url of meta.styleUrls) {
        if (!/\.(css|scss|sass|less)$/.test(url)) continue;
        const p = angular.resolveUrl(abs, url);
        if (fs.existsSync(p) && !out.includes(p)) out.push(p);
      }
    }
  }
  return out;
}

const SCRIPT_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];
const CSS_IN_JS = /from\s+['"](?:styled-components(?:\/macro)?|@emotion\/(?:styled|react|css)|@linaria\/(?:react|core)|@stitches\/react|@vanilla-extract\/(?:css|recipes)|@mui\/(?:material\/styles|system|material)|goober|twin\.macro)['"]/;

function resolveScript(fromAbs, spec) {
  const base = path.resolve(path.dirname(fromAbs), spec);
  const tries = [base, ...SCRIPT_EXTS.map((e) => base + e), ...SCRIPT_EXTS.map((e) => path.join(base, 'index' + e))];
  for (const t of tries) {
    try {
      if (fs.statSync(t).isFile()) return t;
    } catch {}
  }
  return null;
}

// Local modules that hold the component's CSS-in-JS: `./Card.styles`, `./styled`, `import * as S from './styles'`,
// vanilla-extract `./card.css.ts`, or any small relative import that defines styled components.
function stylesModuleImports(abs, code) {
  const out = [];
  const re = /(?:import\s+(?:[\w*{}\s,$]+\s+from\s+)?|require\(\s*)['"](\.{1,2}\/[^'"]+?)['"]/g;
  let m;
  while ((m = re.exec(code))) {
    const spec = m[1];
    if (/\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|json)$/.test(spec)) continue;
    const p = resolveScript(abs, spec);
    if (!p || p === abs || out.includes(p)) continue;
    const named = /(^|[./])(styles?|styled|css)(\.(ts|tsx|js|jsx|mjs))?$/i.test(path.basename(p).replace(/\.(ts|tsx|js|jsx|mjs)$/, '')) || /\.css\.(ts|js)$/.test(p);
    let content = '';
    try {
      const st = fs.statSync(p);
      if (st.size > 40000) continue;
      content = fs.readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    const definesStyled = CSS_IN_JS.test(content) && /\b(styled\s*[.(]|css\s*`|keyframes\s*`|style\s*\(|recipe\s*\()/.test(content);
    if (definesStyled || (named && CSS_IN_JS.test(content))) out.push(p);
  }
  return out;
}

// Sass partials a stylesheet pulls in with @use / @import / @forward — shown to the AI read-only so it
// can reuse variables and mixins instead of hard-coding values.
function sassDependencies(abs, code) {
  const out = [];
  const re = /@(?:use|import|forward)\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(code))) {
    const spec = m[1];
    if (/^(sass:|https?:|~|@)/.test(spec) || /\.css$/.test(spec)) continue;
    const dir = path.dirname(path.resolve(path.dirname(abs), spec));
    const name = path.basename(spec).replace(/\.(scss|sass)$/, '');
    const cands = [];
    for (const ext of ['.scss', '.sass']) {
      cands.push(path.join(dir, name + ext), path.join(dir, '_' + name + ext), path.join(dir, name, '_index' + ext), path.join(dir, name, 'index' + ext));
    }
    const hit = cands.find((c) => fs.existsSync(c));
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

const MAX_REFERENCE_CHARS = 12000;

/**
 * The files the AI may touch: the clicked component's file, the stylesheets it imports, the local modules
 * that hold its styled-components/emotion definitions, and (optionally) the file where that component is used
 * (its call-site). Sass partials those stylesheets depend on are included READ-ONLY, for their tokens.
 */
function editableFiles(root, componentFile, callSiteFile) {
  const files = [];
  const add = (abs, role) => {
    if (files.some((f) => f.abs === abs)) return null;
    const content = fs.readFileSync(abs, 'utf8');
    const limit = role === 'reference' ? MAX_REFERENCE_CHARS : MAX_FILE_CHARS;
    if (content.length > limit) {
      if (role === 'component') throw httpError(413, `${toPosix(path.relative(root, abs))} is too large for AI edits (${content.length} chars).`);
      return null;
    }
    const f = { abs, rel: toPosix(path.relative(realRoot(root), abs)), role, content };
    files.push(f);
    return f;
  };
  const SRC = sourceExt(root);
  const main = resolveWritable(root, componentFile, SRC);
  add(main, 'component');
  const mainContent = files[0].content;
  for (const css of styleImports(main, mainContent)) {
    try {
      add(resolveWritable(root, css, STYLE_EXT), 'stylesheet');
    } catch {}
  }
  // Angular: an element lives in the template (.html); its class (inputs, state, handlers, the standalone
  // `imports` array) is a separate file, and a non-standalone component is declared in an NgModule.
  if (angular.isAngular(root)) {
    let cls = null;
    if (main.endsWith('.html')) {
      const owner = angular.ownerOfTemplate(main);
      if (owner) {
        try {
          cls = add(resolveWritable(root, owner.abs, SRC), 'class');
        } catch {}
      }
    } else if (/@Component\s*\(/.test(mainContent)) cls = files[0];
    if (cls) {
      for (const css of styleImports(cls.abs, cls.content)) {
        try {
          add(resolveWritable(root, css, STYLE_EXT), 'stylesheet');
        } catch {}
      }
      const major = angular.angularMajor(root);
      for (const meta of angular.componentsIn(cls.content)) {
        if (angular.isStandalone(meta, major)) continue;
        const mod = angular.declaringModule(root, cls.abs, meta.className);
        if (mod) {
          try {
            add(resolveWritable(root, mod, SRC), 'module');
          } catch {}
        }
      }
    }
  }
  for (const mod of stylesModuleImports(main, mainContent)) {
    try {
      const f = add(resolveWritable(root, mod, SRC), 'styles');
      // a styles module can itself import a .scss / .css (rare, but cheap to follow)
      if (f) for (const css of styleImports(f.abs, f.content)) {
        try {
          add(resolveWritable(root, css, STYLE_EXT), 'stylesheet');
        } catch {}
      }
    } catch {}
  }
  if (callSiteFile) {
    try {
      add(resolveWritable(root, callSiteFile, SRC), 'call-site');
    } catch {}
  }
  // Read-only Sass partials (variables, mixins) — from imported stylesheets and from Vue/Svelte <style lang="scss">.
  const sassSources = files.filter((f) => /\.(scss|sass)$/.test(f.rel) || (f.role === 'component' && /<style[^>]*lang=["'](scss|sass)/.test(f.content)));
  let refs = 0;
  for (const s of sassSources) {
    for (const dep of sassDependencies(s.abs, s.content)) {
      if (refs >= 3) break;
      try {
        if (add(resolveWritable(root, dep, STYLE_EXT), 'reference')) refs++;
      } catch {}
    }
  }
  let total = 0;
  return files.filter((f) => (total += f.content.length) <= MAX_TOTAL_CHARS || f.role === 'component');
}

// ---------- new files (new components) ----------

const MAX_NEW_FILES = 4;
const MAX_NEW_FILE_CHARS = 40000;

/**
 * Validate a file the AI wants to create. It must be a new source/style file inside one of `allowedDirs`
 * (the clicked component's folder, or its parent for folder-per-component projects), at most 3 levels deep.
 */
/** realpath of the nearest existing ancestor, with the missing segments appended again. */
function realish(p) {
  const missing = [];
  let probe = path.resolve(p);
  while (!fs.existsSync(probe)) {
    const up = path.dirname(probe);
    if (up === probe) break;
    missing.unshift(path.basename(probe));
    probe = up;
  }
  let base = probe;
  try {
    base = fs.realpathSync(probe);
  } catch {}
  return path.join(base, ...missing);
}

function resolveCreatable(root, file, allowedDirs, maxDepth = 3) {
  if (typeof file !== 'string' || !file.trim()) throw httpError(422, 'A new file has no path.');
  const clean = file.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const segs = clean.split('/');
  if (path.isAbsolute(clean) || segs.some((s) => !s || s === '.' || s === '..' || !/^[\w@+.()[\]-]+$/.test(s))) {
    throw httpError(422, `"${file}" is not a valid project-relative path for a new file.`);
  }
  const rootReal = realRoot(root);
  const abs = path.resolve(rootReal, clean);
  if (!sourceExt(root).test(abs) && !STYLE_EXT.test(abs)) throw httpError(422, `New file ${clean} must be a source or stylesheet file.`);
  if (/[\\/](node_modules|\.git|\.next|dist|build)[\\/]/.test(abs)) throw httpError(422, `Refusing to create ${clean} in a generated or vendored folder.`);
  // Allowed folders may not exist yet (a project's first src/pages/ folder): resolve what does exist.
  const dirs = allowedDirs.map((d) => realish(d)).filter((d, i, a) => a.indexOf(d) === i && insideRoot(root, d) !== false);
  const within = dirs.find((d) => {
    const rel = path.relative(d, abs);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) && rel.split(path.sep).length <= maxDepth;
  });
  if (!within) {
    throw httpError(422, `New files may only be created in ${dirs.map((d) => toPosix(path.relative(rootReal, d)) + '/').join(' or ')} — not ${clean}.`);
  }
  if (fs.existsSync(abs)) throw httpError(422, `${clean} already exists. Edit it instead of creating it.`);
  // the nearest existing ancestor must really be inside the allowed folder (no symlink escapes)
  let probe = path.dirname(abs);
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const probeReal = fs.realpathSync(probe);
  const relProbe = path.relative(within, probeReal);
  // Fine when the nearest existing folder is inside the allowed one, or — when the allowed folder does not exist
  // yet — is one of its ancestors inside the project (everything below it gets created fresh, no symlinks).
  const probeIsAncestor = !fs.existsSync(within) && !path.relative(probeReal, within).startsWith('..') && (probeReal === rootReal || insideRoot(root, probeReal));
  if ((relProbe.startsWith('..') || path.isAbsolute(relProbe)) && !probeIsAncestor) throw httpError(422, `Refusing to create ${clean} outside the allowed folders.`);
  return { abs, rel: toPosix(path.relative(rootReal, abs)) };
}

/**
 * An extra file the AI may edit for this change (e.g. the router file when adding a page), in the same shape
 * as editableFiles() entries. Returns null when it can't be edited.
 */
const ANY_EDITABLE = /\.(jsx|tsx|js|mjs|cjs|ts|vue|svelte|css|scss|sass|less)$/;

function extraFile(root, file, role, extRe) {
  try {
    const abs = resolveWritable(root, file, extRe || (STYLE_EXT.test(String(file)) || /\.cjs$/.test(String(file)) ? ANY_EDITABLE : sourceExt(root)));
    const content = fs.readFileSync(abs, 'utf8');
    if (content.length > MAX_FILE_CHARS) return null;
    return { abs, rel: toPosix(path.relative(realRoot(root), abs)), role, content };
  } catch {
    return null;
  }
}

/** creates: [{file, content}] → changes with before === null. */
function applyCreates(root, creates, allowedDirs, maxDepth = 3) {
  if (!Array.isArray(creates) || !creates.length) return [];
  if (!allowedDirs || !allowedDirs.length) throw httpError(422, 'This change may not create new files. Ask for a new component to allow that.');
  if (creates.length > MAX_NEW_FILES) throw httpError(422, `Too many new files (${creates.length}); at most ${MAX_NEW_FILES}.`);
  const out = [];
  creates.forEach((c, i) => {
    const { abs, rel } = resolveCreatable(root, c && c.file, allowedDirs, maxDepth);
    if (out.some((o) => o.abs === abs)) throw httpError(422, `New file ${rel} is listed twice.`);
    const content = lf(typeof c.content === 'string' ? c.content : '');
    if (!content.trim()) throw httpError(422, `New file ${i + 1} (${rel}) is empty.`);
    if (content.length > MAX_NEW_FILE_CHARS) throw httpError(422, `New file ${rel} is too large.`);
    out.push({ abs, rel, role: 'new', created: true, before: null, after: content.endsWith('\n') ? content : content + '\n' });
  });
  return out;
}

function stylingHints(root, files) {
  const hints = [];
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {}
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const tw =
    deps.tailwindcss ||
    ['tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.cjs', 'tailwind.config.mjs'].some((f) => fs.existsSync(path.join(root, f)));
  if (tw) hints.push('The project uses Tailwind CSS: prefer changing Tailwind utility classes in className over writing new CSS.');
  if (files.some((f) => /\.module\.(css|scss|sass|less)$/.test(f.rel))) hints.push('The component uses CSS Modules: style changes belong in its .module stylesheet.');
  else if (files.some((f) => f.role === 'stylesheet')) hints.push('The component imports a stylesheet: style changes can go there.');
  if (deps['styled-components'] || deps['@emotion/styled'] || deps['@emotion/react']) hints.push('The project uses CSS-in-JS (styled-components/emotion); follow the existing pattern in the file.');
  if (!hints.length) hints.push('Follow whatever styling approach the file already uses (inline style, className, <style> block).');
  return hints;
}

// ---------- applying edits ----------

const lf = (s) => String(s).replace(/\r\n/g, '\n');

function occurrences(hay, needle) {
  const at = [];
  if (!needle) return at;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    at.push(i);
    i = hay.indexOf(needle, i + 1);
  }
  return at;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// Fallback when the model got indentation or trailing whitespace slightly wrong:
// match line by line on trimmed content.
function fuzzyRanges(content, find) {
  const lines = content.split('\n');
  const want = find.split('\n').map((l) => l.trim());
  while (want.length && !want[0]) want.shift();
  while (want.length && !want[want.length - 1]) want.pop();
  if (!want.length) return [];
  const starts = [];
  let offset = 0;
  const offsets = lines.map((l) => {
    const o = offset;
    offset += l.length + 1;
    return o;
  });
  for (let i = 0; i + want.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (lines[i + j].trim() !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const endLine = i + want.length - 1;
      starts.push({ start: offsets[i], end: offsets[endLine] + lines[endLine].length });
    }
  }
  return starts;
}

// Same as fuzzyRanges, but runs of whitespace inside a line count as one space too
// (`className="a  b"` vs `className="a b"`, `{ x }` vs `{x }` is NOT matched — only whitespace runs).
function looseRanges(content, find) {
  const norm = (l) => l.trim().replace(/\s+/g, ' ');
  const lines = content.split('\n');
  const want = find.split('\n').map(norm);
  while (want.length && !want[0]) want.shift();
  while (want.length && !want[want.length - 1]) want.pop();
  if (!want.length) return [];
  const normed = lines.map(norm);
  const offsets = [];
  let offset = 0;
  for (const l of lines) {
    offsets.push(offset);
    offset += l.length + 1;
  }
  const out = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (normed[i + j] !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const endLine = i + want.length - 1;
      out.push({ start: offsets[i], end: offsets[endLine] + lines[endLine].length });
    }
  }
  return out;
}

/**
 * Clean up a "find" / "replace" text the model copied with artefacts: markdown fences, or the line-number gutter of
 * the EXCERPT block (">>   12 | code" / "     12 | code"). The gutter is only stripped when every non-empty line
 * has it, so real code containing "|" is left alone.
 */
const GUTTER = /^(?:>>|  )?\s{0,6}\d{1,5} \| ?/;
function cleanSnippet(text) {
  let s = lf(text);
  const fence = s.match(/^\s*```[\w-]*\n([\s\S]*?)\n?```\s*$/);
  if (fence) s = fence[1];
  const lines = s.split('\n');
  const nonEmpty = lines.filter((l) => l.trim());
  if (nonEmpty.length && nonEmpty.every((l) => GUTTER.test(l))) s = lines.map((l) => l.replace(GUTTER, '')).join('\n');
  return s;
}

const indentOf = (l) => (l.match(/^[ \t]*/) || [''])[0];

/**
 * When the "find" matched only after ignoring indentation, shift the replacement by the same amount so the new code
 * lines up with the code around it (model wrote 2 spaces, file uses 6).
 */
function reindent(replacement, needle, matched) {
  const firstWant = needle.split('\n').find((l) => l.trim());
  const firstHave = matched.split('\n').find((l) => l.trim());
  if (firstWant == null || firstHave == null) return replacement;
  const from = indentOf(firstWant);
  const to = indentOf(firstHave);
  if (from === to) return replacement;
  return replacement
    .split('\n')
    .map((l) => {
      if (!l.trim()) return l;
      if (l.startsWith(from)) return to + l.slice(from.length);
      // a line less indented than the find's first line: leave it (it's the model's intent)
      return l;
    })
    .join('\n');
}

/** The lines of `content` that look most like `needle` — shown to the AI when its "find" text didn't match. */
function closestSnippet(content, needle, maxLines = 14) {
  const lines = content.split('\n');
  const want = needle.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!want.length || !lines.length) return '';
  // Dice coefficient on character bigrams: tolerant of typos, renamed props and changed quotes.
  const grams = (s) => {
    const m = new Map();
    const t = s.replace(/\s+/g, ' ');
    for (let i = 0; i < t.length - 1; i++) {
      const g = t.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const wantTok = want.map(grams);
  const lineTok = lines.map((l) => grams(l.trim()));
  const score = (a, b) => {
    let na = 0;
    let nb = 0;
    let both = 0;
    for (const v of a.values()) na += v;
    for (const v of b.values()) nb += v;
    if (!na || !nb) return 0;
    for (const [g, v] of a) if (b.has(g)) both += Math.min(v, b.get(g));
    return (2 * both) / (na + nb);
  };
  let best = -1;
  let at = 0;
  const span = Math.min(want.length, lines.length);
  for (let i = 0; i + span <= lines.length; i++) {
    let s = 0;
    for (let j = 0; j < span; j++) s += score(wantTok[j], lineTok[i + j]);
    if (s > best) {
      best = s;
      at = i;
    }
  }
  if (best <= 0) return '';
  const from = Math.max(0, at - 1);
  const to = Math.min(lines.length, at + Math.min(maxLines, span + 2));
  return lines.slice(from, to).join('\n');
}

function resolveTarget(byRel, files, name) {
  if (byRel.has(name)) return byRel.get(name);
  // "src/App.tsx (the clicked element is defined here)", "./src/App.tsx", "C:\\x\\src\\App.tsx", "FILE: src/App.tsx"
  const n = String(name || '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/^\s*(?:=+\s*)?(?:FILE:\s*)?/i, '')
    .replace(/\s*=+\s*$/, '')
    .replace(/\\/g, '/')
    .trim()
    .replace(/^\.?\//, '');
  if (byRel.has(n)) return byRel.get(n);
  for (const f of byRel.values()) if (f.rel === n || f.rel.endsWith('/' + n) || (f.abs && toPosix(f.abs).endsWith('/' + n))) return f;
  // Bare basename, case-insensitive — only when it is unique.
  const base = n.split('/').pop().toLowerCase();
  const byBase = [...byRel.values()].filter((f) => f.rel.split('/').pop().toLowerCase() === base);
  if (byBase.length === 1) return byBase[0];
  return files.length === 1 ? byRel.get(files[0].rel) : null;
}

/**
 * files: [{rel, content}] (content may contain CRLF), edits: [{file, find, replace}]
 * Returns new contents keyed by rel. Throws a 422 describing every edit that didn't apply (with the closest real
 * code, so the AI's retry can copy it correctly).
 */
function applyEdits(files, edits, hintLine) {
  if (!Array.isArray(edits) || !edits.length) throw httpError(422, 'The AI did not propose any change.');
  const byRel = new Map(files.map((f) => [f.rel, { ...f, next: lf(f.content) }]));
  const problems = [];
  edits.forEach((e, i) => {
    const f = resolveTarget(byRel, files, e && e.file);
    if (!f) {
      problems.push(`Edit ${i + 1} targets "${e && e.file}", which is not one of the files you may change (${[...byRel.keys()].join(', ')}).`);
      return;
    }
    if (f.role === 'reference') {
      problems.push(`Edit ${i + 1} targets ${f.rel}, which is READ-ONLY (shared Sass partial). Change the component's own stylesheet instead.`);
      return;
    }
    const needle = cleanSnippet(e.find || '');
    const rawReplacement = typeof e.replace === 'string' ? e.replace : '';
    // Only strip a gutter from "replace" when "find" had one too (the model copied the excerpt for both).
    const replacement = cleanSnippet(rawReplacement) !== lf(rawReplacement) && needle !== lf(e.find || '') ? cleanSnippet(rawReplacement) : lf(rawReplacement);
    if (!needle.trim()) {
      problems.push(`Edit ${i + 1} has an empty "find" text.`);
      return;
    }
    if (needle === replacement) return; // a no-op edit: harmless, skip it
    let fuzzy = false;
    let ranges = occurrences(f.next, needle).map((s) => ({ start: s, end: s + needle.length }));
    if (!ranges.length) {
      ranges = fuzzyRanges(f.next, needle);
      if (!ranges.length) ranges = looseRanges(f.next, needle);
      fuzzy = ranges.length > 0;
    }
    if (!ranges.length) {
      // The model repeated an edit (or wrote one that a previous edit in this answer already made): skip it.
      if (replacement.trim().length >= 8 && (f.next.includes(replacement) || fuzzyRanges(f.next, replacement).length)) return;
      const near = closestSnippet(f.next, needle);
      problems.push(
        `Edit ${i + 1} could not be applied: its "find" text does not exist in ${f.rel}${i > 0 ? ' (remember edits apply in order, so a find must match the file AFTER the earlier edits)' : ''}.` +
          (near ? `\nThe closest code in ${f.rel} is:\n<<<\n${near}\n>>>\nCopy "find" character-for-character from the file.` : '')
      );
      return;
    }
    let pick = ranges[0];
    if (ranges.length > 1) {
      if (!(f.role === 'component' && hintLine)) {
        problems.push(`Edit ${i + 1} is ambiguous: its "find" text appears ${ranges.length} times in ${f.rel} (lines ${ranges.map((r) => lineOf(f.next, r.start)).join(', ')}). Include more surrounding lines so it is unique.`);
        return;
      }
      pick = ranges.reduce((best, r) => (Math.abs(lineOf(f.next, r.start) - hintLine) < Math.abs(lineOf(f.next, best.start) - hintLine) ? r : best));
    }
    const matched = f.next.slice(pick.start, pick.end);
    let rep = fuzzy ? reindent(replacement, needle, matched) : replacement;
    // A fuzzy match covers whole lines without the needle's leading/trailing blank lines: drop those from the
    // replacement too, so we don't add stray empty lines.
    if (fuzzy) rep = rep.replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '');
    f.next = f.next.slice(0, pick.start) + rep + f.next.slice(pick.end);
  });
  if (problems.length) throw httpError(422, problems.join('\n\n'));
  const out = [];
  for (const f of byRel.values()) {
    const crlf = /\r\n/.test(f.content);
    const next = crlf ? f.next.replace(/\n/g, '\r\n') : f.next;
    if (next !== f.content) out.push({ abs: f.abs, rel: f.rel, role: f.role, before: f.content, after: next });
  }
  if (!out.length) throw httpError(422, 'The proposed edits would not change anything.');
  return out;
}

// ---------- Vue SFC normalising ----------

/**
 * Range of the root <template> block of a Vue SFC: { open, start, end, close } where start..end is its inner
 * content and close is the index right after </template>. Nested <template> tags (slots, v-if groups) are counted.
 */
function vueRootTemplate(text) {
  const tagRe = /<template\b[^>]*?(\/?)>|<\/template\s*>/g;
  const skipRe = /<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/g;
  // Find the root <template> at depth 0, skipping comments and top-level script/style blocks.
  let i = 0;
  while (i < text.length) {
    skipRe.lastIndex = i;
    tagRe.lastIndex = i;
    const s = skipRe.exec(text);
    const t = tagRe.exec(text);
    if (!t) return null;
    if (s && s.index < t.index) {
      i = s.index + s[0].length;
      continue;
    }
    if (t[0].startsWith('</') || t[1] === '/') {
      i = t.index + t[0].length;
      continue;
    }
    const open = t.index;
    const start = t.index + t[0].length;
    let depth = 1;
    tagRe.lastIndex = start;
    let m;
    while ((m = tagRe.exec(text))) {
      if (m[0].startsWith('</')) depth--;
      else if (m[1] !== '/') depth++;
      if (depth === 0) return { open, start, end: m.index, close: m.index + m[0].length };
    }
    return null;
  }
  return null;
}

/**
 * The AI sometimes writes a component's <style> block inside <template>. Vue ignores (or errors on) that, so move
 * every <style>…</style> found inside the root <template> out to a top-level block after </template>. A block whose
 * attributes match an existing top-level <style> is merged into it.
 */
function hoistVueStyles(code) {
  const crlf = /\r\n/.test(code);
  let text = lf(code);
  const tpl = vueRootTemplate(text);
  if (!tpl) return code;
  const inner = text.slice(tpl.start, tpl.end);
  const styleRe = /[ \t]*<style\b([^>]*)>([\s\S]*?)<\/style\s*>[ \t]*\n?/g;
  const found = [];
  const cleaned = inner.replace(styleRe, (_, attrs, body) => {
    found.push({ attrs: attrs.replace(/\s+/g, ' ').trim(), body });
    return '';
  });
  if (!found.length) return code;

  // Strip the common indentation the block had inside the template.
  const dedent = (body) => {
    const lines = body.replace(/^\n+|\s+$/g, '').split('\n');
    const pad = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^[ \t]*/)[0].length));
    return lines.map((l) => l.slice(Number.isFinite(pad) ? pad : 0)).join('\n');
  };

  text = text.slice(0, tpl.start) + cleaned.replace(/\n{3,}/g, '\n\n') + text.slice(tpl.end);
  const closeAt = tpl.close - (inner.length - cleaned.replace(/\n{3,}/g, '\n\n').length);

  const extra = [];
  for (const f of found) {
    const body = dedent(f.body);
    // Merge into an existing top-level <style> with the same attributes.
    const sameRe = new RegExp(`<style\\b([^>]*)>([\\s\\S]*?)<\\/style\\s*>`, 'g');
    let merged = false;
    let m;
    while ((m = sameRe.exec(text))) {
      if (m.index < closeAt) continue;
      if (m[1].replace(/\s+/g, ' ').trim() !== f.attrs) continue;
      const contentEnd = m.index + m[0].lastIndexOf('</style');
      const before = text.slice(0, contentEnd).replace(/\s*$/, '');
      text = `${before}\n\n${body}\n${text.slice(contentEnd)}`;
      merged = true;
      break;
    }
    if (!merged) extra.push(`<style${f.attrs ? ' ' + f.attrs : ''}>\n${body}\n</style>`);
  }
  if (extra.length) {
    // Recompute the template end after any merges (merges only touch text after it).
    const t2 = vueRootTemplate(text);
    const at = t2 ? t2.close : text.length;
    text = `${text.slice(0, at)}\n\n${extra.join('\n\n')}${text.slice(at).replace(/^\n*/, '\n')}`;
    if (!text.endsWith('\n')) text += '\n';
  }
  return crlf ? text.replace(/\n/g, '\r\n') : text;
}

/** Apply hoistVueStyles to every .vue change (edited or newly created). */
function normalizeVueChanges(changes) {
  for (const c of changes) {
    if (c && typeof c.after === 'string' && /\.vue$/.test(c.abs || c.rel || '')) c.after = hoistVueStyles(c.after);
  }
  return changes.filter((c) => c.before === null || c.after !== c.before);
}

// ---------- syntax check ----------

function babelPlugins(file) {
  if (/\.tsx$/.test(file)) return ['jsx', 'typescript', 'decorators-legacy'];
  if (/\.ts$/.test(file)) return ['typescript', 'decorators-legacy'];
  return ['jsx', 'decorators-legacy'];
}

function babelCheck(code, file, lineOffset = 0) {
  try {
    parse(code, {
      sourceType: 'module',
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true,
      errorRecovery: false,
      plugins: babelPlugins(file),
    });
    return null;
  } catch (err) {
    const line = err.loc ? err.loc.line + lineOffset : null;
    return `${err.message.replace(/\s*\(\d+:\d+\)$/, '')}${line ? ` (line ${line})` : ''}`;
  }
}

function cssCheck(code, { lineComments = false, lineOffset = 0 } = {}) {
  let depth = 0;
  let line = 1 + lineOffset;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '\n') line++;
    else if (lineComments && c === '/' && code[i + 1] === '/' && code[i - 1] !== ':') {
      // SCSS / Less // comments (an apostrophe in "don't" must not open a string)
      const end = code.indexOf('\n', i);
      if (end === -1) break;
      i = end - 1;
    } else if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      if (end === -1) return `Unclosed comment (line ${line})`;
      line += code.slice(i, end).split('\n').length - 1;
      i = end + 1;
    } else if (c === '"' || c === "'") {
      const q = c;
      for (i++; i < code.length && code[i] !== q; i++) if (code[i] === '\\') i++;
    } else if (c === '{') depth++;
    else if (c === '}' && --depth < 0) return `Unexpected "}" (line ${line})`;
  }
  return depth ? 'Unbalanced braces: a "}" is missing' : null;
}

function projectRequire(root, id) {
  try {
    return createRequire(path.join(root, 'package.json'))(id);
  } catch {
    return null;
  }
}

// ---- CSS inside styled-components / emotion / linaria tagged templates ----

const STYLED_TAGS = new Set(['css', 'keyframes', 'createGlobalStyle', 'injectGlobal', 'tw']);

function isStyledTag(node) {
  if (!node) return false;
  if (node.type === 'Identifier') return node.name === 'styled' || STYLED_TAGS.has(node.name);
  if (node.type === 'MemberExpression') return isStyledTag(node.object); // styled.div, styled.div.attrs(...)
  if (node.type === 'CallExpression') return isStyledTag(node.callee); // styled(Button), styled.div.attrs({…}), styled('div')
  return false;
}

/** Brace/comment/string check of every styled template literal in a JS/TS file. */
function styledTemplatesCheck(code, file) {
  if (!/\b(styled|css|keyframes|createGlobalStyle|injectGlobal)\b[\s\S]*`/.test(code)) return null;
  let ast;
  try {
    ast = parse(code, { sourceType: 'module', errorRecovery: true, allowReturnOutsideFunction: true, allowImportExportEverywhere: true, plugins: babelPlugins(file) });
  } catch {
    return null;
  }
  let problem = null;
  const visit = (node) => {
    if (problem || !node || typeof node.type !== 'string') return;
    if (node.type === 'TaggedTemplateExpression' && isStyledTag(node.tag)) {
      // Interpolations become a neutral placeholder: `${(p) => p.x}` is a value, `${mixin}` a declaration.
      const text = node.quasi.quasis.map((q) => (q.value.cooked != null ? q.value.cooked : q.value.raw)).join('_mf_');
      const err = cssCheck(text, { lineComments: true, lineOffset: node.quasi.loc.start.line - 1 });
      if (err) problem = `CSS in a styled template: ${err}`;
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'leadingComments' || k === 'trailingComments') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v.type === 'string') visit(v);
    }
  };
  visit(ast.program);
  return problem;
}

/** Real stylesheet parsers when the project has them (postcss-scss, postcss-less, postcss); brace check otherwise. */
function stylesheetCheck(root, file, text) {
  if (/\.sass$/.test(file)) {
    const sass = projectRequire(root, 'sass') || projectRequire(root, 'sass-embedded');
    if (sass && typeof sass.compileString === 'function') {
      try {
        // Stub every import: we only want syntax errors, not "undefined variable" from partials.
        sass.compileString(text, {
          syntax: 'indented',
          importers: [{ canonicalize: (u) => new URL('mf-stub:' + encodeURIComponent(u)), load: () => ({ contents: '', syntax: 'scss' }) }],
          logger: { warn() {}, debug() {} },
        });
      } catch (err) {
        const msg = String(err.message || err);
        if (!/Undefined (variable|mixin|function)|not found|Can't find/i.test(msg)) {
          return { ok: false, checked: true, error: msg.split('\n')[0] };
        }
      }
      return { ok: true, checked: true };
    }
    return { ok: true, checked: false };
  }
  const parserId = /\.scss$/.test(file) ? 'postcss-scss' : /\.less$/.test(file) ? 'postcss-less' : 'postcss';
  const parser = projectRequire(root, parserId);
  const parseFn = parser && (typeof parser.parse === 'function' ? parser.parse : parser.default && parser.default.parse);
  if (parseFn) {
    try {
      parseFn(text, { from: file });
      return { ok: true, checked: true };
    } catch (err) {
      return { ok: false, checked: true, error: `${err.reason || err.message}${err.line ? ` (line ${err.line})` : ''}` };
    }
  }
  const error = cssCheck(text, { lineComments: /\.(scss|less)$/.test(file) });
  return { ok: !error, error, checked: true };
}

// Vue / Svelte <style lang="scss"> blocks, checked like a stylesheet of that language.
function sfcStyleCheck(root, file, text) {
  const rx = /<style\b([^>]*)>([\s\S]*?)<\/style>/g;
  let m;
  while ((m = rx.exec(text))) {
    if (/\bsrc\s*=/.test(m[1])) continue;
    const lang = (m[1].match(/\blang\s*=\s*["']([\w-]+)["']/) || [])[1] || 'css';
    if (!/^(css|scss|sass|less|postcss)$/.test(lang)) continue;
    const startLine = text.slice(0, m.index + m[0].indexOf('>') + 1).split('\n').length - 1;
    const r = stylesheetCheck(root, `x.${lang === 'postcss' ? 'css' : lang}`, m[2]);
    if (!r.ok) return `<style lang="${lang}">: ${String(r.error).replace(/\(line (\d+)\)/, (_, l) => `(line ${Number(l) + startLine})`)}`;
  }
  return null;
}

/** Returns { ok, error, checked } — checked=false means no parser was available for this file type. */
function syntaxCheck(root, file, code) {
  const text = lf(code);
  if (/\.(jsx|tsx|js|mjs|cjs|ts)$/.test(file)) {
    const error =
      babelCheck(text, file) || styledTemplatesCheck(text, file) || (/\.ts$/.test(file) && angular.isAngular(root) ? angular.checkInlineTemplates(root, file, text) : null);
    return { ok: !error, error, checked: true };
  }
  if (file.endsWith('.html')) {
    if (!angular.isAngular(root)) return { ok: true, checked: false };
    const error = angular.checkTemplateFile(root, file, text);
    return { ok: !error, error, checked: true };
  }
  if (STYLE_EXT.test(file)) return stylesheetCheck(root, file, text);
  if (file.endsWith('.vue')) {
    const sfc = projectRequire(root, 'vue/compiler-sfc');
    if (!sfc) {
      const styleError = sfcStyleCheck(root, file, text);
      return styleError ? { ok: false, checked: true, error: styleError } : { ok: true, checked: false };
    }
    const { descriptor, errors } = sfc.parse(text, { filename: file });
    if (errors && errors.length) {
      const e = errors[0];
      return { ok: false, checked: true, error: `${e.message}${e.loc ? ` (line ${e.loc.start.line})` : ''}` };
    }
    for (const block of [descriptor.script, descriptor.scriptSetup].filter(Boolean)) {
      const ts = block.lang === 'ts' || block.lang === 'tsx';
      const error = babelCheck(block.content, ts ? 'x.tsx' : 'x.jsx', block.loc.start.line - 1);
      if (error) return { ok: false, checked: true, error };
    }
    const styleError = sfcStyleCheck(root, file, text);
    return styleError ? { ok: false, checked: true, error: styleError } : { ok: true, checked: true };
  }
  if (file.endsWith('.svelte')) {
    const compiler = projectRequire(root, 'svelte/compiler');
    if (!compiler || typeof compiler.parse !== 'function') {
      const styleError = sfcStyleCheck(root, file, text);
      return styleError ? { ok: false, checked: true, error: styleError } : { ok: true, checked: false };
    }
    try {
      compiler.parse(text);
      const styleError = sfcStyleCheck(root, file, text);
      if (styleError) return { ok: false, checked: true, error: styleError };
      return { ok: true, checked: true };
    } catch (err) {
      const line = err.start && err.start.line;
      return { ok: false, checked: true, error: `${err.message}${line ? ` (line ${line})` : ''}` };
    }
  }
  return { ok: true, checked: false };
}

// ---------- diff ----------

function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  if (n * m > 4e6) return [...a.map((l) => ['-', l]), ...b.map((l) => ['+', l])];
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push([' ', a[i++]]), j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(['-', a[i++]]);
    else ops.push(['+', b[j++]]);
  }
  while (i < n) ops.push(['-', a[i++]]);
  while (j < m) ops.push(['+', b[j++]]);
  return ops;
}

/** Unified diff with 3 lines of context. */
function unifiedDiff(before, after, name, context = 3) {
  const a = lf(before).split('\n');
  const b = lf(after).split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ops = [
    ...a.slice(0, pre).map((l) => [' ', l]),
    ...lcsOps(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf)),
    ...a.slice(a.length - suf).map((l) => [' ', l]),
  ];
  const lines = [`--- a/${name}`, `+++ b/${name}`];
  let added = 0;
  let removed = 0;
  let k = 0;
  let ai = 1;
  let bi = 1;
  const pos = ops.map(([t]) => {
    const p = [ai, bi];
    if (t !== '+') ai++;
    if (t !== '-') bi++;
    return p;
  });
  while (k < ops.length) {
    while (k < ops.length && ops[k][0] === ' ') k++;
    if (k >= ops.length) break;
    const start = Math.max(0, k - context);
    let end = k;
    let lastChange = k;
    while (end < ops.length && end - lastChange <= context * 2) {
      if (ops[end][0] !== ' ') lastChange = end;
      end++;
    }
    end = Math.min(ops.length, lastChange + context + 1);
    const chunk = ops.slice(start, end);
    const aCount = chunk.filter(([t]) => t !== '+').length;
    const bCount = chunk.filter(([t]) => t !== '-').length;
    lines.push(`@@ -${pos[start][0]},${aCount} +${pos[start][1]},${bCount} @@`);
    for (const [t, l] of chunk) {
      if (t === '+') added++;
      if (t === '-') removed++;
      lines.push(t + l);
    }
    k = end;
  }
  return { text: lines.join('\n'), added, removed };
}

// ---------- history (undo) ----------

function historyDir(root) {
  const nm = path.join(root, 'node_modules');
  if (!fs.existsSync(nm)) return privateTmpDir('sourcepeek-edits', crypto.createHash('sha1').update(root).digest('hex').slice(0, 10));
  const dir = path.join(nm, '.cache', 'sourcepeek', 'edits');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Undo and "Apply" write to paths read back from JSON files on disk. Check every one again before writing, as if a
 * client had sent it: a source or stylesheet file inside the project, not in a vendored or generated folder.
 * Throws 409 for anything else, so a tampered or stale entry can't write outside the project.
 */
const STORED_EXT = /\.(jsx|tsx|js|mjs|cjs|ts|vue|svelte|html|css|scss|sass|less)$/;

function checkStoredChanges(root, changes) {
  if (!Array.isArray(changes) || !changes.length) throw httpError(409, 'This change is damaged on disk and cannot be used.');
  return changes.map((c) => {
    const bad = (why) => httpError(409, `Refusing to write ${(c && c.rel) || 'a file'}: ${why}.`);
    if (!c || typeof c.abs !== 'string' || !path.isAbsolute(c.abs)) throw bad('no valid path');
    if (!(c.before === null || typeof c.before === 'string') || !(c.after === null || typeof c.after === 'string')) throw bad('damaged entry');
    const real = realish(c.abs);
    if (!STORED_EXT.test(real)) throw bad('not a source or stylesheet file');
    if (/[\\/](node_modules|\.git|\.next|dist|build)[\\/]/.test(real)) throw bad('generated or vendored folder');
    if (!insideRoot(root, real)) throw bad('outside the project');
    if (fs.existsSync(real) && !fs.statSync(real).isFile()) throw bad('not a file');
    const dirs = Array.isArray(c.dirs) ? c.dirs.filter((d) => typeof d === 'string' && path.isAbsolute(d) && insideRoot(root, realish(d))) : undefined;
    return { ...c, abs: real, dirs };
  });
}

const newId = () => Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
const entryPath = (root, id) => {
  if (!/^[\w-]+$/.test(String(id))) throw httpError(400, 'Invalid edit id');
  return path.join(historyDir(root), `${id}.json`);
};

function publicEntry(e) {
  return {
    id: e.id,
    at: e.at,
    request: e.request,
    summary: e.summary,
    kind: e.kind || null,
    styling: e.styling || null,
    undone: Boolean(e.undone),
    files: e.files.map((f) => ({ rel: f.rel, role: f.role, created: Boolean(f.created), diff: f.diff, added: f.added, removed: f.removed })),
  };
}

function newFileDiff(after, name) {
  const b = lf(after).replace(/\n$/, '').split('\n');
  return { text: [`--- /dev/null`, `+++ b/${name}`, `@@ -0,0 +1,${b.length} @@`, ...b.map((l) => '+' + l)].join('\n'), added: b.length, removed: 0 };
}

function withDiffs(changes) {
  return changes.map((c) => {
    const d = c.before === null ? newFileDiff(c.after, c.rel) : unifiedDiff(c.before, c.after, c.rel);
    return { ...c, diff: d.text, added: d.added, removed: d.removed };
  });
}

// Remove folders this tool created for a new component, if they are empty again.
function removeCreatedDirs(dirs) {
  for (const d of dirs || []) {
    try {
      fs.rmdirSync(d);
    } catch {}
  }
}

/**
 * Write a set of changes all-or-nothing. A change with before === null creates a new file (never
 * overwriting one); after === null deletes a file this tool created (used by undo).
 */
function writeAll(changes) {
  const done = [];
  const revert = (c) => {
    try {
      if (c.before === null) {
        fs.unlinkSync(c.abs);
        removeCreatedDirs(c.dirs);
      } else fs.writeFileSync(c.abs, c.before, 'utf8');
    } catch {}
  };
  try {
    for (const c of changes) {
      if (c.after === null) {
        if (fs.existsSync(c.abs)) fs.unlinkSync(c.abs);
        removeCreatedDirs(c.dirs);
      } else if (c.before === null) {
        const made = [];
        for (let d = path.dirname(c.abs); !fs.existsSync(d); d = path.dirname(d)) made.push(d);
        fs.mkdirSync(path.dirname(c.abs), { recursive: true });
        c.dirs = made; // deepest first, so undo can remove them in order
        fs.writeFileSync(c.abs, c.after, { encoding: 'utf8', flag: 'wx' });
      } else fs.writeFileSync(c.abs, c.after, 'utf8');
      done.push(c);
    }
    // A folder can hold several new files but is recorded on the first one only: retry once all are gone.
    for (const c of changes) if (c.after === null) removeCreatedDirs(c.dirs);
  } catch (err) {
    done.reverse().forEach(revert);
    if (err.code === 'EEXIST') throw httpError(409, `${path.basename(err.path || '')} appeared on disk in the meantime. Nothing was written.`);
    throw httpError(500, `Could not write ${path.basename(err.path || '')}: ${err.message}`);
  }
}

function record(root, request, summary, changes, meta = {}) {
  const entry = { id: newId(), at: new Date().toISOString(), request, summary, kind: meta.kind || null, styling: meta.styling || null, files: changes };
  fs.writeFileSync(entryPath(root, entry.id), JSON.stringify(entry));
  prune(root);
  return entry;
}

function prune(root) {
  try {
    const dir = historyDir(root);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - HISTORY_LIMIT))) fs.unlinkSync(path.join(dir, f));
  } catch {}
}

function history(root) {
  try {
    const dir = historyDir(root);
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, 20)
      .map((f) => publicEntry(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))));
  } catch {
    return [];
  }
}

function undo(root, id, force) {
  const file = entryPath(root, id);
  let entry;
  try {
    entry = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw httpError(404, 'This change is no longer in the undo history.');
  }
  if (entry.undone) throw httpError(409, 'This change was already undone.');
  entry.files = checkStoredChanges(root, entry.files);
  const changed = entry.files.filter((f) => {
    try {
      return fs.readFileSync(f.abs, 'utf8') !== f.after;
    } catch {
      return !f.created; // a new file that is already gone has nothing to undo
    }
  });
  if (changed.length && !force) {
    throw httpError(409, `${changed.map((f) => f.rel).join(', ')} changed after this edit. Undo would overwrite those newer changes.`, { conflict: true });
  }
  writeAll(entry.files.map((f) => ({ ...f, before: f.after, after: f.before })));
  entry.undone = true;
  fs.writeFileSync(file, JSON.stringify(entry));
  return publicEntry(entry);
}

// ---------- rebasing a change onto the file as it is now ----------

/** Hunks of a line diff: [{ aStart, old: [lines], neu: [lines] }] with up to `context` lines on each side. */
function diffHunks(a, b, context = 3) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ops = [...a.slice(0, pre).map((l) => [' ', l]), ...lcsOps(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf)), ...a.slice(a.length - suf).map((l) => [' ', l])];
  const hunks = [];
  let k = 0;
  let ai = 0;
  const aAt = ops.map(([t]) => {
    const p = ai;
    if (t !== '+') ai++;
    return p;
  });
  while (k < ops.length) {
    while (k < ops.length && ops[k][0] === ' ') k++;
    if (k >= ops.length) break;
    let end = k;
    // Changes separated by fewer than 2*context unchanged lines belong to one hunk.
    let last = k;
    while (end < ops.length && end - last <= context * 2) {
      if (ops[end][0] !== ' ') last = end;
      end++;
    }
    const start = Math.max(k - context, hunks.length ? hunks[hunks.length - 1].opEnd : 0);
    end = Math.min(ops.length, last + context + 1);
    const chunk = ops.slice(start, end);
    hunks.push({ aStart: aAt[start], old: chunk.filter(([t]) => t !== '+').map(([, l]) => l), neu: chunk.filter(([t]) => t !== '-').map(([, l]) => l), opEnd: end });
    k = end;
  }
  return hunks;
}

function findBlock(lines, block, from, expected) {
  const hits = [];
  if (!block.length) return hits;
  for (let i = from; i + block.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < block.length; j++) {
      if (lines[i + j] !== block[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits.sort((x, y) => Math.abs(x - expected) - Math.abs(y - expected));
}

/**
 * Re-apply the change before→after onto `current` (the file changed in the meantime: another applied change,
 * an editor save, a formatter). Each hunk is located by its own lines plus context; context is shrunk step by step
 * when the neighbouring lines changed too. Returns the new text, or null when a hunk no longer fits.
 */
function rebaseText(before, after, current) {
  const crlf = /\r\n/.test(current);
  const B = lf(before);
  const A = lf(after);
  const C = lf(current);
  if (C === B) return after;
  if (C === A) return current;
  const lines = C.split('\n');
  const hunks = diffHunks(B.split('\n'), A.split('\n'), 3);
  let drift = 0; // where the previous hunk landed in `current` relative to where it was in `before`
  let floor = 0; // hunks stay in order: the next one is searched after the previous one
  for (const h of hunks) {
    const lead = countLead(h);
    const tail = countTail(h);
    let placed = false;
    // Full context first, then less (the neighbouring lines may have changed too).
    for (let trim = 0; trim <= 3 && !placed; trim++) {
      const cutL = Math.min(trim, lead);
      const cutT = Math.min(trim, tail);
      const old = h.old.slice(cutL, h.old.length - cutT);
      const neu = h.neu.slice(cutL, h.neu.length - cutT);
      if (!old.length) continue; // a pure insertion needs at least one context line to anchor on
      const expected = h.aStart + cutL + drift;
      const hits = findBlock(lines, old, floor, expected);
      if (!hits.length) continue;
      const at = hits[0];
      lines.splice(at, old.length, ...neu);
      drift = at - (h.aStart + cutL) + (neu.length - old.length);
      floor = at + neu.length;
      placed = true;
    }
    if (!placed) return null;
  }
  const out = lines.join('\n');
  return crlf ? out.replace(/\n/g, '\r\n') : out;
}

// Number of unchanged context lines at the start / end of a hunk.
function countLead(h) {
  let n = 0;
  while (n < h.old.length && n < h.neu.length && h.old[n] === h.neu[n]) n++;
  return n;
}
function countTail(h) {
  let n = 0;
  const lead = countLead(h);
  while (n < h.old.length - lead && n < h.neu.length - lead && h.old[h.old.length - 1 - n] === h.neu[h.neu.length - 1 - n]) n++;
  return n;
}

/**
 * Make a set of changes current: every edited file is compared with what is on disk NOW. If the file changed since
 * the change was computed (another applied preview, an editor save, prettier…), the change is rebased onto it and
 * syntax-checked again. Throws 409 (with `regenerate: true`) when it can't be done safely.
 * Returns { changes, rebased: [rel] }.
 */
function rebaseOntoDisk(root, changes) {
  const rebased = [];
  const out = [];
  for (const c of changes) {
    if (c.before === null) {
      if (fs.existsSync(c.abs)) {
        let now = null;
        try {
          now = fs.readFileSync(c.abs, 'utf8');
        } catch {}
        if (now !== null && lf(now) === lf(c.after)) continue; // already there, identical
        throw httpError(409, `${c.rel} was created in the meantime, so this change can't create it. Generate it again.`, { conflict: true, regenerate: true });
      }
      out.push(c);
      continue;
    }
    let now;
    try {
      now = fs.readFileSync(c.abs, 'utf8');
    } catch {
      throw httpError(409, `${c.rel} no longer exists. Generate the change again.`, { conflict: true, regenerate: true });
    }
    if (now === c.before) {
      out.push(c);
      continue;
    }
    if (now === c.after) continue; // this exact change is already on disk
    const next = rebaseText(c.before, c.after, now);
    if (next === null) {
      throw httpError(409, `${c.rel} changed since this change was generated, and the change no longer fits the new code. Generate it again.`, { conflict: true, regenerate: true });
    }
    if (next === now) continue;
    const check = syntaxCheck(root, c.abs, next);
    if (!check.ok) {
      throw httpError(409, `${c.rel} changed since this change was generated; re-applying it there would not parse (${check.error}). Generate it again.`, { conflict: true, regenerate: true });
    }
    rebased.push(c.rel);
    out.push({ ...c, before: now, after: next });
  }
  if (!out.length) throw httpError(409, 'This change is already in your code — nothing to write.', { conflict: true, already: true });
  return { changes: rebased.length ? withDiffs(out) : out, rebased };
}

// ---------- pending proposals (review-before-write mode) ----------
// Kept in memory AND on disk: a dev-server reload (HMR re-evaluating this module, Next.js running the route in a
// second module instance, a restart) must not lose a preview the developer is still looking at.
// The in-memory copy is keyed by project root as well, like the one on disk.

const PENDING_DISK_TTL = 24 * 60 * 60 * 1000;
const pending = new Map();
const pendingKey = (root, id) => `${root ? realRoot(root) : ''}\0${id}`;

function pendingDir(root) {
  const dir = path.join(historyDir(root), 'pending');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const pendingPath = (root, id) => {
  if (!/^[\w-]+$/.test(String(id))) throw httpError(400, 'Invalid proposal id');
  return path.join(pendingDir(root), `${id}.json`);
};

function prunePending(root) {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.created > PENDING_DISK_TTL) pending.delete(k);
  try {
    const dir = pendingDir(root);
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        if (now - fs.statSync(p).mtimeMs > PENDING_DISK_TTL) fs.unlinkSync(p);
      } catch {}
    }
  } catch {}
}

function propose(request, summary, changes, meta = {}, root = null) {
  const now = Date.now();
  const id = newId();
  const p = { request, summary, changes, meta, created: now };
  pending.set(pendingKey(root, id), p);
  if (root) {
    prunePending(root);
    try {
      fs.writeFileSync(pendingPath(root, id), JSON.stringify(p));
    } catch {}
  }
  return id;
}

function loadPending(root, id) {
  const key = pendingKey(root, id);
  if (pending.has(key)) return pending.get(key);
  try {
    const p = JSON.parse(fs.readFileSync(pendingPath(root, id), 'utf8'));
    if (p && Array.isArray(p.changes) && Date.now() - p.created <= PENDING_DISK_TTL) return p;
  } catch {}
  return null;
}

function dropPending(root, id) {
  pending.delete(pendingKey(root, id));
  try {
    fs.unlinkSync(pendingPath(root, id));
  } catch {}
}

function commit(root, id) {
  const p = loadPending(root, id);
  if (!p) throw httpError(404, 'This preview is no longer available on the server. Generate it again.', { regenerate: true });
  // The proposal may come from disk: check its paths again, then re-check against the files as they are now and
  // rebase when they changed in the meantime.
  const { changes, rebased } = rebaseOntoDisk(root, checkStoredChanges(root, p.changes));
  writeAll(changes);
  dropPending(root, id);
  const entry = record(root, p.request, p.summary, changes, p.meta);
  entry.rebased = rebased;
  return entry;
}

function discard(id, root = null) {
  if (root) return dropPending(root, id);
  for (const k of [...pending.keys()]) if (k.endsWith(`\0${id}`)) pending.delete(k);
}

module.exports = {
  sourceExt,
  editableFiles,
  stylingHints,
  applyEdits,
  applyCreates,
  extraFile,
  STYLE_EXT,
  hoistVueStyles,
  normalizeVueChanges,
  resolveCreatable,
  syntaxCheck,
  unifiedDiff,
  withDiffs,
  writeAll,
  record,
  history,
  undo,
  checkStoredChanges,
  insideRoot,
  rebaseText,
  rebaseOntoDisk,
  propose,
  commit,
  discard,
  publicEntry,
  httpError,
};
