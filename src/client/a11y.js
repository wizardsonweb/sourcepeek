// "Accessibility": checks the clicked element and its component (with the components it renders).
// Every finding points at the file and line that wrote the element, and "Fix with AI" sends it to Change with AI
// with that location — the part a page-level audit can't do.
//
// Checks: images without alt text, buttons and links with no name, form fields without a label, colour contrast
// (WCAG AA), skipped heading levels and empty headings, and click handlers that can't be reached with the keyboard.
// Automated checks find only part of the problems; a keyboard and a screen reader find the rest.

import { el, locate, resolveHit, openSource, fileLine, flashElement } from './core.js';
import { ngApi } from './angular.js';

const MAX_ELEMENTS = 2500;
const MAX_FINDINGS = 60;

// ---------- helpers ----------

function visible(n) {
  if (!n || n.nodeType !== 1 || !n.isConnected) return false;
  if (typeof n.checkVisibility === 'function') {
    try {
      return n.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
    } catch {}
  }
  const cs = getComputedStyle(n);
  return cs.display !== 'none' && cs.visibility !== 'hidden' && n.getClientRects().length > 0;
}

function ariaHidden(n) {
  for (let a = n; a && a.nodeType === 1; a = a.parentElement) if (a.getAttribute('aria-hidden') === 'true') return true;
  return false;
}

const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();

function byIds(ids) {
  return clean(
    String(ids)
      .split(/\s+/)
      .map((id) => {
        const r = id && document.getElementById(id);
        return r ? r.textContent : '';
      })
      .join(' ')
  );
}

/** Text a screen reader would announce from the element's content. */
function contentName(n, depth = 0) {
  if (depth > 20) return '';
  let out = '';
  for (const c of n.childNodes) {
    if (c.nodeType === 3) out += ' ' + c.textContent;
    else if (c.nodeType === 1) {
      if (c.getAttribute('aria-hidden') === 'true') continue;
      const tag = c.tagName;
      if (tag === 'IMG' || (tag === 'INPUT' && c.type === 'image')) out += ' ' + (c.getAttribute('alt') || '');
      else if (c.getAttribute('aria-label')) out += ' ' + c.getAttribute('aria-label');
      else if (c.getAttribute('aria-labelledby')) out += ' ' + byIds(c.getAttribute('aria-labelledby'));
      else if (tag === 'svg' || tag === 'SVG') {
        const t = c.querySelector('title');
        out += ' ' + (t ? t.textContent : '');
      } else if (tag !== 'STYLE' && tag !== 'SCRIPT' && tag !== 'TEMPLATE') {
        const cs = getComputedStyle(c);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        out += ' ' + contentName(c, depth + 1);
      }
    }
  }
  return clean(out);
}

/** A practical subset of the accessible-name computation. */
function accName(n) {
  const lb = n.getAttribute('aria-labelledby');
  if (lb) {
    const t = byIds(lb);
    if (t) return t;
  }
  const al = clean(n.getAttribute('aria-label'));
  if (al) return al;
  const tag = n.tagName;
  if (tag === 'IMG' || tag === 'AREA' || (tag === 'INPUT' && n.type === 'image')) return clean(n.getAttribute('alt'));
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
    if (tag === 'INPUT' && /^(submit|reset|button)$/.test(n.type)) return clean(n.value || (n.type === 'submit' ? 'Submit' : n.type === 'reset' ? 'Reset' : ''));
    const labels = n.labels ? Array.from(n.labels).map((l) => contentName(l)).join(' ') : '';
    if (clean(labels)) return clean(labels);
    return clean(n.getAttribute('title'));
  }
  const text = contentName(n);
  if (text) return text;
  return clean(n.getAttribute('title'));
}

function startTag(n) {
  const parts = [n.tagName.toLowerCase()];
  for (const a of Array.from(n.attributes)) {
    if (/^(data-mf-|_ngcontent|_nghost|ng-reflect)/.test(a.name) || a.name === 'style') continue;
    let v = a.value;
    if (a.name === 'class') v = v.split(/\s+/).filter(Boolean).slice(0, 3).join(' ') + (v.split(/\s+/).filter(Boolean).length > 3 ? ' …' : '');
    if (v.length > 50) v = v.slice(0, 48) + '…';
    parts.push(v === '' ? a.name : `${a.name}="${v}"`);
    if (parts.length > 5) break;
  }
  return `<${parts.join(' ')}>`;
}

