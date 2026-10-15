import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createOpenAIProxy} from '../src/openai-proxy.mjs';

class Client extends EventEmitter {
  writableEnded = false;
  chunks = [];
  writeHead() {}
  write(chunk) { this.chunks.push(Buffer.from(chunk)); return true; }
  end() { this.writableEnded = true; }
}
function fixture(t, upstream, fetchImpl) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-proxy-controls-'));
  const counters = {model_calls: 0, known_input: 0, known_output: 0, unknown_usage: 0}, events = [];
  const proxy = createOpenAIProxy({directory, upstream, fetchImpl, counters, event: value => events.push(value)});
  t.after(() => { proxy.abort(); fs.rmSync(directory, {recursive: true, force: true}); });
  return {proxy, counters, events};
}
const request = (extra = {}) => ({url: '/v1/responses', headers: {authorization: 'Bearer SYNTHETIC_ONLY', ...extra}});
const payload = {model: 'gpt-test', input: [], max_tool_calls: 1, parallel_tool_calls: true, reasoning: {effort: 'high'}};
const completed = () => new Response(JSON.stringify({status: 'completed', usage: {input_tokens: 4, output_tokens: 2}}));

test('ordinary API preserves explicit controls while native Codex and Lite keep required compatibility', async t => {
  for (const [upstream, lite, cap] of [['https://api.openai.com/v1', false, 1],
    ['https://chatgpt.com/backend-api/codex', false, undefined], ['https://api.openai.com/v1', true, undefined]]) {
    let sent, count = 0;
    const {proxy} = fixture(t, upstream, async (_url, init) => { sent = JSON.parse(init.body); count++; return completed(); });
    await proxy.forward(request(lite ? {'x-openai-internal-codex-responses-lite': '1'} : {}), new Client(), payload);
    assert.equal(sent.max_tool_calls, cap);
    assert.equal(sent.parallel_tool_calls, !lite);
    assert.deepEqual(sent.reasoning, payload.reasoning);
    assert.equal(count, 1);
  }
});
test('abort cancels a backpressured stream without another model request or leaked drain listener', async t => {
  let written;
  const blocked = new Promise(resolve => { written = resolve; });
  const client = new Client();
  client.write = chunk => { client.chunks.push(Buffer.from(chunk)); written(); return false; };
  const {proxy, counters} = fixture(t, 'https://api.openai.com/v1', async () => completed());
  const forwarding = proxy.forward(request(), client, payload);
  await blocked;
  proxy.abort();
  await assert.rejects(forwarding, /disconnected/);
  assert.equal(counters.model_calls, 1);
  assert.equal(counters.unknown_usage, 1);
  assert.equal(client.listenerCount('drain'), 0);
  assert.equal(client.listenerCount('close'), 0);
  assert.equal(client.writableEnded, false);
});
test('backpressure resumes exact bytes once; client disconnect aborts upstream without retry', async t => {
  let blocked;
  const waiting = new Promise(resolve => { blocked = resolve; });
  const client = new Client();
  client.write = chunk => { client.chunks.push(Buffer.from(chunk)); blocked(); return false; };
  const {proxy, counters} = fixture(t, 'https://api.openai.com/v1', async () => completed());
  const forwarding = proxy.forward(request(), client, payload);
  await waiting;
  client.emit('drain');
  await forwarding;
  assert.equal(JSON.parse(Buffer.concat(client.chunks)).status, 'completed');
  assert.equal(client.writableEnded, true);
  assert.equal(counters.known_input, 4);
  let started, signal;
  const ready = new Promise(resolve => { started = resolve; });
  const second = fixture(t, 'https://api.openai.com/v1', async (_url, init) => {
    signal = init.signal; started();
    return await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('upstream cancelled')), {once: true}));
  });
  const disconnected = new Client(), pending = second.proxy.forward(request(), disconnected, payload);
  await ready; disconnected.emit('close');
  await assert.rejects(pending, /cancelled/);
  assert.equal(signal.aborted, true);
  assert.equal(second.counters.model_calls, 1);
  assert.equal(disconnected.listenerCount('close'), 0);
});
