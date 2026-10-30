const STYLE_ID = 'sourcepeek-live-styles';
const STORAGE_KEY = 'sourcepeek:style-changes';
const MAX_LINES = 450;
const MAX_CHARS = 24000;

const SEMANTIC = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'button', 'input', 'select', 'textarea', 'label', 'img', 'svg',
  'section', 'header', 'footer', 'nav', 'main', 'article', 'aside', 'form', 'ul', 'ol', 'li', 'table', 'figure', 'video',
]);
const TEXTY = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'button', 'label', 'li', 'span', 'strong', 'em', 'small']);
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'link', 'meta', 'sourcepeek-root']);
const OPAQUE = new Set(['svg', 'select', 'video', 'canvas', 'iframe', 'picture']);

const esc = (s) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&'));

function stableClasses(n) {
  const list = Array.from(n.classList || []);
  // styled-components adds a stable "sc-xxxx" component id plus a hash class that changes whenever its CSS
  // changes; emotion adds "css-<hash>". Those hashes would break the preview after the next hot reload.
  const styled = list.some((c) => /^sc-/.test(c));
  return list.filter(
    (c) =>
      /^[A-Za-z_][\w-]*$/.test(c) &&
      c.length <= 40 &&
      !/^svelte-/.test(c) &&
      !/^ng-(tns-|star-inserted|trigger|animating|untouched|touched|pristine|dirty|valid|invalid|pending)/.test(c) &&
      !/^css-[a-z0-9]{4,}(-[\w]+)?$/.test(c) &&
      !(styled && !/^sc-/.test(c) && /^[A-Za-z]{5,8}$/.test(c) && /[a-z]/.test(c) && /[A-Z]/.test(c))
  );
}

function isUnique(sel) {
  try {
    return document.querySelectorAll(sel).length === 1;
  } catch {
    return false;
  }
}

