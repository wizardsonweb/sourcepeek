'use strict';
const providers = require('./providers.cjs');
const nocomments = require('./nocomments.cjs');

function contextBlock({ componentName, file, cssClasses, gitContext }, source) {
  const commits =
    ((gitContext && gitContext.commits) || [])
      .slice(0, 5)
      .map((c) => `- ${c.subject} (${c.author})`)
      .join('\n') || 'No commit history available.';
  const src = source
    ? `\n\nSource code (may be truncated):\n${source}`
    : '\n\n(No source code available — base your answer only on the metadata above.)';
  return `Component: ${componentName}
File: ${file}
Branch: ${(gitContext && gitContext.branch) || 'unknown'}
CSS classes: ${cssClasses || 'none'}
Recent commits:
${commits}${src}`;
}

const complete = (root, prompt, maxTokens, opts) => providers.complete(root, prompt, maxTokens, opts);

function summarize(root, payload, source) {
  return complete(
    root,
    `You are annotating a UI component for a developer tool panel. Be factual and concise. Do not invent details not present below.

${contextBlock(payload, source)}

Write a 2-3 sentence summary covering: what this component likely does, and a note on its recent change activity. Do not use markdown.`,
    500
  );
}

function errors(root, payload, source) {
  return complete(
    root,
    `You are a senior code reviewer. Assess how error-prone this component might be.

${contextBlock(payload, source)}

Write 2-4 sentences. Base your assessment on real signals: frequency of recent changes, commit messages suggesting bugfixes/hotfixes, and (if source is available) actual code smells. If there isn't enough signal to say anything meaningful, say so plainly instead of guessing. Do not use markdown.`,
    500
  );
}

function refactor(root, payload, source) {
  return complete(
    root,
    `You are a senior front-end engineer proposing a refactor for the component below.

${contextBlock(payload, source)}

If source code was provided above, propose a concrete refactored version of it. If no source code was provided, do not invent a full rewrite — instead list 3-5 concrete, actionable refactor suggestions based on the component's name, classes and change history, and note which of them would need the real source to confirm.

Return only the refactored code when source code is provided. Do not add explanations or markdown fences.`,
    4000
  );
}

const clip = (s, n) => (typeof s === 'string' ? (s.length > n ? s.slice(0, n) + '\n…(truncated)' : s) : '');

function parseStyleReply(text) {
  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) try { obj = JSON.parse(m[0]); } catch {}
  }
  let css = obj && typeof obj.css === 'string' ? obj.css : null;
  if (css === null) {
    const fence = text.match(/```(?:css)?\s*([\s\S]*?)```/);
    css = fence ? fence[1] : /[{}]/.test(text) ? text : '';
  }
  css = css
    .replace(/^```(?:css)?\s*|```\s*$/g, '')
    .replace(/@import[^;]*;?/gi, '');
  // Change with AI never adds comments, even if the model ignored the rule.
  css = nocomments.stripAll('x.css', css).replace(/\n{3,}/g, '\n\n').trim();
  const summary = obj && typeof obj.summary === 'string' ? obj.summary.trim() : '';
  return { css, summary };
}

