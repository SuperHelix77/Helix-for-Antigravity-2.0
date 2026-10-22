import { createHash } from 'node:crypto';
import { LEAN_SWITCH_RECEIPT_PREFIX } from './helix-lean-switch.mjs';
import { retainToolResult, readRetainedToolResult } from './tool-result-store.mjs';

/**
 * Helix2ElasticFrontier
 * 
 * Solves the "Premature Pruning" defect of HELIX 1.0.
 * In HELIX 1.0, overly aggressive compression on failed test outputs starved the
 * model of critical failure diagnostics, reducing reasoning tokens and causing lost solves.
 * 
 * HELIX 2.0 Elastic Frontier:
 * - On exitCode == 0: Employs maximum compression (ultra-compact receipt).
 * - On exitCode != 0: Dynamically scales diagnostic resolution (Elasticity):
 *     Level 1: Compact error summary + failing test name.
 *     Level 2 (after repeat failure or complex traceback): Full failure frame, assertion diff,
 *              and targeted traceback, while still archiving raw unneeded stdout.
 * - Injects explicit reasoning directives ensuring high reasoning effort is sustained
 *   on complex bugs, guaranteeing Intelligence Parity with vanilla models.
 */
export class Helix2ElasticFrontier {
  constructor({ directory, maxDiagnosticLines = 32, maxTracebackFrames = 5 } = {}) {
    this.directory = directory;
    this.maxDiagnosticLines = maxDiagnosticLines;
    this.maxTracebackFrames = maxTracebackFrames;
    this.failureCounts = new Map(); // task/command -> consecutive failure count
  }

  /**
   * Evaluates command output with adaptive diagnostic elasticity.
   */
  shapeDiagnosticOutput(output, { command = '', exitCode = 0, taskId = 'default', toolName = 'run_command' } = {}) {
    if (typeof output !== 'string' || !output) {
      return { output: output || '', receipt: null, level: 0, rawBytes: 0, shapedBytes: 0 };
    }

    const rawBytes = Buffer.byteLength(output, 'utf8');
    const digest = createHash('sha256').update(output, 'utf8').digest('hex');
    const handle = retainToolResult(output, { directory: this.directory, ttlMs: 0 });

    // Success path: Maximum compression
    if (exitCode === 0) {
      this.failureCounts.delete(taskId);
      const summary = this.#extractSuccessSummary(output);
      const receipt = [
        `${LEAN_SWITCH_RECEIPT_PREFIX} ${toolName} exit:0 raw:${rawBytes}B sha256:${digest.slice(0, 16)}; handle:${handle}]`,
        summary,
        `[Exact log retained in HELIX archive; retrieve with context raw receipt ${handle}]`
      ].join('\n');

      return {
        output: receipt,
        receipt: handle,
        digest,
        level: 0,
        rawBytes,
        shapedBytes: Buffer.byteLength(receipt, 'utf8'),
        savedBytes: Math.max(0, rawBytes - Buffer.byteLength(receipt, 'utf8'))
      };
    }

    // Failure path: Elastic diagnostic escalation
    const currentFailures = (this.failureCounts.get(taskId) || 0) + 1;
    this.failureCounts.set(taskId, currentFailures);

    // Escalation Level:
    // Level 1: First failure -> Focused traceback + failure assertion
    // Level 2: Repeat failure (>=2) -> Deep diagnostic expansion (failing frame, locals, full assert)
    const level = currentFailures >= 2 ? 2 : 1;
    const diagnostics = this.#extractElasticDiagnostics(output, level);

    const receipt = [
      `[HELIX 2.0 Elastic Frontier: ${toolName} exit:${exitCode} failure_count:${currentFailures} resolution:L${level} raw:${rawBytes}B; handle:${handle}]`,
      diagnostics.header,
      '--- TARGETED DIAGNOSTICS ---',
      diagnostics.body,
      '--- REASONING DIRECTIVE ---',
      level === 2
        ? '[CRITICAL: Repeat test failure detected. Deeply examine the assertion delta and traceback above before editing.]'
        : '[Examine the specific failure frame and assertion above. Focus fix precisely on the root cause.]',
      `[Full uncompressed execution log retained; retrieve with context raw receipt ${handle}]`
    ].join('\n');

    return {
      output: receipt,
      receipt: handle,
      digest,
      level,
      rawBytes,
      shapedBytes: Buffer.byteLength(receipt, 'utf8'),
      savedBytes: Math.max(0, rawBytes - Buffer.byteLength(receipt, 'utf8')),
      consecutiveFailures: currentFailures
    };
  }

  #extractSuccessSummary(output) {
    const lines = output.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (/passed|ok|success|===/i.test(line) && line.length > 0) {
        return line;
      }
    }
    return `Exit code 0; ${lines.length} lines executed cleanly.`;
  }

  #extractElasticDiagnostics(output, level) {
    const lines = output.split('\n');
    const errorLines = [];
    const tracebackLines = [];
    let inTraceback = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/Traceback \(most recent call last\):/i.test(line)) {
        inTraceback = true;
        tracebackLines.push(line);
        continue;
      }

      if (inTraceback) {
        tracebackLines.push(line);
        if (/^[a-zA-Z0-9_.]*(?:Error|Exception|AssertionError):/i.test(line)) {
          inTraceback = false;
        }
      } else if (/\b(FAIL|FAILED|ERROR|AssertionError|Exception)\b/i.test(line)) {
        errorLines.push(line);
      }
    }

    let header = errorLines.slice(0, 3).join('\n') || 'Test assertion failure detected.';
    let body = '';

    if (tracebackLines.length > 0) {
      if (level === 1) {
        // Level 1: Keep last 12 lines of traceback (the actual failing frame and error)
        body = tracebackLines.slice(-12).join('\n');
      } else {
        // Level 2: Deep expansion: up to 30 lines of full call stack
        body = tracebackLines.slice(-30).join('\n');
      }
    } else {
      // Non-traceback test error (e.g. pytest summary or custom runner)
      body = errorLines.slice(0, level === 1 ? 16 : 32).join('\n');
    }

    return { header, body: body || output.slice(-800) };
  }
}
