import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {RtkAdapter} from '../src/rtk-adapter.mjs';
import {ModelState} from '../src/model-state.mjs';
import {DeterministicMemory, claudeMemRead} from '../src/memory.mjs';
import {createService} from '../src/service.mjs';
import {request} from '../src/connection.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function temp(t, cleanup = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-modules-'));
  if (cleanup) t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}
test('model phases follow provider events, never elapsed time or MCP-only inference', () => {
  const state = new ModelState();
  assert.equal(state.snapshot().observed, false);
  assert.equal(state.snapshot([{kind: 'context'}]).state, 'tool');
  state.start('one', 'gpt-test');
  state.event('one', {type: 'response.created'}); assert.equal(state.snapshot().state, 'waiting');
  state.event('one', {type: 'response.output_item.added', item: {type: 'reasoning', encrypted_content: 'not-collected'}});
  assert.equal(state.snapshot().state, 'reasoning'); assert.equal(JSON.stringify(state.snapshot()).includes('not-collected'), false);
  state.event('one', {type: 'response.output_text.delta', delta: 'private body'}); assert.equal(state.snapshot().state, 'generating');
  state.finish('one', true); assert.equal(state.snapshot().state, 'complete');
  state.start('two', 'gpt-test'); state.finish('two', false); assert.equal(state.snapshot().state, 'failed');
});
test('memory browse is bounded and project-scoped; external Claude-Mem stays byte-identical', t => {
  const dir = temp(t), memory = new DeterministicMemory(dir);
  const note = memory.put({project: 'p', task: 'now', title: 'Exact', body: 'line one\r\nline two'});
  memory.put({project: 'other', task: 'old', title: 'Hidden', body: 'other scope'});
  assert.equal(memory.projects().length, 2);
  assert.equal(memory.browse({project: 'p'}).notes.length, 1);
  assert.equal(memory.read(note.id).body, 'line one\r\nline two');
  assert.throws(() => memory.browse({project: 'p', limit: 10000})); memory.close();
  const file = path.join(dir, 'external.db'), db = new DatabaseSync(file);
  db.exec('CREATE TABLE observations(id INTEGER PRIMARY KEY,project TEXT,title TEXT,narrative TEXT)');
  db.prepare('INSERT INTO observations VALUES(1,?,?,?)').run('p', 'Claude exact', 'literal\r\nnote'); db.close();
  const before = hash(fs.readFileSync(file));
  assert.equal(claudeMemRead(file, 'projects')[0].notes, 1);
  assert.equal(claudeMemRead(file, 'browse', {project: 'other'}).notes.length, 0);
  assert.equal(claudeMemRead(file, 'read', {project: 'p', id: '1'}).body, 'literal\r\nnote');
  assert.equal(claudeMemRead(file, 'read', {project: 'other', id: '1'}), null);
  assert.equal(hash(fs.readFileSync(file)), before);
});
test('RTK uses archived stdin only, preserves exact raw bytes, and fails closed without replay', t => {
  const dir = temp(t), objects = path.join(dir, 'goals/objects'); fs.mkdirSync(objects, {recursive: true});
  const raw = 'full original\r\n'.repeat(100), source = hash(raw); fs.writeFileSync(path.join(objects, source), raw);
  const calls = [];
  const run = (_exe, argv, options) => {
    calls.push({argv, input: options.input});
    return {status: 0, stdout: argv[0] === '--version' ? 'rtk 0.51.0\n' : argv[0] === 'telemetry' ? 'enabled: no\n' : 'summary\n'};
  };
  const rtk = new RtkAdapter({directory: dir, run});
  const result = rtk.filter({source}); assert.equal(result.status, 'filtered');
  assert.equal(result.commands_reexecuted, 0); assert.equal(result.semantic_success, null);
  assert.deepEqual(calls.at(-1).argv, ['pipe', '--filter', 'pytest']); assert.equal(calls.at(-1).input, raw);
  assert.equal(fs.readFileSync(path.join(objects, source), 'utf8'), raw);
  assert.throws(() => rtk.filter({source, filter: 'sh -c mutation'}));
  fs.writeFileSync(path.join(objects, source), 'tampered'); assert.throws(() => rtk.filter({source}), /integrity/);
  fs.writeFileSync(path.join(objects, source), raw);
  const noTelemetry = new RtkAdapter({directory: dir, run: (_exe, argv) => ({status: 0, stdout: argv[0] === '--version' ? 'rtk 0.51.0' : 'enabled: yes'})});
  assert.equal(noTelemetry.filter({source}).status, 'native');
  const failed = new RtkAdapter({directory: dir, run: (_exe, argv) => argv[0] === 'pipe' ? {status: 1, stdout: ''} : run(_exe, argv, {})});
  assert.equal(failed.filter({source}).status, 'native');
});
test('memory and diagnostics share the service capability; selected memory source is honored', async t => {
  const directory = temp(t, false), service = await createService({directory});
  t.after(async () => { await service.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  const invoke = (name, args) => request('/rpc', {directory, value: {method: 'tools/call', params: {name, arguments: args}}});
  await invoke('memory', {action: 'put', project: 'p', task: 'now', title: 'Needle', body: 'Exact body'});
  const projects = await request('/memory/projects', {directory}); assert.equal(projects[0].project, 'p');
  const page = await request('/memory/browse', {directory, value: {project: 'p'}});
  const exact = await request('/memory/read', {directory, value: {project: 'p', id: page.notes[0].id}}); assert.equal(exact.body, 'Exact body');
  await assert.rejects(invoke('memory', {action: 'search', source: 'claude-mem', project: 'p', query: 'Needle'}), /not connected/);
  await assert.rejects(invoke('memory', {action: 'put', source: 'claude-mem', project: 'p', task: 'now', title: 'Wrong source', body: 'Do not write'}), /read-only/);
  assert.equal((await request('/diagnostics', {directory})).model_calls, 0);
  assert.equal((await fetch(service.endpoint.url + '/memory/projects')).status, 403);
  assert.equal((await request('/snapshot', {directory})).model_state.observed, false);
  assert.equal((await request('/rpc', {directory, value: {method: 'tools/list'}})).tools.find(x => x.name === 'context').inputSchema.properties.action.enum.includes('rtk'), true);
});
test('queued and incomplete JSON never masquerade as completed model work', async t => {
  for (const status of ['queued', 'in_progress', 'incomplete', 'failed']) {
    const directory = temp(t, false);
    const service = await createService({directory, upstream: 'https://api.openai.com/v1', fetchImpl: async () => new Response(JSON.stringify({status, usage: {input_tokens: 7, output_tokens: 2}}), {headers: {'content-type': 'application/json'}})});
    try {
      const response = await fetch(service.endpoint.url + '/v1/responses', {method: 'POST', headers: {'x-helix-key': service.endpoint.token, authorization: 'Bearer synthetic', 'content-type': 'application/json'}, body: JSON.stringify({model: 'gpt-test', input: []})});
      await response.text(); const snapshot = service.snapshot();
      assert.notEqual(snapshot.model_state.state, 'complete');
      assert.equal(snapshot.events[0].status, 'failed_or_unknown');
      assert.equal(snapshot.counters.known_input, 7); assert.equal(snapshot.counters.known_output, 2);
    } finally { await service.close(); fs.rmSync(directory, {recursive: true, force: true}); }
  }
});
test('incomplete SSE usage is retained without asserting success', async t => {
  const directory = temp(t, false);
  const service = await createService({directory, upstream: 'https://api.openai.com/v1', fetchImpl: async () => new Response('data: ' + JSON.stringify({type: 'response.incomplete', response: {usage: {input_tokens: 19, output_tokens: 5}}}) + '\n\n', {headers: {'content-type': 'text/event-stream'}})});
  try {
    const response = await fetch(service.endpoint.url + '/v1/responses', {method: 'POST', headers: {'x-helix-key': service.endpoint.token, authorization: 'Bearer synthetic', 'content-type': 'application/json'}, body: JSON.stringify({model: 'gpt-test', input: []})});
    await response.text(); assert.equal(service.snapshot().model_state.state, 'failed');
    assert.equal(service.snapshot().counters.known_input, 19); assert.equal(service.snapshot().counters.known_output, 5);
  } finally { await service.close(); fs.rmSync(directory, {recursive: true, force: true}); }
});
test('core restart is exclusive across awaited shutdown and refuses concurrent RPC', async t => {
  const directory = temp(t, false);
  let releaseClose, startedClose, closed = 0, initialized = 0;
  const gate = new Promise(resolve => { releaseClose = resolve; });
  const started = new Promise(resolve => { startedClose = resolve; });
  const core = {child: {}, async close() { closed++; startedClose(); await gate; this.child = null; },
    async call() { initialized++; this.child = {}; return {tools: []}; }};
  const service = await createService({directory, coreFactory: () => core});
  try {
    const first = request('/core/restart', {directory, value: {}}); await started;
    await assert.rejects(request('/core/restart', {directory, value: {}}), /restart/);
    await assert.rejects(request('/rpc', {directory, value: {method: 'tools/list'}}), /restarting/);
    releaseClose(); assert.equal((await first).status, 'online');
    assert.equal(closed, 1); assert.equal(initialized, 1);
  } finally { releaseClose(); await service.close(); fs.rmSync(directory, {recursive: true, force: true}); }
});
test('explicit database picker selection takes precedence over an environment default', async t => {
  const directory = temp(t, false), old = process.env.HELIX_CLAUDE_MEM_DB;
  const make = (name, project) => { const file = path.join(directory, name), db = new DatabaseSync(file);
    db.exec('CREATE TABLE observations(id INTEGER PRIMARY KEY,project TEXT,title TEXT,narrative TEXT)');
    db.prepare('INSERT INTO observations VALUES(1,?,?,?)').run(project, 'Exact', 'Literal'); db.close(); return file; };
  process.env.HELIX_CLAUDE_MEM_DB = make('default.db', 'default');
  const selected = make('selected.db', 'selected'), before = hash(fs.readFileSync(selected));
  const service = await createService({directory});
  try {
    assert.equal((await request('/memory/projects', {directory}))[0].project, 'default');
    await request('/memory/connect', {directory, value: {file: selected}});
    assert.equal((await request('/memory/projects', {directory}))[0].project, 'selected');
    assert.equal(hash(fs.readFileSync(selected)), before);
  } finally { await service.close(); if (old === undefined) delete process.env.HELIX_CLAUDE_MEM_DB; else process.env.HELIX_CLAUDE_MEM_DB = old;
    fs.rmSync(directory, {recursive: true, force: true}); }
});
test('malformed proxy input does not leave a twenty-minute controller timer alive', () => {
  const code = `import {createOpenAIProxy} from './src/openai-proxy.mjs';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'helix-invalid-'));const p=createOpenAIProxy({directory:dir,upstream:'https://api.openai.com/v1',event:()=>{},counters:{},fetchImpl:()=>{throw Error('must not fetch')}});
    try{await p.forward({url:'/v1/responses',headers:{authorization:'Bearer synthetic'}},{once(){}},{model:'gpt-test',input:{}});process.exitCode=2}catch(e){if(!/input/.test(e.message))process.exitCode=3}finally{p.abort();fs.rmSync(dir,{recursive:true,force:true})}`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 3000});
  assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
});
test('pretty JSON responses retain exact provider usage and do not claim observed reasoning', async t => {
  const directory = temp(t, false);
  const service = await createService({directory, upstream: 'https://api.openai.com/v1', fetchImpl: async () => new Response(JSON.stringify({status: 'completed', usage: {input_tokens: 12, output_tokens: 3}}, null, 2) + '\n', {headers: {'content-type': 'application/json'}})});
  t.after(async () => { await service.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  const response = await fetch(service.endpoint.url + '/v1/responses', {method: 'POST', headers: {'x-helix-key': service.endpoint.token, authorization: 'Bearer synthetic', 'content-type': 'application/json'}, body: JSON.stringify({model: 'gpt-test', input: []})});
  await response.text(); const snapshot = service.snapshot();
  assert.equal(snapshot.counters.known_input, 12); assert.equal(snapshot.counters.known_output, 3); assert.equal(snapshot.counters.unknown_usage, 0);
  assert.equal(snapshot.model_state.state, 'complete');
});
