'use strict';

// Static storage scan: which localStorage / sessionStorage keys and Cache Storage caches a component (and the hooks /
// modules it imports) reads or writes. Covers the Web APIs directly and the common wrappers around them:
//   • localStorage.getItem('k') / setItem / removeItem / clear, window.sessionStorage…, localStorage['k'], localStorage.k
//   • caches.open('name') / has / delete / match, and cache.put / add / match / delete on a cache opened in the same file
//   • useLocalStorage / useSessionStorage (usehooks-ts, @uidotdev, Mantine, VueUse useStorage, ahooks …), jotai
//     atomWithStorage, zustand persist({ name }), redux-persist persistReducer({ key }) → "persist:<key>"
// Keys built at runtime keep {placeholders} (`cart:{userId}`) so the client can match them against real keys.

const fs = require('fs');
const path = require('path');
const { helpers: h } = require('./network.cjs');

const MAX_FILES = 12;
const MAX_FILE_CHARS = 250000;
const MAX_DEPTH = 2;

const STORAGE_OPS = { getItem: 'read', setItem: 'write', removeItem: 'remove', clear: 'clear', key: 'read' };
const CACHES_OPS = { open: 'open', has: 'read', delete: 'remove', match: 'read', keys: 'read' };
const CACHE_OPS = { put: 'write', add: 'write', addAll: 'write', match: 'read', matchAll: 'read', delete: 'remove', keys: 'read' };
// Hooks that take the key as their first argument (or { key } as their only one).
const HOOKS = /^use(Local|Session)?Storage(State|Value)?$|^usePersistedState$|^useStickyState$/;

