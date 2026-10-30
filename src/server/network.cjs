'use strict';

// Static network scan: which HTTP requests a component (and the hooks / API modules it imports) can make.
// For each one: method, URL pattern, where it is called, an example payload inferred from the code for
// POST/PUT/PATCH, and the expected response shape when a TypeScript type says what comes back.

const fs = require('fs');
const path = require('path');
const { parse } = require('@babel/parser');

const MAX_FILES = 10;
const MAX_FILE_CHARS = 250000;
const MAX_DEPTH = 2; // component → hook → api module
const RESOLVE_EXTS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.vue', '.svelte'];
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const FETCH_LIKE = new Set(['fetch', '$fetch', 'ofetch', 'useFetch', 'useLazyFetch', 'ky', 'got', 'request', 'wretch']);
const SWR_LIKE = new Set(['useSWR', 'useSWRImmutable', 'useSWRInfinite', 'useSWRMutation']);
// Objects whose .get()/.delete() are not HTTP calls.
const NOT_HTTP = /^(searchParams|params|query|headers|formData|form|map|cache|store|storage|localStorage|sessionStorage|router|route|cookies?|weakMap|set|registry|config|env|state|context|ctx|emitter|events?)$/i;

const toPosix = (p) => p.split(path.sep).join('/');

// ---------- files & imports ----------

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''));
  } catch {
    return null;
  }
}

function aliases(root) {
  const out = [];
  for (const f of ['tsconfig.json', 'jsconfig.json']) {
    const j = readJson(path.join(root, f));
    const o = j && j.compilerOptions;
    if (!o || !o.paths) continue;
    const base = path.resolve(root, o.baseUrl || '.');
    for (const [k, v] of Object.entries(o.paths)) {
      if (!k.endsWith('/*') || !Array.isArray(v) || !v[0] || !v[0].endsWith('/*')) continue;
      out.push({ prefix: k.slice(0, -1), dir: path.resolve(base, v[0].slice(0, -2)) });
    }
  }
  for (const [prefix, d] of [['@/', 'src'], ['@/', '.'], ['~/', 'src'], ['~/', '.'], ['$lib/', 'src/lib']]) {
    if (out.some((a) => a.prefix === prefix)) continue;
    const dir = path.resolve(root, d);
    if (fs.existsSync(dir) && (prefix === '$lib/' || fs.existsSync(path.join(dir, 'components')) || fs.existsSync(path.join(dir, 'app')) || fs.existsSync(path.join(dir, 'lib'))))
      out.push({ prefix, dir });
  }
  return out;
}

function resolveImport(fromAbs, spec, aliasList) {
  let base;
  if (spec.startsWith('.')) base = path.resolve(path.dirname(fromAbs), spec);
  else {
    const a = aliasList.find((x) => spec.startsWith(x.prefix));
    if (!a) return null;
    base = path.join(a.dir, spec.slice(a.prefix.length));
  }
  const cands = [base, ...RESOLVE_EXTS.map((e) => base + e), ...RESOLVE_EXTS.map((e) => path.join(base, 'index' + e))];
  if (/\.(js|jsx|mjs)$/.test(base)) {
    const stem = base.replace(/\.(js|jsx|mjs)$/, '');
    cands.push(stem + '.ts', stem + '.tsx');
  }
  for (const c of cands) {
    try {
      if (fs.statSync(c).isFile() && RESOLVE_EXTS.includes(path.extname(c))) {
        const real = fs.realpathSync(c);
        return /[\\/]node_modules[\\/]/.test(real) ? null : real;
      }
    } catch {}
  }
  return null;
}

/** JS/TS code blocks of a file, with the line offset of each block. */
function scriptBlocks(file, text) {
  if (/\.(vue|svelte)$/.test(file)) {
    const out = [];
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = re.exec(text))) {
      const before = text.slice(0, m.index + m[0].indexOf('>') + 1);
      const ts = /lang=["']ts["']/.test(m[1]);
      out.push({ code: m[2], lineOffset: before.split('\n').length - 1, ts, jsx: false });
    }
    return out;
  }
  return [{ code: text, lineOffset: 0, ts: /\.tsx?$/.test(file), jsx: !/\.ts$/.test(file) }];
}

function parseBlock(block) {
  const plugins = ['decorators-legacy'];
  if (block.jsx) plugins.push('jsx');
  if (block.ts) plugins.push('typescript');
  try {
    return parse(block.code, {
      sourceType: 'module',
      errorRecovery: true,
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true,
      plugins,
    });
  } catch {
    if (block.ts && block.jsx) {
      try {
        return parse(block.code, { sourceType: 'module', errorRecovery: true, plugins: ['typescript', 'decorators-legacy'] });
      } catch {}
    }
    return null;
  }
}

// ---------- AST helpers ----------

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'range', 'errors', 'tokens', 'comments']);

