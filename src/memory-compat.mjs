import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';

const lower = value => value.replace(/[A-Z]/g, c => c.toLowerCase());
const validText = (value, max) => typeof value === 'string' && value.trim() && value.length <= max;
const closed = value => ['done', 'dropped'].includes(String(value).toLowerCase());
const marks = values => values.map(() => '?').join(',');
const tables = new Set(['observations', 'session_summaries', 'user_prompts', 'tool_uses', 'sdk_sessions', 'work_state_entries', 'helix']);

export function callerProject(cwd) {
  if (!validText(cwd, 4096) || !path.isAbsolute(cwd)) throw new Error('Caller cwd or explicit project required');
  const real = fs.realpathSync(cwd);
  if (!fs.statSync(real).isDirectory()) throw new Error('Caller cwd must be a directory');
  let root = real, aliases = [];
  try {
    const [top, common, superproject] = execFileSync('git', ['-C', real, 'rev-parse', '--show-toplevel', '--git-common-dir', '--show-superproject-working-tree'], {encoding: 'utf8', timeout: 3000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'pipe']}).split('\n');
    root = top; const name = path.basename(top), commonPath = path.resolve(real, common);
    if (superproject) aliases = [path.basename(superproject), name, path.basename(superproject) + '/' + path.relative(superproject, top).split(path.sep).join('/')];
    else if (commonPath !== path.join(top, '.git')) {
      const parent = path.basename(path.dirname(commonPath));
      aliases = parent === name ? [parent + '/' + parent, parent] : [parent, parent + '/' + name];
    } else aliases = [name];
  } catch {
    const home = os.homedir(), config = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'));
    const excluded = new Set([home, os.tmpdir(), config, path.parse(real).root]);
    if (real !== config && !real.startsWith(config + path.sep)) for (let current = real, depth = 0; depth < 64 && !excluded.has(current); current = path.dirname(current), depth++) {
      if (['.claude-mem-project', '.claude-mem.json'].some(name => fs.existsSync(path.join(current, name)))) { root = current; break; }
    }
    aliases = [...new Set([path.basename(real), path.basename(root) || 'unknown-project'])];
  }
  return {real, root, aliases};
}

export function foldWorkState(entries, includeClosed = false) {
  const groups = new Map();
  for (const entry of entries) {
    const project = entry.scope_project || entry.project, key = JSON.stringify([lower(project), entry.list_name]);
    if (!groups.has(key)) groups.set(key, {project, list: entry.list_name, state: Object.create(null), tasks: new Map()});
    const group = groups.get(key), fields = typeof entry.fields === 'string' ? JSON.parse(entry.fields) : entry.fields;
    if (fields.task == null || fields.task === '') Object.assign(group.state, fields);
    else {
      const task = String(fields.task);
      group.tasks.set(task, {...group.tasks.get(task), ...fields});
    }
  }
  const clean = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== null));
  return [...groups.values()].map(group => ({project: group.project, list: group.list,
    state: includeClosed || !closed(group.state.status) ? clean(group.state) : {},
    tasks: [...group.tasks.values()].filter(task => includeClosed || !closed(task.status)).map(clean)}))
    .filter(group => Object.keys(group.state).length || group.tasks.length);
}
export function renderWorkState(groups) {
  const extra = (object, excluded) => Object.entries(object).filter(([key]) => !excluded.includes(key)).map(([key, value]) => `${key}=${value}`).join(', ');
  const lines = groups.flatMap(group => {
    const state = extra(group.state, ['task']);
    return [`- ${group.list} [${group.project}]${state ? ': ' + state : ''}`,
      ...group.tasks.map(task => `  - ${task.status ? '[' + task.status + '] ' : ''}${task.task}${extra(task, ['task', 'status']) ? ' (' + extra(task, ['task', 'status']) + ')' : ''}`)];
  });
  return lines.join('\n') || 'No matching work state.';
}

