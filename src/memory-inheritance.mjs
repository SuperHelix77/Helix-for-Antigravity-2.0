import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {DatabaseSync, backup} from 'node:sqlite';
import {privateDirectory, privateJSON} from './local-state.mjs';

const quote = value => '"' + value.replaceAll('"', '""') + '"';
function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Inheritance requires regular files, not links');
  return stat;
}
export async function fileDigest(file) {
  regular(file);
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// Hash raw text bytes as blobs, not decoded JS strings. Integers retain all 64 bits.
export function databaseDigest(db) {
  const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
  const tables = {};
  for (const entry of schema.filter(row => row.type === 'table')) {
    const columns = db.prepare(`PRAGMA table_info(${quote(entry.name)})`).all();
    const primary = columns.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => quote(c.name));
    const expressions = columns.flatMap(c => [
      `typeof(${quote(c.name)})`,
      `CASE WHEN typeof(${quote(c.name)}) IN ('text','blob') THEN CAST(${quote(c.name)} AS BLOB) ELSE ${quote(c.name)} END`,
    ]);
    const query = db.prepare(`SELECT ${expressions.join(',')} FROM ${quote(entry.name)} ORDER BY ${primary.length ? primary.join(',') : 'rowid'}`);
    query.setReadBigInts(true); query.setReturnArrays(true);
    const hash = createHash('sha256'); let rows = 0;
    for (const row of query.iterate()) {
      rows++; hash.update('row:');
      for (const value of row) {
        const bytes = value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(value === null ? 'null' : String(value));
        hash.update(String(bytes.length) + ':'); hash.update(bytes);
      }
    }
    tables[entry.name] = {rows, sha256: hash.digest('hex')};
  }
  return {schema_sha256: createHash('sha256').update(JSON.stringify(schema)).digest('hex'), tables};
}

export async function snapshotDatabase(source, destination) {
  regular(source);
  if (fs.existsSync(destination)) throw new Error('Snapshot destination must be new');
  fs.closeSync(fs.openSync(destination, 'wx', 0o600));
  const db = new DatabaseSync(source, {readOnly: true});
  let copy;
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN');
    db.prepare('SELECT count(*) FROM sqlite_schema').get();
    await backup(db, destination, {rate: 2048});
    copy = new DatabaseSync(destination);
    // A standalone snapshot must not depend on new or source WAL sidecars.
    copy.exec('PRAGMA journal_mode=DELETE');
    const integrity = copy.prepare('PRAGMA quick_check').all();
    if (integrity.length !== 1 || integrity[0].quick_check !== 'ok') throw new Error('Inherited SQLite integrity check failed');
    const before = databaseDigest(db), after = databaseDigest(copy);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Inherited SQLite rows or schema differ');
    return {integrity: 'ok', ...after};
  } finally { copy?.close(); db.close(); }
}

async function archiveTree(source, destination) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error('Auxiliary memory links are not followed');
  if (stat.isDirectory()) {
    privateDirectory(destination);
    const names = fs.readdirSync(source).sort(), files = [];
    for (const name of names) {
      const sidecar = /\.(?:sqlite3?|db)-(?:wal|shm)$/.test(name);
      const target = sidecar ? path.join(privateDirectory(path.join(destination, 'opaque-sqlite-sidecars')), name) : path.join(destination, name);
      files.push(...await archiveTree(path.join(source, name), target));
    }
    if (JSON.stringify(names) !== JSON.stringify(fs.readdirSync(source).sort())) throw new Error('Auxiliary memory changed during inheritance');
    return files;
  }
  regular(source);
  if (/\.(sqlite3?|db)$/.test(source)) {
    const database = await snapshotDatabase(source, destination);
    fs.chmodSync(destination, 0o400);
    return [{file: destination, database, sha256: await fileDigest(destination)}];
  }
  const before = await fileDigest(source);
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL); fs.chmodSync(destination, 0o400);
  const after = fs.lstatSync(source);
  if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || before !== await fileDigest(destination) || before !== await fileDigest(source)) throw new Error('Auxiliary memory file changed during inheritance');
  return [{file: destination, sha256: before, bytes: stat.size}];
}

export async function inheritMemory({directory, source, auxiliary = []}) {
  directory = privateDirectory(directory);
  if (!path.isAbsolute(source) || !Array.isArray(auxiliary) || auxiliary.some(file => !path.isAbsolute(file))) throw new Error('Explicit absolute memory paths required');
  const root = privateDirectory(path.join(privateDirectory(path.join(directory, 'inherited')), randomUUID()));
  const file = path.join(root, 'claude-mem.sqlite');
  const database = await snapshotDatabase(source, file);
  fs.chmodSync(file, 0o400);
  const extras = [];
  for (const [index, selected] of auxiliary.entries()) {
    const destination = path.join(root, `aux-${index}-${path.basename(selected)}`);
    extras.push(...await archiveTree(selected, destination));
  }
  const manifest = {schema: 'helix.memory-inheritance.v1', created: Date.now(), source, file,
    source_preserved: true, database, sha256: await fileDigest(file), auxiliary: extras,
    pending_jobs_replayed: 0, model_calls: 0};
  const manifestFile = path.join(root, 'manifest.json'); privateJSON(manifestFile, manifest);
  // Publish the new read source only after every verification and auxiliary archive succeeds.
  privateJSON(path.join(directory, 'memory-inheritance-proof.json'), manifest);
  privateJSON(path.join(directory, 'memory-bridge.json'), {file, inheritance: manifestFile});
  return manifest;
}
