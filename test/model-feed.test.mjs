import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createService} from '../src/service.mjs';
import {watchModel} from '../src/connection.mjs';
import {ModelState} from '../src/model-state.mjs';

test('phase subscribers receive transitions, not token text or repeated token notifications', () => {
  let updates = 0;
  const state = new ModelState(() => { updates++; });
  state.start('one', 'gpt-test');
  for (let i = 0; i < 100; i++) state.event('one', {type: 'response.reasoning_summary_text.delta', delta: 'PRIVATE SUMMARY'});
  assert.equal(updates, 2);
  assert.equal(JSON.stringify(state.snapshot()).includes('PRIVATE SUMMARY'), false);
  state.event('one', {type: 'response.output_text.delta', delta: 'PRIVATE MESSAGE'});
  assert.equal(updates, 3); assert.equal(state.snapshot().state, 'generating');
  state.finish('one', true); assert.equal(updates, 4);
  const brokenObserver = new ModelState(() => { throw new Error('observer failed'); });
  assert.doesNotThrow(() => { brokenObserver.start('one', 'gpt-test'); brokenObserver.finish('one', true); });
});

test('authenticated local event feed pushes reasoning and generating without snapshot polling or model calls', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-model-feed-'));
  let output;
  const source = new ReadableStream({start(controller) { output = controller; }});
  const service = await createService({directory, upstream: 'https://api.openai.com/v1', fetchImpl: async () => new Response(source, {headers: {'content-type': 'text/event-stream'}})});
  const stop = new AbortController(), observed = [];
  const feed = watchModel(value => observed.push(value), {directory, signal: stop.signal});
  const until = async predicate => {
    const deadline = Date.now() + 3000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error('Phase event did not arrive'); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  try {
    await until(() => observed.length);
    const blocked = await fetch(service.endpoint.url + '/model/events', {headers: {authorization: 'Bearer ' + service.endpoint.token, origin: 'https://untrusted.invalid'}});
    assert.equal(blocked.status, 403);
    const completed = fetch(service.endpoint.url + '/v1/responses', {method: 'POST', headers: {'x-helix-key': service.endpoint.token, authorization: 'Bearer synthetic'}, body: JSON.stringify({model: 'gpt-test', input: []})}).then(response => response.text());
    completed.catch(() => {});
    await until(() => observed.some(value => value.state === 'waiting'));
    const send = event => output.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(event) + '\n\n'));
    send({type: 'response.reasoning_summary_text.delta', delta: 'PRIVATE SUMMARY'});
    await until(() => observed.some(value => value.state === 'reasoning'));
    send({type: 'response.output_text.delta', delta: 'PRIVATE MESSAGE'});
    await until(() => observed.some(value => value.state === 'generating'));
    send({type: 'response.completed', response: {usage: {input_tokens: 1, output_tokens: 1}}}); output.close();
    await completed; await until(() => observed.some(value => value.state === 'complete'));
    assert.equal(JSON.stringify(observed).includes('PRIVATE'), false);
    assert.equal(service.snapshot().counters.model_calls, 1, 'Only the synthetic mock transport request is counted');
  } finally { try { output.close(); } catch {} stop.abort(); await feed; await service.close(); fs.rmSync(directory, {recursive: true, force: true}); }
});
