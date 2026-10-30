'use strict';
// "Change with AI" needs to know two things before it asks a model for anything:
//   1. WHAT kind of change was asked for — visual only (CSS can do it), code (text, markup, logic),
//      a new component, or a mix. That decides Preview-as-CSS vs. a code diff, and what the edit may touch.
//   2. HOW this element is styled — styled-components, emotion, Sass/SCSS (module or global), CSS Modules,
//      Tailwind, a Vue/Svelte <style> block, inline styles… so the change lands where it belongs.

const fs = require('fs');
const path = require('path');
const angular = require('./angular.cjs');
const project = require('./project.cjs');

const KINDS = new Set(['style', 'theme', 'code', 'component', 'page', 'mixed']);

const KIND_LABEL = {
  style: 'Style change',
  theme: 'Theme / global style',
  code: 'Code change',
  component: 'New component',
  page: 'New page / route',
  mixed: 'Style + code change',
};

// ---------------------------------------------------------------------------------------------
// 1. Request classification
// ---------------------------------------------------------------------------------------------

const COMPONENT_RX = [
  /\b(new|separate|own|reusable|standalone|child|sub-?)\s+(react\s+|vue\s+|svelte\s+)?component\b/i,
  /\b(extract|split|pull|move|break|refactor|turn|wrap)\b[^.?!]{0,50}\b(in|into|to|out|as)\b[^.?!]{0,40}\bcomponents?\b/i,
  /\b(create|make|add|build|generate|write)\s+(a|an|the)?\s*(new\s+)?(\w+\s+){0,3}component\b/i,
  /\bas\s+(a|an|its\s+own)\s+(\w+\s+)?component\b/i,
  /\bcomponent\s+(called|named)\b/i,
];

