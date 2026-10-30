'use strict';
// "Change with AI" → New page / route. A new page has to live where the project's router looks for pages, which is
// almost never the clicked component's folder:
//   • file-based routing — Next.js (app/ or pages/), SvelteKit (src/routes), Nuxt (pages/), Remix / React Router 7
//     (app/routes), TanStack Router (src/routes with __root): the page is a new file at the right path.
//   • routing in code — React Router, Vue Router, Angular, TanStack (code-based), wouter: the page is a new file in
//     the pages/views folder AND an entry in the router file, which therefore becomes one of the editable files.
// detect() works out which one applies; check() makes sure the AI's change really adds a route.

const fs = require('fs');
const path = require('path');
const angular = require('./angular.cjs');

const SCRIPT = /\.(jsx|tsx|js|mjs|ts)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.nuxt', '.output', '.svelte-kit', 'dist', 'build', 'out', 'coverage', '.turbo', '.vercel', '.angular']);

const toPosix = (p) => p.split(path.sep).join('/');

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''));
  } catch {
    return null;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Files under dir (relative, posix), at most `depth` levels deep and `limit` entries. */
function walk(dir, { depth = 4, limit = 400, filter = () => true } = {}) {
  const out = [];
  const go = (d, level) => {
    if (out.length >= limit || level > depth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.name.startsWith('.') && e.name !== '.') continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) go(abs, level + 1);
      } else if (filter(abs)) out.push(abs);
    }
  };
  go(dir, 0);
  return out;
}

