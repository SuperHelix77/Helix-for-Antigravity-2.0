import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Helix2PatchEngine } from '../src/helix2-patch-engine.mjs';
import { Helix2ToolPipeline } from '../src/helix2-tool-pipeline.mjs';

test('Helix2PatchEngine parses and applies multi-file unified diff', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix2-patch-'));
  const fileA = path.join(tmpDir, 'alpha.txt');
  const fileB = path.join(tmpDir, 'beta.txt');

  fs.writeFileSync(fileA, 'line 1\nline 2\nline 3\n', 'utf8');
  fs.writeFileSync(fileB, 'apple\nbanana\ncherry\n', 'utf8');

  const patchText = `--- a/alpha.txt
+++ b/alpha.txt
@@ -1,3 +1,3 @@
 line 1
-line 2
+line two updated
 line 3
--- a/beta.txt
+++ b/beta.txt
@@ -1,3 +1,3 @@
 apple
-banana
+blueberry
 cherry
`;

  const engine = new Helix2PatchEngine();
  const res = engine.applyPatch(tmpDir, patchText);

  assert.equal(res.success, true);
  assert.equal(res.filesModified.length, 2);
  assert.equal(fs.readFileSync(fileA, 'utf8'), 'line 1\nline two updated\nline 3\n');
  assert.equal(fs.readFileSync(fileB, 'utf8'), 'apple\nblueberry\ncherry\n');

  // Verify rollback
  engine.revertPatch(res.backups);
  assert.equal(fs.readFileSync(fileA, 'utf8'), 'line 1\nline 2\nline 3\n');
  assert.equal(fs.readFileSync(fileB, 'utf8'), 'apple\nbanana\ncherry\n');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Helix2ToolPipeline executes multi-file patch with auto targeted testing', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix2-pipe-patch-'));
  const srcDir = path.join(tmpDir, 'src');
  const testDir = path.join(tmpDir, 'test');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(testDir, { recursive: true });

  const srcFile = path.join(srcDir, 'math.mjs');
  const testFile = path.join(testDir, 'math.test.mjs');

  fs.writeFileSync(srcFile, 'export function multiply(a, b) { return a + b; }\n', 'utf8');
  fs.writeFileSync(testFile, `
import test from 'node:test';
import assert from 'node:assert/strict';
import { multiply } from '../src/math.mjs';

test('multiply works', () => {
  assert.equal(multiply(2, 3), 6);
});
`, 'utf8');

  const patchText = `--- a/src/math.mjs
+++ b/src/math.mjs
@@ -1 +1 @@
-export function multiply(a, b) { return a + b; }
+export function multiply(a, b) { return a * b; }
`;

  const pipeline = new Helix2ToolPipeline();
  const operations = [
    { kind: 'patch', patch: patchText, rollbackOnFailure: true },
    { kind: 'command', command: 'auto' }
  ];

  const result = await pipeline.executePipeline(tmpDir, operations);

  assert.equal(result.success, true);
  assert.equal(result.stepsExecuted, 2);
  assert.ok(result.results[0].success);
  assert.equal(result.results[1].exitCode, 0);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Helix2ToolPipeline auto-reverts patch when test fails', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix2-pipe-revert-'));
  const srcDir = path.join(tmpDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  const srcFile = path.join(srcDir, 'broken.mjs');
  fs.writeFileSync(srcFile, 'const x = 1;\n', 'utf8');

  const patchText = `--- a/src/broken.mjs
+++ b/src/broken.mjs
@@ -1 +1 @@
-const x = 1;
+const x = 999;
`;

  const pipeline = new Helix2ToolPipeline();
  const operations = [
    { kind: 'patch', patch: patchText, rollbackOnFailure: true },
    { kind: 'command', command: 'exit 1' }
  ];

  const result = await pipeline.executePipeline(tmpDir, operations);

  assert.equal(result.success, false);
  // Original file should have been reverted back to x = 1
  assert.equal(fs.readFileSync(srcFile, 'utf8'), 'const x = 1;\n');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
