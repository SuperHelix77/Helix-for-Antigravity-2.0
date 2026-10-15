import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {launchBenchmark} from '../scripts/launch-benchmark.mjs';
import {processStartIdentityProbe} from '../src/process-identity.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const entry = fileURLToPath(new URL('../scripts/launch-benchmark.mjs', import.meta.url));
function fixture(t, runner) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-launch-no-provider-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, 'controller'));
  const files = {
    'runner.mjs': runner || 'import fs from "node:fs"; fs.appendFileSync("started.txt", "one synthetic start\\n"); await new Promise(resolve => setTimeout(resolve, 700));',
    'helix1-readiness.mjs': 'export function checkNew50Launch({approvedHash}) { return {ready:true,contract_sha256:approvedHash,failures:[]}; }',
  };
  for (let i = 0; i < 978; i++) files[`fixture-${i}.txt`] = 'No model, credential or external request.';
  const bindings = Object.entries(files).map(([file, bytes]) => {
    fs.writeFileSync(path.join(root, file), bytes, {mode: 0o600});
    return {file, sha256: hash(bytes), mode: 0o600};
  });
  const contract = JSON.stringify({schema: 'helix1.new50-launch.v2', bindings});
  fs.writeFileSync(path.join(root, 'controller/launch-contract.json'), contract);
  return {root, approved: hash(contract)};
}
function run(root, approved) {
  const child = spawn(process.execPath, [entry, root, approved], {stdio: ['ignore', 'pipe', 'pipe']});
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; }); child.stdout.resume();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill('SIGTERM'), 10000);
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); resolve({code, stderr}); });
  });
}

test('concurrent launchers start only one synthetic no-provider runner', async t => {
  const f = fixture(t);
  const results = await Promise.all([run(f.root, f.approved), run(f.root, f.approved)]);
  assert.equal(results.filter(result => result.code === 0).length, 1);
  assert.equal(results.filter(result => result.stderr.includes('EEXIST')).length, 1);
  assert.equal(fs.readFileSync(path.join(f.root, 'started.txt'), 'utf8'), 'one synthetic start\n');
  const owner = JSON.parse(fs.readFileSync(path.join(f.root, 'controller/monitor-owner.json')));
  assert.equal(owner.contract_sha256, f.approved); assert.equal(owner.exit.code, 0);
  assert.equal(fs.statSync(path.join(f.root, 'controller/controller-console.log')).mode & 0o077, 0);
});

test('an approved empty contract cannot authorize an unbound runner', async t => {
  const f = fixture(t), bytes = '{}';
  fs.writeFileSync(path.join(f.root, 'controller/launch-contract.json'), bytes);
  const result = await run(f.root, hash(bytes));
  assert.notEqual(result.code, 0); assert.match(result.stderr, /Complete reviewed/);
  assert.equal(fs.existsSync(path.join(f.root, 'started.txt')), false);
});

test('changed reviewed runner is rejected before spawning', async t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.root, 'runner.mjs'), '\n// altered\n');
  const result = await run(f.root, f.approved);
  assert.notEqual(result.code, 0); assert.match(result.stderr, /Changed launch input/);
  assert.equal(fs.existsSync(path.join(f.root, 'started.txt')), false);
});

test('log collision fails before spawn and removes only the owned reservation', async t => {
  const f = fixture(t), log = path.join(f.root, 'controller/controller-console.log');
  fs.writeFileSync(log, 'Prior evidence must remain.');
  const result = await run(f.root, f.approved);
  assert.notEqual(result.code, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'started.txt')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'controller/monitor-launch.lock')), false);
  assert.equal(fs.readFileSync(log, 'utf8'), 'Prior evidence must remain.');
});

test('post-spawn owner publication failure stops its child and preserves failure evidence', async t => {
  const f = fixture(t); let pid;
  await assert.rejects(launchBenchmark(f.root, f.approved, {writeOwner(_file, owner) { pid = owner.pid; throw new Error('Synthetic publication failure'); }}), /Synthetic publication failure/);
  assert.ok(pid);
  assert.equal(processStartIdentityProbe(pid).state, 'absent');
  const owner = JSON.parse(fs.readFileSync(path.join(f.root, 'controller/monitor-owner.json')));
  assert.equal(owner.launch_error, 'Synthetic publication failure');
  assert.equal(fs.existsSync(path.join(f.root, 'controller/monitor-launch.lock')), true);
});

test('cancellation is bounded even when a synthetic runner traps the graceful signal', async t => {
  const f = fixture(t, 'import fs from "node:fs"; process.on("SIGTERM",()=>{}); fs.writeFileSync("started.txt","ready"); setInterval(()=>{},1000);');
  const running = launchBenchmark(f.root, f.approved, {stopAfterMs: 100});
  for (let attempt = 0; attempt < 200 && !fs.existsSync(path.join(f.root, 'started.txt')); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fs.readFileSync(path.join(f.root, 'started.txt'), 'utf8'), 'ready');
  process.emit('SIGTERM');
  assert.equal(await running, 1);
  const owner = JSON.parse(fs.readFileSync(path.join(f.root, 'controller/monitor-owner.json')));
  assert.equal(owner.exit.signal, 'SIGKILL');
  assert.equal(processStartIdentityProbe(owner.pid).state, 'absent');
});
