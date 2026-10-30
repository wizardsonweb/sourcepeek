'use strict';
// AI spend tracking: every completion's token usage is added up per provider + model and kept in
// <root>/.sourcepeek/usage.json, so the "$" button in the More view can show what the current model has cost.
const fs = require('fs');
const path = require('path');
const { readEnv } = require('./env.cjs');

const FILE = path.join('.sourcepeek', 'usage.json');

// USD per 1M tokens [input, output]. First match wins, so more specific patterns come first.
// Override with SOURCEPEEK_AI_PRICE="input,output" (USD per 1M tokens) for any other model or a negotiated rate.
const PRICES = [
  [/^claude-haiku-5-5/, 0.1, 0.5],
  [/^gemini-3\.8-flash/, 0.375, 1.875],
  [/^gpt-4\.1-mini/, 0.4, 1.6],
];

const cache = new Map(); // root → data

function file(root) {
  return path.join(root, FILE);
}

function load(root) {
  if (cache.has(root)) return cache.get(root);
  let data = { models: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file(root), 'utf8'));
    if (parsed && typeof parsed.models === 'object') data = parsed;
  } catch {}
  cache.set(root, data);
  return data;
}

function save(root, data) {
  try {
    const dir = path.join(root, '.sourcepeek');
    fs.mkdirSync(dir, { recursive: true });
    const ignore = path.join(dir, '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '# Sourcepeek local data — not for git\n*\n');
    fs.writeFileSync(file(root), JSON.stringify(data, null, 2));
  } catch {}
}

const keyOf = (p) => `${p.id}|${p.model}`;
const num = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0);

/** Price per 1M tokens for this provider/model, or null when unknown. */
function priceFor(root, p) {
  const env = String(readEnv(root, 'SOURCEPEEK_AI_PRICE') || '').trim();
  if (env) {
    const [i, o] = env.split(/[,\s/]+/).map(Number);
    if (isFinite(i) && isFinite(o)) return { input: i, output: o, source: 'env' };
  }
  if (p.local) return { input: 0, output: 0, source: 'local' };
  const hit = PRICES.find(([re]) => re.test(String(p.model || '')));
  return hit ? { input: hit[1], output: hit[2], source: 'table' } : null;
}

/**
 * Record one response. `u` = { input, output, cacheRead, cacheWrite, cost } — cost only when the provider reports it
 * (OpenRouter). Never throws: tracking must not break an AI call.
 */
function record(root, p, u) {
  if (!root || !p || !u) return;
  try {
    const data = load(root);
    const k = keyOf(p);
    const m = (data.models[k] = data.models[k] || {
      provider: p.id,
      label: p.label,
      model: p.model,
      since: new Date().toISOString(),
      calls: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      unpriced: 0,
    });
    const input = num(u.input);
    const output = num(u.output);
    const cacheRead = num(u.cacheRead);
    const cacheWrite = num(u.cacheWrite);
    m.calls += 1;
    m.input += input;
    m.output += output;
    m.cacheRead += cacheRead;
    m.cacheWrite += cacheWrite;
    m.label = p.label;
    m.last = new Date().toISOString();
    if (typeof u.cost === 'number' && isFinite(u.cost)) {
      m.cost += u.cost;
      m.reported = true;
    } else {
      const price = priceFor(root, p);
      // Cache reads ≈ 10% of input, cache writes ≈ 125% (Anthropic's ratios; a fair estimate elsewhere).
      if (price) m.cost += (input * price.input + output * price.output + cacheRead * price.input * 0.1 + cacheWrite * price.input * 1.25) / 1e6;
      else m.unpriced += 1;
    }
    save(root, data);
  } catch {}
}

function publicEntry(m) {
  return {
    provider: m.provider,
    label: m.label,
    model: m.model,
    since: m.since,
    last: m.last || null,
    calls: m.calls,
    input: m.input,
    output: m.output,
    cacheRead: m.cacheRead,
    cacheWrite: m.cacheWrite,
    cost: m.cost,
    // Some calls were made before a price was known: the dollar figure leaves those out.
    partial: m.unpriced > 0 && m.unpriced < m.calls,
    priced: m.unpriced < m.calls,
  };
}

/** Spend for the model in use now (`p` from providers.resolve), plus the total across every model used. */
function summary(root, p) {
  const data = load(root);
  const all = Object.values(data.models);
  const m = p && data.models[keyOf(p)];
  const price = p ? priceFor(root, p) : null;
  return {
    current: p
      ? {
          ...(m
            ? publicEntry(m)
            : { provider: p.id, label: p.label, model: p.model, since: null, last: null, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, partial: false, priced: Boolean(price) }),
          price: price && price.source !== 'local' ? { input: price.input, output: price.output, source: price.source } : null,
          local: Boolean(p.local),
          reported: Boolean(m && m.reported),
        }
      : null,
    total: all.reduce((s, x) => s + (x.cost || 0), 0),
    models: all.length,
  };
}

function reset(root, p) {
  const data = load(root);
  if (p) delete data.models[keyOf(p)];
  else data.models = {};
  save(root, data);
}

module.exports = { record, summary, reset, priceFor, PRICES };
