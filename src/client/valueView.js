// Readable values for "Renders & state", the inspect panel's props and value provenance.
//
//  • describe(v)    → a node: what the value is (kind, class, size) and how to list what's inside it.
//                     Framework objects are shown for what they mean, not for their internals:
//                     Angular FormGroup / FormControl / FormArray → value, status, errors, dirty, touched;
//                     RxJS BehaviorSubject → its current value; Angular signals → their value; Vue refs unwrapped.
//  • freeze(v)      → a bounded deep copy of that view (the timeline keeps these, because Angular forms and
//                     Vue reactive objects are mutated in place, so the live object can't show the old value).
//  • changes(a, b)  → the paths that changed between two frozen values: `form.value.title "a" → "ab"`.
//  • preview(node)  → one line: `Array(5) [{id: 21, title: "asperiores…"}, …]`.
//  • valueTree(v)   → a DOM tree you can expand node by node, all the way down (live or frozen).
//  • openValueModal → the whole value in a large overlay: tree + pretty JSON, both complete.

const IDENT = /^[A-Za-z_$][\w$]*$/;
const STR_PREVIEW = 60;
const STR_FROZEN = 20000;
const PAGE = 100;

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function safeGet(o, k) {
  try {
    return o[k];
  } catch {
    return undefined;
  }
}

function ctorName(v) {
  try {
    const proto = Object.getPrototypeOf(v);
    if (!proto || proto === Object.prototype) return null;
    const c = proto.constructor;
    const n = c && c.name;
    return n && n !== 'Object' ? n.replace(/^_+/, '') : null;
  } catch {
    return null;
  }
}

function isSignalFn(v) {
  if (typeof v !== 'function') return false;
  try {
    return Object.getOwnPropertySymbols(v).some((s) => s.description === 'SIGNAL');
  } catch {
    return false;
  }
}

function isNgControl(v) {
  try {
    return (
      typeof v.status === 'string' &&
      'value' in v &&
      typeof v.setValue === 'function' &&
      v.valueChanges &&
      typeof v.valueChanges.subscribe === 'function'
    );
  } catch {
    return false;
  }
}

function isObservable(v) {
  try {
    return typeof v.subscribe === 'function' && typeof v.pipe === 'function';
  } catch {
    return false;
  }
}

function hiddenKey(k, plain) {
  if (k.startsWith('__v_') || k === '__ngContext__' || k.startsWith('ɵ') || k.startsWith('__reactFiber') || k.startsWith('__reactProps')) return true;
  // Underscore fields are internals on class instances (services, RxJS, stores) but real data on plain objects (`_id`).
  return !plain && k.startsWith('_');
}

function ngControlKind(v) {
  const name = ctorName(v);
  if (name && /^(Untyped)?Form(Group|Array|Control|Record)$/.test(name)) return name.replace(/^Untyped/, '');
  const c = safeGet(v, 'controls');
  if (Array.isArray(c)) return 'FormArray';
  if (c && typeof c === 'object') return 'FormGroup';
  return 'FormControl';
}

/**
 * What a value is and how to look inside it. Never throws.
 * { k: kind, c: class name, p: primitive, n: size, s: short label, kids: () => [[key, value]] | null, noDiff: Set }
 */