// A new page / route: new files where the router looks for them (and a router entry), not just a component.
const PAGE_RX = [
  /\bnew\s+(?:[\w/-]+\s+){0,2}(?:route|page|screen|view)s?\b(?!\s*(?:title|header|heading|background|colou?r|width|layout|margin|padding))/i,
  /\b(?:add|create|make|build|generate|set\s*up|scaffold)\s+(?:a|an|another|one\s+more)\s+(?:[\w/-]+\s+){0,2}(?:route|page|screen)s?\b(?!\s*(?:title|header|heading|background|colou?r))/i,
  /\b(?:route|page)\s+(?:at|for|called|named|on)\s+["'`“]?\/[\w-]*/i,
  /["'`“]\/[a-z][\w/-]*["'`”]\s+(?:route|page)\b/i,
  /\b(?:route|path|url)\s+["'`“]?\/[a-z][\w-]*["'`”]?\s+(?:that|which|with|showing|rendering)\b/i,
];

// The whole app's look, not one element: theme, palette, every page, site-wide.
const THEME_RX = [
  /\b(entire|whole|full|complete|overall|global)\s+(?:[\w-]+\s+){0,2}(theme|site|website|web\s*site|app|application|project|ui|design|look|colou?r\s*scheme|colou?rs|palette|typography|fonts?|styling|style)\b/i,
  /\b(change|switch|update|redo|redesign|rework|refresh|modernize|modernise|make|apply|use|create|give|set|swap)\b[^.?!]{0,30}\b(theme|colou?r[-\s]*scheme|colou?r[-\s]*palette|palette|design[-\s]*tokens?|design\s+system|brand(ing)?\s+colou?rs?|primary\s+colou?r|accent\s+colou?r|base\s+font|font\s+family)\b/i,
  /\b(theme|colou?r[-\s]*scheme|palette|design[-\s]*tokens?)\b[^.?!]{0,30}\b(to|into|like|more|based\s+on|inspired)\b/i,
  /\b(everywhere|site[-\s]?wide|app[-\s]?wide|globally|across\s+(?:the\s+)?(?:whole\s+|entire\s+)?(?:site|app|website|pages|project|application)|on\s+(?:all|every)\s+pages?|all\s+(?:the\s+)?pages)\b/i,
  /\b(?:all|every)\s+(?:the\s+)?(?:buttons|links|headings|titles|inputs|cards|fonts?|texts?|sections)\b[^.?!]{0,30}\b(?:on|in|across|of)\s+(?:the\s+)?(?:site|app|website|project|application)\b/i,
  /\b(?:make|turn|switch|convert)\b[^.?!]{0,25}\b(?:site|app|website|ui|everything|it\s+all)\b[^.?!]{0,20}\b(?:dark|light|darker|lighter)\b/i,
  /\b(?:dark|light)\s+(?:theme|colou?r\s*scheme)\b/i,
];
// A theme request that also asks for code (a toggle, a switch button, state) is a mix the model should judge.
const THEME_CODE_RX = /\b(toggle|switch(?:er)?\s+button|button|checkbox|localstorage|state|prefers-color-scheme\s+listener|context)\b/i;

// Things CSS cannot do: content, markup, behaviour, data, attributes.
const CODE_RX = [
  // text / copy
  /\b(change|set|update|replace|rename|reword|rewrite)\s+(the\s+|this\s+|its\s+)?([\w-]+\s+)?(text|label|title|heading|copy|wording|placeholder|caption|name|message|tooltip text)\b(?!\s+(colou?r|size|font|weight|style|spacing))/i,
  /\b(text|label|title|heading|copy|placeholder|caption)\b[^.?!]{0,30}\b(to\s+say|should\s+say|to\s+read|should\s+read)\b/i,
  /\b(say|says|read|reads)\s+["“'‘]/i,
  /\btranslat(e|ion)\b/i,
  // adding / removing markup
  /\b(add|insert|include|append|prepend)\b[^.?!]{0,40}\b(button|link|input|field|icon|image|img|logo|avatar|paragraph|heading|subtitle|badge|label|item|row|section|footer|header|list|divider|checkbox|radio|switch|toggle|dropdown|select|tooltip|modal|dialog|menu|tab|counter|spinner|loader|skeleton|placeholder|error message|message|text|emoji|arrow|close button)\b/i,
  /\b(remove|delete|drop)\s+(the\s+|this\s+)?(button|link|input|field|icon|image|item|row|section|element|component|text|label|badge)\b(?![^.?!]{0,20}\b(border|shadow|background|underline|padding|margin|outline|radius|color)\b)/i,
  /\b(wrap|unwrap)\b[^.?!]{0,30}\b(in|with)\b/i,
  // behaviour / state / data
  /\b(loading|spinner|skeleton)\s+(state|indicator)?\b[^.?!]{0,30}\b(while|when|during|until)\b/i,
  /\b(add|show|implement)\s+(a\s+)?(loading|error|empty|disabled|success)\s+state\b/i,
  /\b(on\s*click|onclick|click\s+handler|event\s+handler|handler|callback|onchange|on\s+change|on\s+submit|onsubmit)\b/i,
  /\b(when|after|while|once|if)\b[^.?!]{0,30}\b(click(ed|s)?|tap(ped|s)?|press(ed|es)?|submit(ted|s)?|hover(ed|s)?\s+show|scroll(ed|s)?|load(ed|s)?|fail(s|ed)?|empty)\b/i,
  /\b(disable[ds]?|enable[ds]?)\b[^.?!]{0,30}\b(when|while|if|until|unless)\b/i,
  /\b(show|hide|display|render)\b[^.?!]{0,30}\b(only\s+)?(when|if|unless|for\s+logged|based\s+on)\b/i,
  /\b(state|useState|useEffect|reactive|ref\(|store|context|reducer|signal)\b/i,
  /\b(fetch|api|endpoint|request|response|query|mutation|submit\s+to|post\s+to|load\s+data|from\s+the\s+server)\b/i,
  /\b(validat(e|ion)|required\s+field|debounce|throttle|sort(ing)?\s+by|filter(ing)?\s+by|search\s+by|paginat(e|ion)|infinite\s+scroll)\b/i,
  /\b(navigate|redirect|route|router|link\s+(it\s+)?to|href|open\s+(in\s+)?(a\s+)?new\s+tab|go\s+to)\b/i,
  /\b(open|close|toggle)s?\s+(a\s+|the\s+)?(modal|dialog|drawer|menu|dropdown|popover|accordion|panel)\b/i,
  /\b(prop|props|variant\s+prop|pass\s+(a|the)?\s*\w+\s+to|default\s+value|typescript|type(d)?\s+(the\s+)?props|interface)\b/i,
  /\b(aria-\w+|aria\s+label|alt\s+text|screen\s*reader|a11y|tabindex|keyboard\s+(support|navigation)|focus\s+trap)\b/i,
  /\b(localstorage|sessionstorage|cookie|analytics|track(ing)?\s+event|console\.log|log\s+(it|the))\b/i,
  /\b(count(er)?|increment|decrement|timer|countdown|copy\s+to\s+clipboard|format\s+(the\s+)?(date|price|number|currency))\b/i,
];

// Visual vocabulary.
const STYLE_RX = [
  /\b(colou?r|red|blue|green|yellow|orange|purple|violet|pink|black|white|gr[ae]y|teal|cyan|indigo|brand\s+colou?r|primary\s+colou?r|accent)\b/i,
  /\b(bigger|smaller|larger|tiny|huge|size|font|typeface|bold|bolder|italic|underline[ds]?|uppercase|lowercase|capitali[sz]e|weight|line[-\s]?height|letter[-\s]?spacing|text[-\s]?shadow)\b/i,
  /\b(padding|margin|spacing|spaced|space\s+(between|around)|gap|gutter|indent|whitespace|breathing\s+room|tighter|looser|denser|compact|spacious|cramped)\b/i,
  /\b(border|outline|radius|rounded|round(er)?\s+corners|pill|circle|square\s+corners|shadow|elevation|glow|blur|backdrop)\b/i,
  /\b(background|bg|gradient|opacity|transparent|translucent|semi-?transparent|dark(er)?|light(er)?|contrast|muted|vibrant|pastel|neon|glass(y|morphism)?)\b/i,
  /\b(align(ed|ment)?|center(ed)?|centre(d)?|left|right|justif(y|ied)|vertical(ly)?|horizontal(ly)?|middle)\b/i,
  /\b(width|height|wide|wider|narrow(er)?|tall(er)?|short(er)?|full[-\s]?width|max[-\s]?width|stretch|shrink|grow|fit|aspect[-\s]?ratio|cover|contain)\b/i,
  /\b(flex|flexbox|grid|columns?|rows?|stack(ed)?|side\s+by\s+side|inline|wrap(ping)?|layout|reorder|swap\s+(the\s+)?order|order|move\s+\w+\s+(above|below|after|before|to\s+the\s+(left|right|top|bottom)))\b/i,
  /\b(position|sticky|fixed|absolute|relative|z-?index|overlap|on\s+top)\b/i,
  /\b(hover|focus|active|pressed)\s+(effect|state|style|colou?r)?\b/i,
  /\b(transition|animat(e|ion|ed)|fade|slide|bounce|pulse|spin|scale|rotate|transform|smooth)\b/i,
  /\b(cursor|pointer|overflow|scroll(bar)?|truncate|ellipsis|clamp|nowrap|hidden|invisible|visible|hide\s+on\s+mobile)\b/i,
  /\b(responsive|mobile|tablet|desktop|breakpoint|small\s+screens?|large\s+screens?|media\s+query)\b/i,
  /\b(style|styling|styled|look(s)?|looks?\s+(like|better|nicer)|prettier|nicer|cleaner|modern|minimal(ist)?|elegant|polish(ed)?|theme|dark\s+mode|light\s+mode|design)\b/i,
  /\b(px|rem|em|vh|vw|%|#[0-9a-f]{3,8})\b/i,
];

const REORDER_RX = /\b(put|place|move|show|swap|switch|reorder|reverse)\b[^.?!]{0,50}\b(after|before|above|below|under|underneath|on\s+top\s+of|next\s+to|first|last|order|places|positions?)\b/i;

function hits(list, text) {
  const out = [];
  for (const rx of list) {
    const m = text.match(rx);
    if (m) out.push(m[0].trim());
  }
  return out;
}

/**
 * Fast rule-based guess. `confident` means it's safe to skip asking a model.
 * Returns { kind|null, confident, reason, signals }.
 */
function classify(instruction) {
  const text = String(instruction || '').replace(/\s+/g, ' ').trim();
  const page = hits(PAGE_RX, text);
  const comp = hits(COMPONENT_RX, text);
  const code = hits(CODE_RX, text);
  const style = hits(STYLE_RX, text);
  const theme = hits(THEME_RX, text);
  const signals = { page, component: comp, code, style, theme };
  const q = (a) => a.slice(0, 2).map((s) => `“${s.length > 32 ? s.slice(0, 30) + '…' : s}”`).join(', ');
  // Reordering is CSS (flex `order`) in a live preview, but moving the markup when written to source.
  const reorder = REORDER_RX.test(text);

  if (page.length) return { kind: 'page', confident: true, reason: `asks for a new page / route (${q(page)})`, signals };
  if (comp.length) return { kind: 'component', confident: true, reason: `asks for a component (${q(comp)})`, signals };
  if (theme.length) {
    if (!THEME_CODE_RX.test(text)) return { kind: 'theme', confident: true, reason: `changes the look of the whole app (${q(theme)})`, signals };
    return { kind: 'theme', confident: false, reason: `theme (${q(theme)}) and code (${q(code.length ? code : [text.match(THEME_CODE_RX)[0]])})`, signals };
  }
  if (reorder && !code.length) return { kind: 'style', reorder: true, confident: true, reason: 'reorders elements', signals };
  if (code.length && !style.length) return { kind: 'code', confident: true, reason: `needs code (${q(code)})`, signals };
  if (style.length && !code.length) return { kind: 'style', confident: true, reason: `visual only (${q(style)})`, signals };
  if (code.length && style.length) {
    // Both vocabularies matched. It is genuinely mixed only when the code signal is strong;
    // a model is better at telling "make the submit button red" (style) from "red + loading state" (mixed).
    return { kind: 'mixed', confident: false, reason: `visual (${q(style)}) and code (${q(code)})`, signals };
  }
  return { kind: null, confident: false, reason: 'no clear signal', signals };
}

// ---------------------------------------------------------------------------------------------
// 2. Styling detection
// ---------------------------------------------------------------------------------------------

function readPkg(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

function majorOf(range) {
  const m = String(range || '').match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

/** What the project has installed / configured, independent of the clicked component. */
function projectStyling(root) {
  const pkg = readPkg(root);
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.peerDependencies || {}) };
  const has = (n) => Object.prototype.hasOwnProperty.call(deps, n);
  const exists = (f) => fs.existsSync(path.join(root, f));
  const twConfig = ['tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.cjs', 'tailwind.config.mjs'].some(exists);
  const tailwind = has('tailwindcss') || has('@tailwindcss/vite') || has('@tailwindcss/postcss') || twConfig;
  return {
    tailwind,
    tailwindMajor: tailwind ? majorOf(deps.tailwindcss || deps['@tailwindcss/vite'] || deps['@tailwindcss/postcss']) || (twConfig ? 3 : 4) : null,
    unocss: has('unocss') || has('@unocss/vite'),
    sass: has('sass') || has('sass-embedded') || has('node-sass'),
    less: has('less'),
    styledComponents: has('styled-components'),
    styledComponentsMajor: majorOf(deps['styled-components']),
    emotion: has('@emotion/styled') || has('@emotion/react') || has('@emotion/css'),
    mui: has('@mui/material') || has('@mui/system') || has('@mui/joy'),
    chakra: has('@chakra-ui/react'),
    vanillaExtract: has('@vanilla-extract/css'),
    linaria: has('@linaria/core') || has('@linaria/react'),
    stitches: has('@stitches/react'),
    styledJsx: has('styled-jsx') || has('next'),
    classUtils: ['clsx', 'classnames', 'tailwind-merge', 'class-variance-authority', 'tailwind-variants'].filter(has),
  };
}

const CSS_IN_JS_IMPORT = /from\s+['"](styled-components(?:\/macro|\/native)?|@emotion\/(?:styled|react|css)|@linaria\/(?:react|core)|@stitches\/react|@vanilla-extract\/css|@mui\/(?:material\/styles|system|material)|goober)['"]/;

function cssInJsLib(content) {
  const m = content.match(CSS_IN_JS_IMPORT);
  if (!m) return null;
  const lib = m[1];
  if (lib.startsWith('styled-components')) return 'styled-components';
  if (lib.startsWith('@emotion')) return 'emotion';
  if (lib.startsWith('@linaria')) return 'linaria';
  if (lib.startsWith('@stitches')) return 'stitches';
  if (lib.startsWith('@vanilla-extract')) return 'vanilla-extract';
  if (lib.startsWith('@mui')) return /\bstyled\s*\(/.test(content) ? 'mui-styled' : null;
  return lib;
}

const lines = (s) => String(s).replace(/\r\n/g, '\n').split('\n');

/** The opening tag written at `line` (1-based) — up to its closing `>` — plus its name. */
function openingTagAt(content, line) {
  const all = lines(content);
  const start = Math.max(0, (Number(line) || 1) - 1);
  const chunk = all.slice(start, start + 12).join('\n');
  // The tagger records the line the opening tag starts on, so the tag must start on that line.
  const m = (all[start] || '').match(/<([A-Za-z][\w.:-]*)/);
  if (!m) return { name: null, text: all[start] || '' };
  const from = m.index;
  // Walk to the end of the opening tag, skipping {…} expressions and quoted strings.
  let depth = 0;
  let quote = null;
  let i = from;
  for (; i < chunk.length; i++) {
    const c = chunk[i];
    if (quote) {
      if (c === quote && chunk[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth <= 0) break;
  }
  return { name: m[1], text: chunk.slice(from, i + 1) };
}

const escRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function lineAt(content, index) {
  return content.slice(0, index).split('\n').length;
}

/** Where `const Name = styled…` / `styled(Base)` / `css\`` / `style({…})` (vanilla-extract) is defined. */
function findStyledDefinition(files, name) {
  if (!name) return null;
  const local = name.includes('.') ? name.split('.').pop() : name;
  const rx = new RegExp(
    `(?:export\\s+)?(?:const|let|var)\\s+${escRx(local)}\\s*(?::[^=]+)?=\\s*(styled\\s*[.(]|styled\\.\\w+|\\w+\\s*\\.\\s*withComponent|tw\\s*[.\`(]|css\\s*\`|style\\s*\\(|recipe\\s*\\(|createStyled|makeStyles)`
  );
  for (const f of files) {
    const m = f.content.match(rx);
    if (m) {
      const lib = cssInJsLib(f.content) || (/tw\s*[.`(]/.test(m[1]) ? 'twin.macro' : 'css-in-js');
      return { name, local, file: f.rel, line: lineAt(f.content, m.index), lib };
    }
  }
  return null;
}

function classNameExpr(tagText) {
  const m = tagText.match(/\b(?:className|class)\s*=\s*(\{[\s\S]*?\}(?=\s*[\w-]+\s*=|\s*\/?>|\s*$)|"[^"]*"|'[^']*')/);
  return m ? m[1] : null;
}

const TW_TOKEN = /(^|\s|["'`])(-?(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|space-[xy]|w|h|min-w|max-w|min-h|max-h|top|left|right|bottom|inset|z|text|bg|from|via|to|border|rounded|shadow|ring|font|leading|tracking|opacity|grid-cols|col-span|row-span|flex|basis|grow|shrink|items|justify|content|self|place|order|translate-[xy]|rotate|scale|duration|ease|delay)-[\w./[\]#%-]+|flex|grid|block|inline-flex|inline-block|hidden|relative|absolute|fixed|sticky|uppercase|lowercase|capitalize|italic|underline|truncate|container|sr-only|(?:sm|md|lg|xl|2xl|hover|focus|active|dark|group-hover|disabled):[\w./[\]#%:-]+)(?=$|\s|["'`])/;

function looksTailwind(s) {
  if (!s) return false;
  let n = 0;
  const tokens = String(s).split(/[\s"'`{}(),]+/).filter(Boolean);
  for (const t of tokens) if (TW_TOKEN.test(' ' + t + ' ')) n++;
  return n >= 2 || (n >= 1 && tokens.length <= 2);
}

function sfcStyleBlocks(content) {
  const out = [];
  const rx = /<style\b([^>]*)>/g;
  let m;
  while ((m = rx.exec(content))) {
    const attrs = m[1];
    const lang = (attrs.match(/\blang\s*=\s*["']([\w-]+)["']/) || [])[1] || 'css';
    out.push({ lang, scoped: /\bscoped\b/.test(attrs), module: /\bmodule\b/.test(attrs), global: /\bglobal\b/.test(attrs), line: lineAt(content, m.index), src: (attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/) || [])[1] || null });
  }
  return out;
}

function sassTokens(files) {
  const vars = new Set();
  const mixins = new Set();
  const fns = new Set();
  for (const f of files) {
    if (!/\.(scss|sass)$/.test(f.rel) && !(f.role === 'component' && /lang=["'](scss|sass)/.test(f.content))) continue;
    for (const m of f.content.matchAll(/^\s*(\$[\w-]+)\s*:/gm)) vars.add(m[1]);
    for (const m of f.content.matchAll(/@mixin\s+([\w-]+)(\([^)]*\))?/g)) mixins.add(m[1] + (m[2] || ''));
    for (const m of f.content.matchAll(/@function\s+([\w-]+)/g)) fns.add(m[1] + '()');
    for (const m of f.content.matchAll(/^\s*(--[\w-]+)\s*:/gm)) vars.add(`var(${m[1]})`);
  }
  return { vars: [...vars].slice(0, 40), mixins: [...mixins].slice(0, 15), fns: [...fns].slice(0, 10) };
}

function cssModuleRule(files, cls) {
  for (const f of files) {
    if (!/\.module\.(css|scss|sass|less)$/.test(f.rel)) continue;
    const m = f.content.match(new RegExp(`\\.${escRx(cls)}(?![\\w-])`));
    if (m) return { file: f.rel, line: lineAt(f.content, m.index) };
  }
  return null;
}

const SYSTEM_LABEL = {
  'styled-components': 'styled-components',
  emotion: 'Emotion',
  'mui-styled': 'MUI styled()',
  'mui-sx': 'MUI sx prop',
  linaria: 'Linaria',
  stitches: 'Stitches',
  'vanilla-extract': 'vanilla-extract',
  'twin.macro': 'twin.macro',
  'scss-module': 'SCSS Module',
  'sass-module': 'Sass Module',
  'less-module': 'Less Module',
  'css-module': 'CSS Module',
  scss: 'SCSS stylesheet',
  sass: 'Sass stylesheet',
  less: 'Less stylesheet',
  css: 'CSS stylesheet',
  tailwind: 'Tailwind CSS',
  unocss: 'UnoCSS utilities',
  'vue-style': 'Vue <style> block',
  'svelte-style': 'Svelte <style> block',
  'angular-styles': 'Angular component styles',
  'styled-jsx': 'styled-jsx',
  'emotion-css-prop': 'Emotion css prop',
  inline: 'inline style',
  unknown: 'no clear styling system',
};

function moduleKind(rel) {
  const m = rel.match(/\.module\.(css|scss|sass|less)$/);
  if (!m) return null;
  return { css: 'css-module', scss: 'scss-module', sass: 'sass-module', less: 'less-module' }[m[1]];
}

function sheetKind(rel) {
  return moduleKind(rel) || (rel.match(/\.(scss|sass|less|css)$/) || [])[1] || null;
}

/**
 * Work out how the clicked element — and its component — is styled.
 * files: editableFiles() output (component, stylesheet, styles, call-site, reference).
 * Returns { primary, label, element, systems: [{system, where}], rules: [...prompt lines], project }
 */
function detectStyling(root, files, { line, tag } = {}) {
  const project = projectStyling(root);
  const component = files.find((f) => f.role === 'component');
  const content = component ? component.content : '';
  const isSfc = component && /\.(vue|svelte)$/.test(component.rel);
  const opening = component ? openingTagAt(content, line) : { name: null, text: '' };
  const systems = [];
  const add = (system, where) => {
    if (!systems.some((s) => s.system === system && s.where === where)) systems.push({ system, where });
  };

  // --- what the component and its style files use ---
  const sheets = files.filter((f) => f.role === 'stylesheet');
  for (const s of sheets) add(sheetKind(s.rel), s.rel);
  for (const f of files.filter((x) => x.role === 'component' || x.role === 'styles')) {
    const lib = cssInJsLib(f.content);
    if (lib && /\b(styled|css|keyframes|createGlobalStyle|style|recipe)\s*[.(`]/.test(f.content)) add(lib, f.rel);
    if (/<style\s+jsx\b/.test(f.content)) add('styled-jsx', f.rel);
    if (/\bsx\s*=\s*\{/.test(f.content) && project.mui) add('mui-sx', f.rel);
    if (/\bcss\s*=\s*\{/.test(f.content) && project.emotion) add('emotion-css-prop', f.rel);
  }
  if (isSfc) {
    for (const b of sfcStyleBlocks(content)) {
      if (b.src) continue;
      add(component.rel.endsWith('.vue') ? 'vue-style' : 'svelte-style', `${component.rel} <style${b.lang !== 'css' ? ` lang="${b.lang}"` : ''}${b.scoped ? ' scoped' : ''}${b.module ? ' module' : ''}>`);
    }
  }
  // Angular: styles inline in the @Component decorator (styleUrl files are already listed as stylesheets)
  const ngCls = files.find((f) => f.role === 'class') || (component && /\.ts$/.test(component.rel) && /@Component\s*\(/.test(content) ? component : null);
  if (ngCls && /\bstyles\s*:\s*[[`'"]/.test(ngCls.content)) add('angular-styles', `${ngCls.rel} @Component styles`);
  const allClassAttrs = [...content.matchAll(/\b(?:className|class)\s*=\s*("[^"]*"|'[^']*'|\{`[^`]*`\}|\{(?:clsx|cn|classNames|cx|twMerge)\([^)]*\)\})/g)].map((m) => m[1]).join(' ');
  if ((project.tailwind || project.unocss) && looksTailwind(allClassAttrs)) add(project.tailwind ? 'tailwind' : 'unocss', component ? component.rel : 'className');
  if (/\bstyle\s*=\s*\{\{/.test(content) || /:style\s*=/.test(content)) add('inline', component ? component.rel : '');

  // --- the clicked element itself ---
  let element = null;
  const tagName = opening.name;
  if (tagName && /^[A-Z]|\./.test(tagName)) {
    const def = findStyledDefinition(files, tagName);
    if (def) element = { kind: def.lib === 'css-in-js' ? 'styled-components' : def.lib, tag: tagName, definedIn: def.file, line: def.line, note: `<${tagName}> is a ${def.lib} component defined in ${def.file}:${def.line}` };
  }
  if (!element) {
    const cls = classNameExpr(opening.text);
    const modRef = cls && cls.match(/\b(styles|classes|css|s|style|cls)\s*(?:\.\s*([A-Za-z_][\w]*)|\[\s*['"]([\w-]+)['"]\s*\])/);
    if (modRef) {
      const name = modRef[2] || modRef[3];
      const rule = cssModuleRule(files, name);
      const mod = files.find((f) => moduleKind(f.rel));
      if (mod) element = { kind: moduleKind(mod.rel), className: name, definedIn: rule ? rule.file : mod.rel, line: rule ? rule.line : null, note: `uses class .${name} from ${rule ? `${rule.file}:${rule.line}` : mod.rel}${rule ? '' : ' (rule not written yet)'}` };
    } else if (cls && (project.tailwind || project.unocss) && looksTailwind(cls)) {
      element = { kind: project.tailwind ? 'tailwind' : 'unocss', classes: cls, note: `has utility classes ${cls.length > 120 ? cls.slice(0, 120) + '…' : cls}` };
    } else if (/\bsx\s*=\s*\{/.test(opening.text)) {
      element = { kind: 'mui-sx', note: 'is styled through its sx prop' };
    } else if (/\bcss\s*=\s*\{/.test(opening.text) && project.emotion) {
      element = { kind: 'emotion-css-prop', note: 'is styled through the Emotion css prop' };
    } else if (/\b(?:style|:style)\s*=\s*\{/.test(opening.text) || /:style\s*=/.test(opening.text)) {
      element = { kind: 'inline', note: 'is styled with an inline style' };
    } else if (cls && ngCls && !sheets.length && systems.some((s) => s.system === 'angular-styles')) {
      const first = cls.replace(/^["'{`]+|["'}`]+$/g, '').split(/\s+/)[0];
      element = { kind: 'angular-styles', className: first, note: `uses class .${first}, styled in the component's @Component styles` };
    } else if (cls && isSfc && systems.some((s) => /-style$/.test(s.system))) {
      const first = cls.replace(/^["'{`]+|["'}`]+$/g, '').split(/\s+/)[0];
      element = { kind: component.rel.endsWith('.vue') ? 'vue-style' : 'svelte-style', className: first, note: `uses class .${first}, styled in the component's <style> block` };
    } else if (cls && sheets.length) {
      const first = cls.replace(/^["'{`]+|["'}`]+$/g, '').split(/\s+/)[0];
      const sheet = sheets.find((s) => new RegExp(`\\.${escRx(first)}(?![\\w-])`).test(s.content)) || sheets[0];
      element = { kind: sheetKind(sheet.rel), className: first, definedIn: sheet.rel, note: `uses class .${first} from ${sheet.rel}` };
    }
  }

  // --- pick the primary approach: the element's own > the component's > the project's ---
  const ORDER = [
    'styled-components', 'emotion', 'mui-styled', 'linaria', 'stitches', 'vanilla-extract', 'twin.macro',
    'scss-module', 'sass-module', 'less-module', 'css-module', 'vue-style', 'svelte-style', 'tailwind', 'unocss', 'angular-styles',
    'mui-sx', 'emotion-css-prop', 'styled-jsx', 'scss', 'sass', 'less', 'css', 'inline',
  ];
  let primary = element ? element.kind : null;
  if (!primary) primary = ORDER.find((k) => systems.some((s) => s.system === k)) || null;
  const overall = safeStats(root);
  if (!primary && overall && overall.dominant) {
    const d = overall.dominant;
    const map = { 'tailwind-css': 'tailwind', 'scss-module': 'scss-module', 'css-module': 'css-module', 'less-module': 'less-module', mui: 'mui-styled' };
    const cand = map[d] || d;
    if (SYSTEM_LABEL[cand] && !/^(vue|svelte)-style/.test(cand)) primary = cand;
    else if (/^vue-style/.test(d) && isSfc && component.rel.endsWith('.vue')) primary = 'vue-style';
    else if (/^svelte-style/.test(d) && isSfc && component.rel.endsWith('.svelte')) primary = 'svelte-style';
  }
  if (!primary) {
    if (project.styledComponents) primary = 'styled-components';
    else if (project.emotion) primary = 'emotion';
    else if (project.tailwind) primary = 'tailwind';
    else if (project.sass) primary = 'scss';
    else primary = 'unknown';
  }
  const where = element && element.definedIn ? element.definedIn : (systems.find((s) => s.system === primary) || {}).where;
  const sfcBlock = (primary === 'vue-style' || primary === 'svelte-style') && where && component && where.startsWith(component.rel + ' ');
  const label = sfcBlock
    ? `${primary === 'vue-style' ? 'Vue' : 'Svelte'} ${where.slice(component.rel.length + 1)}`
    : `${SYSTEM_LABEL[primary] || primary}${where && where !== (component && component.rel) ? ` · ${path.basename(where.split(' ')[0])}` : ''}`;

  const rules = stylingRules(primary, { element, systems, project, files, component, isSfc, angular: Boolean(ngCls) });
  if (overall && overall.systems.length) rules.push(`Across the whole project the styling is: ${overall.summary}. New markup must look native: reuse the classes / styled components / stylesheet rules the surrounding code already uses.`);
  return { primary, label, element, systems, project, overall, rules };
}

function safeStats(root) {
  try {
    return project.stats(root);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// 2b. Theme / global style changes
// ---------------------------------------------------------------------------------------------

/**
 * Rules for a change to the look of the WHOLE app, for whatever styling system(s) the project uses.
 * stats: project.stats(), theme: project.themeFiles(), styling: detectStyling() of the clicked element.
 */
function themeRules(root, stats, theme, styling) {
  const r = [];
  const has = (k) => theme.some((f) => f.kind === k);
  const list = (k) => theme.filter((f) => f.kind === k).map((f) => f.rel).join(', ');
  const s = stats || { counts: {}, systems: [], twColors: [], twOther: [], hexColors: [], cssVars: [] };
  const counts = s.counts || {};
  const tw = s.tailwind || counts.tailwind;
  const cssInJs = ['styled-components', 'emotion', 'linaria', 'stitches', 'mui', 'vanilla-extract'].filter((k) => counts[k]);
  const sheets = ['css', 'scss', 'less', 'css-module', 'scss-module', 'less-module'].filter((k) => counts[k]);
  const sfc = Object.keys(counts).filter((k) => /^(vue|svelte)-style/.test(k));

  r.push(`This change is SITE-WIDE: every page and component must pick it up, not only the clicked element. Implement it at the project's source of truth for its look — the THEME FILES below — instead of editing one component. Project styling: ${s.summary || 'unknown'}.`);
  r.push('Interpret the request as a coherent theme: choose a consistent palette (background, surface/card, text, muted text, border, primary + hover, accent), and apply every role. Keep sufficient contrast (WCAG AA: 4.5:1 for body text). Values the request names must be used exactly.');
  if (theme.length) r.push(`THEME FILES (editable): ${theme.map((f) => `${f.rel} — ${f.why}`).join('; ')}.`);
  else r.push('No global stylesheet or theme file was found. Put the theme in the root layout / app entry shown (a global <style> / class on the outermost element), or in the stylesheet the entry imports.');

  if (tw) {
    const major = s.tailwindMajor || 3;
    const used = s.twColors.map(([k, n]) => `${k}×${n}`).slice(0, 24).join(', ');
    const palettes = [...new Set(s.twColors.map(([k]) => k.replace(/^[a-z]+-/, '').replace(/-\d{2,3}$/, '')))].slice(0, 12);
    r.push(`Tailwind ${major}: components hard-code utility classes, so re-theme by REMAPPING the theme values those classes read — that changes every page at once without touching each component. Most used colour utilities in the project: ${used || '(none found)'} → palettes in use: ${palettes.join(', ') || 'none'}.`);
    if (major >= 4) {
      r.push(`Tailwind v4: edit the @theme block of the main CSS file${has('tailwind-css') ? ` (${list('tailwind-css')})` : ''} (add one right after @import "tailwindcss" if missing). Redefining a palette variable re-colours every utility that uses it: --color-blue-600: #…; (do the full 50–950 scale of each palette you remap), --color-white / --color-black, --font-sans, --radius-lg etc. Page background/text: a rule in @layer base { body { … } } or the classes on <body>/<html> in the root layout.`);
    } else {
      r.push(`Tailwind v3: edit ${has('tailwind-config') ? list('tailwind-config') : 'tailwind.config'} → theme.extend: colors (redefine the palettes the project uses, e.g. blue: { 50: '#…', …, 950: '#…' }, white: '#…', gray: {…}), fontFamily.sans, borderRadius. Keep existing config keys, plugins and content globs. Page background/text: @layer base { body { @apply … } } in the global CSS${has('tailwind-css') ? ` (${list('tailwind-css')})` : ''}, or the classes on <body>/<html> in the root layout.`);
    }
    r.push('A scheme inversion (e.g. "make the whole site dark") in a project whose components use light utilities (bg-white, bg-gray-50, text-gray-900…) is done by remapping those palette entries (white → dark surface, the gray scale reversed: gray-50 ↔ gray-950 …) so the existing classes render the new scheme. If the project already uses dark: variants with a class strategy, add the class to <html> in the root layout instead.');
    if (s.twOther.length) r.push(`Other theme-related utilities in use: ${s.twOther.map(([k, n]) => `${k}×${n}`).join(', ')}.`);
  }
  if (sheets.length || sfc.length) {
    const vars = s.cssVars.length ? ` Existing custom properties: ${s.cssVars.slice(0, 50).join(', ')}.` : '';
    const hex = s.hexColors.length ? ` Most used hard-coded colours: ${s.hexColors.slice(0, 14).map(([k, n]) => `${k}×${n}`).join(', ')}.` : '';
    r.push(`Stylesheets (${[...sheets, ...sfc].join(', ')}): change the design tokens first — :root custom properties, Sass $variables, Less @variables in the THEME FILES — so every rule that reads them changes.${vars}${hex}`);
    r.push('Where colours/fonts are hard-coded instead of tokens, add (or extend) global rules in the global stylesheet — body, h1–h6, a, button, input, card/section classes the pages use — and introduce tokens there. CSS Modules and component stylesheets you can see may be edited too when a global rule cannot reach them (specificity), using the same tokens.');
    if (counts.scss || counts['scss-module']) r.push('SCSS: keep SCSS syntax; if a stylesheet starts using a variable from a partial it does not @use yet, add the @use/@import line. Prefer CSS custom properties for colours that must change at runtime.');
    if (counts.less || counts['less-module']) r.push('Less: variables are @name: value; — change them where they are defined (variables/theme .less file) and keep the @import order.');
  }
  if (cssInJs.length) {
    r.push(`CSS-in-JS (${cssInJs.join(', ')}): change the theme object every styled component reads (the object passed to <ThemeProvider theme={…}>, createTheme({ palette … }), tokens) and the global styles (createGlobalStyle\` … \` / <Global styles>).${has('theme') ? ` Theme: ${list('theme')}.` : ''}${has('global-styles') ? ` Global styles: ${list('global-styles')}.` : ''} Keep every existing key (components reference them); change values, add keys only if needed.`);
    r.push('If components hard-code colours instead of reading the theme, add global rules in createGlobalStyle / <Global> (or the global CSS file) for body, headings, links and buttons; edit a styled component you can see only when that is the only way.');
  }
  if (!tw && !sheets.length && !sfc.length && !cssInJs.length) {
    r.push('The project has no clear styling system. Put the theme in one global place: CSS custom properties in :root plus base rules (body, headings, links, buttons) in the global stylesheet the entry file imports, or a <style> in the root layout if there is none.');
  }
  r.push('Do not change markup, text or behaviour. Do not rename classes, tokens or theme keys that existing code uses.');
  return r;
}

function stylingRules(primary, { element, systems, project, files, component, angular: isNg }) {
  const r = [];
  const others = systems.filter((s) => s.system !== primary).map((s) => `${SYSTEM_LABEL[s.system] || s.system} (${s.where})`);
  r.push(`Primary styling approach for this element: ${SYSTEM_LABEL[primary] || primary}.${element ? ` The clicked element ${element.note}.` : ''}`);
  if (others.length) r.push(`Also present in these files: ${others.join('; ')}. Do not switch approaches: style changes go where the clicked element is already styled.`);

  const tokens = sassTokens(files);
  const sc = project.styledComponentsMajor;

  switch (primary) {
    case 'styled-components':
    case 'emotion':
    case 'mui-styled':
    case 'linaria':
    case 'stitches':
    case 'twin.macro':
      r.push(
        element && element.definedIn
          ? `Change the CSS inside the template literal / style object of ${element.local || element.tag} in ${element.definedIn} (around line ${element.line}). Do not add a className, a stylesheet or inline styles for it.`
          : 'Change the existing styled definitions (styled.x`…` / styled(X)`…` / css`…`). If the element has no styled wrapper yet, create one next to the existing ones (same file that holds the other styled definitions) and use it in place of the plain tag.'
      );
      r.push('Write valid CSS inside the template: every declaration ends with a semicolon, nesting uses &:hover / & > span like the existing rules, and ${…} interpolations stay intact.');
      if (files.some((f) => /\btheme\b/.test(f.content) && (f.role === 'styles' || f.role === 'component'))) {
        r.push('The styles read values from the theme (${({ theme }) => theme.…}). Reuse theme values the file already uses instead of hard-coding new colours or sizes where a theme value fits.');
      }
      if (primary === 'styled-components') {
        r.push(
          sc && sc >= 6
            ? 'styled-components v6: pass style-only props as transient props ($isActive, $size) so they are not forwarded to the DOM.'
            : 'For conditional styles use props in interpolations (${(p) => p.$active && css`…`}); prefer transient $props for style-only flags.'
        );
      }
      break;
    case 'scss-module':
    case 'sass-module':
    case 'less-module':
    case 'css-module':
      r.push(
        element && element.className
          ? `Change the .${element.className} rule in ${element.definedIn}${element.line ? ` (line ${element.line})` : ''}. If the change needs a new class, add it to that module and reference it as styles.newClass in the markup.`
          : 'Style changes go into the imported module stylesheet; reference new classes as styles.className in the markup. Never use global class names for module styles.'
      );
      break;
    case 'scss':
    case 'sass':
    case 'less':
    case 'css':
      r.push(
        element && element.className
          ? `Change the .${element.className} rule in ${element.definedIn}. Make selectors specific enough not to affect other components that share the stylesheet.`
          : 'Style changes go into the stylesheet the component imports. Use selectors that only match this component.'
      );
      break;
    case 'tailwind':
    case 'unocss':
      r.push('Change utility classes in className / class. Do not write CSS files or inline styles. Use the design scale (p-4, text-lg, bg-red-600); use arbitrary values (w-[37px]) only when nothing on the scale fits.');
      r.push('Responsive and state variants use prefixes (md:, hover:, focus-visible:, dark:). Replace conflicting classes instead of appending a second one (remove p-2 when adding p-4).');
      if (project.classUtils.length) r.push(`The project has ${project.classUtils.join(', ')}: keep using them the way the file does (cn(...), clsx(...), cva variants).`);
      if (project.tailwind && project.tailwindMajor >= 4) r.push('Tailwind v4: theme tokens live in CSS (@theme); there is no tailwind.config to edit.');
      break;
    case 'vue-style':
    case 'svelte-style':
      r.push(`Edit the component's own <style> block in ${component ? component.rel : 'the component'}, keeping its lang/scoped/module attributes. Add or change classes in the template as needed.${
        primary === 'vue-style' ? ' The <style> block is top-level (a sibling of <template>), never inside <template>.' : ''
      }`);
      break;
    case 'angular-styles':
      r.push('Edit the styles in the @Component decorator (styles: [ … ] or styles: `…`) of the component class. Add or change classes in the template as needed.');
      break;
    case 'mui-sx':
      r.push('Change the sx prop of the clicked element. Use theme shortcuts (p: 2, color: "primary.main", bgcolor) like the existing sx objects.');
      break;
    case 'emotion-css-prop':
      r.push('Change the css prop of the clicked element (css={css`…`} or object styles), matching the existing usage.');
      break;
    case 'styled-jsx':
      r.push('Edit the <style jsx> block of the component.');
      break;
    case 'inline':
      r.push('The element is styled inline. Change its style object (style={{ … }} / :style) unless the component also has a stylesheet, in which case prefer adding a class there.');
      break;
    default:
      r.push('There is no clear styling system for this element. Follow whatever the file already does (className, inline style, <style> block). If nothing exists, prefer a small inline style object over creating new files.');
  }

  if (isNg) {
    r.push('Angular component styles are scoped to their component (emulated encapsulation): put the rule in the stylesheet of the component whose template contains the element. Use :host for the component\'s own element; avoid ::ng-deep unless restyling a child component\'s internals.');
  }
  const isSass = /scss|sass/.test(primary) || files.some((f) => /\.(scss|sass)$/.test(f.rel)) || (component && /lang=["'](scss|sass)/.test(component.content));
  if (isSass) {
    r.push('Sass: keep SCSS syntax (nesting with &, //-comments are fine). In .sass files use the indented syntax — no braces or semicolons.');
    if (tokens.vars.length || tokens.mixins.length) {
      r.push(
        `Reuse the existing Sass tokens instead of hard-coded values when one fits: ${[...tokens.vars, ...tokens.mixins.map((m) => '@include ' + m), ...tokens.fns].slice(0, 45).join(', ')}.` +
          ' Files marked READ-ONLY show where they come from; if a stylesheet uses a token from a partial it does not @use yet, add the @use line.'
      );
    }
  }
  return r;
}

// ---------------------------------------------------------------------------------------------
// 3. Conventions for new components
// ---------------------------------------------------------------------------------------------

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).map((d) => (d.isDirectory() ? d.name + '/' : d.name));
  } catch {
    return [];
  }
}

/**
 * Where new component files may go and how they should look, derived from the clicked component.
 * Returns { dirs: [abs…], rules: [...] }.
 */
/**
 * Rules for the component file(s) a new page uses: naming, exports, styling — but not WHERE they go or that the
 * clicked component renders them (routes.detect() decides that for a page).
 */
function pageComponentRules(root, files, styling) {
  const { rules } = componentConventions(root, files, styling);
  const skip = /may only be created in|^Import it into the clicked|^Import the new component into the clicked|^Use it in .* by its selector|^Render the new component where|^Files next to the clicked|^This project uses one folder per component|^The clicked component is declared in an NgModule|^Reusable components of this project/;
  return rules.filter((r) => !skip.test(r)).map((r) => r.replace(/the clicked component/g, 'the existing components'));
}

function componentConventions(root, files, styling) {
  const component = files.find((f) => f.role === 'component');
  if (!component) return { dirs: [], rules: [] };
  const ngClass = files.find((f) => f.role === 'class') || (/\.ts$/.test(component.rel) && /@Component\s*\(/.test(component.content) ? component : null);
  if (ngClass && angular.isAngular(root)) return angularConventions(root, files, styling, component, ngClass);

  const abs = component.abs;
  const dir = path.dirname(abs);
  const ext = path.extname(abs);
  const base = path.basename(abs, ext);
  const dirName = path.basename(dir);
  const folderPerComponent = base === 'index' || base === dirName;
  const parent = path.dirname(dir);
  const relDir = (d) => path.relative(root, d).split(path.sep).join('/') || '.';
  const dirs = [dir];
  if (folderPerComponent && path.relative(root, parent) && !path.relative(root, parent).startsWith('..')) dirs.push(parent);
  // Route / layout files (app/page.tsx, src/routes/+page.svelte, pages/…) are no place for reusable components:
  // the project's components folder is.
  const shared = project.componentDirs(root);
  const routeish = /(^|[\\/])(page|layout|template|_app|\+page|\+layout|__root|root)\.\w+$/.test(abs) || /(^|[\\/])(app|pages|routes|views|layouts)[\\/]/.test(abs);
  for (const d of shared) if (!dirs.includes(d)) (routeish ? dirs.unshift(d) : dirs.push(d));

  const c = component.content;
  const isTs = /\.tsx?$/.test(ext);
  const sfc = ext === '.vue' || ext === '.svelte';
  const r = [];
  r.push(`New component file(s) may only be created in ${dirs.map((d) => relDir(d) + '/').join(' or ')} (subfolders allowed). Use paths relative to the project root, e.g. "${relDir(folderPerComponent ? parent : dir)}/${folderPerComponent ? 'PriceTag/PriceTag' : 'PriceTag'}${ext}".`);
  if (ext === '.svelte') {
    const runes = /\$(props|state|derived|effect)\s*[(<]/.test(c);
    const ts = /<script\b[^>]*lang=["']ts["']/.test(c);
    r.push(`Match the clicked component: a PriceTag.svelte single-file component${ts ? ' with <script lang="ts">' : ''}, PascalCase file name. ${runes ? 'Declare props with let { price } = $props()' : 'Declare props with export let price'} like the clicked component does.`);
    r.push(`Import it into the clicked component with a DEFAULT import that keeps the extension:  import PriceTag from './PriceTag.svelte';  — a .svelte file has no named exports, so import { PriceTag } would be undefined. Then render <PriceTag … />.`);
  } else if (ext === '.vue') {
    const setup = /<script\b[^>]*\bsetup\b/.test(c);
    const ts = /<script\b[^>]*lang=["']ts["']/.test(c);
    r.push(`Match the clicked component: a PriceTag.vue single-file component with ${setup ? `<script setup${ts ? ' lang="ts"' : ''}> and defineProps` : `the Options API (export default { props: … })${ts ? ' and lang="ts"' : ''}`}, PascalCase file name.`);
    r.push(`Import it into the clicked component with a DEFAULT import that keeps the extension:  import PriceTag from './PriceTag.vue';  — never import { PriceTag }.${setup ? '' : ' Also register it in components: { PriceTag }.'} Then render <PriceTag … />.`);
  } else {
    const def = /export\s+default\b/.test(c);
    r.push(`Match the clicked component: file extension ${ext}, PascalCase name, ${def ? 'default export' : 'named export'}${isTs ? ', typed props (an interface/type like the existing component uses)' : ''}.`);
    r.push(def ? `Import it with a default import: import PriceTag from './PriceTag';` : `Import it with a named import: import { PriceTag } from './PriceTag';`);
  }
  if (folderPerComponent) r.push(`This project uses one folder per component (${relDir(dir)}/${path.basename(abs)}): create the new one as its own folder next to it, with the same file naming.`);
  const siblings = listDir(dir).filter((n) => !/^\./.test(n)).slice(0, 30);
  if (siblings.length) r.push(`Files next to the clicked component: ${siblings.join(', ')}.`);
  if (siblings.some((n) => /\.(test|spec|stories)\./.test(n))) r.push('Do not create tests or stories unless asked.');

  const p = styling ? styling.primary : 'unknown';
  if (/-module$/.test(p)) {
    const modExt = (files.find((f) => moduleKind(f.rel)) || { rel: '.module.css' }).rel.match(/\.module\.\w+$/)[0];
    r.push(`Style the new component with its own ${modExt} file next to it (NewName${modExt}), imported as styles — same as the clicked component.`);
  } else if (['styled-components', 'emotion', 'linaria', 'stitches', 'mui-styled'].includes(p)) {
    const stylesFile = files.find((f) => f.role === 'styles');
    r.push(
      stylesFile
        ? `Style the new component with ${SYSTEM_LABEL[p]}, in its own ${path.basename(stylesFile.rel).replace(/^[^.]+/, 'NewName')} file, like ${stylesFile.rel}.`
        : `Style the new component with ${SYSTEM_LABEL[p]}, with the styled definitions in the same file like the clicked component.`
    );
  } else if (p === 'tailwind' || p === 'unocss') {
    r.push('Style the new component with utility classes; do not create a stylesheet.');
  } else if (p === 'vue-style' || p === 'svelte-style' || (sfc && /<style\b/.test(c))) {
    r.push(
      `Give the new single-file component its own <style> block with the same lang/scoped attributes as the clicked one.${
        ext === '.vue' ? ' In a .vue file the <style> block is a TOP-LEVEL block, a sibling of <template> and <script> — never put it inside <template>.' : ''
      }`
    );
  } else if (['scss', 'sass', 'less', 'css'].includes(p)) {
    r.push(`Put the new component's styles in its own .${p} file next to it and import it, like the clicked component does.`);
  }
  const alias = project.aliases(root).find((a) => fs.existsSync(a.dir));
  if (shared.length) r.push(`Reusable components of this project live in ${shared.map((d) => relDir(d) + '/').join(', ')}${routeish ? ' — put the new component there, not next to a route/layout file' : ''}.${alias ? ` Imports may use the alias ${alias.prefix} → ${relDir(alias.dir)}/ the way existing files do.` : ''}`);
  r.push('Render the new component where PLACEMENT says (or in place of the markup it was extracted from), and import it in THAT file. Move any state or handlers it needs, and pass data in as props.');
  return { dirs, rules: r };
}

const toKebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase();

function angularPrefix(root, meta) {
  const m = meta && meta.selector && meta.selector.match(/^([a-z][a-z0-9]*)-/);
  if (m) return m[1];
  try {
    const ws = JSON.parse(fs.readFileSync(path.join(root, 'angular.json'), 'utf8'));
    for (const p of Object.values(ws.projects || {})) if (p && p.prefix) return p.prefix;
  } catch {}
  return 'app';
}

/** Angular CLI conventions for a new component, taken from the clicked one. */
function angularConventions(root, files, styling, component, cls) {
  const major = angular.angularMajor(root);
  const meta = angular.componentsIn(cls.content)[0] || null;
  const dir = path.dirname(cls.abs);
  const relDir = path.relative(root, dir).split(path.sep).join('/') || '.';
  const oldStyle = /\.component\.ts$/.test(cls.abs); // price-tag.component.ts + PriceTagComponent (Angular ≤ 19 CLI)
  const prefix = angularPrefix(root, meta);
  const styleUrl = meta && meta.styleUrls[0];
  const styleExt = styleUrl ? path.extname(styleUrl) : meta && meta.inlineStyles ? null : '.css';
  const inlineTpl = Boolean(meta && meta.template && !meta.templateUrl);
  const stem = oldStyle ? 'price-tag.component' : 'price-tag';
  const className = oldStyle ? 'PriceTagComponent' : 'PriceTag';
  const folder = `${relDir}/price-tag`;
  const standaloneOwner = angular.isStandalone(meta, major);
  const usesSignals = /\b(input|signal|computed|output)\s*[(<]/.test(cls.content);
  const onPush = /ChangeDetectionStrategy\.OnPush/.test(cls.content);

  const r = [];
  r.push(`New component file(s) may only be created in ${relDir}/ (subfolders allowed). Create the component in its own folder, like \`ng generate component price-tag\` would: ${[`${folder}/${stem}.ts`, inlineTpl ? null : `${folder}/${stem}.html`, styleExt ? `${folder}/${stem}${styleExt}` : null].filter(Boolean).join(', ')}.`);
  r.push(
    `Match the clicked component: class ${className} (${oldStyle ? 'PascalCase + "Component" suffix, files named *.component.*' : 'PascalCase without a "Component" suffix, files named without ".component"'}), selector '${prefix}-price-tag', ${inlineTpl ? 'an inline template' : `templateUrl: './${stem}.html'`}${styleExt ? (/styleUrls\s*:/.test(cls.content) ? `, styleUrls: ['./${stem}${styleExt}']` : `, styleUrl: './${stem}${styleExt}'`) : meta && meta.inlineStyles ? ', inline styles' : ''}${onPush ? ', changeDetection: ChangeDetectionStrategy.OnPush' : ''}.`
  );
  r.push(`Export the class with a NAMED export (export class ${className}) and import it with a named import without the .ts extension: import { ${className} } from './price-tag/${stem}';`);
  r.push((major || 0) >= 19 ? 'Components are standalone by default in this Angular version: do not add standalone: true (and never standalone: false).' : 'Make the new component standalone: true, and list what its own template uses in its imports array.');
  r.push(usesSignals ? 'Inputs with input() / input.required(), outputs with output(), state with signal() — like the clicked component.' : 'Inputs with @Input(), outputs with @Output() + EventEmitter — like the clicked component.');
  if (standaloneOwner) {
    r.push(`Use it in ${component.rel} by its selector (<${prefix}-price-tag … />), add ${className} to the imports array of ${meta ? meta.className : 'the clicked component'}'s @Component, and add the TypeScript import at the top of ${cls.rel}. All three are required.`);
  } else {
    const mod = files.find((f) => f.role === 'module');
    r.push(`The clicked component is declared in an NgModule${mod ? ` (${mod.rel})` : ''}: use the new component by its selector in the template and add ${className} to that module's imports (standalone) — with its TypeScript import.`);
  }
  const p = styling ? styling.primary : 'unknown';
  if (p === 'tailwind' || p === 'unocss') r.push('Style the new component with utility classes in its template; keep its stylesheet empty or omit styleUrl.');
  else if (styleExt) r.push(`Put the new component's styles in its own ${styleExt} file (component styles are scoped to it), using the same conventions as ${styleUrl || 'the clicked component'}.`);
  const siblings = listDir(dir).filter((n) => !/^\./.test(n)).slice(0, 30);
  if (siblings.length) r.push(`Files next to the clicked component: ${siblings.join(', ')}.`);
  r.push('Do not create .spec.ts test files unless asked.');
  r.push('Render the new component where the clicked element is (or in place of the markup it was extracted from). Move the state and handlers it needs into its class and pass data in through inputs.');
  return { dirs: [dir], rules: r };
}

module.exports = {
  KINDS,
  KIND_LABEL,
  classify,
  projectStyling,
  detectStyling,
  componentConventions,
  pageComponentRules,
  themeRules,
  openingTagAt,
  looksTailwind,
  SYSTEM_LABEL,
};