async function style(root, body, source) {
  const sel = body.selected || {};
  const prompt = `You are a senior front-end engineer helping a developer TRY OUT visual changes on a running web page.
The developer describes changes in plain language. You must translate them into a CSS stylesheet that will be injected live into the page.

RULES
- Target elements ONLY with selectors that will match the page outline below. Prefer the exact selectors given in [brackets]; a shorter class-based selector is fine if it clearly matches the same element(s).
- Never invent class names or ids that are not in the outline.
- "the title", "main title", "heading" usually means the most prominent h1 (or the largest heading). "buttons" means all button-like elements (button, a styled as button, input[type=submit]) unless the request is narrower.
- "this", "this element", "it" refers to the SELECTED element.${body.scope === 'global' ? `
- This is a SITE-WIDE / THEME change: restyle the whole page, not just the selected element. Use broad selectors (:root custom properties, html, body, h1–h6, a, button, input, and the classes shared by cards/sections in the outline). If the outline shows CSS custom properties or utility classes (bg-white, text-gray-900…), override what they produce on every element that uses them.` : ''}
- Reordering ("section 1 after section 2") must be done with CSS only: make the common parent a flex column (display:flex; flex-direction:column) if it isn't already flex/grid, then set "order" on the children. Give EVERY sibling in that parent an explicit order so nothing jumps unexpectedly.
- Keep everything else on the page as it is. Do not reset or restyle unrelated elements.
- Do not use !important (the tool adds it automatically for preview).
- Write clean, readable CSS, one rule per selector.
- NEVER write comments of any kind (no /* … */, no //). Output CSS rules only.
- If PREVIOUSLY APPLIED CSS exists, the new request may build on it ("even bigger", "undo the red"). Output ONLY the new/overriding rules for this request — they are appended after the existing ones.
- If part of the request cannot be done with CSS or no matching element exists, skip that part and say so in the summary.

Reply with a JSON object only: {"css": "<the stylesheet>", "summary": "<1-2 plain sentences: what you changed and which elements; mention anything you skipped>"}

DEVELOPER REQUEST:
${clip(body.instruction, 2000)}

SELECTED ELEMENT (the one they clicked in the inspector):
selector: ${clip(sel.selector, 400) || 'unknown'}
tag: ${clip(sel.tag, 40) || 'unknown'}
component: ${clip(body.componentName, 200) || 'unknown'} (${clip(body.file, 400) || 'unknown file'})
${body.stylingLabel ? `styled with: ${clip(body.stylingLabel, 120)}${/styled|emotion|linaria|stitches/i.test(body.stylingLabel) ? ' — its generated class names (sc-…, css-…, random letters) change when the code changes; prefer the stable sc- class, ids, data attributes or structural selectors' : ''}\n` : ''}
PAGE OUTLINE (indented = nested; [selector] tag "text" {current styles}; ★ = selected element):
${clip(body.domOutline, 24000) || '(not available)'}

PREVIOUSLY APPLIED CSS:
${clip(body.existingCss, 12000) || '(none)'}
${source ? `\nSOURCE OF THE SELECTED COMPONENT (may be truncated, for context only):\n${source}` : ''}`;
  let text;
  try {
    text = await complete(root, prompt, 3000, { json: true });
  } catch (err) {
    if (!/response_format|json_object|json mode|json_schema/i.test(err.message)) throw err;
    text = await complete(root, prompt, 3000);
  }
  return parseStyleReply(text);
}

function parseJsonReply(text) {
  const raw = String(text || '').trim();
  const candidates = [raw, (raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [])[1], (raw.match(/\{[\s\S]*\}/) || [])[0]];
  for (const c of candidates) {
    if (!c) continue;
    try {
      return JSON.parse(c);
    } catch {}
  }
  return null;
}

function excerpt(content, line, radius = 12) {
  const lines = String(content).replace(/\r\n/g, '\n').split('\n');
  const from = Math.max(1, line - radius);
  const to = Math.min(lines.length, line + radius);
  const out = [];
  for (let i = from; i <= to; i++) out.push(`${i === line ? '>>' : '  '} ${String(i).padStart(4)} | ${lines[i - 1]}`);
  return out.join('\n');
}

