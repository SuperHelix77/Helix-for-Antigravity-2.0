import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {ActivityFrames, NativeActivityProjection, NativeCodexActivity, nativeActivityScope} from '../src/native-codex-activity.mjs';
import {createService} from '../src/service.mjs';
import {request, watchModel} from '../src/connection.mjs';

const scope = {threadId: '11111111-2222-3333-4444-555555555555', hostId: 'local'};
const frame = value => { const payload = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4); header.writeUInt32LE(payload.length); return Buffer.concat([header, payload]); };
const snapshot = (state, revision = 1) => ({type: 'snapshot', revision, conversationState: state});
const turn = {turnId: 'turn-public', status: 'inProgress', turnStartedAtMs: 100,
  items: [{id: 'r', type: 'reasoning', summary: ['PRIVATE REASONING'], content: 'PRIVATE CONTENT'}], completedItemIds: {r: false}};
const initial = () => ({model: 'gpt-public-test', threadRuntimeStatus: {type: 'active'}, turns: [structuredClone(turn)], messages: ['PRIVATE MESSAGE']});
const until = async predicate => { const deadline = Date.now() + 2500; while (!predicate()) { if (Date.now() > deadline) throw new Error('Expected native activity did not arrive'); await new Promise(resolve => setTimeout(resolve, 5)); } };

test('native projection distinguishes active items, completion, generation, tool, compaction and idle without text', () => {
  const projection = new NativeActivityProjection();
  assert.equal(projection.accept(snapshot(initial()), 'owner').state, 'reasoning');
  assert.equal(JSON.stringify(projection.value).includes('PRIVATE'), false);
  const patch = (patches, revision) => projection.accept({type: 'patches', baseRevision: revision - 1, revision, patches}, 'owner');
  assert.equal(patch([
    {op: 'replace', path: ['turns', 0, 'completedItemIds', 'r'], value: true},
    {op: 'add', path: ['turns', 0, 'items', 1], value: {id: 'm', type: 'agentMessage', text: 'PRIVATE OUTPUT'}},
    {op: 'add', path: ['turns', 0, 'aeonAssistantMessageStartedAtMsById'], value: {m: 100}},
  ], 2).state, 'generating');
  assert.equal(patch([{op: 'add', path: ['turns', 0, 'items', 1, 'text'], value: 'PRIVATE DELTA'}], 3).state, 'generating');
  assert.equal(patch([
    {op: 'add', path: ['turns', 0, 'agentMessageCompletedAtMsById'], value: {m: 101}},
    {op: 'add', path: ['turns', 0, 'items', 2], value: {id: 't', type: 'commandExecution', status: 'inProgress', command: 'PRIVATE COMMAND'}},
  ], 4).state, 'tool');
  assert.equal(patch([
    {op: 'replace', path: ['turns', 0, 'items', 2, 'status'], value: 'completed'},
    {op: 'add', path: ['turns', 0, 'items', 3], value: {id: 'c', type: 'contextCompaction'}},
    {op: 'add', path: ['turns', 0, 'completedItemIds', 'c'], value: false},
  ], 5).state, 'compacting');
  assert.equal(patch([{op: 'replace', path: ['turns', 0, 'completedItemIds', 'c'], value: true}], 6).state, 'waiting');
  assert.equal(patch([{op: 'replace', path: ['turns', 0, 'status'], value: 'completed'},
    {op: 'replace', path: ['threadRuntimeStatus', 'type'], value: 'idle'}], 7).state, 'idle');
  assert.equal(JSON.stringify(projection).includes('PRIVATE'), false);
});

test('an agent message needs an explicit start receipt; missing completion alone cannot prove generation', () => {
  const projection = new NativeActivityProjection(), state = initial();
  state.turns[0].items = [{id: 'message', type: 'agentMessage'}]; state.turns[0].completedItemIds = {};
  assert.equal(projection.accept(snapshot(state), 'owner').state, 'waiting');
  state.turns[0].aeonAssistantMessageStartedAtMsById = {message: 200};
  assert.equal(projection.accept(snapshot(state, 2), 'owner').state, 'generating');
  state.turns[0].agentMessageCompletedAtMsById = {message: 201};
  assert.equal(projection.accept(snapshot(state, 3), 'owner').state, 'waiting');
});

