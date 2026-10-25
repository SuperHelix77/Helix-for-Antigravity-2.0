import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Helix2TokenMonitor } from '../src/helix2-token-monitor.mjs';

test('Helix2TokenMonitor records and audits token metrics without cost in SQLite', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-token-monitor-test-'));
  const logDir = path.join(tmpDir, '.system_generated', 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  const fullTranscriptPath = path.join(logDir, 'transcript_full.jsonl');

  // Create synthetic transcript lines with PLANNER_RESPONSE token metrics
  const lines = [
    JSON.stringify({ step_index: 1, type: 'USER_INPUT', content: 'hello' }),
    JSON.stringify({
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      input_tokens: 2400,
      cache_read_tokens: 35000,
      output_tokens: 150
    })
  ];
  fs.writeFileSync(fullTranscriptPath, lines.join('\n') + '\n');

  const monitor = new Helix2TokenMonitor({ directory: tmpDir });

  // Record metrics
  const res = monitor.recordStepMetrics({
    transcriptPath: path.join(logDir, 'transcript.jsonl'),
    conversationId: 'test-conv-01',
    baselineTokens: 263265
  });

  assert.equal(res.recorded, true);
  assert.equal(res.stepIndex, 2);
  assert.equal(res.inputTokens, 2400);
  assert.equal(res.cacheReadTokens, 35000);
  assert.equal(res.outputTokens, 150);
  assert.equal(res.totalTokens, 37550);
  assert.ok(res.savedPercent > 80, `Expected savings > 80%, got ${res.savedPercent}%`);

  // Verify idempotent: second call does not re-insert duplicate step
  const res2 = monitor.recordStepMetrics({
    transcriptPath: path.join(logDir, 'transcript.jsonl'),
    conversationId: 'test-conv-01',
    baselineTokens: 263265
  });
  assert.equal(res2.recorded, false);
  assert.equal(res2.reason, 'already_recorded');

  // Verify conversation summary
  const summary = monitor.getConversationSummary('test-conv-01');
  assert.equal(summary.totalSteps, 1);
  assert.equal(summary.totalTokens, 37550);
  assert.ok(summary.overallSavedPercent > 80);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
