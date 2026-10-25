import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Helix2ContextSharpener } from '../src/helix2-context-sharpener.mjs';
import { HelixLeanSwitch } from '../src/helix-lean-switch.mjs';
import { DeterministicMemory } from '../src/memory.mjs';

test('Red Team Guard: Secrets are redacted from SQLite memory and Lean Switch receipts', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-leak-test-'));
  const mem = new DeterministicMemory(tmpDir);
  const sharpener = new Helix2ContextSharpener({ memory: mem, stateDir: tmpDir });

  // 1. Test SQLite Memory Evacuation Secret Redaction
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  const sensitiveCmd = 'curl -H "Authorization: Bearer my-secret-jwt-token" https://api.openai.com/v1 -d "api_key=sk-1234567890abcdef"';
  
  fs.writeFileSync(transcriptPath, JSON.stringify({
    step_index: 0,
    type: 'USER_INPUT',
    content: `Run curl with secret: ${sensitiveCmd}`
  }) + '\n' + JSON.stringify({
    step_index: 1,
    type: 'USER_INPUT',
    content: 'Check the result'
  }));

  sharpener.evacuateStaleContext({
    transcriptPath,
    workspaceDir: tmpDir,
    conversationId: 'convo-leak-audit'
  });

  // Query memory directly
  const notes = mem.search({ project: path.basename(tmpDir), query: 'curl', limit: 5 });
  assert.ok(notes.length > 0, 'Memory note should exist');
  for (const n of notes) {
    assert.ok(!n.title.includes('my-secret-jwt-token'), 'JWT token must be redacted from title');
    assert.ok(!n.title.includes('sk-1234567890abcdef'), 'API key must be redacted from title');
    assert.ok(!n.body.includes('my-secret-jwt-token'), 'JWT token must be redacted from body');
    assert.ok(!n.body.includes('sk-1234567890abcdef'), 'API key must be redacted from body');
    assert.ok(n.body.includes('[REDACTED]'), 'Body must contain [REDACTED]');
  }

  // 2. Test Lean Switch Secret Redaction in Visible Receipts
  const lean = new HelixLeanSwitch({ directory: path.join(tmpDir, 'programs') });
  const rawOutputWithSecret = 'Error: Authentication failed with api_key=sk-abcdef1234567890 and Bearer eyJhbGciOiJIUzI1NiJ9\nStack trace:\nline 10 at auth.js';
  const shaped = lean.shapeCommandOutput(rawOutputWithSecret, {
    command: 'npm test -- --token=my-secret-token',
    exitCode: 1,
    toolName: 'run_command'
  });

  assert.ok(!shaped.output.includes('sk-abcdef1234567890'), 'API key must not leak in shaped output');
  assert.ok(!shaped.output.includes('eyJhbGciOiJIUzI1NiJ9'), 'Bearer token must not leak in shaped output');
  assert.ok(shaped.output.includes('[REDACTED]'), 'Shaped output must show [REDACTED]');

  // 3. Test Cross-Project Memory Isolation
  const sharpenerGeneric1 = new Helix2ContextSharpener({ memory: mem, stateDir: tmpDir });
  sharpenerGeneric1.evacuateStaleContext({
    transcriptPath,
    workspaceDir: '/',
    conversationId: 'convo-session-A'
  });

  const recalledForSessionB = sharpenerGeneric1.retrieveSharpContext({
    workspaceDir: '/',
    conversationId: 'convo-session-B',
    userPrompt: 'curl command'
  });

  assert.equal(recalledForSessionB, '', 'Session B must not recall memories from Session A when no workspace is active');

  mem.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
