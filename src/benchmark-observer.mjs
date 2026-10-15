import fs from 'node:fs';
import path from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {createHash} from 'node:crypto';
import {processStartIdentityProbe} from './process-identity.mjs';

function json(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error('Unsupported monitor source');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
class Journal {
  constructor(project) { this.project = project; this.rows = []; this.offset = 0; this.pending = ''; this.decoder = new StringDecoder('utf8'); }
  read(file) {
    let stat; try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return this.rows; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Monitor journal must be a regular file');
    const identity = `${stat.dev}:${stat.ino}`;
    if (this.identity !== identity || stat.size < this.offset) {
      this.identity = identity; this.rows = []; this.offset = 0; this.pending = ''; this.decoder = new StringDecoder('utf8');
    }
    if (stat.size === this.offset) return this.rows;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      while (this.offset < stat.size) {
        const buffer = Buffer.alloc(Math.min(256 * 1024, stat.size - this.offset));
        const count = fs.readSync(fd, buffer, 0, buffer.length, this.offset);
        if (!count) break;
        this.offset += count; this.pending += this.decoder.write(buffer.subarray(0, count));
        let end;
        while ((end = this.pending.indexOf('\n')) >= 0) {
          const line = this.pending.slice(0, end); this.pending = this.pending.slice(end + 1);
          if (!line.trim()) continue;
          const value = this.project(JSON.parse(line)); this.rows.push(value);
        }
        if (this.pending.length > 32 * 1024 * 1024 || this.rows.length > 100000) throw new Error('Monitor journal exceeds bounds');
      }
    } finally { fs.closeSync(fd); }
    return this.rows;
  }
}
const known = rows => {
  const value = {input: 0, output: 0, reasoning: 0, tokens: 0, unknown: 0};
  for (const row of rows) {
    for (const [name, key] of [['input','input_tokens'],['output','output_tokens'],['reasoning','reasoning_tokens'],['tokens','total_tokens']]) {
      const count = row.usage?.[key]; if (Number.isSafeInteger(count) && count >= 0) value[name] += count;
    }
    if (!Number.isSafeInteger(row.usage?.total_tokens) || row.usage.total_tokens < 0) value.unknown++;
  }
  return value;
};
const grade = (task, id) => !task?.grade || task.grade_exit !== 0 || !Array.isArray(task.grade.resolved_ids) ? null : task.grade.resolved_ids.includes(id);
export class BenchmarkObserver {
  constructor(directory) {
    this.directory = directory;
    this.usage = Object.fromEntries(['vanilla','modified'].map(name => [name, new Journal(row => ({id: row.id, order: row.order, started: row.started,
      status: row.status, completed: row.completed, usage: row.usage, compaction: row.compaction, tools: row.tools}))]));
    this.tests = new Journal(row => ({order: row.order, exit_code: row.exit_code, signal: row.signal}));
    this.environments = new Journal(row => ({event: row.event, order: row.order, wall_ms: row.wall_ms}));
    this.native = new Journal(row => row.type === 'item.completed' ? {type: row.item?.type, status: row.item?.status, tool: row.item?.tool, exit_code: row.item?.exit_code} : null);
  }
  view() {
    const controller = path.join(this.directory, 'controller'), manifest = json(path.join(this.directory, 'manifest.json'));
    if (!Array.isArray(manifest?.tasks) || manifest.tasks.length !== 50 ||
        manifest.tasks.some((task, index) => task.order !== index + 1 || typeof task.instance_id !== 'string' || !task.instance_id) ||
        new Set(manifest.tasks.map(task => task.instance_id)).size !== 50) throw new Error('Expected the selected HELIX NEW50 cohort');
    const cohort = manifest.tasks.map(task => Object.fromEntries(['order', 'instance_id', 'repo', 'base_commit'].map(key => [key, task[key]])));
    if (createHash('sha256').update(JSON.stringify(cohort)).digest('hex') !== '63b358be9981c187c66761f516f4b8d1ad6805fb366519b597fae7a2d91f5457') throw new Error('Selected source differs from the fixed NEW50 cohort');
    const status = json(path.join(controller, 'status.json'));
    const historical = json(path.join(controller, 'historical-vanilla-state.json'));
    const rows = {}, lanes = {}, tasks = {};
    for (const name of ['vanilla','modified']) {
      rows[name] = this.usage[name].read(path.join(controller, `${name}-usage.jsonl`));
      const state = status?.lanes?.[name] || (name === 'vanilla' ? historical : null);
      tasks[name] = state?.tasks || [];
      const graded = tasks[name].filter(task => grade(task, manifest.tasks[task.order - 1]?.instance_id) !== null);
      lanes[name] = {...known(rows[name]), requests: rows[name].length, submitted: tasks[name].length, graded: graded.length,
        solves: graded.filter(task => grade(task, manifest.tasks[task.order - 1]?.instance_id)).length,
        failed_requests: rows[name].filter(row => row.status !== 200 || !row.completed).length,
        failed_issues: graded.filter(task => !grade(task, manifest.tasks[task.order - 1]?.instance_id)).length,
        failed_issue_requests: rows[name].filter(row => graded.some(task => task.order === row.order && !grade(task, manifest.tasks[task.order - 1]?.instance_id))).length,
        compactions: rows[name].filter(row => row.compaction).length};
    }
    let prefix = 0;
    for (const issue of manifest.tasks) {
      if (['vanilla','modified'].every(name => grade(tasks[name].find(task => task.order === issue.order), issue.instance_id) !== null)) prefix++;
      else break;
    }
    const matched = Object.fromEntries(['vanilla','modified'].map(name => [name, known(rows[name].filter(row => row.order <= prefix))]));
    const owner = json(path.join(controller, 'monitor-owner.json'));
    const probe = owner ? processStartIdentityProbe(owner.pid) : null;
    const alive = !!owner?.start_identity && probe?.state === 'alive' && probe.identity === owner.start_identity;
    const current = status?.lanes?.modified?.current || 1, finished = status?.lanes?.modified?.exit || owner?.exit;
    const phase = finished ? prefix === 50 && finished.code === 0 ? 'completed' : 'stopped' : alive ? 'running' :
      (status?.lanes?.modified?.requests > 0 || rows.modified.length > 0 || owner) ? 'unknown' : 'prepared';
    const events = rows.modified.slice(-30).map(row => ({id: `request-${row.id}`, at: row.started, kind: 'model', action: `Issue ${row.order} response`,
      status: row.status === 200 && row.completed ? 'complete' : 'failed', input_tokens: row.usage?.input_tokens ?? null, output_tokens: row.usage?.output_tokens ?? null}));
    const tests = this.tests.read(path.join(controller, 'modified-tests.jsonl'));
    const environment = this.environments.read(path.join(controller, 'environment-events.jsonl')).at(-1);
    const inFlight = alive ? Math.max(0, (status?.lanes?.modified?.requests || 0) - rows.modified.length) : 0;
    const nativeTools = this.native.read(path.join(controller, 'modified-cli.jsonl')).filter(row => row && ['command_execution','mcp_tool_call'].includes(row.type));
    const live = {status: phase, current, instance_id: manifest.tasks[current - 1]?.instance_id || null, requests: Math.max(lanes.modified.requests, status?.lanes?.modified?.requests || 0),
      known_input: lanes.modified.input, known_output: lanes.modified.output, known_tokens: lanes.modified.tokens,
      unknown_usage: lanes.modified.unknown, graded: lanes.modified.graded, submitted: lanes.modified.submitted, solved: lanes.modified.solves,
      activity: events.reverse(), tool_commands: tests.length, native_tool_calls: nativeTools.length, in_flight: inFlight,
      failed_commands: tests.filter(row => row.exit_code !== 0).length,
      matched_pairs: prefix, phase: phase === 'running' ? inFlight ? 'Model request in progress' : environment?.event?.startsWith('prepare_') ? `Environment ${environment.order}: ${environment.event}` : `Issue ${current}` : phase};
    return {name: path.basename(this.directory), model: manifest.model, effort: manifest.effort, complete: phase === 'completed', lanes, live,
      known_savings_percent: prefix && matched.vanilla.tokens ? 100 * (matched.vanilla.tokens - matched.modified.tokens) / matched.vanilla.tokens : null,
      output_savings_percent: prefix && matched.vanilla.output ? 100 * (matched.vanilla.output - matched.modified.output) / matched.vanilla.output : null,
      complete_savings_percent: null,
      pairs: manifest.tasks.map(issue => ({order: issue.order, instance_id: issue.instance_id,
        vanilla_pass: grade(tasks.vanilla.find(t => t.order === issue.order), issue.instance_id), modified_pass: grade(tasks.modified.find(t => t.order === issue.order), issue.instance_id),
        vanilla_tokens: known(rows.vanilla.filter(row => row.order === issue.order)).tokens,
        modified_tokens: rows.modified.some(row => row.order === issue.order) ? known(rows.modified.filter(row => row.order === issue.order)).tokens : null})),
      limitations: ['Frozen historical vanilla baseline; modified v2 uses the same known 50 tasks, not a new holdout.',
        `Cumulative savings compare only the ${prefix} officially graded matched pairs. Lane columns include all recorded effort so far.`,
        'Unknown usage is not zero. Failures remain included. Complete billed cost and root orchestration overhead are not measured.',
        'Running status requires the controller PID and kernel start identity to match; timestamps alone do not prove liveness.']};
  }
}