export function describe(v) {
  const t = typeof v;
  if (v === undefined) return { k: 'undefined' };
  if (v === null) return { k: 'null' };
  if (t === 'boolean' || t === 'number' || t === 'bigint') return { k: t, p: v };
  if (t === 'string') return { k: 'string', p: v };
  if (t === 'symbol') return { k: 'symbol', s: v.toString() };
  if (t === 'function') {
    if (isSignalFn(v)) {
      let inner;
      try {
        inner = v();
      } catch {}
      return { k: 'signal', c: 'Signal', kids: () => [['value', inner]], inner };
    }
    return { k: 'function', s: v.name || 'anonymous' };
  }
  try {
    if (v.__v_isRef) return describe(safeGet(v, 'value'));
    if (typeof Node !== 'undefined' && v instanceof Node) {
      if (v.nodeType !== 1) return { k: 'node', s: v.nodeName };
      const id = v.id ? `#${v.id}` : '';
      const cls = typeof v.className === 'string' && v.className.trim() ? '.' + v.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
      return { k: 'element', s: `<${v.tagName.toLowerCase()}${id}${cls}>` };
    }
    if (typeof Window !== 'undefined' && v instanceof Window) return { k: 'node', s: 'Window' };
    if (v.$$typeof) {
      const type = v.type;
      const name = typeof type === 'string' ? type : (type && (type.displayName || type.name)) || 'Component';
      return { k: 'react', s: `<${name} />`, kids: () => [['props', v.props], ...(v.key != null ? [['key', v.key]] : [])] };
    }
    if (v instanceof Date) return { k: 'date', s: isNaN(v) ? 'Invalid Date' : v.toISOString() };
    if (v instanceof RegExp) return { k: 'regexp', s: String(v) };
    if (v instanceof Error) return { k: 'error', c: v.name || 'Error', p: v.message, kids: () => [['message', v.message], ['stack', v.stack]] };
    if (typeof Promise !== 'undefined' && v instanceof Promise) return { k: 'promise', s: 'Promise' };
    if (isNgControl(v)) {
      const kind = ngControlKind(v);
      const kids = () => {
        const out = [['value', safeGet(v, 'value')], ['status', safeGet(v, 'status')]];
        const errors = safeGet(v, 'errors');
        if (errors) out.push(['errors', errors]);
        out.push(['dirty', safeGet(v, 'dirty')], ['touched', safeGet(v, 'touched')]);
        if (safeGet(v, 'disabled')) out.push(['disabled', true]);
        const c = safeGet(v, 'controls');
        if (c && typeof c === 'object') out.push(['controls', c]);
        return out;
      };
      // value already holds every field; repeating it per control would double every change in the timeline.
      return { k: 'form', c: kind, kids, noDiff: new Set(['controls']), status: safeGet(v, 'status'), value: safeGet(v, 'value') };
    }
    if (isObservable(v)) {
      const name = ctorName(v) || 'Observable';
      if (typeof v.getValue === 'function') {
        let cur;
        try {
          cur = v.getValue();
        } catch {}
        return { k: 'observable', c: name, kids: () => [['value', cur]], inner: cur, hasInner: true };
      }
      return { k: 'observable', c: name, s: name };
    }
    if (typeof Map !== 'undefined' && v instanceof Map) {
      return { k: 'map', c: 'Map', n: v.size, kids: () => [...v].map(([key, val]) => [mapKey(key), val]) };
    }
    if (typeof Set !== 'undefined' && v instanceof Set) {
      return { k: 'set', c: 'Set', n: v.size, kids: () => [...v].map((val, i) => [i, val]) };
    }
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
      const name = ctorName(v) || 'TypedArray';
      return { k: 'array', c: name, n: v.length, kids: () => Array.from(v.slice(0, 1000), (x, i) => [i, x]) };
    }
    if (Array.isArray(v)) return { k: 'array', c: 'Array', n: v.length, kids: () => v.map((x, i) => [i, x]) };
    const cls = ctorName(v);
    const plain = !cls;
    let keys = [];
    try {
      keys = Object.keys(v).filter((key) => !hiddenKey(key, plain));
    } catch {}
    return { k: 'object', c: cls, n: keys.length, kids: () => keys.map((key) => [key, safeGet(v, key)]) };
  } catch {
    return { k: 'object', c: '?', n: 0, kids: () => [] };
  }
}

function mapKey(key) {
  if (typeof key === 'string') return key;
  const d = describe(key);
  return d.p !== undefined ? String(d.p) : previewOf(d, 1, 40);
}

// ---------- frozen copies ----------

/** A bounded deep copy of describe()'s view. Frozen nodes have the same shape, with `e` instead of kids(). */
export function freeze(v, budget = 3000) {
  const b = { n: budget };
  const stack = [];
  const walk = (val, depth) => {
    if (--b.n < 0) return { k: 'more' };
    const d = describe(val);
    const out = { k: d.k };
    if (d.c) out.c = d.c;
    if (d.s !== undefined) out.s = d.s;
    if (d.n !== undefined) out.n = d.n;
    if (d.status) out.status = d.status;
    if (d.noDiff) out.nd = [...d.noDiff];
    if (d.p !== undefined) out.p = typeof d.p === 'string' && d.p.length > STR_FROZEN ? d.p.slice(0, STR_FROZEN) : d.p;
    if (typeof d.p === 'string' && d.p.length > STR_FROZEN) out.len = d.p.length;
    if (typeof d.p === 'bigint') out.p = String(d.p) + 'n';
    if (!d.kids) return out;
    if (val !== null && typeof val === 'object') {
      if (stack.includes(val)) return { k: 'circular' };
      stack.push(val);
    }
    let kids = [];
    try {
      kids = d.kids();
    } catch {}
    if (depth > 14) {
      out.e = [];
      out.x = kids.length;
    } else {
      out.e = [];
      const max = d.k === 'array' || d.k === 'set' || d.k === 'map' ? 500 : 300;
      for (const [key, child] of kids.slice(0, max)) {
        if (b.n < 0) break;
        out.e.push([key, walk(child, depth + 1)]);
      }
      if (kids.length > out.e.length) out.x = kids.length - out.e.length;
    }
    if (val !== null && typeof val === 'object') stack.pop();
    return out;
  };
  return walk(v, 0);
}

