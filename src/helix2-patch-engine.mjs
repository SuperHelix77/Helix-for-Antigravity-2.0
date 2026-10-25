import fs from 'node:fs';
import path from 'node:path';

/**
 * Helix2PatchEngine
 * 
 * High-performance, zero-dependency atomic unified diff patch engine.
 * Applies multi-file patches in memory before committing to disk.
 * Supports rollback on test failure for zero-risk refactoring in 1 turn.
 */
export class Helix2PatchEngine {
  constructor() {}

  /**
   * Parse a unified diff string into structured file patch specifications.
   */
  parsePatch(patchText) {
    if (!patchText || typeof patchText !== 'string') {
      return [];
    }

    const files = [];
    const lines = patchText.replace(/\r\n/g, '\n').split('\n');
    let currentFile = null;
    let currentHunk = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('--- ')) {
        const fileA = line.slice(4).trim().replace(/^[ab]\//, '');
        // Next line usually +++
        const nextLine = lines[i + 1] || '';
        let fileB = fileA;
        if (nextLine.startsWith('+++ ')) {
          fileB = nextLine.slice(4).trim().replace(/^[ab]\//, '');
          i++; // skip +++ line
        }
        const targetPath = fileB === '/dev/null' ? fileA : fileB;
        currentFile = {
          file: targetPath,
          hunks: []
        };
        files.push(currentFile);
        currentHunk = null;
      } else if (line.startsWith('@@ ') && currentFile) {
        const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (match) {
          currentHunk = {
            oldStart: parseInt(match[1], 10),
            oldLines: parseInt(match[2] ?? '1', 10),
            newStart: parseInt(match[3], 10),
            newLines: parseInt(match[4] ?? '1', 10),
            lines: []
          };
          currentFile.hunks.push(currentHunk);
        }
      } else if (currentHunk) {
        if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line === '') {
          currentHunk.lines.push(line);
        }
      }
    }

    return files;
  }

  /**
   * Applies unified diff patch atomically across all target files.
   */
  applyPatch(projectDir, patchText, { dryRun = false } = {}) {
    const cwd = path.resolve(projectDir);
    const parsedFiles = this.parsePatch(patchText);

    if (parsedFiles.length === 0) {
      return { success: false, error: 'No valid unified diff hunks found in patch' };
    }

    const backups = new Map();
    const plannedWrites = [];

    // Stage 1: Validation and in-memory application
    for (const filePatch of parsedFiles) {
      const targetPath = path.resolve(cwd, filePatch.file);
      if (!fs.existsSync(targetPath)) {
        return { success: false, error: `Target file not found: ${filePatch.file}` };
      }

      const originalContent = fs.readFileSync(targetPath, 'utf8');
      backups.set(targetPath, originalContent);

      const patched = this.#applyHunksToFile(originalContent, filePatch.hunks, filePatch.file);
      if (!patched.success) {
        return { success: false, error: patched.error, file: filePatch.file };
      }

      plannedWrites.push({ targetPath, content: patched.content, relFile: filePatch.file });
    }

    if (dryRun) {
      return { success: true, filesModified: plannedWrites.map(w => w.relFile), dryRun: true };
    }

    // Stage 2: Write all modified files to disk
    try {
      for (const { targetPath, content } of plannedWrites) {
        fs.writeFileSync(targetPath, content, 'utf8');
      }
      return {
        success: true,
        filesModified: plannedWrites.map(w => w.relFile),
        backups
      };
    } catch (e) {
      // Revert any partially written files
      this.revertPatch(backups);
      return { success: false, error: `Failed to write patch: ${e.message}` };
    }
  }

  /**
   * Revert modified files using in-memory backup map.
   */
  revertPatch(backups) {
    if (!backups) return;
    for (const [filePath, content] of backups.entries()) {
      try {
        fs.writeFileSync(filePath, content, 'utf8');
      } catch {}
    }
  }

  #applyHunksToFile(originalContent, hunks, fileName) {
    let lines = originalContent.split(/\r?\n/);

    for (let hIdx = 0; hIdx < hunks.length; hIdx++) {
      const hunk = hunks[hIdx];
      // Locate the match point starting near oldStart - 1
      let startIdx = Math.max(0, hunk.oldStart - 1);

      // Verify and find exact alignment
      const expectedOld = hunk.lines.filter(l => l.startsWith(' ') || l.startsWith('-')).map(l => l.slice(1));
      let matchIdx = -1;

      // Check at nominal startIdx
      if (this.#matchesAt(lines, startIdx, expectedOld)) {
        matchIdx = startIdx;
      } else {
        // Scan within a +/- 20 line window
        const minIdx = Math.max(0, startIdx - 20);
        const maxIdx = Math.min(lines.length - expectedOld.length, startIdx + 20);
        for (let i = minIdx; i <= maxIdx; i++) {
          if (this.#matchesAt(lines, i, expectedOld)) {
            matchIdx = i;
            break;
          }
        }
      }

      if (matchIdx === -1) {
        return {
          success: false,
          error: `Hunk #${hIdx + 1} failed to match in ${fileName} near line ${hunk.oldStart}`
        };
      }

      // Reconstruct lines replacement
      const newLines = [];
      for (const line of hunk.lines) {
        if (line.startsWith(' ') || line.startsWith('+')) {
          newLines.push(line.slice(1));
        }
      }

      lines.splice(matchIdx, expectedOld.length, ...newLines);
    }

    return { success: true, content: lines.join('\n') };
  }

  #matchesAt(lines, index, expected) {
    if (index + expected.length > lines.length) return false;
    for (let i = 0; i < expected.length; i++) {
      if (lines[index + i] !== expected[i]) return false;
    }
    return true;
  }
}
