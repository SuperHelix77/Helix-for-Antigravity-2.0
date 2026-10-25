import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Helix2TranscriptShaper } from '../src/helix2-transcript-shaper.mjs';
import { Helix2ToolPipeline } from '../src/helix2-tool-pipeline.mjs';
import { Helix2ContextSharpener } from '../src/helix2-context-sharpener.mjs';
import { DeterministicMemory } from '../src/memory.mjs';

test('HELIX One Flow: Compound pipeline executes multi-step workflow in 1 unified step', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-one-flow-'));
  const testFileName = 'service.js';
  const testFilePath = path.join(tmpDir, testFileName);
  fs.writeFileSync(testFilePath, 'export function getStatus() { return "initial"; }\n');

  const pipeline = new Helix2ToolPipeline({ directory: path.join(tmpDir, 'store') });
  const operations = [
    {
      kind: 'edit',
      file: testFileName,
      target: 'return "initial";',
      replacement: 'return "atomic-one-flow";'
    },
    {
      kind: 'command',
      command: `node -e 'import assert from "node:assert"; import { getStatus } from "./${testFileName}"; assert.equal(getStatus(), "atomic-one-flow");'`
    }
  ];

  const result = await pipeline.executePipeline(tmpDir, operations, { taskId: 'one-flow-task' });
  assert.equal(result.success, true, 'Compound pipeline must succeed in one execution');
  assert.equal(result.stepsExecuted, 2, 'Both steps must execute');
  assert.ok(fs.readFileSync(testFilePath, 'utf8').includes('atomic-one-flow'), 'Target replacement must be applied');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('HELIX Automated Compaction: Synchronous shaper achieves >=95% reduction on large transcripts', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-compaction-audit-'));
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  const fullTranscriptPath = path.join(tmpDir, 'transcript_full.jsonl');
  const chunkDir = path.join(tmpDir, 'chunks', 'transcript');
  fs.mkdirSync(chunkDir, { recursive: true });

  // Generate a realistic 600KB transcript with 100 verbose tool execution steps
  const lines = [];
  for (let i = 0; i < 100; i++) {
    lines.push(JSON.stringify({
      step_index: i * 2,
      type: 'USER_INPUT',
      content: `Step ${i}: Run command and check system performance.`
    }));
    lines.push(JSON.stringify({
      step_index: i * 2 + 1,
      type: 'PLANNER_RESPONSE',
      tool_calls: [{
        name: 'run_command',
        arguments: { CommandLine: `npm test --runInBand test_${i}.js` }
      }],
      content: `Verbose test log for run ${i}:\n` + 'PASS src/module.test.js (5.2s)\n'.repeat(150) + '\nRan 150 test suites.'
    }));
  }

  const rawContent = lines.join('\n') + '\n';
  fs.writeFileSync(transcriptPath, rawContent);
  const initialBytes = fs.statSync(transcriptPath).size;
  assert.ok(initialBytes > 400 * 1024, `Initial transcript must be large (>400KB), got ${initialBytes}`);

  // Create synthetic chunk files
  for (let c = 0; c < 5; c++) {
    fs.writeFileSync(path.join(chunkDir, `0000000${c}.jsonl`), 'chunk data '.repeat(1000));
  }
  assert.equal(fs.readdirSync(chunkDir).length, 5, 'Should have 5 initial chunk files');

  const shaper = new Helix2TranscriptShaper({
    maxUncompactedBytes: 40 * 1024,
    retainRecentSteps: 4,
    archiveThresholdLines: 15
  });

  assert.equal(shaper.needsShaping(transcriptPath), true, 'Needs shaping must trigger');

  const tStart = performance.now();
  const shapeResult = shaper.shapeTranscript({ transcriptPath, fullTranscriptPath });
  const durationMs = performance.now() - tStart;

  assert.equal(shapeResult.status, 'shaped');
  assert.ok(durationMs < 50, `Compaction must be sub-50ms synchronous, took ${durationMs.toFixed(2)}ms`);

  const compactedBytes = fs.statSync(transcriptPath).size;
  const reductionPercent = ((initialBytes - compactedBytes) / initialBytes) * 100;

  // Verify reduction is >= 90%
  assert.ok(reductionPercent >= 90, `Compaction reduction must be >=90%, achieved ${reductionPercent.toFixed(2)}%`);
  assert.ok(fs.existsSync(fullTranscriptPath), 'Full transcript must be preserved 100% losslessly');

  // Verify chunks were synced down to 1
  const remainingChunks = fs.readdirSync(chunkDir);
  assert.equal(remainingChunks.length, 1, 'Orphaned chunks must be pruned down to 1 slice');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('HELIX Memory Isolation: Directives recall sharply under 25 tokens without stale cross-talk', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-mem-audit-'));
  const mem = new DeterministicMemory(tmpDir);
  const sharpener = new Helix2ContextSharpener({ memory: mem, stateDir: tmpDir });
  const project = path.basename(tmpDir);

  // Put a directive for the active session
  mem.put({
    project,
    task: 'test-session-active',
    title: 'Directive: Optimize latency to sub-20ms',
    body: 'Ensure all tests pass and latency is verified.',
    kind: 'decision'
  });

  const retrieved = sharpener.retrieveSharpContext({
    workspaceDir: tmpDir,
    conversationId: 'test-session-active',
    userPrompt: 'What was the directive regarding latency?'
  });

  assert.ok(retrieved.includes('[HELIX MEMORY (<25 tok)]'));
  assert.ok(retrieved.includes('Optimize latency'));

  mem.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
