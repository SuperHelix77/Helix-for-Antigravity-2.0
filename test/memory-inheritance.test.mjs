import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {inheritMemory, snapshotDatabase, databaseDigest, fileDigest} from '../src/memory-inheritance.mjs';
import {DeterministicMemory, claudeMemRead, lookupClaudeMem} from '../src/memory.mjs';
import {MemoryCompatibility, callMemoryCompatibility, foldWorkState, callerProject} from '../src/memory-compat.mjs';
import {createService} from '../src/service.mjs';
import {request} from '../src/connection.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-inheritance-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const source = path.join(directory, 'legacy.db'), db = new DatabaseSync(source);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE observations(id INTEGER PRIMARY KEY,project TEXT,title TEXT,narrative TEXT,facts TEXT,text TEXT,merged_into_project TEXT,metadata BLOB);
    CREATE VIRTUAL TABLE observation_fts USING fts5(title,narrative);
    CREATE TABLE sdk_sessions(id INTEGER PRIMARY KEY,project TEXT,cwd TEXT);
    CREATE TABLE session_summaries(id INTEGER PRIMARY KEY,project TEXT,request TEXT,learned TEXT,completed TEXT,merged_into_project TEXT);
    CREATE TABLE user_prompts(id INTEGER PRIMARY KEY,session_db_id INTEGER,prompt_text TEXT);
    CREATE TABLE tool_uses(id INTEGER PRIMARY KEY,project TEXT,tool_input TEXT,tool_response TEXT);
    CREATE TABLE work_state_entries(id INTEGER PRIMARY KEY,project TEXT,list_name TEXT,fields TEXT);
    CREATE TABLE pending_messages(id INTEGER PRIMARY KEY,status TEXT);
    CREATE TABLE typed_values(k INTEGER PRIMARY KEY,large_integer INTEGER,raw_text TEXT,bits BLOB);
    INSERT INTO typed_values VALUES(1,9223372036854775807,CAST(X'80FF0061' AS TEXT),X'00FF');
    INSERT INTO pending_messages VALUES(1,'queued');
    INSERT INTO observations VALUES(1,'canonical','Literal',NULL,'["fact-only memory"]','exact\r\ntext',NULL,X'00FF');
    INSERT INTO observation_fts VALUES('Literal','indexed evidence');
    INSERT INTO session_summaries VALUES(1,'canonical','request','learned exact','complete',NULL);
    INSERT INTO user_prompts VALUES(1,3,'prior prompt exact');
    INSERT INTO tool_uses VALUES(1,'canonical','long exact command','raw result');`);
  db.prepare('INSERT INTO sdk_sessions VALUES(?,?,?)').run(1, 'canonical', directory);
  db.prepare('INSERT INTO sdk_sessions VALUES(?,?,?)').run(2, 'former', directory);
  db.prepare('INSERT INTO sdk_sessions VALUES(?,?,?)').run(3, 'canonical', directory);
  for (const [id, project, list, fields] of [[1, 'canonical', 'current', {task: 'now', status: 'doing', obsolete: 'clear'}],
    [2, 'CANONICAL', 'current', {task: 'now', obsolete: null}], [3, 'canonical', 'old', {task: 'settled', status: 'done'}]])
    db.prepare('INSERT INTO work_state_entries VALUES(?,?,?,?)').run(id, project, list, JSON.stringify(fields));
  return {directory, source, db};
}

test('online backup preserves all SQLite tables, FTS, raw text bytes, blobs, 64-bit integers and queued state', async t => {
  const {directory, source, db} = fixture(t); t.after(() => db.close());
  const destination = path.join(directory, 'snapshot.db'), before = databaseDigest(db);
  const proof = await snapshotDatabase(source, destination);
  assert.deepEqual(proof.tables, before.tables); assert.equal(proof.integrity, 'ok');
  assert.equal(proof.tables.pending_messages.rows, 1); assert.ok(proof.tables.observation_fts_data);
  const copy = new DatabaseSync(destination, {readOnly: true});
  assert.equal(copy.prepare('SELECT hex(raw_text) AS v FROM typed_values').get().v, '80FF0061');
  const large = copy.prepare('SELECT large_integer FROM typed_values'); large.setReadBigInts(true);
  assert.equal(large.get().large_integer, 9223372036854775807n);
  assert.equal(copy.prepare('SELECT status FROM pending_messages').get().status, 'queued'); copy.close();
  assert.throws(() => db.prepare('SELECT imaginary FROM observations').all());
  await assert.rejects(snapshotDatabase(source, destination), /must be new/);
});

test('inheritance retains private auxiliary bytes and switches only after verification', async t => {
  const {directory, source, db} = fixture(t); t.after(() => db.close());
  const home = path.join(directory, 'owned'), aux = path.join(directory, 'corpora'); fs.mkdirSync(aux);
  fs.writeFileSync(path.join(aux, 'literal.bin'), Buffer.from([0, 255, 13, 10]));
  const sourceBefore = databaseDigest(db), proof = await inheritMemory({directory: home, source, auxiliary: [aux]});
  assert.equal(proof.model_calls, 0); assert.equal(proof.pending_jobs_replayed, 0);
  assert.deepEqual(databaseDigest(db), sourceBefore); assert.equal(proof.auxiliary.length, 1);
  assert.deepEqual(fs.readFileSync(proof.auxiliary[0].file), Buffer.from([0, 255, 13, 10]));
  assert.equal(fs.statSync(proof.file).mode & 0o777, 0o400); assert.equal(fs.statSync(path.dirname(proof.file)).mode & 0o777, 0o700);
  assert.equal(proof.sha256, await fileDigest(proof.file));
  const config = fs.readFileSync(path.join(home, 'memory-bridge.json'), 'utf8');
  const linked = path.join(directory, 'linked'); fs.symlinkSync(aux, linked);
  await assert.rejects(inheritMemory({directory: home, source, auxiliary: [linked]}), /links/);
  assert.equal(fs.readFileSync(path.join(home, 'memory-bridge.json'), 'utf8'), config);
});

test('auxiliary WAL files stay opaque and cannot replay over the verified database', async t => {
  const {directory, source, db} = fixture(t); t.after(() => db.close());
  const auxiliary = path.join(directory, 'chroma'); fs.mkdirSync(auxiliary);
  const other = new DatabaseSync(path.join(auxiliary, 'chroma.sqlite3'));
  other.exec('PRAGMA journal_mode=WAL; CREATE TABLE vectors(id INTEGER PRIMARY KEY,value BLOB); INSERT INTO vectors VALUES(1,X\'00FF\');');
  t.after(() => other.close());
  const proof = await inheritMemory({directory: path.join(directory, 'owned'), source, auxiliary: [auxiliary]});
  const archived = proof.auxiliary.find(row => row.database);
  assert.equal(fs.existsSync(archived.file + '-wal'), false);
  assert.ok(proof.auxiliary.some(row => row.file.includes('opaque-sqlite-sidecars') && row.file.endsWith('-wal')));
  const copy = new DatabaseSync(archived.file, {readOnly: true});
  assert.equal(copy.prepare('SELECT hex(value) AS v FROM vectors').get().v, '00FF'); copy.close();
});

test('proof publication failure never changes the active memory pointer', async t => {
  const {directory, source, db} = fixture(t); t.after(() => db.close());
  const home = path.join(directory, 'owned'); fs.mkdirSync(home, {mode: 0o700});
  const pointer = path.join(home, 'memory-bridge.json'), old = JSON.stringify({file: 'previous'});
  fs.writeFileSync(pointer, old, {mode: 0o600});
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === path.join(home, 'memory-inheritance-proof.json')) throw new Error('synthetic proof failure'); return rename(from, to); };
  try { await assert.rejects(inheritMemory({directory: home, source}), /synthetic proof/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(pointer, 'utf8'), old);
});

test('deterministic compatibility keeps caller cwd, project aliases, null clearing, closed items and writes across restart', t => {
  const {directory, source, db} = fixture(t); t.after(() => db.close());
  const home = path.join(directory, 'owned'); fs.mkdirSync(home, {mode: 0o700});
  let memory = new DeterministicMemory(home), compat = new MemoryCompatibility(memory, () => source);
  let groups = compat.readState({cwd: directory, list: 'current', includeClosed: true});
  assert.equal(groups.length, 1); assert.equal(groups[0].project, 'canonical');
  assert.equal(groups[0].tasks[0].obsolete, undefined);
  assert.equal(compat.readState({cwd: directory, list: 'old'}).length, 0);
  assert.equal(compat.readState({cwd: directory, list: 'old', includeClosed: true})[0].tasks[0].status, 'done');
  const before = databaseDigest(db);
  compat.writeState({cwd: directory, list: 'current', fields: {task: 'now', status: 'done'}});
  assert.deepEqual(databaseDigest(db), before);
  memory.close(); memory = new DeterministicMemory(home); compat = new MemoryCompatibility(memory, () => source);
  assert.equal(compat.readState({cwd: directory, list: 'current'}).length, 0);
  assert.equal(compat.readState({cwd: directory, list: 'current', includeClosed: true})[0].tasks[0].status, 'done');
  assert.throws(() => compat.writeState({cwd: directory, list: 'x', fields: {nested: {bad: true}}}), /primitive/);
  assert.throws(() => compat.writeState({cwd: directory, list: 'x', fields: {value: Infinity}}), /primitive/);
  assert.throws(() => compat.writeState({cwd: directory, list: 'x', fields: JSON.parse('{"__proto__":"bad"}')}), /primitive/);
  assert.throws(() => compat.readState({cwd: 'relative'}), /cwd/); memory.close();
});

test('adopted project lists stay distinct; a closed list does not hide its still-open tasks', () => {
  const result = foldWorkState([
    {project: 'one', list_name: 'shared', fields: {status: 'done'}},
    {project: 'one', list_name: 'shared', fields: {task: 'unfinished', status: 'doing'}},
    {project: 'two', list_name: 'shared', fields: {task: 'other', status: 'doing'}},
  ]);
  assert.equal(result.length, 2); assert.equal(result[0].tasks[0].task, 'unfinished'); assert.deepEqual(result[0].state, {});
});

test('facts without narratives are searchable and exact records recover summaries/prompts/tool history', t => {
  const {directory, source, db} = fixture(t); t.after(() => db.close());
  const memory = new DeterministicMemory(path.join(directory, 'owned')), compat = new MemoryCompatibility(memory, () => source);
  assert.equal(compat.search({cwd: directory, query: 'fact-only'}).length, 1);
  assert.equal(lookupClaudeMem(source, {project: 'canonical', query: 'fact-only'})[0].id, 1);
  assert.match(claudeMemRead(source, 'read', {project: 'canonical', id: '1'}).body, /fact-only/);
  for (const table of ['observations', 'session_summaries', 'user_prompts', 'tool_uses']) {
    let offset = 0, restored = '';
    do { const part = compat.record({table, id: 1, offset, limit: 7}); restored += part.text; offset = part.next_offset; } while (offset !== null);
    assert.equal(restored, JSON.stringify(db.prepare(`SELECT * FROM ${table} WHERE id=1`).get()));
  }
  assert.throws(() => compat.record({table: 'sqlite_schema', id: 1}));
  assert.throws(() => compat.record({id: 1, project: 'other'}), /mismatch/);
  assert.throws(() => compat.search({cwd: directory, query: 'x', dateStart: '2020'}), /does not guess/);
  const note = callMemoryCompatibility(compat, 'save_memory', {title: 'direct', text: 'literal direct memory'}, directory);
  const saved = JSON.parse(note.content[0].text); assert.equal(saved.status, 'stored');
  assert.equal(JSON.parse(compat.record({table: 'helix', id: saved.id}).text).body, 'literal direct memory');
  assert.ok(compat.memory.search({project: 'canonical', query: 'literal'}).some(row => row.id === saved.id));
  const long = 'x'.repeat(50000);
  const large = callMemoryCompatibility(compat, 'save_memory', {title: 'full old limit', text: long}, directory);
  assert.equal(memory.read(JSON.parse(large.content[0].text).id).body, long); memory.close();
});

test('unseen nested callers use git and marker roots without inspecting remote credentials', t => {
  const {directory, db} = fixture(t); t.after(() => db.close());
  const repository = path.join(directory, 'repo'), nested = path.join(repository, 'a', 'b'); fs.mkdirSync(nested, {recursive: true});
  execFileSync('git', ['init', repository], {stdio: 'ignore'});
  assert.deepEqual(callerProject(nested).aliases, ['repo']);
  const marker = path.join(directory, 'marker'), child = path.join(marker, 'child'); fs.mkdirSync(child, {recursive: true});
  fs.writeFileSync(path.join(marker, '.claude-mem-project'), '');
  assert.deepEqual(callerProject(child).aliases, ['child', 'marker']);
});

test('unseen submodule callers recover inherited parent-scoped memory without broadening explicit projects', t => {
  const {directory, source, db} = fixture(t); t.after(() => db.close());
  const parent = path.join(directory, 'superproject'), origin = path.join(directory, 'module-source');
  const git = (cwd, args) => execFileSync('git', ['-C', cwd, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {stdio: 'ignore'});
  execFileSync('git', ['init', parent], {stdio: 'ignore'}); execFileSync('git', ['init', origin], {stdio: 'ignore'});
  git(origin, ['-c', 'user.name=Public Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'public fixture']);
  git(parent, ['-c', 'protocol.file.allow=always', 'submodule', 'add', origin, 'modules/member']);
  const child = path.join(parent, 'modules/member'), nested = path.join(child, 'new/nested'); fs.mkdirSync(nested, {recursive: true});
  assert.deepEqual(callerProject(nested).aliases, ['superproject', 'member', 'superproject/modules/member']);
  db.prepare('INSERT INTO work_state_entries(project,list_name,fields) VALUES(?,?,?)')
    .run('superproject', 'parent-memory', JSON.stringify({task: 'Parent constraint', status: 'doing'}));
  const memory = new DeterministicMemory(path.join(directory, 'owned')); t.after(() => memory.close());
  const compat = new MemoryCompatibility(memory, () => source);
  assert.equal(compat.readState({cwd: nested, list: 'parent-memory'})[0].tasks[0].task, 'Parent constraint');
  assert.deepEqual(compat.readState({cwd: nested, project: 'unrelated', list: 'parent-memory'}), []);
});

test('memory compatibility MCP routes share one service; capability rejects untrusted callers', async t => {
  const {directory, source, db} = fixture(t); t.after(() => db.close());
  const home = path.join(directory, 'owned'); fs.mkdirSync(home, {mode: 0o700});
  fs.writeFileSync(path.join(home, 'memory-bridge.json'), JSON.stringify({file: source}), {mode: 0o600});
  const service = await createService({directory: home});
  try {
    const call = (name, args) => request('/rpc', {directory: home, value: {method: 'tools/call', params: {name: 'memory:' + name, arguments: args, caller_cwd: directory}}});
    assert.match((await call('work_state_read', {list: 'current'})).content[0].text, /canonical/);
    await call('work_state_write', {list: 'current', fields: {task: 'now', status: 'done'}});
    assert.match((await call('work_state_read', {list: 'current'})).content[0].text, /No matching/);
    assert.equal(service.snapshot().counters.model_calls, 0); assert.equal(service.snapshot().memory.legacy_worker_required, false);
    const forbidden = await fetch(service.endpoint.url + '/rpc', {method: 'POST', headers: {origin: 'http://untrusted', authorization: 'Bearer ' + service.endpoint.token}, body: '{}'});
    assert.equal(forbidden.status, 403);
    const child = spawn(process.execPath, ['bin/helix.mjs', 'memory-mcp'], {cwd: new URL('..', import.meta.url), env: {...process.env, HELIX_HOME: home}, stdio: ['pipe', 'pipe', 'pipe']});
    let output = ''; const gotLine = new Promise(resolve => child.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) resolve(); }));
    child.stdin.write(JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}) + '\n'); await gotLine;
    const response = JSON.parse(output.split('\n')[0]);
    assert.ok(response.result.tools.some(tool => tool.name === 'work_state_write'));
    assert.ok(response.result.tools.some(tool => tool.name === 'memory_record'));
    child.stdin.end(); await once(child, 'exit');
  } finally { await service.close(); }
});
