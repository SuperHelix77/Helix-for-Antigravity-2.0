import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Helix2SpeculativeWorker } from '../src/helix2-speculative-worker.mjs';

test('Helix2SpeculativeWorker Reassurance Guard blocks redundant verified runs on clean commit', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix2-spec-work-'));
  const cacheDir = path.join(tmpDir, 'cache');
  fs.mkdirSync(cacheDir, { mode: 0o700 });

  execFileSync('git', ['init'], { cwd: tmpDir });
  execFileSync('git', ['config', 'user.name', 'Helix'], { cwd: tmpDir });
  execFileSync('git', ['config', 'user.email', 'helix@example.com'], { cwd: tmpDir });

  const dummy = path.join(tmpDir, 'dummy.txt');
  fs.writeFileSync(dummy, 'hello\n', 'utf8');
  execFileSync('git', ['add', '.'], { cwd: tmpDir });
  execFileSync('git', ['commit', '-m', 'clean'], { cwd: tmpDir });

  const worker = new Helix2SpeculativeWorker({ cacheDir });

  // Initially: not verified, so not blocked
  const check1 = worker.checkReassuranceGuard('npm test', tmpDir);
  assert.equal(check1.block, false);

  // Record verified pass
  worker.recordVerifiedPass('npm test', tmpDir, 0);

  // Now: should block redundant reassurance run
  const check2 = worker.checkReassuranceGuard('npm test', tmpDir);
  assert.equal(check2.block, true);
  assert.ok(check2.receipt.includes('already verified exit:0'));

  // If a file is modified (dirty tree): should NOT block!
  fs.writeFileSync(dummy, 'dirty modification\n', 'utf8');
  const check3 = worker.checkReassuranceGuard('npm test', tmpDir);
  assert.equal(check3.block, false);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Helix2SpeculativeWorker launches speculative pre-flight on test intent', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix2-spec-pre-'));
  const cacheDir = path.join(tmpDir, 'cache');
  fs.mkdirSync(cacheDir, { mode: 0o700 });

  fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}', 'utf8');

  const worker = new Helix2SpeculativeWorker({ cacheDir });
  const launch = worker.launchSpeculativePreFlight({
    workspaceDir: tmpDir,
    userPrompt: 'Does it work properly?'
  });

  assert.ok(launch);
  assert.equal(launch.launched, true);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
