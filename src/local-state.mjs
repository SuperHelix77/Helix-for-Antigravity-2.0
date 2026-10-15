import fs from 'node:fs';
import path from 'node:path';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {STATE_DIR} from './paths.mjs';

export function privateDirectory(directory = STATE_DIR) {
  const resolved = path.resolve(directory);
  fs.mkdirSync(resolved, {recursive: true, mode: 0o700});
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) ||
      typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('HELIX_HOME must be an owner-private directory');
  return resolved;
}

export function privateJSON(file, value) {
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}

export function readPrivateJSON(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.mode & 0o077 || typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('Unsafe state file');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}

export function authorized(header, token) {
  const value = Buffer.from(header || ''), expected = Buffer.from(`Bearer ${token}`);
  return value.length === expected.length && timingSafeEqual(value, expected);
}
