'use strict';
// Security checks of the backend: Host / Origin gate, locality, path confinement, stored undo/commit paths,
// private temp folders, login rate limit and cookie parsing. Run with `npm test` (node --test).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const handler = require('../src/server/handler.cjs');
const edit = require('../src/server/edit.cjs');
const auth = require('../src/server/auth.cjs');
const { privateTmpDir } = require('../src/server/tmpdir.cjs');

const LOCAL = '127.0.0.1';
const LAN = '192.168.1.20';

function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sp-test-')));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'App.jsx'), 'export default function App() {\n  return <div>hi</div>;\n}\n');
  return root;
}

function outside() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sp-outside-')));
  const file = path.join(dir, 'secret.js');
  fs.writeFileSync(file, 'module.exports = "secret";\n');
  return file;
}

function call(root, { route, method = 'POST', headers = {}, body = {}, remote = LOCAL, dev = true }) {
  return handler.handle({
    method,
    route,
    headers: { host: 'localhost:5173', 'x-sourcepeek': '1', ...headers },
    getBody: async () => body,
    root,
    dev,
    remote,
  });
}

function withEnv(vars, fn) {
  const old = {};
  for (const k of Object.keys(vars)) {
    old[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  const restore = () => {
    for (const k of Object.keys(old)) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
  };
  return Promise.resolve().then(fn).finally(restore);
}

// ---------- 1. Host / Origin (DNS rebinding) ----------

test('dev gate accepts localhost, *.localhost and IP hosts', () => {
  const root = project();
  for (const host of ['localhost:5173', 'LOCALHOST', 'app.localhost:3000', '127.0.0.1:41234', '[::1]:5173', '192.168.1.20:5173']) {
    assert.equal(handler._devHostProblem(root, { host }), null, host);
  }
});

test('dev gate refuses a rebound domain in Host or X-Forwarded-Host', () => {
  const root = project();
  assert.match(handler._devHostProblem(root, { host: 'evil.example:5173' }), /not allowed/);
  assert.match(handler._devHostProblem(root, { host: '127.0.0.1:41234', 'x-forwarded-host': 'evil.example:3000' }), /not allowed/);
  assert.match(handler._devHostProblem(root, {}), /no Host/);
});

test('dev gate checks Origin against the dev server', () => {
  const root = project();
  assert.equal(handler._devHostProblem(root, { host: 'localhost:5173', origin: 'http://localhost:5173' }), null);
  // a dev-server proxy: the browser is on localhost:3000, the backend on 127.0.0.1:41xxx
  assert.equal(handler._devHostProblem(root, { host: '127.0.0.1:41234', origin: 'http://localhost:3000' }), null);
  assert.equal(handler._devHostProblem(root, { host: '127.0.0.1:41234', 'x-forwarded-host': 'localhost:3000', origin: 'http://localhost:3000' }), null);
  assert.match(handler._devHostProblem(root, { host: 'localhost:5173', origin: 'http://evil.example' }), /not allowed/);
  assert.match(handler._devHostProblem(root, { host: 'localhost:5173', origin: 'null' }), /Origin|not allowed/);
  assert.match(handler._devHostProblem(root, { host: '192.168.1.20:5173', origin: 'http://10.0.0.9:5173' }), /does not match/);
});

test('SOURCEPEEK_ALLOWED_HOSTS adds names and subdomains', () =>
  withEnv({ SOURCEPEEK_ALLOWED_HOSTS: 'myapp.test, .corp.test' }, () => {
    const root = project();
    assert.equal(handler._devHostProblem(root, { host: 'myapp.test:5173' }), null);
    assert.equal(handler._devHostProblem(root, { host: 'a.corp.test' }), null);
    assert.equal(handler._devHostProblem(root, { host: 'corp.test' }), null);
    assert.match(handler._devHostProblem(root, { host: 'notcorp.test' }), /not allowed/);
  }));

test('a rebound request cannot reach /ai/change or /context', async () => {
  const root = project();
  for (const route of ['/ai/change', '/context', '/mcp/selection', '/health']) {
    const [status] = await call(root, { route, method: route === '/health' ? 'GET' : 'POST', headers: { host: 'evil.example:5173' } });
    assert.equal(status, 403, route);
  }
});

// ---------- 2. Locality and reading files outside the project ----------

test('fromThisComputer is false when no address is known', () => {
  assert.equal(handler._fromThisComputer(null, {}), false);
  assert.equal(handler._fromThisComputer(null, { 'x-forwarded-for': '127.0.0.1' }), true);
  assert.equal(handler._fromThisComputer(LOCAL, { 'x-forwarded-for': `${LOCAL}, ${LAN}` }), false);
});

test('other devices get nothing in dev unless SOURCEPEEK_ALLOW_REMOTE=1', async () => {
  const root = project();
  await withEnv({ SOURCEPEEK_ALLOW_REMOTE: undefined, SOURCEPEEK_ALLOW_REMOTE_EDITS: undefined }, async () => {
    const [status, body] = await call(root, { route: '/context', remote: LAN, headers: { host: '192.168.1.5:5173' }, body: { file: 'src/App.jsx', line: 1 } });
    assert.equal(status, 403);
    assert.equal(body.remote, true);
    const [hs, health] = await call(root, { route: '/health', method: 'GET', remote: LAN, headers: { host: '192.168.1.5:5173' } });
    assert.equal(hs, 200);
    assert.equal(health.remoteBlocked, true);
    assert.equal(health.root, undefined);
  });
  await withEnv({ SOURCEPEEK_ALLOW_REMOTE: '1' }, async () => {
    const [status] = await call(root, { route: '/context', remote: LAN, headers: { host: '192.168.1.5:5173' }, body: { file: 'src/App.jsx', line: 1 } });
    assert.equal(status, 200);
  });
});

test('read endpoints refuse files outside the project', async () => {
  const root = project();
  const secret = outside();
  for (const route of ['/context', '/network', '/storage', '/lookup/handler']) {
    const [status, body] = await call(root, { route, body: { file: secret, line: 1 } });
    assert.equal(status, 403, `${route}: ${JSON.stringify(body)}`);
  }
  const [ok] = await call(root, { route: '/context', body: { file: 'src/App.jsx', line: 1 } });
  assert.equal(ok, 200);
});

test('SOURCEPEEK_SOURCE_ROOTS allows extra folders', () =>
  withEnv({ SOURCEPEEK_SOURCE_ROOTS: undefined }, async () => {
    const root = project();
    const secret = outside();
    process.env.SOURCEPEEK_SOURCE_ROOTS = path.relative(root, path.dirname(secret));
    const [status] = await call(root, { route: '/context', body: { file: secret, line: 1 } });
    assert.equal(status, 200);
  }));

// ---------- 3. Undo / commit trust paths stored on disk ----------

function historyFile(root, id) {
  return path.join(root, 'node_modules', '.cache', 'sourcepeek', 'edits', `${id}.json`);
}

test('undo refuses a tampered history entry that points outside the project', () => {
  const root = project();
  const victim = outside();
  edit.history(root); // creates the folder
  const id = 'tampered-1';
  fs.mkdirSync(path.dirname(historyFile(root, id)), { recursive: true });
  fs.writeFileSync(
    historyFile(root, id),
    JSON.stringify({ id, at: new Date().toISOString(), request: 'x', summary: 'x', files: [{ abs: victim, rel: 'a.js', role: 'component', before: 'pwned\n', after: fs.readFileSync(victim, 'utf8') }] })
  );
  assert.throws(() => edit.undo(root, id, true), (e) => e.status === 409 && /outside the project/.test(e.message));
  assert.equal(fs.readFileSync(victim, 'utf8'), 'module.exports = "secret";\n');
});

test('undo refuses non-source files inside the project', () => {
  const root = project();
  const rc = path.join(root, '.bashrc');
  fs.writeFileSync(rc, 'ok\n');
  assert.throws(() => edit.checkStoredChanges(root, [{ abs: rc, rel: '.bashrc', before: 'x', after: 'ok\n' }]), /not a source/);
});

test('undo of a real change still works', () => {
  const root = project();
  const file = path.join(root, 'src', 'App.jsx');
  const before = fs.readFileSync(file, 'utf8');
  const after = before.replace('hi', 'hello');
  const changes = [{ abs: file, rel: 'src/App.jsx', role: 'component', before, after }];
  edit.writeAll(changes);
  const entry = edit.record(root, 'say hello', 'hello', changes);
  edit.undo(root, entry.id, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('commit refuses a tampered pending proposal on disk', () => {
  const root = project();
  const victim = outside();
  const id = edit.propose('x', 'x', [{ abs: path.join(root, 'src', 'App.jsx'), rel: 'src/App.jsx', before: 'a', after: 'b' }], {}, root);
  const pendingFile = path.join(root, 'node_modules', '.cache', 'sourcepeek', 'edits', 'pending', `${id}.json`);
  const p = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  p.changes = [{ abs: victim, rel: 'x.js', before: fs.readFileSync(victim, 'utf8'), after: 'pwned\n' }];
  fs.writeFileSync(pendingFile, JSON.stringify(p));
  edit.discard(id); // forget the in-memory copy, as after a restart
  assert.throws(() => edit.commit(root, id), (e) => e.status === 409);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'module.exports = "secret";\n');
});

test('pending proposals are kept per project root', () => {
  const a = project();
  const b = project();
  const id = edit.propose('x', 'x', [{ abs: path.join(a, 'src', 'App.jsx'), rel: 'src/App.jsx', before: 'a', after: 'b' }], {}, a);
  assert.throws(() => edit.commit(b, id), (e) => e.status === 404);
  edit.discard(id, a);
});

test('temp folders are private to this user', { skip: process.platform === 'win32' }, () => {
  const dir = privateTmpDir('sourcepeek-test', 'sub');
  const st = fs.lstatSync(dir);
  assert.equal(st.mode & 0o777, 0o700);
  assert.equal(st.uid, process.getuid());
  assert.ok(path.basename(path.dirname(dir)).endsWith(`-${process.getuid()}`));
});

test('a temp folder that is a symlink is refused', { skip: process.platform === 'win32' }, () => {
  const base = path.join(os.tmpdir(), `sourcepeek-test-link-${process.getuid()}`);
  fs.rmSync(base, { recursive: true, force: true });
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-target-'));
  fs.symlinkSync(target, base);
  try {
    assert.throws(() => privateTmpDir('sourcepeek-test-link'), /not a directory/);
  } finally {
    fs.unlinkSync(base);
  }
});

// ---------- 4. MCP snippets ----------

test('MCP snippets only read source files inside the project', async () => {
  const { sourceInProject, snippet } = await import('../src/mcp/server.js');
  const root = project();
  const secret = outside();
  fs.writeFileSync(path.join(root, '.env'), 'KEY=1\n');
  assert.ok(sourceInProject(root, 'src/App.jsx'));
  assert.ok(snippet(root, 'src/App.jsx', 2).includes('return <div>hi</div>'));
  assert.equal(sourceInProject(root, secret), null);
  assert.equal(sourceInProject(root, '../' + path.basename(path.dirname(secret)) + '/secret.js'), null);
  assert.equal(sourceInProject(root, '.env'), null);
  assert.equal(sourceInProject(root, path.join(os.homedir(), '.ssh', 'id_rsa')), null);
  assert.equal(snippet(root, secret, 1), null);
});

// ---------- lower severity: auth ----------

test('login rate limit ignores a forged X-Forwarded-For on direct connections', () => {
  assert.equal(auth._clientIp('203.0.113.7', { 'x-forwarded-for': '1.2.3.4' }), '203.0.113.7');
  // behind a proxy: the entry the proxy added (the last one), not the client-chosen first one
  assert.equal(auth._clientIp('10.0.0.2', { 'x-forwarded-for': '1.2.3.4, 198.51.100.9' }), '198.51.100.9');
  assert.equal(auth._clientIp(null, { 'x-forwarded-for': '198.51.100.9' }), '198.51.100.9');
});

test('rotating X-Forwarded-For does not get more login attempts', async () => {
  auth._reset();
  const token = 'x'.repeat(24);
  let limited = 0;
  for (let i = 0; i < 12; i++) {
    const [status] = await auth.login(token, { token: 'wrong' }, { remote: '203.0.113.7', headers: { 'x-forwarded-for': `1.2.3.${i}` } });
    if (status === 429) limited++;
  }
  assert.ok(limited >= 2);
  auth._reset();
});

test('many failures elsewhere do not lock out the right token', async () => {
  auth._reset();
  const token = 'y'.repeat(24);
  // fill the global counter from many addresses (without waiting for each failure's delay)
  await Promise.all(Array.from({ length: 210 }, (_, i) => auth.login(token, { token: 'nope' }, { remote: `203.0.${i >> 8}.${i & 255}`, headers: {} })));
  const [status] = await auth.login(token, { token }, { remote: '198.51.100.1', headers: {} });
  assert.equal(status, 200);
  auth._reset();
});

test('a malformed cookie is not a server error', () => {
  const token = 'z'.repeat(24);
  assert.doesNotThrow(() => auth.authorized(token, { cookie: 'sourcepeek_session=%E0%A4%A; other=1' }));
  assert.equal(auth.authorized(token, { cookie: 'sourcepeek_session=%E0%A4%A' }), false);
});

test('production gate answers 401, not 500, for a malformed cookie', () =>
  withEnv({ SOURCEPEEK_ENABLE_PROD: '1', SOURCEPEEK_TOKEN: 'q'.repeat(24) }, async () => {
    const root = project();
    const [status] = await call(root, { route: '/context', dev: false, headers: { cookie: 'sourcepeek_session=%zz' } });
    assert.equal(status, 401);
  }));
