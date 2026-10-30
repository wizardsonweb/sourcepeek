'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { ensureServer } = require('./server/standalone.cjs');
const { enabled, prodToken } = require('./server/env.cjs');

const LOADER = path.join(__dirname, 'next-loader.cjs');
const DEV_PHASE = 'phase-development-server';
const BUILD_PHASE = 'phase-production-build';
const SERVER_PHASE = 'phase-production-server';

function nextMajorMinor(root) {
  try {
    const v = createRequire(path.join(root, 'package.json'))('next/package.json').version;
    const [maj, min] = v.split('.').map(Number);
    return { maj, min };
  } catch {
    return { maj: 15, min: 3 };
  }
}

function addTurbopackRules(config, root) {
  const loader = { loader: LOADER, options: { root } };
  const rules = {
    // No `as:` — the loader returns the same language it gets. `as: '*.tsx'` made Turbopack rename every
    // module to `x.tsx.tsx`, which broke imports written with an explicit extension ('./Foo.tsx').
    '*.tsx': { loaders: [loader] },
    '*.jsx': { loaders: [loader] },
  };
  const { maj, min } = nextMajorMinor(root);
  if (maj > 15 || (maj === 15 && min >= 3)) {
    config.turbopack = config.turbopack || {};
    config.turbopack.rules = { ...rules, ...(config.turbopack.rules || {}) };
  } else {
    config.experimental = config.experimental || {};
    config.experimental.turbo = config.experimental.turbo || {};
    config.experimental.turbo.rules = { ...rules, ...(config.experimental.turbo.rules || {}) };
  }
}

function addWebpackLoader(config, root, always) {
  const userWebpack = config.webpack;
  config.webpack = (wc, ctx) => {
    if (ctx.dev || always) {
      wc.module.rules.unshift({
        test: /\.(jsx|tsx|js|mjs)$/,
        exclude: /[\\/]node_modules[\\/]/,
        enforce: 'pre',
        use: [{ loader: LOADER, options: { root } }],
      });
    }
    return typeof userWebpack === 'function' ? userWebpack(wc, ctx) : wc;
  };
}

function addRewrite(config, destination) {
  const rule = { source: '/__sourcepeek/:path*', destination };
  const userRewrites = config.rewrites;
  config.rewrites = async () => {
    const r = typeof userRewrites === 'function' ? await userRewrites() : [];
    if (Array.isArray(r)) return { beforeFiles: [rule], afterFiles: r, fallback: [] };
    return { ...r, beforeFiles: [rule, ...(r.beforeFiles || [])] };
  };
}

const ROUTE_FILES = [
  'app/api/sourcepeek/[...path]/route.js',
  'app/api/sourcepeek/[...path]/route.ts',
  'app/api/sourcepeek/[...path]/route.mjs',
  'src/app/api/sourcepeek/[...path]/route.js',
  'src/app/api/sourcepeek/[...path]/route.ts',
  'src/app/api/sourcepeek/[...path]/route.mjs',
  'pages/api/sourcepeek/[...path].js',
  'pages/api/sourcepeek/[...path].ts',
  'src/pages/api/sourcepeek/[...path].js',
  'src/pages/api/sourcepeek/[...path].ts',
];

function findRouteFile(root) {
  return ROUTE_FILES.find((f) => fs.existsSync(path.join(root, f))) || null;
}

const SKIP_DIRS = new Set(['node_modules', 'public', 'out', 'dist', 'build', 'coverage']);

function sourceGlobs(root) {
  let dirs = [];
  try {
    dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !SKIP_DIRS.has(d.name))
      .map((d) => d.name);
  } catch {}
  return dirs.map((d) => `./${d}/**/*.{js,jsx,ts,tsx,mjs,vue,svelte}`);
}

function addSourceTracing(config, root) {
  const globs = sourceGlobs(root);
  if (!globs.length) return;
  const { maj } = nextMajorMinor(root);
  const holder = maj >= 15 ? config : (config.experimental = config.experimental || {});
  const current = holder.outputFileTracingIncludes || {};
  const key = '/api/sourcepeek/**';
  holder.outputFileTracingIncludes = { ...current, [key]: [...(current[key] || []), ...globs] };
}

function withSourcepeek(userConfig = {}) {
  return async function sourcepeekNextConfig(phase, ctx) {
    const config = typeof userConfig === 'function' ? await userConfig(phase, ctx) : { ...userConfig };
    if (process.env.SOURCEPEEK_DISABLE) return config;
    const root = process.cwd();
    const dev = phase === DEV_PHASE;
    // `next dev`: always (SOURCEPEEK_DISABLE=1 turns it off). Production builds: only with SOURCEPEEK_ENABLE_PROD=1,
    // and the deployed backend answers only after unlocking with SOURCEPEEK_TOKEN.
    if (!enabled(root, { dev, mode: dev ? 'development' : 'production' })) return config;
    const prod = phase === BUILD_PHASE || phase === SERVER_PHASE;
    if (!dev && !prod) return config;
    if (phase === BUILD_PHASE && !prodToken(root).token) {
      console.warn('[sourcepeek] SOURCEPEEK_ENABLE_PROD=1 but SOURCEPEEK_TOKEN is missing or shorter than 16 characters — the deployed backend will stay closed until it is set.');
    }

    if (dev) {
      try {
        addRewrite(config, `http://127.0.0.1:${await ensureServer(root)}/__sourcepeek/:path*`);
      } catch (err) {
        console.warn('[sourcepeek] backend not started:', err.message);
      }
    } else {
      addRewrite(config, '/api/sourcepeek/:path*');
      if (phase === BUILD_PHASE) {
        addSourceTracing(config, root);
        if (!findRouteFile(root)) {
          console.warn('[sourcepeek] the production backend route is missing, so Sourcepeek will stay hidden in this build. Run: npx sourcepeek setup');
        }
      }
    }
    if (phase !== SERVER_PHASE) {
      addWebpackLoader(config, root, prod);
      addTurbopackRules(config, root);
    }
    return config;
  };
}

module.exports = withSourcepeek;
module.exports.withSourcepeek = withSourcepeek;
module.exports.default = withSourcepeek;