function walk(node, visit, parents = []) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parents);
  parents.push(node);
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const v = node[key];
    if (Array.isArray(v)) for (const c of v) c && typeof c.type === 'string' && walk(c, visit, parents);
    else if (v && typeof v.type === 'string') walk(v, visit, parents);
  }
  parents.pop();
}

const keyName = (k) => (!k ? null : k.type === 'Identifier' ? k.name : k.type === 'StringLiteral' ? k.value : k.type === 'NumericLiteral' ? String(k.value) : null);

function prop(obj, name) {
  if (!obj || obj.type !== 'ObjectExpression') return null;
  for (const p of obj.properties) {
    if (p.type === 'ObjectProperty' && keyName(p.key) === name) return p.value;
  }
  return null;
}

function unwrap(n) {
  while (n && (n.type === 'TSAsExpression' || n.type === 'TSSatisfiesExpression' || n.type === 'TSNonNullExpression' || n.type === 'ParenthesizedExpression' || n.type === 'AwaitExpression' || n.type === 'TSTypeAssertion'))
    n = n.expression || n.argument;
  return n;
}

function calleeName(c) {
  if (!c) return null;
  if (c.type === 'Identifier') return c.name;
  if (c.type === 'MemberExpression' || c.type === 'OptionalMemberExpression') {
    const p = c.computed ? null : c.property && c.property.name;
    return p;
  }
  return null;
}

function objectName(c) {
  let o = c && c.object;
  while (o && (o.type === 'MemberExpression' || o.type === 'OptionalMemberExpression')) {
    if (!o.computed && o.property && o.property.name) return o.property.name;
    o = o.object;
  }
  if (!o) return null;
  if (o.type === 'Identifier') return o.name;
  if (o.type === 'ThisExpression') return 'this';
  if (o.type === 'CallExpression') return calleeName(o.callee);
  return null;
}

// ---------- values ----------

function envName(n) {
  // process.env.X / import.meta.env.X
  if (!n || n.type !== 'MemberExpression' || n.computed) return null;
  const o = n.object;
  if (o && o.type === 'MemberExpression' && !o.computed && o.property && o.property.name === 'env') return n.property.name;
  return null;
}

/** Render an expression used as a URL. {text, dynamic} or null. */
function urlOf(n, scope, depth = 0) {
  n = unwrap(n);
  if (!n || depth > 4) return null;
  if (n.type === 'StringLiteral') return { text: n.value, dynamic: false };
  if (n.type === 'TemplateLiteral') {
    let text = '';
    let dynamic = false;
    n.quasis.forEach((q, i) => {
      text += q.value.cooked != null ? q.value.cooked : q.value.raw;
      const e = n.expressions[i];
      if (!e) return;
      const r = urlOf(e, scope, depth + 1);
      if (r && !r.dynamic) text += r.text;
      else {
        dynamic = true;
        text += `{${placeholder(e)}}`;
      }
    });
    return { text, dynamic };
  }
  if (n.type === 'BinaryExpression' && n.operator === '+') {
    const a = urlOf(n.left, scope, depth + 1) || { text: `{${placeholder(n.left)}}`, dynamic: true };
    const b = urlOf(n.right, scope, depth + 1) || { text: `{${placeholder(n.right)}}`, dynamic: true };
    return { text: a.text + b.text, dynamic: a.dynamic || b.dynamic };
  }
  if (n.type === 'Identifier' && scope.consts.has(n.name)) return urlOf(scope.consts.get(n.name), scope, depth + 1);
  if (n.type === 'NewExpression' && n.callee.type === 'Identifier' && n.callee.name === 'URL' && n.arguments[0]) {
    return urlOf(n.arguments[0], scope, depth + 1);
  }
  if (n.type === 'LogicalExpression') return urlOf(n.left, scope, depth + 1) || urlOf(n.right, scope, depth + 1);
  return null;
}

function placeholder(e) {
  e = unwrap(e);
  const env = envName(e);
  if (env) return env;
  if (!e) return '…';
  if (e.type === 'Identifier') return e.name;
  if ((e.type === 'MemberExpression' || e.type === 'OptionalMemberExpression') && !e.computed && e.property) return e.property.name;
  if (e.type === 'CallExpression') return calleeName(e.callee) || '…';
  return '…';
}

const looksLikeUrl = (t) => /^(https?:)?\/\//.test(t) || /^\/[\w\-.~{}:@$]/.test(t) || /^\{[^}]+\}\/?[\w\-.~{}:@$/]/.test(t) || /^\/$/.test(t) || /^(api|v\d)\//.test(t);