const NATIVE_FOCUS = /^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY|IFRAME)$/;

function focusable(n) {
  if (n.hasAttribute('tabindex')) return true;
  if (n.isContentEditable) return true;
  if (!NATIVE_FOCUS.test(n.tagName)) return (n.tagName === 'AUDIO' || n.tagName === 'VIDEO') && n.hasAttribute('controls');
  if (n.tagName === 'A') return n.hasAttribute('href');
  return !n.disabled;
}

function hasClickHandler(n) {
  try {
    if (typeof n.onclick === 'function' || n.hasAttribute('onclick')) return true;
    for (const k in n) {
      if (k.startsWith('__reactProps$')) {
        const p = n[k];
        if (p && (p.onClick || p.onMouseDown || p.onPointerDown || p.onMouseUp)) return true;
      }
    }
    // Vue keeps its event invokers on `_vei` (a Symbol('_vei') since 3.4).
    let vei = n._vei;
    if (!vei) {
      const sym = Object.getOwnPropertySymbols(n).find((x) => x.description === '_vei');
      if (sym) vei = n[sym];
    }
    if (vei && (vei.onClick || vei.onMousedown || vei.onPointerdown)) return true;
    if (typeof n.__click === 'function' || Array.isArray(n.__click)) return true; // Svelte 5 delegated events
    const ng = ngApi();
    if (ng && typeof ng.getListeners === 'function') {
      const ls = ng.getListeners(n) || [];
      if (ls.some((l) => l.name === 'click' && l.type !== 'output')) return true;
    }
  } catch {}
  return false;
}

// ---------- colour contrast ----------

function parseColor(str) {
  const m = String(str).match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
  if (p.length < 3 || p.some((x) => Number.isNaN(x))) return null;
  return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
}

const over = (top, bottom) => {
  const a = top.a + bottom.a * (1 - top.a);
  if (!a) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (k) => (top[k] * top.a + bottom[k] * bottom.a * (1 - top.a)) / a;
  return { r: mix('r'), g: mix('g'), b: mix('b'), a };
};

