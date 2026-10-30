'use strict';
// Small source lookups the browser can't do itself:
//   • handlerAt — the element written at file:line has `onClick={toggle}` (JSX), `@click="toggle"` (Vue),
//     `(click)="toggle()"` (Angular), `onclick={toggle}` / `on:click={toggle}` (Svelte): where is `toggle` declared?
//     Used by Web Vitals to point a slow interaction (INP) at the handler's file and line.
//   • attrAt — at a call-site `<ProductCard price={item.price} />`, what expression feeds the prop `price`, and is
//     `item` the parameter of `data.items.map(item => …)`? Used by "Where does this value come from?".

const fs = require('fs');
const path = require('path');
const { parse } = require('@babel/parser');
const angular = require('./angular.cjs');

const IDENT = /^[A-Za-z_$][\w$]*$/;

function plugins(file) {
  if (/\.tsx$/.test(file)) return ['jsx', 'typescript', 'decorators-legacy'];
  if (/\.ts$/.test(file)) return ['typescript', 'decorators-legacy'];
  return ['jsx', 'decorators-legacy'];
}

function astOf(file, code) {
  try {
    return parse(code, {
      sourceType: 'module',
      errorRecovery: true,
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true,
      plugins: plugins(file),
    });
  } catch {
    return null;
  }
}

/** Walk with parent links. fn(node, parents) — return false to skip children. */
function walk(node, fn, parents = []) {
  if (!node || typeof node.type !== 'string') return;
  if (fn(node, parents) === false) return;
  parents.push(node);
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra' || k.endsWith('Comments')) continue;
    const v = node[k];
    if (Array.isArray(v)) for (const x of v) walk(x, fn, parents);
    else if (v && typeof v.type === 'string') walk(v, fn, parents);
  }
  parents.pop();
}

