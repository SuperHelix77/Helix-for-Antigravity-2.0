#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const candidateRunners = [
  path.resolve(currentDir, '../bin/helix.mjs'),
  path.resolve(currentDir, '../../bin/helix.mjs'),
  '/Users/mert/.gemini/antigravity/scratch/HELIX-1.0/bin/helix.mjs',
  path.join(os.homedir(), '.gemini/antigravity/bin/helix')
];
const leanRunner = candidateRunners.find(p => fs.existsSync(p)) || 'helix';

const candidateBreakers = [
  path.resolve(currentDir, '../src/helix2-engine-circuit-breaker.mjs'),
  path.resolve(currentDir, '../../src/helix2-engine-circuit-breaker.mjs'),
  '/Users/mert/.gemini/antigravity/scratch/HELIX-1.0/src/helix2-engine-circuit-breaker.mjs'
];
const breakerPath = candidateBreakers.find(p => fs.existsSync(p)) || candidateBreakers[0];

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
  const conversationId = input.conversationId || input.conversation_id || process.env.CONVERSATION_ID || process.env.ANTIGRAVITY_CONVERSATION_ID || 'default';

  const toolCall = input.toolCall;
  if (!toolCall) {
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
    return;
  }

  // Engine-Level Circuit Breaker Enforcement
  try {
    const { Helix2EngineCircuitBreaker } = await import(breakerPath);
    const breaker = new Helix2EngineCircuitBreaker();
    const result = breaker.checkPreToolUse({
      toolCall,
      workspaceDir,
      conversationId,
      leanRunner
    });

    if (result) {
      process.stdout.write(JSON.stringify(result));
      return;
    }
  } catch {}

  // Fallback: allow
  process.stdout.write(JSON.stringify({ decision: 'allow' }));
}

main().catch(() => {
  process.stdout.write(JSON.stringify({ decision: 'allow' }));
});