test('unknown runtime states do not masquerade as idle and text-only deltas skip metadata recomputation', () => {
  const projection = new NativeActivityProjection(), state = initial();
  projection.accept(snapshot(state), 'owner');
  projection.snapshot = () => { throw new Error('Text delta should not reclassify the whole history'); };
  assert.equal(projection.accept({type: 'patches', baseRevision: 1, revision: 2, patches: [
    {op: 'add', path: ['turns', 0, 'items', 0, 'summary', 0], value: 'PRIVATE DELTA'},
  ]}, 'owner').state, 'reasoning');
  const other = new NativeActivityProjection();
  state.turns[0].status = 'completed'; state.threadRuntimeStatus.type = 'unrecognized';
  assert.equal(other.accept(snapshot(state), 'owner').observed, false);
  delete state.threadRuntimeStatus;
  assert.equal(other.accept(snapshot(state, 2), 'owner').observed, false);
});

test('canonical history uses explicit active turn, never insertion order or historical reasoning', () => {
  const projection = new NativeActivityProjection();
  const active = {...structuredClone(turn), completedItemIds: {r: true}};
  const state = {threadRuntimeStatus: {type: 'active'}, turnHistory: {kind: 'canonical', history: {entitiesByKey: {
    active, older: {...turn, turnId: 'older', status: 'completed'},
  }}}};
  assert.equal(projection.accept(snapshot(state), 'owner').state, 'waiting');
  state.turnHistory.history.entitiesByKey.active.completedItemIds.r = false;
  assert.equal(projection.accept(snapshot(state, 2), 'owner').state, 'reasoning');
  state.turnHistory.history.entitiesByKey.other = {...turn, turnId: 'other'};
  assert.equal(projection.accept(snapshot(state, 3), 'owner').observed, false);
});

test('native nullable timestamps survive normal replace patches and latest model metadata is reported', () => {
  const projection = new NativeActivityProjection(), state = initial();
  delete state.model; state.latestModel = 'gpt-native-latest'; state.turns[0].params = {model: 'gpt-native-current', privateInstructions: 'PRIVATE'};
  state.turns[0].turnStartedAtMs = null; state.turns[0].finalAssistantStartedAtMs = null;
  assert.equal(projection.accept(snapshot(state), 'owner').model, 'gpt-native-current');
  assert.doesNotThrow(() => projection.accept({type: 'patches', baseRevision: 1, revision: 2, patches: [
    {op: 'replace', path: ['turns', 0, 'turnStartedAtMs'], value: 100},
    {op: 'replace', path: ['turns', 0, 'finalAssistantStartedAtMs'], value: 101},
  ]}, 'owner'));
  state.threadRuntimeStatus.type = 'idle';
  assert.equal(projection.accept(snapshot(state, 3), 'owner').model, 'gpt-native-latest');
  assert.equal(JSON.stringify(projection).includes('PRIVATE'), false);
});

test('duplicate native history preserves fuller items and canonical completion metadata, with ambiguous reconciliation unknown', () => {
  const projection = new NativeActivityProjection(), state = initial();
  state.turnHistory = {kind: 'canonical', history: {entitiesByKey: {one: structuredClone(turn)}}};
  state.turns[0].items = []; state.turns[0].completedItemIds = {};
  assert.equal(projection.accept(snapshot(state), 'owner').state, 'reasoning');
  state.turnHistory.history.entitiesByKey.one.completedItemIds.r = true;
  state.turns[0].completedItemIds.r = false;
  assert.equal(projection.accept(snapshot(state, 2), 'owner').state, 'waiting');
  state.turnHistory.history.entitiesByKey.one.items.push({id: 'extra', type: 'agentMessage'});
  state.turns[0].items = [{id: 'different', type: 'agentMessage'}];
  assert.equal(projection.accept(snapshot(state, 3), 'owner').observed, false);
});

