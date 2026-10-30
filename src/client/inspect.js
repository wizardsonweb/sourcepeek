// Framework introspection: component chain (breadcrumbs), call-sites, props and state.
// React → fibers, Vue → component instances, Svelte → __svelte_meta, Angular → ng debug API, anything else → DOM tags.

import { ngChain, ngApi } from './angular.js';
import { preview } from './valueView.js';

const baseName = (f) => String(f).split(/[\\/]/).pop().replace(/\.[^.]+$/, '');

function parseCall(v) {
  const m = typeof v === 'string' && v.match(/^(.*):(\d+)$/);
  return m ? { file: m[1], line: Number(m[2]) } : null;
}

// ---------- value preview ----------

/** One-line preview of a value (Angular forms, RxJS subjects, signals and Vue refs shown for what they hold). */
export function describe(value) {
  return preview(value, 120);
}

// `raw` = true returns the values themselves instead of previews (used by "Renders & state" to diff them).
function entries(obj, skip = [], raw = false) {
  if (!obj || typeof obj !== 'object') return [];
  return Object.keys(obj)
    .filter((k) => !skip.includes(k))
    .map((k) => [k, raw ? obj[k] : k === 'children' ? describeChildren(obj[k]) : describe(obj[k])]);
}

function describeChildren(c) {
  if (Array.isArray(c)) return `[${c.length} children]`;
  return describe(c);
}

// ---------- React ----------

let prodNames = false;
/** On a production build, component names are minified: prefer the names tagged at build time. */
export function setProductionNames(on) {
  prodNames = Boolean(on);
}

const REACT_COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]); // function, class, forwardRef, memo, simple memo
const HOST_TAGS = new Set([5, 26, 27]); // host component, hoistable, singleton (<html>/<body> in React 19)

function reactFiber(node) {
  for (const k in node) if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) return node[k];
  return null;
}

function fiberName(f) {
  const t = f.type;
  if (!t) return null;
  if (typeof t === 'function') return t.displayName || t.name || null;
  if (typeof t === 'object') {
    if (t.displayName) return t.displayName;
    const inner = t.render || t.type;
    if (inner) return inner.displayName || inner.name || (inner.render && (inner.render.displayName || inner.render.name)) || null;
  }
  return null;
}

function firstHost(f) {
  for (let n = f.child; n; n = n.child) if (n.stateNode && n.stateNode.nodeType === 1 && HOST_TAGS.has(n.tag)) return n.stateNode;
  return null;
}

/**
 * A fiber and its alternate swap roles on every commit; DOM nodes and `.return` pointers can point at either.
 * This is React's own findCurrentFiberUsingSlowPath: returns the copy that is on screen, or null if unmounted.
 */
export function findCurrentFiber(fiber) {
  const alternate = fiber && fiber.alternate;
  if (!fiber) return null;
  if (!alternate) {
    let n = fiber;
    while (n.return) n = n.return;
    return n.tag === 3 ? fiber : null;
  }
  let a = fiber;
  let b = alternate;
  for (let guard = 0; guard < 10000; guard++) {
    const parentA = a.return;
    if (!parentA) break;
    const parentB = parentA.alternate;
    if (!parentB) {
      const next = parentA.return;
      if (next) {
        a = b = next;
        continue;
      }
      break;
    }
    if (parentA.child === parentB.child) {
      for (let child = parentA.child; child; child = child.sibling) {
        if (child === a) return fiber;
        if (child === b) return alternate;
      }
      return null;
    }
    if (a.return !== b.return) {
      a = parentA;
      b = parentB;
    } else {
      let found = false;
      for (let child = parentA.child; child; child = child.sibling) {
        if (child === a) {
          found = true;
          a = parentA;
          b = parentB;
          break;
        }
        if (child === b) {
          found = true;
          b = parentA;
          a = parentB;
          break;
        }
      }
      if (!found) {
        for (let child = parentB.child; child; child = child.sibling) {
          if (child === a) {
            found = true;
            a = parentB;
            b = parentA;
            break;
          }
          if (child === b) {
            found = true;
            b = parentB;
            a = parentA;
            break;
          }
        }
      }
      if (!found) return null;
    }
  }
  if (a.tag !== 3 || !a.stateNode) return null;
  return a.stateNode.current === a ? fiber : alternate;
}

/** Props and state of a React component fiber, as [[key, preview]] rows. */
export function readReact(fiber, raw = false) {
  return { props: entries(fiber.memoizedProps || {}, ['data-mf-call'], raw), state: reactState(fiber, raw) };
}

function reactState(f, raw = false) {
  if (f.tag === 1) return f.stateNode && f.stateNode.state ? entries(f.stateNode.state, [], raw) : [];
  const out = [];
  let h = f.memoizedState;
  let i = 0;
  while (h && i < 60) {
    // useState / useReducer hooks are the ones with an update queue that has a reducer.
    if (h.queue && typeof h.queue === 'object' && 'lastRenderedReducer' in h.queue) out.push([`state[${out.length}]`, raw ? h.memoizedState : describe(h.memoizedState)]);
    h = h.next;
    i++;
  }
  return out;
}

