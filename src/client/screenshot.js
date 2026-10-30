// Screenshot of the visible part of the page, with one element outlined — no dependencies, no permission prompt.
//
// How: the page is copied into an SVG <foreignObject> with every element's computed style inlined, images,
// background images and web fonts embedded as data URLs, then the SVG is drawn onto a canvas. Fixed and sticky
// elements are placed where they are on screen, scrolled containers keep their scroll position.
// Limits: cross-origin iframes and images without CORS show as grey boxes. `captureScreen()` is the
// pixel-perfect alternative (browser screen-share prompt).

import { nativeFetch } from './network.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'HEAD', 'BASE', 'SOURCEPEEK-ROOT']);
const SKIP_PROP = /^(--|transition|animation|will-change|cursor|pointer-events|user-select|-webkit-user-select|caret-color|content-visibility|contain-intrinsic|view-transition|anchor-name|position-anchor)/;
const SKIP_ATTR = /^(on|style$|srcset$|src$|loading$|decoding$|fetchpriority$|sizes$)/i;
const BAD_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
const URL_RE = /url\(\s*(['"]?)((?!data:|#|about:)[^'")]+)\1\s*\)/g;
const MAX_RESOURCES = 80;
const MAX_RESOURCE_BYTES = 4 * 1024 * 1024;
const MAX_FONT_BYTES = 3 * 1024 * 1024;
const TIME_BUDGET = 9000;

let PROPS = null;
let SKIP_IDX = null;

function propList() {
  if (PROPS) return PROPS;
  const cs = getComputedStyle(document.documentElement);
  const all = [];
  for (let i = 0; i < cs.length; i++) if (!cs[i].startsWith('--')) all.push(cs[i]);
  PROPS = all;
  SKIP_IDX = all.map((p) => SKIP_PROP.test(p));
  return PROPS;
}

/** Browser-default computed values per tag, from a blank iframe inside Sourcepeek's shadow root. */
function defaultsFactory(mount) {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.tabIndex = -1;
  iframe.style.cssText = 'position:fixed;left:-20000px;top:0;width:200px;height:200px;border:0;visibility:hidden;pointer-events:none;';
  (mount || document.documentElement).appendChild(iframe);
  const doc = iframe.contentDocument;
  doc.open();
  doc.write('<!DOCTYPE html><html><head></head><body></body></html>');
  doc.close();
  const svgHost = doc.createElementNS(SVG_NS, 'svg');
  doc.body.appendChild(svgHost);
  const cache = new Map();
  const props = propList();
  const read = (cs) => props.map((p) => cs.getPropertyValue(p));
  return {
    get(isSvg, tag) {
      const key = (isSvg ? 'svg:' : '') + tag;
      let v = cache.get(key);
      if (v) return v;
      let e;
      if (isSvg) {
        e = doc.createElementNS(SVG_NS, tag);
        (tag === 'svg' ? doc.body : svgHost).appendChild(e);
      } else {
        e = doc.createElement(/^(html|body)$/.test(tag) ? 'div' : tag);
        doc.body.appendChild(e);
      }
      v = read(doc.defaultView.getComputedStyle(e));
      e.remove();
      cache.set(key, v);
      return v;
    },
    pseudo() {
      let v = cache.get('::before');
      if (v) return v;
      const e = doc.createElement('span');
      doc.body.appendChild(e);
      v = read(doc.defaultView.getComputedStyle(e, '::before'));
      e.remove();
      cache.set('::before', v);
      return v;
    },
    dispose() {
      iframe.remove();
    },
  };
}

/** Inline style text: every property that differs from the browser default or from what the parent passes down. */
function styleText(cs, def, parentVals) {
  const props = PROPS;
  const vals = new Array(props.length);
  let out = '';
  for (let i = 0; i < props.length; i++) {
    const v = cs.getPropertyValue(props[i]);
    vals[i] = v;
    if (SKIP_IDX[i]) continue;
    if (v === def[i] && (!parentVals || v === parentVals[i])) continue;
    out += `${props[i]}:${v};`;
  }
  return { text: out, vals };
}

const intersects = (r, vw, vh) => r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;

function copyAttrs(from, to, isSvg) {
  for (const a of from.attributes) {
    if (!isSvg && SKIP_ATTR.test(a.name)) continue;
    if (isSvg && /^(on|style$)/i.test(a.name)) continue;
    try {
      if (a.namespaceURI) to.setAttributeNS(a.namespaceURI, a.name, a.value);
      else to.setAttribute(a.name, a.value);
    } catch {}
  }
}

function addFonts(ctx, cs) {
  const fam = cs.getPropertyValue('font-family');
  if (!fam) return;
  const weight = cs.getPropertyValue('font-weight');
  const style = cs.getPropertyValue('font-style');
  for (const f of fam.split(',')) {
    const name = f.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
    if (name) ctx.fonts.add(`${name}|${weight}|${style}`);
  }
}

function childList(node) {
  if (node.shadowRoot) return node.shadowRoot.childNodes;
  if (node.localName === 'slot' && typeof node.assignedNodes === 'function') {
    const assigned = node.assignedNodes({ flatten: true });
    if (assigned.length) return assigned;
  }
  return node.childNodes;
}

function cloneNode(node, ctx, parentVals, parentCs) {
  if (node.nodeType === 3) {
    const t = node.data;
    if (ctx.chars.size < 4000) for (const ch of t) ctx.chars.add(ch.codePointAt(0));
    if (parentCs && t.trim()) addFonts(ctx, parentCs);
    return ctx.fac.createTextNode(t);
  }
  if (node.nodeType !== 1) return null;
  if (node === ctx.exclude) return null;
  const isSvg = node.namespaceURI === SVG_NS;
  if (!isSvg && SKIP_TAGS.has(node.tagName)) return null;
  if (performance.now() > ctx.deadline) throw new Error('This page is too large to render in time — use “Capture screen”.');

  const cs = getComputedStyle(node);
  if (cs.display === 'none') return null;
  const tag = node.localName;
  const rect = node.getBoundingClientRect();
  const pos = cs.position;
  const { vw, vh, sx, sy, fac } = ctx;
  ctx.count++;

  // Fixed / sticky: draw them where they are on screen, on top of everything, positioned in page coordinates.
  if ((pos === 'fixed' || (pos === 'sticky' && intersects(rect, vw, vh))) && !ctx.relocating) {
    if (!intersects(rect, vw, vh)) return null;
    ctx.relocating = true;
    let moved;
    try {
      moved = cloneNode(node, ctx, ctx.rootVals, ctx.rootCs);
    } finally {
      ctx.relocating = false;
    }
    if (moved) {
      moved.setAttribute(
        'style',
        (moved.getAttribute('style') || '') +
          `position:absolute;left:${rect.left + sx}px;top:${rect.top + sy}px;right:auto;bottom:auto;width:${rect.width}px;height:${rect.height}px;margin:0;box-sizing:border-box;transform:none;translate:none;scale:none;`
      );
      ctx.layer.push({ el: moved, z: parseInt(cs.zIndex, 10) || 0, order: ctx.layer.length });
    }
    if (pos === 'fixed') return null;
    // A sticky element still takes up its place in the flow.
    const phTag = /^(html|body)$/.test(tag) ? 'div' : tag;
    const ph = fac.createElement(phTag);
    ph.setAttribute('style', styleText(cs, ctx.defs.get(false, phTag), parentVals).text + 'visibility:hidden;');
    return ph;
  }
  const relocatingRoot = ctx.relocating === true;
  if (relocatingRoot) ctx.relocating = 'inside';

  let out;
  const def = ctx.defs.get(isSvg, isSvg ? tag : /^(html|body)$/.test(tag) ? 'div' : tag);
  const { text, vals } = styleText(cs, def, parentVals);
  let css = text;
  const visible = intersects(rect, vw, vh);

  if (isSvg) {
    out = fac.createElementNS(SVG_NS, tag);
    copyAttrs(node, out, true);
    if (tag === 'use') {
      const ref = node.getAttribute('href') || node.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      if (ref && ref[0] === '#') ctx.ids.add(ref.slice(1));
    }
  } else if (tag === 'canvas' || tag === 'video') {
    out = fac.createElement('img');
    copyAttrs(node, out, false);
    try {
      if (tag === 'canvas') out.setAttribute('src', node.toDataURL());
      else {
        const c = document.createElement('canvas');
        c.width = node.videoWidth || rect.width;
        c.height = node.videoHeight || rect.height;
        c.getContext('2d').drawImage(node, 0, 0, c.width, c.height);
        out.setAttribute('src', c.toDataURL('image/jpeg', 0.85));
      }
    } catch {
      if (tag === 'video' && node.poster) ctx.imgs.push({ el: out, src: node.poster });
      else css += 'background:#d1d5db;';
    }
    css += 'object-fit:contain;';
  } else if (tag === 'iframe' || tag === 'embed' || tag === 'object') {
    out = fac.createElement('div');
    css += 'background:#e5e7eb;display:flex;align-items:center;justify-content:center;color:#6b7280;font:12px sans-serif;';
    out.textContent = tag;
    out.setAttribute('style', css);
    return out;
  } else {
    out = fac.createElement(/^(html|body)$/.test(tag) ? 'div' : tag);
    copyAttrs(node, out, false);
    if (tag === 'img') {
      const src = node.currentSrc || node.src;
      if (src && visible) ctx.imgs.push({ el: out, src });
    } else if (tag === 'input') {
      const type = (node.type || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        if (node.checked) out.setAttribute('checked', '');
        else out.removeAttribute('checked');
      } else if (type === 'password') out.setAttribute('value', '•'.repeat(Math.min(String(node.value).length, 24)));
      else if (type !== 'file') out.setAttribute('value', node.value);
    } else if (tag === 'option') {
      if (node.selected) out.setAttribute('selected', '');
      else out.removeAttribute('selected');
    }
  }

  // Far outside the screen: keep the box (so the layout holds) but skip its content.
  const far = rect.bottom < -vh || rect.top > 2 * vh || rect.right < -vw || rect.left > 2 * vw;
  const prunable = far && !isSvg && !/^(inline|contents)$/.test(cs.display) && rect.height > 0;

  // ::before / ::after
  if (!isSvg && !prunable && tag !== 'img' && tag !== 'input') {
    for (const p of ['::before', '::after']) {
      const pcs = getComputedStyle(node, p);
      const c = pcs.getPropertyValue('content');
      if (!c || c === 'none' || c === 'normal') continue;
      const cls = `mfp${++ctx.pseudoN}`;
      const st = styleText(pcs, ctx.defs.pseudo(), vals).text;
      ctx.pseudo.push(`.${cls}${p}{${st}content:${c};}`);
      if (/url\(/.test(st)) ctx.pseudoUrls = true;
      out.setAttribute('class', ((out.getAttribute('class') || '') + ' ' + cls).trim());
    }
  }

  const scrolled = !isSvg && (node.scrollTop || node.scrollLeft) && node !== document.body && node !== document.documentElement;
  if (!isSvg && /(auto|scroll)/.test(cs.overflowX + cs.overflowY)) css += 'overflow:hidden;';
  if (css.includes('url(') && visible) ctx.urlEls.push(out);
  out.setAttribute('style', css);

  if (tag === 'textarea') out.textContent = node.value;
  else if (!prunable) {
    for (const child of childList(node)) {
      const c = cloneNode(child, ctx, vals, cs);
      if (c) out.appendChild(c);
    }
  }
  if (scrolled) {
    for (const c of out.children) {
      const t = c.style.getPropertyValue('transform');
      c.style.setProperty('transform', `translate(${-node.scrollLeft}px, ${-node.scrollTop}px)${t && t !== 'none' ? ' ' + t : ''}`);
    }
  }
  if (relocatingRoot) ctx.relocating = true;
  return out;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

function fetcher(ctx) {
  const cache = new Map();
  return (url, maxBytes = MAX_RESOURCE_BYTES) => {
    if (cache.has(url)) return cache.get(url);
    if (cache.size >= MAX_RESOURCES) return Promise.resolve(null);
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctrl && ctrl.abort(), 4000);
    const p = nativeFetch(url, { cache: 'force-cache', credentials: 'same-origin', signal: ctrl && ctrl.signal })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => (b && b.size <= maxBytes ? blobToDataUrl(b) : null))
      .catch(() => null)
      .finally(() => clearTimeout(timer));
    cache.set(url, p);
    return p;
  };
}

async function inlineUrls(text, get, base) {
  const found = new Set();
  text.replace(URL_RE, (m, q, u) => found.add(u));
  if (!found.size) return text;
  const map = new Map();
  await Promise.all(
    [...found].map(async (u) => {
      let abs = u;
      try {
        abs = new URL(u, base || location.href).href;
      } catch {}
      map.set(u, await get(abs));
    })
  );
  return text.replace(URL_RE, (m, q, u) => (map.get(u) ? `url("${map.get(u)}")` : 'none'));
}

// ---------- web fonts ----------

function parseRanges(s) {
  if (!s) return null;
  const out = [];
  for (const part of s.split(',')) {
    const m = part.trim().match(/^U\+([0-9a-f?]+)(?:-([0-9a-f]+))?$/i);
    if (!m) continue;
    if (m[1].includes('?')) out.push([parseInt(m[1].replace(/\?/g, '0'), 16), parseInt(m[1].replace(/\?/g, 'f'), 16)]);
    else out.push([parseInt(m[1], 16), parseInt(m[2] || m[1], 16)]);
  }
  return out.length ? out : null;
}

function weightMatches(spec, weight) {
  if (!spec || spec === 'normal' && weight === '400' || spec === 'bold' && weight === '700') return true;
  const nums = String(spec).match(/\d+/g);
  if (!nums) return true;
  const w = Number(weight) || 400;
  if (nums.length >= 2) return w >= Number(nums[0]) && w <= Number(nums[1]);
  return Math.abs(Number(nums[0]) - w) <= 100;
}

async function sheetTexts() {
  const out = [];
  for (const sheet of [...document.styleSheets]) {
    try {
      const rules = sheet.cssRules;
      const faces = [];
      const walk = (list) => {
        for (const r of list) {
          if (r.type === 5) faces.push(r.cssText); // CSSFontFaceRule
          else if (r.cssRules) walk(r.cssRules);
        }
      };
      walk(rules);
      if (faces.length) out.push({ text: faces.join('\n'), base: sheet.href || location.href });
    } catch {
      // cross-origin stylesheet (e.g. Google Fonts): read it ourselves
      if (sheet.href) {
        try {
          const r = await nativeFetch(sheet.href, { cache: 'force-cache' });
          if (r.ok) out.push({ text: await r.text(), base: sheet.href });
        } catch {}
      }
    }
  }
  return out;
}

async function fontCss(ctx, get) {
  if (!ctx.fonts.size) return '';
  const used = [...ctx.fonts].map((k) => k.split('|'));
  const families = new Set(used.map((u) => u[0]));
  const chars = [...ctx.chars];
  let budget = MAX_FONT_BYTES;
  const blocks = [];
  for (const { text, base } of await sheetTexts()) {
    for (const block of text.match(/@font-face\s*{[^}]*}/g) || []) {
      const fam = (block.match(/font-family:\s*([^;]+);/) || [])[1];
      const name = fam && fam.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
      if (!name || !families.has(name)) continue;
      const weight = (block.match(/font-weight:\s*([^;]+);/) || [])[1];
      const style = ((block.match(/font-style:\s*([^;]+);/) || [])[1] || 'normal').trim();
      if (!used.some(([f, w, s]) => f === name && weightMatches(weight && weight.trim(), w) && (style === 'normal' ? !/italic|oblique/.test(s) : /italic|oblique/.test(s)))) continue;
      const ranges = parseRanges((block.match(/unicode-range:\s*([^;]+);/) || [])[1]);
      if (ranges && !chars.some((c) => ranges.some(([a, b]) => c >= a && c <= b))) continue;
      blocks.push({ block, base });
    }
  }
  const out = [];
  for (const { block, base } of blocks.slice(0, 24)) {
    const src = (block.match(/src:\s*([^;]+);/) || [])[1];
    if (!src) continue;
    const first = src.match(/url\(\s*(['"]?)([^'")]+)\1\s*\)\s*(format\([^)]*\))?/);
    if (!first) continue;
    let abs = first[2];
    try {
      abs = new URL(first[2], base).href;
    } catch {}
    if (abs.startsWith('data:')) {
      out.push(block);
      continue;
    }
    const data = await get(abs, Math.min(budget, MAX_RESOURCE_BYTES));
    if (!data) continue;
    budget -= data.length * 0.75;
    out.push(block.replace(/src:\s*[^;]+;/, `src:url("${data}")${first[3] ? ' ' + first[3] : ''};`));
    if (budget <= 0) break;
  }
  return out.join('\n');
}

// ---------- drawing ----------

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The browser could not render the page snapshot — use “Capture screen”.'));
    img.src = src;
  });
}

function canvasScale(w, h) {
  let s = Math.min(window.devicePixelRatio || 1, 2);
  while (s > 0.5 && w * h * s * s > 16e6) s -= 0.25;
  return s;
}

/** Outline the element on the screenshot. `r` is in CSS pixels of the captured viewport. */
export function drawHighlight(g, r, label, scale, vw, vh) {
  if (!r || r.width <= 0 || r.height <= 0) return;
  const x = Math.max(r.left, 0);
  const y = Math.max(r.top, 0);
  const w = Math.min(r.right, vw) - x;
  const h = Math.min(r.bottom, vh) - y;
  if (w <= 0 || h <= 0) return;
  g.save();
  g.scale(scale, scale);
  // Tint small elements; a big one (a whole section) only gets the outline, so the page stays readable.
  if (w * h < vw * vh * 0.35) {
    g.fillStyle = 'rgba(239,68,68,0.12)';
    g.fillRect(x, y, w, h);
  }
  g.lineWidth = 3;
  g.strokeStyle = '#ef4444';
  g.strokeRect(x - 1.5, y - 1.5, w + 3, h + 3);
  if (label) {
    g.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    const tw = g.measureText(label).width + 12;
    const ly = y - 22 >= 0 ? y - 22 : Math.min(y + h + 4, vh - 20);
    const lx = Math.min(Math.max(x - 1.5, 0), Math.max(vw - tw, 0));
    g.fillStyle = '#ef4444';
    g.fillRect(lx, ly, tw, 20);
    g.fillStyle = '#fff';
    g.textBaseline = 'middle';
    g.fillText(label, lx + 6, ly + 10);
  }
  g.restore();
}

function toBlob(canvas) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the screenshot'))), 'image/png');
    } catch (e) {
      reject(new Error('This browser blocks reading the rendered snapshot — use “Capture screen”.'));
    }
  });
}

