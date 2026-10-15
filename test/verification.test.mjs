import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {GoalEngine} from '../src/helix-goal-engine.mjs';
import {verificationCommand, verificationBoundary, qualifyTestExit} from '../src/verification.mjs';
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
test('verification guard scans complete observations and distinguishes known failure from acceptance', () => {
  const success = {exit_code: 0, stdout: '# tests 2\n# pass 2\n# fail 0\n', stderr: ''};
  assert.equal(verificationBoundary(success), null);
  for (const output of ['# tests 2\n# fail 1\n', 'not ok 2 - regression\n', 'FAILED (failures=1)\n',
    '=== 1 failed, 20 passed in 0.2s ===\n', 'collected 0 items\n', '# tests 0\n',
    'passed 1\n'.repeat(100) + '# fail 1\n', JSON.stringify({schema: 'helix.tests.v1', complete: true, tests: [{status: 'fail'}]}),
    JSON.stringify({schema: 'helix.tests.v1', complete: false, tests: [{status: 'pass'}]}),
    JSON.stringify({schema: 'helix.tests.v1', complete: true, tests: [{status: 'skip'}]})])
    assert.ok(verificationBoundary({exit_code: 0, output}), output);
  for (const change of [{exit_code: 1}, {truncated: true}, {tooLarge: true}, {output_truncated: true}, {signal: 'SIGTERM'}, {boundary: 'unknown'}])
    assert.ok(verificationBoundary({...success, ...change}));
  assert.ok(verificationBoundary({exit_code: 0}));
  // The native template must work without module imports or Node globals.
  const portable = new Function('return (' + verificationBoundary.toString() + ')')();
  assert.equal(portable(success), null);
  assert.ok(portable({exit_code: 0, output: '# fail 1\n'}));
});
