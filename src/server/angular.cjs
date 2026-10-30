'use strict';
// Angular support on the server.
//
// Angular templates are compiled by the Angular CLI, so elements carry no data-mf-* tags. In dev mode the browser
// knows which component owns an element (ng.getOwningComponent) and that component's class file (debug info the
// compiler emits since v17.1). This module does the rest:
//   • reads a component's @Component metadata (selector, templateUrl / inline template, styleUrl(s), standalone, imports)
//   • finds the line of the clicked element inside the template, from a description of the element
//   • maps a template file back to its component class, and a class to the NgModule that declares it
//   • checks Angular templates for syntax errors (with @angular/compiler when the project has it)

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { pathToFileURL } = require('url');
const { parse } = require('@babel/parser');

const toPosix = (p) => p.split(path.sep).join('/');
const SKIP_DIRS = new Set(['node_modules', '.git', '.angular', 'dist', 'build', 'out', 'coverage', '.cache', 'tmp']);

// ---------- project ----------

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

const projectCache = new Map();

/** { angular: bool, major: number|null } — cached per root, refreshed when package.json changes. */
function project(root) {
  const pkgPath = path.join(root, 'package.json');
  let mtime = 0;
  try {
    mtime = fs.statSync(pkgPath).mtimeMs;
  } catch {}
  const hit = projectCache.get(root);
  if (hit && hit.mtime === mtime) return hit.info;
  const pkg = readJson(pkgPath) || {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  let major = null;
  if (deps['@angular/core']) {
    try {
      major = Number(createRequire(pkgPath)('@angular/core/package.json').version.split('.')[0]);
    } catch {
      const m = String(deps['@angular/core']).match(/(\d+)/);
      major = m ? Number(m[1]) : null;
    }
  }
  const info = { angular: Boolean(deps['@angular/core']), major };
  projectCache.set(root, { mtime, info });
  return info;
}

const isAngular = (root) => project(root).angular;
const angularMajor = (root) => project(root).major;

/** Components are standalone by default from Angular 19. */
function isStandalone(meta, major) {
  if (!meta) return false;
  if (meta.standalone === true) return true;
  if (meta.standalone === false) return false;
  return (major || 0) >= 19;
}

// ---------- @Component metadata ----------

function astOf(code) {
  try {
    return parse(code, { sourceType: 'module', errorRecovery: true, plugins: ['typescript', 'decorators-legacy'] });
  } catch {
    return null;
  }
}

const keyName = (k) => (!k ? null : k.type === 'Identifier' ? k.name : k.type === 'StringLiteral' ? k.value : null);

function stringValue(n, code) {
  if (!n) return null;
  if (n.type === 'StringLiteral') return n.value;
  if (n.type === 'TemplateLiteral' && !n.expressions.length) return n.quasis.map((q) => q.value.cooked).join('');
  return null;
}

/**
 * All @Component classes in a .ts file:
 * [{ className, line, selector, templateUrl, template: {text, line, start, end}|null, styleUrls: [], inlineStyles,
 *    standalone: true|false|null, imports: {names, start, end}|null, decorator: {start, end} }]
 */
function componentsIn(code) {
  const ast = astOf(code);
  if (!ast) return [];
  const out = [];
  for (const top of ast.program.body) {
    const cls = top.type === 'ClassDeclaration' ? top : top.declaration && top.declaration.type === 'ClassDeclaration' ? top.declaration : null;
    if (!cls) continue;
    const decorators = [...(cls.decorators || []), ...(top.decorators || [])];
    const dec = decorators.find((d) => {
      const e = d.expression;
      const callee = e && e.type === 'CallExpression' ? e.callee : null;
      return callee && ((callee.type === 'Identifier' && callee.name === 'Component') || (callee.type === 'MemberExpression' && callee.property && callee.property.name === 'Component'));
    });
    if (!dec) continue;
    const arg = dec.expression.arguments[0];
    const meta = {
      className: cls.id ? cls.id.name : 'default',
      line: cls.id ? cls.id.loc.start.line : cls.loc.start.line,
      selector: null,
      templateUrl: null,
      template: null,
      styleUrls: [],
      inlineStyles: false,
      standalone: null,
      imports: null,
      decorator: { start: dec.start, end: dec.end, line: dec.loc.start.line },
    };
    if (arg && arg.type === 'ObjectExpression') {
      for (const p of arg.properties) {
        if (p.type !== 'ObjectProperty') continue;
        const k = keyName(p.key);
        const v = p.value;
        if (k === 'selector') meta.selector = stringValue(v, code);
        else if (k === 'templateUrl') meta.templateUrl = stringValue(v, code);
        else if (k === 'template' && (v.type === 'TemplateLiteral' || v.type === 'StringLiteral')) {
          // Line numbers inside the template map 1:1 onto the file, starting on the line of the opening quote.
          meta.template = { text: code.slice(v.start + 1, v.end - 1), line: v.loc.start.line, start: v.start + 1, end: v.end - 1 };
        } else if (k === 'styleUrl') {
          const s = stringValue(v, code);
          if (s) meta.styleUrls.push(s);
        } else if (k === 'styleUrls' && v.type === 'ArrayExpression') {
          for (const e of v.elements) {
            const s = stringValue(e, code);
            if (s) meta.styleUrls.push(s);
          }
        } else if (k === 'styles') meta.inlineStyles = true;
        else if (k === 'standalone' && v.type === 'BooleanLiteral') meta.standalone = v.value;
        else if (k === 'imports' && v.type === 'ArrayExpression') {
          meta.imports = { names: v.elements.filter((e) => e && e.type === 'Identifier').map((e) => e.name), start: v.start, end: v.end, all: v.elements.length };
        }
      }
    }
    out.push(meta);
  }
  return out;
}

function readText(abs) {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/** Resolve a templateUrl / styleUrl relative to its component file ('./x.html', 'x.html'). */
const resolveUrl = (tsAbs, url) => path.resolve(path.dirname(tsAbs), url);

function componentMeta(tsAbs, className, code) {
  const text = code !== undefined ? code : readText(tsAbs);
  if (text == null) return null;
  const all = componentsIn(text);
  return all.find((c) => c.className === className) || (all.length === 1 || !className ? all[0] : null) || null;
}

/** The template of a component: an external .html file, or the inline template inside the .ts file. */
function templateOf(tsAbs, meta) {
  if (!meta) return null;
  if (meta.templateUrl) {
    const abs = resolveUrl(tsAbs, meta.templateUrl);
    const text = readText(abs);
    return text == null ? null : { kind: 'external', abs, text, lineOffset: 0 };
  }
  if (meta.template) return { kind: 'inline', abs: tsAbs, text: meta.template.text, lineOffset: meta.template.line - 1 };
  return null;
}

function walkFiles(dir, test, out, limit, depth = 0) {
  if (out.length >= limit || depth > 8) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= limit) return;
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walkFiles(p, test, out, limit, depth + 1);
    } else if (test(e.name)) out.push(p);
  }
}