const KIND_BRIEF = {
  style: `KIND: STYLE CHANGE — purely visual. Implement it in the styling layer described under STYLING, where the clicked element is already styled.
- Do not change text, markup structure, props or logic. Touch the markup only to hook the style up (a className, a styled wrapper, a transient prop, a variant).`,
  reorder: `KIND: REORDER — move the markup in the source so the elements render in the requested order. Do not fake the order with CSS (order / flex-direction) in source code.`,
  code: `KIND: CODE CHANGE — content, markup, props, state or behaviour. Make the code change. If part of it is visual, implement that part as described under STYLING. New markup goes where PLACEMENT decides.`,
  mixed: `KIND: STYLE + CODE CHANGE — implement the behaviour/markup part in the component and the visual part in the styling layer described under STYLING. Do both. New markup goes where PLACEMENT decides.`,
  theme: `KIND: THEME / GLOBAL STYLE — the look of the WHOLE app changes (theme, palette, fonts, every page). Implement it in the project's theme layer described under THEME (design tokens, Tailwind theme, theme object, global styles), so every page and component picks it up. Touch individual components only where the theme layer cannot reach them.`,
  component: `KIND: NEW COMPONENT — create a new component in its own file (put it in "create") and render it on the page.
- If the request says extract / split / move / replace, move that markup (and the state, handlers and styles it needs) out of the clicked component into the new one, and render the new component in its place.
- Otherwise this is an ADDITION: keep every existing line of markup and insert the new component (<NewComponent />, or its selector in Angular) at the position PLACEMENT decides — which may be in a different file than the clicked component (the page, the section, the list the click was in). Do not remove or rewrite anything else.
- Give it the content the request describes (title, text, image, button…) with realistic placeholder content and sensible props, and style it so it fits the surrounding design.
- The file that renders the new component MUST import it (one "edits" entry adds the import line next to the existing imports) with the right relative path, and default vs named import must match how the new file exports it. .vue and .svelte files are always default-imported, with their extension. Angular components are named imports and must also be added to the @Component imports array (or the NgModule).
- Follow CONVENTIONS for location, naming, exports, typing and styling. Style it with the same approach as the clicked component (see STYLING).`,
  page: `KIND: NEW PAGE / ROUTE — add a new page reachable at its own URL, exactly the way this project's router expects (see ROUTING AND NEW FILES).
- Put the page file(s) in "create" at the location ROUTING describes — NOT next to the clicked component unless that is the routes folder. Use the URL the request names (e.g. "/hihi"); if it names none, pick a short kebab-case one from what the page is about.
- If the request asks for a component (or text, e.g. a component saying "hihi") on the page, create that component as its own file too, and render it in the page with a correct import (default vs named must match its export). Text the request quotes must appear exactly.
- If routes are declared in code (a router file is among the files), register the new route there with one "edits" entry plus its import, written exactly like the existing routes. Keep every existing route; a catch-all / wildcard route stays last.
- Leave the clicked component and other existing files alone unless the request asks for it (e.g. "and link to it from here").
- In "summary", give the URL of the new page.`,
};

/**
 * Ask the model for search/replace edits (and, for new components, new files) that implement
 * `body.instruction` in real source. files: [{rel, role, content}] — the only files it may touch.
 * plan: { kind, reorder, styling: {rules}, conventions: {rules}, allowCreate }
 */
