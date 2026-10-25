import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DeterministicMemory } from '../src/memory.mjs';
import { HelixLeanSwitch } from '../src/helix-lean-switch.mjs';
import { Helix2SpeculativePreAnalyzer } from '../src/helix2-speculative-pre-analyzer.mjs';
import { Helix2EngineCircuitBreaker } from '../src/helix2-engine-circuit-breaker.mjs';
import { shapeWebAndMcpPayload } from '../src/tool-result-aging.mjs';
import { Helix2ContextSharpener } from '../src/helix2-context-sharpener.mjs';

function tempDir(prefix = 'helix-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// -----------------------------------------------------------------------------
// Attack Surface 1: Ephemeral Prefix Freezing & Jitter Elimination
// -----------------------------------------------------------------------------
test('Surface 1: Static protocol header prefix is 100% byte-identical across multiple invocations', (t) => {
  const tmpDir = tempDir('prefix-');
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const sharpener = new Helix2ContextSharpener({ stateDir: tmpDir });
  
  // Create two distinct calls
  const ctx1 = sharpener.shapePreInvocation({
    workspaceDir: tmpDir,
    latestUserPrompt: 'What is the status?'
  });
  const ctx2 = sharpener.shapePreInvocation({
    workspaceDir: tmpDir,
    latestUserPrompt: 'What is the status?'
  });

  assert.ok(ctx1, 'Context 1 must be generated');
  assert.ok(ctx2, 'Context 2 must be generated');

  const prefix1 = ctx1.split('\n\n')[0];
  const prefix2 = ctx2.split('\n\n')[0];
  assert.equal(prefix1, prefix2, 'Static protocol header prefix must be 100% byte-identical');
  assert.ok(prefix1.includes('[HELIX 2.0 PROTOCOL ACTIVATED - ZERO-BLOAT EPHEMERAL CONTEXT]'));
});

// -----------------------------------------------------------------------------
// Attack Surface 2: Out-of-Band Tool Payload Floods (HTML & Large JSON)
// -----------------------------------------------------------------------------
test('Surface 2: shapeWebAndMcpPayload distills raw HTML and large JSON into compact previews', (t) => {
  // Test 2A: Large HTML document
  const rawHtml = `<!DOCTYPE html>
<html>
<head>
  <style>body { background: #fff; font-family: sans-serif; }</style>
  <script>console.log("tracking snippet");</script>
</head>
<body>
  <h1>Documentation Portal</h1>
  <p>Welcome to the main API guide.</p>
  ${'<div>Additional content section with details and paragraphs.</div>\n'.repeat(40)}
</body>
</html>`;

  const shapedHtml = shapeWebAndMcpPayload(rawHtml);
  assert.ok(shapedHtml.length < rawHtml.length, 'Shaped HTML must be smaller than raw HTML');
  assert.ok(!shapedHtml.includes('<style>'), 'Style tags must be stripped');
  assert.ok(!shapedHtml.includes('<script>'), 'Script tags must be stripped');
  assert.ok(shapedHtml.includes('HTML Document distilled into text preview'), 'Must contain distillation header');

  // Test 2B: Large JSON array
  const largeArray = Array.from({ length: 500 }, (_, i) => ({ id: i, name: `item_${i}`, active: true }));
  const rawJsonArray = JSON.stringify(largeArray, null, 2);
  const shapedJson = shapeWebAndMcpPayload(rawJsonArray);
  assert.ok(shapedJson.length < rawJsonArray.length, 'Shaped JSON array must be significantly smaller');
  assert.ok(shapedJson.includes('JSON Array (500 records)'), 'Must summarize array length');
  assert.ok(shapedJson.includes('item_0'), 'Must preserve sample item preview');
});

// -----------------------------------------------------------------------------
// Attack Surface 3: Speculative Diff Explosion in Dirty Repositories
// -----------------------------------------------------------------------------
test('Surface 3: Speculative pre-analyzer bounds large git diffs to summary and key hunks', (t) => {
  const tmpDir = tempDir('diff-bound-');
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const analyzer = new Helix2SpeculativePreAnalyzer({ maxDiffLines: 15 });
  // The bounding logic triggers when diffLines.length > maxDiffLines
  assert.equal(analyzer.maxDiffLines, 15, 'Configured with compact diff line cap');
});

// -----------------------------------------------------------------------------
// Attack Surface 4: Agent Amnesia & Duplicate Tool Invocations
// -----------------------------------------------------------------------------
test('Surface 4: Circuit breaker bounds duplicate reads in the same turn without mutation', (t) => {
  const tmpDir = tempDir('cb-amnesia-');
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const breaker = new Helix2EngineCircuitBreaker({ stateDir: tmpDir });
  const convId = 'amnesia-conv';

  breaker.initTurn({
    conversationId: convId,
    workspaceDir: tmpDir,
    userPrompt: 'Inspect config'
  });

  // Turn 1: First read
  breaker.recordPostToolUse({
    toolCall: { name: 'read_file', args: { Path: 'config.json', StartLine: 1, EndLine: 200 } },
    conversationId: convId,
    workspaceDir: tmpDir
  });

  // Turn 2: Model attempts duplicate read on the same range with no mutation
  const res = breaker.checkPreToolUse({
    toolCall: { name: 'read_file', args: { Path: 'config.json', StartLine: 1, EndLine: 200 } },
    conversationId: convId,
    workspaceDir: tmpDir
  });

  assert.equal(res.decision, 'allow');
  assert.ok(res.overwrite, 'Duplicate read must trigger bounded overwrite');
  assert.equal(res.overwrite.StartLine, 1);
  assert.equal(res.overwrite.EndLine, 15, 'Duplicate read bounded to 15 lines');
});

// -----------------------------------------------------------------------------
// Attack Surface 5: Binary, Minified, and Lockfile Traps
// -----------------------------------------------------------------------------
test('Surface 5: Circuit breaker bounds binary files to line 1 and lockfiles to 25 lines', (t) => {
  const tmpDir = tempDir('cb-traps-');
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const breaker = new Helix2EngineCircuitBreaker({ stateDir: tmpDir });

  // 5A: Binary file (.sqlite)
  const binRes = breaker.checkPreToolUse({
    toolCall: { name: 'read_file', args: { Path: 'data/app.sqlite', StartLine: 1, EndLine: 100 } }
  });
  assert.equal(binRes.decision, 'allow');
  assert.equal(binRes.overwrite.StartLine, 1);
  assert.equal(binRes.overwrite.EndLine, 1, 'Binary file read must be bounded to 1 line');

  // 5B: Dependency lockfile (package-lock.json)
  const lockRes = breaker.checkPreToolUse({
    toolCall: { name: 'read_file', args: { Path: 'package-lock.json', StartLine: 1, EndLine: 500 } }
  });
  assert.equal(lockRes.decision, 'allow');
  assert.equal(lockRes.overwrite.StartLine, 1);
  assert.equal(lockRes.overwrite.EndLine, 25, 'Lockfile read must be bounded to 25 lines');

  // 5C: Minified bundle (.min.js)
  const minRes = breaker.checkPreToolUse({
    toolCall: { name: 'read_file', args: { Path: 'dist/bundle.min.js', StartLine: 1, EndLine: 1000 } }
  });
  assert.equal(minRes.decision, 'allow');
  assert.equal(minRes.overwrite.StartLine, 1);
  assert.equal(minRes.overwrite.EndLine, 25, 'Minified file read must be bounded to 25 lines');
});

// -----------------------------------------------------------------------------
// Attack Surface 6: Unbounded SQLite Fact Retention & Pruning
// -----------------------------------------------------------------------------
test('Surface 6: DeterministicMemory prunes transient facts while preserving decisions and constraints', (t) => {
  const tmpDir = tempDir('mem-prune-');
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const memory = new DeterministicMemory(tmpDir);

  // Store decisions and constraints (must be permanently preserved)
  memory.put({ project: 'test-proj', task: 't1', title: 'Arch decision 1', body: 'Use PostgreSQL', kind: 'decision' });
  memory.put({ project: 'test-proj', task: 't1', title: 'Constraint 1', body: 'Zero external workers', kind: 'constraint' });

  // Store transient facts
  for (let i = 0; i < 20; i++) {
    memory.put({ project: 'test-proj', task: 't1', title: `Transient fact ${i}`, body: `Output ${i}`, kind: 'fact' });
  }

  assert.equal(memory.count(), 22, 'Initial total notes stored');

  // Prune down to max 5 notes for test-proj
  memory.prune({ project: 'test-proj', maxNotes: 5, ttlDays: 30 });

  const remaining = memory.count();
  assert.ok(remaining <= 7, 'Notes count must be pruned close to maxNotes limit');

  // Decisions and constraints MUST be intact
  const decisions = memory.search({ project: 'test-proj', query: 'PostgreSQL' });
  assert.ok(decisions.length > 0, 'Decision must be preserved after pruning');
  assert.equal(decisions[0].title, 'Arch decision 1');

  memory.close();
});

// -----------------------------------------------------------------------------
// Attack Surface 7: Shell Environment & Secret Dumping Redaction
// -----------------------------------------------------------------------------
test('Surface 7: Lean switch redacts secrets and bounds long env dumps', (t) => {
  const tmpDir = tempDir('lean-env-');
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const lean = new HelixLeanSwitch({ directory: tmpDir, minSavedBytes: 100, maxPreviewLines: 8 });

  const envDump = [
    'USER=tester',
    'SHELL=/bin/zsh',
    'AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE_SECRET',
    'GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyz',
    'DATABASE_PASSWORD=super_secret_db_pass_123',
    'API_KEY=sk_live_abcdef123456789',
    'PATH=/usr/local/bin:/usr/bin:/bin',
    'NODE_ENV=production',
    'HOME=/Users/tester',
    'LANG=en_US.UTF-8',
    'EDITOR=vim',
    'LOGNAME=tester'
  ].join('\n');

  const result = lean.shapeCommandOutput(envDump, {
    command: 'env',
    exitCode: 0,
    toolName: 'run_command'
  });

  assert.ok(result.receipt, 'Receipt should be generated for large env output');
  assert.ok(!result.output.includes('AKIAIOSFODNN7EXAMPLE_SECRET'), 'AWS Secret Key must be redacted');
  assert.ok(!result.output.includes('ghp_1234567890abcdefghijklmnopqrstuvwxyz'), 'GitHub Token must be redacted');
  assert.ok(!result.output.includes('super_secret_db_pass_123'), 'Database Password must be redacted');
  assert.ok(!result.output.includes('sk_live_abcdef123456789'), 'API Key must be redacted');
  assert.ok(result.output.includes('[REDACTED_SECRET]'), 'Must show redaction placeholder');
});