/**
 * Screenshot of the current viewport. opts: { target, label, exclude, mount }
 * → { blob, width, height, method: 'dom', ms, elements }
 */
export async function captureDom({ target, label, exclude, mount } = {}) {
  const t0 = performance.now();
  propList();
  const de = document.documentElement;
  const vw = de.clientWidth || innerWidth;
  const vh = de.clientHeight || innerHeight;
  const sx = window.scrollX;
  const sy = window.scrollY;
  const docW = Math.max(de.scrollWidth, document.body.scrollWidth, vw);
  const docH = Math.max(de.scrollHeight, document.body.scrollHeight, vh);
  const fac = document.implementation.createHTMLDocument('');
  const defs = defaultsFactory(mount);
  const ctx = {
    fac, defs, vw, vh, sx, sy, exclude,
    pseudo: [], pseudoN: 0, layer: [], urlEls: [], imgs: [], ids: new Set(), chars: new Set(), fonts: new Set(),
    count: 0, deadline: t0 + TIME_BUDGET, relocating: false,
  };
  const targetRect = target && target.isConnected ? target.getBoundingClientRect() : null;
  let svg;
  try {
    const htmlCs = getComputedStyle(de);
    const bodyCs = getComputedStyle(document.body);
    const root = fac.createElement('div');
    const rootStyle = styleText(htmlCs, defs.get(false, 'div'), null);
    ctx.rootVals = rootStyle.vals;
    ctx.rootCs = htmlCs;
    let bg = '';
    const transparent = (c) => !c || c === 'transparent' || /rgba\(.*,\s*0\)$/.test(c);
    if (transparent(htmlCs.backgroundColor) && htmlCs.backgroundImage === 'none') {
      bg = `background-color:${transparent(bodyCs.backgroundColor) ? '#fff' : bodyCs.backgroundColor};background-image:${bodyCs.backgroundImage};`;
    }
    root.setAttribute(
      'style',
      rootStyle.text + bg + `position:relative;margin:0;padding:0;border:0;overflow:hidden;width:${docW}px;height:${docH}px;min-height:0;max-height:none;transform:translate(${-sx}px,${-sy}px);transform-origin:0 0;`
    );
    if (bg.includes('url(')) ctx.urlEls.push(root);
    const styleEl = fac.createElement('style');
    root.appendChild(styleEl);
    const body = cloneNode(document.body, ctx, rootStyle.vals, htmlCs);
    if (body) root.appendChild(body);
    ctx.layer.sort((a, b) => a.z - b.z || a.order - b.order).forEach((l) => root.appendChild(l.el));

    // SVG sprites / gradients referenced by id that live in a hidden <svg> elsewhere on the page.
    const missing = [...ctx.ids].filter((id) => !root.querySelector(`[id="${CSS.escape(id)}"]`));
    if (missing.length) {
      const holder = fac.createElementNS(SVG_NS, 'svg');
      holder.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden;');
      const d = fac.createElementNS(SVG_NS, 'defs');
      for (const id of missing) {
        const src = document.getElementById(id);
        if (src) d.appendChild(fac.importNode(src, true));
      }
      holder.appendChild(d);
      root.appendChild(holder);
    }

    const get = fetcher(ctx);
    await Promise.all([
      ...ctx.imgs.map(async ({ el, src }) => {
        const data = await get(src);
        if (data) el.setAttribute('src', data);
        else el.setAttribute('style', (el.getAttribute('style') || '') + 'background:#e5e7eb;');
      }),
      ...ctx.urlEls.map(async (el) => el.setAttribute('style', await inlineUrls(el.getAttribute('style') || '', get))),
    ]);
    let pseudoCss = ctx.pseudo.join('\n');
    if (ctx.pseudoUrls) pseudoCss = await inlineUrls(pseudoCss, get);
    const fonts = await fontCss(ctx, get).catch(() => '');
    styleEl.textContent = fonts + '\n' + pseudoCss;

    const xhtml = new XMLSerializer().serializeToString(root).replace(BAD_XML, '');
    svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${vw}" height="${vh}" viewBox="0 0 ${vw} ${vh}"><foreignObject x="0" y="0" width="100%" height="100%">${xhtml}</foreignObject></svg>`;
  } finally {
    defs.dispose();
  }

  const img = await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
  if (img.decode) await img.decode().catch(() => {});
  await new Promise((r) => requestAnimationFrame(() => r()));
  const scale = canvasScale(vw, vh);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vw * scale);
  canvas.height = Math.round(vh * scale);
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  drawHighlight(g, targetRect, label, scale, vw, vh);
  const blob = await toBlob(canvas);
  return { blob, width: canvas.width, height: canvas.height, method: 'dom', ms: Math.round(performance.now() - t0), elements: ctx.count };
}

/**
 * Pixel-perfect screenshot through the browser's screen-share prompt (pick “This tab”).
 * Must be called straight from a click. opts: { target, label, hide: element to hide while capturing }
 */
export async function captureScreen({ target, label, hide } = {}) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) throw new Error('Screen capture is not available in this browser.');
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'browser', frameRate: 5 },
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
  });
  const prev = hide ? hide.style.visibility : '';
  try {
    if (hide) hide.style.visibility = 'hidden';
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    // Let the prompt disappear and our panel hide before grabbing the frame.
    await new Promise((r) => setTimeout(r, 350));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const w = video.videoWidth;
    const h = video.videoHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d');
    g.drawImage(video, 0, 0, w, h);
    const vw = document.documentElement.clientWidth || innerWidth;
    const vh = document.documentElement.clientHeight || innerHeight;
    const scale = w / innerWidth;
    if (target && target.isConnected) drawHighlight(g, target.getBoundingClientRect(), label, scale, vw, vh);
    const blob = await toBlob(canvas);
    return { blob, width: w, height: h, method: 'screen' };
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    if (hide) hide.style.visibility = prev;
  }
}
