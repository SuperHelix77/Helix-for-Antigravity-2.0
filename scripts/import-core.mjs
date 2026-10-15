import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const seeds = [
  'bin/helix-context-mcp.mjs', 'src/cache-stable-aging.mjs',
  'src/tool-call-aging.mjs', 'src/helix-operation-broker.mjs',
  'src/helix-lazy-tool-help.mjs', 'src/helix-initial-observation.mjs',
  'src/helix-post-test-git.mjs', 'src/helix-candidate-cost.mjs',
];
const tests = [
  'helix-goal-engine', 'helix-evidence', 'helix-tool-flow', 'helix-flow-admission',
  'helix-evidence-delta', 'helix-native-function-bridge', 'helix-operation-broker',
  'helix-checkpoint-operation', 'helix-initial-observation', 'helix-post-test-git',
  'helix-lazy-tool-help', 'helix-patch-evidence', 'helix-candidate-cost',
  'tool-call-aging', 'tool-call-retention', 'tool-result-store', 'cache-stable-aging',
];

export function importCore(source) {
  const seen = new Set();
  const pending = [...seeds];
  const records = [];
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    if (file.startsWith('..') || path.isAbsolute(file)) throw new Error('Out-of-scope source');
    seen.add(file);
    if (file === 'src/paths.mjs') continue;
    const input = path.join(source, file);
    const stat = fs.lstatSync(input);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Only explicit regular sources are allowed');
    const bytes = fs.readFileSync(input);
    const destination = path.join(root, file);
    if (fs.existsSync(destination) && !fs.readFileSync(destination).equals(bytes)) throw new Error(`Refusing to overwrite ${file}`);
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    fs.copyFileSync(input, destination);
    fs.chmodSync(destination, stat.mode & 0o777);
    records.push({file, sha256: createHash('sha256').update(bytes).digest('hex')});
    for (const match of bytes.toString('utf8').matchAll(/(?:from\s*|import\s*\()(["'])(\.[^"']+)\1/g)) {
      pending.push(path.normalize(path.join(path.dirname(file), match[2])));
    }
  }
  for (const file of ['LICENSE', 'src/windows-process-tree.ps1', 'bin/helix-source-bundle.py', 'skills/helixcontext/SKILL.md',
    ...tests.map(name => `test/${name}.test.mjs`)]) {
    const input = path.join(source, file);
    if (!fs.existsSync(input)) continue;
    const destination = path.join(root, file);
    if (fs.existsSync(destination) && !fs.readFileSync(destination).equals(fs.readFileSync(input))) throw new Error(`Refusing to overwrite ${file}`);
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    fs.copyFileSync(input, destination);
    records.push({file, sha256: createHash('sha256').update(fs.readFileSync(input)).digest('hex')});
  }
  fs.mkdirSync(path.join(root, 'docs'), {recursive: true});
  const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
  fs.writeFileSync(path.join(root, 'docs/upstream-provenance.json'), JSON.stringify({
    schema: 'helix.source-import.v1', upstream: 'codex-router', base_commit: commit,
    working_tree_sources: true, files: records.sort((a,b) => a.file.localeCompare(b.file)),
    adaptation: 'Portable src/paths.mjs replaces provider/service discovery. Subsequent HELIX changes are tracked in this repository.',
    excluded: ['credentials', 'sessions', 'personal memory', 'raw requests', 'generated workspaces', 'Claude engine'],
  }, null, 2) + '\n');
  return {files: records.length, external_model_calls: 0};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = process.argv[2];
  if (!source) throw new Error('Usage: node scripts/import-core.mjs SOURCE_REPOSITORY');
  console.log(JSON.stringify(importCore(path.resolve(source))));
}
