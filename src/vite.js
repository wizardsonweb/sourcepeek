import { createRequire } from 'module';
import path from 'path';
import transformMod from './transform.cjs';
import handlerMod from './server/handler.cjs';
import envMod from './server/env.cjs';
import { HOOK_SOURCE } from './client/reactHook.js';

const { transform, createVueNodeTransform } = transformMod;
const { createHandler } = handlerMod;
const { enabled } = envMod;

export default function sourcepeek() {
  let root = process.cwd();
  let vueHooked = false;
  let compilerSfc = null;
  let usesReact = false;

  return {
    name: 'sourcepeek',
    enforce: 'pre',
    // Always on the dev server (SOURCEPEEK_DISABLE=1 turns it off). Production builds and `vite preview` only with
    // SOURCEPEEK_ENABLE_PROD=1 — and the backend there answers only after unlocking with SOURCEPEEK_TOKEN.
    apply(config, env) {
      const r = path.resolve(config.root || process.cwd());
      const dev = env.command === 'serve' && !env.isPreview;
      return enabled(r, { dev, mode: env.mode || (dev ? 'development' : 'production') });
    },

    configResolved(config) {
      root = config.root;
      try {
        const req = createRequire(root + '/package.json');
        const pkg = req('./package.json');
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        usesReact = Boolean(deps.react || deps['react-dom'] || deps.preact);
      } catch {}
      const vuePlugin = config.plugins.find((p) => p && p.name === 'vite:vue');
      if (vuePlugin && vuePlugin.api && vuePlugin.api.options) {
        const opts = vuePlugin.api.options;
        opts.template = opts.template || {};
        opts.template.compilerOptions = opts.template.compilerOptions || {};
        const nt = opts.template.compilerOptions.nodeTransforms || [];
        opts.template.compilerOptions.nodeTransforms = [...nt, createVueNodeTransform(() => root)];
        vuePlugin.api.options = opts;
        vueHooked = true;
      } else if (vuePlugin) {
        try {
          compilerSfc = createRequire(root + '/package.json')('vue/compiler-sfc');
        } catch {}
      }
    },

    configureServer(server) {
      server.middlewares.use(createHandler({ root: () => root, dev: true }));
    },

    configurePreviewServer(server) {
      server.middlewares.use(createHandler({ root: () => root }));
    },

    // "Renders & state" counts React commits through the DevTools hook, which must exist before react-dom loads.
    transformIndexHtml() {
      if (!usesReact) return [];
      return [{ tag: 'script', children: HOOK_SOURCE, injectTo: 'head-prepend' }];
    },

    transform(code, id) {
      if (id.includes('?')) return null;
      if (id.endsWith('.vue') && vueHooked) return null;
      return transform(code, id, root, { compilerSfc });
    },
  };
}

export { sourcepeek };
