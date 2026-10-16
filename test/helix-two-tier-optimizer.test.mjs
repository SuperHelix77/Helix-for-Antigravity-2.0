import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createArchive, ScopedOperations, digest } from '../src/helix-scoped-operations.mjs';
import { RequestOptimizer } from '../src/request-optimizer.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-two-tier-test-'));
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const tools = [{ type: 'custom', name: 'exec' }];
  const binding1 = {
    scope: 'task-1-django-15061',
    epoch: 'epoch-1',
    revision: 1,
    source_sha256: digest('source-1'),
    tools_sha256: digest(tools)
  };
  const binding2 = {
    scope: 'task-2-django-13220',
    epoch: 'epoch-1',
    revision: 2,
    source_sha256: digest('source-2'),
    tools_sha256: digest(tools)
  };

  const archive = createArchive({ directory: path.join(directory, 'archive'), key: randomBytes(32) });
  const scopedOperations = new ScopedOperations({ archive, authority: () => true });

  return { directory, tools, binding1, binding2, scopedOperations, archive };
}

test('Two-Tier Optimizer combines Scoped Retirement with Active Intra-Task Aging', t => {
  const f = fixture(t);

  // Sealed Task 1 items
  const call1 = { type: 'custom_tool_call', name: 'exec', id: 'call-1', call_id: 'call-1', input: 'python tests.py' };
  const result1 = { type: 'custom_tool_call_output', call_id: 'call-1', output: 'Task 1 results\n'.repeat(50) };

  f.scopedOperations.recordCompletedPair({
    binding: f.binding1,
    call: call1,
    result: result1,
    outcome: { state: 'passed' }
  });
  const record1 = f.scopedOperations.seal({
    binding: f.binding1,
    review: 'Task 1 passed cleanly'
  });

  // Active Task 2 items: includes an older large tool result within Task 2 + a frontier call
  const task2OldCall = { type: 'custom_tool_call', name: 'exec', id: 'call-2a', call_id: 'call-2a', input: 'git diff HEAD~1' };
  const task2OldResult = { type: 'custom_tool_call_output', call_id: 'call-2a', output: 'massive diff content\n'.repeat(100) };
  const task2NewCall = { type: 'custom_tool_call', name: 'exec', id: 'call-2b', call_id: 'call-2b', input: 'pytest tests/test_core.py' };
  const task2NewResult = { type: 'custom_tool_call_output', call_id: 'call-2b', output: 'active frontier output' };

  const payload = {
    model: 'gemini-3.8-flash-high',
    tools: f.tools,
    input: [
      call1, result1,
      task2OldCall, task2OldResult,
      task2NewCall, task2NewResult
    ]
  };

  const optimizer = new RequestOptimizer(f.directory, {
    scopedOperations: f.scopedOperations,
    scopeContext: () => ({ currentBinding: f.binding2 }),
    twoTier: true,
    cacheStable: { minSavedBytes: 256, minResults: 1 }
  });

  const shaped = optimizer.shape(payload, { session: 'two-tier-session' });

  assert.equal(shaped.stats.mode, 'two-tier');
  assert.equal(shaped.stats.retiredPairs, 1, 'Task 1 call/result must be retired');
  assert.ok(shaped.stats.intraTaskAged >= 1, 'Task 2 older tool result must be aged');
  assert.ok(shaped.stats.bytesRemoved > 0, 'Bytes must be saved across both tiers');

  // Verify Task 1 is replaced by archive manifest
  assert.equal(shaped.payload.input[0].type, 'message');
  assert.ok(shaped.payload.input[0].content[0].text.includes('Archived tool pairs'));

  // Verify Task 2 older result is aged with a receipt
  const shapedTask2OldResult = shaped.payload.input.find(item => item?.call_id === 'call-2a' && item?.type === 'custom_tool_call_output');
  assert.ok(shapedTask2OldResult, 'Task 2 old result must exist');
  assert.ok(typeof shapedTask2OldResult.output === 'string' && shapedTask2OldResult.output.includes('[aged '), 'Old result must be compacted with receipt');

  // Verify Task 2 frontier result remains unmodified
  const shapedFrontierResult = shaped.payload.input.find(item => item?.call_id === 'call-2b' && item?.type === 'custom_tool_call_output');
  assert.equal(shapedFrontierResult.output, 'active frontier output');
});
