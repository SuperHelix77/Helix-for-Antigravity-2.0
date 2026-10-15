import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {rtkStatus} from './runtime-status.mjs';

export class RtkAdapter {
  constructor({directory, executable = process.env.HELIX_RTK_PATH || 'rtk', enabled = process.env.HELIX_RTK_ENABLED !== '0', run = spawnSync} = {}) {
    this.directory = directory; this.executable = executable; this.run = run; this.enabled = enabled;
    this.status = {...rtkStatus({executable, run}), enabled, integration: 'archive-first stdin filter', commands_reexecuted: 0};
    const telemetry = enabled && this.status.available ? run(executable, ['telemetry', 'status'], {encoding: 'utf8', timeout: 1500, maxBuffer: 4000, windowsHide: true}) : null;
    this.status.telemetry_confirmed_off = telemetry?.status === 0 && /enabled:\s+no\b/.test(telemetry.stdout || '');
  }
  filter({source, filter = 'pytest'}) {
    if (!/^[a-f0-9]{64}$/.test(source) || !['pytest', 'cargo-test', 'git-log', 'grep', 'find'].includes(filter)) throw new Error('Exact evidence hash and supported RTK filter required');
    const file = path.join(this.directory, 'goals/objects', source);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Regular archived evidence required');
    if (stat.size > 1024 * 1024) return {status: 'native', reason: 'Archive exceeds the 1 MiB filter budget; use indexed retrieval', raw: source, model_calls: 0};
    const bytes = fs.readFileSync(file);
    if (createHash('sha256').update(bytes).digest('hex') !== source) throw new Error('Evidence integrity failure');
    let text;
    try { text = new TextDecoder('utf8', {fatal: true}).decode(bytes); }
    catch { return {status: 'native', reason: 'Binary evidence is not filtered', raw: source, model_calls: 0}; }
    const base = {raw: source, input_bytes: bytes.length, partial: true, semantic_success: null, model_calls: 0, commands_reexecuted: 0};
    if (!this.enabled || !this.status.available || !this.status.telemetry_confirmed_off) return {...base, status: 'native', reason: 'RTK disabled, unavailable or telemetry-off state unverified; exact source retained'};
    const result = this.run(this.executable, ['pipe', '--filter', filter], {input: text, encoding: 'utf8', timeout: 2000, maxBuffer: 2 * 1024 * 1024,
      cwd: this.directory, windowsHide: true});
    if (result.status !== 0 || !result.stdout?.trim() || Buffer.byteLength(result.stdout) >= bytes.length) return {...base, status: 'native', reason: 'Filter failed, empty or not smaller; original command never replayed'};
    const summary = result.stdout;
    if (Buffer.byteLength(summary) > 12000) return {...base, status: 'native', reason: 'Filtered preview exceeds the bounded response budget'};
    return {...base, status: 'filtered', filter, summary, output_bytes: Buffer.byteLength(summary),
      bytes_removed: bytes.length - Buffer.byteLength(summary), estimated_token_savings: null,
      recovery: `context raw {receipt:'${source}',offset:0,limit:12000}`};
  }
}