// One upward walk over the fiber tree visits both the DOM ancestors (host fibers, tagged with
// data-mf-*) and the client components, in their real nesting order. Server Components have no
// fibers on the client, but the DOM they rendered is tagged, so they still show up in the chain.
function reactChain(el) {
  const fiber = reactFiber(el);
  if (!fiber) return null;
  const domComps = new Set();
  for (let a = el; a; a = a.parentElement) if (a.dataset && a.dataset.mfComp) domComps.add(a.dataset.mfComp);
  const up = []; // innermost first
  const push = (item) => {
    const prev = up[up.length - 1];
    if (prev && prev.name === item.name && (!prev.file || !item.file || prev.file === item.file)) {
      // Same component seen again further out: its outer DOM element, or the fiber that owns the DOM
      // we just passed, or a memo() wrapper around the inner function.
      if (item.fromDom) {
        prev.el = item.el;
        prev.line = item.line;
        prev.file = prev.file || item.file;
      } else {
        prev.callSite = prev.callSite || item.callSite;
        if (!prev.props) {
          prev.props = item.props;
          prev.propsRaw = item.propsRaw;
        }
        if (!prev.state || !prev.state.length) prev.state = item.state;
        prev._fiber = prev._fiber || item._fiber;
        prev.fiber = true;
      }
      return;
    }
    up.push(item);
  };
  for (let f = fiber; f; f = f.return) {
    if (HOST_TAGS.has(f.tag) && f.stateNode && f.stateNode.dataset && f.stateNode.dataset.mfComp) {
      const n = f.stateNode;
      push({ name: n.dataset.mfComp, el: n, file: n.dataset.mfFile, line: Number(n.dataset.mfLine) || 1, callSite: null, props: null, state: null, fromDom: true });
      continue;
    }
    if (!REACT_COMPONENT_TAGS.has(f.tag)) continue;
    const props = f.memoizedProps || {};
    const call = parseCall(props['data-mf-call']);
    const host = firstHost(f);
    let name = fiberName(f);
    const tagged = host && host.dataset && host.dataset.mfComp;
    if (!name && tagged) name = tagged;
    // Production builds minify component names (`u`, `$E`); the tag written at build time keeps the real one.
    else if (prodNames && tagged && name !== tagged && /^[$_]?[A-Za-z]{0,2}\$?\d*$/.test(name) && (call || domComps.has(tagged))) name = tagged;
    if (!name || !(call || domComps.has(name))) continue;
    let cur = f;
    try {
      cur = findCurrentFiber(f) || f;
    } catch {}
    push({ name, el: host, file: null, line: null, callSite: call, props: entries(cur.memoizedProps || props, ['data-mf-call']), propsRaw: entries(cur.memoizedProps || props, ['data-mf-call'], true), state: reactState(cur), fiber: true, _fiber: f });
  }
  // An element written in Page but rendered inside <Card>{children}</Card> appears as "Page" both
  // outside and inside Card. Keep the outer, real component and drop the DOM-only repeat.
  const out = up.reverse().filter((c, i, all) => c.fiber || !all.slice(0, i).some((o) => o.name === c.name && (!o.file || o.file === c.file)));
  for (const c of out) {
    delete c.fromDom;
    delete c.fiber;
  }
  return out;
}

// ---------- Vue ----------

/** Props and state of a Vue component instance, as [[key, preview]] rows. */
export function readVue(i, raw = false) {
  const setup = i.setupState && typeof i.setupState === 'object' ? i.setupState : {};
  const state = [];
  for (const k of Object.keys(setup)) {
    let v;
    try {
      v = setup[k];
    } catch {
      continue;
    }
    if (typeof v === 'function') continue;
    // <script setup> exposes imported components too — they are code, not state.
    if (v && typeof v === 'object' && !v.__v_isRef && (v.__hmrId || v.__file || typeof v.setup === 'function' || typeof v.render === 'function')) continue;
    state.push([k, raw ? v : describe(v)]);
  }
  if (i.data && typeof i.data === 'object') state.push(...entries(i.data, [], raw));
  return { props: entries(i.props, [], raw), state: state.slice(0, 40) };
}

function vueChain(el) {
  let inst = null;
  for (let n = el; n && !inst; n = n.parentElement) inst = n.__vueParentComponent || null;
  if (!inst) return null;
  const out = [];
  for (let i = inst; i; i = i.parent) {
    const type = i.type || {};
    if (!type.__file) continue; // internal components (Transition, RouterView, …)
    const { props, state } = readVue(i);
    let propsRaw = null;
    try {
      propsRaw = readVue(i, true).props;
    } catch {}
    let root = i.subTree && i.subTree.el;
    while (root && root.nodeType !== 1) root = root.nextSibling;
    const parentFile = i.parent && i.parent.type && i.parent.type.__file;
    out.push({
      name: type.__name || type.name || baseName(type.__file),
      el: root || null,
      file: type.__file,
      line: root && root.dataset && root.dataset.mfLine ? Number(root.dataset.mfLine) : 1,
      callSite: parentFile ? { file: parentFile, line: null } : null,
      props,
      propsRaw,
      state,
      _inst: i,
    });
  }
  return out.reverse();
}