/** Component class file for a class name — used when the browser has no debug info (Angular < 17.1). */
function findClassFile(root, className) {
  if (!/^[A-Za-z_$][\w$]*$/.test(String(className || ''))) return null;
  const files = [];
  const src = path.join(root, 'src');
  walkFiles(fs.existsSync(src) ? src : root, (n) => /\.ts$/.test(n) && !/\.(spec|test|d)\.ts$/.test(n), files, 4000);
  if (fs.existsSync(path.join(root, 'projects'))) walkFiles(path.join(root, 'projects'), (n) => /\.ts$/.test(n) && !/\.(spec|test|d)\.ts$/.test(n), files, 8000);
  const rx = new RegExp(`\\bclass\\s+${className}\\b`);
  for (const f of files) {
    const t = readText(f);
    if (t && rx.test(t) && /@Component\s*\(/.test(t)) return f;
  }
  return null;
}

/** The component class that uses `htmlAbs` as its templateUrl. */
function ownerOfTemplate(htmlAbs) {
  const dir = path.dirname(htmlAbs);
  const base = path.basename(htmlAbs, '.html');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /\.ts$/.test(n) && !/\.(spec|test|d)\.ts$/.test(n));
  } catch {
    return null;
  }
  names.sort((a, b) => (a === base + '.ts' ? -1 : b === base + '.ts' ? 1 : 0));
  for (const n of names) {
    const tsAbs = path.join(dir, n);
    const code = readText(tsAbs);
    if (!code || !/templateUrl/.test(code)) continue;
    for (const meta of componentsIn(code)) {
      if (meta.templateUrl && resolveUrl(tsAbs, meta.templateUrl) === htmlAbs) return { abs: tsAbs, meta, code };
    }
  }
  return null;
}