/** Frozen node → the same interface as describe() (kids() returns frozen children). */
export function frozenDescriptor(node) {
  if (!node) return { k: 'undefined' };
  return { ...node, kids: node.e ? () => node.e : null, noDiff: node.nd ? new Set(node.nd) : null, frozen: true };
}

/** Stable text of a frozen node: equal text ⇔ equal value (as far as the copy goes). */
export function fingerprintOf(node) {
  try {
    return JSON.stringify(node, (k, v) => (typeof v === 'bigint' ? String(v) : v));
  } catch {
    return String(Math.random());
  }
}

// ---------- changes between two frozen values ----------

export function pathJoin(path, key) {
  if (typeof key === 'number') return `${path}[${key}]`;
  if (IDENT.test(String(key))) return path ? `${path}.${key}` : String(key);
  return `${path}[${JSON.stringify(String(key))}]`;
}

const leafEqual = (a, b) => a.k === b.k && a.p === b.p && a.s === b.s && a.c === b.c && a.n === b.n && a.len === b.len;

/**
 * Paths whose value differs between two frozen nodes, deepest first where possible.
 * [{ path, from: frozenNode|null, to: frozenNode|null, added?, removed? }] — at most `limit`, plus `more` count.
 */
export function changes(a, b, base = '', limit = 8) {
  const out = [];
  let more = 0;
  const push = (c) => (out.length < limit ? out.push(c) : more++);
  const walk = (x, y, path) => {
    if (!x || !y) {
      push({ path, from: x || null, to: y || null, added: !x, removed: !y });
      return;
    }
    if (x.k === 'more' || y.k === 'more') return;
    const container = x.e && y.e && x.k === y.k && x.c === y.c;
    if (!container) {
      if (!leafEqual(x, y) || Boolean(x.e) !== Boolean(y.e) || (x.e && fingerprintOf(x) !== fingerprintOf(y))) push({ path, from: x, to: y });
      return;
    }
    const skip = new Set(x.nd || []);
    const xm = new Map(x.e.map(([k, n]) => [String(k), [k, n]]));
    const ym = new Map(y.e.map(([k, n]) => [String(k), [k, n]]));
    const keys = [...new Set([...xm.keys(), ...ym.keys()])];
    const before = out.length + more;
    for (const sk of keys) {
      if (skip.has(sk)) continue;
      const xe = xm.get(sk);
      const ye = ym.get(sk);
      const key = (xe || ye)[0];
      const xn = xe ? xe[1] : null;
      const yn = ye ? ye[1] : null;
      if (xn && yn && fingerprintOf(xn) === fingerprintOf(yn)) continue;
      walk(xn, yn, pathJoin(path, x.k === 'array' || x.k === 'set' ? Number(key) : key));
    }
    // Array grew or shrank beyond what the copy holds, or a status-only change on a form.
    if (out.length + more === before && (x.n !== y.n || x.status !== y.status || x.x !== y.x)) push({ path, from: x, to: y });
  };
  walk(a, b, base);
  return { list: out, more };
}

// ---------- one-line previews ----------

