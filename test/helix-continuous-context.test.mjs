import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createArchive, ScopedOperations, digest } from '../src/helix-scoped-operations.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-continuous-test-'));
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

test('Continuous Context Control retires historical task messages into encrypted archive', t => {
  const f = fixture(t);

  // Task 1 execution items
  const userMsg1 = { type: 'message', role: 'user', content: 'Fix issue in django-15061: Formsets fail on empty data' };
  const call1 = { type: 'custom_tool_call', name: 'exec', id: 'call-1', call_id: 'call-1', input: 'python tests.py' };
  const result1 = { type: 'custom_tool_call_output', call_id: 'call-1', output: 'Tests failed: AssertionError' };
  const asstMsg1 = { type: 'message', role: 'assistant', content: 'I found the bug and fixed the widget initialization.' };

  // Task 2 active items
  const userMsg2 = { type: 'message', role: 'user', content: 'Fix issue in django-13220: Serialization error' };
  const call2 = { type: 'custom_tool_call', name: 'exec', id: 'call-2', call_id: 'call-2', input: 'pytest serialization' };
  const result2 = { type: 'custom_tool_call_output', call_id: 'call-2', output: 'Running serialization tests...' };

  // Record and seal Task 1 with associated messages
  f.scopedOperations.recordCompletedPair({
    binding: f.binding1,
    call: call1,
    result: result1,
    outcome: { state: 'passed' }
  });

  const record1 = f.scopedOperations.seal({
    binding: f.binding1,
    review: 'Task 1 verified with unit tests passing.',
    messages: [userMsg1, asstMsg1]
  });

  // Construct request payload containing both Task 1 history and Task 2 active work
  const payload = {
    model: 'gemini-3.8-flash-high',
    tools: f.tools,
    input: [userMsg1, call1, result1, asstMsg1, userMsg2, call2, result2]
  };

  // View under current task (Task 2) WITH continuousContext enabled
  const viewed = f.scopedOperations.view(payload, {
    currentBinding: f.binding2,
    continuousContext: true
  });

  assert.equal(viewed.status, 'retired');
  assert.equal(viewed.retiredPairs, 1);
  assert.equal(viewed.retiredMessages, 2, 'Both userMsg1 and asstMsg1 must be retired');

  // Verify shaped request structure
  const shapedInput = viewed.request.input;
  // Should contain: [Handoff Manifest for Task 1, userMsg2, call2, result2]
  assert.equal(shapedInput.length, 4);
  assert.equal(shapedInput[0].type, 'message');
  assert.equal(shapedInput[0].role, 'developer');
  assert.ok(shapedInput[0].content[0].text.includes('Archived scope handoff'));
  assert.ok(shapedInput[0].content[0].text.includes('task-1-django-15061'));

  // Active Task 2 items must remain 100% identical and active
  assert.deepEqual(shapedInput[1], userMsg2);
  assert.deepEqual(shapedInput[2], call2);
  assert.deepEqual(shapedInput[3], result2);

  // Verify lossless recovery of Task 1 archive
  const recovered = f.scopedOperations.recover({ id: record1.id, currentBinding: f.binding2 });
  assert.equal(recovered.binding.scope, f.binding1.scope);
  assert.equal(recovered.review, 'Task 1 verified with unit tests passing.');
  assert.deepEqual(recovered.messages, [userMsg1, asstMsg1]);
  assert.deepEqual(recovered.rows[0].pair, { call: call1, result: result1 });
});

test('Continuous Context Control without explicit messages detects boundary messages automatically', t => {
  const f = fixture(t);

  const userMsg1 = { type: 'message', role: 'user', content: 'Fix SymPy bug in trigonometry' };
  const call1 = { type: 'custom_tool_call', name: 'exec', id: 'call-1', call_id: 'call-1', input: 'pytest sympy' };
  const result1 = { type: 'custom_tool_call_output', call_id: 'call-1', output: 'SymPy tests pass' };
  const asstMsg1 = { type: 'message', role: 'assistant', content: 'SymPy bug resolved.' };

  const userMsg2 = { type: 'message', role: 'user', content: 'Next task: fix geometry' };
  const call2 = { type: 'custom_tool_call', name: 'exec', id: 'call-2', call_id: 'call-2', input: 'pytest geometry' };
  const result2 = { type: 'custom_tool_call_output', call_id: 'call-2', output: 'Running geometry...' };

  f.scopedOperations.recordCompletedPair({
    binding: f.binding1,
    call: call1,
    result: result1,
    outcome: { state: 'passed' }
  });

  // Seal without explicit messages array
  const record1 = f.scopedOperations.seal({
    binding: f.binding1,
    review: 'Trig fix verified'
  });

  const payload = {
    model: 'gemini-3.8-flash-high',
    tools: f.tools,
    input: [userMsg1, call1, result1, asstMsg1, userMsg2, call2, result2]
  };

  const viewed = f.scopedOperations.view(payload, {
    currentBinding: f.binding2,
    continuousContext: true
  });

  assert.equal(viewed.status, 'retired');
  assert.equal(viewed.retiredPairs, 1);
  assert.equal(viewed.retiredMessages, 2);

  // Active items preserved
  assert.equal(viewed.request.input.length, 4);
  assert.deepEqual(viewed.request.input[1], userMsg2);
});
