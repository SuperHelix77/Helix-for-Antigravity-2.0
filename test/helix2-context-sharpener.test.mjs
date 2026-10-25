import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Helix2ContextSharpener } from '../src/helix2-context-sharpener.mjs';
import { DeterministicMemory } from '../src/memory.mjs';

test('Helix2ContextSharpener evacuates context to SQLite memory and retrieves sharply', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-sharpener-test-'));
  const mem = new DeterministicMemory(tmpDir);
  const sharpener = new Helix2ContextSharpener({ memory: mem, stateDir: tmpDir });

  // Create a synthetic transcript with a directive and milestone checkpoint
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  const lines = [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'Please optimize latency and test speed in our codebase.' }),
    JSON.stringify({
      step_index: 1,
      type: 'CHECKPOINT',
      content: '[helix:archive] Sealed 12 steps of latency tests; raw in transcript_full.jsonl'
    }),
    JSON.stringify({ step_index: 2, type: 'USER_INPUT', content: 'Now investigate why tool latency was high.' })
  ];
  fs.writeFileSync(transcriptPath, lines.join('\n'));

  // 1. Evacuate stale context
  const evacuated = sharpener.evacuateStaleContext({
    transcriptPath,
    workspaceDir: tmpDir,
    conversationId: 'test-convo-123'
  });

  assert.ok(evacuated >= 1, 'Should have evacuated at least 1 item');

  // 2. Retrieve sharp context matching the query
  const retrieved = sharpener.retrieveSharpContext({
    workspaceDir: tmpDir,
    conversationId: 'test-convo-123',
    userPrompt: 'What was the result of latency and speed directive?'
  });

  assert.ok(retrieved.includes('[HELIX MEMORY (<25 tok)]'), 'Should format memory header');
  assert.ok(retrieved.includes('latency'), 'Should contain the evacuated directive');

  // 3. Shape PreInvocation
  const shaped = sharpener.shapePreInvocation({
    workspaceDir: tmpDir,
    transcriptPath,
    conversationId: 'test-convo-123',
    latestUserPrompt: 'What was the latency optimization?'
  });

  assert.ok(shaped.includes('[HELIX 2.0 PROTOCOL ACTIVATED - ZERO-BLOAT EPHEMERAL CONTEXT]'));
  assert.ok(shaped.includes('latency'));

  // 4. Test automated task complexity classification
  const c1 = sharpener.classifyTaskComplexity({ userPrompt: 'sitrep?' });
  assert.equal(c1.tier, 'MINIMAL');
  assert.ok(c1.guidance.includes('MINIMAL'));

  const c2 = sharpener.classifyTaskComplexity({
    userPrompt: 'Fix bug in widgets.py',
    astSnippet: '[HELIX UNIVERSAL 100% AST TARGET]\nFile: widgets.py'
  });
  assert.equal(c2.tier, 'SURGICAL');
  assert.ok(c2.guidance.includes('SURGICAL'));

  const c3 = sharpener.classifyTaskComplexity({
    userPrompt: 'Architect a distributed fault-tolerant raft consensus engine across 5 nodes with complex split-brain recovery scenarios'
  });
  assert.equal(c3.tier, 'DEEP');
  assert.ok(c3.guidance.includes('THOROUGH'));

  mem.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
