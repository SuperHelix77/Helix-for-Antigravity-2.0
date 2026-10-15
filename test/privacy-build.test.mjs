import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('privacy audit includes untracked generated JavaScript and rejects development source paths', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-privacy-public-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  execFileSync('git', ['init', '-q'], {cwd: directory});
  fs.mkdirSync(path.join(directory, 'dist/assets'), {recursive: true});
  fs.writeFileSync(path.join(directory, '.gitignore'), 'dist/\n');
  const file = path.join(directory, 'dist/assets/application.js');
  const audit = () => spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/privacy-audit.mjs', import.meta.url))],
    {cwd: directory, encoding: 'utf8', timeout: 5000});
  fs.writeFileSync(file, 'console.log("public production fixture")');
  let result = audit();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).generated_js_scanned, 1);
  for (const bad of ['const x = "jsxDEV";', 'const x = "' + '/Users/' + 'synthetic-fixture/source.jsx";']) {
    fs.writeFileSync(file, bad); result = audit();
    assert.equal(result.status, 1, 'The positive control must be caught');
    assert.match(result.stderr, /generated build|development transform/);
  }
});
