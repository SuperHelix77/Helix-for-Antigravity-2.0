import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {privateDirectory} from './local-state.mjs';

const text = (value, limit) => typeof value === 'string' && value.trim() && value.length <= limit;
const terms = query => {
  const words = query.match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 12) || [];
  if (words.length === 0) return null;
  return words.map(t => {
    const clean = t.replaceAll('"', '""');
    return clean.length >= 4 ? `("${clean}" OR "${clean}"*)` : `"${clean}"`;
  }).join(' OR ');
};

export class DeterministicMemory {
  constructor(directory) {
    const file = path.join(privateDirectory(directory), 'memory.sqlite');
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Unsafe memory database');
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    try { this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY,project TEXT NOT NULL,task TEXT NOT NULL,
        title TEXT NOT NULL,body TEXT NOT NULL,kind TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_notes_project_task ON notes(project, task);
      CREATE VIRTUAL TABLE IF NOT EXISTS note_index USING fts5(title,body,content=notes,content_rowid=rowid);
      CREATE TRIGGER IF NOT EXISTS notes_insert AFTER INSERT ON notes BEGIN
        INSERT INTO note_index(rowid,title,body) VALUES(new.rowid,new.title,new.body); END;
      CREATE TRIGGER IF NOT EXISTS notes_delete AFTER DELETE ON notes BEGIN
        INSERT INTO note_index(note_index,rowid,title,body) VALUES('delete',old.rowid,old.title,old.body); END;`); }
    catch (error) { this.db.close(); throw error; }
  }
  prune({project, maxNotes = 500, ttlDays = 30} = {}) {
    try {
      const cutoff = Date.now() - (ttlDays * 24 * 60 * 60 * 1000);
      // Prune transient facts older than ttlDays; preserve architectural decisions and constraints
      if (project) {
        this.db.prepare(`DELETE FROM notes WHERE kind NOT IN ('decision', 'constraint') AND created < ? AND project = ?`).run(cutoff, project);
        const countRow = this.db.prepare('SELECT count(*) as c FROM notes WHERE project = ?').get(project);
        if (countRow && countRow.c > maxNotes) {
          const excess = countRow.c - maxNotes;
          this.db.prepare(`DELETE FROM notes WHERE id IN (SELECT id FROM notes WHERE project = ? AND kind NOT IN ('decision', 'constraint') ORDER BY created ASC LIMIT ?)`).run(project, excess);
        }
      } else {
        this.db.prepare(`DELETE FROM notes WHERE kind NOT IN ('decision', 'constraint') AND created < ?`).run(cutoff);
      }
    } catch {}
  }
  put({project, task, title, body, kind = 'fact'}) {
    if (![project, task].every(v => text(v, 256)) || !text(title, 200) || !text(body, 50000) ||
        !['fact', 'decision', 'rejected', 'settled', 'constraint'].includes(kind)) throw new Error('Explicit project/task, title and literal memory body required');
    const id = randomUUID();
    this.db.prepare('INSERT INTO notes VALUES(?,?,?,?,?,?,?)').run(id, project, task, title, body, kind, Date.now());
    this.prune({project});
    return {id, status: 'stored', model_calls: 0};
  }
  search({project, task, query, limit = 5, expand = false}) {
    if (!text(query, 1000) || !Number.isInteger(limit) || limit < 1 || limit > 20 || (task !== undefined && !text(task, 256))) throw new Error('Explicit query and bounded limit required');
    const match = terms(query);
    if (!match) return [];

    let whereClause = 'WHERE note_index MATCH ?';
    const params = [match];

    if (project && project !== '*' && project !== 'any') {
      if (Array.isArray(project)) {
        whereClause += ` AND n.project IN (${project.map(() => '?').join(',')})`;
        params.push(...project);
      } else {
        whereClause += " AND (n.project=? OR n.project='global')";
        params.push(project);
      }
    }

    if (task !== undefined) {
      whereClause += ' AND n.task=?';
      params.push(task);
    }

    params.push(limit);

    const rows = this.db.prepare(`SELECT n.id,n.project,n.task,n.title,n.body,n.kind FROM note_index f
      JOIN notes n ON n.rowid=f.rowid ${whereClause} ORDER BY bm25(note_index, 5.0, 1.0),n.created DESC LIMIT ?`)
      .all(...params);
    return rows.map(row => ({...row, body: expand ? row.body : row.body.slice(0, 320),
      partial: !expand && row.body.length > 320, authority: 'historical evidence, not an active task'}));
  }
  read(id) {
    if (!text(id, 128)) throw new Error('Memory id required');
    return this.db.prepare('SELECT id,project,task,title,body,kind,created FROM notes WHERE id=?').get(id) || null;
  }
  projects() {
    return this.db.prepare('SELECT project,count(*) AS notes FROM notes GROUP BY project ORDER BY project').all()
      .map(row => ({...row, source: 'helix'}));
  }
  browse({project, task, limit = 20, cursor = 0}) {
    if (!text(project, 256) || task !== undefined && !text(task, 256) || !Number.isInteger(limit) || limit < 1 || limit > 50 ||
        !Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Explicit project and bounded memory page required');
    const rows = this.db.prepare(`SELECT id,title,task,kind,body,created FROM notes WHERE project=? ${task === undefined ? '' : 'AND task=?'} ORDER BY created DESC,id LIMIT ? OFFSET ?`)
      .all(project, ...(task === undefined ? [] : [task]), limit + 1, cursor);
    return {notes: rows.slice(0, limit).map(({body, ...row}) => ({...row, preview: body.slice(0, 320), source: 'helix'})),
      next_cursor: rows.length > limit ? cursor + limit : null};
  }
  count() { return this.db.prepare('SELECT count(*) AS n FROM notes').get().n; }
  close() { this.db.close(); }
}

export function claudeMemRead(file, action, args = {}) {
  if (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) throw new Error('Regular Claude-Mem database required');
  const db = new DatabaseSync(file, {readOnly: true});
  try {
    const columns = db.prepare('PRAGMA table_info(observations)').all().map(r => r.name);
    if (!['id', 'project', 'title', 'narrative'].every(k => columns.includes(k))) throw new Error('Unsupported Claude-Mem schema');
    if (action === 'projects') return db.prepare('SELECT project,count(*) AS notes FROM observations WHERE project IS NOT NULL GROUP BY project ORDER BY project LIMIT 200').all()
      .map(row => ({...row, source: 'claude-mem'}));
    if (!text(args.project, 256)) throw new Error('Explicit Claude-Mem project required');
    if (action === 'read') {
      if (!/^\d+$/.test(String(args.id)) || !Number.isSafeInteger(Number(args.id))) throw new Error('Valid Claude-Mem id required');
      const row = db.prepare('SELECT * FROM observations WHERE project=? AND id=?').get(args.project, Number(args.id));
      const details = row && ['text', 'facts', 'concepts', 'files_read', 'files_modified'].filter(key => row[key] && row[key] !== '[]').map(key => `${key}: ${row[key]}`);
      return row ? {id: String(row.id), project: args.project, title: row.title, body: [row.subtitle, row.narrative, ...details].filter(Boolean).join('\n\n'), record: row, source: 'claude-mem', authority: 'historical evidence only'} : null;
    }
    const {limit = 20, cursor = 0} = args;
    if (action !== 'browse' || !Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Bounded Claude-Mem page required');
    const rows = db.prepare('SELECT id,title,narrative FROM observations WHERE project=? ORDER BY id DESC LIMIT ? OFFSET ?').all(args.project, limit + 1, cursor);
    return {notes: rows.slice(0, limit).map(row => ({id: String(row.id), title: row.title, preview: row.narrative?.slice(0, 320) || '', task: null, kind: 'observation', created: null, source: 'claude-mem'})),
      next_cursor: rows.length > limit ? cursor + limit : null};
  } finally { db.close(); }
}

// Explicitly configured optional bridge. No worker startup, embedding or LLM extraction.
export function lookupClaudeMem(file, {project, query, limit = 5}) {
  if (!text(project, 256) || !text(query, 1000) || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Project, literal query and bounded limit required');
  const db = new DatabaseSync(file, {readOnly: true});
  try {
    const columns = db.prepare('PRAGMA table_info(observations)').all().map(r => r.name);
    if (!['id', 'project', 'title', 'narrative'].every(k => columns.includes(k))) throw new Error('Unsupported Claude-Mem schema; no guessed query');
    const literal = `%${query.replace(/[\\%_]/g, '\\$&')}%`, selected = ['title', 'narrative', 'text', 'facts'].filter(key => columns.includes(key));
    return db.prepare(`SELECT * FROM observations WHERE project=? AND (${selected.map(key => `${key} LIKE ? ESCAPE '\\'`).join(' OR ')}) ORDER BY id DESC LIMIT ?`)
      .all(project, ...selected.map(() => literal), limit).map(r => ({id: r.id, title: r.title, body: (r.narrative || r.text || r.facts || '').slice(0, 640), source: 'claude-mem', authority: 'historical evidence only'}));
  } finally { db.close(); }
}
