'use strict';

const path = require('path');
const { parse } = require('@babel/parser');
const MagicStringMod = require('magic-string');
const MagicString = MagicStringMod.default || MagicStringMod;

const ATTR_FILE = 'data-mf-file';
const ATTR_LINE = 'data-mf-line';
const ATTR_COMP = 'data-mf-comp';
// Where a component is *used* (`<Button />` in Page.tsx). Lets the inspector show the call-site,
// not only the definition. data-* so it is harmless if a component spreads its props onto the DOM.
const ATTR_CALL = 'data-mf-call';

// Components that reject or mishandle unknown props.
const NO_CALL_SITE = new Set(['Fragment', 'StrictMode', 'Profiler', 'Suspense', 'SuspenseList', 'Activity', 'ViewTransition', 'Html', 'Head', 'Main', 'NextScript']);

function isComponentName(n) {
  if (!n) return false;
  if (n.type === 'JSXIdentifier') return /^[A-Z]/.test(n.name) && !NO_CALL_SITE.has(n.name);
  if (n.type === 'JSXMemberExpression') {
    // <Foo.Bar>, but not <React.Fragment> / <Ctx.Provider> / <motion.div>
    const prop = n.property && n.property.name;
    if (!prop || NO_CALL_SITE.has(prop) || prop === 'Provider' || prop === 'Consumer') return false;
    return /^[A-Z]/.test(prop);
  }
  return false;
}

const JSX_FILE = /\.(jsx|tsx|js|mjs)$/;
const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'range', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens']);

function isIgnoredPath(file) {
  return !file || file.includes('\0') || /[\\/]node_modules[\\/]/.test(file) || /[\\/]\.next[\\/]/.test(file);
}

function toRel(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function nameFromFile(file) {
  const base = path.basename(file).replace(/\.[^.]+$/, '');
  if (/^(page|layout|index|template|route|\+page|\+layout)$/.test(base)) {
    const dir = path.basename(path.dirname(file));
    return `${dir}/${base}`;
  }
  return base;
}

function transformJsx(code, file, root) {
  if (!code.includes('<')) return null;
  const isTs = /\.tsx$/.test(file);
  let ast;
  try {
    ast = parse(code, {
      sourceType: 'module',
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
      plugins: isTs ? ['jsx', 'typescript', 'decorators-legacy'] : ['jsx', 'decorators-legacy'],
    });
  } catch {
    return null;
  }

  const rel = toRel(root, file);
  const fallbackName = nameFromFile(file);
  const callSites = !/^(0|false|off)$/i.test(String(process.env.SOURCEPEEK_CALLSITES || ''));
  const s = new MagicString(code);
  let tagged = 0;

  function visit(node, comp) {
    if (!node || typeof node.type !== 'string') return;
    let next = comp;

    switch (node.type) {
      case 'FunctionDeclaration':
      case 'ClassDeclaration':
        if (node.id && /^[A-Z]/.test(node.id.name)) next = node.id.name;
        break;
      case 'VariableDeclarator':
        if (node.id && node.id.type === 'Identifier' && /^[A-Z]/.test(node.id.name)) next = node.id.name;
        break;
      case 'ExportDefaultDeclaration':
        if (node.declaration && !node.declaration.id) next = fallbackName;
        break;
      case 'JSXOpeningElement': {
        const n = node.name;
        if (callSites && isComponentName(n)) {
          const already = node.attributes.some((a) => a.type === 'JSXAttribute' && a.name && a.name.name === ATTR_CALL);
          if (!already) {
            // Placed after the last attribute so a forwarded `{...props}` cannot overwrite it.
            const last = node.attributes[node.attributes.length - 1];
            const typeArgs = node.typeArguments || node.typeParameters;
            const at = last ? last.end : typeArgs ? typeArgs.end : n.end;
            s.appendLeft(at, ` ${ATTR_CALL}={${JSON.stringify(`${rel}:${node.loc.start.line}`)}}`);
            tagged++;
          }
        }
        if (n && n.type === 'JSXIdentifier' && /^[a-z]/.test(n.name)) {
          const already = node.attributes.some(
            (a) => a.type === 'JSXAttribute' && a.name && a.name.name === ATTR_FILE
          );
          if (!already) {
            const line = node.loc.start.line;
            s.appendLeft(
              n.end,
              ` ${ATTR_FILE}={${JSON.stringify(rel)}} ${ATTR_LINE}={${JSON.stringify(String(line))}} ${ATTR_COMP}={${JSON.stringify(comp || fallbackName)}}`
            );
            tagged++;
          }
        }
        break;
      }
    }

    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue;
      const v = node[key];
      if (Array.isArray(v)) for (const c of v) visit(c, next);
      else if (v && typeof v.type === 'string') visit(v, next);
    }
  }

  visit(ast.program, null);
  if (!tagged) return null;
  return { code: s.toString(), map: s.generateMap({ source: file, includeContent: true, hires: true }) };
}

function transformVue(code, file, root, compilerSfc) {
  if (!compilerSfc || !code.includes('<template')) return null;
  let descriptor;
  try {
    ({ descriptor } = compilerSfc.parse(code, { filename: file, sourceMap: false }));
  } catch {
    return null;
  }
  const tpl = descriptor.template;
  if (!tpl || !tpl.ast || (tpl.lang && tpl.lang !== 'html')) return null;

  const rel = toRel(root, file);
  const comp = nameFromFile(file);
  const s = new MagicString(code);
  const base = tpl.ast.loc && tpl.ast.loc.start.offset > 0 ? 0 : tpl.loc.start.offset;
  const lineBase = base === 0 ? 0 : tpl.loc.start.line - 1;
  let tagged = 0;

  function visit(node) {
    if (!node) return;
    if (node.type === 1 && node.tagType === 0) {
      const has = (node.props || []).some((p) => p.name === ATTR_FILE);
      if (!has) {
        const at = base + node.loc.start.offset + 1 + node.tag.length;
        const line = node.loc.start.line + lineBase;
        s.appendLeft(at, ` ${ATTR_FILE}="${esc(rel)}" ${ATTR_LINE}="${line}" ${ATTR_COMP}="${esc(comp)}"`);
        tagged++;
      }
    }
    (node.children || []).forEach(visit);
  }
  visit(tpl.ast);
  if (!tagged) return null;
  return { code: s.toString(), map: s.generateMap({ source: file, includeContent: true, hires: true }) };
}

function createVueNodeTransform(getRoot) {
  return function sourcepeekNodeTransform(node, context) {
    if (node.type !== 1 || node.tagType !== 0) return;
    const file = context.filename;
    if (!file || isIgnoredPath(file)) return;
    if (node.props.some((p) => p.name === ATTR_FILE)) return;
    const rel = toRel(getRoot(), file);
    const add = (name, value) =>
      node.props.push({
        type: 6,
        name,
        nameLoc: node.loc,
        value: { type: 2, content: value, loc: node.loc },
        loc: node.loc,
      });
    add(ATTR_FILE, rel);
    add(ATTR_LINE, String(node.loc.start.line));
    add(ATTR_COMP, nameFromFile(file));
  };
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function transform(code, file, root, extra = {}) {
  if (isIgnoredPath(file)) return null;
  if (JSX_FILE.test(file)) return transformJsx(code, file, root);
  if (file.endsWith('.vue')) return transformVue(code, file, root, extra.compilerSfc);
  return null;
}

module.exports = { transform, transformJsx, transformVue, createVueNodeTransform, isIgnoredPath, toRel };
