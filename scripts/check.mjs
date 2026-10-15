import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const roots = ['src', 'bin', 'desktop', 'scripts', 'test']; let count = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Release sources must not contain symlinks');
    if (entry.isDirectory()) walk(file);
    else if (/\.(mjs|cjs)$/.test(file)) { execFileSync(process.execPath, ['--check', file], {stdio: 'pipe'}); count++; }
  }
}
for (const directory of roots) walk(directory);
for (const file of ['package.json', 'package-lock.json']) JSON.parse(fs.readFileSync(file));
execFileSync('git', ['diff', '--check'], {stdio: 'inherit'});
console.log(`Checked ${count} modules, package manifests and tracked whitespace.`);
