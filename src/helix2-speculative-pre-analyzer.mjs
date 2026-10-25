import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Helix2AstIndexer } from './helix2-ast-indexer.mjs';

/**
 * Helix2SpeculativePreAnalyzer
 * 
 * Pre-computes code analysis, AST symbols, working tree diffs, and last-failure loci
 * BEFORE the model starts thinking during PreInvocation.
 * 
 * This eliminates the classic "thinking -> analyze -> thinking -> edit" ping-pong
 * by ensuring the model begins its invocation with the target code and diff already visible.
 */
export class Helix2SpeculativePreAnalyzer {
  constructor({ maxDiffLines = 30, maxLocusLines = 25 } = {}) {
    this.maxDiffLines = maxDiffLines;
    this.maxLocusLines = maxLocusLines;
    this.indexer = new Helix2AstIndexer();
  }

  /**
   * Pre-analyze workspace state, user prompt targets, and previous errors.
   */
  analyzeWorkspace({ workspaceDir, userPrompt = '', transcriptPath = null }) {
    if (!workspaceDir || !fs.existsSync(workspaceDir)) return null;

    const sections = [];

    // 1. Detect git working tree changes and active diff
    const gitInfo = this.#detectGitStatusAndDiff(workspaceDir);
    if (gitInfo) {
      sections.push(gitInfo);
    }

    // 2. Detect target files and symbols referenced in the prompt
    const targetLocus = this.#detectTargetSymbols(workspaceDir, userPrompt);
    if (targetLocus) {
      sections.push(targetLocus);
    }

    // 3. Detect recent tool failure or traceback in transcript
    const lastError = this.#detectLastToolFailure(transcriptPath);
    if (lastError) {
      sections.push(lastError);
    }

    if (sections.length === 0) return null;

    return `[HELIX SPECULATIVE PRE-ANALYSIS]\n${sections.join('\n')}`;
  }

  #detectGitStatusAndDiff(workspaceDir) {
    if (!fs.existsSync(path.join(workspaceDir, '.git'))) return null;

    try {
      const statusOut = execFileSync('git', ['status', '--porcelain', '-uall'], {
        cwd: workspaceDir,
        encoding: 'utf8',
        timeout: 1000
      }).trim();

      if (!statusOut) return null;

      const lines = statusOut.split('\n').map(l => l.trim()).filter(Boolean);
      const modifiedFiles = lines.slice(0, 5).map(l => l.replace(/^([?MADRCU]{1,2})\s+/, ''));
      const remainingCount = lines.length > 5 ? lines.length - 5 : 0;

      let summary = `• Working Tree: ${lines.length} changed file${lines.length > 1 ? 's' : ''} (${modifiedFiles.join(', ')}${remainingCount > 0 ? ` +${remainingCount} more` : ''})`;

      // Get compact diff hunks for modified files (capped at maxDiffLines)
      try {
        const diffOut = execFileSync('git', ['diff', '-U1', '--no-color'], {
          cwd: workspaceDir,
          encoding: 'utf8',
          timeout: 1500
        }).trim();

        if (diffOut) {
          const diffLines = diffOut.split('\n')
            .filter(l => l.startsWith('@@') || l.startsWith('+') || l.startsWith('-'))
            .filter(l => !l.startsWith('+++') && !l.startsWith('---'))
            .slice(0, this.maxDiffLines);

          if (diffLines.length > 0) {
            summary += `\n  Pending Diff (${diffLines.length} lines):\n  ` + diffLines.map(l => l.slice(0, 80)).join('\n  ');
          }
        }
      } catch {}

      return summary;
    } catch {
      return null;
    }
  }

  #detectTargetSymbols(workspaceDir, userPrompt) {
    if (!userPrompt || typeof userPrompt !== 'string') return null;

    // Find file paths mentioned in the prompt (e.g. src/foo.mjs, test/bar.test.mjs)
    const fileMatches = userPrompt.match(/\b(?:[\w.-]+\/)+[\w.-]+\.(?:mjs|js|ts|py|json|md)\b/g) || [];
    const directFiles = userPrompt.match(/\b[\w.-]+\.(?:mjs|js|ts|py|json)\b/g) || [];
    const candidateFiles = Array.from(new Set([...fileMatches, ...directFiles]));

    for (const relFile of candidateFiles) {
      const fullPath = path.resolve(workspaceDir, relFile);
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        try {
          // If a specific symbol is also mentioned (class or function name)
          const symbolMatches = userPrompt.match(/\b[A-Z][a-zA-Z0-9_]{3,}\b|\b[a-z][a-zA-Z0-9_]{3,}(?=\()/g) || [];
          for (const sym of symbolMatches) {
            const locus = this.indexer.extractSymbol(fullPath, sym);
            if (locus) {
              const codeLines = locus.code.split('\n').slice(0, this.maxLocusLines);
              return `• Target Locus: ${locus.symbol} [lines ${locus.startLine}-${locus.endLine} in ${relFile}]:\n  ` + codeLines.map(l => l.slice(0, 90)).join('\n  ');
            }
          }

          // If no specific symbol matched, extract top definitions or first 15 lines
          const content = fs.readFileSync(fullPath, 'utf8');
          const lines = content.split('\n').slice(0, 15);
          return `• Target File: ${relFile} (${lines.length} initial lines):\n  ` + lines.map(l => l.slice(0, 90)).join('\n  ');
        } catch {}
      }
    }

    return null;
  }

  #detectLastToolFailure(transcriptPath) {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

    try {
      const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n');
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 6); i--) {
        try {
          const item = JSON.parse(lines[i]);
          if (item.type === 'PLANNER_RESPONSE') {
            const content = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
            if (content.includes('Command exited with code') && !content.includes('code 0')) {
              const match = content.match(/Command exited with code (\d+)/);
              const exitCode = match ? match[1] : '1';
              // Extract error line or failure summary
              const errorLines = content.split('\n')
                .filter(l => /(?:error|failed|exception|assertion|cannot find|enoent)/i.test(l))
                .slice(0, 3);
              return `• Last Command Failure (exit ${exitCode}):\n  ` + errorLines.map(l => l.slice(0, 80)).join('\n  ');
            }
          }
        } catch {}
      }
    } catch {}

    return null;
  }
}
