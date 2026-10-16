import { createHash } from 'node:crypto';
import { shapeToolResult } from './tool-result-aging.mjs';
import { retainToolResult, readRetainedToolResult } from './tool-result-store.mjs';

export const LEAN_SWITCH_RECEIPT_PREFIX = '[HELIX Lean Switch:';

/**
 * HelixLeanSwitch provides deterministic frontier shaping and compact receipts
 * for coding agent operations, moving mechanical verbosity out of the model's
 * reasoning context while keeping 100% of the original content recoverable on demand.
 */
export class HelixLeanSwitch {
  constructor({ directory, retain, recover, maxPreviewLines = 16, minSavedBytes = 256, enabled = true } = {}) {
    this.directory = directory;
    this.retain = retain || (text => retainToolResult(text, { directory: this.directory, ttlMs: 0 }));
    this.recover = recover || (handle => readRetainedToolResult(handle, { directory: this.directory }));
    this.maxPreviewLines = maxPreviewLines;
    this.minSavedBytes = minSavedBytes;
    this.enabled = enabled;
  }

  /**
   * Shapes a command or test result into a compact representation.
   * If savings are achieved, returns the compact receipt and retains the original.
   * Otherwise returns the unmodified original.
   */
  shapeCommandOutput(output, { command = '', exitCode = 0, toolName = 'run_command' } = {}) {
    if (!this.enabled || typeof output !== 'string' || !output) {
      return { output, receipt: null, savedBytes: 0, rawBytes: output ? Buffer.byteLength(output, 'utf8') : 0 };
    }
    const rawBytes = Buffer.byteLength(output, 'utf8');
    if (rawBytes < this.minSavedBytes) {
      return { output, receipt: null, savedBytes: 0, rawBytes };
    }

    const digest = createHash('sha256').update(output, 'utf8').digest('hex');
    const handle = this.retain(output);

    // Verify round-trip recovery immediately; fail closed if integrity fails
    if (this.recover(handle) !== output) {
      throw new Error('Lean switch archive recovery failed');
    }

    const isTest = /(?:pytest|test|runtests|jest|mocha|unittest)/i.test(command);
    const isGit = /(?:git\s+diff|git\s+status|git\s+log)/i.test(command);

    let leanText = '';
    if (isTest) {
      leanText = this.#summarizeTestOutput(output, exitCode);
    } else if (isGit) {
      leanText = this.#summarizeGitOutput(output);
    } else {
      leanText = this.#summarizeGenericOutput(output);
    }

    const leanReceipt = [
      `${LEAN_SWITCH_RECEIPT_PREFIX} ${toolName} exit:${exitCode} raw:${rawBytes}B sha256:${digest.slice(0, 24)}; handle:${handle}]`,
      leanText,
      `[Exact original retained in HELIX archive; retrieve with context raw receipt ${handle}]`
    ].join('\n');

    const shapedBytes = Buffer.byteLength(leanReceipt, 'utf8');
    const savedBytes = Math.max(0, rawBytes - shapedBytes);

    return {
      output: savedBytes > 0 ? leanReceipt : output,
      receipt: handle,
      digest,
      savedBytes,
      rawBytes,
      shapedBytes: savedBytes > 0 ? shapedBytes : rawBytes
    };
  }

  /**
   * Shapes a file view or read result into a compact representation with line metrics.
   */
  shapeFileContent(filePath, content, { startLine = 1, endLine = null } = {}) {
    if (!this.enabled || typeof content !== 'string' || !content) {
      return { content, receipt: null, savedBytes: 0 };
    }
    const rawBytes = Buffer.byteLength(content, 'utf8');
    if (rawBytes < this.minSavedBytes) {
      return { content, receipt: null, savedBytes: 0 };
    }

    const digest = createHash('sha256').update(content, 'utf8').digest('hex');
    const handle = this.retain(content);

    if (this.recover(handle) !== content) {
      throw new Error('Lean switch archive recovery failed for file content');
    }

    const lines = content.split('\n');
    const totalLines = lines.length;
    const preview = lines.length <= this.maxPreviewLines
      ? content
      : [
          ...lines.slice(0, Math.floor(this.maxPreviewLines / 2)),
          `[... ${lines.length - this.maxPreviewLines} lines omitted by Lean Switch ...]`,
          ...lines.slice(-Math.floor(this.maxPreviewLines / 2))
        ].join('\n');

    const receipt = [
      `${LEAN_SWITCH_RECEIPT_PREFIX} file:${filePath} lines:${totalLines} (${rawBytes}B) sha256:${digest.slice(0, 24)}; handle:${handle}]`,
      preview,
      `[Exact file content retained in HELIX archive; retrieve with context raw receipt ${handle}]`
    ].join('\n');

    const shapedBytes = Buffer.byteLength(receipt, 'utf8');
    const savedBytes = Math.max(0, rawBytes - shapedBytes);

    return {
      content: savedBytes > 0 ? receipt : content,
      receipt: handle,
      digest,
      savedBytes,
      rawBytes,
      shapedBytes: savedBytes > 0 ? shapedBytes : rawBytes
    };
  }

  #summarizeTestOutput(output, exitCode) {
    const lines = output.split('\n');
    const summaryLines = [];
    
    // Look for test summary line (e.g. "12 passed in 1.4s" or "FAILED (failures=1)")
    for (let i = lines.length - 1; i >= 0 && summaryLines.length < 4; i--) {
      const line = lines[i].trim();
      if (/passed|failed|error|skipped|warnings?|===|FAILED|OK/i.test(line) && line.length > 0) {
        summaryLines.unshift(line);
      }
    }

    if (exitCode !== 0) {
      const errorLines = lines.filter(l => /\b(FAIL|ERROR|AssertionError|Exception|Traceback|SyntaxError)\b/i.test(l)).slice(0, 10);
      return [...errorLines, '--- test status ---', ...summaryLines].join('\n');
    }

    return summaryLines.length ? summaryLines.join('\n') : `Exit code ${exitCode}; ${lines.length} lines executed.`;
  }

  #summarizeGitOutput(output) {
    const lines = output.split('\n');
    const fileHeaders = lines.filter(l => /^diff --git|^--- |^\+\+\+ |@@/i.test(l));
    if (fileHeaders.length) {
      const files = lines.filter(l => /^diff --git/i.test(l)).map(l => l.replace(/^diff --git a\//, '').replace(/ b\/.*$/, ''));
      return `Modified ${files.length} file(s): ${files.join(', ')}\n` + fileHeaders.slice(0, 12).join('\n');
    }
    return lines.slice(0, 10).join('\n');
  }

  #summarizeGenericOutput(output) {
    const shaped = shapeToolResult(output);
    const lines = shaped.split('\n');
    if (lines.length <= this.maxPreviewLines) return shaped;
    return [
      ...lines.slice(0, Math.floor(this.maxPreviewLines / 2)),
      `[... ${lines.length - this.maxPreviewLines} lines omitted by Lean Switch ...]`,
      ...lines.slice(-Math.floor(this.maxPreviewLines / 2))
    ].join('\n');
  }
}