function strPreview(s, max = STR_PREVIEW) {
  const one = s.length > max ? s.slice(0, max) + '…' : s;
  return JSON.stringify(one).replace(/…"$/, '…"');
}

function keyText(k) {
  return typeof k === 'number' ? '' : IDENT.test(String(k)) ? String(k) : JSON.stringify(String(k));
}

/** One-line text for a descriptor (live or frozen). depth 0 shows a few children, deeper levels only a label. */
export function previewOf(d, depth = 0, max = 110) {
  switch (d.k) {
    case 'undefined':
    case 'null':
      return d.k;
    case 'boolean':
    case 'number':
      return String(d.p);
    case 'bigint':
      return String(d.p).replace(/n?$/, 'n');
    case 'string':
      return d.len ? strPreview(d.p) + ` (${d.len.toLocaleString()} chars)` : strPreview(d.p, depth ? 30 : STR_PREVIEW);
    case 'symbol':
    case 'element':
    case 'node':
    case 'react':
    case 'date':
    case 'regexp':
    case 'promise':
      return d.s;
    case 'function':
      return `ƒ ${d.s}()`;
    case 'circular':
      return '[circular]';
    case 'more':
      return '…';
    case 'error':
      return `${d.c}: ${d.p}`;
    default:
      break;
  }
  const kids = d.kids ? safeKids(d) : [];
  const label = labelOf(d);
  if (d.k === 'signal' || (d.k === 'observable' && kids.length)) {
    const inner = kids[0] ? childDesc(d, kids[0][1]) : { k: 'undefined' };
    return depth ? `${d.c}(…)` : `${d.c}(${previewOf(inner, 1, 60)})`;
  }
  if (d.k === 'observable') return d.c;
  if (d.k === 'form') {
    const value = kids.find(([k]) => k === 'value');
    const status = kids.find(([k]) => k === 'status');
    const st = status ? (status[1] && typeof status[1] === 'object' ? status[1].p : status[1]) : '';
    if (depth) return `${d.c} ${st || ''}`.trim();
    return `${d.c} ${value ? previewOf(childDesc(d, value[1]), 1, max - 20) : ''} ${st || ''}`.replace(/\s+/g, ' ').trim();
  }
  if (depth >= 2 || !kids.length) {
    if (d.k === 'array' || d.k === 'map' || d.k === 'set') return `${label}`;
    if (!kids.length) return d.c ? `${d.c} {}` : '{}';
    return d.c ? `${d.c} {…}` : '{…}';
  }
  const parts = [];
  let used = label.length + 4;
  let shown = 0;
  for (const [k, child] of kids) {
    const kt = keyText(k);
    const sep = d.k === 'map' ? ' => ' : ': ';
    const piece = (kt && d.k !== 'array' && d.k !== 'set' ? kt + sep : '') + previewOf(childDesc(d, child), depth + 1, depth ? 24 : 48);
    if (shown && used + piece.length > max) break;
    parts.push(piece);
    used += piece.length + 2;
    shown++;
  }
  const total = d.n !== undefined ? d.n : kids.length;
  const rest = total - shown;
  const inner = parts.join(', ') + (rest > 0 ? `, …${rest} more` : '');
  if (d.k === 'array') return `${label} [${inner}]`;
  if (d.k === 'map' || d.k === 'set') return `${label} {${inner}}`;
  return `${d.c ? d.c + ' ' : ''}{${inner}}`;
}

export function labelOf(d) {
  if (d.k === 'array') return `${d.c && d.c !== 'Array' ? d.c : 'Array'}(${d.n})`;
  if (d.k === 'map' || d.k === 'set') return `${d.c}(${d.n})`;
  if (d.k === 'object') return d.c || 'Object';
  return d.c || d.k;
}

function safeKids(d) {
  try {
    return d.kids() || [];
  } catch {
    return [];
  }
}

/** Child descriptor: frozen parents have frozen children. */
function childDesc(parent, child) {
  return parent.frozen ? frozenDescriptor(child) : describe(child);
}

/** Preview text of any raw value. */
export function preview(v, max) {
  return previewOf(describe(v), 0, max);
}

/** Preview text of a frozen node. */
export function previewFrozen(node, max) {
  return previewOf(frozenDescriptor(node), 0, max);
}

// ---------- JSON ----------

/** Complete JSON of what describe() shows (forms as their view, circular refs marked). Big but bounded. */
export function toJson(v, { frozen = false, indent = 2, maxChars = 4e6 } = {}) {
  const stack = [];
  let size = 0;
  const conv = (val, depth) => {
    if (size > maxChars) return '…';
    const d = frozen ? frozenDescriptor(val) : describe(val);
    size += 8;
    switch (d.k) {
      case 'undefined':
        return null;
      case 'null':
      case 'boolean':
      case 'number':
        return d.k === 'null' ? null : d.p;
      case 'string':
        size += d.p.length;
        return d.p;
      case 'bigint':
        return String(d.p);
      case 'circular':
        return '[circular]';
      case 'more':
        return '…';
      default:
        break;
    }
    if (!d.kids) return previewOf(d, 1);
    const raw = frozen ? null : val;
    if (raw && typeof raw === 'object') {
      if (stack.includes(raw)) return '[circular]';
      stack.push(raw);
    }
    if (depth > 40) return previewOf(d, 1);
    const kids = safeKids(d);
    let out;
    if (d.k === 'array' || d.k === 'set') out = kids.map(([, c]) => conv(c, depth + 1));
    else if (d.k === 'signal' || (d.k === 'observable' && kids.length)) out = conv(kids[0][1], depth + 1);
    else {
      out = {};
      for (const [k, c] of kids) out[String(k)] = conv(c, depth + 1);
      if (d.x) out['…'] = `${d.x} more`;
    }
    if (raw && typeof raw === 'object') stack.pop();
    return out;
  };
  try {
    return JSON.stringify(conv(v, 0), null, indent);
  } catch (err) {
    return String(err && err.message);
  }
}

// ---------- DOM tree ----------

function h(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

const PRIM_CLASS = { string: 'str', number: 'num', bigint: 'num', boolean: 'bool', null: 'nil', undefined: 'nil', function: 'fn', symbol: 'fn', date: 'num' };

function leafNode(d, full) {
  if (d.k === 'string') {
    const s = d.p;
    const span = h('span', 'mf-vt-str');
    if (!full && (s.length > 280 || s.split('\n').length > 4)) {
      span.classList.add('mf-vt-clamp');
      span.textContent = JSON.stringify(s.length > 4000 ? s.slice(0, 4000) : s).slice(0, -1) + (s.length > 4000 ? '…"' : '"');
      const wrap = h('span', 'mf-vt-strwrap');
      const more = h('button', 'mf-vt-more', `show all ${s.length.toLocaleString()} chars`);
      more.type = 'button';
      more.onclick = (e) => {
        e.stopPropagation();
        span.classList.remove('mf-vt-clamp');
        span.textContent = s;
        span.classList.add('mf-vt-str--raw');
        more.remove();
      };
      wrap.append(span, more);
      return wrap;
    }
    span.textContent = s.includes('\n') ? s : JSON.stringify(s);
    if (s.includes('\n')) span.classList.add('mf-vt-str--raw');
    if (d.len) span.textContent += ` … (${d.len.toLocaleString()} chars, copy for the rest)`;
    return span;
  }
  return h('span', 'mf-vt-' + (PRIM_CLASS[d.k] || 'lbl'), previewOf(d, 1));
}

/**
 * An expandable tree for a value. opts: { frozen, open: Set<path> (kept across re-renders), path, expand: depth to open initially }
 * Click a row (or its ▸) to open it. Long arrays page in steps of 100. Long strings are clamped with "show all".
 */
export function valueTree(value, opts = {}) {
  const open = opts.open || new Set();
  const root = h('div', 'mf-vt');
  root.setAttribute('role', 'tree');
  const desc = (v) => (opts.frozen ? frozenDescriptor(v) : describe(v));
  const node = (key, v, path, depth, parentDesc) => {
    const d = desc(v);
    const row = h('div', 'mf-vt-node');
    const line = h('div', 'mf-vt-line');
    line.setAttribute('role', 'treeitem');
    const expandable = Boolean(d.kids) && (d.k !== 'object' || d.n > 0 || d.x) && d.k !== 'more';
    const caret = h('span', 'mf-vt-caret', expandable ? '▸' : '');
    line.appendChild(caret);
    if (key !== null && key !== undefined) {
      const isIndex = parentDesc && (parentDesc.k === 'array' || parentDesc.k === 'set');
      line.append(h('span', isIndex ? 'mf-vt-idx' : 'mf-vt-key', isIndex ? String(key) : String(key)), h('span', 'mf-vt-colon', ':'));
    }
    const prev = h('span', 'mf-vt-prev');
    line.appendChild(prev);
    row.appendChild(line);
    if (!expandable) {
      prev.appendChild(leafNode(d, false));
      return row;
    }
    const kidsBox = h('div', 'mf-vt-kids');
    kidsBox.setAttribute('role', 'group');
    let built = false;
    const build = () => {
      built = true;
      const kids = safeKids(d);
      let shown = 0;
      const more = h('button', 'mf-vt-more mf-vt-page');
      more.type = 'button';
      const page = () => {
        const next = kids.slice(shown, shown + PAGE);
        for (const [k, c] of next) {
          const childPath = pathJoin(path, d.k === 'array' || d.k === 'set' ? Number(k) : k);
          kidsBox.insertBefore(node(k, c, childPath, depth + 1, d), more);
        }
        shown += next.length;
        const left = kids.length - shown;
        more.hidden = left <= 0;
        more.textContent = `show ${Math.min(PAGE, left)} more (${left.toLocaleString()} left of ${kids.length.toLocaleString()})`;
      };
      more.onclick = (e) => {
        e.stopPropagation();
        page();
      };
      kidsBox.appendChild(more);
      page();
      if (d.x) kidsBox.appendChild(h('div', 'mf-vt-note', `…${d.x} more not kept in this snapshot`));
      if (!kids.length && !d.x) kidsBox.appendChild(h('div', 'mf-vt-note', 'empty'));
    };
    const set = (isOpen) => {
      row.classList.toggle('mf-vt-node--open', isOpen);
      line.setAttribute('aria-expanded', String(isOpen));
      caret.textContent = isOpen ? '▾' : '▸';
      prev.textContent = isOpen ? labelOf(d) + (d.k === 'form' && d.status ? ` · ${d.status}` : '') : previewOf(d, depth ? 0 : 0, depth ? 90 : 140);
      prev.classList.toggle('mf-vt-prev--label', isOpen);
      if (isOpen && !built) build();
      kidsBox.hidden = !isOpen;
      if (isOpen) open.add(path);
      else open.delete(path);
    };
    line.classList.add('mf-vt-line--click');
    line.tabIndex = 0;
    line.onclick = (e) => {
      e.stopPropagation();
      set(kidsBox.hidden);
    };
    line.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        set(kidsBox.hidden);
      } else if (e.key === 'ArrowRight' && kidsBox.hidden) set(true);
      else if (e.key === 'ArrowLeft' && !kidsBox.hidden) set(false);
    };
    row.appendChild(kidsBox);
    set(open.has(path) || depth < (opts.expand || 0));
    return row;
  };
  root.appendChild(node(opts.key === undefined ? null : opts.key, value, opts.path || '', 0, null));
  return root;
}

