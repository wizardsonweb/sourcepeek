'use strict';
const { readEnv } = require('./env.cjs');
const usage = require('./usage.cjs');

const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    keys: ['SOURCEPEEK_OPENAI_API_KEY', 'OPENAI_API_KEY'],
    base: 'https://api.openai.com/v1',
    baseEnv: 'OPENAI_BASE_URL',
    model: 'gpt-4.1-mini',
    modelEnv: 'SOURCEPEEK_OPENAI_MODEL',
    tokenParam: 'max_completion_tokens',
    json: true,
  },
  anthropic: {
    label: 'Claude',
    kind: 'anthropic',
    keys: ['SOURCEPEEK_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
    base: 'https://api.anthropic.com/v1',
    baseEnv: 'ANTHROPIC_BASE_URL',
    model: 'claude-haiku-5-5',
  },
  gemini: {
    label: 'Gemini',
    keys: ['SOURCEPEEK_GEMINI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY'],
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3.8-flash',
    json: true,
  },
  mistral: {
    label: 'Mistral',
    keys: ['MISTRAL_API_KEY'],
    base: 'https://api.mistral.ai/v1',
    model: 'mistral-small-latest',
    json: true,
  },
  groq: {
    label: 'Groq',
    keys: ['GROQ_API_KEY'],
    base: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    json: true,
  },
  deepseek: {
    label: 'DeepSeek',
    keys: ['DEEPSEEK_API_KEY'],
    base: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    json: true,
  },
  openrouter: {
    label: 'OpenRouter',
    keys: ['OPENROUTER_API_KEY'],
    base: 'https://openrouter.ai/api/v1',
    model: 'openrouter/auto',
    json: false,
  },
  ollama: {
    label: 'Ollama',
    local: true,
    keys: [],
    model: null,
    json: true,
  },
  custom: {
    label: 'Custom',
    keys: ['SOURCEPEEK_AI_API_KEY'],
    model: null,
    json: false,
  },
};

const ORDER = ['openai', 'anthropic', 'gemini', 'mistral', 'groq', 'deepseek', 'openrouter'];
const OLLAMA_TTL = 30000;
let ollamaCache = null;

function ollamaBase(root) {
  const host = readEnv(root, 'OLLAMA_HOST') || 'http://127.0.0.1:11434';
  return (/^https?:\/\//.test(host) ? host : `http://${host}`).replace(/\/+$/, '');
}

async function probeOllama(root) {
  const base = ollamaBase(root);
  if (ollamaCache && ollamaCache.base === base && Date.now() - ollamaCache.at < OLLAMA_TTL) return ollamaCache.value;
  let value = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 400);
    const res = await fetch(`${base}/api/tags`, { signal: ctrl.signal });
    clearTimeout(t);
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      const models = (data.models || []).map((m) => m.name || m.model).filter(Boolean);
      value = { base, models };
    }
  } catch {}
  ollamaCache = { base, at: Date.now(), value };
  return value;
}

function firstKey(root, names) {
  for (const n of names) {
    const v = readEnv(root, n);
    if (v) return v;
  }
  return null;
}

function trimBase(u) {
  return String(u).replace(/\/+$/, '');
}

async function build(root, id) {
  const p = PROVIDERS[id];
  if (!p) return null;
  const override = readEnv(root, 'SOURCEPEEK_AI_MODEL') || (p.modelEnv && readEnv(root, p.modelEnv));

  if (id === 'ollama') {
    const probe = await probeOllama(root);
    const model = override || readEnv(root, 'OLLAMA_MODEL') || (probe && probe.models[0]) || null;
    if (!probe || !model) return null;
    return { id, ...p, key: null, base: `${probe.base}/v1`, model };
  }

  if (id === 'custom') {
    const base = readEnv(root, 'SOURCEPEEK_AI_BASE_URL');
    if (!base || !override) return null;
    return { id, ...p, label: readEnv(root, 'SOURCEPEEK_AI_LABEL') || 'Custom', key: firstKey(root, p.keys), base: trimBase(base), model: override };
  }

  const key = firstKey(root, p.keys);
  if (!key) return null;
  const base = trimBase(readEnv(root, 'SOURCEPEEK_AI_BASE_URL') || (p.baseEnv && readEnv(root, p.baseEnv)) || p.base);
  return { id, ...p, key, base, model: override || p.model };
}

async function resolve(root) {
  const forced = String(readEnv(root, 'SOURCEPEEK_AI_PROVIDER') || '').trim().toLowerCase();
  if (forced) return build(root, forced === 'claude' ? 'anthropic' : forced === 'google' ? 'gemini' : forced);
  if (readEnv(root, 'SOURCEPEEK_AI_BASE_URL') && readEnv(root, 'SOURCEPEEK_AI_MODEL') && !ORDER.some((id) => firstKey(root, PROVIDERS[id].keys))) {
    return build(root, 'custom');
  }
  for (const id of ORDER) {
    const p = await build(root, id);
    if (p) return p;
  }
  return build(root, 'ollama');
}