async function edit(root, body, files, plan, retry) {
  const sel = body.selected || {};
  const component = files.find((f) => f.role === 'component');
  const line = Number(body.line) || 1;
  // Backwards compatible: older callers passed an array of styling hints.
  if (Array.isArray(plan)) plan = { kind: 'mixed', styling: { rules: plan }, conventions: { rules: [] }, allowCreate: false };
  const kind = plan.reorder && plan.kind !== 'component' && plan.kind !== 'page' && plan.kind !== 'theme' ? 'reorder' : plan.kind || 'mixed';
  const roleNote = {
    component: 'the clicked element is defined here',
    stylesheet: 'stylesheet imported by the component',
    styles: 'CSS-in-JS styles module used by the component (styled-components / emotion definitions)',
    'call-site': 'where this component is used on the page — props such as labels or variants are passed here',
    reference: 'READ-ONLY shared Sass partial, for its variables and mixins — never edit it',
    class: 'Angular component class of this template — inputs, state, handlers, and the @Component imports array',
    module: 'Angular NgModule that declares this component — declarations and imports',
    router: 'router configuration — register the new route here, like the existing ones',
    page: 'the PAGE / route file that renders the current URL — page content belongs here',
    layout: 'LAYOUT / app shell — wraps EVERY page around its {children} / <Outlet/> / <slot/>; never put page content here',
    context: 'another file that renders part of the boxes around the clicked element (see PLACEMENT) — you may insert there',
    theme: 'THEME FILE — defines the look of the whole app (tokens, Tailwind theme, theme object, global styles)',
    entry: 'app entry / root layout — where global styles are imported and providers are set up',
  };
  const fileBlocks = files
    .map((f) => `===== FILE: ${f.rel} (${roleNote[f.role] || f.role}) =====\n${f.content.replace(/\r\n/g, '\n')}\n===== END FILE: ${f.rel} =====`)
    .join('\n\n');
  const stylingRules = (plan.styling && plan.styling.rules) || [];
  const conventionRules = plan.allowCreate ? (plan.conventions && plan.conventions.rules) || [] : [];
  const frameworkRules = plan.framework || [];
  const themeRules = plan.theme || [];
  const placement = plan.placement || null;

  const prompt = `You are a senior front-end engineer making a change directly in the source code of a running web app.
The developer clicked an element in the browser and described what they want. Your edit is written to disk and hot-reloaded, so it must be correct and must compile.

${KIND_BRIEF[kind] || KIND_BRIEF.mixed}

RULES
- ${plan.allowCreate ? `Only change the files shown below, plus the NEW files you list in "create" (only for ${kind === 'page' ? 'the new page, the components it uses and their styles' : 'the new component and its own styles'}). Never rename or delete files, never overwrite an existing file.` : 'Only change the files shown below. Never create, rename or delete files.'} Never add new npm dependencies.
- Files marked READ-ONLY are context only. Never edit them.
- Do exactly what the request says — every part of it, and nothing it did not ask for. Values the request names (colours, sizes, spacing, text, URLs, names) must appear exactly as written; do not round, rename or "improve" them.
- Make the smallest change that fully does what was asked. Keep everything unrelated exactly as it is: formatting, naming, imports, behaviour.
- Match the existing code style (quotes, semicolons, indentation, component patterns).
- NEVER add comments of any kind — not in code, markup or CSS (no //, /* */, {/* */}, <!-- -->, no JSDoc, no TODO notes). Explanations belong in "summary" only. Leave the file's existing comments exactly as they are.
- "this", "it", "this element" means the CLICKED ELEMENT. The line marked >> in the excerpt is where it is written.
- If the request needs state, effects or handlers (e.g. "add a loading state"), implement them properly in the component, including imports from libraries the file already uses.
- Every identifier you use must be imported or declared. When you start using something new (a component, hook, helper), add its import in the same answer.
- If the request is impossible within these files, or unclear, return no edits and explain in "summary". For a THEME change there is always a way: if the theme files can't express it, add global rules to the global stylesheet or the root layout.
- Images: reuse an image the project already has when one obviously fits; otherwise use a placeholder https://picsum.photos/seed/<word>/800/500 in a plain <img> with a descriptive alt (not next/image, which needs remote-domain config).

STYLING
- ${stylingRules.join('\n- ') || 'Follow whatever styling approach the file already uses.'}
${themeRules.length ? `\nTHEME\n- ${themeRules.join('\n- ')}\n` : ''}${placement ? `\nPLACEMENT — where new UI goes\n${placement}\n` : ''}${plan.project ? `\nPROJECT (how this codebase is organised — use it to put things where they belong)\n${plan.project}\n` : ''}${frameworkRules.length ? `\nFRAMEWORK\n- ${frameworkRules.join('\n- ')}\n` : ''}
${conventionRules.length ? `\n${kind === 'page' ? `ROUTING AND NEW FILES (${clip(plan.routing && plan.routing.label, 60) || 'router'})` : 'CONVENTIONS FOR NEW FILES'}\n-${conventionRules.join('\n- ')}\n` : ''}
OUTPUT
Reply with one JSON object only, no prose, no markdown:
{"summary": "<1-2 plain sentences: what you changed and where>", "edits": [{"file": "<path exactly as in the FILE header>", "find": "<exact text currently in the file>", "replace": "<new text>"}]${plan.allowCreate ? ', "create": [{"file": "<new project-relative path>", "content": "<complete file content>"}]' : ''}}
- "find" must be copied character-for-character from the FILE blocks below (including indentation) and be long enough to be unique — usually 2-8 whole lines. Never copy from the EXCERPT: do not include its line numbers, "|" gutter or >> marker.
- Edits are applied in order, each to the result of the previous ones. Never write two edits that touch the same lines — merge them into one edit. Never repeat an edit.
- Several small edits are better than rewriting large blocks. "replace" holds the complete new text for exactly the lines in "find".
- Before answering, check that your edits together do everything the request asks.${plan.allowCreate ? '\n- "create" holds complete new files. Every import between new and existing files must use the correct relative path (or the project import alias, the way existing files use it), without a .ts/.tsx/.js/.jsx extension (import X from "./X"); .vue and .svelte imports keep their extension (import X from "./X.svelte").' : ''}

DEVELOPER REQUEST:
${clip(body.instruction, 3000)}

CLICKED ELEMENT:
component: ${clip(body.componentName, 200) || 'unknown'}
file: ${component ? component.rel : clip(body.file, 400)}  line: ${line}
tag: ${clip(sel.tag, 40) || 'unknown'}   classes: ${clip(sel.classes, 400) || 'none'}
text: ${clip(sel.text, 300) || '(none)'}
rendered HTML: ${clip(sel.html, 1500) || '(not available)'}
${body.callSite ? `used at: ${clip(body.callSite, 400)}` : ''}
${body.props ? `rendered with props: ${clip(body.props, 1500)}` : ''}

EXCERPT AROUND THE CLICKED ELEMENT (${component ? component.rel : 'component'}):
${component ? excerpt(component.content, line) : '(not available)'}

${fileBlocks}
${retry ? `\nYOUR PREVIOUS ATTEMPT FAILED — nothing was written:\n${clip(retry, 5000)}\nWrite a complete new answer (all edits again, not only the fixed ones) that avoids this problem.` : ''}`;

  // Low temperature: the edits must reproduce existing code exactly. Truncated answers are retried once with a
  // bigger budget instead of being parsed as broken JSON.
  const ask = async (budget) => {
    const opts = { json: true, temperature: 0, strict: true };
    try {
      return await complete(root, prompt, budget, opts);
    } catch (err) {
      if (!/response_format|json_object|json mode|json_schema/i.test(err.message)) throw err;
      return complete(root, prompt, budget, { ...opts, json: false });
    }
  };
  let text;
  try {
    text = await ask(8000);
  } catch (err) {
    if (!err.truncated) throw err;
    try {
      text = await ask(16000);
    } catch (err2) {
      if (!err2.truncated) throw err2;
      return { edits: null, truncated: true, creates: [], summary: '' };
    }
  }
  const obj = parseJsonReply(text);
  if (!obj) return { edits: null, creates: [], summary: '', raw: text };
  const creates = Array.isArray(obj.create) ? obj.create : Array.isArray(obj.creates) ? obj.creates : [];
  return {
    edits: Array.isArray(obj.edits) ? obj.edits.filter((e) => e && typeof e.find === 'string') : [],
    creates: creates.filter((c) => c && typeof c.file === 'string' && typeof c.content === 'string'),
    summary: typeof obj.summary === 'string' ? obj.summary.trim() : '',
  };
}