function guessValue(hint) {
  const h = String(hint || '').replace(/^(set|get|new|current|selected|input)(?=[A-Z])/, '');
  const l = h.toLowerCase();
  if (!l) return 'string';
  if (/e-?mail/.test(l)) return 'user@example.com';
  if (/password|secret/.test(l)) return '••••••••';
  if (/^(is|has|can|should|allow)[A-Z_]/.test(h) || /^(enabled|active|checked|done|completed|visible|published|remember|agree|accepted)$/.test(l)) return true;
  if (/(^id$|[a-z]Id$|_id$|^uuid$)/.test(h)) return /uuid/.test(l) ? '00000000-0000-0000-0000-000000000000' : 1;
  if (/(count|amount|price|total|qty|quantity|age|page|limit|offset|size|number|^num|rating|score|year|index|order|position|cost|weight|height|width)/.test(l)) return 0;
  if (/(date|time|^at$|At$|_at$|deadline|birthday)/.test(h)) return '2026-01-01T00:00:00.000Z';
  if (/(url|link|href|website|avatar|image|photo)/.test(l)) return 'https://example.com';
  if (/phone|mobile|tel/.test(l)) return '+1 555 0100';
  if (/^(tags|items|ids|list|options|roles)$/.test(l)) return [];
  if (/^name$|fullname|full_name/.test(l)) return 'Jane Doe';
  if (/first_?name/.test(l)) return 'Jane';
  if (/last_?name/.test(l)) return 'Doe';
  if (/title|subject/.test(l)) return 'Example title';
  if (/message|description|text|body|content|comment|note/.test(l)) return 'Lorem ipsum';
  return 'string';
}

/** Example JSON value built from an expression (object literals, consts, names). */
function exampleOf(n, scope, hint, depth = 0) {
  n = unwrap(n);
  if (!n) return guessValue(hint);
  if (depth > 5) return '…';
  switch (n.type) {
    case 'StringLiteral':
      return n.value;
    case 'NumericLiteral':
      return n.value;
    case 'BooleanLiteral':
      return n.value;
    case 'NullLiteral':
      return null;
    case 'TemplateLiteral': {
      const r = urlOf(n, scope);
      return r ? r.text : guessValue(hint);
    }
    case 'ObjectExpression': {
      const out = {};
      for (const p of n.properties) {
        if (p.type === 'ObjectProperty') {
          const k = keyName(p.key);
          if (k === null) continue;
          out[k] = exampleOf(p.value, scope, k, depth + 1);
        } else if (p.type === 'SpreadElement') {
          const v = exampleOf(p.argument, scope, placeholder(p.argument), depth + 1);
          if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, v);
          else out[`...${placeholder(p.argument)}`] = '…';
        }
      }
      return out;
    }
    case 'ArrayExpression':
      return n.elements.slice(0, 3).filter(Boolean).map((e) => exampleOf(e, scope, hint, depth + 1));
    case 'Identifier': {
      if (n.name === 'undefined') return null;
      const init = scope.consts.get(n.name);
      if (init && init.type !== 'Identifier') {
        const u = unwrap(init);
        if (u && /Literal$|ObjectExpression|ArrayExpression/.test(u.type)) return exampleOf(init, scope, n.name, depth + 1);
      }
      const t = scope.varTypes.get(n.name);
      if (t) {
        const v = typeExample(t, scope.types, 0);
        if (v !== undefined) return v;
      }
      return guessValue(n.name);
    }
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      return guessValue(!n.computed && n.property ? n.property.name : hint);
    case 'CallExpression': {
      const c = calleeName(n.callee);
      if (c === 'stringify' && n.arguments[0]) return exampleOf(n.arguments[0], scope, hint, depth + 1);
      if (c === 'String' || c === 'toString' || c === 'trim') return guessValue(hint);
      if (c === 'Number' || c === 'parseInt' || c === 'parseFloat') return 0;
      if (c === 'Boolean') return true;
      if (c === 'toISOString') return '2026-01-01T00:00:00.000Z';
      if (c === 'fromEntries') return { key: 'value' };
      return guessValue(hint);
    }
    case 'NewExpression':
      if (n.callee.type === 'Identifier' && n.callee.name === 'Date') return '2026-01-01T00:00:00.000Z';
      return guessValue(hint);
    case 'UnaryExpression':
      if (n.operator === '!') return true;
      if (n.operator === '-' && n.argument.type === 'NumericLiteral') return -n.argument.value;
      return guessValue(hint);
    case 'ConditionalExpression':
      return exampleOf(n.consequent, scope, hint, depth + 1);
    case 'LogicalExpression':
      return exampleOf(n.left, scope, hint, depth + 1);
    case 'BinaryExpression':
      return n.operator === '+' ? exampleOf(n.left, scope, hint, depth + 1) : /[<>=]/.test(n.operator) ? true : 0;
    default:
      return guessValue(hint);
  }
}

