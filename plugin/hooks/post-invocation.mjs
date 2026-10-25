#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const candidateBreakers = [
  path.resolve(currentDir, '../src/helix2-engine-circuit-breaker.mjs'),
  path.resolve(currentDir, '../../src/helix2-engine-circuit-breaker.mjs'),
  '/Users/mert/.gemini/antigravity/scratch/HELIX-1.0/src/helix2-engine-circuit-breaker.mjs'
];
const breakerPath = candidateBreakers.find(p => fs.existsSync(p)) || candidateBreakers[0];

/**
 * Helix PostInvocation Hook
 *
 * This is the ENGINE-LEVEL enforcement of the 1-flow rule.
 * It hard-caps the number of model invocations (thinking blocks)
 * per user turn by returning { terminationBehavior: "terminate" }.
 *
 * Why here and not PreToolUse?
 *   PreToolUse can only deny/modify individual tool calls.
 *   Denying a tool call ADDS a thinking turn (the model re-plans).
 *   PostInvocation terminates the LOOP, preventing further invocations entirely.
 */
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
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const conversationId = input.conversationId || input.conversation_id
    || process.env.CONVERSATION_ID || process.env.ANTIGRAVITY_CONVERSATION_ID || 'default';
  const invocationNum = input.invocationNum ?? 0;

  try {
    const { Helix2EngineCircuitBreaker } = await import(breakerPath);
    const breaker = new Helix2EngineCircuitBreaker();
    const result = breaker.checkPostInvocation({ conversationId, invocationNum });

    if (result && result.terminationBehavior) {
      process.stdout.write(JSON.stringify(result));
      return;
    }
  } catch {}

  process.stdout.write(JSON.stringify({}));
}

main().catch(() => {
  process.stdout.write(JSON.stringify({}));
});
