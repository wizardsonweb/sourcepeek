'use strict';
// Where should new UI go? "Add a component here with a title, text and an image" rarely means "append it to the
// file that happens to own the clicked DOM node". The clicked node is often a layout wrapper (<main>{children}</main>)
// whose file wraps EVERY page, a leaf (<h2>, <img>) that can't hold a card, or a tiny shared component used all over.
//
// The browser sends the boxes around the click — ancestors, the clicked box, its children and siblings — each with
// the source file:line that writes it (data-mf-file / Svelte / Vue metadata) and where the click point was. This
// module turns that into:
//   • files: the page file for the current URL and the files that render the surrounding boxes, editable, with
//            layouts marked as such;
//   • text:  a short structural description plus the placement rules, for the prompt.

const fs = require('fs');
const path = require('path');
const edit = require('./edit.cjs');
const project = require('./project.cjs');

const MAX_EXTRA_FILES = 4;
const MAX_EXTRA_CHARS = 45000;
const MAX_TOTAL_CHARS = 170000;

const clip = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

function parseSrc(src) {
  const m = typeof src === 'string' && src.match(/^(.*?)(?::(\d+))?$/);
  if (!m || !m[1]) return null;
  return { file: m[1], line: m[2] ? Number(m[2]) : null };
}

function samePath(root, a, b) {
  if (!a || !b) return false;
  const ra = path.isAbsolute(a) ? a : path.resolve(root, a);
  const rb = path.isAbsolute(b) ? b : path.resolve(root, b);
  try {
    return fs.realpathSync(ra) === fs.realpathSync(rb);
  } catch {
    return path.resolve(ra) === path.resolve(rb);
  }
}

function box(n, layoutFiles, root) {
  if (!n || typeof n !== 'object') return '';
  const cls = n.cls ? '.' + clip(n.cls, 60).split(' ').filter(Boolean).slice(0, 4).join('.') : '';
  const size = n.w && n.h ? ` ${n.w}×${n.h}` : '';
  const disp = n.display && !/^(block|inline)$/.test(n.display) ? ` ${clip(n.display, 30)}` : '';
  const kids = typeof n.kids === 'number' && n.kids ? ` ${n.kids} child${n.kids === 1 ? '' : 'ren'}` : '';
  const text = n.text ? ` "${clip(n.text, 50)}"` : '';
  const src = parseSrc(n.src);
  const rel = src ? toRel(root, src.file) : null;
  const where = src ? ` — ${rel}${src.line ? ':' + src.line : ''}${n.comp ? ` <${clip(n.comp, 40)}>` : ''}` : n.comp ? ` — <${clip(n.comp, 40)}>` : '';
  const flags = [];
  if (rel && layoutFiles.has(rel)) flags.push('LAYOUT');
  if (n.repeated) flags.push(`one of ${n.repeated} similar items`);
  if (n.leaf) flags.push('leaf');
  if (n.inline) flags.push('inline');
  return `<${clip(n.tag, 20)}${cls}>${size}${disp}${kids}${text}${where}${flags.length ? ` [${flags.join(', ')}]` : ''}`;
}

function toRel(root, file) {
  const abs = path.isAbsolute(file) ? file : path.resolve(root, file);
  return path.relative(root, abs).split(path.sep).join('/');
}

/**
 * root, body ({ file, placement }), files (editableFiles output — mutated: extra files are pushed).
 * Returns { text, added: [rel] }.
 */