// ---------- Svelte ----------

function svelteChain(el, lineOffset) {
  let meta = null;
  let node = el;
  for (; node && !meta; node = node.parentElement) meta = node.__svelte_meta && node.__svelte_meta.loc ? node.__svelte_meta : null;
  if (!meta) return null;
  const out = [{ name: baseName(meta.loc.file), el, file: meta.loc.file, line: (meta.loc.line || 0) + lineOffset, callSite: null, props: null, state: null }];
  // Svelte 5 records the component hierarchy (with usage locations) in meta.parent.
  for (let p = meta.parent; p; p = p.parent) {
    if (p.type !== 'component' || !p.file) continue;
    out[out.length - 1].callSite = out[out.length - 1].callSite || { file: p.file, line: (p.line || 0) + lineOffset };
    out.push({ name: baseName(p.file), el: null, file: p.file, line: null, callSite: null, props: null, state: null });
  }
  return out.length > 1 ? out.reverse() : null;
}

// ---------- DOM fallback ----------

function domChain(el, lineOffset) {
  const out = [];
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    let file = null;
    let line = null;
    let name = null;
    if (n.dataset && n.dataset.mfFile) {
      file = n.dataset.mfFile;
      line = Number(n.dataset.mfLine) || 1;
      name = n.dataset.mfComp || baseName(file);
    } else if (n.__svelte_meta && n.__svelte_meta.loc && n.__svelte_meta.loc.file) {
      file = n.__svelte_meta.loc.file;
      line = (n.__svelte_meta.loc.line || 0) + lineOffset;
      name = baseName(file);
    }
    if (!file) continue;
    const last = out[out.length - 1];
    if (last && last.name === name && last.file === file) {
      last.el = n; // keep the outermost element of that component
      last.line = line;
    } else out.push({ name, el: n, file, line, callSite: null, props: null, state: null });
  }
  return out.reverse();
}

/**
 * Component chain from the outermost user component to the one that contains `el`.
 * Each item: { name, el, file, line, callSite: {file,line}|null, props: [[k,v]]|null, state: [[k,v]]|null }
 */
export function componentChain(el, { lineOffset = 0 } = {}) {
  let chain = null;
  try {
    chain = reactChain(el) || vueChain(el) || svelteChain(el, lineOffset) || ngChain(el);
  } catch {
    chain = null;
  }
  if (!chain || !chain.length) chain = domChain(el, lineOffset);
  return chain;
}

/** The visible text that belongs to this element itself (not to nested elements). */
export function ownText(el) {
  let t = '';
  for (const c of el.childNodes) if (c.nodeType === 3) t += c.textContent;
  t = t.replace(/\s+/g, ' ').trim();
  if (!t && el.children.length === 0) t = (el.textContent || '').replace(/\s+/g, ' ').trim();
  return t.length > 300 ? '' : t;
}

/**
 * The top-level DOM elements a component rendered — what "Accessibility" checks.
 * track: { fiber | vueInst | ngInst, el, file }.
 */
export function componentRoots(track) {
  const out = [];
  try {
    if (track.fiber) {
      const cur = findCurrentFiber(track.fiber) || track.fiber;
      const walk = (f, depth) => {
        for (let c = f.child; c && out.length < 50; c = c.sibling) {
          if (HOST_TAGS.has(c.tag) && c.stateNode && c.stateNode.nodeType === 1) out.push(c.stateNode);
          else if (depth < 200) walk(c, depth + 1);
        }
      };
      walk(cur, 0);
    } else if (track.vueInst) {
      const sub = track.vueInst.subTree;
      if (sub && sub.el && sub.el.nodeType === 1) out.push(sub.el);
      else if (sub && sub.el) {
        for (let n = sub.el; n && n !== sub.anchor; n = n.nextSibling) if (n.nodeType === 1) out.push(n);
      }
    } else if (track.ngInst) {
      const ng = ngApi();
      const host = ng && ng.getHostElement(track.ngInst);
      if (host) out.push(host);
    } else if (track.el && track.el.__svelte_meta) {
      let top = track.el;
      for (let a = track.el; a && a.nodeType === 1; a = a.parentElement) {
        const m = a.__svelte_meta;
        if (m && m.loc && m.loc.file === track.file) top = a;
      }
      out.push(top);
    }
  } catch {}
  if (!out.length && track.root) out.push(track.root);
  if (!out.length && track.el) out.push(track.el);
  return out.filter((n) => n && n.isConnected);
}