/** What kind of body: json | form | multipart | text | null */
function bodyOf(n, scope) {
  const u = unwrap(n);
  if (!u) return null;
  if (u.type === 'CallExpression' && calleeName(u.callee) === 'stringify') return { type: 'json', example: exampleOf(u.arguments[0], scope, 'body') };
  if (u.type === 'NewExpression' && u.callee.type === 'Identifier') {
    if (u.callee.name === 'FormData')
      return u.arguments[0]
        ? { type: 'multipart', example: { field: 'value' }, note: `Multipart form data — the real fields come from the <form> ${placeholder(u.arguments[0])}.` }
        : { type: 'multipart', example: { field: 'value' }, note: 'Multipart form data — fields are appended in code.' };
    if (u.callee.name === 'URLSearchParams') return { type: 'form', example: u.arguments[0] ? exampleOf(u.arguments[0], scope, 'params') : {} };
  }
  if (u.type === 'Identifier') {
    const init = unwrap(scope.consts.get(u.name));
    if (init && init !== u && (init.type === 'NewExpression' || init.type === 'CallExpression')) return bodyOf(init, scope);
  }
  if (u.type === 'StringLiteral' || u.type === 'TemplateLiteral') return { type: 'text', example: exampleOf(u, scope, 'body') };
  return { type: 'json', example: exampleOf(u, scope, 'body') };
}

function headersOf(n, scope) {
  const u = unwrap(n);
  if (!u) return null;
  if (u.type === 'Identifier' && scope.consts.has(u.name)) return headersOf(scope.consts.get(u.name), scope);
  if (u.type === 'NewExpression' && u.arguments[0]) return headersOf(u.arguments[0], scope);
  if (u.type !== 'ObjectExpression') return null;
  const out = {};
  for (const p of u.properties) {
    if (p.type !== 'ObjectProperty') continue;
    const k = keyName(p.key);
    if (!k) continue;
    const v = unwrap(p.value);
    if (v.type === 'StringLiteral') out[k] = v.value;
    else if (v.type === 'TemplateLiteral') out[k] = (urlOf(v, scope) || { text: '…' }).text;
    else out[k] = `{${placeholder(v)}}`;
  }
  return Object.keys(out).length ? out : null;
}

// ---------- TypeScript types → example JSON ----------

