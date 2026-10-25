import { createHash } from 'node:crypto';
import { shapeToolResult } from './tool-result-aging.mjs';
import { retainToolResult, readRetainedToolResult } from './tool-result-store.mjs';
import { redactContextText } from './compaction-checkpoint.mjs';

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
    const isEnv = /\b(?:env|printenv|export)\b/i.test(command);
    if (rawBytes < this.minSavedBytes) {
      const safeOut = isEnv ? this.#summarizeEnvOutput(output) : redactContextText(output);
      return { output: safeOut, receipt: null, savedBytes: 0, rawBytes };
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
    } else if (isEnv) {
      leanText = this.#summarizeEnvOutput(output);
    } else {
      leanText = this.#summarizeGenericOutput(output);
    }

    const safeLeanText = isEnv ? leanText : redactContextText(leanText);
    const leanReceipt = [
      `${LEAN_SWITCH_RECEIPT_PREFIX} ${toolName} exit:${exitCode} raw:${rawBytes}B sha256:${digest.slice(0, 24)}; handle:${handle}]`,
      safeLeanText,
      `[Exact original retained in HELIX archive; view with: helix raw ${handle}]`
    ].join('\n');

    const shapedBytes = Buffer.byteLength(leanReceipt, 'utf8');
    const savedBytes = Math.max(0, rawBytes - shapedBytes);
    const finalOutput = savedBytes > 0 ? leanReceipt : (isEnv ? this.#summarizeEnvOutput(output) : redactContextText(output));

    return {
      output: finalOutput,
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
      `[Exact file content retained in HELIX archive; view with: helix raw ${handle}]`
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
      // Framework Stack Trace Pruning: Strip external plumbing (site-packages, node_modules)
      const isExternalPlumbing = l => /(?:site-packages|node_modules|dist-packages|\/usr\/lib\/python|\/lib\/node_modules|\/internal\/modules)/i.test(l);
      
      const relevantLines = [];
      let inTraceback = false;

      for (const line of lines) {
        if (/Traceback \(most recent call last\):/i.test(line)) {
          inTraceback = true;
          relevantLines.push(line);
          continue;
        }

        if (inTraceback) {
          if (isExternalPlumbing(line)) {
            // Drop external framework frame
            continue;
          }
          if (/\b(?:AssertionError|Exception|Error|TypeError|ValueError|IndexError|KeyError)\b/i.test(line)) {
            inTraceback = false;
            relevantLines.push(line);
            continue;
          }
          if (/^\s*File\s+/i.test(line) || /^\s+at\s+/i.test(line)) {
            relevantLines.push(line);
          } else if (line.trim().length > 0 && relevantLines.length < 15) {
            relevantLines.push(line);
          }
        } else if (/\b(FAIL|ERROR|AssertionError|Exception|SyntaxError)\b/i.test(line)) {
          if (!isExternalPlumbing(line)) {
            relevantLines.push(line);
          }
        }
      }

      const displayErrors = relevantLines.length > 0 ? relevantLines.slice(0, 12) : lines.filter(l => !isExternalPlumbing(l)).slice(0, 10);
      return [...displayErrors, '--- test status ---', ...summaryLines].join('\n');
    }

    return summaryLines.length ? summaryLines.join('\n') : `Exit code ${exitCode}; ${lines.length} lines executed.`;
  }

  #summarizeGitOutput(output) {
    const lines = output.split('\n');
    // Check if git status
    const isStatus = lines.some(l => /On branch|Changes to be committed|Changes not staged|Untracked files/i.test(l));
    if (isStatus) {
      const statusLines = lines.filter(l => /modified:|new file:|deleted:|untracked/i.test(l) || /On branch/i.test(l));
      if (statusLines.length > 15) {
        return `${statusLines[0]}\nModified/Untracked: ${statusLines.length - 1} files\n` + statusLines.slice(1, 10).join('\n') + `\n[... ${statusLines.length - 10} files omitted; see raw]`;
      }
      return statusLines.join('\n');
    }

    // Git diff
    const fileHeaders = lines.filter(l => /^diff --git|^--- |^\+\+\+ |@@/i.test(l));
    if (fileHeaders.length) {
      const files = lines.filter(l => /^diff --git/i.test(l)).map(l => l.replace(/^diff --git\//, '').replace(/ b\/.*$/, ''));
      if (lines.length > 40) {
        // Multi-file or large diff: summarize files and hunks
        return `Modified ${files.length} file(s): ${files.slice(0, 5).join(', ')}${files.length > 5 ? '...' : ''}\n` +
          fileHeaders.slice(0, 12).join('\n') +
          `\n[... Diff truncated for context safety (${lines.length} lines); exact diff in raw]`;
      }
      return output;
    }
    return lines.slice(0, 12).join('\n');
  }

  #summarizeEnvOutput(output) {
    const lines = output.split('\n');
    const sanitized = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      // Redact sensitive credentials, secrets, tokens, and keys
      if (/(=|\b)(?:[A-Za-z0-9_-]*(?:KEY|SECRET|TOKEN|PASS|AUTH|CREDENTIAL|PRIVATE)[A-Za-z0-9_-]*)=/i.test(line)) {
        const key = line.split('=')[0];
        sanitized.push(`${key}=[REDACTED_SECRET]`);
      } else {
        sanitized.push(line);
      }
    }
    if (sanitized.length <= this.maxPreviewLines) {
      return sanitized.join('\n');
    }
    const preview = [
      ...sanitized.slice(0, Math.floor(this.maxPreviewLines / 2)),
      `[... ${sanitized.length - this.maxPreviewLines} environment variables bounded for context safety; view full in raw ...]`,
      ...sanitized.slice(-Math.floor(this.maxPreviewLines / 2))
    ];
    return preview.join('\n');
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
