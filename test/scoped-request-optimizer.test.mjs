import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {createArchive, ScopedOperations, digest} from '../src/helix-scoped-operations.mjs';
import {RequestOptimizer} from '../src/request-optimizer.mjs';
import {createService} from '../src/service.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-scoped-'));
  const cleanup = [];
  t.after(async () => {
    try { for (const close of cleanup.reverse()) await close(); }
    finally { fs.rmSync(directory, {recursive: true, force: true}); }
  });
  const tools = [{type: 'custom', name: 'exec'}];
  const binding = {scope: 'synthetic-task-1', epoch: 'synthetic-epoch', revision: 1,
    source_sha256: digest('synthetic source'), tools_sha256: digest(tools)};
  const currentBinding = {...binding, scope: 'synthetic-task-2'};
  const call = {type: 'custom_tool_call', name: 'exec', id: 'synthetic-item', call_id: 'synthetic-call', input: 'synthetic original program'};
  const result = {type: 'custom_tool_call_output', call_id: call.call_id, output: 'synthetic complete evidence\n'.repeat(100)};
  const payload = {model: 'gpt-6.1-sol', tools, reasoning: {effort: 'high'}, text: {verbosity: 'medium'},
    instructions: 'Preserve all current requirements.', input: [call, result,
      {type: 'reasoning', encrypted_content: 'SYNTHETIC_OPAQUE_UNCHANGED'},
      {type: 'message', role: 'assistant', content: 'Normal synthetic answer'}]};
  const scopedOperations = new ScopedOperations({archive: createArchive({directory: path.join(directory, 'archive'), key: randomBytes(32)}), authority: () => true});
  scopedOperations.recordCompletedPair({binding, call, result, outcome: {state: 'passed'}});
  const record = scopedOperations.seal({binding, review: 'Synthetic model review, not benchmark correctness.'});
  return {directory, binding, currentBinding, payload, scopedOperations, record, cleanup};
}

test('scoped optimization is explicit and pair-atomic, with normal settings untouched', t => {
  const f = fixture(t);
  assert.throws(() => new RequestOptimizer(f.directory, {scopedOperations: f.scopedOperations}), /current controller context required/);
  const optimizer = new RequestOptimizer(f.directory, {scopedOperations: f.scopedOperations,
    scopeContext: args => { assert.deepEqual(args, {session: 'synthetic-session', model: f.payload.model}); return {currentBinding: f.currentBinding}; }});
  const shaped = optimizer.shape(f.payload, {session: 'synthetic-session'});
  assert.equal(shaped.stats.mode, 'scoped'); assert.equal(shaped.stats.retiredPairs, 1);
  assert.ok(shaped.stats.bytesRemoved > 0);
  assert.equal(shaped.payload.input[0].type, 'message');
  assert.deepEqual(shaped.payload.input.slice(1), f.payload.input.slice(2));
  const {input, ...settings} = shaped.payload, {input: original, ...expectedSettings} = f.payload;
  assert.deepEqual(settings, expectedSettings); assert.equal(f.payload.input[0], original[0]);
  assert.deepEqual(f.scopedOperations.recover({id: f.record.id, currentBinding: f.currentBinding}).rows[0].pair,
    {call: original[0], result: original[1]});
});

test('unbound, stale, dependent and cancelled scopes keep the entire original without legacy aging', t => {
  const f = fixture(t);
  for (const context of [null, {currentBinding: f.binding},
    {currentBinding: {...f.currentBinding, tools_sha256: digest('changed')}},
    {currentBinding: f.currentBinding, requiredCallIds: ['synthetic-call']}]) {
    const optimizer = new RequestOptimizer(f.directory, {scopedOperations: f.scopedOperations, scopeContext: () => context});
    assert.equal(optimizer.shape(f.payload, {session: 'synthetic-session'}).payload, f.payload);
  }
  const optimizer = new RequestOptimizer(f.directory, {scopedOperations: f.scopedOperations,
    scopeContext: () => ({currentBinding: f.currentBinding})});
  assert.equal(optimizer.shape(f.payload, {session: 'synthetic-session', signal: AbortSignal.abort()}).payload, f.payload);
});

