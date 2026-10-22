import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Helix2ElasticFrontier } from '../src/helix2-elastic-frontier.mjs';

test('Helix2ElasticFrontier applies maximum compression on exit 0', t => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix2-frontier-'));
  t.after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  const frontier = new Helix2ElasticFrontier({ directory: tmpDir });
  const rawLog = 'Running tests...\ntest_one PASSED\ntest_two PASSED\n' + 'test_bulk PASSED\n'.repeat(40) + '=== 42 passed in 1.2s ===';
  
  const res = frontier.shapeDiagnosticOutput(rawLog, {
    command: 'pytest tests/',
    exitCode: 0,
    taskId: 'task-1'
  });

  assert.equal(res.level, 0);
  assert.ok(res.savedBytes > 0);
  assert.ok(res.output.includes('exit:0'));
  assert.ok(res.output.includes('42 passed'));
});

test('Helix2ElasticFrontier escalates diagnostic resolution on repeat failures', t => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix2-frontier-'));
  t.after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  const frontier = new Helix2ElasticFrontier({ directory: tmpDir });
  const failureLog = [
    'Traceback (most recent call last):',
    '  File "django/forms/boundfield.py", line 42, in subwidgets',
    '    id_ = self.field.widget.attrs.get("id") or self.auto_id',
    '  File "django/forms/widgets.py", line 105, in id_for_label',
    '    return f"{id_}_0"',
    'AssertionError: Expected id_0 but got empty string',
    'FAILED (failures=1)'
  ].join('\n');

  // First failure -> Resolution Level 1
  const res1 = frontier.shapeDiagnosticOutput(failureLog, {
    command: 'pytest tests/test_widgets.py',
    exitCode: 1,
    taskId: 'task-14534'
  });
  assert.equal(res1.level, 1);
  assert.ok(res1.output.includes('resolution:L1'));
  assert.ok(res1.output.includes('AssertionError'));

  // Repeat failure -> Escalation to Level 2
  const res2 = frontier.shapeDiagnosticOutput(failureLog, {
    command: 'pytest tests/test_widgets.py',
    exitCode: 1,
    taskId: 'task-14534'
  });
  assert.equal(res2.level, 2);
  assert.ok(res2.output.includes('resolution:L2'));
  assert.ok(res2.output.includes('CRITICAL: Repeat test failure detected'));
});
