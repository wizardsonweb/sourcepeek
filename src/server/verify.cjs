'use strict';
// Checks that run after the syntax check and before anything is written. Code can parse and still crash:
//  • a component used in JSX that is never imported or declared ("Meter is not defined")
//  • a relative import of a file that doesn't exist, or of a default export that isn't there
//  • Next.js App Router: hooks / event handlers in a Server Component, or a new client component without 'use client'
//  • "add a component" that silently deletes the markup it was supposed to sit next to
// Each problem is phrased as an instruction, because it goes back to the AI for its retry.

const fs = require('fs');
const path = require('path');
const { parse } = require('@babel/parser');
const angular = require('./angular.cjs');

const JS_FILE = /\.(jsx|tsx|js|mjs|ts)$/;
const SFC_FILE = /\.(vue|svelte)$/;
const RESOLVE_EXTS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.vue', '.svelte'];

function plugins(file) {
  if (/\.tsx$/.test(file)) return ['jsx', 'typescript', 'decorators-legacy'];
  if (/\.ts$/.test(file)) return ['typescript', 'decorators-legacy'];
  return ['jsx', 'decorators-legacy'];
}

/** Script part of a file: the whole file for JS/TS, the <script> blocks for Vue/Svelte. */
function scriptOf(file, code) {
  if (JS_FILE.test(file)) return { code, file };
  if (/\.(vue|svelte)$/.test(file)) {
    const blocks = [...String(code).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    if (!blocks.length) return { code: '', file: 'x.js', sfc: true }; // markup only: nothing imported
    const ts = blocks.some((b) => /lang=["']ts/.test(b[1]));
    return { code: blocks.map((b) => b[2]).join('\n'), file: ts ? 'x.ts' : 'x.js', sfc: true };
  }
  return null;
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

function patternNames(p, out) {
  if (!p) return;
  switch (p.type) {
    case 'Identifier':
      out.add(p.name);
      break;
    case 'ObjectPattern':
      p.properties.forEach((x) => patternNames(x.type === 'RestElement' ? x.argument : x.value, out));
      break;
    case 'ArrayPattern':
      p.elements.forEach((x) => patternNames(x, out));
      break;
    case 'RestElement':
      patternNames(p.argument, out);
      break;
    case 'AssignmentPattern':
      patternNames(p.left, out);
      break;
    case 'TSParameterProperty':
      patternNames(p.parameter, out);
      break;
  }
}

const SKIP = new Set(['loc', 'start', 'end', 'extra', 'range', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens']);

/** Declared names (anywhere in the file), JSX component names used, and imports. */
function analyze(file, code) {
  const s = scriptOf(file, code);
  if (!s) return null;
  const ast = astOf(s.file, s.code);
  if (!ast) return null;
  const declared = new Set();
  const used = new Map(); // name -> first line
  const imports = []; // {source, default: bool, named: [..], namespace: bool, line}
  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return;
    switch (n.type) {
      case 'ImportDeclaration': {
        const imp = { source: n.source.value, default: false, named: [], namespace: false, line: n.loc.start.line, typeOnly: n.importKind === 'type' };
        for (const sp of n.specifiers) {
          declared.add(sp.local.name);
          if (sp.type === 'ImportDefaultSpecifier') imp.default = true;
          else if (sp.type === 'ImportNamespaceSpecifier') imp.namespace = true;
          else if (sp.importKind !== 'type') {
            const name = sp.imported.type === 'Identifier' ? sp.imported.name : sp.imported.value;
            if (name === 'default') imp.default = true;
            else imp.named.push(name);
          }
        }
        imports.push(imp);
        break;
      }
      case 'VariableDeclarator':
        patternNames(n.id, declared);
        break;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
      case 'ObjectMethod':
      case 'ClassMethod':
        if (n.id) declared.add(n.id.name);
        (n.params || []).forEach((p) => patternNames(p, declared));
        break;
      case 'ClassDeclaration':
      case 'ClassExpression':
      case 'TSEnumDeclaration':
      case 'TSImportEqualsDeclaration':
        if (n.id) declared.add(n.id.name);
        break;
      case 'CatchClause':
        patternNames(n.param, declared);
        break;
      case 'JSXOpeningElement': {
        let name = n.name;
        while (name && name.type === 'JSXMemberExpression') name = name.object;
        if (name && name.type === 'JSXIdentifier' && (/^[A-Z]/.test(name.name) || n.name.type === 'JSXMemberExpression')) {
          if (!used.has(name.name)) used.set(name.name, n.loc.start.line);
        }
        break;
      }
    }
    for (const k of Object.keys(n)) {
      if (SKIP.has(k)) continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v.type === 'string') visit(v);
    }
  };
  visit(ast.program);
  return { declared, used, imports, sfc: Boolean(s.sfc) };
}

// ---------- import resolution ----------

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''));
  } catch {
    return null;
  }
}

