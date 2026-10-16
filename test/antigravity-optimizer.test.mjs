import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RequestOptimizer } from '../src/request-optimizer.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-antigravity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('RequestOptimizer supports Gemini, Claude, and Antigravity models with fast aging', t => {
  const directory = fixture(t);
  const optimizer = new RequestOptimizer(directory);

  const input = [];
  for (let n = 0; n < 4; n++) {
    input.push({ type: 'function_call', name: 'exec_command', call_id: `c${n}`, arguments: '{"cmd":"test"}' });
    input.push({ type: 'function_call_output', call_id: `c${n}`, output: `Log chunk ${n}\n` + 'detailed execution proof\n'.repeat(100) });
    input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checked step.' }] });
  }

  for (const model of ['gemini-3.8-flash', 'claude-3-7-sonnet', 'antigravity']) {
    const payload = {
      model,
      reasoning: { effort: 'high' },
      input: JSON.parse(JSON.stringify(input)),
      tools: [{ name: 'exec', type: 'custom' }]
    };
    const result = optimizer.shape(payload, { session: `session-${model}`, provider: 'antigravity' });
    assert.equal(result.stats.enabled, true, `Optimizer must be enabled for ${model}`);
    assert.ok(result.stats.toolResultsRetained >= 1, `At least one tool result must be aged for ${model}`);
  }
});
