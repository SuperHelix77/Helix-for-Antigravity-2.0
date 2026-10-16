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

test('HelixLeanSwitch disabled mode preserves exact input without archiving', t => {
  const { directory } = fixture(t);
  const lean = new HelixLeanSwitch({ directory, enabled: false });

  const output = 'some long text '.repeat(100);
  const result = lean.shapeCommandOutput(output, { command: 'test', exitCode: 0 });

  assert.equal(result.output, output);
  assert.equal(result.receipt, null);
  assert.equal(result.savedBytes, 0);
});