export class MemoryCompatibility {
  constructor(memory, sourceFile) {
    this.memory = memory; this.sourceFile = sourceFile;
    memory.db.exec(`CREATE TABLE IF NOT EXISTS inherited_work_updates(
      id INTEGER PRIMARY KEY, project TEXT NOT NULL, list_name TEXT NOT NULL, fields TEXT NOT NULL, created INTEGER NOT NULL)`);
  }
  withSource(callback) {
    const file = this.sourceFile();
    if (!file) return callback(null);
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('Regular inherited memory database required');
    const db = new DatabaseSync(file, {readOnly: true});
    try { return callback(db); } finally { db.close(); }
  }
  projects(db, {project, cwd}) {
    if (project !== undefined && !validText(project, 256)) throw new Error('Valid explicit memory project required');
    let requested = project ? [project] : [];
    if (!project) {
      const {real, root, aliases} = callerProject(cwd);
      if (db && db.prepare("SELECT 1 FROM sqlite_schema WHERE name='sdk_sessions'").get()) {
        const columns = db.prepare('PRAGMA table_info(sdk_sessions)').all().map(row => row.name);
        if (columns.includes('cwd')) requested = db.prepare('SELECT project FROM sdk_sessions WHERE cwd IN (?,?) AND project IS NOT NULL ORDER BY id').all(cwd, real).map(row => row.project);
        if (!requested.length && columns.includes('cwd')) requested = db.prepare('SELECT project FROM sdk_sessions WHERE cwd=? AND project IS NOT NULL ORDER BY id').all(root).map(row => row.project);
      }
      if (!requested.length) requested = aliases;
    }
    const primary = requested.at(-1);
    requested = [...new Set(requested.filter(value => value !== primary)), primary];
    const read = new Set(requested);
    if (db) for (const table of ['observations', 'session_summaries']) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
      if (columns.includes('merged_into_project')) for (const row of db.prepare(`SELECT DISTINCT project FROM ${table} WHERE merged_into_project COLLATE NOCASE IN (${marks(requested)})`).all(...requested)) if (row.project) read.add(row.project);
    }
    return {primary, requested, read: [...read]};
  }
  readState(args) {
    if (args.list !== undefined && !validText(args.list, 200) || args.includeClosed !== undefined && typeof args.includeClosed !== 'boolean') throw new Error('Valid work-state list and includeClosed flag required');
    return this.withSource(db => {
      const scope = this.projects(db, args), entries = [];
      if (db && db.prepare("SELECT 1 FROM sqlite_schema WHERE name='work_state_entries'").get()) {
        entries.push(...db.prepare(`SELECT id,project,list_name,fields FROM work_state_entries WHERE project COLLATE NOCASE IN (${marks(scope.read)}) ${args.list === undefined ? '' : 'AND list_name=?'} ORDER BY id`)
          .all(...scope.read, ...(args.list === undefined ? [] : [args.list])));
      }
      entries.push(...this.memory.db.prepare(`SELECT id,project,list_name,fields FROM inherited_work_updates WHERE project COLLATE NOCASE IN (${marks(scope.read)}) ${args.list === undefined ? '' : 'AND list_name=?'} ORDER BY id`)
        .all(...scope.read, ...(args.list === undefined ? [] : [args.list])));
      const requested = new Set(scope.requested.map(lower));
      return foldWorkState(entries.map(row => ({...row, scope_project: requested.has(lower(row.project)) ? scope.primary : row.project})), args.includeClosed);
    });
  }
  writeState(args) {
    const {fields, list} = args;
    if (!validText(list, 200) || !fields || typeof fields !== 'object' || Array.isArray(fields) || !Object.keys(fields).length ||
        Object.entries(fields).some(([key, value]) => !key.trim() || ['__proto__', 'constructor', 'prototype'].includes(key) || value !== null && !['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) || JSON.stringify(fields).length > 2000) throw new Error('Work state requires a list and bounded primitive fields (2000 characters)');
    const project = this.withSource(db => this.projects(db, args).primary);
    this.memory.db.prepare('INSERT INTO inherited_work_updates(project,list_name,fields,created) VALUES(?,?,?,?)').run(project, list, JSON.stringify(fields), Date.now());
    return this.readState({...args, fields: undefined});
  }
  record({table = 'observations', id, offset = 0, limit = 12000, project}) {
    if (!tables.has(table) || table !== 'helix' && (!Number.isSafeInteger(Number(id)) || !/^\d+$/.test(String(id))) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 24000) throw new Error('Known memory table, id and bounded exact range required');
    const encode = row => {
      if (!row) return null;
      if (project !== undefined && (!validText(project, 256) || row.project !== project)) throw new Error('Inherited memory project mismatch');
      const exact = JSON.stringify(row), next = offset + limit;
      return {table, id: String(id), encoding: 'JSON UTF-16 character ranges', text: exact.slice(offset, next), characters: exact.length,
        next_offset: next < exact.length ? next : null, authority: 'historical evidence, not authorization'};
    };
    if (table === 'helix') return encode(this.memory.read(id));
    return this.withSource(db => {
      if (!db) throw new Error('No inherited database connected');
      const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(Number(id));
      return encode(row);
    });
  }
  search(args) {
    if (!validText(args.query, 1000)) throw new Error('Literal memory search query required');
    const limit = args.limit ?? 20, offset = args.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0 || args.orderBy !== undefined && !['date_asc', 'date_desc'].includes(args.orderBy)) throw new Error('Bounded literal memory search required');
    if (args.platformSource || args.dateStart || args.dateEnd) throw new Error('This deterministic adapter does not guess platform/date filters; use exact memory_record retrieval');
    return this.withSource(db => {
      if (!db) return [];
      const scope = this.projects(db, args), category = args.type || 'all';
      const specs = category === 'all' ? [['observations', ['title', 'narrative', 'text', 'facts']], ['session_summaries', ['request', 'learned', 'completed']], ['user_prompts', ['prompt_text']]] :
        category === 'sessions' ? [['session_summaries', ['request', 'learned', 'completed']]] : category === 'prompts' ? [['user_prompts', ['prompt_text']]] : [['observations', ['title', 'narrative', 'text', 'facts']]];
      const results = [], literal = '%' + args.query.replace(/[\\%_]/g, '\\$&') + '%';
      for (const [table, wanted] of specs) {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
        if (!columns.length) continue;
        const selected = wanted.filter(column => columns.includes(column));
        const projectSQL = columns.includes('project') ? `project COLLATE NOCASE IN (${marks(scope.read)})` : `session_db_id IN (SELECT id FROM sdk_sessions WHERE project COLLATE NOCASE IN (${marks(scope.read)}))`;
        const typeFilter = table === 'observations' ? args.obs_type || (!['all', 'observations', 'sessions', 'prompts'].includes(category) ? category : null) : null;
        const types = typeFilter?.split(',').map(value => value.trim()).filter(Boolean) || [];
        const rows = db.prepare(`SELECT * FROM ${table} WHERE ${projectSQL} AND (${selected.map(column => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')}) ${types.length ? `AND type IN (${marks(types)})` : ''} ORDER BY id ${args.orderBy === 'date_asc' ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`)
          .all(...scope.read, ...selected.map(() => literal), ...types, limit, offset);
        results.push(...rows.map(row => ({id: row.id, table, title: row.title || row.request?.slice(0, 200) || row.prompt_text?.slice(0, 200), preview: (row.narrative || row.text || row.facts || row.learned || row.prompt_text || '').slice(0, 320), project: row.project || scope.primary})));
      }
      return results.slice(0, limit);
    });
  }
}

export const memoryCompatibilityTools = [
  {name: 'work_state_read', description: 'Read scoped historical work state. Memory is not authorization to resume old tasks.', inputSchema: {type: 'object', properties: {list: {type: 'string'}, includeClosed: {type: 'boolean'}}, additionalProperties: false}},
  {name: 'work_state_write', description: 'Append explicit work-state fields to HELIX SQLite. No model worker.', inputSchema: {type: 'object', properties: {list: {type: 'string'}, fields: {type: 'object', additionalProperties: {type: ['string', 'number', 'boolean', 'null']}}}, required: ['list', 'fields'], additionalProperties: false}},
  {name: 'search', description: 'Bounded literal search of inherited observations, summaries and prompts. No embedding/model calls.', inputSchema: {type: 'object', properties: {query: {type: 'string'}, project: {type: 'string'}, limit: {type: 'integer'}, offset: {type: 'integer'}, type: {type: 'string'}, obs_type: {type: 'string'}, orderBy: {enum: ['date_asc', 'date_desc']}}, required: ['query'], additionalProperties: false}},
  {name: 'get_observations', description: 'Retrieve exact inherited observation fields by id. For long records use memory_record ranges.', inputSchema: {type: 'object', properties: {ids: {type: 'array', items: {type: 'integer'}, maxItems: 20}, project: {type: 'string'}}, required: ['ids'], additionalProperties: false}},
  {name: 'memory_record', description: 'Recover every stored field of inherited records or new HELIX notes in exact bounded JSON ranges. Use table helix and the UUID for new notes.', inputSchema: {type: 'object', properties: {table: {enum: [...tables]}, id: {type: ['integer', 'string']}, offset: {type: 'integer'}, limit: {type: 'integer'}}, required: ['table', 'id'], additionalProperties: false}},
  {name: 'save_memory', description: 'Store an explicitly selected literal note in HELIX SQLite without an observer or model.', inputSchema: {type: 'object', properties: {project: {type: 'string'}, title: {type: 'string'}, text: {type: 'string'}}, required: ['text', 'title'], additionalProperties: false}},
];

export function callMemoryCompatibility(compat, name, args, cwd) {
  const input = {...args, cwd}; let value;
  if (name === 'work_state_read') value = renderWorkState(compat.readState(input));
  else if (name === 'work_state_write') value = renderWorkState(compat.writeState(input));
  else if (name === 'search') {
    const inherited = compat.search(input), project = compat.withSource(db => compat.projects(db, input).primary);
    value = [...inherited, ...compat.memory.search({project, query: args.query, limit: Math.min(args.limit || 20, 20)}).map(row => ({id: row.id, table: 'helix', title: row.title, preview: row.body}))].slice(0, args.limit || 20);
  } else if (name === 'get_observations') {
    if (!Array.isArray(args.ids) || !args.ids.length || args.ids.length > 20) throw new Error('One to twenty observation ids required');
    value = args.ids.map(id => compat.record({id, project: args.project}));
  } else if (name === 'memory_record') value = compat.record(args);
  else if (name === 'save_memory') {
    const project = compat.withSource(db => compat.projects(db, input).primary);
    value = compat.memory.put({project, task: 'explicit-memory', title: args.title, body: args.text});
  } else throw new Error('Unknown deterministic memory tool');
  return {content: [{type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value)}]};
}