// ---------- full view ----------

let modalHost = null;

/** Show a value completely in a large overlay inside `shadow`: tree (expandable to the bottom) and pretty JSON. */
export function openValueModal(shadow, title, value, { frozen = false, onCopy } = {}) {
  closeValueModal();
  const back = h('div', 'mf-vmodal');
  const card = h('div', 'mf-vmodal-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', title);
  const head = h('div', 'mf-vmodal-head');
  const t = h('strong', 'mf-vmodal-title', title);
  const tabs = h('div', 'mf-net-tabs');
  const treeTab = h('button', 'mf-net-tab mf-net-tab--on', 'Tree');
  const jsonTab = h('button', 'mf-net-tab', 'JSON');
  treeTab.type = jsonTab.type = 'button';
  tabs.append(treeTab, jsonTab);
  const copyBtn = h('button', 'mf-net-btn', 'Copy JSON');
  copyBtn.type = 'button';
  const close = h('button', 'mf-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  head.append(t, tabs, copyBtn, close);
  const body = h('div', 'mf-vmodal-body');
  const d = frozen ? frozenDescriptor(value) : describe(value);
  const sum = h('div', 'mf-vmodal-sum', previewOf(d, 0, 200));
  const treeBox = h('div', 'mf-vmodal-tree');
  treeBox.appendChild(valueTree(value, { frozen, expand: 1 }));
  const pre = h('pre', 'mf-vmodal-json');
  pre.hidden = true;
  let json = null;
  const getJson = () => (json === null ? (json = toJson(value, { frozen })) : json);
  body.append(sum, treeBox, pre);
  card.append(head, body);
  back.appendChild(card);
  const show = (which) => {
    treeTab.classList.toggle('mf-net-tab--on', which === 'tree');
    jsonTab.classList.toggle('mf-net-tab--on', which === 'json');
    treeBox.hidden = which !== 'tree';
    pre.hidden = which !== 'json';
    if (which === 'json' && !pre.textContent) pre.textContent = getJson();
  };
  treeTab.onclick = () => show('tree');
  jsonTab.onclick = () => show('json');
  copyBtn.onclick = () => onCopy && onCopy(getJson(), copyBtn);
  close.onclick = closeValueModal;
  back.onclick = (e) => {
    if (e.target === back) closeValueModal();
  };
  back.addEventListener('pointerdown', (e) => e.stopPropagation());
  shadow.appendChild(back);
  modalHost = back;
  close.focus();
  return back;
}

/** Closes the value overlay. Returns true when one was open (Escape closes it before anything else). */
export function closeValueModal() {
  if (!modalHost) return false;
  modalHost.remove();
  modalHost = null;
  return true;
}

export { hasOwn };
