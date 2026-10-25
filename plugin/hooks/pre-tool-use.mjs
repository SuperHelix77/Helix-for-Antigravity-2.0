#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const candidateRunners = [
  path.resolve(currentDir, '../../bin/helix.mjs'),
  '/Users/mert/.gemini/antigravity/scratch/HELIX-1.0/bin/helix.mjs',
  path.join(os.homedir(), '.gemini/antigravity/bin/helix')
];
const leanRunner = candidateRunners.find(p => fs.existsSync(p)) || 'helix';

const LEAN_TARGET_REGEX = /(?:npm\s+(?:test|run\s+build|install|ci)|npx\s+(?:test|build)|node\s+--test|pytest|cargo\s+(?:test|build)|git\s+log|vitest|jest|make\s+(?:test|build)|mvn\s+(?:test|compile)|gradle\s+(?:test|build)|vite\s+build|tsc\b)/i;

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  let input = {};
  try {
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (raw) input = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
    return;
  }

  const workspacePaths = input.workspacePaths || [];
  const workspaceDir = workspacePaths[0] || process.cwd();

  const toolCall = input.toolCall;
  if (!toolCall) {
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
    return;
  }

  // 1. Intercept read_file: bound reads to 300 lines max to prevent prompt dumps
  if (toolCall.name === 'read_file' && toolCall.args?.Path) {
    const args = toolCall.args;
    const start = typeof args.StartLine === 'number' ? args.StartLine : (args.StartLine ? parseInt(args.StartLine, 10) : 1);
    const end = typeof args.EndLine === 'number' ? args.EndLine : (args.EndLine ? parseInt(args.EndLine, 10) : null);
    
    if (end === null) {
      process.stdout.write(JSON.stringify({
        decision: 'allow',
        overwrite: {
          StartLine: start,
          EndLine: start + 299
        }
      }));
      return;
    } else if (end - start > 350) {
      process.stdout.write(JSON.stringify({
        decision: 'allow',
        overwrite: {
          EndLine: start + 300
        }
      }));
      return;
    }
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
    return;
  }

  // 2. Intercept verbose terminal commands with Lean Switch
  if (toolCall.name !== 'run_command' || !toolCall.args?.CommandLine) {
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
    return;
  }

  const cmd = toolCall.args.CommandLine.trim();

  // 1.5 Reassurance Guard: block redundant verification runs if working tree is clean and already verified (<2ms)
  try {
    const { Helix2SpeculativeWorker } = await import('/Users/mert/.gemini/antigravity/scratch/HELIX-1.0/src/helix2-speculative-worker.mjs');
    const worker = new Helix2SpeculativeWorker();
    const guard = worker.checkReassuranceGuard(cmd, workspaceDir);
    if (guard.block) {
      process.stdout.write(JSON.stringify({
        decision: 'allow',
        overwrite: {
          CommandLine: `echo "${guard.receipt.replace(/"/g, '\\"')}"`
        }
      }));
      return;
    }
  } catch {}

  // If already wrapped or not a verbose target, allow as-is
  if (cmd.includes('helix.mjs lean') || cmd.startsWith('helix lean') || !LEAN_TARGET_REGEX.test(cmd)) {
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
    return;
  }

  // Wrap with Helix Lean Switch for 90%+ terminal output token compression
  const isWin = process.platform === 'win32';
  const escapedCmd = isWin
    ? cmd.replace(/"/g, '""')
    : cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const overwrittenCmd = isWin
    ? `node "${path.normalize(leanRunner)}" lean -- ${cmd}`
    : `node "${leanRunner}" lean -- "${escapedCmd}"`;

  const output = {
    decision: 'allow',
    overwrite: {
      CommandLine: overwrittenCmd
    }
  };

  process.stdout.write(JSON.stringify(output));
}

main().catch(() => {
  process.stdout.write(JSON.stringify({ decision: 'allow' }));
});