/** `@/x` style aliases from tsconfig/jsconfig paths, plus the Next.js default. */
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
  if (!out.some((a) => a.prefix === '$lib/') && fs.existsSync(path.join(root, 'src', 'lib'))) {
    const pkg = readJson(path.join(root, 'package.json')) || {};
    if ({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }['@sveltejs/kit']) out.push({ prefix: '$lib/', dir: path.resolve(root, 'src', 'lib') });
  }
  if (!out.some((a) => a.prefix === '@/')) {
    for (const d of ['src', '.']) if (fs.existsSync(path.join(root, d, 'app')) || fs.existsSync(path.join(root, d, 'components'))) out.push({ prefix: '@/', dir: path.resolve(root, d), guess: true });
  }
  return out;
}

/** Absolute path the import points to (created files count), null if missing, undefined if not checkable. */
function resolveImport(root, fromAbs, spec, created, aliasList) {
  let base;
  if (spec.startsWith('.')) base = path.resolve(path.dirname(fromAbs), spec);
  else {
    const a = aliasList.find((x) => spec.startsWith(x.prefix));
    if (!a) return undefined; // a package — not ours to check
    base = path.join(a.dir, spec.slice(a.prefix.length));
  }
  const exists = (p) => created.has(p) || (fs.existsSync(p) && fs.statSync(p).isFile());
  const cands = [base, ...RESOLVE_EXTS.map((e) => base + e), ...RESOLVE_EXTS.map((e) => path.join(base, 'index' + e))];
  // `./Meter.js` written for a `.tsx` file (TS ESM style)
  if (/\.(js|jsx|mjs)$/.test(base)) {
    const stem = base.replace(/\.(js|jsx|mjs)$/, '');
    cands.push(stem + '.ts', stem + '.tsx');
  }
  const hit = cands.find(exists);
  if (hit) return hit;
  return null;
}

function exportsOf(code) {
  if (/export\s+\*\s+from/.test(code)) return null; // can't tell — don't check
  const named = new Set();
  for (const m of code.matchAll(/export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|enum|interface|type)\s+([A-Za-z_$][\w$]*)/g)) named.add(m[1]);
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const seg = part.trim().split(/\s+as\s+/);
      const name = (seg[1] || seg[0] || '').trim();
      if (name) named.add(name);
    }
  }
  const hasDefault = /export\s+default\b/.test(code) || named.has('default');
  return { hasDefault, named };
}

