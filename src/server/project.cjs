'use strict';
// "Change with AI" sees more than the clicked file:
//   • tree()        — a compact project tree, so the model knows where things live (pages, components, styles).
//   • stats()       — which styling systems the project really uses (CSS, SCSS, Less, CSS Modules, Tailwind,
//                     styled-components, Emotion …), how much, and the utilities / colours used most.
//   • themeFiles()  — the files that define the look of the WHOLE app: global stylesheets, Tailwind config or
//                     @theme block, Sass/Less variable partials, the styled-components / Emotion / MUI theme
//                     and global styles. "Change the entire theme" is implemented there.
//   • pageForPath() — the route file that renders the current URL, so new content lands on the page, not in a
//                     layout that wraps every page.
// Everything is cached per project root for a short while: a scan walks the source tree once.

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', '.nuxt', '.output', '.svelte-kit', 'dist', 'build', 'out', 'coverage', '.turbo',
  '.vercel', '.angular', '.sourcepeek', '.cache', '.idea', '.vscode', 'vendor', 'tmp', 'temp', '.storybook', 'storybook-static',
]);
const CODE = /\.(jsx?|tsx?|mjs|cjs|vue|svelte|html)$/;
const STYLE = /\.(css|scss|sass|less)$/;
const MAX_FILES = 2500;
const MAX_READ = 300000;
const TTL = 20000;

const toPosix = (p) => p.split(path.sep).join('/');
const rel = (root, abs) => toPosix(path.relative(root, abs)) || '.';

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function read(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_READ) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

function deps(root) {
  const pkg = readJson(path.join(root, 'package.json')) || {};
  return { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.peerDependencies || {}) };
}

// ---------------------------------------------------------------------------------------------
// walking the source tree
// ---------------------------------------------------------------------------------------------

/** Every source / style file of the project (not node_modules, not build output), at most MAX_FILES. */
function listFiles(root) {
  const out = [];
  const go = (dir, depth) => {
    if (out.length >= MAX_FILES || depth > 9) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !(depth === 0 && e.name === 'public')) go(abs, depth + 1);
      } else if ((CODE.test(e.name) || STYLE.test(e.name)) && !/\.(min|d)\.\w+$/.test(e.name) && !/\.(test|spec|stories)\.\w+$/.test(e.name)) {
        out.push(abs);
      }
    }
  };
  go(root, 0);
  return out;
}

const cache = new Map();
function cached(root, key, fn) {
  const k = root + '\0' + key;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = fn();
  cache.set(k, { at: Date.now(), value });
  return value;
}

function files(root) {
  return cached(root, 'files', () => listFiles(root));
}

// ---------------------------------------------------------------------------------------------
// project tree
// ---------------------------------------------------------------------------------------------

/**
 * A compact tree of the project's source folders. Folders with many files are summarised ("+ 14 more .tsx").
 * At most `maxLines` lines.
 */
function tree(root, maxLines = 140) {
  return cached(root, 'tree:' + maxLines, () => {
    const all = files(root).map((f) => rel(root, f));
    const config = fs
      .readdirSync(root)
      .filter((n) => /^(package\.json|tsconfig\.json|vite\.config\.\w+|next\.config\.\w+|nuxt\.config\.\w+|svelte\.config\.\w+|angular\.json|tailwind\.config\.\w+|postcss\.config\.\w+|astro\.config\.\w+)$/.test(n));
    const dirs = new Map();
    for (const f of all) {
      const d = path.posix.dirname(f);
      if (!dirs.has(d)) dirs.set(d, []);
      dirs.get(d).push(path.posix.basename(f));
    }
    const lines = [];
    const rootFiles = [...new Set([...config, ...(dirs.get('.') || [])])];
    dirs.delete('.');
    if (rootFiles.length) lines.push(`./  ${rootFiles.join(', ')}`);
    const sorted = [...dirs.keys()].sort();
    for (const d of sorted) {
      if (lines.length >= maxLines) {
        lines.push(`… (${sorted.length - sorted.indexOf(d)} more folders)`);
        break;
      }
      const names = dirs.get(d);
      const shown = names.slice(0, 12);
      const more = names.length - shown.length;
      lines.push(`${d === '.' ? '.' : d}/  ${shown.join(', ')}${more > 0 ? `, + ${more} more` : ''}`);
    }
    return lines.join('\n');
  });
}

