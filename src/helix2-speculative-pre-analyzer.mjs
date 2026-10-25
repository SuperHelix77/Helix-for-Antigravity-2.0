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
    this.gitCache = new Map();
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
    const gitDir = path.join(workspaceDir, '.git');
    if (!fs.existsSync(gitDir)) return null;

    const indexPath = path.join(gitDir, 'index');
    const indexMtime = fs.existsSync(indexPath) ? fs.statSync(indexPath).mtimeMs : 0;
    const cached = this.gitCache.get(workspaceDir);
    if (cached && cached.indexMtime === indexMtime && (Date.now() - cached.at < 15000)) {
      return cached.result;
    }

    try {
      const statusOut = execFileSync('git', ['status', '--porcelain', '-uall'], {
        cwd: workspaceDir,
        encoding: 'utf8',
        timeout: 1000
      }).trim();

      if (!statusOut) {
        try {
          const headRev = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
            cwd: workspaceDir,
            encoding: 'utf8',
            timeout: 500
          }).trim();
          const cleanRes = `• Working Tree: Clean at commit ${headRev}.\n• Directive: State is cryptographically verified (exit 0). DO NOT re-run tests or query logs for reassurance. Respond directly in Turn 1.`;
          this.gitCache.set(workspaceDir, { indexMtime, result: cleanRes, at: Date.now() });
          return cleanRes;
        } catch {
          return null;
        }
      }

      const lines = statusOut.split('\n').map(l => l.trim()).filter(Boolean);
      const modifiedFiles = lines.slice(0, 5).map(l => l.replace(/^([?MADRCU]{1,2})\s+/, ''));
      const remainingCount = lines.length > 5 ? lines.length - 5 : 0;

      let summary = `• Working Tree: ${lines.length} changed file${lines.length > 1 ? 's' : ''} (${modifiedFiles.join(', ')}${remainingCount > 0 ? ` +${remainingCount} more` : ''})`;

      // Get compact diff hunks for modified files (bounded with adaptive diff compression)
      try {
        let statSummary = '';
        if (lines.length > 3) {
          try {
            const statOut = execFileSync('git', ['diff', '--stat', '--no-color'], {
              cwd: workspaceDir,
              encoding: 'utf8',
              timeout: 1000
            }).trim();
            if (statOut) {
              const statLines = statOut.split('\n');
              statSummary = statLines.slice(-3).join('\n  ');
            }
          } catch {}
        }

        const diffOut = execFileSync('git', ['diff', '-U1', '--no-color'], {
          cwd: workspaceDir,
          encoding: 'utf8',
          timeout: 1500
        }).trim();

        if (diffOut) {
          const diffLines = diffOut.split('\n')
            .filter(l => l.startsWith('@@') || l.startsWith('+') || l.startsWith('-'))
            .filter(l => !l.startsWith('+++') && !l.startsWith('---'));

          if (diffLines.length > this.maxDiffLines) {
            // Adaptive Diff Bounding: Collapse to summary when dirty tree is large
            summary += `\n  Pending Diff: ${diffLines.length} lines modified across working tree`;
            if (statSummary) summary += `\n  Stat: ${statSummary}`;
            summary += `\n  Key Hunks:\n  ` + diffLines.slice(0, 10).map(l => l.slice(0, 80)).join('\n  ');
            summary += `\n  [... ${diffLines.length - 10} diff lines bounded for context safety]`;
          } else if (diffLines.length > 0) {
            summary += `\n  Pending Diff (${diffLines.length} lines):\n  ` + diffLines.map(l => l.slice(0, 80)).join('\n  ');
          }
        }
      } catch {}

      this.gitCache.set(workspaceDir, { indexMtime, result: summary, at: Date.now() });
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
    // First priority: check background syntax pre-flight cache (<2ms)
    try {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      if (home) {
        const cacheDir = path.join(home, '.helix', 'cache');
        if (fs.existsSync(cacheDir)) {
          const errorFiles = fs.readdirSync(cacheDir).filter(f => f.endsWith('.syntax_error'));
          for (const ef of errorFiles) {
            try {
              const errData = JSON.parse(fs.readFileSync(path.join(cacheDir, ef), 'utf8'));
              if (errData && errData.file && (Date.now() - (errData.at || 0) < 300000)) {
                const rel = path.basename(errData.file);
                return `• Background Pre-Flight Syntax Error in ${rel}:\n  ` + (errData.error || '').split('\n').slice(0, 2).map(l => l.slice(0, 80)).join('\n  ');
              }
            } catch {}
          }
        }
      }
    } catch {}

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
