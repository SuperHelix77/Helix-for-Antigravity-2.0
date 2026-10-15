import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {GoalEngine} from '../src/helix-goal-engine.mjs';
import {verificationCommand, qualifyTestExit} from '../src/verification.mjs';
import {compileNativeOperation} from '../src/helix-native-function-bridge.mjs';

test('verification rejects masked shell exits before dispatch; argv is literal', () => {
  for (const cmd of ['pytest; true', 'false || true', 'pytest | tail', 'echo $(false)', 'true\nfalse']) assert.throws(() => verificationCommand({cmd}), /Compound/);
  const arg = "literal; $(echo BAD) ' " + '\u00e7';
  const declared = verificationCommand({argv: [process.execPath, '-e', 'process.stdout.write(process.argv[1])', arg]});
  const executed = spawnSync('/bin/sh', ['-c', declared.cmd], {encoding: 'utf8'});
  assert.equal(executed.status, 0); assert.equal(executed.stdout, arg);
  assert.throws(() => verificationCommand({cmd: 'true', argv: ['false']}));
});
test('masked pytest failures and zero selections become verification boundaries with exact originals', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-verifier-'));
  const engine = new GoalEngine({directory});
  t.after(() => { engine.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  const output = '==== 3 failed, 15 passed in 2.0s ====\n';
  const result = qualifyTestExit(engine, {stdout: output, stderr: '', exit_code: 0});
  assert.equal(result.exit_code, 0); assert.equal(result.verification_exit_code, 78);
  const packet = engine.objectJSON(result.verification_receipt);
  assert.equal(engine.read(packet.stdout.raw).content, output);
  assert.equal(qualifyTestExit(engine, {stdout: 'no tests ran in 0.2s\n', stderr: '', exit_code: 0}).verification_exit_code, 78);
  assert.equal(qualifyTestExit(engine, {stdout: '==== 15 passed in 2.0s ====\n', stderr: '', exit_code: 0}).verification_exit_code, undefined);
  assert.equal(result.semantic_success, null);
});
test('typed checkpoint never dispatches a compound verifier or echoes injected scope', () => {
  const binding = {task: '01', state: 'active', kind: 'model', busy: false, revision: 1, step: 'fix-01', scope: {project: '/public', session: 'current', goal: 'active'}};
  const code = compileNativeOperation({op: 'checkpoint', revision: 1, step: 'fix-01', review: 'Conditional review.', request_id: 'one', verify: {cmd: 'pytest; true'}}, {task: '01', checkpointBinding: () => binding});
  assert.ok(code.includes('checkpoint_not_executed')); assert.ok(!code.includes('tools.exec_command'));
});
