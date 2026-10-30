'use strict';
// A small localhost server for the Sourcepeek backend, for dev servers that can't host it as middleware
// (Next.js rewrites to it, the Angular CLI proxies to it). One per project root, on a port derived from the root.

const http = require('http');
const { createHandler } = require('./handler.cjs');

function portFor(root) {
  let h = 0;
  for (const ch of root) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 41000 + (h % 2000);
}

function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/__sourcepeek/health', timeout: 800 }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(d));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

/** Starts the backend for `root` (or finds the one already running) and returns its port. */
async function ensureServer(root) {
  const g = globalThis;
  g.__sourcepeekPorts = g.__sourcepeekPorts || {};
  if (g.__sourcepeekPorts[root]) return g.__sourcepeekPorts[root];
  let port = portFor(root);
  for (let i = 0; i < 10; i++, port++) {
    const server = http.createServer(createHandler({ root, dev: true }));
    try {
      await listen(server, port);
      server.unref();
      g.__sourcepeekPorts[root] = port;
      return port;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      const health = await probe(port);
      if (health && health.name === 'sourcepeek' && health.root === root) {
        g.__sourcepeekPorts[root] = port;
        return port;
      }
    }
  }
  throw new Error('could not find a free port for the backend');
}

module.exports = { ensureServer, portFor, probe };