function typeExample(t, types, depth, seen = new Set()) {
  if (!t) return undefined;
  if (t.type === 'TSTypeAnnotation') t = t.typeAnnotation;
  if (depth > 6) return '…';
  switch (t.type) {
    case 'TSStringKeyword':
      return 'string';
    case 'TSNumberKeyword':
    case 'TSBigIntKeyword':
      return 0;
    case 'TSBooleanKeyword':
      return true;
    case 'TSNullKeyword':
    case 'TSUndefinedKeyword':
    case 'TSVoidKeyword':
      return null;
    case 'TSAnyKeyword':
    case 'TSUnknownKeyword':
      return undefined;
    case 'TSLiteralType':
      return t.literal.type === 'TemplateLiteral' ? 'string' : t.literal.value;
    case 'TSArrayType': {
      const v = typeExample(t.elementType, types, depth + 1, seen);
      return v === undefined ? [] : [v];
    }
    case 'TSTupleType':
      return t.elementTypes.map((e) => typeExample(e.type === 'TSNamedTupleMember' ? e.elementType : e, types, depth + 1, seen));
    case 'TSParenthesizedType':
    case 'TSOptionalType':
      return typeExample(t.typeAnnotation, types, depth, seen);
    case 'TSUnionType': {
      const real = t.types.filter((x) => !['TSNullKeyword', 'TSUndefinedKeyword'].includes(x.type));
      return typeExample(real[0] || t.types[0], types, depth, seen);
    }
    case 'TSIntersectionType': {
      const out = {};
      for (const x of t.types) {
        const v = typeExample(x, types, depth, seen);
        if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, v);
      }
      return out;
    }
    case 'TSTypeLiteral':
    case 'TSInterfaceBody':
      return membersExample(t.members || t.body, types, depth, seen);
    case 'TSTypeReference': {
      const name = t.typeName.type === 'Identifier' ? t.typeName.name : t.typeName.right && t.typeName.right.name;
      const args = (t.typeParameters && t.typeParameters.params) || [];
      if (name === 'Array' || name === 'ReadonlyArray') {
        const v = typeExample(args[0], types, depth + 1, seen);
        return v === undefined ? [] : [v];
      }
      if (['Promise', 'Readonly', 'Partial', 'Required', 'NonNullable', 'Awaited'].includes(name)) return typeExample(args[0], types, depth, seen);
      if (name === 'Date') return '2026-01-01T00:00:00.000Z';
      if (name === 'Record') return { key: typeExample(args[1], types, depth + 1, seen) ?? 'value' };
      if (name === 'Pick' || name === 'Omit') {
        const base = typeExample(args[0], types, depth, seen);
        if (!base || typeof base !== 'object' || Array.isArray(base)) return base;
        const keys = literalKeys(args[1]);
        const out = {};
        for (const k of Object.keys(base)) if (name === 'Pick' ? keys.includes(k) : !keys.includes(k)) out[k] = base[k];
        return out;
      }
      const decl = types.get(name);
      if (!decl || seen.has(name)) return seen.has(name) ? `{${name}}` : undefined;
      const s2 = new Set(seen).add(name);
      if (decl.type === 'TSTypeAliasDeclaration') return typeExample(decl.typeAnnotation, types, depth + 1, s2);
      if (decl.type === 'TSInterfaceDeclaration') {
        const out = {};
        for (const ext of decl.extends || []) {
          const v = typeExample({ type: 'TSTypeReference', typeName: ext.expression, typeParameters: ext.typeParameters }, types, depth + 1, s2);
          if (v && typeof v === 'object') Object.assign(out, v);
        }
        return Object.assign(out, membersExample(decl.body.body, types, depth + 1, s2));
      }
      if (decl.type === 'TSEnumDeclaration') {
        const m = decl.members[0];
        return m && m.initializer ? exampleOf(m.initializer, { consts: new Map(), varTypes: new Map(), types }) : 0;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

function literalKeys(t) {
  if (!t) return [];
  if (t.type === 'TSLiteralType') return [String(t.literal.value)];
  if (t.type === 'TSUnionType') return t.types.flatMap(literalKeys);
  return [];
}

function membersExample(members, types, depth, seen) {
  const out = {};
  for (const m of members || []) {
    if (m.type === 'TSPropertySignature') {
      const k = keyName(m.key);
      if (k === null) continue;
      const v = typeExample(m.typeAnnotation, types, depth + 1, seen);
      out[k] = v === undefined ? guessValue(k) : v;
    } else if (m.type === 'TSIndexSignature') {
      const v = typeExample(m.typeAnnotation, types, depth + 1, seen);
      out.key = v === undefined ? 'value' : v;
    }
  }
  return out;
}

function typeLabel(t, code) {
  if (!t) return null;
  if (t.type === 'TSTypeAnnotation') t = t.typeAnnotation;
  return code.slice(t.start, t.end).replace(/\s+/g, ' ').slice(0, 80);
}

// ---------- per-file analysis ----------

function topLevelNames(stmt) {
  const d = stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration' ? stmt.declaration : stmt;
  const names = [];
  if (stmt.type === 'ExportDefaultDeclaration') names.push('default');
  if (!d) return names;
  if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id) names.push(d.id.name);
  if (d.type === 'VariableDeclaration') for (const v of d.declarations) if (v.id.type === 'Identifier') names.push(v.id.name);
  if (d.type === 'Identifier') names.push(d.name);
  return names;
}

function analyzeFile(abs, text) {
  const blocks = scriptBlocks(abs, text);
  const result = { imports: [], types: new Map(), calls: [], topNames: [], exportAliases: new Map() };
  for (const block of blocks) {
    const ast = parseBlock(block);
    if (!ast) continue;
    const code = block.code;
    const consts = new Map();
    const varTypes = new Map();
    // pass 1: imports, declarations, types
    walk(ast.program, (n) => {
      if (n.type === 'ImportDeclaration') {
        const names = n.specifiers.map((s) => (s.type === 'ImportDefaultSpecifier' ? 'default' : s.type === 'ImportNamespaceSpecifier' ? '*' : s.imported ? keyName(s.imported) : null)).filter(Boolean);
        result.imports.push({ source: n.source.value, names: names.length ? names : ['*'], typeOnly: n.importKind === 'type' });
      } else if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier') {
        if (n.init) consts.set(n.id.name, n.init);
        if (n.id.typeAnnotation) varTypes.set(n.id.name, n.id.typeAnnotation);
      } else if ((n.type === 'TSInterfaceDeclaration' || n.type === 'TSTypeAliasDeclaration' || n.type === 'TSEnumDeclaration') && n.id) {
        result.types.set(n.id.name, n);
      } else if (n.type === 'ExportSpecifier' && n.local && n.exported) {
        result.exportAliases.set(keyName(n.exported), n.local.name);
      }
    });
    const scope = { consts, varTypes, types: result.types, code };
    // pass 2: calls, with their top-level owner
    for (const stmt of ast.program.body) {
      const owners = topLevelNames(stmt);
      result.topNames.push(...owners);
      walk(stmt, (n, parents) => {
        if (n.type !== 'CallExpression' && n.type !== 'OptionalCallExpression' && n.type !== 'NewExpression') return;
        const found = detect(n, scope);
        if (!found) return;
        for (const f of [].concat(found)) {
          f.line = (n.loc ? n.loc.start.line : 1) + block.lineOffset;
          f.owners = owners;
          f.fn = enclosingName(parents) || owners.find((o) => o !== 'default') || null;
          if (!f.responseType) Object.assign(f, responseTypeFromContext(n, parents, scope));
          if (f.responseType) f.responseLabel = typeLabel(f.responseType, code);
          result.calls.push(f);
        }
      });
    }
  }
  return result;
}

function enclosingName(parents) {
  for (let i = parents.length - 1; i >= 0; i--) {
    const p = parents[i];
    if ((p.type === 'FunctionDeclaration' || p.type === 'FunctionExpression') && p.id) return p.id.name;
    if (p.type === 'VariableDeclarator' && p.id.type === 'Identifier' && /Function|Arrow/.test((p.init && p.init.type) || '')) return p.id.name;
    if (p.type === 'ObjectProperty' && /Function|Arrow/.test(p.value.type)) return keyName(p.key);
    if (p.type === 'ObjectMethod' || p.type === 'ClassMethod') return keyName(p.key);
  }
  return null;
}

/** `axios.get<User[]>()`, `res.json() as User[]`, `const u: User = await res.json()`, `Promise<User>` return types. */
function responseTypeFromContext(call, parents, scope) {
  const tp = call.typeParameters || call.typeArguments;
  if (tp && tp.params && tp.params[0]) return { responseType: tp.params[0] };
  // nearest function around the call
  let fn = null;
  for (let i = parents.length - 1; i >= 0; i--) {
    if (/Function|ArrowFunction|ObjectMethod|ClassMethod/.test(parents[i].type)) {
      fn = parents[i];
      break;
    }
  }
  if (!fn) return {};
  let found = null;
  walk(fn.body, (n, ps) => {
    if (found) return;
    if (n.type === 'TSAsExpression' || n.type === 'TSSatisfiesExpression') {
      let e = unwrap(n.expression);
      if (e && e.type === 'CallExpression' && calleeName(e.callee) === 'json') found = n.typeAnnotation;
    }
    if (n.type === 'VariableDeclarator' && n.id.typeAnnotation && n.init) {
      const e = unwrap(n.init);
      if (e && e.type === 'CallExpression' && calleeName(e.callee) === 'json') found = n.id.typeAnnotation;
    }
    if (n.type === 'CallExpression' && calleeName(n.callee) === 'json' && (n.typeParameters || n.typeArguments)) found = (n.typeParameters || n.typeArguments).params[0];
  });
  if (!found && fn.returnType) {
    let t = fn.returnType.typeAnnotation;
    if (t && t.type === 'TSTypeReference' && t.typeName.name === 'Promise' && t.typeParameters) t = t.typeParameters.params[0];
    if (t && !['TSVoidKeyword', 'TSAnyKeyword', 'TSUnknownKeyword'].includes(t.type) && !(t.type === 'TSTypeReference' && t.typeName.name === 'Response')) found = t;
  }
  return found ? { responseType: found } : {};
}

function detect(n, scope) {
  const callee = n.callee;
  const name = calleeName(callee);
  const args = n.arguments || [];
  const isMember = callee && (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression');
  const obj = isMember ? objectName(callee) : null;

  if (n.type === 'NewExpression') {
    if (callee.type === 'Identifier' && callee.name === 'EventSource' && args[0]) {
      const u = urlOf(args[0], scope);
      if (u && looksLikeUrl(u.text)) return { kind: 'eventsource', method: 'GET', url: u.text, dynamic: u.dynamic, stream: true };
    }
    return null;
  }

  // fetch(url, { method, body, headers }) and friends
  if (name && FETCH_LIKE.has(name) && (!isMember || ['window', 'globalThis', 'self', 'this'].includes(obj) || name === 'fetch' || name === '$fetch') && args[0]) {
    let u = urlOf(args[0], scope);
    let opts = unwrap(args[1]);
    if (opts && opts.type === 'Identifier' && scope.consts.has(opts.name)) opts = unwrap(scope.consts.get(opts.name));
    if (!u && unwrap(args[0]) && unwrap(args[0]).type === 'NewExpression' && unwrap(args[0]).callee.name === 'Request') {
      const r = unwrap(args[0]);
      u = urlOf(r.arguments[0], scope);
      opts = unwrap(r.arguments[1]);
    }
    if (!u || !looksLikeUrl(u.text)) return null;
    const m = prop(opts, 'method');
    const method = m && unwrap(m).type === 'StringLiteral' ? unwrap(m).value.toUpperCase() : m ? '{method}' : 'GET';
    const bodyNode = prop(opts, 'body') || prop(opts, 'json') || prop(opts, 'data');
    const out = { kind: name, method, url: u.text, dynamic: u.dynamic, headers: headersOf(prop(opts, 'headers'), scope) };
    if (bodyNode) Object.assign(out, payloadFields(bodyOf(bodyNode, scope)));
    const q = prop(opts, 'query') || prop(opts, 'params') || prop(opts, 'searchParams');
    if (q) out.query = exampleOf(q, scope, 'query');
    return out;
  }

  // useSWR('/api/x', fetcher)
  if (name && SWR_LIKE.has(name) && !isMember && args[0]) {
    let key = unwrap(args[0]);
    if (key && key.type === 'ArrowFunctionExpression') key = unwrap(key.body);
    if (key && key.type === 'ConditionalExpression') key = unwrap(key.consequent);
    if (key && key.type === 'LogicalExpression') key = unwrap(key.right);
    if (key && key.type === 'ArrayExpression') key = key.elements[0];
    const u = urlOf(key, scope);
    if (!u || !looksLikeUrl(u.text)) return null;
    return { kind: name, method: name === 'useSWRMutation' ? 'POST' : 'GET', url: u.text, dynamic: u.dynamic };
  }

  // axios({ url, method, data }) / client.request({...})
  if ((name === 'axios' && !isMember) || (isMember && name === 'request' && obj && !NOT_HTTP.test(obj))) {
    const cfg = unwrap(args[0]);
    if (cfg && cfg.type === 'ObjectExpression') {
      const u = urlOf(prop(cfg, 'url'), scope);
      if (!u || !looksLikeUrl(u.text)) return null;
      const m = prop(cfg, 'method');
      const out = { kind: 'axios', method: m && unwrap(m).type === 'StringLiteral' ? unwrap(m).value.toUpperCase() : 'GET', url: u.text, dynamic: u.dynamic, headers: headersOf(prop(cfg, 'headers'), scope) };
      const d = prop(cfg, 'data');
      if (d) Object.assign(out, payloadFields(bodyOf(d, scope)));
      const p = prop(cfg, 'params');
      if (p) out.query = exampleOf(p, scope, 'params');
      return out;
    }
    if (name === 'axios' && cfg) {
      const u = urlOf(cfg, scope);
      if (u && looksLikeUrl(u.text)) return { kind: 'axios', method: 'GET', url: u.text, dynamic: u.dynamic };
    }
    return null;
  }

  // axios.get(url, config) / api.post(url, data, config) / ky.post(url, { json })
  if (isMember && name && HTTP_METHODS.has(name.toLowerCase()) && args[0] && !(obj && NOT_HTTP.test(obj))) {
    const u = urlOf(args[0], scope);
    if (!u || !looksLikeUrl(u.text)) return null;
    const method = name.toUpperCase();
    const base = instanceBase(callee, scope);
    const url = base && !/^(https?:)?\/\//.test(u.text) ? base.text.replace(/\/+$/, '') + '/' + u.text.replace(/^\/+/, '') : u.text;
    const out = { kind: obj || 'client', method, url, dynamic: u.dynamic || Boolean(base && base.dynamic) };
    const second = unwrap(args[1]);
    const third = unwrap(args[2]);
    const isOpts = (o) => o && o.type === 'ObjectExpression' && o.properties.length > 0 && o.properties.every((p) => p.type === 'ObjectProperty' && ['json', 'body', 'headers', 'searchParams', 'params', 'query', 'timeout', 'credentials', 'signal', 'retry', 'withCredentials', 'responseType'].includes(keyName(p.key)));
    let cfg = null;
    if (['GET', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)) cfg = second;
    else if (isOpts(second) && (prop(second, 'json') || prop(second, 'body') || !third)) {
      cfg = second;
      const b = prop(second, 'json') || prop(second, 'body');
      if (b) Object.assign(out, payloadFields(prop(second, 'json') ? { type: 'json', example: exampleOf(b, scope, 'body') } : bodyOf(b, scope)));
    } else {
      if (second) Object.assign(out, payloadFields(bodyOf(second, scope)));
      cfg = third;
    }
    if (cfg && cfg.type === 'ObjectExpression') {
      out.headers = headersOf(prop(cfg, 'headers'), scope);
      const p = prop(cfg, 'params') || prop(cfg, 'searchParams') || prop(cfg, 'query');
      if (p) out.query = exampleOf(p, scope, 'params');
      if (method === 'DELETE' && prop(cfg, 'data')) Object.assign(out, payloadFields(bodyOf(prop(cfg, 'data'), scope)));
    }
    return out;
  }

  // xhr.open('POST', url)
  if (isMember && name === 'open' && args.length >= 2) {
    const m = unwrap(args[0]);
    if (m && m.type === 'StringLiteral' && HTTP_METHODS.has(m.value.toLowerCase())) {
      const u = urlOf(args[1], scope);
      if (u && looksLikeUrl(u.text)) return { kind: 'xhr', method: m.value.toUpperCase(), url: u.text, dynamic: u.dynamic };
    }
  }
  return null;
}

/** `const client = axios.create({ baseURL: '/api' })` / `ky.create({ prefixUrl })` → the base URL of `client.get(...)`. */
function instanceBase(callee, scope) {
  const o = callee && callee.object;
  if (!o || o.type !== 'Identifier') return null;
  const init = unwrap(scope.consts.get(o.name));
  if (!init || init.type !== 'CallExpression' || !['create', 'extend'].includes(calleeName(init.callee))) return null;
  const cfg = unwrap(init.arguments[0]);
  const b = prop(cfg, 'baseURL') || prop(cfg, 'prefixUrl') || prop(cfg, 'baseUrl');
  return b ? urlOf(b, scope) : null;
}

function payloadFields(b) {
  if (!b) return {};
  return { payload: b.example === undefined ? null : b.example, payloadType: b.type, payloadNote: b.note || null };
}

// ---------- scan ----------

/**
 * Scan a component file and the local modules it imports (two levels deep, only the exports it uses).
 * Returns { endpoints, files } with project-relative paths.
 */
function scan(root, componentAbs) {
  const aliasList = aliases(root);
  const rel = (abs) => toPosix(path.relative(root, abs));
  const files = new Map(); // abs → { analysis, depth, via: Set<names> | null(all) }
  const queue = [{ abs: componentAbs, depth: 0, names: null, via: null }];
  const allTypes = new Map();
  const endpoints = [];

  while (queue.length && files.size < MAX_FILES) {
    const item = queue.shift();
    let entry = files.get(item.abs);
    if (entry) {
      // already scanned: widen the set of used exports
      if (entry.names && item.names) item.names.forEach((n) => entry.names.add(n));
      else entry.names = null;
      continue;
    }
    let text;
    try {
      text = fs.readFileSync(item.abs, 'utf8');
    } catch {
      continue;
    }
    if (text.length > MAX_FILE_CHARS) continue;
    const analysis = analyzeFile(item.abs, text);
    entry = { analysis, depth: item.depth, names: item.names ? new Set(item.names) : null, via: item.via };
    files.set(item.abs, entry);
    for (const [k, v] of analysis.types) if (!allTypes.has(k)) allTypes.set(k, v);
    if (item.depth >= MAX_DEPTH) continue;
    for (const imp of analysis.imports) {
      const target = resolveImport(item.abs, imp.source, aliasList);
      if (!target || target === item.abs) continue;
      if (imp.typeOnly) {
        // types only: read for response shapes, never for calls
        queue.push({ abs: target, depth: MAX_DEPTH, names: new Set(), via: null });
        continue;
      }
      const names = imp.names.includes('*') ? null : new Set(imp.names);
      queue.push({ abs: target, depth: item.depth + 1, names, via: imp.names.filter((n) => n !== '*' && n !== 'default').join(', ') || null });
    }
  }

  for (const [abs, entry] of files) {
    const { analysis, names } = entry;
    // map exported aliases back to local names
    const wanted = names ? new Set([...names].map((n) => analysis.exportAliases.get(n) || n)) : null;
    for (const c of analysis.calls) {
      if (wanted && !c.owners.some((o) => wanted.has(o))) continue;
      const responseType = c.responseType;
      const response = responseType ? typeExample(responseType, allTypes, 0) : undefined;
      endpoints.push({
        method: c.method,
        url: c.url,
        dynamic: Boolean(c.dynamic),
        file: rel(abs),
        line: c.line,
        fn: c.fn || null,
        kind: c.kind,
        external: entry.depth > 0,
        headers: c.headers || null,
        query: c.query === undefined ? null : c.query,
        payload: c.payload === undefined ? null : c.payload,
        payloadType: c.payloadType || null,
        payloadNote: c.payloadNote || null,
        response: response === undefined ? null : response,
        responseType: c.responseLabel || null,
        stream: Boolean(c.stream),
      });
    }
  }

  // de-duplicate (same method + url): keep the first, it is the closest to the component
  const seen = new Map();
  const out = [];
  for (const e of endpoints) {
    const k = e.method + ' ' + e.url;
    const prev = seen.get(k);
    if (prev) {
      if (!prev.payload && e.payload) prev.payload = e.payload;
      if (!prev.response && e.response) {
        prev.response = e.response;
        prev.responseType = e.responseType;
      }
      continue;
    }
    seen.set(k, e);
    out.push(e);
  }
  return { endpoints: out, files: [...files.keys()].map(rel) };
}

module.exports = {
  scan,
  // Shared with storage.cjs, which walks the same import graph with the same parser.
  helpers: { aliases, resolveImport, scriptBlocks, parseBlock, walk, unwrap, urlOf, keyName, prop, calleeName, objectName, topLevelNames, enclosingName, toPosix },
  _internal: { analyzeFile, typeExample },
};