const clip = (s, n = 160) => {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// ---------- event names ----------

const EVENT_PROPS = {
  click: ['onClick', 'onClickCapture', 'onDoubleClick'],
  dblclick: ['onDoubleClick'],
  pointerdown: ['onPointerDown', 'onMouseDown', 'onTouchStart', 'onClick'],
  pointerup: ['onPointerUp', 'onMouseUp', 'onTouchEnd', 'onClick'],
  mousedown: ['onMouseDown', 'onPointerDown'],
  mouseup: ['onMouseUp', 'onPointerUp'],
  keydown: ['onKeyDown', 'onKeyPress', 'onChange', 'onInput', 'onBeforeInput'],
  keyup: ['onKeyUp', 'onChange', 'onInput'],
  keypress: ['onKeyPress', 'onKeyDown', 'onChange', 'onInput'],
  input: ['onInput', 'onChange'],
  change: ['onChange'],
  submit: ['onSubmit'],
};

function propNames(events) {
  const out = [];
  for (const e of events || []) for (const p of EVENT_PROPS[e] || [`on${e[0].toUpperCase()}${e.slice(1)}`]) if (!out.includes(p)) out.push(p);
  return out.length ? out : ['onClick'];
}

/** Template event names (Vue @x, Angular (x), Svelte on:x / onx) for the interaction's events. */
function domEvents(events) {
  const out = new Set();
  for (const p of propNames(events)) out.add(p.replace(/^on/, '').replace(/Capture$/, '').toLowerCase());
  for (const e of events || []) out.add(e);
  out.add('click');
  return [...out];
}

// ---------- declarations ----------

/** Line where `name` is declared in this file: function, const/let/var, class method or class field. */
function declIn(ast, name) {
  let hit = null;
  walk(ast.program, (n) => {
    if (hit) return false;
    if ((n.type === 'FunctionDeclaration' || n.type === 'TSDeclareFunction') && n.id && n.id.name === name) hit = { line: n.loc.start.line, kind: 'function' };
    else if (n.type === 'VariableDeclarator' && n.id && n.id.type === 'Identifier' && n.id.name === name) hit = { line: n.loc.start.line, kind: 'function' };
    else if ((n.type === 'ClassMethod' || n.type === 'ClassProperty' || n.type === 'ObjectMethod' || n.type === 'ClassPrivateMethod') && n.key && (n.key.name === name || n.key.value === name)) hit = { line: n.loc.start.line, kind: 'method' };
    else if (n.type === 'ObjectProperty' && n.key && n.key.name === name && n.value && /Function/.test(n.value.type)) hit = { line: n.loc.start.line, kind: 'method' };
    return undefined;
  });
  return hit;
}

/** Is `name` a prop of the component that contains `parents` (a destructured parameter, or `props.name`)? */
function isPropOf(parents, name) {
  for (let i = parents.length - 1; i >= 0; i--) {
    const p = parents[i];
    if (!/Function/.test(p.type) || !p.params || !p.params.length) continue;
    const first = p.params[0];
    if (first.type === 'ObjectPattern') {
      for (const prop of first.properties) {
        const v = prop.type === 'RestElement' ? null : prop.value && prop.value.type === 'AssignmentPattern' ? prop.value.left : prop.value;
        if (v && v.type === 'Identifier' && v.name === name) return true;
      }
    }
  }
  return false;
}

function src(code, n) {
  return code.slice(n.start, n.end);
}

// ---------- JSX ----------

/** The JSX opening element written at `line` (the one starting there, else the innermost spanning it). */
function jsxElementAt(ast, line) {
  let start = null;
  let span = null;
  walk(ast.program, (n, parents) => {
    if (n.type !== 'JSXOpeningElement' || !n.loc) return undefined;
    if (n.loc.start.line === line && !start) start = { node: n, parents: parents.slice() };
    else if (n.loc.start.line <= line && n.loc.end.line >= line) span = { node: n, parents: parents.slice() };
    return undefined;
  });
  return start || span;
}

function jsxAttr(el, names) {
  for (const want of names) {
    const a = el.attributes.find((x) => x.type === 'JSXAttribute' && x.name && (x.name.name === want || (x.name.name && x.name.name.name === want)));
    if (a) return a;
  }
  return null;
}

function resolveExpr(ast, code, expr, parents, file) {
  const at = (n) => n.loc.start.line;
  if (!expr) return null;
  if (expr.type === 'Identifier') {
    const d = declIn(ast, expr.name);
    if (isPropOf(parents, expr.name)) return { name: expr.name, kind: 'prop', line: at(expr) };
    return d ? { name: expr.name, kind: d.kind, line: d.line } : { name: expr.name, kind: 'unknown', line: at(expr) };
  }
  if (expr.type === 'MemberExpression' || expr.type === 'OptionalMemberExpression') {
    const prop = expr.property && (expr.property.name || expr.property.value);
    const obj = expr.object;
    if (obj.type === 'ThisExpression' && prop) {
      const d = declIn(ast, prop);
      return { name: `this.${prop}`, kind: 'method', line: d ? d.line : at(expr) };
    }
    if (obj.type === 'Identifier' && obj.name === 'props') return { name: `props.${prop}`, kind: 'prop', line: at(expr) };
    return { name: clip(src(code, expr), 60), kind: 'member', line: at(expr) };
  }
  if (expr.type === 'ArrowFunctionExpression' || expr.type === 'FunctionExpression') {
    // `() => toggle(id)` / `e => { e.preventDefault(); save(); }` — point at the inline handler and the function it calls.
    let call = null;
    walk(expr.body, (n) => {
      if (call) return false;
      if (n.type === 'CallExpression' && (n.callee.type === 'Identifier' || (n.callee.type === 'MemberExpression' && n.callee.object.type === 'ThisExpression'))) {
        const nm = n.callee.type === 'Identifier' ? n.callee.name : n.callee.property.name;
        if (!/^(preventDefault|stopPropagation|set[A-Z]\w*)$/.test(nm)) call = n;
      }
      return undefined;
    });
    const out = { name: 'inline handler', kind: 'inline', line: at(expr) };
    if (call) {
      const nm = call.callee.type === 'Identifier' ? call.callee.name : call.callee.property.name;
      const d = declIn(ast, nm);
      if (d) out.calls = { name: nm, line: d.line };
      else if (isPropOf(parents, nm)) out.calls = { name: nm, line: at(call), prop: true };
    }
    return out;
  }
  if (expr.type === 'CallExpression') {
    const callee = expr.callee.type === 'Identifier' ? expr.callee.name : null;
    const d = callee ? declIn(ast, callee) : null;
    return { name: clip(src(code, expr), 60), kind: 'factory', line: d ? d.line : at(expr) };
  }
  return { name: clip(src(code, expr), 60), kind: 'expression', line: at(expr) };
}

function jsxHandler(file, code, line, events) {
  const ast = astOf(file, code);
  if (!ast) return null;
  const hit = jsxElementAt(ast, line);
  if (!hit) return null;
  let attr = jsxAttr(hit.node, propNames(events));
  if (!attr) attr = hit.node.attributes.find((a) => a.type === 'JSXAttribute' && a.name && /^on[A-Z]/.test(a.name.name || ''));
  if (!attr || !attr.value || attr.value.type !== 'JSXExpressionContainer') return null;
  const r = resolveExpr(ast, code, attr.value.expression, hit.parents, file);
  return r ? { ...r, attr: clip(src(code, attr), 140), attrLine: attr.loc.start.line, prop: attr.name.name } : null;
}

// ---------- templates (Vue, Angular, Svelte) ----------

/** The text of the start tag that covers `line` (it may span several lines). */
function tagTextAt(code, line) {
  const lines = code.split('\n');
  let i = line - 1;
  // walk back to the line holding the tag's `<`
  while (i > 0 && !/<[A-Za-z]/.test(lines[i]) && i > line - 8) i--;
  let text = '';
  for (let j = i; j < Math.min(lines.length, i + 20); j++) {
    text += lines[j] + '\n';
    if (/>\s*$|\/>/.test(lines[j]) && j >= line - 1) break;
  }
  return text;
}

function scriptDecl(code, name, offsetLine = 0) {
  if (!IDENT.test(name)) return null;
  const rx = [
    new RegExp(`(?:^|\\n)[ \\t]*(?:export\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${name}\\s*\\(`),
    new RegExp(`(?:^|\\n)[ \\t]*(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*(?::[^=\\n]+)?=`),
    new RegExp(`(?:^|\\n)[ \\t]*(?:(?:public|private|protected|readonly|static|async|override)\\s+)*${name}\\s*(?:<[^>\\n]*>)?\\s*\\([^)\\n]*\\)\\s*(?::[^{\\n]+)?\\{`),
    new RegExp(`(?:^|\\n)[ \\t]*(?:(?:public|private|protected|readonly|static)\\s+)*${name}\\s*(?::[^=\\n]+)?=\\s*(?:async\\s*)?\\(`),
  ];
  for (const r of rx) {
    const m = r.exec(code);
    if (m) return { line: lineOf(code, m.index + (m[0].startsWith('\n') ? 1 : 0)) + offsetLine };
  }
  return null;
}

const leadIdent = (expr) => {
  const m = /^\s*(?:\$event\s*=>\s*)?(?:this\.)?([A-Za-z_$][\w$]*)/.exec(String(expr || ''));
  return m ? m[1] : null;
};

function templateHandler(root, abs, code, line, events) {
  const tag = tagTextAt(code, line);
  const names = domEvents(events);
  let m = null;
  let flavour = '';
  if (/\.vue$/.test(abs)) {
    for (const ev of names) {
      m = new RegExp(`(?:@|v-on:)${ev}(?:\\.[\\w.]+)?\\s*=\\s*"([^"]*)"`, 'i').exec(tag) || new RegExp(`(?:@|v-on:)${ev}(?:\\.[\\w.]+)?\\s*=\\s*'([^']*)'`, 'i').exec(tag);
      if (m) break;
    }
    flavour = 'vue';
  } else if (/\.svelte$/.test(abs)) {
    for (const ev of names) {
      m = new RegExp(`(?:on:${ev}(?:\\|[\\w|]+)?|on${ev})\\s*=\\s*\\{([^}]*)\\}`, 'i').exec(tag);
      if (m) break;
    }
    flavour = 'svelte';
  } else {
    for (const ev of names) {
      m = new RegExp(`\\(${ev}(?:\\.[\\w.]+)?\\)\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
      if (m) break;
    }
    flavour = 'angular';
  }
  if (!m) return null;
  const expr = m[1].trim();
  const arrow = /=>/.test(expr) && !/^\s*\$event\s*=>/.test(expr);
  const body = (arrow ? expr.split('=>').slice(1).join('=>') : expr).trim().replace(/^\{\s*/, '');
  // A handler name (`save`) or a call (`save($event)`, `this.save()`) points at a function; anything else
  // (`count++`, `open = !open`) is the handler itself, written inline.
  const called = /^(?:this\.)?[A-Za-z_$][\w$]*\s*\(/.test(body) || (!arrow && /^(?:this\.)?[A-Za-z_$][\w$]*\s*;?$/.test(body));
  let name = called ? leadIdent(body) : null;
  if (!name) return { name: clip(expr, 60), kind: 'inline', line, file: abs, attr: clip(m[0], 140), attrLine: line };
  let file = abs;
  let decl = null;
  if (flavour === 'angular') {
    const owner = abs.endsWith('.html') ? angular.ownerOfTemplate(abs) : { abs, code };
    if (owner) {
      file = owner.abs;
      decl = scriptDecl(owner.code, name);
    }
  } else {
    const blocks = [...code.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
    for (const b of blocks) {
      const offset = lineOf(code, b.index) - 1;
      decl = scriptDecl(b[1], name, offset);
      if (decl) break;
    }
  }
  return {
    name,
    kind: decl ? (arrow ? 'inline' : 'function') : 'unknown',
    line: decl ? decl.line : line,
    file,
    attr: clip(m[0], 140),
    attrLine: line,
    ...(arrow && decl ? { calls: { name, line: decl.line } } : {}),
  };
}

// ---------- public ----------

/** Where the handler of the element at file:line is declared. */
function handlerAt(root, abs, line, events) {
  const code = fs.readFileSync(abs, 'utf8');
  const rel = (p) => path.relative(root, p).split(path.sep).join('/');
  let r = null;
  if (/\.(jsx|tsx|js|mjs)$/.test(abs)) r = jsxHandler(abs, code, line, events);
  if (!r && /\.(vue|svelte|html|ts)$/.test(abs)) r = templateHandler(root, abs, code, line, events);
  if (!r) return { found: false };
  return { found: true, ...r, file: rel(r.file || abs), attrFile: rel(abs) };
}

// ---------- call-site attributes (value provenance) ----------

/** `item` in `items.map((item, i) => <Card price={item.price} />)`: the collection it iterates, as written. */
function iterationOf(code, parents, ident) {
  for (let i = parents.length - 1; i >= 0; i--) {
    const fnNode = parents[i];
    if (!/^(ArrowFunctionExpression|FunctionExpression)$/.test(fnNode.type)) continue;
    const param = fnNode.params[0];
    const names = new Set();
    const collect = (p) => {
      if (!p) return;
      if (p.type === 'Identifier') names.add(p.name);
      else if (p.type === 'ObjectPattern') p.properties.forEach((x) => collect(x.type === 'RestElement' ? x.argument : x.value && x.value.type === 'AssignmentPattern' ? x.value.left : x.value));
      else if (p.type === 'AssignmentPattern') collect(p.left);
    };
    collect(param);
    if (!names.has(ident)) continue;
    const call = parents[i - 1];
    if (call && call.type === 'CallExpression' && call.callee.type === 'MemberExpression' && /^(map|flatMap|forEach|filter)$/.test(call.callee.property.name || '')) {
      return { collection: clip(src(code, call.callee.object), 80), param: ident, line: call.loc.start.line, destructured: param.type === 'ObjectPattern' };
    }
    return null;
  }
  return null;
}

function rootIdent(expr) {
  let n = expr;
  while (n && (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression' || n.type === 'TSNonNullExpression' || n.type === 'CallExpression' || n.type === 'OptionalCallExpression')) {
    n = n.type === 'TSNonNullExpression' ? n.expression : n.object || n.callee;
  }
  return n && n.type === 'Identifier' ? n.name : null;
}

function jsxAttrAt(file, code, line, prop) {
  const ast = astOf(file, code);
  if (!ast) return null;
  const hit = jsxElementAt(ast, line);
  if (!hit) return null;
  const el = hit.node;
  const attr = el.attributes.find((a) => a.type === 'JSXAttribute' && a.name && a.name.name === prop);
  if (attr) {
    if (!attr.value) return { kind: 'literal', expr: 'true', line: attr.loc.start.line, text: prop };
    if (attr.value.type === 'StringLiteral') return { kind: 'literal', expr: JSON.stringify(attr.value.value), line: attr.loc.start.line, text: clip(src(code, attr)) };
    const expr = attr.value.expression;
    const id = rootIdent(expr);
    return { kind: 'expression', expr: clip(src(code, expr), 120), line: attr.loc.start.line, text: clip(src(code, attr)), root: id, iterates: id ? iterationOf(code, hit.parents, id) : null };
  }
  const spread = el.attributes.find((a) => a.type === 'JSXSpreadAttribute');
  if (spread) {
    const id = rootIdent(spread.argument);
    return { kind: 'spread', expr: clip(src(code, spread.argument), 120), line: spread.loc.start.line, text: clip(src(code, spread)), root: id, iterates: id ? iterationOf(code, hit.parents, id) : null };
  }
  return { kind: 'missing', line: el.loc.start.line, text: clip(src(code, el.name), 60) };
}

const kebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

function templateAttrAt(abs, code, line, prop) {
  const tag = tagTextAt(code, line);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = [...new Set([prop, kebab(prop)])].map(esc).join('|');
  let m;
  if (/\.vue$/.test(abs)) {
    m = new RegExp(`(?:^|\\s)(?::|v-bind:)(?:${names})\\s*=\\s*"([^"]*)"`).exec(tag);
    if (m) return { kind: 'expression', expr: clip(m[1], 120), line, text: clip(m[0]), root: leadIdent(m[1]), iterates: vueFor(tag, leadIdent(m[1])) };
    m = new RegExp(`(?:^|\\s)(?:${names})\\s*=\\s*"([^"]*)"`).exec(tag);
    if (m) return { kind: 'literal', expr: JSON.stringify(m[1]), line, text: clip(m[0]) };
    if (/v-bind="([^"]+)"/.test(tag)) {
      const s = /v-bind="([^"]+)"/.exec(tag);
      return { kind: 'spread', expr: s[1], line, text: clip(s[0]), root: leadIdent(s[1]), iterates: vueFor(tag, leadIdent(s[1])) };
    }
  } else if (/\.svelte$/.test(abs)) {
    m = new RegExp(`(?:^|\\s)(?:${names})\\s*=\\s*\\{([^}]*)\\}`).exec(tag);
    if (m) return { kind: 'expression', expr: clip(m[1], 120), line, text: clip(m[0]), root: leadIdent(m[1]) };
    m = new RegExp(`\\{(${esc(prop)})\\}`).exec(tag);
    if (m) return { kind: 'shorthand', expr: prop, line, text: m[0], root: prop };
    m = new RegExp(`(?:^|\\s)(?:${names})\\s*=\\s*"([^"]*)"`).exec(tag);
    if (m) return { kind: 'literal', expr: JSON.stringify(m[1]), line, text: clip(m[0]) };
  } else {
    m = new RegExp(`\\[(?:${names})\\]\\s*=\\s*"([^"]*)"`).exec(tag);
    if (m) return { kind: 'expression', expr: clip(m[1], 120), line, text: clip(m[0]), root: leadIdent(m[1]), iterates: ngFor(code, line, leadIdent(m[1])) };
    m = new RegExp(`(?:^|\\s)(?:${names})\\s*=\\s*"([^"]*)"`).exec(tag);
    if (m) return { kind: /\{\{/.test(m[1]) ? 'expression' : 'literal', expr: /\{\{/.test(m[1]) ? clip(m[1], 120) : JSON.stringify(m[1]), line, text: clip(m[0]) };
  }
  return { kind: 'missing', line, text: clip(tag.split(/\s/)[0], 60) };
}

function vueFor(tag, ident) {
  if (!ident) return null;
  const m = /v-for\s*=\s*"\s*\(?\s*([A-Za-z_$][\w$]*)[^"]*?\s+(?:in|of)\s+([^"]+)"/.exec(tag);
  return m && m[1] === ident ? { collection: m[2].trim(), param: ident } : null;
}

function ngFor(code, line, ident) {
  if (!ident) return null;
  const before = code.split('\n').slice(Math.max(0, line - 15), line).join('\n');
  const m = [...before.matchAll(/\*ngFor\s*=\s*"\s*let\s+([A-Za-z_$][\w$]*)\s+of\s+([^;"]+)/g), ...before.matchAll(/@for\s*\(\s*([A-Za-z_$][\w$]*)\s+of\s+([^;)]+)/g)].pop();
  return m && m[1] === ident ? { collection: m[2].trim(), param: ident } : null;
}

/** First line where `<tag` is written (Vue / Svelte / Angular templates, when the browser doesn't know the line). */
function tagLine(code, tag) {
  const names = [...new Set([tag, kebab(tag).replace(/^-/, '')])].filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const m = new RegExp(`<(?:${names.join('|')})(?=[\\s/>])`).exec(code);
  return m ? lineOf(code, m.index) : null;
}

/**
 * At a call-site, the expression that feeds `prop`. Without a line (Vue, Angular parents), `tag` — the child's
 * component name or selector — finds its first use in the parent's template.
 */
function attrAt(root, abs, line, prop, tag) {
  if (!IDENT.test(String(prop || '')) && !/^[\w-]+$/.test(String(prop || ''))) return { found: false };
  let file = abs;
  let code = fs.readFileSync(abs, 'utf8');
  if (!line && tag && /^[\w-]+$/.test(tag)) {
    if (/\.ts$/.test(abs)) {
      // Angular parent: its template is the .html next to it, or the inline template.
      const meta = angular.componentsIn(code).find((m) => m.templateUrl || m.template);
      const tpl = meta ? angular.templateOf(abs, meta) : null;
      if (tpl) {
        const l = tagLine(tpl.text, tag);
        if (l) {
          line = l + tpl.lineOffset;
          if (tpl.kind === 'external') {
            file = tpl.abs;
            code = tpl.text;
          }
        }
      }
    } else line = tagLine(code, tag);
  }
  if (!line) return { found: false };
  let r = null;
  if (/\.(jsx|tsx|js|mjs)$/.test(file)) r = jsxAttrAt(file, code, line, prop);
  else if (/\.(vue|svelte|html|ts)$/.test(file)) r = templateAttrAt(file, code, line, prop);
  const rel = path.relative(root, file).split(path.sep).join('/');
  return r ? { found: r.kind !== 'missing', file: rel, ...r } : { found: false };
}

module.exports = { handlerAt, attrAt, _jsxElementAt: jsxElementAt };
