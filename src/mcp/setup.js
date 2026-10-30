// `npx sourcepeek mcp setup [claude|cursor|vscode]` — registers the Sourcepeek MCP server with coding agents for this
// project. Existing entries in the config files are kept; only the "sourcepeek" server is added or updated.

import fs from 'fs';
import path from 'path';

const ENTRY = { command: 'npx', args: ['sourcepeek', 'mcp'] };

function readJson(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, s) => s || '').replace(/,(\s*[}\]])/g, '$1'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

const TARGETS = {
  claude: { file: '.mcp.json', key: 'mcpServers', entry: () => ({ ...ENTRY }), label: 'Claude Code' },
  cursor: { file: '.cursor/mcp.json', key: 'mcpServers', entry: () => ({ ...ENTRY }), label: 'Cursor' },
  vscode: { file: '.vscode/mcp.json', key: 'servers', entry: () => ({ type: 'stdio', ...ENTRY }), label: 'VS Code (Copilot agent mode)' },
};

export function setupMcp(cwd, { c, ok, warn, fail, only = [] }) {
  console.log(`\n🔥 ${c.b('Sourcepeek MCP setup')}\n`);
  if (!fs.existsSync(path.join(cwd, 'package.json'))) {
    fail('No package.json here — run this from your project root.');
    process.exitCode = 1;
    return;
  }
  const wanted = only.length ? only.filter((t) => TARGETS[t]) : ['claude', ...(fs.existsSync(path.join(cwd, '.cursor')) ? ['cursor'] : []), ...(fs.existsSync(path.join(cwd, '.vscode')) ? ['vscode'] : [])];
  for (const bad of only.filter((t) => !TARGETS[t])) warn(`Unknown target "${bad}" — use claude, cursor or vscode.`);
  for (const t of wanted) {
    const { file, key, entry, label } = TARGETS[t];
    const abs = path.join(cwd, file);
    let cfg;
    try {
      cfg = readJson(abs);
    } catch (err) {
      fail(`${file} is not valid JSON (${err.message}) — add the server by hand: "sourcepeek": ${JSON.stringify(entry())}`);
      continue;
    }
    cfg[key] = cfg[key] || {};
    const had = JSON.stringify(cfg[key].sourcepeek || null) === JSON.stringify(entry());
    cfg[key].sourcepeek = entry();
    write(abs, cfg);
    ok(had ? `${file} already has the sourcepeek server (${label})` : `Added the sourcepeek server to ${file} (${label})`);
  }
  console.log(`\n${c.d('Other agents — add a stdio server with the command')}  ${c.m('npx sourcepeek mcp')}`);
  console.log(c.d(`  Claude Code (all projects):  claude mcp add sourcepeek -- npx sourcepeek mcp`));
  console.log(c.d(`  Windsurf: ~/.codeium/windsurf/mcp_config.json → "mcpServers": { "sourcepeek": ${JSON.stringify(ENTRY)} }`));
  console.log(`\nRestart your agent, run your dev server, click an element with Sourcepeek, then ask: ${c.b('“fix this”')}.\n`);
}
