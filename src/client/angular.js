// Angular introspection through the dev-mode debug API (window.ng). Angular templates are compiled by the
// Angular CLI, so elements carry no data-mf-* tags. Instead:
//   • ng.getOwningComponent(el) gives the component whose template contains the element,
//   • its class carries debug info with the file and line (Angular 17.1+, dev builds),
//   • the backend finds the element's line inside that component's template (/angular/locate).

import { describe } from './inspect.js';

const baseName = (f) => String(f).split(/[\\/]/).pop().replace(/\.[^.]+$/, '');

export function ngApi() {
  const ng = typeof window !== 'undefined' ? window.ng : null;
  return ng && typeof ng.getOwningComponent === 'function' && typeof ng.getComponent === 'function' ? ng : null;
}

function defOf(inst) {
  const ctor = inst && inst.constructor;
  return ctor ? ctor['ɵcmp'] || null : null;
}

/** { inst, def, name, file, line } for a component instance. */
function info(inst) {
  const def = defOf(inst);
  if (!def) return null;
  const dbg = def.debugInfo || null;
  const name = (dbg && dbg.className) || inst.constructor.name || 'Component';
  return { inst, def, name, file: (dbg && dbg.filePath) || null, line: (dbg && dbg.lineNumber) || 1, hasDebug: Boolean(dbg && dbg.filePath) };
}

function owning(ng, node) {
  try {
    return info(ng.getOwningComponent(node));
  } catch {
    return null;
  }
}

function hostOf(ng, inst) {
  try {
    return ng.getHostElement(inst) || null;
  } catch {
    return null;
  }
}

/**
 * The element the developer meant and the component whose template wrote it. Elements rendered inside a
 * library component (no debug info) resolve to the nearest ancestor written in the project's own templates.
 */
export function ngLocate(target) {
  const ng = ngApi();
  if (!ng) return null;
  let first = null;
  for (let node = target; node && node.nodeType === 1; node = node.parentElement) {
    if (node.tagName === 'SOURCEPEEK-ROOT') return null;
    const o = owning(ng, node);
    if (!o) continue;
    if (!first) first = { node, o };
    if (o.hasDebug) return { el: node, file: o.file, line: o.line, comp: o.name, ng: true };
  }
  // Angular < 17.1 has no debug info: use the class name, the backend finds its file.
  return first ? { el: first.node, file: null, line: 1, comp: first.o.name, ng: true } : null;
}

const NG_CLASS = /^ng-(star-inserted|tns-|trigger|animating|animate|untouched|touched|pristine|dirty|valid|invalid|pending|enter|leave)/;
const SKIP_ATTR = /^(_ngcontent-|_nghost-|ng-reflect-|ng-version$|ng-server-context$|data-mf-|class$|style$|id$)/;

/** What the backend needs to find the element in the template. */
function describeElement(ng, el, inst) {
  const chain = [];
  const host = hostOf(ng, inst);
  for (let a = el.parentElement; a && a !== host; a = a.parentElement) {
    let o = null;
    try {
      o = ng.getOwningComponent(a);
    } catch {}
    if (o === inst) chain.push(a.tagName.toLowerCase());
    if (chain.length >= 8 || a === document.body) break;
  }
  let index = 0;
  if (el.parentElement) {
    const same = Array.from(el.parentElement.children).filter((c) => {
      if (c.tagName !== el.tagName) return false;
      try {
        return ng.getOwningComponent(c) === inst;
      } catch {
        return false;
      }
    });
    index = Math.max(0, same.indexOf(el));
  }
  let text = '';
  for (const c of el.childNodes) if (c.nodeType === 3) text += c.textContent;
  text = text.replace(/\s+/g, ' ').trim();
  if (!text && el.children.length === 0) text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    classes: Array.from(el.classList || []).filter((c) => !NG_CLASS.test(c)),
    attrs: Array.from(el.attributes || [])
      .map((a) => a.name)
      .filter((n) => !SKIP_ATTR.test(n)),
    text: text.length > 300 ? '' : text,
    chain,
    index,
  };
}

/**
 * Resolve an Angular hit to the template file and line of the element, plus where its component is used.
 * `api` is core's backend call. Returns a new hit; on failure the original one (class file + line).
 */
export async function ngResolve(hit, api) {
  const ng = ngApi();
  if (!ng || !hit || !hit.ng) return hit;
  const o = owning(ng, hit.el);
  if (!o) return hit;
  const host = hostOf(ng, o.inst);
  const parent = host ? owning(ng, host) : null;
  const [self, call] = await Promise.all([
    api('/angular/locate', { file: o.file, className: o.name, element: describeElement(ng, hit.el, o.inst) }),
    parent ? api('/angular/locate', { file: parent.file, className: parent.name, element: describeElement(ng, host, parent.inst) }) : null,
  ]);
  const out = { ...hit };
  if (self && self.ok) {
    out.file = self.data.file;
    out.line = self.data.line;
    out.classFile = self.data.classFile;
    out.classLine = self.data.classLine;
    out.selector = self.data.selector;
  } else if (!out.file) {
    out.error = (self && self.error) || 'Could not find the component file';
  }
  if (call && call.ok) out.callSite = { file: call.data.file, line: call.data.line };
  return out;
}