/** 'local' | 'session' | null for an expression that is (or names) a Web Storage object. */
function storageArea(n, scope, depth = 0) {
  n = h.unwrap(n);
  if (!n || depth > 3) return null;
  let name = null;
  if (n.type === 'Identifier') {
    name = n.name;
    if (name !== 'localStorage' && name !== 'sessionStorage' && scope.consts.has(name)) return storageArea(scope.consts.get(name), scope, depth + 1);
  } else if ((n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') && !n.computed && n.property) {
    const o = h.unwrap(n.object);
    if (o && o.type === 'Identifier' && /^(window|globalThis|self)$/.test(o.name)) name = n.property.name;
  }
  return name === 'localStorage' ? 'local' : name === 'sessionStorage' ? 'session' : null;
}

/** True for `caches` / `window.caches`. */
function isCaches(n) {
  n = h.unwrap(n);
  if (!n) return false;
  if (n.type === 'Identifier') return n.name === 'caches';
  return (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') && !n.computed && n.property && n.property.name === 'caches' && h.unwrap(n.object) && h.unwrap(n.object).type === 'Identifier';
}

/** A variable holding `await caches.open('name')` → that cache name ({text, dynamic}). */
function openedCache(n, scope, depth = 0) {
  n = h.unwrap(n);
  if (!n || depth > 3) return null;
  if (n.type === 'Identifier' && scope.consts.has(n.name)) return openedCache(scope.consts.get(n.name), scope, depth + 1);
  if (n.type === 'CallExpression' && n.callee && (n.callee.type === 'MemberExpression' || n.callee.type === 'OptionalMemberExpression')) {
    if (h.calleeName(n.callee) === 'open' && isCaches(n.callee.object)) return keyOf(n.arguments[0], scope) || { text: '{…}', dynamic: true };
    // caches.open('x').then((cache) => …) is handled where the callback parameter is used: not traced
  }
  return null;
}

/**
 * A storage key expression → {text, dynamic, ref?}. Literal, template, `+`, local const, `KEYS.cart` from a local
 * object, or an imported constant (`ref` — resolved in scan() once that module has been read).
 */
function keyOf(n, scope, depth = 0) {
  n = h.unwrap(n);
  if (!n || depth > 4) return null;
  const direct = h.urlOf(n, scope);
  if (direct && !(direct.dynamic && /^\{[^}]*\}$/.test(direct.text))) return direct;
  if ((n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') && n.object && n.object.type === 'Identifier') {
    const obj = h.unwrap(scope.consts.get(n.object.name));
    const k = n.computed ? (n.property.type === 'StringLiteral' ? n.property.value : null) : n.property && n.property.name;
    if (obj && obj.type === 'ObjectExpression' && k) {
      const v = h.prop(obj, k);
      if (v) return keyOf(v, scope, depth + 1);
    }
    if (scope.imported.has(n.object.name) && k) return { text: `{${k}}`, dynamic: true, ref: { name: n.object.name, member: k } };
  }
  if (n.type === 'Identifier' && scope.imported.has(n.name)) return { text: `{${n.name}}`, dynamic: true, ref: { name: n.name } };
  if (n.type === 'Identifier') return { text: `{${n.name}}`, dynamic: true };
  if (n.type === 'MemberExpression' && !n.computed && n.property) return { text: `{${n.property.name}}`, dynamic: true };
  return direct || { text: '{…}', dynamic: true };
}

/** `{ storage: createJSONStorage(() => sessionStorage) }`, `storage: storageSession` … → area. */
function areaFromConfig(cfg, scope) {
  const s = cfg && h.prop(cfg, 'storage');
  if (!s) return 'local';
  const text = scope.code.slice(s.start, s.end);
  return /session/i.test(text) ? 'session' : 'local';
}

function objectArg(n, scope) {
  n = h.unwrap(n);
  if (n && n.type === 'Identifier' && scope.consts.has(n.name)) n = h.unwrap(scope.consts.get(n.name));
  return n && n.type === 'ObjectExpression' ? n : null;
}

/** One call → zero or more findings { area, key, dynamic, ref, op, lib, url }. */
function detectCall(n, scope) {
  const c = n.callee;
  const name = h.calleeName(c);
  if (!name) return null;
  const member = c.type === 'MemberExpression' || c.type === 'OptionalMemberExpression';

  if (member && STORAGE_OPS[name]) {
    const area = storageArea(c.object, scope);
    if (area) {
      const op = STORAGE_OPS[name];
      if (name === 'clear') return { area, key: '*', op, lib: `${area}Storage.clear()` };
      if (name === 'key') return { area, key: '*', op, lib: `${area}Storage.key()` };
      const k = keyOf(n.arguments[0], scope);
      return k && { area, key: k.text, dynamic: k.dynamic, ref: k.ref, op, lib: `${area}Storage.${name}` };
    }
  }

  if (member && CACHES_OPS[name] && isCaches(c.object)) {
    const op = CACHES_OPS[name];
    if (name === 'match') {
      const u = keyOf(n.arguments[0], scope);
      return { area: 'cache', key: '*', op, url: u ? u.text : null, lib: 'caches.match' };
    }
    if (name === 'keys') return { area: 'cache', key: '*', op, lib: 'caches.keys' };
    const k = keyOf(n.arguments[0], scope);
    return k && { area: 'cache', key: k.text, dynamic: k.dynamic, ref: k.ref, op, lib: `caches.${name}` };
  }

  if (member && CACHE_OPS[name]) {
    const cacheName = openedCache(c.object, scope);
    if (cacheName) {
      const first = h.unwrap(n.arguments[0]);
      let url = null;
      if (first && first.type === 'ArrayExpression') url = first.elements.map((e) => (keyOf(e, scope) || {}).text).filter(Boolean).join(', ');
      else if (first) url = (keyOf(first, scope) || {}).text || null;
      return { area: 'cache', key: cacheName.text, dynamic: cacheName.dynamic, ref: cacheName.ref, op: CACHE_OPS[name], url, lib: `cache.${name}` };
    }
  }

  if (!member && HOOKS.test(name)) {
    const a0 = h.unwrap(n.arguments[0]);
    let k = null;
    let area = /Session/.test(name) ? 'session' : 'local';
    const cfg = objectArg(a0, scope);
    if (cfg && h.prop(cfg, 'key')) k = keyOf(h.prop(cfg, 'key'), scope);
    else if (a0) k = keyOf(a0, scope);
    // VueUse: useStorage(key, initial, sessionStorage)
    if (name === 'useStorage' && n.arguments[2] && storageArea(n.arguments[2], scope)) area = storageArea(n.arguments[2], scope);
    return k && { area, key: k.text, dynamic: k.dynamic, ref: k.ref, op: 'read/write', lib: name };
  }

  if (!member && name === 'atomWithStorage') {
    const k = keyOf(n.arguments[0], scope);
    const s = n.arguments[2] && scope.code.slice(n.arguments[2].start, n.arguments[2].end);
    return k && { area: s && /session/i.test(s) ? 'session' : 'local', key: k.text, dynamic: k.dynamic, ref: k.ref, op: 'read/write', lib: 'jotai atomWithStorage' };
  }

  // zustand: persist(creator, { name: 'cart', storage: createJSONStorage(() => sessionStorage) })
  if (!member && name === 'persist' && n.arguments.length >= 2) {
    const cfg = objectArg(n.arguments[1], scope);
    const nm = cfg && h.prop(cfg, 'name');
    const k = nm && keyOf(nm, scope);
    return k && { area: areaFromConfig(cfg, scope), key: k.text, dynamic: k.dynamic, ref: k.ref, op: 'read/write', lib: 'zustand persist' };
  }

  // redux-persist: persistReducer({ key: 'root', storage }, reducer) → stored as "persist:root"
  if (!member && name === 'persistReducer') {
    const cfg = objectArg(n.arguments[0], scope);
    const kp = cfg && h.prop(cfg, 'key');
    const k = kp && keyOf(kp, scope);
    const prefixNode = cfg && h.prop(cfg, 'keyPrefix');
    const prefix = prefixNode ? (keyOf(prefixNode, scope) || { text: 'persist:' }).text : 'persist:';
    return k && { area: areaFromConfig(cfg, scope), key: prefix + k.text, dynamic: k.dynamic, op: 'read/write', lib: 'redux-persist' };
  }
  return null;
}

/** `localStorage.token`, `localStorage['token'] = x` — property access instead of getItem/setItem. */
function detectMember(n, parents, scope) {
  if (n.type !== 'MemberExpression' && n.type !== 'OptionalMemberExpression') return null;
  const area = storageArea(n.object, scope);
  if (!area) return null;
  const parent = parents[parents.length - 1];
  // the callee of localStorage.getItem(…) is handled by detectCall
  if (parent && (parent.type === 'CallExpression' || parent.type === 'OptionalCallExpression') && parent.callee === n) return null;
  let key = null;
  if (n.computed) key = keyOf(n.property, scope);
  else if (n.property && n.property.name && !(n.property.name in STORAGE_OPS) && n.property.name !== 'length') key = { text: n.property.name, dynamic: false };
  if (!key) return null;
  const write = parent && parent.type === 'AssignmentExpression' && parent.left === n;
  const del = parent && parent.type === 'UnaryExpression' && parent.operator === 'delete';
  return { area, key: key.text, dynamic: key.dynamic, ref: key.ref, op: write ? 'write' : del ? 'remove' : 'read', lib: `${area}Storage${n.computed ? '[…]' : '.' + key.text}` };
}

function analyzeFile(abs, text) {
  const result = { imports: [], finds: [], exportAliases: new Map(), strings: new Map(), objects: new Map() };
  for (const block of h.scriptBlocks(abs, text)) {
    const ast = h.parseBlock(block);
    if (!ast) continue;
    const consts = new Map();
    const imported = new Map(); // local name → { source, name }
    h.walk(ast.program, (n) => {
      if (n.type === 'ImportDeclaration') {
        const names = n.specifiers.map((s) => (s.type === 'ImportDefaultSpecifier' ? 'default' : s.type === 'ImportNamespaceSpecifier' ? '*' : s.imported ? h.keyName(s.imported) : null)).filter(Boolean);
        result.imports.push({ source: n.source.value, names: names.length ? names : ['*'], typeOnly: n.importKind === 'type' });
        for (const s of n.specifiers) {
          if (s.importKind === 'type' || n.importKind === 'type') continue;
          imported.set(s.local.name, { source: n.source.value, name: s.type === 'ImportSpecifier' ? h.keyName(s.imported) : s.type === 'ImportDefaultSpecifier' ? 'default' : '*' });
        }
      } else if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init) {
        consts.set(n.id.name, n.init);
      } else if (n.type === 'ExportSpecifier' && n.local && n.exported) {
        result.exportAliases.set(h.keyName(n.exported), n.local.name);
      }
    });
    const scope = { consts, imported, code: block.code };
    // Top-level string constants and objects of strings, so an importer can resolve `CART_KEY` / `KEYS.cart`.
    for (const stmt of ast.program.body) {
      const d = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
      if (!d || d.type !== 'VariableDeclaration') continue;
      for (const v of d.declarations) {
        if (v.id.type !== 'Identifier' || !v.init) continue;
        const init = h.unwrap(v.init);
        if (init.type === 'ObjectExpression') {
          const obj = new Map();
          for (const p of init.properties) {
            if (p.type !== 'ObjectProperty') continue;
            const s = h.urlOf(p.value, scope);
            if (s && !s.dynamic) obj.set(h.keyName(p.key), s.text);
          }
          if (obj.size) result.objects.set(v.id.name, obj);
        } else {
          const s = h.urlOf(init, scope);
          if (s && !s.dynamic) result.strings.set(v.id.name, s.text);
        }
      }
    }
    for (const stmt of ast.program.body) {
      const owners = h.topLevelNames(stmt);
      h.walk(stmt, (n, parents) => {
        let found = null;
        if (n.type === 'CallExpression' || n.type === 'OptionalCallExpression') found = detectCall(n, scope);
        else if (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') found = detectMember(n, parents, scope);
        if (!found) return;
        found.line = (n.loc ? n.loc.start.line : 1) + block.lineOffset;
        found.owners = owners;
        found.fn = h.enclosingName(parents) || owners.find((o) => o !== 'default') || null;
        if (found.ref) found.ref = { ...found.ref, ...imported.get(found.ref.name) };
        result.finds.push(found);
      });
    }
  }
  return result;
}

/**
 * Scan a component file and the local modules it imports (two levels deep, only the exports it uses).
 * Returns { keys: [{ area, key, dynamic, op, lib, url, file, line, fn }], files } with project-relative paths.
 */
function scan(root, componentAbs) {
  const aliasList = h.aliases(root);
  const rel = (abs) => h.toPosix(path.relative(root, abs));
  const files = new Map();
  const queue = [{ abs: componentAbs, depth: 0, names: null }];

  while (queue.length && files.size < MAX_FILES) {
    const item = queue.shift();
    const known = files.get(item.abs);
    if (known) {
      if (known.names && item.names) item.names.forEach((n) => known.names.add(n));
      else known.names = null;
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
    const entry = { analysis, depth: item.depth, names: item.names ? new Set(item.names) : null, resolved: new Map() };
    files.set(item.abs, entry);
    if (item.depth > MAX_DEPTH) continue;
    for (const imp of analysis.imports) {
      const target = resolveCached(entry, item.abs, imp.source, aliasList);
      if (!target || target === item.abs || imp.typeOnly) continue;
      // Past the depth limit a module is still read for its constants (key names), but its calls are not counted.
      const names = imp.names.includes('*') ? null : new Set(imp.names);
      queue.push({ abs: target, depth: item.depth + 1, names: item.depth + 1 > MAX_DEPTH ? new Set() : names });
    }
  }

  const resolveRef = (entry, abs, ref) => {
    if (!ref || !ref.source) return null;
    const target = resolveCached(entry, abs, ref.source, aliasList);
    const mod = target && files.get(target);
    if (!mod) return null;
    const local = mod.analysis.exportAliases.get(ref.name) || ref.name;
    if (ref.member) {
      const obj = mod.analysis.objects.get(local);
      return obj && obj.has(ref.member) ? obj.get(ref.member) : null;
    }
    return mod.analysis.strings.get(local) || null;
  };

  const keys = [];
  for (const [abs, entry] of files) {
    if (entry.depth > MAX_DEPTH) continue;
    const { analysis, names } = entry;
    const wanted = names ? new Set([...names].map((n) => analysis.exportAliases.get(n) || n)) : null;
    for (const f of analysis.finds) {
      if (wanted && !f.owners.some((o) => wanted.has(o))) continue;
      let key = f.key;
      let dynamic = Boolean(f.dynamic);
      const resolved = f.ref ? resolveRef(entry, abs, f.ref) : null;
      if (resolved != null) {
        key = key.replace(`{${f.ref.member || f.ref.name}}`, resolved);
        dynamic = /\{[^}]*\}/.test(key);
      }
      keys.push({ area: f.area, key, dynamic, op: f.op, lib: f.lib, url: f.url || null, file: rel(abs), line: f.line, fn: f.fn || null, external: entry.depth > 0 });
    }
  }
  return { keys, files: [...files.entries()].filter(([, e]) => e.depth <= MAX_DEPTH).map(([abs]) => rel(abs)) };
}

function resolveCached(entry, fromAbs, spec, aliasList) {
  if (!entry.resolved.has(spec)) entry.resolved.set(spec, h.resolveImport(fromAbs, spec, aliasList));
  return entry.resolved.get(spec);
}

module.exports = { scan, _internal: { analyzeFile } };