function luminance({ r, g, b }) {
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

const hex = ({ r, g, b }) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/** The solid colour behind an element, or null when an image or gradient is in the way. */
function backgroundOf(n) {
  const layers = [];
  for (let a = n; a && a.nodeType === 1; a = a.parentElement) {
    const cs = getComputedStyle(a);
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
    const c = parseColor(cs.backgroundColor);
    if (c && c.a > 0) {
      layers.push(c);
      if (c.a >= 1) break;
    }
  }
  let bg = { r: 255, g: 255, b: 255, a: 1 }; // the canvas
  for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
  return bg;
}

function contrastOf(n) {
  const cs = getComputedStyle(n);
  let fg = parseColor(cs.color);
  if (!fg) return null;
  const bg = backgroundOf(n);
  if (!bg) return null;
  let opacity = 1;
  for (let a = n; a && a.nodeType === 1; a = a.parentElement) opacity *= parseFloat(getComputedStyle(a).opacity) || 1;
  fg = over({ ...fg, a: fg.a * opacity }, bg);
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  const size = parseFloat(cs.fontSize) || 16;
  const bold = (parseInt(cs.fontWeight, 10) || 400) >= 700;
  const large = size >= 24 || (bold && size >= 18.66);
  return { ratio, need: large ? 3 : 4.5, fg: hex(fg), bg: hex(bg), large };
}

function ownText(n) {
  let t = '';
  for (const c of n.childNodes) if (c.nodeType === 3) t += c.textContent;
  return clean(t);
}

// ---------- headings ----------

function headingLevel(n) {
  const m = /^H([1-6])$/.exec(n.tagName);
  if (m) return Number(m[1]);
  if (n.getAttribute('role') === 'heading') return Number(n.getAttribute('aria-level')) || 2;
  return 0;
}

// ---------- the scan ----------

/**
 * Findings for the elements under `roots` (deduplicated), plus `target` itself.
 * Each: { rule, severity: 'error'|'warn', el, message, detail, fix }.
 */
export function scanA11y(roots, target) {
  const set = new Set();
  const list = [];
  const add = (n) => {
    if (!n || n.nodeType !== 1 || set.has(n) || list.length >= MAX_ELEMENTS) return;
    if (n.tagName === 'SOURCEPEEK-ROOT' || n.tagName === 'SCRIPT' || n.tagName === 'STYLE') return;
    set.add(n);
    list.push(n);
  };
  const scopes = [...new Set(roots.filter(Boolean))].filter((r, i, all) => !all.some((o, j) => j !== i && o !== r && o.contains(r)));
  for (const r of scopes) {
    add(r);
    const w = document.createTreeWalker(r, NodeFilter.SHOW_ELEMENT);
    for (let n = w.nextNode(); n && list.length < MAX_ELEMENTS; n = w.nextNode()) add(n);
  }
  if (target) add(target);

  const findings = [];
  const push = (f) => findings.length < MAX_FINDINGS && findings.push(f);
  let headings = null;

  for (const n of list) {
    if (!visible(n) && n.tagName !== 'INPUT') continue;
    const tag = n.tagName;
    const lower = tag.toLowerCase();
    const role = n.getAttribute('role');
    const hidden = ariaHidden(n);

    // Images
    if (!hidden && (tag === 'IMG' || (tag === 'INPUT' && n.type === 'image'))) {
      const alt = n.getAttribute('alt');
      const src = (n.getAttribute('src') || '').split('/').pop().slice(0, 60);
      if (alt === null && !n.getAttribute('aria-label') && !n.getAttribute('aria-labelledby') && role !== 'presentation' && role !== 'none') {
        push({ rule: 'img-alt', severity: 'error', el: n, message: 'Image has no alt text', detail: 'Screen readers announce the file name instead, or skip it.', fix: `Add a meaningful alt attribute to this image${src ? ` (${src})` : ''} describing what it shows. If it is purely decorative, use alt="".` });
      } else if (alt && /^(image|img|photo|picture|icon|logo|graphic|untitled|\S+\.(png|jpe?g|gif|svg|webp|avif))$/i.test(alt.trim())) {
        push({ rule: 'img-alt', severity: 'warn', el: n, message: `Alt text “${alt.trim()}” doesn’t describe the image`, detail: 'Describe what the image shows or why it is there.', fix: `The alt text "${alt.trim()}" is not descriptive. Replace it with a short description of what the image shows (or alt="" if decorative).` });
      }
      continue;
    }
    if (!hidden && (role === 'img' || ((tag === 'svg' || tag === 'SVG') && role === 'img')) && !accName(n)) {
      push({ rule: 'img-alt', severity: 'error', el: n, message: 'Element with role="img" has no name', detail: 'Add aria-label (or a <title> inside the SVG).', fix: 'This element has role="img" but no accessible name. Add an aria-label describing it (or a <title> inside the SVG).' });
    }

    // Buttons and links
    const isButton = tag === 'BUTTON' || role === 'button' || (tag === 'INPUT' && /^(button|submit|reset)$/.test(n.type));
    const isLink = (tag === 'A' && n.hasAttribute('href')) || role === 'link';
    if (!hidden && (isButton || isLink) && !accName(n)) {
      const what = isLink ? 'Link' : 'Button';
      const iconOnly = n.querySelector('svg, img, i, [class*="icon" i]');
      push({
        rule: 'name',
        severity: 'error',
        el: n,
        message: `${what} has no text`,
        detail: iconOnly ? 'Icon-only: screen readers announce just “button”/“link”. Add aria-label.' : 'Screen readers announce just “button”/“link”.',
        fix: `This ${what.toLowerCase()} has no accessible name (no text, aria-label or title)${iconOnly ? ' — it only contains an icon' : ''}. Add an aria-label (or visually hidden text) that says what it does.`,
      });
    }

    // Form fields
    const field = (tag === 'INPUT' && !/^(hidden|submit|reset|button|image)$/.test(n.type)) || tag === 'SELECT' || tag === 'TEXTAREA' || /^(textbox|combobox|searchbox|listbox|spinbutton|slider|checkbox|radio|switch)$/.test(role || '');
    if (field && !hidden && (visible(n) || n.type === 'checkbox' || n.type === 'radio') && !accName(n)) {
      const ph = n.getAttribute('placeholder');
      const kind = tag === 'INPUT' ? `<input type="${n.type}">` : `<${lower}>`;
      push({
        rule: 'label',
        severity: 'error',
        el: n,
        message: ph ? `Field has only a placeholder (“${ph.slice(0, 40)}”), no label` : 'Form field has no label',
        detail: ph ? 'Placeholders disappear while typing and many screen readers don’t read them as the label.' : 'Screen readers can’t tell what to enter.',
        fix: `This ${kind} has no label${ph ? ` (only the placeholder "${ph}")` : ''}. Associate a visible <label> with it (htmlFor/for + id, or wrap it), or add aria-label if a visible label doesn't fit the design.`,
      });
    }

    // Keyboard access
    if (!hidden && tag !== 'HTML' && tag !== 'BODY' && !focusable(n) && hasClickHandler(n)) {
      const inner = n.querySelector('a[href], button, input, select, textarea, [tabindex]');
      if (!inner) {
        push({
          rule: 'keyboard',
          severity: 'error',
          el: n,
          message: `Clickable <${lower}> can’t be reached with the keyboard`,
          detail: 'It has a click handler but no tabindex or role, so Tab skips it and Enter does nothing.',
          fix: `This <${lower}> has a click handler but can't be focused or used with the keyboard. Prefer turning it into a <button type="button"> (keep its look with CSS). Otherwise add role="button", tabIndex 0 and a keydown handler for Enter and Space.`,
        });
      }
    }
    const ti = n.getAttribute('tabindex');
    if (ti !== null && Number(ti) > 0) {
      push({ rule: 'keyboard', severity: 'warn', el: n, message: `tabindex="${ti}" changes the tab order`, detail: 'Positive tabindex makes this element jump ahead of everything else.', fix: `Remove tabindex="${ti}" (or use tabindex="0") so keyboard focus follows the page order.` });
    }
    if (hidden && n.getAttribute('aria-hidden') === 'true') {
      const f = n.matches('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])') ? n : n.querySelector('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])');
      if (f) push({ rule: 'keyboard', severity: 'error', el: n, message: 'aria-hidden content contains something focusable', detail: 'Keyboard users can Tab to it, but screen readers say nothing.', fix: 'This aria-hidden="true" element contains a focusable control. Remove aria-hidden, or make the control unfocusable (tabindex="-1" / inert) while hidden.' });
    }

    // Headings
    const level = headingLevel(n);
    if (level) {
      if (!accName(n)) push({ rule: 'heading', severity: 'error', el: n, message: `Empty <h${level}>`, detail: 'Screen-reader users navigate by headings; an empty one is a dead end.', fix: `This heading (h${level}) has no text. Give it text, or remove it if it's only used for spacing.` });
      else {
        if (!headings) headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')).filter((h) => visible(h) && !ariaHidden(h) && !h.closest('sourcepeek-root'));
        const i = headings.indexOf(n);
        const prev = i > 0 ? headingLevel(headings[i - 1]) : 0;
        if (prev && level > prev + 1) {
          push({ rule: 'heading', severity: 'warn', el: n, message: `Heading level skipped: h${prev} → h${level}`, detail: `The heading before it on the page is an h${prev}. Screen-reader users expect h${prev + 1}.`, fix: `This <h${level}> comes right after an <h${prev}> on the page, so a level is skipped. Change it to <h${prev + 1}> and keep its current look with CSS if needed.` });
        }
      }
    }

    // Contrast (text written directly in this element)
    if (!hidden && ownText(n)) {
      const c = contrastOf(n);
      if (c && c.ratio < c.need) {
        const r = Math.floor(c.ratio * 100) / 100;
        push({
          rule: 'contrast',
          severity: c.ratio < c.need - 1 ? 'error' : 'warn',
          el: n,
          message: `Low contrast ${r}:1 (needs ${c.need}:1)`,
          detail: `Text ${c.fg} on ${c.bg}${c.large ? ' (large text)' : ''}. WCAG AA.`,
          fix: `The text "${ownText(n).slice(0, 60)}" has a colour contrast of ${r}:1 (${c.fg} on ${c.bg}); WCAG AA needs ${c.need}:1. Darken or lighten the text colour (or the background) so it passes, staying close to the current design.`,
          swatch: c,
        });
      }
    }
  }
  const order = { error: 0, warn: 1 };
  return { findings: findings.sort((a, b) => order[a.severity] - order[b.severity]), checked: list.length, capped: list.length >= MAX_ELEMENTS };
}

// ---------- UI ----------

const RULE_LABEL = { 'img-alt': 'Alt text', name: 'Name', label: 'Label', keyboard: 'Keyboard', heading: 'Heading', contrast: 'Contrast' };

/**
 * Fill the Accessibility accordion body.
 * opts: { roots: () => Element[], target: Element, componentName, onCount(n), fix(instruction, target) }
 */
export function buildA11y(box, opts) {
  const head = el('div', 'mf-a11y-head');
  const summary = el('div', 'mf-muted mf-a11y-summary');
  const recheck = el('button', 'mf-net-btn', 'Re-check');
  recheck.type = 'button';
  head.append(summary, recheck);
  const list = el('div', 'mf-a11y-list');
  const foot = el('div', 'mf-net-hint', 'Checked: alt text, button and link names, form labels, colour contrast (WCAG AA), heading order and keyboard access. Automated checks find only part of the problems — try the page with Tab and a screen reader too.');
  box.append(head, list, foot);
  let result = null;

  const run = () => {
    try {
      result = scanA11y(opts.roots(), opts.target);
    } catch (err) {
      result = { findings: [], checked: 0, error: String((err && err.message) || err) };
    }
    if (opts.onCount) opts.onCount(result.findings.length);
    render();
    return result;
  };

  function render() {
    list.textContent = '';
    const f = result.findings;
    const errors = f.filter((x) => x.severity === 'error').length;
    summary.textContent = result.error
      ? `Check failed: ${result.error}`
      : f.length
        ? `${f.length} issue${f.length === 1 ? '' : 's'} (${errors} error${errors === 1 ? '' : 's'}, ${f.length - errors} warning${f.length - errors === 1 ? '' : 's'}) in ${opts.componentName} and what it renders · ${result.checked} elements checked`
        : `No issues found in ${opts.componentName} · ${result.checked} elements checked`;
    for (const item of f) list.appendChild(row(item));
  }

  function row(item) {
    const r = el('div', `mf-a11y-item mf-a11y-item--${item.severity}`);
    const top = el('div', 'mf-a11y-top');
    top.append(el('span', `mf-a11y-sev mf-a11y-sev--${item.severity}`, item.severity === 'error' ? 'Error' : 'Warning'), el('span', 'mf-a11y-rule', RULE_LABEL[item.rule] || item.rule), el('span', 'mf-a11y-msg', item.message));
    r.appendChild(top);
    if (item.swatch) {
      const sw = el('span', 'mf-a11y-swatch', 'Aa');
      sw.style.color = item.swatch.fg;
      sw.style.background = item.swatch.bg;
      top.appendChild(sw);
    }
    r.appendChild(el('div', 'mf-muted', item.detail));
    r.appendChild(el('code', 'mf-a11y-tag', startTag(item.el)));
    const actions = el('div', 'mf-a11y-actions');
    const where = el('button', 'mf-linkbtn', 'locating…');
    where.type = 'button';
    const show = el('button', 'mf-net-btn', 'Show');
    show.type = 'button';
    show.title = 'Scroll to it and highlight it';
    show.onclick = () => {
      try {
        item.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch {}
      setTimeout(() => flashElement(item.el, item.message), 250);
    };
    const fixBtn = el('button', 'mf-net-btn mf-net-btn--primary', 'Fix with AI');
    fixBtn.type = 'button';
    fixBtn.title = 'Preview a fix in Change with AI — nothing is written until you apply it';
    actions.append(where, show, fixBtn);
    r.appendChild(actions);
    r.onmouseenter = () => flashElement(item.el, item.message, true);

    let hit = null;
    const resolved = (h) => {
      hit = h && h.file ? h : null;
      where.textContent = hit ? fileLine(hit.file, hit.line) : 'source not found';
      where.title = hit ? 'Open in your editor' : 'This element is not written in your own source files (a library?)';
      where.disabled = !hit;
    };
    const h0 = locate(item.el);
    if (h0 && h0.ng) resolveHit(h0).then(resolved);
    else resolved(h0);
    where.onclick = () => hit && openSource(hit.file, hit.line);
    fixBtn.onclick = () => {
      const at = hit ? ` at ${fileLine(hit.file, hit.line)}` : '';
      const instruction = `Accessibility fix${at} for ${startTag(item.el)}: ${item.fix}`;
      opts.fix(instruction, hit ? { ...hit, el: item.el } : null, item.rule === 'contrast' ? null : 'code');
    };
    return r;
  }

  recheck.onclick = run;
  run();
  return { rerun: run, count: () => (result ? result.findings.length : 0) };
}
