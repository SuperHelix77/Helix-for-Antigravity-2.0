import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createService} from '../src/service.mjs';
import {request} from '../src/connection.mjs';
import {DeterministicMemory} from '../src/memory.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-release-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return directory;
}
test('literal memory is deterministic, task scoped, searchable and exact after restart', t => {
  const directory = fixture(t);
  let memory = new DeterministicMemory(directory);
  const body = 'Rejected hypothesis\r\nUnicode: \u00e7; literal token %_\\ and full evidence.';
  const result = memory.put({project: 'test', task: 'current', title: 'Hypothesis alpha', body, kind: 'rejected'});
  memory.put({project: 'other', task: 'old', title: 'Hypothesis alpha', body: 'Unrelated old work'});
  assert.equal(memory.search({project: 'test', task: 'old', query: 'Hypothesis'}).length, 0);
  assert.equal(memory.search({project: 'test', task: 'current', query: '" OR 1=1 --'}).length, 0);
  assert.equal(memory.search({project: 'test', query: 'Hypothesis'})[0].kind, 'rejected');
  memory.close(); memory = new DeterministicMemory(directory);
  assert.equal(memory.read(result.id).body, body); assert.equal(result.model_calls, 0);
  memory.close();
});
test('one service, private capability, real MCP core, local memory and precise shutdown', async t => {
  const directory = fixture(t), service = await createService({directory});
  t.after(() => service.close());
  const info = service.endpoint;
  assert.equal((fs.statSync(path.join(directory, 'endpoint.json')).mode & 0o077), 0);
  await assert.rejects(createService({directory}), /EEXIST/);
  assert.equal((await fetch(info.url + '/snapshot')).status, 403);
  assert.equal((await fetch(info.url + '/snapshot', {headers: {authorization: `Bearer ${info.token}`, origin: 'https://untrusted.invalid'}})).status, 403);
  const invoke = (name, args) => request('/rpc', {directory, value: {method: 'tools/call', params: {name, arguments: args}}});
  const list = await request('/rpc', {directory, value: {method: 'tools/list'}});
  assert.deepEqual(list.tools.map(r => r.name), ['goal', 'context', 'memory']);
  assert.match((await invoke('context', {action: 'doctor'})).content[0].text, /Ollama.*none/);
  const note = await invoke('memory', {action: 'put', project: 'test', task: 'current', title: 'Exact recovery', body: 'Literal test memory'});
  const id = JSON.parse(note.content[0].text).id;
  assert.equal(JSON.parse((await invoke('memory', {action: 'read', id})).content[0].text).body, 'Literal test memory');
  const planned = await invoke('goal', {action: 'plan', project: directory, session: 'current', request_id: 'one', objective: 'Only this task',
    steps: [{id: 'review', title: 'Review', kind: 'model', acceptance: 'Review only this result.', artifacts: ['result.txt']}]});
  assert.equal(planned.isError, undefined, planned.content?.[0]?.text);
  const snapshot = await request('/snapshot', {directory});
  assert.equal(snapshot.memory.notes, 1); assert.equal(snapshot.counters.model_calls, 0);
  assert.equal(snapshot.goals[0].objective, 'Only this task'); assert.equal(snapshot.goals[0].stored_only, true);
  assert.equal(snapshot.compaction.threshold_override, null);
  assert.equal(snapshot.privacy.background_llm, false);
  await service.close(); assert.equal(fs.existsSync(path.join(directory, 'endpoint.json')), false);
  assert.equal(fs.existsSync(path.join(directory, 'service.lock')), false);
});
test('installer is idempotent and never touches the client config/auth; uninstall preserves archives', t => {
  const directory = fixture(t), client = path.join(directory, 'codex'); fs.mkdirSync(client);
  fs.writeFileSync(path.join(client, 'config.toml'), 'model="unchanged"\n');
  fs.writeFileSync(path.join(client, 'auth.json'), '{"private":"not-read"}');
  const env = {...process.env, HELIX_HOME: path.join(directory, 'helix'), CODEX_HOME: client};
  const cli = action => spawnSync(process.execPath, ['bin/helix.mjs', action], {cwd: root, env, encoding: 'utf8'});
  assert.equal(cli('install').status, 0); assert.equal(cli('install').status, 0);
  const archive = path.join(env.HELIX_HOME, 'keep-original'); fs.writeFileSync(archive, 'exact');
  assert.equal(cli('uninstall').status, 0);
  assert.equal(fs.readFileSync(archive, 'utf8'), 'exact');
  assert.equal(fs.readFileSync(path.join(client, 'config.toml'), 'utf8'), 'model="unchanged"\n');
  assert.equal(fs.readFileSync(path.join(client, 'auth.json'), 'utf8'), '{"private":"not-read"}');
});
test('owned startup failures remove only their lock and close unpublished listeners', async t => {
  const directory = fixture(t);
  fs.writeFileSync(path.join(directory, 'memory.sqlite'), 'not a database', {mode: 0o600});
  await assert.rejects(createService({directory}), /database/);
  assert.equal(fs.existsSync(path.join(directory, 'service.lock')), false);
  fs.unlinkSync(path.join(directory, 'memory.sqlite'));
  fs.mkdirSync(path.join(directory, 'endpoint.json'));
  await assert.rejects(createService({directory}));
  assert.equal(fs.existsSync(path.join(directory, 'service.lock')), false);
  assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.tmp')), false);
  assert.ok(fs.statSync(path.join(directory, 'endpoint.json')).isDirectory(), 'Do not remove an unrelated conflicting state entry');
  fs.rmdirSync(path.join(directory, 'endpoint.json'));
  const service = await createService({directory}); await service.close();
});
test('MCP adapter rejects JSON null and stays alive for the next real request', async t => {
  const directory = fixture(t), service = await createService({directory});
  try {
    const child = spawn(process.execPath, ['bin/helix.mjs', 'mcp'], {cwd: root, env: {...process.env, HELIX_HOME: directory}, stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 5000);
    child.stdout.on('data', bytes => {
      stdout += bytes;
      if (stdout.includes('"id":1,"result"')) child.stdin.end();
    });
    child.stdin.write('null\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    const code = await new Promise(resolve => child.once('close', resolve)); clearTimeout(timer);
    assert.equal(code, 0); const replies = stdout.trim().split('\n').map(JSON.parse);
    assert.equal(replies[0].error.code, -32600); assert.deepEqual(replies[1].result, {});
  } finally { await service.close(); }
});
