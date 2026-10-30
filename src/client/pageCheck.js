// "Meta tags": SEO basics for the whole page — title, meta description, h1s, canonical link, Open Graph tags
// and <html lang>. Shown as an accordion in the More view. Each check is also run on the HTML the server sends (what crawlers that don't run
// JavaScript see), because a title set only in the browser is a common surprise.

import { el, getState, flashElement } from './core.js';
import { nativeFetch } from './network.js';

const OG = ['og:title', 'og:description', 'og:image', 'og:url', 'og:type'];

function meta(doc, attr, name) {
  const m = doc.querySelector(`meta[${attr}="${name}" i]`);
  return m ? (m.getAttribute('content') || '').trim() : null;
}

/** Raw facts about a document, used for both the live page and the server HTML. */
function facts(doc, live) {
  const title = (doc.querySelector('title') ? doc.title || doc.querySelector('title').textContent : '').trim();
  const h1s = Array.from(doc.querySelectorAll('h1')).filter((h) => !live || !h.closest('sourcepeek-root'));
  const canon = Array.from(doc.querySelectorAll('link[rel~="canonical" i]'));
  const og = {};
  for (const k of OG) og[k] = meta(doc, 'property', k) ?? meta(doc, 'name', k);
  return {
    title,
    description: meta(doc, 'name', 'description'),
    h1s,
    canonical: canon.map((l) => l.getAttribute('href') || ''),
    og,
    lang: (doc.documentElement.getAttribute('lang') || '').trim(),
    robots: meta(doc, 'name', 'robots'),
  };
}

const ok = (text, hint) => ({ level: 'ok', text, hint });
const warn = (text, hint) => ({ level: 'warn', text, hint });
const bad = (text, hint) => ({ level: 'fail', text, hint });