test('paginated native history inserts new items at shared anchors and preserves canonical terminal status', () => {
  const projection = new NativeActivityProjection(), state = initial();
  const canonical = {...structuredClone(turn), itemsPagination: {privateCursor: 'PRIVATE'}, items: [{id: 'a', type: 'reasoning'}, {id: 'b', type: 'reasoning'}], completedItemIds: {a: true, b: true}};
  state.turnHistory = {kind: 'canonical', history: {entitiesByKey: {one: canonical}}};
  state.turns[0].items = [{id: 'a', type: 'reasoning'}, {id: 'new', type: 'mcpToolCall'}, {id: 'b', type: 'reasoning'}]; state.turns[0].completedItemIds = {new: false};
  assert.equal(projection.accept(snapshot(state), 'owner').state, 'tool');
  canonical.status = 'completed';
  assert.equal(projection.accept(snapshot(state, 2), 'owner').state, 'waiting');
  assert.equal(JSON.stringify(projection).includes('PRIVATE'), false);
});

test('native revision gaps, missing patch parents, incompatible types and unsafe scopes fail closed', () => {
  const projection = new NativeActivityProjection(); projection.accept(snapshot(initial()), 'owner');
  assert.throws(() => projection.accept({type: 'patches', baseRevision: 0, revision: 2, patches: []}, 'owner'), /gap/);
  assert.throws(() => projection.accept({type: 'patches', baseRevision: 1, revision: 2, patches: []}, 'other'), /gap/);
  assert.throws(() => projection.accept({type: 'patches', baseRevision: 1, revision: 2, patches: [{op: 'replace', path: ['turns', 19, 'status'], value: 'completed'}]}, 'owner'), /parent/);
  assert.throws(() => projection.accept(snapshot(initial(), 0), 'owner'), /Stale/);
  const future = initial(); future.turns[0].items[0].type = 'newUnknownKind';
  assert.equal(projection.accept(snapshot(future, 3), 'owner').observed, false);
  assert.throws(() => nativeActivityScope({threadId: scope.threadId, hostId: 'remote'}), /local/);
  assert.throws(() => nativeActivityScope({...scope, token: 'not accepted'}), /local/);
});

test('frame parser handles fragmentation, coalescing and rejects declared oversize before allocation', () => {
  const received = [], parser = new ActivityFrames(value => received.push(value), 200);
  const source = Buffer.concat([frame({type: 'one'}), frame({type: 'two'})]);
  for (const byte of source) parser.push(Buffer.from([byte]));
  assert.deepEqual(received, [{type: 'one'}, {type: 'two'}]);
  parser.push(Buffer.concat([frame({type: 'three'}), frame({type: 'four'})]));
  assert.equal(received.length, 4);
  const header = Buffer.alloc(4); header.writeUInt32LE(201);
  assert.throws(() => parser.push(header), /limit/); assert.equal(parser.payload, null);
  assert.throws(() => new ActivityFrames(() => {}).push(Buffer.alloc(4)), /limit/);
  const partial = new ActivityFrames(() => {}); partial.push(frame({secret: 'PRIVATE'}).subarray(0, 8));
  const retained = partial.payload; partial.close(); assert.ok(retained.every(byte => byte === 0));
});

async function ipcFixture(t, onFollow = () => {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-native-ipc-'));
  const socketPath = path.join(directory, 'ipc.sock'), sockets = new Set(), messages = [];
  let selected;
  const server = net.createServer(socket => {
    sockets.add(socket); selected = socket;
    socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    const parser = new ActivityFrames(message => {
      messages.push(message);
      if (message.method === 'initialize') socket.write(frame({type: 'response', requestId: message.requestId, result: {clientId: 'monitor-public'}}));
      if (message.method === 'thread-stream-following-changed') onFollow(message.params.following, send);
    });
    socket.on('data', chunk => parser.push(chunk));
  });
  const send = (change, selectedScope = scope, version = 11) => selected.write(frame({type: 'broadcast', method: 'thread-stream-state-changed', version,
    sourceClientId: 'owner-public', targetClientIds: ['monitor-public'], params: {conversationId: selectedScope.threadId, hostId: selectedScope.hostId, change}}));
  await new Promise(resolve => server.listen(socketPath, resolve)); fs.chmodSync(socketPath, 0o600);
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, {recursive: true, force: true}); });
  return {directory, socketPath, messages, send, sockets};
}