/** The NgModule that declares a (non-standalone) component: looks in *.module.ts files up to 3 folders up. */
function declaringModule(root, tsAbs, className) {
  const rx = new RegExp(`declarations\\s*:\\s*\\[[^\\]]*\\b${className}\\b`);
  let dir = path.dirname(tsAbs);
  const rootReal = path.resolve(root);
  for (let i = 0; i < 4 && dir.startsWith(rootReal); i++, dir = path.dirname(dir)) {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => /\.module\.ts$/.test(n));
    } catch {}
    for (const n of names) {
      const abs = path.join(dir, n);
      const t = readText(abs);
      if (t && rx.test(t)) return abs;
    }
  }
  return null;
}

// ---------- template parsing ----------

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const VIRTUAL = new Set(['ng-container', 'ng-template', 'ng-content']); // never in the DOM

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineAtOffset(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * A forgiving HTML parser for Angular templates. Returns { nodes, errors }:
 * nodes: [{ tag, line, attrs: [{name, value}], parent, children, text }], errors: [{ message, line }].
 */
function parseTemplate(text) {
  const src = String(text).replace(/\r\n/g, '\n');
  const starts = lineStarts(src);
  const nodes = [];
  const errors = [];
  const root = { tag: '#root', children: [], text: '', parent: null };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      if (end === -1) {
        errors.push({ message: 'Unclosed comment <!--', line: lineAtOffset(starts, i) });
        break;
      }
      i = end + 3;
      continue;
    }
    if (src.startsWith('{{', i)) {
      const end = src.indexOf('}}', i + 2);
      if (end === -1) {
        errors.push({ message: 'Unclosed interpolation {{', line: lineAtOffset(starts, i) });
        break;
      }
      top().text += src.slice(i, end + 2);
      i = end + 2;
      continue;
    }
    if (src[i] === '<' && src[i + 1] === '/') {
      const m = src.slice(i).match(/^<\/\s*([A-Za-z][\w:.-]*)\s*>/);
      if (!m) {
        top().text += src[i];
        i++;
        continue;
      }
      const tag = m[1].toLowerCase();
      const at = stack.map((n) => n.tag).lastIndexOf(tag);
      if (at <= 0) {
        if (!VOID.has(tag)) errors.push({ message: `Unexpected closing tag </${m[1]}>`, line: lineAtOffset(starts, i) });
      } else {
        for (let k = stack.length - 1; k > at; k--) errors.push({ message: `Unclosed element <${stack[k].tag}>`, line: stack[k].line });
        stack.length = at;
      }
      i += m[0].length;
      continue;
    }
    if (src[i] === '<' && /[A-Za-z]/.test(src[i + 1] || '')) {
      const nameMatch = src.slice(i + 1).match(/^[A-Za-z][\w:.-]*/);
      const tag = nameMatch[0].toLowerCase();
      const node = { tag, rawTag: nameMatch[0], line: lineAtOffset(starts, i), offset: i, attrs: [], parent: top(), children: [], text: '' };
      let j = i + 1 + nameMatch[0].length;
      let closed = false;
      let selfClosing = false;
      while (j < src.length) {
        const c = src[j];
        if (/\s/.test(c)) {
          j++;
          continue;
        }
        if (c === '>') {
          closed = true;
          j++;
          break;
        }
        if (c === '/' && src[j + 1] === '>') {
          closed = true;
          selfClosing = true;
          j += 2;
          break;
        }
        if (c === '<') break; // a missing ">"
        const am = src.slice(j).match(/^[^\s=>]+/);
        const name = am ? am[0] : c;
        j += name.length || 1;
        let value = null;
        let k = j;
        while (/\s/.test(src[k] || '')) k++;
        if (src[k] === '=') {
          k++;
          while (/\s/.test(src[k] || '')) k++;
          const q = src[k];
          if (q === '"' || q === "'") {
            const end = src.indexOf(q, k + 1);
            if (end === -1) {
              errors.push({ message: `Unclosed attribute value in <${nameMatch[0]}>`, line: lineAtOffset(starts, k) });
              j = src.length;
              break;
            }
            value = src.slice(k + 1, end);
            j = end + 1;
          } else {
            const um = src.slice(k).match(/^[^\s>]+/);
            value = um ? um[0] : '';
            j = k + value.length;
          }
        }
        node.attrs.push({ name, value });
      }
      if (!closed) {
        errors.push({ message: `Unclosed tag <${nameMatch[0]}`, line: node.line });
        i = j;
        continue;
      }
      node.parent.children.push(node);
      nodes.push(node);
      if (!selfClosing && !VOID.has(tag)) stack.push(node);
      i = j;
      continue;
    }
    top().text += src[i];
    i++;
  }
  for (let k = stack.length - 1; k > 0; k--) errors.push({ message: `Unclosed element <${stack[k].rawTag}>`, line: stack[k].line });
  return { nodes, errors };
}