// ---------------------------------------------------------------------------------------------
// styling statistics
// ---------------------------------------------------------------------------------------------

const TW_COLOR = /(?:^|[\s"'`{(:])(?:[a-z0-9-]+:)*((?:bg|text|border|ring|from|via|to|fill|stroke|divide|outline|decoration|accent|caret|placeholder|shadow)-((?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}|white|black|primary|secondary|accent|muted|foreground|background|card|border|destructive|brand(?:-\d{2,3})?))(?:\/\d+)?(?=$|[\s"'`})])/g;
const TW_FONT = /(?:^|[\s"'`{(:])(?:[a-z0-9-]+:)*(font-(?:sans|serif|mono|display|heading|body)|rounded(?:-[a-z0-9]+)?)(?=$|[\s"'`})])/g;
const HEX = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g;
const CSS_IN_JS = /from\s+['"](styled-components(?:\/macro|\/native)?|@emotion\/(?:styled|react|css)|@linaria\/(?:react|core)|@stitches\/react|@vanilla-extract\/css|@mui\/(?:material|system|joy)(?:\/styles)?|goober)['"]/;

function bump(map, k, n = 1) {
  map.set(k, (map.get(k) || 0) + n);
}

function top(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

/**
 * How the project is styled overall.
 * Returns { counts: {system: files}, dominant, systems: [...], twColors, twOther, hexColors, cssVars, label }
 */
function stats(root) {
  return cached(root, 'stats', () => {
    const d = deps(root);
    const has = (n) => Object.prototype.hasOwnProperty.call(d, n);
    const counts = new Map();
    const twColors = new Map();
    const twOther = new Map();
    const hexColors = new Map();
    const cssVars = new Set();
    let classAttrFiles = 0;
    for (const abs of files(root)) {
      const name = path.basename(abs);
      const code = read(abs);
      if (code == null) continue;
      if (STYLE.test(name)) {
        const mod = /\.module\.(css|scss|sass|less)$/.test(name);
        const ext = name.match(STYLE)[1];
        const twEntry = /@tailwind\s+(base|components|utilities)|@import\s+["']tailwindcss|@theme\b/.test(code);
        // A Tailwind entry stylesheet with nothing else in it is not "plain CSS" styling.
        const onlyTw = twEntry && !code.replace(/@(tailwind|import|theme|plugin|source|config|layer)[^;{]*(;|\{[^}]*\})/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
        if (!onlyTw) bump(counts, mod ? `${ext === 'sass' ? 'scss' : ext}-module` : ext === 'sass' ? 'scss' : ext);
        if (twEntry) bump(counts, 'tailwind-css');
        for (const m of code.matchAll(HEX)) bump(hexColors, m[0].toLowerCase());
        for (const m of code.matchAll(/(--[\w-]+)\s*:/g)) if (cssVars.size < 400) cssVars.add(m[1]);
        continue;
      }
      const lib = code.match(CSS_IN_JS);
      if (lib) {
        const l = lib[1];
        const sys = l.startsWith('styled-components') ? 'styled-components' : l.startsWith('@emotion') ? 'emotion' : l.startsWith('@mui') ? 'mui' : l.startsWith('@linaria') ? 'linaria' : l.startsWith('@stitches') ? 'stitches' : l.startsWith('@vanilla-extract') ? 'vanilla-extract' : l;
        if (sys !== 'mui' || /\bstyled\s*\(|\bsx\s*=/.test(code)) bump(counts, sys);
        for (const m of code.matchAll(HEX)) bump(hexColors, m[0].toLowerCase());
      }
      if (/\.(vue|svelte)$/.test(name) && /<style\b/.test(code)) {
        const lang = (code.match(/<style\b[^>]*\blang\s*=\s*["'](\w+)["']/) || [])[1] || 'css';
        bump(counts, `${name.endsWith('.vue') ? 'vue' : 'svelte'}-style-${lang === 'sass' ? 'scss' : lang}`);
      }
      const classAttrs = code.match(/\b(?:className|class|:class)\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\})/g);
      if (classAttrs) {
        const joined = classAttrs.join(' ');
        let n = 0;
        for (const m of joined.matchAll(TW_COLOR)) {
          bump(twColors, m[1]);
          n++;
        }
        for (const m of joined.matchAll(TW_FONT)) bump(twOther, m[1]);
        if (n || /\b(?:flex|grid|p[xy]?-\d|m[xy]?-\d|gap-\d|text-(?:xs|sm|lg|xl|\dxl)|rounded|shadow)\b/.test(joined)) {
          classAttrFiles++;
          if (has('tailwindcss') || has('@tailwindcss/vite') || has('@tailwindcss/postcss') || hasTwConfig(root)) bump(counts, 'tailwind');
        }
      }
    }
    const tailwind = has('tailwindcss') || has('@tailwindcss/vite') || has('@tailwindcss/postcss') || hasTwConfig(root);
    const order = [...counts.entries()].filter(([k]) => k !== 'tailwind-css').sort((a, b) => b[1] - a[1]);
    const dominant = order.length ? order[0][0] : tailwind ? 'tailwind' : null;
    const LABEL = {
      css: 'plain CSS', scss: 'SCSS', less: 'Less', 'css-module': 'CSS Modules', 'scss-module': 'SCSS Modules', 'less-module': 'Less Modules',
      tailwind: 'Tailwind CSS', 'styled-components': 'styled-components', emotion: 'Emotion', mui: 'MUI', linaria: 'Linaria', stitches: 'Stitches',
      'vanilla-extract': 'vanilla-extract',
    };
    const label = (k) => LABEL[k] || k.replace(/^(vue|svelte)-style-(\w+)$/, (_, f, l) => `${f === 'vue' ? 'Vue' : 'Svelte'} <style${l !== 'css' ? ` lang="${l}"` : ''}>`);
    return {
      counts: Object.fromEntries(counts),
      dominant,
      tailwind,
      tailwindMajor: tailwind ? twMajor(root, d) : null,
      systems: order.map(([k, n]) => ({ system: k, files: n, label: label(k) })),
      summary: order.length ? order.map(([k, n]) => `${label(k)} (${n} file${n === 1 ? '' : 's'})`).join(', ') : 'no stylesheets or styling library found',
      twColors: top(twColors, 30),
      twOther: top(twOther, 12),
      hexColors: top(hexColors, 20),
      cssVars: [...cssVars].slice(0, 120),
      classAttrFiles,
    };
  });
}

function hasTwConfig(root) {
  return ['tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.cjs', 'tailwind.config.mjs'].some((f) => isFile(path.join(root, f)));
}

function twMajor(root, d) {
  // the installed version wins over the range in package.json
  const pj = readJson(path.join(root, 'node_modules', 'tailwindcss', 'package.json'));
  const v = (pj && pj.version) || d.tailwindcss || d['@tailwindcss/vite'] || d['@tailwindcss/postcss'] || '';
  const m = String(v).match(/(\d+)/);
  if (m) return Number(m[1]);
  return hasTwConfig(root) ? 3 : 4;
}

// ---------------------------------------------------------------------------------------------
// files that define the look of the whole app
// ---------------------------------------------------------------------------------------------

/** tsconfig/jsconfig path aliases: [{ prefix: '@/', dir: abs }] */
function aliases(root) {
  const out = [];
  for (const f of ['tsconfig.json', 'jsconfig.json', 'tsconfig.app.json']) {
    let txt = '';
    try {
      txt = fs.readFileSync(path.join(root, f), 'utf8');
    } catch {
      continue;
    }
    let j = null;
    try {
      j = JSON.parse(txt.replace(/\/\*[\s\S]*?\*\/|(^|[^:"'])\/\/[^\n]*/g, '$1').replace(/,(\s*[}\]])/g, '$1'));
    } catch {}
    const co = j && j.compilerOptions;
    if (!co || !co.paths) continue;
    const base = path.resolve(root, co.baseUrl || '.');
    for (const [k, v] of Object.entries(co.paths)) {
      if (!k.endsWith('/*') || !Array.isArray(v) || !v[0]) continue;
      out.push({ prefix: k.slice(0, -1), dir: path.resolve(base, v[0].replace(/\*$/, '')) });
    }
  }
  if (!out.some((a) => a.prefix === '@/') && isDir(path.join(root, 'src'))) out.push({ prefix: '@/', dir: path.join(root, 'src') });
  if (!out.some((a) => a.prefix === '~/') && isDir(path.join(root, 'src'))) out.push({ prefix: '~/', dir: path.join(root, 'src') });
  return out;
}

function resolveSpec(root, fromAbs, spec) {
  if (/^\.{1,2}\//.test(spec)) return path.resolve(path.dirname(fromAbs), spec);
  for (const a of aliases(root)) if (spec.startsWith(a.prefix)) return path.join(a.dir, spec.slice(a.prefix.length));
  if (spec.startsWith('/')) return path.join(root, spec);
  return null;
}

const SCRIPT_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

function resolveScript(root, fromAbs, spec) {
  const base = resolveSpec(root, fromAbs, spec);
  if (!base) return null;
  for (const e of SCRIPT_EXTS) if (isFile(base + e) && CODE.test(base + e)) return base + e;
  return null;
}

/** Stylesheets an entry file imports: import './globals.css', import '@/styles/app.scss', <style src>, @import. */
function importedStyles(root, abs, code) {
  const out = [];
  const re = /(?:import\s+(?:[\w*{}\s,]+\s+from\s+)?|@import\s+(?:url\()?|@use\s+|require\(\s*|<link[^>]+href=|<style\b[^>]*\bsrc\s*=\s*)['"]([^'"]+\.(?:css|scss|sass|less))['"]/g;
  for (const m of code.matchAll(re)) {
    const p = resolveSpec(root, abs, m[1]);
    if (p && isFile(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

/** The app's entry / root files: where global styles and providers usually live. */
function entryFiles(root) {
  const cands = [
    'src/app/layout', 'app/layout', 'src/pages/_app', 'pages/_app', 'src/pages/_document', 'pages/_document',
    'src/main', 'src/index', 'src/App', 'src/app', 'main', 'index', 'App', 'app/root', 'src/root', 'src/app.config', 'src/app/app.config',
    'src/routes/__root', 'app/routes/__root', 'src/routes/+layout', 'src/app.html', 'app.vue', 'app/app.vue', 'src/App.vue', 'src/App.svelte',
    'layouts/default', 'app/layouts/default', 'src/layouts/default', 'src/layouts/Layout', 'src/layouts/BaseLayout',
  ];
  const exts = ['.tsx', '.jsx', '.ts', '.js', '.mjs', '.vue', '.svelte', '.astro', '.html', ''];
  const out = [];
  for (const c of cands) {
    for (const e of exts) {
      const abs = path.join(root, c + e);
      if (isFile(abs) && (CODE.test(abs) || abs.endsWith('.astro')) && !out.includes(abs)) {
        out.push(abs);
        break;
      }
    }
  }
  return out;
}

/** Global stylesheets from nuxt.config css: [] and angular.json styles: []. */
function configuredStyles(root) {
  const out = [];
  const ng = readJson(path.join(root, 'angular.json'));
  if (ng && ng.projects) {
    for (const p of Object.values(ng.projects)) {
      const styles = p && p.architect && p.architect.build && p.architect.build.options && p.architect.build.options.styles;
      for (const s of styles || []) {
        const f = typeof s === 'string' ? s : s && s.input;
        if (f && STYLE.test(f) && isFile(path.join(root, f))) out.push(path.join(root, f));
      }
    }
  }
  for (const n of ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs']) {
    const code = read(path.join(root, n));
    if (!code) continue;
    const m = code.match(/\bcss\s*:\s*\[([^\]]*)\]/);
    if (!m) continue;
    for (const s of m[1].matchAll(/['"]([^'"]+\.(?:css|scss|sass|less))['"]/g)) {
      const spec = s[1].replace(/^~\/|^@\//, '');
      for (const base of [root, path.join(root, 'app'), path.join(root, 'src')]) {
        const p = path.join(base, spec.replace(/^\.\//, ''));
        if (isFile(p) && !out.includes(p)) {
          out.push(p);
          break;
        }
      }
    }
  }
  return out;
}

const GLOBAL_NAME = /(^|\/)(globals?|index|app|main|style|styles|base|reset|theme|themes|tokens|variables|vars|colors|colours|palette|typography|_variables|_vars|_tokens|_colors|_theme|_base|_typography|_root|root|custom-properties|design-tokens)\.(css|scss|sass|less)$/i;

/**
 * Files that define the look of the whole app. Returns
 * [{ abs, rel, kind: 'global-css'|'tokens'|'tailwind-config'|'tailwind-css'|'theme'|'global-styles', why }]
 * ordered by how central they are (at most `max`).
 */
function themeFiles(root, max = 8) {
  return cached(root, 'theme:' + max, () => {
    const out = [];
    const add = (abs, kind, why) => {
      if (!abs || out.some((f) => f.abs === abs)) return;
      if (/[\\/]node_modules[\\/]/.test(abs)) return;
      out.push({ abs, rel: rel(root, abs), kind, why });
    };
    const kindOfSheet = (abs, code) => {
      if (/@import\s+["']tailwindcss|@theme\b|@tailwind\s+base/.test(code || '')) return 'tailwind-css';
      if (/(^|[\\/])_?(variables|vars|tokens|colors|colours|palette|theme|themes|design-tokens|custom-properties)\.(scss|sass|less|css)$/i.test(abs)) return 'tokens';
      return 'global-css';
    };

    // 1. stylesheets the entry files import, and configured global styles
    const entries = entryFiles(root);
    for (const e of entries) {
      const code = read(e);
      if (!code) continue;
      for (const s of importedStyles(root, e, code)) {
        if (/\.module\.(css|scss|sass|less)$/.test(s)) continue;
        add(s, kindOfSheet(s, read(s)), `imported by ${rel(root, e)} (global stylesheet)`);
      }
    }
    for (const s of configuredStyles(root)) add(s, kindOfSheet(s, read(s)), 'global stylesheet in the framework config');

    // 2. well-known global / token stylesheets anywhere in the source
    const all = files(root);
    const sheets = all.filter((f) => STYLE.test(f) && !/\.module\.(css|scss|sass|less)$/.test(f));
    for (const s of sheets) {
      const code = read(s) || '';
      if (/@import\s+["']tailwindcss|@theme\b|@tailwind\s+base/.test(code)) add(s, 'tailwind-css', 'Tailwind entry stylesheet');
    }
    for (const s of sheets) {
      if (!GLOBAL_NAME.test(toPosix(s))) continue;
      const code = read(s) || '';
      add(s, kindOfSheet(s, code), /:root\s*\{|^\s*\$[\w-]+\s*:|^\s*@[\w-]+\s*:/m.test(code) ? 'defines design tokens (variables)' : 'global stylesheet');
    }
    // 3. stylesheets that define :root custom properties / many $ or @ variables
    for (const s of sheets) {
      if (out.length >= max * 2) break;
      const code = read(s) || '';
      const vars = (code.match(/^\s*(?:--[\w-]+|\$[\w-]+|@[\w-]+)\s*:/gm) || []).length;
      if (/:root\s*\{/.test(code) && vars >= 3) add(s, 'tokens', `defines ${vars} variables in :root`);
      else if (vars >= 8) add(s, 'tokens', `defines ${vars} Sass/Less variables`);
    }

    // 4. Tailwind config
    for (const n of ['tailwind.config.ts', 'tailwind.config.js', 'tailwind.config.mjs', 'tailwind.config.cjs']) {
      const abs = path.join(root, n);
      if (isFile(abs)) add(abs, 'tailwind-config', 'Tailwind theme (colors, fonts, radius…)');
    }

    // 5. CSS-in-JS / component-library themes and global styles
    const scripts = all.filter((f) => /\.(jsx?|tsx?|mjs)$/.test(f));
    const themeHits = [];
    for (const f of scripts) {
      const code = read(f);
      if (!code || code.length > 60000) continue;
      const score =
        (/\bcreateGlobalStyle\s*`/.test(code) ? 5 : 0) +
        (/<Global\b[^>]*styles\s*=/.test(code) ? 4 : 0) +
        (/\b(createTheme|extendTheme|createStitches|createThemeContract|createGlobalTheme)\s*\(/.test(code) ? 5 : 0) +
        (/\b(?:export\s+)?(?:const|let)\s+(?:\w*[tT]heme\w*|tokens|colors|palette)\s*(?::[^=]+)?=\s*\{/.test(code) && /\b(colou?rs?|palette|primary|background|fonts?)\b/.test(code) ? 4 : 0) +
        (/\bDefaultTheme\b/.test(code) && /declare\s+module/.test(code) ? 2 : 0) +
        (/<ThemeProvider\b/.test(code) ? 2 : 0) +
        (/(^|[\\/])(theme|themes|tokens|GlobalStyles?|global-?styles?|styles)(\.\w+)?\.(jsx?|tsx?)$/i.test(f) ? 2 : 0);
      if (score >= 4) themeHits.push({ f, score, global: /\bcreateGlobalStyle\s*`|<Global\b/.test(code) });
    }
    themeHits.sort((a, b) => b.score - a.score);
    for (const h of themeHits.slice(0, 4)) add(h.f, h.global ? 'global-styles' : 'theme', h.global ? 'global styles (createGlobalStyle / <Global>)' : 'theme object (ThemeProvider / createTheme / tokens)');

    // Order: Tailwind config & @theme CSS, tokens, theme objects, global CSS, global styles.
    const rank = { 'tailwind-config': 0, 'tailwind-css': 1, tokens: 2, theme: 3, 'global-css': 4, 'global-styles': 5 };
    return out.sort((a, b) => rank[a.kind] - rank[b.kind]).slice(0, max);
  });
}

/** The first global stylesheet the app loads — where previewed CSS can always be written as a last resort. */
function globalStylesheet(root) {
  const t = themeFiles(root, 12);
  const pick = t.find((f) => f.kind === 'tailwind-css') || t.find((f) => f.kind === 'global-css' && /\.(css|scss|less)$/.test(f.abs)) || t.find((f) => f.kind === 'tokens' && /\.(css|scss|less)$/.test(f.abs));
  return pick ? pick.abs : null;
}

// ---------------------------------------------------------------------------------------------
// layouts and pages
// ---------------------------------------------------------------------------------------------

const OUTLET_RX = /\{\s*(?:props\.)?children\s*\}|\{@render\s+children|<Outlet\b|<slot\s*\/?>|<slot\b[^>]*name=["']default|<router-outlet|<RouterView\b|<router-view\b|<NuxtPage\b|<nuxt-page\b|<Slot\s*\/>|<\s*Component\s+\{\.\.\.pageProps\}/;

/** Does this file render the page outlet (it is a layout / app shell that wraps every page)? */
function isLayout(abs, code) {
  if (/(^|[\\/])(layout|_app|\+layout|__root|root|App|app|default|_layout)\.(tsx|jsx|ts|js|vue|svelte|astro)$/.test(abs) && OUTLET_RX.test(code || '')) return true;
  if (/(^|[\\/])layouts?[\\/]/.test(abs) && OUTLET_RX.test(code || '')) return true;
  // A shell component (<Layout>, <Shell>, <AppFrame>) that renders children around page content.
  return /\b(Layout|Shell|Frame|Scaffold|Wrapper|Container)\b/.test(path.basename(abs)) && /\{\s*(?:props\.)?children\s*\}|<Outlet\b|<slot\b|<RouterView\b|<router-view\b/.test(code || '');
}

const escRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The route file that renders `pathname` in file-based routers (Next.js app / pages, SvelteKit, Nuxt, Remix flat
 * routes, Astro) — or, for routing in code, the component a route entry points at. Returns abs path or null.
 */
function pageForPath(root, pathname) {
  if (typeof pathname !== 'string') return null;
  const clean = pathname.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  const segs = clean.split('/').filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  const all = files(root).map((f) => ({ abs: f, rel: rel(root, f) }));
  const segMatch = (fsSegs, urlSegs) => {
    // route groups (marketing), parallel @slots and [locale]-style params are handled; catch-alls take the rest
    const fsS = fsSegs.filter((s) => !/^\(.*\)$/.test(s) && !/^@/.test(s));
    let i = 0;
    for (let j = 0; j < fsS.length; j++) {
      const s = fsS[j];
      if (/^\[\[?\.\.\./.test(s) || /^\[\.\.\./.test(s) || /^\[\.\.\.\w*\]$/.test(s) || s === '$' || /^\[\.\.\.[\w]+\]$/.test(s)) return true;
      if (/^\[\[.*\]\]$/.test(s)) {
        if (i < urlSegs.length) i++;
        continue;
      }
      if (i >= urlSegs.length) return false;
      if (/^\[.*\]$/.test(s) || /^\$/.test(s) || /^:/.test(s)) {
        i++;
        continue;
      }
      if (s.toLowerCase() !== urlSegs[i].toLowerCase()) return false;
      i++;
    }
    return i === urlSegs.length;
  };
  const score = (fsSegs) => fsSegs.filter((s) => !/^[[$(@:]/.test(s)).length * 10 - fsSegs.filter((s) => /^\[/.test(s)).length;
  const candidates = [];
  for (const f of all) {
    let m;
    if ((m = f.rel.match(/^(?:src\/)?app\/(.*?)\/?page\.(tsx|jsx|js|ts|mdx)$/))) candidates.push({ abs: f.abs, segs: m[1] ? m[1].split('/') : [] });
    else if ((m = f.rel.match(/^(?:src\/)?pages\/(.*)\.(tsx|jsx|js|ts|vue|astro|md|mdx)$/)) && !/^(_app|_document|_error|api\/)/.test(m[1])) {
      const s = m[1].split('/');
      if (s[s.length - 1] === 'index') s.pop();
      candidates.push({ abs: f.abs, segs: s });
    } else if ((m = f.rel.match(/^src\/routes\/(.*?)\/?\+page\.svelte$/))) candidates.push({ abs: f.abs, segs: m[1] ? m[1].split('/') : [] });
    else if ((m = f.rel.match(/^app\/pages\/(.*)\.vue$/))) {
      const s = m[1].split('/');
      if (s[s.length - 1] === 'index') s.pop();
      candidates.push({ abs: f.abs, segs: s });
    } else if ((m = f.rel.match(/^app\/routes\/([^/]+)\.(tsx|jsx|ts|js)$/)) && !/^_|\.(server|client)$/.test(m[1])) {
      // Remix flat routes: blog.$slug.tsx, _index.tsx
      const s = m[1].split('.').filter((x) => x !== '_index' && !x.startsWith('_'));
      candidates.push({ abs: f.abs, segs: m[1] === '_index' ? [] : s });
    }
  }
  const hits = candidates.filter((c) => segMatch(c.segs, segs)).sort((a, b) => score(b.segs) - score(a.segs));
  if (hits.length) return hits[0].abs;

  // Routing in code: { path: '/about', element: <About /> } / <Route path="/about" element={<About/>} /> / component: About
  const want = '/' + segs.join('/');
  for (const f of all) {
    if (!/\.(jsx?|tsx?)$/.test(f.abs)) continue;
    const code = read(f.abs);
    if (!code || !/\bpath\s*[:=]\s*\{?\s*['"`]/.test(code)) continue;
    const pathRx = new RegExp(`path\\s*[:=]\\s*\\{?\\s*['"\`]/?${escRx(want.slice(1))}['"\`]`);
    const m = pathRx.exec(code);
    if (!m) continue;
    const near = code.slice(m.index, m.index + 300);
    const comp = (near.match(/(?:element|component|Component)\s*[:=]\s*\{?\s*<?\s*([A-Z][\w$]*)/) || [])[1];
    if (!comp) continue;
    const imp = code.match(new RegExp(`import\\s+(?:${escRx(comp)}|\\{[^}]*\\b${escRx(comp)}\\b[^}]*\\})\\s+from\\s+['"]([^'"]+)['"]`)) || code.match(new RegExp(`${escRx(comp)}\\s*=\\s*(?:React\\.)?lazy\\(\\s*\\(\\)\\s*=>\\s*import\\(\\s*['"]([^'"]+)['"]`));
    if (imp) {
      const target = resolveScript(root, f.abs, imp[1]);
      if (target) return target;
    }
  }
  return null;
}

/** Folders where shared components live, best first. */
function componentDirs(root) {
  return ['src/components', 'components', 'app/components', 'src/lib/components', 'src/app/components', 'src/ui', 'src/shared/components', 'src/common/components']
    .map((d) => path.join(root, d))
    .filter(isDir);
}

module.exports = { files, tree, stats, themeFiles, globalStylesheet, entryFiles, isLayout, pageForPath, componentDirs, aliases, OUTLET_RX };