function deps(root) {
  const pkg = readJson(path.join(root, 'package.json')) || {};
  return { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
}

function usesTs(root) {
  return isFile(path.join(root, 'tsconfig.json'));
}

/** The `@/` (or `~/`) alias the project has configured, if any. */
function aliasHint(root) {
  for (const f of ['tsconfig.json', 'jsconfig.json']) {
    const j = readJson(path.join(root, f));
    const p = j && j.compilerOptions && j.compilerOptions.paths;
    if (!p) continue;
    for (const [k, v] of Object.entries(p)) {
      if (k.endsWith('/*') && Array.isArray(v) && v[0]) return `${k.slice(0, -1)} → ${v[0].replace(/\*$/, '')}`;
    }
  }
  return null;
}

/** Most common extension among files, or fallback. */
function commonExt(files, fallback) {
  const n = new Map();
  for (const f of files) {
    const e = path.extname(f);
    n.set(e, (n.get(e) || 0) + 1);
  }
  let best = fallback;
  let max = 0;
  for (const [e, c] of n) if (c > max) (best = e), (max = c);
  return best;
}

const firstDir = (root, ...cands) => cands.map((c) => path.join(root, c)).find(isDir) || null;
const rel = (root, abs) => toPosix(path.relative(root, abs)) || '.';

function componentsDir(root, ...extra) {
  return firstDir(root, ...extra, 'src/components', 'components', 'app/components', 'src/lib/components', 'src/app/components');
}

function listRoutes(root, dir, re, max = 25) {
  return walk(dir, { depth: 5, limit: 300, filter: (f) => re.test(f) })
    .map((f) => rel(root, f))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
    .slice(0, max);
}

// ---------------------------------------------------------------------------------------------
// routing in code: find the file that declares the routes
// ---------------------------------------------------------------------------------------------

const ROUTER_RX = {
  react: /\bcreate(?:Browser|Hash|Memory)Router\s*\(|<Routes\b|<Route\b|\buseRoutes\s*\(|createRoutesFromElements|<Switch\b|\bcreateRoute\s*\(|\bcreateRootRoute\s*\(/g,
  vue: /\bcreateRouter\s*\(|\broutes\s*:\s*\[|RouteRecordRaw/g,
  angular: /\bRoutes\b|RouterModule\.for(?:Root|Child)\s*\(|provideRouter\s*\(/g,
};

/** The source file with the most router declarations in it (src/ first, then the root). */
function findRouterFile(root, flavor) {
  const rx = ROUTER_RX[flavor];
  const named = /(^|[\\/])(router|routes|routing|app[.-]routes|app-routing\.module|App|main|index)\.(jsx|tsx|js|mjs|ts)$/;
  const base = isDir(path.join(root, 'src')) ? path.join(root, 'src') : root;
  const files = walk(base, { depth: 5, limit: 600, filter: (f) => SCRIPT.test(f) && !/\.(test|spec|stories|d)\.\w+$/.test(f) });
  let best = null;
  for (const f of files) {
    let code;
    try {
      if (fs.statSync(f).size > 80000) continue;
      code = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const hits = (code.match(rx) || []).length;
    if (!hits) continue;
    // a file that lists routes beats one that only mounts <RouterProvider router={router} />
    const routeEntries = (code.match(/\bpath\s*[:=]\s*['"`]/g) || []).length;
    const score = hits + routeEntries * 2 + (named.test(f) ? 1 : 0);
    if (!best || score > best.score) best = { abs: f, score };
  }
  return best ? best.abs : null;
}

// ---------------------------------------------------------------------------------------------
// detection
// ---------------------------------------------------------------------------------------------

/**
 * How a new page is added to this project.
 * Returns { ok, mode: 'fs'|'config', framework, label, dirs: [abs], routerFiles: [abs], routeDir, routeFile: RegExp,
 *           example, rules: [...] } — or { ok: false, reason }.
 */
function detect(root) {
  const d = deps(root);
  const has = (n) => Object.prototype.hasOwnProperty.call(d, n);
  const ts = usesTs(root);
  const alias = aliasHint(root);
  const aliasRule = alias ? `The project has the import alias ${alias}; use it the way existing files do, otherwise use relative imports.` : 'Use relative imports between the new files and existing ones.';
  const fileRules = [];

  // ----- Next.js -----
  if (has('next')) {
    const appDir = firstDir(root, 'src/app', 'app');
    const pagesDir = firstDir(root, 'src/pages', 'pages');
    const appPages = appDir ? listRoutes(root, appDir, /[\\/]page\.(tsx|jsx|js|ts|mdx)$/) : [];
    const comps = componentsDir(root);
    if (appDir && (appPages.length || !pagesDir)) {
      const ext = commonExt(appPages.filter((p) => !p.endsWith('.mdx')), ts ? '.tsx' : '.jsx');
      const appRel = rel(root, appDir);
      // Route groups / [locale] segments: the new page belongs next to the existing pages.
      const home = appPages.find((p) => /\/page\.\w+$/.test(p) && p.split('/').length === appRel.split('/').length + 1);
      const nested = !home && appPages[0] ? path.posix.dirname(appPages[0]) : appRel;
      const example = `${nested}/new-page/page${ext}`;
      return {
        ok: true,
        mode: 'fs',
        framework: 'next-app',
        label: 'Next.js App Router',
        dirs: [appDir, comps || appDir],
        routerFiles: [],
        routeDir: appDir,
        routeFile: /(^|[\\/])page\.(tsx|jsx|js|ts)$/,
        example,
        rules: [
          `This is the Next.js App Router (file-based routing). A new route is a FOLDER under ${appRel}/ holding a page${ext} file with a default-exported React component: ${example} is served at /new-page. There is no router config to edit.`,
          appPages.length ? `Existing pages: ${appPages.join(', ')}. Put the new one at the same level as the others (inside the same route group or [segment] folder if they all live in one).` : `There are no pages yet besides the root layout; create ${appRel}/<route>/page${ext}.`,
          'page files are Server Components by default: do not use hooks, event handlers or browser APIs in them. Interactive parts go in a separate component file whose first line is "use client";.',
          'Do not create layout, loading or error files unless asked — the root layout already wraps the new page.',
          `New reusable components go in ${comps ? rel(root, comps) + '/' : `${appRel}/ (e.g. ${appRel}/new-page/Hello${ext})`}, then are imported into the page. ${aliasRule}`,
        ],
      };
    }
    if (pagesDir) {
      const pages = listRoutes(root, pagesDir, /\.(tsx|jsx|js|ts)$/).filter((p) => !/\/(api)\//.test(p));
      const ext = commonExt(pages, ts ? '.tsx' : '.jsx');
      const pRel = rel(root, pagesDir);
      const example = `${pRel}/new-page${ext}`;
      return {
        ok: true,
        mode: 'fs',
        framework: 'next-pages',
        label: 'Next.js Pages Router',
        dirs: [pagesDir, comps || path.dirname(pagesDir)],
        routerFiles: [],
        routeDir: pagesDir,
        routeFile: /(^|[\\/])(?!_)[^\\/]+\.(tsx|jsx|js|ts)$/,
        routeExclude: /[\\/]api[\\/]/,
        example,
        rules: [
          `This is the Next.js Pages Router (file-based routing). A new route is a file under ${pRel}/ with a default-exported React component: ${example} is served at /new-page (or ${pRel}/new-page/index${ext}). There is no router config to edit. Never put components that are not pages in ${pRel}/.`,
          pages.length ? `Existing pages: ${pages.join(', ')}.` : '',
          `New reusable components go in ${comps ? rel(root, comps) + '/' : 'a components/ folder next to ' + pRel + '/'} and are imported into the page. ${aliasRule}`,
        ].filter(Boolean),
      };
    }
  }

  // ----- SvelteKit -----
  if (has('@sveltejs/kit')) {
    const routesDir = path.join(root, 'src', 'routes');
    const pages = isDir(routesDir) ? listRoutes(root, routesDir, /\+page\.svelte$/) : [];
    const lib = firstDir(root, 'src/lib/components', 'src/lib') || path.join(root, 'src', 'lib');
    return {
      ok: true,
      mode: 'fs',
      framework: 'sveltekit',
      label: 'SvelteKit',
      dirs: [routesDir, lib],
      routerFiles: [],
      routeDir: routesDir,
      routeFile: /\+page\.svelte$/,
      example: 'src/routes/new-page/+page.svelte',
      rules: [
        'This is SvelteKit (file-based routing). A new route is a FOLDER under src/routes/ with a +page.svelte file: src/routes/new-page/+page.svelte is served at /new-page. There is no router config to edit.',
        pages.length ? `Existing pages: ${pages.join(', ')}. Put the new one next to them (inside the same (group) folder if they all use one).` : '',
        `New reusable components go in ${rel(root, lib)}/ and are imported with the $lib alias and the .svelte extension (import Hello from '$lib/${path.relative(path.join(root, 'src', 'lib'), lib) ? toPosix(path.relative(path.join(root, 'src', 'lib'), lib)) + '/' : ''}Hello.svelte').`,
        'Do not create +page.js / +page.server.js / +layout files unless the request needs data loading or a layout.',
      ].filter(Boolean),
    };
  }

  // ----- Nuxt -----
  if (has('nuxt') || has('nuxt3')) {
    const appBase = isDir(path.join(root, 'app')) && (isFile(path.join(root, 'app', 'app.vue')) || isDir(path.join(root, 'app', 'pages'))) ? path.join(root, 'app') : root;
    const pagesDir = path.join(appBase, 'pages');
    const pages = isDir(pagesDir) ? listRoutes(root, pagesDir, /\.vue$/) : [];
    const appVue = path.join(appBase, 'app.vue');
    const comps = path.join(appBase, 'components');
    const routerFiles = [];
    if (isFile(appVue)) {
      const code = fs.readFileSync(appVue, 'utf8');
      if (!/<NuxtPage\b|<nuxt-page\b/.test(code)) routerFiles.push(appVue);
    }
    const pRel = rel(root, pagesDir);
    return {
      ok: true,
      mode: 'fs',
      framework: 'nuxt',
      label: 'Nuxt',
      dirs: [pagesDir, comps],
      routerFiles,
      routeDir: pagesDir,
      routeFile: /\.vue$/,
      example: `${pRel}/new-page.vue`,
      rules: [
        `This is Nuxt (file-based routing). A new route is a .vue file under ${pRel}/: ${pRel}/new-page.vue is served at /new-page. There is no router config to edit.`,
        pages.length ? `Existing pages: ${pages.join(', ')}.` : `There is no ${pRel}/ folder yet: create ${pRel}/new-page.vue, and also ${pRel}/index.vue holding what app.vue shows today, so / keeps working.`,
        routerFiles.length ? `${rel(root, appVue)} does not render <NuxtPage /> yet, so no page would show: replace its page content with <NuxtPage /> (keep any layout around it) — move the current content into ${pRel}/index.vue.` : '',
        `New components go in ${rel(root, comps)}/ — Nuxt auto-imports them, so <Hello /> works in a page without an import.`,
      ].filter(Boolean),
    };
  }

  // ----- TanStack Router, file-based -----
  if (has('@tanstack/react-router')) {
    const routesDir = firstDir(root, 'src/routes', 'app/routes');
    const rootRoute = routesDir && ['__root.tsx', '__root.jsx', '__root.ts', '__root.js'].map((f) => path.join(routesDir, f)).find(isFile);
    if (rootRoute) {
      const ext = path.extname(rootRoute) === '.ts' ? '.tsx' : path.extname(rootRoute) === '.js' ? '.jsx' : path.extname(rootRoute);
      const rRel = rel(root, routesDir);
      const pages = listRoutes(root, routesDir, /\.(tsx|jsx|ts|js)$/).filter((p) => !/routeTree\.gen/.test(p));
      return {
        ok: true,
        mode: 'fs',
        framework: 'tanstack-file',
        label: 'TanStack Router (file-based)',
        dirs: [routesDir, componentsDir(root) || path.dirname(routesDir)],
        routerFiles: [],
        routeDir: routesDir,
        routeFile: /(^|[\\/])(?!__)[^\\/]+\.(tsx|jsx|ts|js)$/,
        example: `${rRel}/new-page${ext}`,
        rules: [
          `This is TanStack Router with file-based routing. A new route is a file under ${rRel}/: ${rRel}/new-page${ext} exporting  export const Route = createFileRoute('/new-page')({ component: NewPage })  (import { createFileRoute } from '@tanstack/react-router'). The route tree (routeTree.gen.ts) is regenerated by the bundler plugin — never edit it.`,
          pages.length ? `Existing route files: ${pages.join(', ')}.` : '',
          `New reusable components go in ${rel(root, componentsDir(root) || path.dirname(routesDir))}/. ${aliasRule}`,
        ].filter(Boolean),
      };
    }
  }

  // ----- Remix / React Router 7 framework mode -----
  if (has('@remix-run/react') || has('@react-router/dev')) {
    const appDir = path.join(root, 'app');
    const routesTs = ['routes.ts', 'routes.js'].map((f) => path.join(appDir, f)).find(isFile);
    const routesDir = path.join(appDir, 'routes');
    const pages = isDir(routesDir) ? listRoutes(root, routesDir, /\.(tsx|jsx|ts|js)$/) : [];
    const ext = commonExt(pages, ts ? '.tsx' : '.jsx');
    const flat = !routesTs || /flatRoutes\s*\(/.test(fs.readFileSync(routesTs, 'utf8'));
    return {
      ok: true,
      mode: flat ? 'fs' : 'config',
      framework: 'remix',
      label: has('@react-router/dev') ? 'React Router (framework mode)' : 'Remix',
      dirs: [routesDir, componentsDir(root, 'app/components') || appDir],
      routerFiles: flat ? [] : [routesTs],
      routeDir: routesDir,
      routeFile: /\.(tsx|jsx|ts|js)$/,
      example: `app/routes/new-page${ext}`,
      rules: [
        flat
          ? `Routes are files in app/routes/ (flat routes): app/routes/new-page${ext} with a default-exported component is served at /new-page (dots in the file name make nested URLs: blog.new-page${ext} → /blog/new-page).`
          : `Routes are listed in ${rel(root, routesTs)}: create app/routes/new-page${ext} (default-exported component) and add  route('new-page', 'routes/new-page${ext}')  to the list, the same way existing routes are added.`,
        pages.length ? `Existing route modules: ${pages.join(', ')}.` : '',
        `New reusable components go in ${rel(root, componentsDir(root, 'app/components') || appDir)}/. ${aliasRule}`,
      ].filter(Boolean),
    };
  }

  // ----- Angular -----
  if (angular.isAngular(root)) {
    const routerFile =
      ['src/app/app.routes.ts', 'src/app/app-routing.module.ts', 'src/app/app.routing.ts', 'src/app/routes.ts'].map((f) => path.join(root, f)).find(isFile) || findRouterFile(root, 'angular');
    if (!routerFile) return { ok: false, reason: 'This Angular app has no router set up (no app.routes.ts / app-routing.module.ts / provideRouter), so a new page has nowhere to be registered. Add routing (ng generate … or provideRouter in app.config.ts) first, or ask for a new component instead.' };
    const appDir = firstDir(root, 'src/app') || path.dirname(routerFile);
    const pagesDir = firstDir(root, 'src/app/pages', 'src/app/views', 'src/app/features') || appDir;
    return {
      ok: true,
      mode: 'config',
      framework: 'angular',
      label: 'Angular Router',
      dirs: [pagesDir, appDir],
      routerFiles: [routerFile],
      routeDir: null,
      routeFile: null,
      example: `${rel(root, pagesDir)}/new-page/new-page.component.ts`,
      rules: [
        `Routes are declared in ${rel(root, routerFile)}. Create the page as a new component in its own folder under ${rel(root, pagesDir)}/ (like \`ng generate component new-page\`), then add  { path: 'new-page', component: NewPageComponent }  (or loadComponent: () => import(…) if the other routes are lazy) to the routes array, matching the existing entries. Keep a wildcard ('**') route LAST.`,
        'Follow the naming of the existing components (with or without the "Component" suffix and *.component.* file names). The page component must be standalone unless the project uses NgModules everywhere.',
        `Smaller components the page uses go next to it (own folder each) and are added to the page's @Component imports array.`,
      ],
    };
  }

  // ----- Vue Router -----
  if (has('vue-router') || has('unplugin-vue-router')) {
    const fileBased = has('unplugin-vue-router') && isDir(path.join(root, 'src', 'pages'));
    const comps = componentsDir(root) || path.join(root, 'src', 'components');
    if (fileBased) {
      const pagesDir = path.join(root, 'src', 'pages');
      return {
        ok: true,
        mode: 'fs',
        framework: 'vue-file',
        label: 'Vue Router (file-based)',
        dirs: [pagesDir, comps],
        routerFiles: [],
        routeDir: pagesDir,
        routeFile: /\.vue$/,
        example: 'src/pages/new-page.vue',
        rules: [
          'Routes come from files in src/pages/ (unplugin-vue-router): src/pages/new-page.vue is served at /new-page. There is no route list to edit.',
          `Pages: ${listRoutes(root, pagesDir, /\.vue$/).join(', ') || '(none yet)'}.`,
          `New components go in ${rel(root, comps)}/ and are imported with their .vue extension.`,
        ],
      };
    }
    const routerFile = ['src/router/index.ts', 'src/router/index.js', 'src/router.ts', 'src/router.js', 'src/router/routes.ts', 'src/router/routes.js'].map((f) => path.join(root, f)).find(isFile) || findRouterFile(root, 'vue');
    if (routerFile) {
      const viewsDir = firstDir(root, 'src/views', 'src/pages') || path.join(root, 'src', 'views');
      return {
        ok: true,
        mode: 'config',
        framework: 'vue-router',
        label: 'Vue Router',
        dirs: [viewsDir, comps],
        routerFiles: [routerFile],
        routeDir: null,
        routeFile: null,
        example: `${rel(root, viewsDir)}/NewPageView.vue`,
        rules: [
          `Routes are declared in ${rel(root, routerFile)}. Create the page as a new single-file component in ${rel(root, viewsDir)}/ (named like the existing views there) and add a route object { path: '/new-page', name: 'new-page', component: … } to the routes array, matching how existing routes import their views (lazy  () => import('…')  or a static import). Keep a catch-all route LAST.`,
          `Components the page uses go in ${rel(root, comps)}/ and are imported with their .vue extension.`,
        ],
      };
    }
    return { ok: false, reason: 'vue-router is installed, but no router file (createRouter({ routes: [...] })) was found, so a new page has nowhere to be registered.' };
  }

  // ----- React Router / wouter / TanStack (code-based) -----
  if (has('react-router-dom') || has('react-router') || has('wouter') || has('@tanstack/react-router') || has('@reach/router')) {
    const routerFile = findRouterFile(root, 'react');
    if (!routerFile) {
      return { ok: false, reason: 'A router package is installed, but no file declares routes (createBrowserRouter, <Routes>/<Route>, useRoutes…), so a new page has nowhere to be registered. Set up the router first, or ask for a new component instead.' };
    }
    const src = isDir(path.join(root, 'src')) ? path.join(root, 'src') : root;
    const pagesDir = firstDir(root, 'src/pages', 'src/routes', 'src/views', 'src/screens', 'pages') || path.join(src, 'pages');
    const comps = componentsDir(root) || src;
    const ext = path.extname(routerFile).replace(/^\.ts$/, '.tsx').replace(/^\.js$/, '.jsx');
    const lib = has('wouter') ? 'wouter' : has('@tanstack/react-router') ? 'TanStack Router' : 'React Router';
    return {
      ok: true,
      mode: 'config',
      framework: 'react-router',
      label: lib,
      dirs: [pagesDir, comps],
      routerFiles: [routerFile],
      routeDir: null,
      routeFile: null,
      example: `${rel(root, pagesDir)}/NewPage${ext}`,
      rules: [
        `Routes are declared in ${rel(root, routerFile)} (${lib}). Create the page component in ${rel(root, pagesDir)}/ and register it there at its own path, written exactly like the existing routes (a route object { path: '/new-page', element: <NewPage /> }, a <Route path="/new-page" element={<NewPage />} />, lazy() or a static import — whatever the file already does), with its import. Keep a catch-all ("*") route LAST.`,
        `Components the page uses go in ${rel(root, comps)}/ (or next to the page if the project keeps page-only components there). ${aliasRule}`,
      ],
    };
  }

  return {
    ok: false,
    reason:
      'This project has no router — no Next.js / SvelteKit / Nuxt pages folder and no react-router, vue-router or similar set up — so a new page would have no URL. Install and set up a router first (e.g. npm i react-router-dom), or ask for a new component on the current page instead.',
  };
}

// ---------------------------------------------------------------------------------------------
// after the AI answered
// ---------------------------------------------------------------------------------------------

function inside(dir, abs) {
  const r = path.relative(dir, abs);
  return Boolean(r) && !r.startsWith('..') && !path.isAbsolute(r);
}

/** Problems with a "new page" change, phrased for the AI's retry. */
function check(routing, changes) {
  const problems = [];
  if (!routing || !routing.ok) return problems;
  const created = changes.filter((c) => c.before === null);
  if (routing.mode === 'fs') {
    const page = created.find((c) => inside(routing.routeDir, c.abs) && routing.routeFile.test(c.abs) && !(routing.routeExclude && routing.routeExclude.test(c.abs)));
    if (!page) {
      problems.push(`No route file was created, so the page would not have a URL. In this project (${routing.label}) a new page is a new file like ${routing.example} — put it in "create".`);
    }
  } else {
    if (!created.length) problems.push(`No page file was created. Create the page component (e.g. ${routing.example}) in "create".`);
    const touched = changes.some((c) => routing.routerFiles.includes(c.abs) && c.before !== null);
    if (!touched) {
      problems.push(`The new page is not registered: add its route (and import) to ${routing.routerFiles.map((f) => path.basename(f)).join(' / ')} with an "edits" entry, like the existing routes.`);
    }
  }
  return problems;
}

module.exports = { detect, check };