/** Control-flow braces (@if {…} / @for {…}) must balance; a literal { or } in text is an error since Angular 17. */
function blockBraceErrors(text) {
  const src = String(text).replace(/\r\n/g, '\n');
  const starts = lineStarts(src);
  const errors = [];
  let depth = 0;
  let i = 0;
  const open = [];
  while (i < src.length) {
    if (src.startsWith('<!--', i)) {
      const e = src.indexOf('-->', i);
      i = e === -1 ? src.length : e + 3;
      continue;
    }
    if (src.startsWith('{{', i)) {
      const e = src.indexOf('}}', i);
      i = e === -1 ? src.length : e + 2;
      continue;
    }
    if (src[i] === '<' && /[A-Za-z/]/.test(src[i + 1] || '')) {
      // skip the tag including quoted attribute values (bindings may contain braces)
      let j = i + 1;
      let q = null;
      for (; j < src.length; j++) {
        const c = src[j];
        if (q) {
          if (c === q) q = null;
        } else if (c === '"' || c === "'") q = c;
        else if (c === '>') break;
      }
      i = j + 1;
      continue;
    }
    if (src[i] === '@' && /[a-z]/.test(src[i + 1] || '')) {
      // @if (cond) {  — skip the parenthesised expression, then expect "{"
      const m = src.slice(i).match(/^@(\w+)\s*/);
      let j = i + m[0].length;
      if (src[j] === '(') {
        let d = 0;
        for (; j < src.length; j++) {
          if (src[j] === '(') d++;
          else if (src[j] === ')' && --d === 0) {
            j++;
            break;
          }
        }
        while (/\s/.test(src[j] || '')) j++;
      }
      if (src[j] === '{') {
        depth++;
        open.push(lineAtOffset(starts, i));
        i = j + 1;
        continue;
      }
      if (m[1] === 'let') {
        const e = src.indexOf(';', j);
        i = e === -1 ? src.length : e + 1;
        continue;
      }
      i = j;
      continue;
    }
    if (src[i] === '}') {
      if (depth === 0) errors.push({ message: 'Unexpected "}" — close only @if / @for / @switch blocks, write a literal brace as {{ \'}\' }}', line: lineAtOffset(starts, i) });
      else {
        depth--;
        open.pop();
      }
    } else if (src[i] === '{') {
      errors.push({ message: 'Unexpected "{" in text — write a literal brace as {{ \'{\' }}', line: lineAtOffset(starts, i) });
    }
    i++;
  }
  if (depth > 0) errors.push({ message: 'A control-flow block (@if / @for / @switch …) is missing its closing "}"', line: open[open.length - 1] });
  return errors;
}

// ---------- finding the clicked element ----------

