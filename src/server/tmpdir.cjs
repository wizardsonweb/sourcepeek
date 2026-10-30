'use strict';
// Folders in the system temp directory. /tmp is shared between users on most Linux machines and its paths are
// predictable, so another user could create our folder first and plant files in it. Every folder made here is
// per user (the uid is in the name), created with mode 0700, and checked: a real directory (not a symlink), owned
// by us, with no access for group or others. A folder that fails the check is never used.

const fs = require('fs');
const os = require('os');
const path = require('path');

const uid = typeof process.getuid === 'function' ? process.getuid() : null;

function checkOwned(dir) {
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a directory`);
  if (uid === null) return; // Windows: the temp dir is already per user
  if (st.uid !== uid) throw new Error(`${dir} belongs to another user`);
  if (st.mode & 0o077) fs.chmodSync(dir, 0o700);
}

function ensurePrivateDir(dir) {
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  checkOwned(dir);
  return dir;
}

/**
 * A private folder in the temp directory: <tmp>/<name>-<uid>/<...sub>. Each level is created 0700 and checked,
 * so nothing below it can be swapped for a symlink by another user.
 */
function privateTmpDir(name, ...sub) {
  let dir = ensurePrivateDir(path.join(os.tmpdir(), uid === null ? name : `${name}-${uid}`));
  for (const s of sub) dir = ensurePrivateDir(path.join(dir, s));
  return dir;
}

module.exports = { privateTmpDir, ensurePrivateDir };
