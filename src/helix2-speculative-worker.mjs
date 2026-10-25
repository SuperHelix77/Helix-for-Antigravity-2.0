import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

/**
 * Helix2SpeculativeWorker
 * 
 * Implements Concurrent Speculative Execution (CSE):
 * Runs toolflows and targeted test verifications on the host IN PARALLEL
 * while the model is in its remote inference / thinking phase.
 * 
 * Also enforces the Single-Pass Reassurance Guard:
 * Blocks compulsive duplicate verification runs when the git revision is clean and verified.
 */
export class Helix2SpeculativeWorker {
  constructor({ cacheDir } = {}) {
    this.cacheDir = cacheDir || path.join(os.homedir(), '.helix', 'cache');
    try { fs.mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 }); } catch {}
  }

  /**
   * Evaluate if a command is a redundant reassurance run on an already-verified, clean workspace.
   */
  checkReassuranceGuard(command, workspaceDir) {
    if (!command || !workspaceDir || !fs.existsSync(path.join(workspaceDir, '.git'))) {
      return { block: false };
    }

    // Only guard read-only verification / test commands
    const isVerificationTarget = /(?:npm\s+test|node\s+--test|pytest|cargo\s+test|vitest|jest)/i.test(command);
    if (!isVerificationTarget) {
      return { block: false };
    }

    try {
      // 1. Check if tracked git files are 100% clean
      const status = execFileSync('git', ['status', '--porcelain', '-uno'], {
        cwd: workspaceDir,
        encoding: 'utf8',
        timeout: 800
      }).trim();

      if (status.length > 0) {
        // Dirty files exist: verification is legitimate, do not block
        return { block: false };
      }

      // 2. Check if this exact command passed previously on the current HEAD
      const headRev = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: workspaceDir,
        encoding: 'utf8',
        timeout: 500
      }).trim();

      const cmdHash = createHash('sha256').update(command.trim()).digest('hex').slice(0, 16);
      const receiptFile = path.join(this.cacheDir, `verified_${headRev.slice(0, 12)}_${cmdHash}.json`);

      if (fs.existsSync(receiptFile)) {
        const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
        if (receipt && receipt.exitCode === 0) {
          return {
            block: true,
            receipt: `[HELIX Single-Pass Guard: Command '${command.slice(0, 40)}' already verified exit:0 on commit ${headRev.slice(0, 8)}; reassurance run skipped (0ms)]`
          };
        }
      }
    } catch (e) {
      // console.error('GUARD ERROR:', e.message);
    }

    return { block: false };
  }

  /**
   * Record a verified command pass on the current HEAD commit.
   */
  recordVerifiedPass(command, workspaceDir, exitCode = 0) {
    if (exitCode !== 0 || !workspaceDir || !fs.existsSync(path.join(workspaceDir, '.git'))) return;

    try {
      const headRev = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: workspaceDir,
        encoding: 'utf8',
        timeout: 500
      }).trim();

      const cmdHash = createHash('sha256').update(command.trim()).digest('hex').slice(0, 16);
      const receiptFile = path.join(this.cacheDir, `verified_${headRev.slice(0, 12)}_${cmdHash}.json`);
      fs.writeFileSync(receiptFile, JSON.stringify({
        command,
        headRev,
        exitCode,
        verifiedAt: Date.now()
      }), 'utf8');
    } catch {}
  }

  /**
   * Launch a background speculative task during PreInvocation while the model is thinking.
   */
  launchSpeculativePreFlight({ workspaceDir, userPrompt, conversationId }) {
    if (!workspaceDir || !userPrompt) return null;

    const lower = userPrompt.toLowerCase();
    const isTestIntent = /\b(?:test|check|verify|work|works|working|status|diff)\b/i.test(lower);
    if (!isTestIntent) return null;

    try {
      const specId = conversationId ? conversationId.slice(0, 16) : 'default';
      const specResultFile = path.join(this.cacheDir, `spec_${specId}.json`);

      // Determine the most targeted speculative command
      let targetCmd = null;
      if (fs.existsSync(path.join(workspaceDir, 'package.json'))) {
        targetCmd = 'node --check package.json';
      }

      if (!targetCmd) return null;

      // Spawn non-blocking background speculative execution
      const child = spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', [process.platform === 'win32' ? '/c' : '-c', targetCmd], {
        cwd: workspaceDir,
        detached: true,
        stdio: 'ignore'
      });
      child.unref();

      return { launched: true, command: targetCmd };
    } catch {
      return null;
    }
  }
}
