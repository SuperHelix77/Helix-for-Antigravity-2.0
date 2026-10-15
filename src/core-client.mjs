import {spawn} from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

export class CoreClient {
  constructor(directory, onEvent = () => {}) {
    this.directory = directory;
    this.onEvent = onEvent;
    this.pending = new Map();
    this.serial = 0;
    this.child = null;
  }
  start() {
    if (this.child) return;
    const child = spawn(process.execPath, [path.join(root, 'bin/helix-context-mcp.mjs')], {
      stdio: ['pipe', 'pipe', 'pipe'], env: {...process.env, ELECTRON_RUN_AS_NODE: '1',
        HELIX_GOAL_DIR: path.join(this.directory, 'goals'),
        HELIX_PROGRAM_RETENTION_DIR: path.join(this.directory, 'programs'),
        MODEL_ROUTER_CONTEXT_ARCHIVE_DIR: path.join(this.directory, 'context-archive'),
        HELIX_CONTEXT_SKILL: path.join(root, 'skills/helixcontext/SKILL.md')},
    });
    this.child = child;
    child.stderr.on('data', () => {});
    const lines = readline.createInterface({input: child.stdout});
    lines.on('line', line => {
      try {
        const value = JSON.parse(line), pending = this.pending.get(value.id);
        if (!pending) return;
        this.pending.delete(value.id);
        clearTimeout(pending.timer);
        value.error ? pending.reject(new Error(value.error.message)) : pending.resolve(value.result);
      } catch { this.onEvent({kind: 'core_protocol_error', status: 'failed'}); }
    });
    const fail = () => {
      if (this.child === child) this.child = null;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Core stopped; execution status may be unknown, mutation not retried')); }
      this.pending.clear();
      this.onEvent({kind: 'core_stopped', status: 'offline'});
    };
    child.once('error', fail);
    child.once('exit', fail);
  }
  call(method, params, {signal} = {}) {
    signal?.throwIfAborted();
    this.start();
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const cancel = () => {
        if (!this.pending.has(id)) return;
        this.child?.stdin.write(JSON.stringify({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: id}}) + '\n');
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error('Request cancelled; mutation is not retried'));
      };
      const timer = setTimeout(cancel, 650000);
      const finish = fn => value => { signal?.removeEventListener('abort', cancel); fn(value); };
      this.pending.set(id, {resolve: finish(resolve), reject: finish(reject), timer});
      signal?.addEventListener('abort', cancel, {once: true});
      this.child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n', error => { if (error) cancel(); });
    });
  }
  async close() {
    const child = this.child;
    if (!child) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(timer);
  }
}