function checks(f) {
  const out = [];
  const t = f.title;
  out.push({
    name: 'Title',
    value: t || null,
    ...(!t ? bad('Missing', 'Add a <title>. It is the link text in search results and the browser tab.') : t.length < 10 ? warn(`Short (${t.length} characters)`, 'Aim for about 30–60 characters that describe this page.') : t.length > 60 ? warn(`Long (${t.length} characters)`, 'Search results cut titles at about 60 characters.') : ok(`${t.length} characters`)),
    key: 'title',
  });
  const d = f.description;
  out.push({
    name: 'Meta description',
    value: d || null,
    ...(d == null ? bad('Missing', 'Add <meta name="description" content="…">. Search engines often show it under the title.') : !d ? bad('Empty') : d.length < 50 ? warn(`Short (${d.length} characters)`, 'Aim for about 70–160 characters.') : d.length > 160 ? warn(`Long (${d.length} characters)`, 'Search results cut descriptions at about 160 characters.') : ok(`${d.length} characters`)),
    key: 'description',
  });
  const n = f.h1s.length;
  out.push({
    name: 'h1',
    value: n ? f.h1s.map((h) => (h.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) || '(empty)').join(' · ') : null,
    ...(n === 0 ? bad('No h1', 'Each page should have one h1 that says what it is about.') : n > 1 ? warn(`${n} h1 elements`, 'Use one h1 per page; make the others h2.') : ok('One h1')),
    els: f.h1s,
    key: 'h1',
  });
  const c = f.canonical;
  let canon;
  if (!c.length) canon = warn('Missing', 'Add <link rel="canonical" href="https://…">, so URL variants (query strings, trailing slashes) count as one page.');
  else if (c.length > 1) canon = bad(`${c.length} canonical links`, 'Keep exactly one; search engines may ignore them all.');
  else if (!/^https?:\/\//i.test(c[0])) canon = warn('Relative URL', 'Use an absolute URL (https://example.com/page).');
  else {
    let other = false;
    try {
      const u = new URL(c[0]);
      other = u.pathname.replace(/\/$/, '') !== location.pathname.replace(/\/$/, '');
    } catch {}
    canon = other ? warn('Points to another path', 'Fine if intended (a duplicate page). Otherwise this page may be dropped from search results.') : ok('Set');
  }
  out.push({ name: 'Canonical', value: c.join(' · ') || null, ...canon, key: 'canonical' });
  const missing = OG.filter((k) => !f.og[k]);
  const img = f.og['og:image'];
  out.push({
    name: 'Open Graph',
    value: OG.filter((k) => f.og[k]).map((k) => `${k.slice(3)}: ${f.og[k].slice(0, 60)}`).join(' · ') || null,
    ...(missing.length === OG.length
      ? warn('No og: tags', 'Links shared on Slack, LinkedIn, X or iMessage get no title, text or image. Add og:title, og:description, og:image, og:url, og:type.')
      : missing.length
        ? warn(`Missing ${missing.join(', ')}`, 'Shared links look incomplete without them.')
        : img && !/^https?:\/\//i.test(img)
          ? warn('og:image is a relative URL', 'Most sites that show previews need an absolute image URL.')
          : ok('All five set')),
    key: 'og',
  });
  const lang = f.lang;
  out.push({
    name: 'lang',
    value: lang || null,
    ...(!lang ? bad('Missing on <html>', 'Add <html lang="en"> (or your language). Screen readers and search engines use it.') : /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/i.test(lang) ? ok('Set') : warn('Not a valid language code', 'Use a BCP 47 code such as en, en-US, hr.')),
    key: 'lang',
  });
  if (f.robots && /noindex/i.test(f.robots)) out.push({ name: 'Robots', value: f.robots, ...warn('noindex', 'This page asks search engines not to index it. Normal on a dev or staging server — make sure production does not send it.'), key: 'robots' });
  return out;
}

const ICON = { ok: '✓', warn: '!', fail: '✕' };

function serverValue(sf, key) {
  if (!sf) return null;
  if (key === 'title') return sf.title || '';
  if (key === 'description') return sf.description || '';
  if (key === 'h1') return sf.h1s.length ? String(sf.h1s.length) : '';
  if (key === 'canonical') return sf.canonical.join(' ');
  if (key === 'og') return OG.filter((k) => sf.og[k]).length ? 'og' : '';
  if (key === 'lang') return sf.lang || '';
  return null;
}

/**
 * Fill the "Meta tags" accordion body: SEO basics for the whole page. ctx: { onCount(fail, warn) }.
 * Returns a cleanup function.
 */
export function buildMetaTags(box, ctx = {}) {
  const st = getState();
  const toolbar = el('div', 'mf-net-toolbar');
  const summary = el('div', 'mf-muted mf-net-summary', location.pathname);
  const again = el('button', 'mf-net-btn', 'Re-check');
  again.type = 'button';
  toolbar.append(summary, again);
  const body = el('div', 'mf-pagecheck-body');
  box.append(toolbar, body);

  let alive = true;
  let server = null; // facts from the HTML the server sent, or { error }
  const run = () => {
    if (!alive) return;
    body.textContent = '';
    const rows = checks(facts(document, true));
    const counts = { ok: 0, warn: 0, fail: 0 };
    rows.forEach((r) => counts[r.level]++);
    if (ctx.onCount) ctx.onCount(counts.fail, counts.warn);
    summary.textContent = `${location.pathname} — ${counts.fail} problem${counts.fail === 1 ? '' : 's'}, ${counts.warn} warning${counts.warn === 1 ? '' : 's'}`;
    for (const r of rows) {
      const item = el('div', `mf-pc-row mf-pc-row--${r.level}`);
      const top = el('div', 'mf-pc-top');
      top.append(el('span', `mf-pc-icon mf-pc-icon--${r.level}`, ICON[r.level]), el('span', 'mf-pc-name', r.name), el('span', 'mf-pc-status', r.text));
      item.appendChild(top);
      if (r.value) item.appendChild(el('div', 'mf-pc-value', r.value));
      if (r.hint) item.appendChild(el('div', 'mf-muted', r.hint));
      if (r.els && r.els.length) {
        const s = el('button', 'mf-net-btn', r.els.length > 1 ? 'Show them' : 'Show');
        s.type = 'button';
        s.onclick = () => {
          r.els.forEach((h, i) =>
            setTimeout(() => {
              try {
                h.scrollIntoView({ block: 'center', behavior: 'smooth' });
              } catch {}
              flashElement(h, `h1 ${i + 1} of ${r.els.length}`);
            }, i * 900)
          );
        };
        item.appendChild(s);
      }
      // What a crawler that doesn't run JavaScript gets for this check.
      const sv = server && !server.error ? serverValue(server, r.key) : null;
      if (sv !== null && r.value) {
        if (!sv) item.appendChild(el('div', 'mf-pc-server', 'Not in the HTML the server sends — set only by JavaScript. Crawlers that don’t run JavaScript won’t see it.'));
      }
      body.appendChild(item);
    }
    if (server && server.error) body.appendChild(el('div', 'mf-net-hint', `Couldn’t load the server HTML to compare: ${server.error}`));
    else if (!server) body.appendChild(el('div', 'mf-net-hint', 'Comparing with the HTML the server sends…'));
  };
  const loadServer = () =>
    nativeFetch(location.href, { headers: { Accept: 'text/html' }, credentials: 'same-origin' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((html) => {
        server = facts(new DOMParser().parseFromString(html, 'text/html'), false);
      })
      .catch((err) => {
        server = { error: String((err && err.message) || err) };
      })
      .then(() => st && st.alive && run());
  again.onclick = () => {
    server = null;
    run();
    loadServer();
  };
  run();
  loadServer();
  return () => {
    alive = false;
  };
}