/**
 * Model fallback for requests the rule-based classifier can't place.
 * Returns { kind, reason } or null.
 */
async function classify(root, body) {
  const sel = body.selected || {};
  const prompt = `Classify a developer's request to change a UI element in their web app. The answer decides whether a live CSS preview can do it, or the source code must change.

Kinds:
- "style": purely visual — CSS alone can do it (colours, sizes, fonts, spacing, borders, shadows, alignment, layout, reordering, hover/animation, hiding) for the clicked element or its component.
- "theme": purely visual but for the WHOLE app — the theme, colour scheme, palette, fonts or look of every page / all buttons / the entire site.
- "code": needs source changes CSS cannot make — text/copy, adding or removing elements, props, state, event handlers, data, conditions, links, accessibility attributes.
- "component": asks for a new component, or to extract/split part of the UI into its own component.
- "page": asks for a new page, screen or route (its own URL), with or without components on it.
- "mixed": clearly asks for both a visual change and a code change.
When in doubt between "style" and "mixed", pick "style" if every part of the request could be done with CSS.

Request: ${clip(body.instruction, 1500)}
Clicked element: <${clip(sel.tag, 40) || '?'}> in ${clip(body.componentName, 120) || 'unknown component'}${sel.text ? `, text "${clip(sel.text, 80)}"` : ''}

Reply with JSON only: {"kind": "style|theme|code|component|page|mixed", "reason": "<at most 12 words>"}`;
  let text;
  try {
    text = await complete(root, prompt, 200, { json: true });
  } catch (err) {
    if (!/response_format|json_object|json mode|json_schema/i.test(err.message)) throw err;
    text = await complete(root, prompt, 200);
  }
  const obj = parseJsonReply(text);
  const kind = obj && String(obj.kind || '').toLowerCase().trim();
  if (!['style', 'theme', 'code', 'component', 'page', 'mixed'].includes(kind)) return null;
  return { kind, reason: typeof obj.reason === 'string' ? obj.reason.trim().slice(0, 120) : '' };
}

/**
 * "Randomise" in Network: a realistic, made-up response body for a request, so the page has data to show.
 * body: { method, url, status, componentName, file, samples: [{ from, value }], responseType, previous, hint }
 * files: [{ rel, role, content }] — code that calls the endpoint, serves it, or the clicked component.
 * Returns { value, summary } (value is the parsed JSON body) or throws.
 */
