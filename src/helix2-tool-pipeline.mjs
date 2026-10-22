import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Helix2ElasticFrontier } from './helix2-elastic-frontier.mjs';

/**
 * Helix2ToolPipeline
 * 
 * Executes bounded, pre-authorized multi-step tool pipelines locally
 * without intermediate LLM round-trips.
 * 
 * Example: Edit file -> Run test suite -> Check git diff in ONE model turn.
 * If any step fails, halts immediately and invokes Elastic Frontier diagnostics.
 */
export class Helix2ToolPipeline {
  constructor({ directory, timeoutMs = 180000 } = {}) {
    this.directory = directory;
    this.timeoutMs = timeoutMs;
    this.frontier = new Helix2ElasticFrontier({ directory });
  }

  /**
   * Executes a sequence of operations atomically within the project.
   */
  async executePipeline(project, operations, { taskId = 'pipeline', signal } = {}) {
    const cwd = path.resolve(project);
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw new Error(`Project directory unavailable: ${project}`);
    }

    const results = [];
    let halt = false;

    for (let i = 0; i < operations.length; i++) {
      if (signal?.aborted) {
        results.push({ step: i, status: 'ABORTED', error: 'Pipeline interrupted by caller' });
        break;
      }

      if (halt) {
        results.push({ step: i, status: 'SKIPPED', reason: 'Previous step failed or halted' });
        continue;
      }

      const op = operations[i];

      if (op.kind === 'edit') {
        const editRes = this.#applyEdit(cwd, op);
        results.push({ step: i, kind: 'edit', ...editRes });
        if (!editRes.success) halt = true;
      } else if (op.kind === 'command') {
        const cmdRes = await this.#executeCommand(cwd, op, { taskId, signal });
        results.push({ step: i, kind: 'command', ...cmdRes });
        if (cmdRes.exitCode !== 0) halt = true;
      } else {
        results.push({ step: i, status: 'ERROR', error: `Unknown pipeline operation: ${op.kind}` });
        halt = true;
      }
    }

    const allPassed = results.every(r => r.success || r.exitCode === 0);
    const summary = [
      `[HELIX 2.0 Pipeline: ${operations.length} steps executed; status:${allPassed ? 'SUCCESS' : 'HALTED'}]`,
      ...results.map((r, idx) => `Step #${idx + 1} (${r.kind || 'op'}): ${r.status || (r.exitCode === 0 ? 'PASS' : 'FAIL')} ${r.summary || ''}`),
      allPassed ? '[All pipeline steps completed successfully.]' : '[Pipeline halted at first failure boundary. Examine diagnostics.]'
    ].join('\n');

    return {
      success: allPassed,
      stepsExecuted: results.filter(r => r.status !== 'SKIPPED').length,
      results,
      summary
    };
  }

  #applyEdit(cwd, op) {
    try {
      const targetPath = path.resolve(cwd, op.file);
      if (!fs.existsSync(targetPath)) return { success: false, status: 'FAIL', error: `File not found: ${op.file}` };

      const content = fs.readFileSync(targetPath, 'utf8');
      if (!content.includes(op.target)) {
        return { success: false, status: 'FAIL', error: `Target substring not found in ${op.file}` };
      }

      const replaced = content.replace(op.target, op.replacement);
      fs.writeFileSync(targetPath, replaced, 'utf8');
      const digest = createHash('sha256').update(replaced, 'utf8').digest('hex');

      return {
        success: true,
        status: 'PASS',
        summary: `Edited ${op.file} (sha256:${digest.slice(0, 16)})`
      };
    } catch (e) {
      return { success: false, status: 'ERROR', error: e.message };
    }
  }

  async executeCommandDirect(cwd, command, options = {}) {
    return this.#executeCommand(cwd, { command }, options);
  }

  async #executeCommand(cwd, op, { taskId, signal }) {
    const cmdStr = op.command || (Array.isArray(op.argv) ? op.argv.join(' ') : '');
    const [file, ...args] = op.argv
      ? op.argv
      : process.platform === 'win32'
        ? ['cmd.exe', '/d', '/s', '/c', op.command]
        : ['/bin/sh', '-c', op.command];

    const child = spawn(file, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout.on('data', c => stdoutChunks.push(c));
    child.stderr.on('data', c => stderrChunks.push(c));

    const timeout = op.timeout_ms || 120000;
    const outcome = await new Promise(resolve => {
      let finished = false;
      const timer = setTimeout(() => {
        if (!finished) {
          finished = true;
          child.kill('SIGKILL');
          resolve({ exitCode: 124, timeout: true });
        }
      }, timeout);

      const abortHandler = () => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          child.kill('SIGKILL');
          resolve({ exitCode: 130, aborted: true });
        }
      };
      signal?.addEventListener('abort', abortHandler, { once: true });

      child.on('close', code => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          resolve({ exitCode: code ?? 0, timeout: false });
        }
      });
      child.on('error', err => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          resolve({ exitCode: 127, error: err.message, timeout: false });
        }
      });
    });

    const stdout = Buffer.concat(stdoutChunks).toString('utf8');
    const stderr = Buffer.concat(stderrChunks).toString('utf8');
    const combined = stderr ? `${stdout}\n--- stderr ---\n${stderr}` : stdout;

    const diagnostic = this.frontier.shapeDiagnosticOutput(combined, {
      command: cmdStr,
      exitCode: outcome.exitCode,
      taskId,
      toolName: 'pipeline_command'
    });

    return {
      command: cmdStr,
      exitCode: outcome.exitCode,
      receipt: diagnostic.receipt,
      output: diagnostic.output,
      savedBytes: diagnostic.savedBytes,
      summary: `exit:${outcome.exitCode} (${diagnostic.savedBytes || 0}B saved via Elastic Frontier)`
    };
  }
}
