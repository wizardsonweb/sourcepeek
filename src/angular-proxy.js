// Angular CLI dev server: `ng serve` has no plugin hook for a backend, but it loads a proxy configuration file.
// sourcepeek.proxy.mjs (written by `npx sourcepeek setup`) calls sourcepeekProxy(): it starts the Sourcepeek backend on a
// localhost port and returns your proxy configuration plus a rule that forwards /__sourcepeek/* to that port.
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import standaloneMod from './server/standalone.cjs';

const { ensureServer } = standaloneMod;

async function loadExisting(config, root) {
  if (!config) return {};
  if (typeof config !== 'string') return config;
  const abs = path.resolve(root, config);
  if (!fs.existsSync(abs)) {
    console.warn(`[sourcepeek] proxy configuration ${config} not found — using only the Sourcepeek proxy.`);
    return {};
  }
  if (abs.endsWith('.json')) {
    const text = fs.readFileSync(abs, 'utf8').replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || '').replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(text);
  }
  const mod = await import(pathToFileURL(abs).href);
  return mod && 'default' in mod ? mod.default : mod;
}

/**
 * @param {object|Array|string} [existing] your own proxy configuration, or the path of its file (JSON or JS).
 * @returns the proxy configuration for the Angular CLI (`proxyConfig` in angular.json).
 */
export async function sourcepeekProxy(existing) {
  const root = process.cwd();
  let base = {};
  try {
    base = (await loadExisting(existing, root)) || {};
  } catch (err) {
    console.warn(`[sourcepeek] could not read the proxy configuration ${existing}: ${err.message}`);
  }
  if (process.env.SOURCEPEEK_DISABLE) return base;
  let port;
  try {
    port = await ensureServer(root);
  } catch (err) {
    console.warn('[sourcepeek] backend not started:', err.message);
    return base;
  }
  // xfwd: the backend sees the browser's address, so "Apply to code" can stay limited to this computer.
  const rule = { target: `http://127.0.0.1:${port}`, secure: false, changeOrigin: false, xfwd: true };
  if (Array.isArray(base)) return [{ context: ['/__sourcepeek'], ...rule }, ...base];
  return { '/__sourcepeek': rule, ...base };
}

export default sourcepeekProxy;