test('read-only native client resynchronizes one gap, ignores other chats, unsubscribes and exposes no private content', async t => {
  let followed = 0;
  const fixture = await ipcFixture(t, (following, send) => { if (following) { followed++; send(snapshot(initial(), followed)); } });
  const states = [], native = new NativeCodexActivity({socketPath: fixture.socketPath, refreshMs: 0, changed: () => states.push(native.snapshot())});
  t.after(() => native.close()); native.bind(scope);
  await until(() => native.snapshot().state === 'reasoning');
  fixture.send(snapshot({threadRuntimeStatus: {type: 'idle'}}, 2), {...scope, threadId: '99999999-2222-3333-4444-555555555555'});
  await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(native.snapshot().state, 'reasoning');
  fixture.send({type: 'patches', baseRevision: 0, revision: 2, patches: []});
  await until(() => followed === 2 && native.snapshot().state === 'reasoning');
  assert.ok(states.some(value => !value.observed && /revision/.test(value.detail)));
  fixture.send(snapshot({threadRuntimeStatus: {type: 'idle'}}, 3)); await until(() => native.snapshot().state === 'idle');
  assert.equal(JSON.stringify(native.projection).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(states).includes('PRIVATE'), false);
  native.close(); await until(() => fixture.messages.some(value => value.params?.following === false));
  assert.equal(native.snapshot().observed, false);
  assert.ok(fixture.messages.every(value => ['initialize', 'thread-stream-following-changed'].includes(value.method)));
});

test('lost native connection and unsupported protocol become unknown, never stale reasoning', async t => {
  const fixture = await ipcFixture(t, (following, send) => { if (following) send(snapshot(initial())); });
  const native = new NativeCodexActivity({socketPath: fixture.socketPath, refreshMs: 0, retryMs: 10000});
  t.after(() => native.close()); native.bind(scope); await until(() => native.snapshot().state === 'reasoning');
  const retired = native.socket; retired.destroy(); native.bind(scope);
  await until(() => native.snapshot().state === 'reasoning');
  retired.emit('error', new Error('Late retired socket error'));
  assert.equal(native.snapshot().state, 'reasoning');
  fixture.send(snapshot(initial(), 2), scope, 999);
  await until(() => !native.snapshot().observed); assert.equal(native.snapshot().state, 'unknown');
  native.bind(scope); await until(() => native.snapshot().state === 'reasoning');
  for (const socket of fixture.sockets) socket.destroy();
  await until(() => !native.snapshot().observed); assert.equal(native.snapshot().state, 'unknown');
});

test('service pushes native phases without provider requests, rejects browser binding and reloads explicit scope', async t => {
  const fixture = await ipcFixture(t, (following, send) => { if (following) send(snapshot(initial())); });
  const directory = path.join(fixture.directory, 'service');
  const nativeActivityFactory = changed => new NativeCodexActivity({socketPath: fixture.socketPath, changed, refreshMs: 0});
  let service = await createService({directory, nativeActivityFactory});
  const stop = new AbortController(), observed = [];
  const feed = watchModel(value => observed.push(value), {directory, signal: stop.signal});
  try {
    await until(() => observed.length);
    const rejected = await fetch(service.endpoint.url + '/model/native', {method: 'POST', headers: {authorization: 'Bearer ' + service.endpoint.token, origin: 'https://untrusted.invalid'}, body: JSON.stringify(scope)});
    assert.equal(rejected.status, 403);
    assert.equal((await request('/model/native', {directory, value: scope})).model_calls, 0);
    await until(() => observed.some(value => value.state === 'reasoning'));
    const generating = initial(); generating.turns[0].completedItemIds = {r: true, m: false}; generating.turns[0].items.push({id: 'm', type: 'agentMessage', text: 'PRIVATE OUTPUT'});
    fixture.send(snapshot(generating, 2)); await until(() => observed.some(value => value.state === 'generating'));
    fixture.send(snapshot({threadRuntimeStatus: {type: 'idle'}}, 3)); await until(() => observed.some(value => value.state === 'idle'));
    assert.equal(service.snapshot().counters.model_calls, 0); assert.equal(service.snapshot().counters.operations, 0);
    assert.equal(service.snapshot().privacy.background_llm, false); assert.equal(JSON.stringify(observed).includes('PRIVATE'), false);
    assert.equal(fs.statSync(path.join(directory, 'native-activity.json')).mode & 0o077, 0);
    stop.abort(); await feed; await service.close();
    service = await createService({directory, nativeActivityFactory});
    await until(() => service.snapshot().model_state.state === 'reasoning');
  } finally { stop.abort(); await feed; await service.close(); }
});
