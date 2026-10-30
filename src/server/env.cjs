'use strict';
const fs = require('fs');
const path = require('path');

function envFiles(mode) {
  const m = mode || (process.env.NODE_ENV === 'production' ? 'production' : 'development');
  return [`.env.${m}.local`, '.env.local', `.env.${m}`, '.env'];
}

function readEnv(root, name, mode) {
  if (process.env[name]) return process.env[name];
  for (const f of envFiles(mode)) {
    try {
      const txt = fs.readFileSync(path.join(root, f), 'utf8');
      const m = txt.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)\\s*$`, 'm'));
      if (m) {
        const v = m[1].trim();
        const q = v.match(/^(['"`])(.*)\1/);
        return q ? q[2] : v.replace(/\s+#.*$/, '').trim();
      }
    } catch {}
  }
  return null;
}

const truthy = (v) => /^(true|1|yes|on)$/i.test(String(v || '').trim());

/** SOURCEPEEK_DISABLE=1 turns Sourcepeek off everywhere: no tagging, no backend. */
function disabled(root, mode) {
  return truthy(readEnv(root, 'SOURCEPEEK_DISABLE', mode));
}

/** Production builds and servers (next build/start, vite build/preview, Vercel…) only run Sourcepeek when opted in. */
function prodOptIn(root, mode) {
  return truthy(readEnv(root, 'SOURCEPEEK_ENABLE_PROD', mode || 'production'));
}

const MIN_TOKEN = 16;

/**
 * The secret that unlocks a production backend. Required: production without a token stays off, so one forgotten
 * env var can't expose your source. Returns { token } or { error }.
 */
function prodToken(root, mode) {
  const t = String(readEnv(root, 'SOURCEPEEK_TOKEN', mode || 'production') || '').trim();
  if (!t) return { error: 'SOURCEPEEK_TOKEN is not set' };
  if (t.length < MIN_TOKEN) return { error: `SOURCEPEEK_TOKEN must be at least ${MIN_TOKEN} characters` };
  return { token: t };
}

/**
 * Is Sourcepeek on here? On the dev server: yes unless SOURCEPEEK_DISABLE=1. Anywhere else: only with
 * SOURCEPEEK_ENABLE_PROD=1 (and, for the backend to answer, a SOURCEPEEK_TOKEN).
 */
function enabled(root, { dev = false, mode } = {}) {
  if (disabled(root, mode || (dev ? 'development' : 'production'))) return false;
  return dev ? true : prodOptIn(root, mode);
}

/** Kept for older imports: production builds are on only when opted in. */
function prodEnabled(root, mode) {
  const dev = mode === 'development';
  return enabled(root, { dev, mode });
}

module.exports = { readEnv, prodEnabled, enabled, disabled, prodOptIn, prodToken, truthy, MIN_TOKEN };