function errorMessage(data, status, provider) {
  const d = Array.isArray(data) ? data[0] : data;
  const raw = (d && d.error && (d.error.message || d.error)) || (d && d.message) || '';
  const msg = typeof raw === 'string' && raw ? raw : `${provider.label} error (${status})`;
  if (status === 404 || /model/i.test(msg) && /not|unknown|invalid|exist|support/i.test(msg)) {
    return `${msg} — set SOURCEPEEK_AI_MODEL to a ${provider.label} model your account can use.`;
  }
  return msg;
}

// Models that reject a custom temperature (OpenAI reasoning models, some proxies) are remembered per run.
const noTemperature = new Set();
const temperatureRejected = (msg) => /temperature/i.test(String(msg || '')) && /support|unsupported|invalid|only|not allowed|does not/i.test(String(msg || ''));

function truncatedErr(p) {
  const e = httpErr(502, `${p.label} hit its output limit before finishing the answer.`);
  e.truncated = true;
  return e;
}

async function callOpenAiCompatible(p, prompt, maxTokens, json, opts = {}) {
  const useTemp = typeof opts.temperature === 'number' && !noTemperature.has(p.base + '|' + p.model);
  const headers = { 'Content-Type': 'application/json' };
  if (p.key) headers.Authorization = `Bearer ${p.key}`;
  if (p.id === 'openrouter') headers['X-Title'] = 'Sourcepeek';
  const res = await fetch(`${p.base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: p.model,
      messages: [{ role: 'user', content: prompt }],
      [p.tokenParam || 'max_tokens']: maxTokens,
      ...(useTemp ? { temperature: opts.temperature } : {}),
      ...(json && p.json ? { response_format: { type: 'json_object' } } : {}),
      // OpenRouter reports the real dollar cost of each call when asked.
      ...(p.id === 'openrouter' ? { usage: { include: true } } : {}),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = errorMessage(data, res.status, p);
    if (useTemp && temperatureRejected(msg)) {
      noTemperature.add(p.base + '|' + p.model);
      return callOpenAiCompatible(p, prompt, maxTokens, json, { ...opts, temperature: undefined });
    }
    throw httpErr(502, msg);
  }
  if (data.usage) {
    const u = data.usage;
    const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
    usage.record(opts.root, p, {
      input: (u.prompt_tokens || 0) - cached,
      output: u.completion_tokens || 0,
      cacheRead: cached,
      cost: typeof u.cost === 'number' ? u.cost : undefined,
    });
  }
  const choice = data.choices && data.choices[0];
  const content = choice && choice.message && choice.message.content;
  const text = Array.isArray(content) ? content.map((c) => c.text || '').join('') : content || '';
  if (!text.trim() && choice && choice.finish_reason === 'length') {
    throw httpErr(502, `${p.label} ran out of tokens before answering — try another SOURCEPEEK_AI_MODEL.`);
  }
  if (opts.strict && choice && choice.finish_reason === 'length') throw truncatedErr(p);
  return text.trim();
}

async function callAnthropic(p, prompt, maxTokens, opts = {}) {
  const useTemp = typeof opts.temperature === 'number' && !noTemperature.has(p.base + '|' + p.model);
  const res = await fetch(`${p.base}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': p.key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: p.model, max_tokens: maxTokens, ...(useTemp ? { temperature: opts.temperature } : {}), messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = errorMessage(data, res.status, p);
    if (useTemp && temperatureRejected(msg)) {
      noTemperature.add(p.base + '|' + p.model);
      return callAnthropic(p, prompt, maxTokens, { ...opts, temperature: undefined });
    }
    throw httpErr(502, msg);
  }
  if (data.usage) {
    const u = data.usage;
    usage.record(opts.root, p, {
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cacheWrite: u.cache_creation_input_tokens || 0,
    });
  }
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (!text.trim() && data.stop_reason === 'max_tokens') {
    throw httpErr(502, `${p.label} ran out of tokens before answering — try another SOURCEPEEK_AI_MODEL.`);
  }
  if (opts.strict && data.stop_reason === 'max_tokens') throw truncatedErr(p);
  return text.trim();
}

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const MISSING = 'Missing AI key in .env (e.g. OPENAI_API_KEY, ANTHROPIC_API_KEY or GEMINI_API_KEY)';

async function complete(root, prompt, maxTokens, opts = {}) {
  const p = await resolve(root);
  if (!p) throw httpErr(503, MISSING);
  const budget = Math.max(maxTokens, 4096);
  const o = { ...opts, root };
  if (p.kind === 'anthropic') return callAnthropic(p, prompt, budget, o);
  return callOpenAiCompatible(p, prompt, budget, Boolean(opts.json), o);
}

async function status(root) {
  const p = await resolve(root);
  return p ? { ok: true, provider: p.id, label: p.label, model: p.model } : { ok: false };
}

module.exports = { complete, status, resolve, MISSING, PROVIDERS };
