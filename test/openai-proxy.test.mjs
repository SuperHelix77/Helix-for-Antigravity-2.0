import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createService} from '../src/service.mjs';
import {officialUpstream} from '../src/openai-proxy.mjs';
import {RequestOptimizer} from '../src/request-optimizer.mjs';
import {readToolCallOriginal} from '../src/tool-call-retention.mjs';

function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-proxy-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true})); return dir; }
test('only explicit official HTTPS bases; no redirects, credentials, aliases or free-model routing', () => {
  assert.equal(officialUpstream('https://api.openai.com/v1/'), 'https://api.openai.com/v1');
  for (const url of ['http://api.openai.com/v1', 'https://api.openai.com.evil.invalid/v1', 'https://user:pass@api.openai.com/v1', 'https://chatgpt.com/private', 'https://api.openai.com/v1?key=BAD']) assert.throws(() => officialUpstream(url));
});
test('aging archives exact originals, maintains the active frontier and has no effect on effort or prose', t => {
  const directory = fixture(t), optimizer = new RequestOptimizer(directory);
  const input = [];
  for (let n = 0; n < 12; n++) {
    input.push({type: 'function_call', name: 'exec_command', call_id: `c${n}`, arguments: '{"cmd":"test"}'});
    input.push({type: 'function_call_output', call_id: `c${n}`, output: `Test operation ${n}\n` + 'passed all local checks\r\n'.repeat(1200)});
    input.push({type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'Reviewed this result.'}]});
  }
  const original = {model: 'gpt-6.1-sol', reasoning: {effort: 'high'}, text: {verbosity: 'medium'}, input,
    tools: [{name: 'exec', type: 'custom'}], instructions: 'Original literal instructions'};
  const result = optimizer.shape(original, {session: 'current'});
  assert.deepEqual(result.payload.reasoning, original.reasoning); assert.deepEqual(result.payload.text, original.text);
  assert.equal(result.payload.instructions, original.instructions); assert.deepEqual(result.payload.tools, original.tools);
  assert.deepEqual(result.payload.input.at(-2), original.input.at(-2));
  const shaped = result.payload.input.find(row => row.output?.includes('context raw receipt'));
  assert.ok(shaped, 'At least one old result must actually age');
  const handle = shaped.output.match(/context raw receipt ([A-Za-z0-9_-]{43})/)[1];
  const raw = readToolCallOriginal(handle, {directory: path.join(directory, 'programs'), limit: 24000});
  const expected = original.input.find(row => row.call_id === shaped.call_id && row.type === 'function_call_output').output;
  assert.equal(raw.content, expected.slice(0, raw.bytes));
  const second = new RequestOptimizer(directory);
  assert.equal(second.recover(handle), expected);
  assert.equal(optimizer.shape(original, {session: 'current', provider: 'openrouter'}).payload, original);
  assert.equal(optimizer.shape({...original, model: 'space-bunny'}, {session: 'current'}).stats.enabled, false);
  assert.equal(optimizer.shape(original).payload, original);
  for (const tools of [undefined, []]) {
    const nativeControl = {...original, tools};
    assert.equal(optimizer.shape(nativeControl, {session: 'current'}).payload, nativeControl, 'Native no-tools context is not transformed');
  }
  const broken = new RequestOptimizer(directory, {retain: () => {throw new Error('disk full');}});
  assert.deepEqual(broken.shape(original, {session: 'new'}).payload.input, input);
});
test('proxy forwards streams once, preserves native defaults, uses no credential discovery and reports real usage', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-proxy-')), calls = [];
  const sse = 'event: response.completed\ndata: ' + JSON.stringify({type: 'response.completed', response: {usage: {input_tokens: 123, output_tokens: 7}}}) + '\n\n';
  const service = await createService({directory, upstream: 'https://api.openai.com/v1', fetchImpl: async (url, init) => {
    calls.push({url, init}); return new Response(sse, {status: 200, headers: {'content-type': 'text/event-stream'}});
  }}); t.after(async () => { await service.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  const headers = {'x-helix-key': service.endpoint.token, authorization: 'Bearer SYNTHETIC_TEST_ONLY', 'content-type': 'application/json', session_id: 'explicit-scope', 'x-openai-internal-codex-responses-lite': '1'};
  const payload = {model: 'gpt-6.1-sol', input: [], reasoning: {effort: 'high'}, text: {verbosity: 'medium'}, parallel_tool_calls: true, max_tool_calls: 1000};
  const response = await fetch(service.endpoint.url + '/v1/responses', {method: 'POST', headers, body: JSON.stringify(payload)});
  assert.equal(await response.text(), sse); assert.equal(calls.length, 1);
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.max_tool_calls, undefined); assert.equal(sent.parallel_tool_calls, false);
  assert.deepEqual(sent.reasoning, payload.reasoning); assert.deepEqual(sent.text, payload.text);
  assert.equal(calls[0].init.headers['x-helix-key'], undefined); assert.equal(calls[0].init.redirect, 'error');
  assert.equal(service.snapshot().counters.known_input, 123); assert.equal(service.snapshot().counters.known_output, 7);
  assert.ok(!JSON.stringify(service.snapshot()).includes('SYNTHETIC_TEST_ONLY'));
  const disabled = await fetch(service.endpoint.url + '/v1/responses', {method: 'POST', headers, body: JSON.stringify({...payload, model: 'space-bunny'})});
  assert.equal(disabled.status, 400); assert.equal(calls.length, 1);
});