const normText = (s) => String(s || '').replace(/\s+/g, ' ').trim();
// control-flow syntax that ends up in text nodes
const stripBlocks = (s) => String(s || '').replace(/@\w+\s*(\([^)]*\))?\s*\{|@let\s[^;]*;|\}/g, ' ');

function staticClasses(node) {
  const out = [];
  for (const a of node.attrs) if (a.name === 'class' && a.value) out.push(...a.value.split(/\s+/).filter(Boolean));
  return out;
}

function boundClasses(node) {
  const out = [];
  for (const a of node.attrs) {
    const m = a.name.match(/^\[class\.([\w-]+)\]$/);
    if (m) out.push(m[1]);
  }
  return out;
}

function textScore(tplText, domText) {
  const t = normText(stripBlocks(tplText));
  const d = normText(domText);
  if (!t || !d) return 0;
  if (!/\{\{/.test(t)) return t === d ? 8 : d.includes(t) || t.includes(d) ? 3 : -1;
  const parts = t.split(/\{\{[\s\S]*?\}\}/).map((p) => p.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  try {
    const rx = new RegExp('^' + parts.join('[\\s\\S]*?') + '$');
    return rx.test(d) ? 6 : parts.some((p) => p && d.includes(p.replace(/\\/g, ''))) ? 1 : -1;
  } catch {
    return 0;
  }
}

/** Real (DOM-producing) ancestors of a template node, innermost first. */
function tplAncestors(node) {
  const out = [];
  for (let p = node.parent; p && p.tag !== '#root'; p = p.parent) if (!VIRTUAL.has(p.tag)) out.push(p.tag);
  return out;
}

function sameTagIndex(node) {
  // siblings in the DOM sense: children of the nearest real ancestor, looking through ng-container / ng-template
  let parent = node.parent;
  while (parent && VIRTUAL.has(parent.tag)) parent = parent.parent;
  const flat = [];
  const collect = (n) => {
    for (const c of n.children) {
      if (VIRTUAL.has(c.tag)) collect(c);
      else flat.push(c);
    }
  };
  if (parent) collect(parent);
  return flat.filter((c) => c.tag === node.tag).indexOf(node);
}

/**
 * Best template element for a DOM element description:
 * desc = { tag, id, classes: [], attrs: [names], text, chain: [ancestor tags, innermost first], index }
 * Returns { node, score, candidates } or null.
 */
function locateElement(nodes, desc) {
  const tag = String(desc.tag || '').toLowerCase();
  const domClasses = new Set(desc.classes || []);
  const domAttrs = new Set((desc.attrs || []).map((a) => String(a).toLowerCase()));
  const chain = (desc.chain || []).map((t) => String(t).toLowerCase());
  let best = null;
  let candidates = 0;
  for (const n of nodes) {
    if (n.tag !== tag) continue;
    candidates++;
    let score = 0;
    // ancestors, innermost first
    const anc = tplAncestors(n);
    for (let k = 0; k < Math.min(anc.length, chain.length); k++) {
      if (anc[k] !== chain[k]) {
        score -= 1;
        break;
      }
      score += 2;
    }
    for (const c of staticClasses(n)) score += domClasses.has(c) ? 3 : -2;
    for (const c of boundClasses(n)) if (domClasses.has(c)) score += 1;
    const id = n.attrs.find((a) => a.name === 'id');
    if (id && id.value && desc.id) score += id.value === desc.id ? 6 : -3;
    else if (id && id.value && !/\{\{/.test(id.value) && !desc.id) score -= 2;
    for (const a of n.attrs) {
      const name = a.name.toLowerCase();
      if (/^[[(*#@]/.test(name) || name === 'class' || name === 'id' || name === 'style') continue;
      score += domAttrs.has(name) ? 1 : -1;
    }
    if (desc.text) score += textScore(n.text, desc.text);
    if (typeof desc.index === 'number' && desc.index === sameTagIndex(n)) score += 1;
    if (!best || score > best.score) best = { node: n, score };
  }
  return best ? { ...best, candidates } : null;
}

/**
 * Where an element is written: the template file (or the .ts file for inline templates) and line.
 * classAbs: the component's .ts file. Returns { file: abs, line, classAbs, classLine, meta, matched } or null.
 */
function locate(classAbs, className, desc) {
  const code = readText(classAbs);
  if (code == null) return null;
  const meta = componentMeta(classAbs, className, code);
  if (!meta) return { file: classAbs, line: 1, classAbs, classLine: 1, meta: null, matched: false };
  const tpl = templateOf(classAbs, meta);
  if (!tpl) return { file: classAbs, line: meta.line, classAbs, classLine: meta.line, meta, matched: false };
  const { nodes } = parseTemplate(tpl.text);
  const hit = desc && desc.tag ? locateElement(nodes, desc) : null;
  const fallbackLine = tpl.kind === 'inline' ? meta.template.line : 1;
  return {
    file: tpl.abs,
    line: hit ? hit.node.line + tpl.lineOffset : fallbackLine,
    classAbs,
    classLine: meta.line,
    meta,
    matched: Boolean(hit),
    score: hit ? hit.score : null,
  };
}

// ---------- syntax check ----------

const compilerCache = new Map();

/** Loads the project's @angular/compiler (ESM-only) once, so the synchronous syntax check can use it. */
async function prepare(root) {
  if (compilerCache.has(root)) return compilerCache.get(root);
  let compiler = null;
  try {
    const resolved = createRequire(path.join(root, 'package.json')).resolve('@angular/compiler');
    compiler = await import(pathToFileURL(resolved).href);
    if (typeof compiler.parseTemplate !== 'function') compiler = null;
  } catch {
    compiler = null;
  }
  compilerCache.set(root, compiler);
  return compiler;
}

function compilerErrors(compiler, text, url) {
  try {
    const res = compiler.parseTemplate(text, url, { preserveWhitespaces: true, enableBlockSyntax: true, enableLetSyntax: true });
    return (res.errors || []).map((e) => ({ message: String(e.msg || e.message || e).split('\n')[0], line: e.span && e.span.start ? e.span.start.line + 1 : null }));
  } catch (err) {
    return [{ message: String(err.message || err).split('\n')[0], line: null }];
  }
}

/** Errors in an Angular template (text of an .html file or of an inline template). */
function templateErrors(root, text, url = 'template.html') {
  const compiler = compilerCache.get(root);
  if (compiler) return compilerErrors(compiler, text, url);
  const errs = parseTemplate(text).errors;
  if ((angularMajor(root) || 0) >= 17) errs.push(...blockBraceErrors(text));
  return errs;
}

function formatErrors(errs, lineOffset = 0) {
  const e = errs[0];
  return `${e.message}${e.line ? ` (line ${e.line + lineOffset})` : ''}`;
}

/** Syntax check for an .html template; null when fine. */
function checkTemplateFile(root, file, text) {
  const errs = templateErrors(root, text, path.basename(file));
  return errs.length ? `Angular template: ${formatErrors(errs)}` : null;
}

/** Syntax check of the inline templates in a component .ts file; null when fine. */
function checkInlineTemplates(root, file, code) {
  if (!/@Component\s*\(/.test(code) || !/\btemplate\s*:/.test(code)) return null;
  for (const meta of componentsIn(code)) {
    if (!meta.template) continue;
    const errs = templateErrors(root, meta.template.text, path.basename(file));
    if (errs.length) return `inline template of ${meta.className}: ${formatErrors(errs, meta.template.line - 1)}`;
  }
  return null;
}

/** Template text of every component in a .ts file plus, for external templates, nothing (they are separate files). */
function inlineTemplates(code) {
  return componentsIn(code)
    .filter((m) => m.template)
    .map((m) => ({ className: m.className, text: m.template.text }));
}

module.exports = {
  project,
  isAngular,
  angularMajor,
  isStandalone,
  componentsIn,
  componentMeta,
  templateOf,
  findClassFile,
  ownerOfTemplate,
  declaringModule,
  parseTemplate,
  blockBraceErrors,
  locateElement,
  locate,
  prepare,
  checkTemplateFile,
  checkInlineTemplates,
  inlineTemplates,
  resolveUrl,
  toPosix,
};
