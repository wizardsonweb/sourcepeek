'use strict';
const { readEnv } = require('./env.cjs');

const TTL = 5 * 60 * 1000;
const cache = new Map();

function repoInfo(root) {
  const env = (n) => readEnv(root, n);
  let owner = null;
  let repo = null;
  const explicit = env('SOURCEPEEK_GITHUB_REPO');
  if (explicit && /^[^/\s]+\/[^/\s]+$/.test(explicit)) [owner, repo] = explicit.replace(/\.git$/, '').split('/');
  else if ((env('VERCEL_GIT_PROVIDER') || 'github') === 'github' && env('VERCEL_GIT_REPO_OWNER') && env('VERCEL_GIT_REPO_SLUG')) {
    owner = env('VERCEL_GIT_REPO_OWNER');
    repo = env('VERCEL_GIT_REPO_SLUG');
  }
  if (!owner || !repo) return null;
  return {
    owner,
    repo,
    branch: env('SOURCEPEEK_GITHUB_BRANCH') || env('VERCEL_GIT_COMMIT_REF') || null,
    sha: env('SOURCEPEEK_GITHUB_SHA') || env('VERCEL_GIT_COMMIT_SHA') || null,
    token: env('SOURCEPEEK_GITHUB_TOKEN') || env('GITHUB_TOKEN') || null,
    api: (env('SOURCEPEEK_GITHUB_API') || 'https://api.github.com').replace(/\/+$/, ''),
    web: (env('SOURCEPEEK_GITHUB_WEB') || 'https://github.com').replace(/\/+$/, ''),
    prefix: (env('SOURCEPEEK_GITHUB_PATH_PREFIX') || '').replace(/^\/+|\/+$/g, ''),
  };
}

function headers(info) {
  const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'sourcepeek', 'X-GitHub-Api-Version': '2022-11-28' };
  if (info.token) h.Authorization = `Bearer ${info.token}`;
  return h;
}

const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

async function commitsFor(info, repoPath) {
  const ref = info.sha || info.branch;
  const q = new URLSearchParams({ path: repoPath, per_page: '5' });
  if (ref) q.set('sha', ref);
  const res = await fetch(`${info.api}/repos/${info.owner}/${info.repo}/commits?${q}`, { headers: headers(info) });
  if (!res.ok) {
    const limited = res.status === 403 || res.status === 429;
    const hidden = res.status === 404 && !info.token;
    const msg = limited
      ? 'GitHub API rate limit reached. Set SOURCEPEEK_GITHUB_TOKEN to raise it.'
      : hidden
        ? 'Repository not reachable. For private repos set SOURCEPEEK_GITHUB_TOKEN.'
        : `GitHub API error (${res.status})`;
    const e = new Error(msg);
    e.github = true;
    throw e;
  }
  const list = await res.json();
  return (Array.isArray(list) ? list : []).map((c) => ({
    hash: c.sha,
    author: (c.commit && c.commit.author && c.commit.author.name) || (c.author && c.author.login) || 'unknown',
    date: (c.commit && c.commit.author && c.commit.author.date) || new Date().toISOString(),
    subject: String((c.commit && c.commit.message) || '').split('\n')[0],
  }));
}

async function blameFor(info, repoPath, line) {
  if (!info.token) return null;
  const expression = info.sha || info.branch || 'HEAD';
  const query = `query($o:String!,$r:String!,$e:String!,$p:String!){repository(owner:$o,name:$r){object(expression:$e){... on Commit{blame(path:$p){ranges{startingLine endingLine commit{oid author{name date}}}}}}}}`;
  const gql = info.api === 'https://api.github.com' ? 'https://api.github.com/graphql' : info.api.replace(/\/v3$/, '') + '/graphql';
  const res = await fetch(gql, {
    method: 'POST',
    headers: { ...headers(info), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { o: info.owner, r: info.repo, e: expression, p: repoPath } }),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const ranges = data && data.data && data.data.repository && data.data.repository.object && data.data.repository.object.blame
    ? data.data.repository.object.blame.ranges
    : [];
  const r = ranges.find((x) => line >= x.startingLine && line <= x.endingLine);
  if (!r || !r.commit) return null;
  return {
    hash: r.commit.oid,
    uncommitted: false,
    author: (r.commit.author && r.commit.author.name) || 'unknown',
    date: (r.commit.author && r.commit.author.date) || new Date().toISOString(),
    summary: '',
  };
}

async function fileContext(root, relPath, line) {
  const info = repoInfo(root);
  if (!info) return null;
  const repoPath = info.prefix ? `${info.prefix}/${relPath}` : relPath;
  const key = `${info.owner}/${info.repo}@${info.sha || info.branch}:${repoPath}:${line}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;

  const ref = info.branch || info.sha;
  const value = {
    git: true,
    source: 'github',
    branch: info.branch || (info.sha ? info.sha.slice(0, 7) : 'unknown'),
    remote: { owner: info.owner, repo: info.repo },
    githubUrl: ref ? `${info.web}/${info.owner}/${info.repo}/blob/${enc(ref)}/${enc(repoPath)}#L${line}` : null,
    commits: [],
    blame: null,
    note: null,
  };
  try {
    const [commits, blame] = await Promise.all([commitsFor(info, repoPath), blameFor(info, repoPath, line).catch(() => null)]);
    value.commits = commits;
    value.blame = blame;
  } catch (err) {
    value.note = err.github ? err.message : 'Could not reach the GitHub API.';
    return value;
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

module.exports = { fileContext, repoInfo };