async function mockData(root, body, files) {
  const samples = (Array.isArray(body.samples) ? body.samples : [])
    .slice(0, 4)
    .map((s) => `--- ${clip(String((s && s.from) || 'sample'), 80)} ---\n${clip(JSON.stringify(s && s.value, null, 2), 6000)}`)
    .join('\n\n');
  const roleNote = {
    consumer: 'code that calls this endpoint and renders what it returns — the fields it reads must exist',
    handler: 'server code that answers this endpoint — its real response shape',
    component: 'the component the developer clicked',
    types: 'type definitions for the response',
  };
  const fileBlocks = (files || [])
    .map((f) => `===== ${f.rel} (${roleNote[f.role] || f.role}) =====\n${f.content}\n===== END ${f.rel} =====`)
    .join('\n\n');
  const flavours = ['a small boutique', 'a busy power user', 'a brand-new account with a little data', 'an international customer', 'a typical weekday', 'a long-time customer', 'a team of five', 'a holiday rush'];
  const flavour = flavours[Math.floor(Math.random() * flavours.length)];
  const prompt = `You generate realistic FAKE API response data for a developer previewing their UI. The JSON you write is injected as the response of a real request in the browser, so the page renders it instead of the real server's answer.

REQUEST: ${clip(String(body.method || 'GET').toUpperCase(), 10)} ${clip(String(body.url || ''), 500)}  (answered with status ${Number(body.status) || 200})
${body.componentName ? `Clicked component: ${clip(String(body.componentName), 120)}${body.file ? ` (${clip(String(body.file), 300)})` : ''}\n` : ''}${body.responseType ? `Response type in the code: ${clip(String(body.responseType), 200)}\n` : ''}
RULES
- The output must be valid JSON in exactly the shape the app expects. If KNOWN SHAPES are given, keep every key, the nesting and each value's type exactly as there. Never rename, drop or add top-level keys. If CODE is given, make sure every field the code reads exists with the right type.
- Fill empty lists (e.g. "items": []) with 3-6 realistic entries modelled on the code that renders them, the handler that builds them, or the type — so the UI has something to show. Never return an empty list unless nothing at all says what goes in it.
- Values must look real and fit the domain the URL, names and code suggest (product names and prices for a shop, people for users, plausible dates in the last year, etc.). No lorem ipsum, no "string", no "example", no placeholders.
- Keep data consistent: ids unique within a list; totals / counts / subtotals equal what the items add up to (e.g. total = sum of price × quantity); dates in a sensible order; related ids point at entries that exist.
- Keep enum-like fields (status, type, role, currency…) to values the code or samples use.
- Image URLs: https://picsum.photos/seed/<word>/<w>/<h>; avatars: https://i.pravatar.cc/150?u=<word>.
- Be inventive: this time, imagine the data belongs to ${flavour}.${body.previous ? ' Produce clearly DIFFERENT values from PREVIOUS (different names, numbers and list lengths).' : ''}
${body.hint ? `- The developer asked for: ${clip(String(body.hint), 500)}\n` : ''}
Reply with ONE JSON object only, no markdown: {"body": <the response body — any JSON value>, "summary": "<one short plain sentence describing the data, e.g. '4 cart items, total 182.50'>"}

KNOWN SHAPES (real or expected responses of this request):
${samples || '(none — infer the shape from the code and the URL)'}
${body.previous ? `\nPREVIOUS (generated earlier; do not repeat it):\n${clip(String(body.previous), 3000)}\n` : ''}
${fileBlocks ? `CODE:\n${fileBlocks}` : '(no code found for this endpoint)'}`;
  let text;
  try {
    text = await complete(root, prompt, 6000, { json: true });
  } catch (err) {
    if (!/response_format|json_object|json mode|json_schema/i.test(err.message)) throw err;
    text = await complete(root, prompt, 6000);
  }
  const obj = parseJsonReply(text);
  if (!obj || typeof obj !== 'object' || !('body' in obj)) {
    const e = new Error('The AI did not return usable JSON — try again.');
    e.status = 502;
    throw e;
  }
  let value = obj.body;
  // Some models return the body as a JSON string.
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {}
  }
  return { value, summary: typeof obj.summary === 'string' ? obj.summary.trim().slice(0, 300) : '' };
}

module.exports = { status: providers.status, summarize, errors, refactor, style, edit, classify, mockData, parseStyleReply, parseJsonReply };
