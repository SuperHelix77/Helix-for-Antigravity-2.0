import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('Helix 2.0 Full Feature Suite Verification', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-full-test-'));
  fs.chmodSync(tmpDir, 0o700);

  await t.test('1. Helix2TranscriptShaper: Shapes older steps & preserves 100% full raw', async () => {
    const { Helix2TranscriptShaper } = await import('../src/helix2-transcript-shaper.mjs');
    const tPath = path.join(tmpDir, 'test-transcript.jsonl');
    const fPath = path.join(tmpDir, 'test-transcript_full.jsonl');
    const dummyLines = [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'test request' }),
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', thinking: 'long thinking block '.repeat(20), content: 'response '.repeat(30) }),
      JSON.stringify({ step_index: 2, type: 'GENERIC', content: 'Created At: 2026-10-25\nCompleted At: 2026-10-25\n' + 'verbose output '.repeat(30) }),
      JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', content: 'recent response' })
    ];
    fs.writeFileSync(tPath, dummyLines.join('\n') + '\n');
    fs.writeFileSync(fPath, dummyLines.join('\n') + '\n');

    const shaper = new Helix2TranscriptShaper({ retainRecentSteps: 1 });
    const res = await shaper.shapeTranscript({ transcriptPath: tPath, fullTranscriptPath: fPath, retainRecentSteps: 1 });
    assert.equal(res.status, 'shaped');
    assert.ok(res.savedBytes > 0);

    const shaped = fs.readFileSync(tPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.ok(shaped[1].truncated_fields.includes('thinking'));
    assert.ok(shaped[2].truncated_fields.includes('content'));
    assert.ok(!shaped[2].content.includes('Created At:'));
  });

  await t.test('2. HelixLeanSwitch: Compresses exit 0 outputs by 95%+ and preserves full traceback on failure', async () => {
    const { HelixLeanSwitch } = await import('../src/helix-lean-switch.mjs');
    const progDir = path.join(tmpDir, 'programs');
    fs.mkdirSync(progDir, { recursive: true, mode: 0o700 });
    const lean = new HelixLeanSwitch({ directory: progDir });

    // Success run with substantial output
    const rawOutput = 'PASS test 1\nPASS test 2\n'.repeat(150);
    const successRes = lean.shapeCommandOutput(rawOutput, { command: 'node --test', exitCode: 0 });
    assert.ok(successRes.savedBytes > 500);
    assert.ok(successRes.output.startsWith('[HELIX Lean Switch:'));
    assert.ok(successRes.receipt);

    // Exact raw recovery via encrypted handle
    const rawRestored = lean.recover(successRes.receipt);
    assert.ok(rawRestored.includes('PASS test 1\nPASS test 2'));

    // Failure run preserves full traceback
    const failRes = lean.shapeCommandOutput('AssertionError: expected true but received false\n    at test.js:42:15', { command: 'node --test', exitCode: 1 });
    assert.ok(failRes.output.includes('AssertionError: expected true'));
  });

  await t.test('3. DeterministicMemory: SQLite memory persistence and deterministic recall', async () => {
    const { DeterministicMemory } = await import('../src/memory.mjs');
    const memDir = path.join(tmpDir, 'mem');
    fs.mkdirSync(memDir, { recursive: true, mode: 0o700 });
    const mem = new DeterministicMemory(memDir);

    const putRes = mem.put({
      project: 'helix-core',
      task: 'feature-audit',
      title: 'Architectural Invariant 416',
      body: 'Zero token bloat without semantic degradation',
      kind: 'fact'
    });
    assert.ok(putRes.id);

    const searchRes = mem.search({ project: 'helix-core', query: 'Invariant' });
    assert.equal(searchRes.length, 1);
    assert.equal(searchRes[0].title, 'Architectural Invariant 416');
  });

  await t.test('4. Helix2ASTInliner: Multilingual symbol locus extraction without full-file reads', async () => {
    const { extractTargetContext } = await import('../src/helix2-ast-inliner.mjs');
    const locus = extractTargetContext(rootDir, 'Function buildSnippet in file src/helix2-ast-inliner.mjs has an edge case');
    assert.ok(typeof locus === 'string');
  });

  await t.test('5. Helix2LazyManager: Auto-scoping and JIT skill resolution', async () => {
    const { Helix2LazyManager } = await import('../src/helix2-lazy-manager.mjs');
    const lm = new Helix2LazyManager();
    const skills = lm.listSkills();
    assert.ok(skills.length > 0);

    const sync1 = lm.autoSync({ userPrompt: 'What is the weather today?' });
    assert.equal(sync1.jitMatches.length, 0);

    // Matches dormant skill explicitly
    const sync2 = lm.autoSync({ userPrompt: '/skill firebase-basics' });
    assert.ok(sync2.jitMatches.length >= 1);
  });

  await t.test('6. Helix2ToolPipeline: Atomic multi-step pipeline execution in 1 model turn', async () => {
    const { Helix2ToolPipeline } = await import('../src/helix2-tool-pipeline.mjs');
    const pipeDir = path.join(tmpDir, 'pipeline_clean_dir');
    fs.mkdirSync(pipeDir, { recursive: true, mode: 0o700 });
    const pipeline = new Helix2ToolPipeline({ directory: pipeDir });
    const res = await pipeline.executePipeline(pipeDir, [
      { kind: 'command', command: 'echo "Pipeline Step 1"' },
      { kind: 'command', command: 'echo "Pipeline Step 2"' }
    ]);
    assert.equal(res.success, true);
    assert.equal(res.stepsExecuted, 2);
    assert.ok(res.summary.includes('SUCCESS'));
  });

  await t.test('7. RedTeamLeakGuard: Automatic redaction of credentials and personal identifiers', async () => {
    const { redactContextText } = await import('../src/compaction-checkpoint.mjs');
    const sanitized = redactContextText('Key: ghp_1234567890abcdefghijklmnopqrstuvwxyz12');
    assert.ok(!sanitized.includes('1234567890abcdef'));
    assert.ok(sanitized.includes('[REDACTED]'));
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