function plan(root, body, files) {
  const pl = body && typeof body.placement === 'object' && body.placement ? body.placement : {};
  const ancestors = Array.isArray(pl.ancestors) ? pl.ancestors.slice(-10) : [];
  const children = Array.isArray(pl.children) ? pl.children.slice(0, 16) : [];
  const siblings = Array.isArray(pl.siblings) ? pl.siblings.slice(0, 16) : [];
  const clicked = pl.clicked && typeof pl.clicked === 'object' ? pl.clicked : null;
  const urlPath = typeof pl.path === 'string' ? pl.path.slice(0, 300) : null;

  let total = files.reduce((n, f) => n + f.content.length, 0);
  const added = [];
  const layoutFiles = new Set();
  const component = files.find((f) => f.role === 'component');
  if (component && project.isLayout(component.abs, component.content)) layoutFiles.add(component.rel);
  for (const f of files) if (f.role !== 'component' && project.isLayout(f.abs, f.content)) layoutFiles.add(f.rel);

  const addFile = (file, role) => {
    if (added.length >= MAX_EXTRA_FILES || !file) return null;
    if (files.some((f) => samePath(root, f.abs, file))) return files.find((f) => samePath(root, f.abs, file));
    if (/[\\/]node_modules[\\/]/.test(file)) return null;
    const f = edit.extraFile(root, file, role);
    if (!f || f.content.length > MAX_EXTRA_CHARS || total + f.content.length > MAX_TOTAL_CHARS) return null;
    if (project.isLayout(f.abs, f.content)) {
      f.role = 'layout';
      layoutFiles.add(f.rel);
    }
    files.push(f);
    added.push(f.rel);
    total += f.content.length;
    return f;
  };

  // 1. the page that renders this URL
  let pageAbs = null;
  try {
    pageAbs = urlPath ? project.pageForPath(root, urlPath) : null;
  } catch {}
  let pageRel = null;
  if (pageAbs) {
    const f = addFile(pageAbs, 'page');
    if (f) {
      pageRel = f.rel;
      if (f.role !== 'component' && f.role !== 'layout') f.role = 'page';
    }
  }

  // 2. files that write the boxes around the click: children first (what's inside the clicked box — often the page
  //    when a layout wrapper was clicked), then the nearest ancestors, then siblings.
  const cands = [];
  const push = (n) => {
    const s = n && parseSrc(n.src);
    if (s && !cands.some((c) => samePath(root, c, s.file))) cands.push(s.file);
  };
  children.forEach(push);
  [...ancestors].reverse().forEach(push);
  siblings.forEach(push);
  for (const c of cands) addFile(c, 'context');

  // 3. describe it
  const L = [];
  if (urlPath) L.push(`URL: ${urlPath}${pageRel ? ` — the page file is ${pageRel}` : ' — no page file found for it (routing in code or a single-page app)'}.`);
  if (layoutFiles.size) L.push(`LAYOUT files (they wrap EVERY page around {children} / <Outlet/> / <slot/>): ${[...layoutFiles].join(', ')}.`);
  if (ancestors.length || clicked) {
    L.push('Boxes around the click, outer → inner (file:line = where that box is written):');
    ancestors.forEach((a, i) => L.push(`${'  '.repeat(Math.min(i, 8))}${box(a, layoutFiles, root)}`));
    if (clicked) L.push(`${'  '.repeat(Math.min(ancestors.length, 8))}★ CLICKED ${box(clicked, layoutFiles, root)}`);
  }
  if (children.length) {
    L.push('Inside the clicked box (its children, in order):');
    children.forEach((c, i) => L.push(`  ${i + 1}. ${box(c, layoutFiles, root)}`));
  }
  if (siblings.length > 1) {
    L.push('Next to the clicked box (same parent, in order; ★ = clicked):');
    siblings.forEach((c, i) => L.push(`  ${i + 1}. ${c.self ? '★ ' : ''}${box(c, layoutFiles, root)}`));
  }
  if (pl.point && typeof pl.point === 'string') L.push(`Click point: ${clip(pl.point, 200)}.`);

  const clickedRel = clicked && parseSrc(clicked.src) ? toRel(root, parseSrc(clicked.src).file) : component ? component.rel : null;
  const clickedIsLayout = clickedRel && layoutFiles.has(clickedRel);
  L.push('');
  L.push('Decide where the new UI belongs the way a careful developer would:');
  L.push('- If the request names a place ("in the header", "above the footer", "inside the card", "on every page"), follow it exactly.');
  L.push('- "here" / no place given: put it in the box the developer clicked, at the click point (between the children the click was nearest to), in the FILE that writes that position (see file:line above). If the click was on a child, insert right after that child (or before it when the click was in its upper part).');
  L.push(
    `- Never put page content into a LAYOUT file, and never right before/after the page outlet ({children}, <Outlet/>, <slot/>, <router-outlet>) — it would appear on every page, above or below everything. ${
      clickedIsLayout ? `The clicked box is written in the layout ${clickedRel}: insert into ${pageRel ? `the page file ${pageRel}` : 'the file that renders the page content (the children listed above)'} instead, at the position matching the click.` : 'If the clicked box turns out to be written in a layout, insert into the page file instead.'
    } Edit a layout only when the request clearly targets every page (header, nav, footer, sidebar, "on all pages").`
  );
  L.push('- A leaf or inline element (heading, paragraph, text, image, link, button, badge, input) cannot hold a block of content: insert after the nearest block that contains it (its card, section or list), as a sibling in that container.');
  L.push('- A list or grid of similar items (cards, tiles, list items): a new card / item / tile belongs in that list as one more item with the same markup and classes as its siblings; any other new block goes after the whole list, not inside it.');
  L.push('- Do not put new content inside a small shared component (button, badge, icon, input wrapper) — it would show up everywhere that component is used. Put it where that component is used (call-site or page).');
  L.push('- Inside a flex row or grid, a new full-width block usually belongs after the row/grid, not in it — unless it is one more item of that row.');
  L.push('- Match the look of the neighbours: same container width, spacing, card style, heading level, classes / styled components / stylesheet conventions.');
  return { text: L.join('\n'), added };
}

module.exports = { plan };