// ---------- component chain, inputs and state ----------

function isSignal(v) {
  if (typeof v !== 'function') return false;
  try {
    return Object.getOwnPropertySymbols(v).some((s) => s.description === 'SIGNAL');
  } catch {
    return false;
  }
}

const read = (v) => (isSignal(v) ? safeCall(v) : v);

function safeCall(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** Class property names of the component's inputs, keyed by public name. */
function inputProps(def) {
  const out = new Map();
  const inputs = def.inputs || {};
  const declared = def.declaredInputs || {};
  for (const pub of Object.keys(inputs)) {
    const v = inputs[pub];
    let prop = typeof declared[pub] === 'string' ? declared[pub] : Array.isArray(v) ? v[0] : typeof v === 'string' ? v : pub;
    if (typeof prop !== 'string') prop = pub;
    out.set(pub, prop);
  }
  return out;
}

function outputProps(def) {
  const outputs = def.outputs || {};
  return new Set(Object.values(outputs).filter((v) => typeof v === 'string'));
}

function isInjected(v) {
  if (!v || typeof v !== 'object') return false;
  const c = v.constructor;
  if (c && (c['ɵprov'] || c['ɵfac'] || c['ɵcmp'] || c['ɵdir'])) return true;
  if ('nativeElement' in v) return true; // ElementRef
  // ChangeDetectorRef / ViewRef, Injector, DestroyRef, Renderer2 — framework plumbing, not state.
  if (typeof v.markForCheck === 'function' && typeof v.detectChanges === 'function') return true;
  if (typeof v.get === 'function' && (c && /Injector$/.test(c.name || ''))) return true;
  return Boolean(c && /^_?(NodeInjectorDestroyRef|DestroyRef|Renderer2?|DefaultDomRenderer2|EmulatedEncapsulationDomRenderer2|ViewContainerRef|TemplateRef|NgZone)\$?\d*$/.test(c.name || ''));
}

function props(o, raw = false) {
  const out = [];
  for (const [pub, prop] of inputProps(o.def)) {
    let v;
    try {
      v = o.inst[prop];
    } catch {
      continue;
    }
    out.push([pub, raw ? read(v) : describe(read(v))]);
  }
  return out;
}

function state(o, raw = false) {
  const skip = new Set([...inputProps(o.def).values(), ...outputProps(o.def), '__ngContext__']);
  const out = [];
  for (const k of Object.keys(o.inst)) {
    if (skip.has(k) || k.startsWith('_') || k.startsWith('ɵ')) continue;
    let v;
    try {
      v = o.inst[k];
    } catch {
      continue;
    }
    if (typeof v === 'function' && !isSignal(v)) continue;
    if (isInjected(v)) continue;
    if (v && typeof v === 'object' && typeof v.subscribe === 'function' && typeof v.emit === 'function') continue; // EventEmitter
    out.push([k, raw ? read(v) : describe(read(v))]);
    if (out.length >= 40) break;
  }
  return out;
}

/** Inputs and fields of an Angular component instance, as [[key, preview]] rows, plus whether it is OnPush. */
export function ngRead(inst, raw = false) {
  const o = info(inst);
  if (!o) return { props: [], state: [], onPush: false };
  return { props: props(o, raw), state: state(o, raw), onPush: Boolean(o.def.onPush) };
}

/** First element of the component's own template — what a breadcrumb highlights and re-inspects. */
function firstOwned(ng, host, inst) {
  if (!host) return null;
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(), i = 0; n && i < 200; n = walker.nextNode(), i++) {
    try {
      if (ng.getOwningComponent(n) === inst) return n;
    } catch {}
  }
  return host;
}

/** Component chain, outermost first: [{ name, el, file, line, callSite, props, state }]. */
export function ngChain(el) {
  const ng = ngApi();
  if (!ng) return null;
  let o = null;
  for (let n = el; n && n.nodeType === 1 && !o; n = n.parentElement) o = owning(ng, n);
  if (!o) return null;
  const out = [];
  const seen = new Set();
  while (o && !seen.has(o.inst) && out.length < 30) {
    seen.add(o.inst);
    const host = hostOf(ng, o.inst);
    const parent = host ? owning(ng, host) : null;
    out.push({
      name: o.name,
      el: firstOwned(ng, host, o.inst),
      file: o.file,
      line: o.line,
      callSite: parent && parent.file ? { file: parent.file, line: null } : null,
      props: props(o),
      propsRaw: props(o, true),
      state: state(o),
      _ngInst: o.inst,
    });
    o = parent;
  }
  return out.reverse();
}

export { baseName };