export function uniqueSelector(node) {
  if (!node || node.nodeType !== 1) return null;
  const parts = [];
  let n = node;
  while (n && n.nodeType === 1 && n !== document.documentElement) {
    if (n === document.body) {
      parts.unshift('body');
      break;
    }
    const tag = n.tagName.toLowerCase();
    if (n.id && /^[A-Za-z][\w-]*$/.test(n.id) && isUnique('#' + n.id)) {
      parts.unshift('#' + n.id);
      break;
    }
    let part = tag + stableClasses(n).slice(0, 3).map((c) => '.' + esc(c)).join('');
    if (isUnique([part, ...parts].join(' > '))) return [part, ...parts].join(' > ');
    const parent = n.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === n.tagName);
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(n) + 1})`;
    }
    parts.unshift(part);
    if (isUnique(parts.join(' > '))) return parts.join(' > ');
    n = parent;
  }
  return parts.join(' > ');
}

function visible(n) {
  return n.getClientRects().length > 0;
}

function ownText(n, tag) {
  if (!TEXTY.has(tag) && n.children.length) return '';
  const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
  return t ? (t.length > 50 ? t.slice(0, 50) + '…' : t) : '';
}

function styleHints(n, tag, isSelected) {
  const cs = getComputedStyle(n);
  const out = [];
  if (cs.display === 'flex' || cs.display === 'inline-flex' || cs.display === 'grid' || cs.display === 'inline-grid') {
    out.push(`display:${cs.display}`);
    if (cs.display.includes('flex')) out.push(`flex-direction:${cs.flexDirection}`);
  }
  if (TEXTY.has(tag) || isSelected) {
    out.push(`font-size:${cs.fontSize}`, `color:${cs.color}`);
    if (Number(cs.fontWeight) >= 600) out.push(`font-weight:${cs.fontWeight}`);
  }
  if ((tag === 'button' || tag === 'a' || isSelected) && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') {
    out.push(`background:${cs.backgroundColor}`);
  }
  return out.length ? ` {${out.join('; ')}}` : '';
}

export function buildOutline(selectedEl) {
  const lines = [];
  let chars = 0;
  const selectedChain = new Set();
  for (let a = selectedEl; a; a = a.parentElement) selectedChain.add(a);

  const visit = (node, depth) => {
    if (lines.length >= MAX_LINES || chars >= MAX_CHARS) return;
    const tag = node.tagName.toLowerCase();
    if (SKIP.has(tag) || !visible(node)) return;
    const isSelected = node === selectedEl;
    const include =
      isSelected ||
      SEMANTIC.has(tag) ||
      node.id ||
      stableClasses(node).length > 0 ||
      (node.dataset && node.dataset.mfComp) ||
      node.children.length >= 2 ||
      selectedChain.has(node);
    let childDepth = depth;
    if (include) {
      const comp = node.dataset && node.dataset.mfComp ? ` <${node.dataset.mfComp}>` : '';
      const text = ownText(node, tag);
      const line =
        '  '.repeat(depth) +
        `[${uniqueSelector(node)}] ${tag}${comp}${text ? ` "${text}"` : ''}${styleHints(node, tag, isSelected)}${isSelected ? ' ★' : ''}`;
      lines.push(line);
      chars += line.length + 1;
      childDepth = depth + 1;
    }
    if (OPAQUE.has(tag)) return;
    for (const c of node.children) visit(c, childDepth);
  };
  if (document.body) visit(document.body, 0);
  if (lines.length >= MAX_LINES || chars >= MAX_CHARS) lines.push('…(outline truncated)');
  return `Viewport: ${window.innerWidth}x${window.innerHeight}\n` + lines.join('\n');
}

export function prepareCss(css) {
  let sheet;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
  } catch {
    return { preview: css, ruleCount: -1, selectors: [] };
  }
  const selectors = [];
  const walk = (rules) => {
    for (const r of rules) {
      if (typeof CSSKeyframesRule !== 'undefined' && r instanceof CSSKeyframesRule) continue;
      if (r.selectorText) selectors.push(r.selectorText);
      if (r.style) {
        const props = Array.from({ length: r.style.length }, (_, i) => r.style[i]);
        for (const p of props) r.style.setProperty(p, r.style.getPropertyValue(p), 'important');
      }
      if (r.cssRules) walk(r.cssRules);
    }
  };
  walk(sheet.cssRules);
  return { preview: Array.from(sheet.cssRules, (r) => r.cssText).join('\n'), ruleCount: sheet.cssRules.length, selectors };
}

export function countMatches(selectors) {
  const hit = new Set();
  for (const s of selectors) {
    const clean = s.replace(
      /::?(before|after|hover|focus-visible|focus-within|focus|active|visited|placeholder|marker|selection|first-letter|first-line)\b/g,
      ''
    );
    try {
      document.querySelectorAll(clean).forEach((n) => hit.add(n));
    } catch {}
  }
  return hit.size;
}

// Change with AI never adds comments to CSS. Removes /* … */ outside strings (a safety net — the server already strips them).
function stripCssComments(css) {
  const s = String(css || '');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      for (; j < s.length && s[j] !== c && s[j] !== '\n'; j++) if (s[j] === '\\') j++;
      out += s.slice(i, j + 1);
      i = j;
    } else if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end === -1 ? s.length : end + 1;
    } else out += c;
  }
  return out.replace(/^[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
}

export function injectChanges(list) {
  let tag = document.getElementById(STYLE_ID);
  if (!list.length) {
    if (tag) tag.remove();
    return;
  }
  if (!tag) {
    tag = document.createElement('style');
    tag.id = STYLE_ID;
    tag.setAttribute('data-sourcepeek', 'live-preview');
  }
  (document.head || document.documentElement).appendChild(tag);
  tag.textContent = list.map((c) => stripCssComments(prepareCss(c.css).preview)).join('\n\n');
}

export function removeInjected() {
  const tag = document.getElementById(STYLE_ID);
  if (tag) tag.remove();
}

export function exportCss(list) {
  return list.map((c) => stripCssComments(c.css).trim()).join('\n\n');
}

export function loadChanges() {
  try {
    const v = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(v) ? v.filter((c) => c && typeof c.css === 'string') : [];
  } catch {
    return [];
  }
}

export function saveChanges(list) {
  try {
    if (list.length) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {}
}
