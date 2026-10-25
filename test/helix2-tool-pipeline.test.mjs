import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Helix2ToolPipeline } from '../src/helix2-tool-pipeline.mjs';

test('Helix2ToolPipeline executes edit and command pipeline sequentially', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix2-pipeline-'));
  const storeDir = path.join(tmpDir, 'store');
  fs.mkdirSync(storeDir, { mode: 0o700 });

  const testFile = path.join(tmpDir, 'test_script.sh');
  fs.writeFileSync(testFile, 'echo "Initial"\n', { encoding: 'utf8' });

  const pipeline = new Helix2ToolPipeline({ directory: storeDir });

  const operations = [
    {
      kind: 'edit',
      file: 'test_script.sh',
      target: 'Initial',
      replacement: 'Updated'
    },
    {
      kind: 'command',
      command: `${process.platform === 'win32' ? 'type' : 'cat'} test_script.sh`
    }
  ];

  const result = await pipeline.executePipeline(tmpDir, operations, { taskId: 'task-test-pipeline' });

  assert.equal(result.success, true);
  assert.equal(result.stepsExecuted, 2);
  assert.ok(result.results[0].success);
  assert.equal(result.results[1].exitCode, 0);
  assert.ok(result.results[1].output.includes('exit:0'));
  assert.ok(result.results[1].receipt);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Helix2ToolPipeline halts at first failure boundary', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix2-pipe-halt-'));
  const storeDir = path.join(tmpDir, 'store');
  fs.mkdirSync(storeDir, { mode: 0o700 });

  const pipeline = new Helix2ToolPipeline({ directory: storeDir });

  const operations = [
    {
      kind: 'command',
      command: 'exit 1'
    },
    {
      kind: 'command',
      command: 'echo "Should not run"'
    }
  ];

  const result = await pipeline.executePipeline(tmpDir, operations, { taskId: 'task-fail-pipeline' });

  assert.equal(result.success, false);
  assert.equal(result.stepsExecuted, 1);
  assert.equal(result.results[0].exitCode, 1);
  assert.equal(result.results[1].status, 'SKIPPED');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('helix flow CLI supports flags and inline JSON pipelines', async () => {
  const { execFileSync } = await import('node:child_process');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix2-flow-cli-'));
  const testFile = path.join(tmpDir, 'sample.txt');
  fs.writeFileSync(testFile, 'initial content', 'utf8');

  const helixBin = path.resolve('bin/helix.mjs');

  // Test 1: Flag-based execution
  const flagOut = execFileSync(process.execPath, [
    helixBin, 'flow',
    '--edit', testFile,
    '--target', 'initial',
    '--replace', 'flow-updated',
    '--test', `${process.platform === 'win32' ? 'type' : 'cat'} "${testFile}"`
  ], { cwd: tmpDir, encoding: 'utf8' });

  assert.ok(flagOut.includes('status:SUCCESS'));
  assert.ok(flagOut.includes('Edited'));
  assert.equal(fs.readFileSync(testFile, 'utf8'), 'flow-updated content');

  // Test 2: Inline JSON execution
  const inlineSpec = JSON.stringify([
    { kind: 'command', command: 'echo "inline success"' }
  ]);
  const jsonOut = execFileSync(process.execPath, [
    helixBin, 'flow', inlineSpec
  ], { cwd: tmpDir, encoding: 'utf8' });

  assert.ok(jsonOut.includes('status:SUCCESS'));
  assert.ok(jsonOut.includes('Step #1 (command): PASS'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