test('missing sessions, other providers and native no-tools requests never consult scope authority', t => {
  const f = fixture(t);
  const optimizer = new RequestOptimizer(f.directory, {scopedOperations: f.scopedOperations,
    scopeContext: () => assert.fail('must not consult authority')});
  for (const payload of [{...f.payload, tools: []}, {...f.payload, tools: undefined}, {...f.payload, model: 'other-model'}]) {
    assert.equal(optimizer.shape(payload, {session: 'synthetic-session'}).payload, payload);
  }
  assert.equal(optimizer.shape(f.payload).payload, f.payload);
  assert.equal(optimizer.shape(f.payload, {session: 'synthetic-session', provider: 'other'}).payload, f.payload);
});

test('server-owned history and asynchronous or failed scope lookup remain exact passthroughs', t => {
  const f = fixture(t);
  for (const scopeContext of [async () => ({currentBinding: f.currentBinding}), () => { throw new Error('stale controller'); }]) {
    const optimizer = new RequestOptimizer(f.directory, {scopedOperations: f.scopedOperations, scopeContext});
    assert.equal(optimizer.shape(f.payload, {session: 'synthetic-session'}).payload, f.payload);
  }
  const optimizer = new RequestOptimizer(f.directory, {scopedOperations: f.scopedOperations,
    scopeContext: () => assert.fail('server-owned history cannot be retired locally')});
  for (const extra of [{previous_response_id: 'synthetic-response'}, {conversation: 'synthetic-conversation'}]) {
    const payload = {...f.payload, ...extra};
    const shaped = optimizer.shape(payload, {session: 'synthetic-session'});
    assert.equal(shaped.payload, payload); assert.equal(shaped.stats.code, 'server_owned_history');
  }
});

test('service opt-in reaches the proxy with no live model calls, no extra request and no answer rewriting', async t => {
  const f = fixture(t), calls = [];
  const sse = 'data: ' + JSON.stringify({type: 'response.completed', response: {usage: {input_tokens: 123, output_tokens: 7}}}) + '\n\n';
  const service = await createService({directory: path.join(f.directory, 'service'), upstream: 'https://api.openai.com/v1',
    optimizerOptions: {scopedOperations: f.scopedOperations, scopeContext: () => ({currentBinding: f.currentBinding})},
    fetchImpl: async (url, init) => { calls.push({url, body: JSON.parse(init.body)}); return new Response(sse, {headers: {'content-type': 'text/event-stream'}}); }});
  f.cleanup.push(() => service.close());
  const headers = {'content-type': 'application/json', authorization: 'Bearer SYNTHETIC_TEST_ONLY',
    'x-helix-key': service.endpoint.token, session_id: 'synthetic-session'};
  const response = await fetch(service.endpoint.url + '/v1/responses', {method: 'POST', headers, body: JSON.stringify(f.payload)});
  assert.equal(await response.text(), sse); assert.equal(calls.length, 1);
  assert.equal(calls[0].body.input[0].type, 'message'); assert.deepEqual(calls[0].body.reasoning, f.payload.reasoning);
  assert.deepEqual(calls[0].body.text, f.payload.text);
  const event = service.snapshot().events.find(row => row.kind === 'openai');
  assert.equal(event.archived_pairs, 1); assert.equal(event.history_policy, 'scoped');
  assert.equal(event.estimated_token_savings, null);
  const control = {...f.payload, tools: []};
  const compact = await fetch(service.endpoint.url + '/v1/responses/compact', {method: 'POST', headers, body: JSON.stringify(control)});
  assert.equal(await compact.text(), sse); assert.equal(calls.length, 2); assert.deepEqual(calls[1].body, control);
});
