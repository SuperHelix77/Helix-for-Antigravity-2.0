import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HelixLeanSwitch, LEAN_SWITCH_RECEIPT_PREFIX } from '../src/helix-lean-switch.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-lean-test-'));
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory };
}

test('HelixLeanSwitch compacts large successful test output with exact recovery', t => {
  const { directory } = fixture(t);
  const lean = new HelixLeanSwitch({ directory });

  const rawTestOutput = [
    'running pytest tests/test_core.py',
    '..'.repeat(200),
    '============================= test session starts ==============================',
    'platform darwin -- Python 3.11.8, pytest-7.4.0, pluggy-1.2.0',
    'rootdir: /tmp/test-project',
    'collected 45 items',
    '',
    'tests/test_core.py ............................................. [100%]',
    '',
    '============================== 45 passed in 1.23s =============================='
  ].join('\n');

  const result = lean.shapeCommandOutput(rawTestOutput, {
    command: 'pytest tests/test_core.py',
    exitCode: 0,
    toolName: 'run_command'
  });

  assert.ok(result.receipt, 'Receipt handle must be generated');
  assert.ok(result.savedBytes > 0, 'Saved bytes must be positive');
  assert.ok(result.output.startsWith(LEAN_SWITCH_RECEIPT_PREFIX), 'Output should be a compact receipt');
  assert.ok(result.output.includes('45 passed in 1.23s'), 'Summary line must be preserved in receipt');

  // Verify 100% exact lossless recovery
  const recovered = lean.recover(result.receipt);
  assert.equal(recovered, rawTestOutput, 'Recovered output must match byte-for-byte');
});

test('HelixLeanSwitch preserves error tracebacks when test fails', t => {
  const { directory } = fixture(t);
  const lean = new HelixLeanSwitch({ directory });

  const failingTestOutput = [
    '============================= test session starts ==============================',
    'collected 3 items',
    '',
    'tests/test_foo.py .F.',
    '',
    '=================================== FAILURES ===================================',
    '________________________________ test_failure _________________________________',
    'Traceback (most recent call last):',
    '  File "/tmp/test_foo.py", line 12, in test_failure',
    '    assert result == expected',
    'AssertionError: Expected 42, got 0',
    '=========================== 1 failed, 2 passed in 0.45s =========================='
  ].join('\n');

  const result = lean.shapeCommandOutput(failingTestOutput, {
    command: 'pytest tests/test_foo.py',
    exitCode: 1,
    toolName: 'run_command'
  });

  assert.ok(result.receipt);
  assert.ok(result.output.includes('AssertionError: Expected 42, got 0'), 'Root failure must be preserved');
  assert.ok(result.output.includes('1 failed, 2 passed in 0.45s'), 'Status count must be preserved');

  const recovered = lean.recover(result.receipt);
  assert.equal(recovered, failingTestOutput);
});

test('HelixLeanSwitch passes small outputs through without overhead', t => {
  const { directory } = fixture(t);
  const lean = new HelixLeanSwitch({ directory, minSavedBytes: 256 });

  const shortOutput = 'OK\n';
  const result = lean.shapeCommandOutput(shortOutput, { command: 'echo OK', exitCode: 0 });

  assert.equal(result.output, shortOutput);
  assert.equal(result.receipt, null);
  assert.equal(result.savedBytes, 0);
});

test('HelixLeanSwitch compacts large file content with exact recovery', t => {
  const { directory } = fixture(t);
  const lean = new HelixLeanSwitch({ directory });

  const largeCode = Array.from({ length: 200 }, (_, i) => `def function_${i}():\n    return ${i}`).join('\n');

  const result = lean.shapeFileContent('/app/large_module.py', largeCode);

  assert.ok(result.receipt);
  assert.ok(result.savedBytes > 0);
  assert.ok(result.content.includes('lines:400'), 'Total line count must be reported');
  assert.ok(result.content.includes('omitted by Lean Switch'), 'Middle should be compacted');

  const recovered = lean.recover(result.receipt);
  assert.equal(recovered, largeCode, 'Original code must recover byte-for-byte');
});

