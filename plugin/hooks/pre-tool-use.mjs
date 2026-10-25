#!/usr/bin/env node
import fs from 'node:fs';

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

  const toolCall = input.toolCall;
  if (!toolCall) {
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
    return;
  }

  // 1. Intercept read_file: bound unbounded reads to 300 lines max to prevent prompt dumps
  if (toolCall.name === 'read_file' && toolCall.args?.Path) {
    const args = toolCall.args;
    if (args.StartLine === undefined && args.EndLine === undefined) {
      process.stdout.write(JSON.stringify({
        decision: 'allow',
        overwrite: {
          StartLine: 1,
          EndLine: 300
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

  // If already wrapped or not a verbose target, allow as-is
  if (cmd.includes('helix.mjs lean') || cmd.startsWith('helix lean') || !LEAN_TARGET_REGEX.test(cmd)) {
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
    return;
  }

  // Wrap with Helix Lean Switch for 90%+ terminal output token compression
  const leanRunner = '/Users/mert/.gemini/antigravity/scratch/HELIX-1.0/bin/helix.mjs';
  // Safely escape and quote command to preserve compound chains (e.g. cd /dir && npm test)
  const escapedCmd = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const overwrittenCmd = `node "${leanRunner}" lean -- "${escapedCmd}"`;

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
