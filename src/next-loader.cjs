'use strict';
const { transform } = require('./transform.cjs');

module.exports = function sourcepeekLoader(source, map) {
  const opts = (typeof this.getOptions === 'function' ? this.getOptions() : this.query) || {};
  const root = opts.root || this.rootContext || process.cwd();
  let out = null;
  try {
    out = transform(String(source), this.resourcePath, root);
  } catch {
    out = null;
  }
  if (!out) return this.callback(null, source, map);
  this.callback(null, out.code, out.map);
};