/** Exports of a Vue / Svelte file: always a default export (the component); named ones only from a module script. */
function sfcExports(file, code) {
  const named = new Set();
  for (const b of String(code).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    const attrs = b[1];
    const moduleScript = file.endsWith('.svelte') ? /\bcontext\s*=\s*["']module["']|\bmodule\b/.test(attrs) : !/\bsetup\b/.test(attrs);
    if (!moduleScript) continue;
    const ex = exportsOf(b[2]);
    if (ex) ex.named.forEach((n) => named.add(n));
  }
  named.delete('default');
  return { hasDefault: true, named };
}

/**
 * Does the bundler find `./Child` when the file is Child.vue / Child.svelte? Vite does not (its default
 * resolve.extensions has no .vue/.svelte); Vue CLI (webpack) and configs that add the extension do.
 */
function sfcWithoutExtensionOk(root, ext) {
  const pkg = readJson(path.join(root, 'package.json')) || {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (ext === '.vue' && (deps['@vue/cli-service'] || deps.nuxt)) return true;
  for (const f of ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs', 'svelte.config.js', 'webpack.config.js']) {
    try {
      const t = fs.readFileSync(path.join(root, f), 'utf8');
      if (new RegExp(`extensions[^\\]]*['"]\\${ext}['"]`).test(t)) return true;
    } catch {}
  }
  return false;
}

/** The markup of a Vue/Svelte file with <script> and <style> blocks blanked out (offsets and lines kept). */
function sfcMarkup(code) {
  return String(code).replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/g, (m) => m.replace(/[^\n]/g, ' '));
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/** Component tags in Svelte markup: <Child>, <Child.Part> (→ Child). Returns Map name → first line. */
function svelteComponentTags(code) {
  const markup = sfcMarkup(code);
  const out = new Map();
  for (const m of markup.matchAll(/<([A-Z][\w$]*)(?:\.[\w$.]+)?(?=[\s/>])/g)) if (!out.has(m[1])) out.set(m[1], lineAt(markup, m.index));
  return out;
}

/** Names Svelte markup declares itself: {#each xs as Item}, {#snippet Row()}, {@const X = …}, let:X, {:then X}. */
function svelteMarkupNames(code) {
  const markup = sfcMarkup(code);
  const out = new Set();
  const rxs = [/\bas\s*\(?\s*([A-Z][\w$]*)/g, /\{#snippet\s+([A-Z][\w$]*)/g, /\{@const\s+([A-Z][\w$]*)/g, /\blet:([A-Z][\w$]*)/g, /\blet:[\w$]+=\{?\s*([A-Z][\w$]*)/g, /\{:?(?:then|catch)\s+([A-Z][\w$]*)/g, /\{#await\s[^}]*\bthen\s+([A-Z][\w$]*)/g];
  for (const rx of rxs) for (const m of markup.matchAll(rx)) out.add(m[1]);
  return out;
}

const kebab = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase();

/** First line where Vue markup uses <Name> or <name-kebab>, or 0. */
function vueUses(code, name) {
  const markup = sfcMarkup(code);
  const m = markup.match(new RegExp(`<(?:${name}|${kebab(name)})(?=[\\s/>])`));
  return m ? lineAt(markup, m.index) : 0;
}

function allowsTsExtensions(root) {
  for (const f of ['tsconfig.json', 'jsconfig.json']) {
    const j = readJson(path.join(root, f));
    if (j && j.compilerOptions && j.compilerOptions.allowImportingTsExtensions) return true;
  }
  return false;
}

// ---------- Next.js App Router ----------

function isNext(root) {
  const j = readJson(path.join(root, 'package.json')) || {};
  return Boolean((j.dependencies && j.dependencies.next) || (j.devDependencies && j.devDependencies.next));
}

const USE_CLIENT = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*['"]use client['"]/;
const CLIENT_ONLY = /\b(useState|useEffect|useReducer|useRef|useLayoutEffect|useContext|useCallback|useMemo|useTransition|useOptimistic|useActionState|useFormStatus|useRouter|usePathname|useSearchParams|useParams)\s*\(|\bon[A-Z]\w*\s*=\s*\{|\b(window|document|localStorage|sessionStorage)\./;

const inAppRouter = (rel) => /(^|\/)app\//.test(rel) && !/(^|\/)pages\//.test(rel);
const clientSignals = (code) => {
  const m = String(code).match(CLIENT_ONLY);
  return m ? m[0].replace(/\s*[=({]+$/, '').trim() : null;
};

// ---------- the check ----------

/**
 * changes: [{abs, rel, role, before, after, created}]
 * opts: { kind, instruction }
 * Returns a list of problem strings (empty when fine).
 */
function verify(root, changes, opts = {}) {
  const problems = [];
  const created = new Map(changes.filter((c) => c.before === null).map((c) => [c.abs, c.after]));
  const aliasList = aliases(root);
  const next = isNext(root);
  const tsExtOk = allowsTsExtensions(root);

  for (const c of changes) {
    const after = analyze(c.rel, c.after);
    if (!after) continue;
    const before = c.before === null ? null : analyze(c.rel, c.before);

    // 1b. Svelte: <Child /> in the markup needs Child imported (or declared) in the <script>.
    if (c.rel.endsWith('.svelte')) {
      const markupNames = svelteMarkupNames(c.after);
      const beforeTags = c.before === null ? new Map() : svelteComponentTags(c.before);
      const beforeAnalysis = before;
      for (const [name, line] of svelteComponentTags(c.after)) {
        if (after.declared.has(name) || markupNames.has(name)) continue;
        if (beforeTags.has(name) && beforeAnalysis && !beforeAnalysis.declared.has(name)) continue; // was already like that
        const made = [...created.keys()].find((k) => path.basename(k, '.svelte') === name);
        const spec = made ? relSpec(c.abs, made) : `./${name}.svelte`;
        problems.push(`${c.rel} line ${line} uses <${name}> but its <script> never imports ${name}. Svelte components are default exports: add  import ${name} from '${spec}';  (default import, keep the .svelte extension — not import { ${name} }).`);
      }
    }
    // 1c. Vue: a newly created component used in the template must be imported (script setup) or registered.
    if (c.rel.endsWith('.vue')) {
      for (const made of created.keys()) {
        if (!made.endsWith('.vue') || made === c.abs) continue;
        const name = path.basename(made, '.vue');
        const line = vueUses(c.after, name);
        if (!line) continue;
        const setup = /<script\b[^>]*\bsetup\b/.test(c.after);
        const registered = setup ? after.declared.has(name) : after.declared.has(name) && new RegExp(`components\\s*:\\s*\\{[^}]*\\b${name}\\b`).test(c.after);
        if (!registered) {
          problems.push(`${c.rel} line ${line} uses <${name}> but ${setup ? 'its <script setup> never imports it' : 'it is not imported and listed in components: { … }'}. Add  import ${name} from '${relSpec(c.abs, made)}';${setup ? '' : ` and components: { ${name} }`} (default import, keep the .vue extension).`);
        }
      }
    }

    // 1. JSX components that are used but never imported/declared (only ones this change introduced).
    if (!after.sfc) {
      for (const [name, line] of after.used) {
        if (after.declared.has(name)) continue;
        if (before && before.used.has(name) && !before.declared.has(name)) continue; // was already like that
        problems.push(`${c.rel} line ${line} uses <${name}> but never imports or declares ${name}. Add the import (e.g. import ${name} from './${name}') — check default vs named export — or don't use it.`);
      }
    }

    // 2. New imports must resolve, and import the exports that exist.
    const oldImports = new Set(before ? before.imports.map((i) => i.source + '|' + i.default + '|' + i.named.join(',')) : []);
    for (const imp of after.imports) {
      if (imp.typeOnly) continue;
      if (oldImports.has(imp.source + '|' + imp.default + '|' + imp.named.join(','))) continue;
      if (!tsExtOk && /^[.@~]/.test(imp.source) && /\.(tsx?|mts|cts)$/.test(imp.source)) {
        problems.push(`${c.rel} line ${imp.line} imports "${imp.source}" with a .ts/.tsx extension. Write it without the extension ("${imp.source.replace(/\.(tsx?|mts|cts)$/, '')}") — TypeScript and some bundlers reject it.`);
        continue;
      }
      const target = resolveImport(root, c.abs, imp.source, created, aliasList);
      if (target === undefined) continue;
      if (target === null) {
        const guess = aliasList.find((a) => imp.source.startsWith(a.prefix) && a.guess);
        if (!guess) problems.push(`${c.rel} line ${imp.line} imports "${imp.source}", which does not exist${created.size ? ` (new files: ${[...created.keys()].map((k) => path.relative(path.dirname(c.abs), k).split(path.sep).join('/')).map((p) => (p.startsWith('.') ? p : './' + p)).join(', ')})` : ''}. Fix the path.`);
        continue;
      }
      const sfcExt = (target.match(SFC_FILE) || [])[0];
      if (sfcExt) {
        if (!imp.source.endsWith(sfcExt) && !sfcWithoutExtensionOk(root, sfcExt)) {
          const fixed = path.basename(target, sfcExt) === 'index' && !/index$/.test(imp.source) ? `${imp.source.replace(/\/$/, '')}/index${sfcExt}` : `${imp.source}${sfcExt}`;
          problems.push(`${c.rel} line ${imp.line} imports "${imp.source}", but Vite only finds ${path.basename(target)} with its extension. Write "${fixed}".`);
          continue;
        }
        let sfcCode = created.get(target);
        if (sfcCode === undefined) {
          const changed = changes.find((x) => x.abs === target);
          sfcCode = changed ? changed.after : (() => { try { return fs.readFileSync(target, 'utf8'); } catch { return ''; } })();
        }
        const ex = sfcExports(target, sfcCode);
        const kind = sfcExt === '.svelte' ? 'Svelte' : 'Vue';
        for (const n of imp.named) {
          if (ex.named.has(n)) continue;
          const local = n;
          problems.push(`${c.rel} line ${imp.line} imports { ${n} } from "${imp.source}", but a ${kind} component file only has a default export. Write  import ${local} from '${imp.source}';  (no braces).`);
        }
        continue;
      }
      if (!JS_FILE.test(target)) continue;
      let code = created.get(target);
      if (code === undefined) {
        const changed = changes.find((x) => x.abs === target);
        code = changed ? changed.after : (() => { try { return fs.readFileSync(target, 'utf8'); } catch { return null; } })();
      }
      const ex = code && exportsOf(code);
      if (!ex) continue;
      const rel = path.relative(root, target).split(path.sep).join('/');
      if (imp.default && !ex.hasDefault) problems.push(`${c.rel} line ${imp.line} default-imports from "${imp.source}", but ${rel} has no default export${ex.named.size ? ` (it exports ${[...ex.named].join(', ')})` : ''}. Use a named import or add export default.`);
      for (const n of imp.named) if (!ex.named.has(n)) problems.push(`${c.rel} line ${imp.line} imports { ${n} } from "${imp.source}", but ${rel} doesn't export ${n}${ex.hasDefault ? ' (it has a default export)' : ''}.`);
    }

    // 3. Next.js App Router: client-only code needs 'use client'.
    if (next && !USE_CLIENT.test(c.after)) {
      const sig = clientSignals(c.after);
      const hadSig = c.before !== null && clientSignals(c.before);
      if (sig && !hadSig) {
        if (c.created) {
          problems.push(`${c.rel} uses ${sig}, so it must be a Client Component: make "use client"; its first line. (This is Next.js; components are Server Components by default.)`);
        } else if (inAppRouter(c.rel)) {
          problems.push(`${c.rel} is a Next.js Server Component, but the change adds ${sig}. Put that state/handler in a separate Client Component (its own file starting with "use client") and render it here, instead of adding it to ${path.basename(c.rel)}.`);
        }
      }
    }
  }

  // 4a. Angular: a new component must be wired up where its selector is used.
  if (angular.isAngular(root)) problems.push(...angularProblems(root, changes, created));

  // 4. "Add a component" must not delete the surrounding markup.
  if ((opts.kind === 'component' || opts.kind === 'page') && !/\b(extract|split|move|replace|refactor|pull|break\s+out|turn\s+.+\s+into|convert|swap|instead\s+of|remove|delete)\b/i.test(opts.instruction || '')) {
    for (const c of changes) {
      if (c.before === null) continue;
      const removed = lineDelta(c.before, c.after);
      if (removed > 3) {
        problems.push(`The request only asks to ADD a ${opts.kind === 'page' ? 'page' : 'component'}, but the edit removes ${removed} existing lines from ${c.rel}. Keep all existing markup and insert the new component (e.g. as a new child of the clicked element).`);
      }
    }
  }
  return problems;
}

/** './Child.svelte' style specifier from one file to another. */
function relSpec(fromAbs, toAbs) {
  const r = path.relative(path.dirname(fromAbs), toAbs).split(path.sep).join('/');
  return r.startsWith('.') ? r : './' + r;
}

const tsSpec = (fromAbs, toAbs) => relSpec(fromAbs, toAbs).replace(/\.ts$/, '');

function countTag(text, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (String(text || '').match(new RegExp(`<${esc}(?=[\\s/>])`, 'g')) || []).length;
}

/** Angular: templates of a change — an .html file, or the inline templates of a .ts file. */
function templatesOf(c, code) {
  if (code == null) return [];
  if (c.abs.endsWith('.html')) return [{ text: code, ownerMeta: null }];
  if (!/\.ts$/.test(c.abs) || !/@Component\s*\(/.test(code)) return [];
  return angular.componentsIn(code).filter((m) => m.template).map((m) => ({ text: m.template.text, ownerMeta: m }));
}

function angularProblems(root, changes, created) {
  const problems = [];
  const major = angular.angularMajor(root);
  const current = (abs) => {
    const ch = changes.find((x) => x.abs === abs);
    if (ch) return ch.after;
    try {
      return fs.readFileSync(abs, 'utf8');
    } catch {
      return null;
    }
  };
  const relOf = (abs) => path.relative(root, abs).split(path.sep).join('/');

  // New components: their templateUrl / styleUrl(s) must exist.
  const made = [];
  for (const c of changes) {
    if (c.before !== null || !/\.ts$/.test(c.abs)) continue;
    for (const meta of angular.componentsIn(c.after)) {
      made.push({ ...meta, abs: c.abs, rel: c.rel });
      for (const url of [meta.templateUrl, ...meta.styleUrls].filter(Boolean)) {
        const p = angular.resolveUrl(c.abs, url);
        if (!created.has(p) && !fs.existsSync(p)) problems.push(`${c.rel}: ${meta.className} points to "${url}", which does not exist. Create that file too, or fix the path (it is relative to ${path.basename(c.abs)}).`);
      }
      if (!meta.selector) problems.push(`${c.rel}: ${meta.className} has no selector. Give it one with the project's prefix, e.g. selector: 'app-${kebab(meta.className.replace(/Component$/, ''))}'.`);
    }
  }

  // Wherever a new selector is now used, the component that renders it must import (or its NgModule declare) it.
  for (const comp of made) {
    const selectors = String(comp.selector || '')
      .split(',')
      .map((x) => x.trim())
      .filter((x) => /^[a-z][\w-]*$/.test(x));
    if (!selectors.length) continue;
    for (const c of changes) {
      if (c.abs === comp.abs) continue;
      const afterT = templatesOf(c, c.after);
      const beforeT = templatesOf(c, c.before);
      for (const t of afterT) {
        const used = selectors.find((sel) => countTag(t.text, sel) > beforeT.reduce((n, b) => n + countTag(b.text, sel), 0));
        if (!used) continue;
        // the component that owns this template
        let ownerAbs = c.abs;
        let ownerMeta = t.ownerMeta;
        if (!ownerMeta) {
          const own = made.find((m) => m.templateUrl && angular.resolveUrl(m.abs, m.templateUrl) === c.abs);
          if (own) {
            ownerAbs = own.abs;
            ownerMeta = own;
          } else {
            const o = angular.ownerOfTemplate(c.abs);
            if (!o) continue;
            ownerAbs = o.abs;
            const code = current(o.abs);
            ownerMeta = angular.componentsIn(code || '').find((m) => m.className === o.meta.className) || o.meta;
          }
        }
        const ownerRel = relOf(ownerAbs);
        if (angular.isStandalone(ownerMeta, major)) {
          if (!angular.isStandalone(comp, major)) {
            problems.push(`${comp.rel}: ${comp.className} is used by the standalone component ${ownerMeta.className}, so it must be standalone itself${(major || 0) < 19 ? ' — add standalone: true to its @Component' : ' — remove standalone: false'}.`);
          }
          if (!ownerMeta.imports || !ownerMeta.imports.names.includes(comp.className)) {
            problems.push(`${ownerRel}: the template of ${ownerMeta.className} now uses <${used}>, but ${comp.className} is not in its @Component imports array, so Angular reports "'${used}' is not a known element". Add ${comp.className} to imports: [ … ] in ${path.basename(ownerRel)}.`);
          }
          const a = analyze(ownerRel, current(ownerAbs) || '');
          if (a && !a.declared.has(comp.className)) {
            problems.push(`${ownerRel} must import the class: add  import { ${comp.className} } from '${tsSpec(ownerAbs, comp.abs)}';  (named import, no .ts extension).`);
          }
        } else {
          const mod = angular.declaringModule(root, ownerAbs, ownerMeta.className);
          const modCode = mod ? current(mod) || '' : null;
          if (mod) {
            // A standalone component goes in the NgModule's imports, a non-standalone one in its declarations.
            const standalone = angular.isStandalone(comp, major);
            const list = standalone ? 'imports' : 'declarations';
            const arr = (modCode.match(new RegExp(`\\b${list}\\s*:\\s*\\[([^\\]]*)\\]`)) || [])[1] || '';
            const wrong = (modCode.match(new RegExp(`\\b${standalone ? 'declarations' : 'imports'}\\s*:\\s*\\[([^\\]]*)\\]`)) || [])[1] || '';
            const has = (txt) => new RegExp(`\\b${comp.className}\\b`).test(txt);
            if (!has(arr)) {
              problems.push(`${ownerMeta.className} is declared in ${relOf(mod)}, so ${comp.className} must be in that NgModule's ${list} for <${used}> to work${has(wrong) ? ` (it is in ${standalone ? 'declarations' : 'imports'}, but it is ${standalone ? '' : 'not '}standalone)` : ''}. Add it to ${list}: [ … ] and import { ${comp.className} } from '${tsSpec(mod, comp.abs)}'.`);
            }
            const a = analyze(relOf(mod), modCode);
            if (a && has(arr) && !a.declared.has(comp.className)) {
              problems.push(`${relOf(mod)} must import the class: add  import { ${comp.className} } from '${tsSpec(mod, comp.abs)}';`);
            }
          }
        }
      }
    }
  }
  return problems;
}

/** Net number of lines removed (removed minus added), ignoring blank lines. */
function lineDelta(before, after) {
  const count = (s) => {
    const m = new Map();
    for (const l of String(s).replace(/\r\n/g, '\n').split('\n')) {
      const t = l.trim();
      if (t) m.set(t, (m.get(t) || 0) + 1);
    }
    return m;
  };
  const a = count(before);
  const b = count(after);
  let removed = 0;
  for (const [l, n] of a) removed += Math.max(0, n - (b.get(l) || 0));
  return removed;
}

/** Prompt rules for the framework: Next.js App Router, Vue / Svelte imports, Angular. */
function frameworkRules(root, files) {
  const r = [];
  const comp = files.find((f) => f.role === 'component');
  if (comp && comp.rel.endsWith('.svelte')) r.push(...svelteRules(comp));
  if (comp && comp.rel.endsWith('.vue')) r.push(...vueRules(comp));
  if (angular.isAngular(root)) r.push(...angularRules(root, files));
  if (isNext(root)) r.push(...nextRules(comp));
  return r;
}

function svelteRules(comp) {
  const runes = /\$(props|state|derived|effect)\s*[(<]/.test(comp.content);
  return [
    'Svelte components have only a default export. Import them as  import Child from \'./Child.svelte\';  — always the default import, always with the .svelte extension. Never write import { Child } from \'./Child.svelte\', and never leave out the extension.',
    runes
      ? 'This project uses Svelte 5 runes: props come from let { … } = $props(), state from $state(), derived values from $derived(), events are plain props (onclick={…}).'
      : 'This component uses the Svelte 3/4 syntax: props are export let …, events on:click={…}, reactive statements $: …. Keep that syntax.',
  ];
}

function vueRules(comp) {
  const setup = /<script\b[^>]*\bsetup\b/.test(comp.content);
  return [
    'Vue single-file components have only a default export. Import them as  import Child from \'./Child.vue\';  — always the default import, always with the .vue extension. Never write import { Child } from \'./Child.vue\'.',
    setup
      ? 'The component uses <script setup>: importing a component there is enough to use it in the template.'
      : 'The component uses the Options API: after importing a component, also register it in components: { Child }.',
  ];
}

function angularRules(root, files) {
  const r = [];
  const major = angular.angularMajor(root);
  const comp = files.find((f) => f.role === 'component');
  const cls = files.find((f) => f.role === 'class') || (comp && /\.ts$/.test(comp.rel) ? comp : null);
  const mod = files.find((f) => f.role === 'module');
  const template = comp && comp.rel.endsWith('.html') ? comp : null;
  r.push(
    `Angular${major ? ' ' + major : ''}: ${template ? `the clicked element is in the template ${template.rel}; the component class is ${cls ? cls.rel : 'its .ts file'}. Markup goes in the template, logic (state, inputs, outputs, handlers, imports) in the class.` : `${comp ? comp.rel : 'the component'} holds both the class and its inline template.`}`
  );
  const meta = cls ? angular.componentsIn(cls.content)[0] : null;
  if (meta) {
    if (angular.isStandalone(meta, major)) {
      r.push(`${meta.className} is a standalone component: every component, directive (NgClass, RouterLink…) and pipe (DatePipe, AsyncPipe…) its template uses must be in its @Component imports array AND imported at the top of ${cls.rel}. A child component is used by its selector (<app-price-tag [price]="price" />), never by its class name.`);
    } else {
      r.push(`${meta.className} is declared in an NgModule${mod ? ` (${mod.rel})` : ''}: components, directives and pipes its template uses must be declared in, or imported into, that module.`);
    }
  }
  const tplText = template ? template.content : meta && meta.template ? meta.template.text : '';
  if (/\*ng(If|For|Switch)/.test(tplText) && !/@(if|for|switch)\b/.test(tplText)) {
    r.push('The template uses *ngIf / *ngFor: keep that style (in a standalone component NgIf / NgFor or CommonModule must be in imports).');
  } else if ((major || 0) >= 17) {
    r.push('Use the built-in control flow: @if (cond) { … } @else { … }, @for (item of items; track item.id) { … }, @switch. A literal { or } in template text must be written as {{ \'{\' }}.');
  }
  if (cls && /\b(signal|input|computed|model)\s*[(<]/.test(cls.content)) {
    r.push('The class uses signals: call them in the template ({{ count() }}), create state with signal(), inputs with input() / input.required(), outputs with output().');
  } else if (cls && /@Input\s*\(/.test(cls.content)) {
    r.push('The class uses @Input() / @Output() decorators: keep that style for new inputs and outputs.');
  }
  r.push('Bindings: [prop]="expr", (event)="handler($event)", [class.name]="cond", two-way [(ngModel)] needs FormsModule in imports.');
  return r;
}

function nextRules(comp) {
  const r = [];
  const server = comp && inAppRouter(comp.rel) && !USE_CLIENT.test(comp.content);
  if (server) {
    r.push(`Next.js App Router: ${comp.rel} is a Server Component (no "use client"). Do not add hooks (useState, useEffect…), event handlers (onClick…) or browser APIs to it. Put interactive parts in a Client Component — a file whose first line is "use client"; — and render that here.`);
  } else if (comp && USE_CLIENT.test(comp.content)) {
    r.push(`Next.js: ${comp.rel} is a Client Component ("use client"), so hooks and event handlers are fine here.`);
  }
  r.push('Next.js: any NEW component that uses state, effects, event handlers or browser APIs must start with "use client"; as its first line. Use the "@/" import alias only if the project already uses it; otherwise relative imports.');
  return r;
}

module.exports = { verify, frameworkRules, analyze, lineDelta };