test('HelixLeanSwitch prunes external framework plumbing frames from failure tracebacks', t => {
  const { directory } = fixture(t);
  const lean = new HelixLeanSwitch({ directory });

  const tracebackWithPlumbing = [
    '============================= test session starts ==============================',
    'platform darwin -- Python 3.11.8',
    ...Array.from({ length: 50 }, (_, i) => `running test item ${i}... passed`),
    '=================================== FAILURES ===================================',
    'Traceback (most recent call last):',
    '  File "/usr/local/lib/python3.11/site-packages/django/core/handlers/exception.py", line 55, in inner',
    '    response = get_response(request)',
    '  File "/usr/local/lib/python3.11/site-packages/django/core/handlers/base.py", line 197, in _get_response',
    '    response = wrapped_callback(request, *callback_args, **callback_kwargs)',
    '  File "/workspace/my_app/views.py", line 42, in user_profile_view',
    '    user = get_user_object(pk)',
    '  File "/workspace/my_app/models.py", line 18, in get_user_object',
    '    assert user.is_active is True',
    'AssertionError: Expected active user',
    '=========================== 1 failed in 0.23s =========================='
  ].join('\n');

  const result = lean.shapeCommandOutput(tracebackWithPlumbing, {
    command: 'pytest',
    exitCode: 1,
    toolName: 'run_command'
  });

  // Verify external site-packages frames are stripped
  assert.ok(!result.output.includes('django/core/handlers/exception.py'), 'site-packages frames must be pruned');
  assert.ok(!result.output.includes('django/core/handlers/base.py'), 'base.py plumbing frame must be pruned');

  // Verify user repo frames are retained
  assert.ok(result.output.includes('my_app/views.py'), 'User repo source frame must be preserved');
  assert.ok(result.output.includes('my_app/models.py'), 'User repo model frame must be preserved');
  assert.ok(result.output.includes('AssertionError: Expected active user'), 'Exception must be preserved');
});

test('HelixLeanSwitch compacts large git diff and git status output', t => {
  const { directory } = fixture(t);
  const lean = new HelixLeanSwitch({ directory });

  // Large multi-file git diff
  const largeDiff = [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,5 +1,5 @@',
    '+ const a = 1;',
    'diff --git a/src/b.js b/src/b.js',
    '--- a/src/b.js',
    '+++ b/src/b.js',
    '@@ -10,5 +10,5 @@',
    '+ const b = 2;',
    ...Array.from({ length: 60 }, (_, i) => `+ extra line ${i} in diff`)
  ].join('\n');

  const resDiff = lean.shapeCommandOutput(largeDiff, {
    command: 'git diff',
    exitCode: 0,
    toolName: 'run_command'
  });

  assert.ok(resDiff.receipt);
  assert.ok(resDiff.output.includes('Modified 2 file(s)'));
  assert.ok(resDiff.output.includes('Diff truncated for context safety'));

  // Git status
  const gitStatusOutput = [
    'On branch main',
    'Changes not staged for commit:',
    ...Array.from({ length: 30 }, (_, i) => `\tmodified:   src/file_${i}.js`),
    'Untracked files:',
    ...Array.from({ length: 20 }, (_, i) => `\tsrc/new_${i}.js`)
  ].join('\n');

  const resStatus = lean.shapeCommandOutput(gitStatusOutput, {
    command: 'git status',
    exitCode: 0,
    toolName: 'run_command'
  });

  assert.ok(resStatus.receipt);
  assert.ok(resStatus.output.includes('Modified/Untracked:'));
});

test('HelixLeanSwitch disabled mode preserves exact input without archiving', t => {
  const { directory } = fixture(t);
  const lean = new HelixLeanSwitch({ directory, enabled: false });

  const output = 'some long text '.repeat(100);
  const result = lean.shapeCommandOutput(output, { command: 'test', exitCode: 0 });

  assert.equal(result.output, output);
  assert.equal(result.receipt, null);
  assert.equal(result.savedBytes, 0);
});
