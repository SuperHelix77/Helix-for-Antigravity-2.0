#!/usr/bin/env node
import fs from 'node:fs';

const LEAN_TARGET_REGEX = /(?:npm\s+test|npx\s+test|node\s+--test|pytest|cargo\s+test|git\s+log|vitest|jest|make\s+test|mvn\s+test|gradle\s+test)/i;

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
  if (!toolCall || toolCall.name !== 'run_command' || !toolCall.args?.CommandLine) {
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
  const overwrittenCmd = `node ${leanRunner} lean -- ${cmd}`;

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
