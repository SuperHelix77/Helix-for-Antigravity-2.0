import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const preToolHook = path.join(root, 'plugin/hooks/pre-tool-use.mjs');
const postToolHook = path.join(root, 'plugin/hooks/post-tool-use.mjs');
const sessionStartHook = path.join(root, 'plugin/hooks/session-start.mjs');
const stopMonitorHook = path.join(root, 'plugin/hooks/stop-monitor.mjs');

test('pre-tool-use hook wraps verbose commands with Helix lean switch', (t) => {
  // 1. Verbose test command should be overwritten
  const inputTest = JSON.stringify({
    toolCall: {
      name: 'run_command',
      args: { CommandLine: 'npm test' }
    }
  });

  const res1 = spawnSync(process.execPath, [preToolHook], {
    input: inputTest,
    encoding: 'utf8'
  });

  assert.equal(res1.status, 0);
  const out1 = JSON.parse(res1.stdout);
  assert.equal(out1.decision, 'allow');
  assert.ok(out1.overwrite?.CommandLine.includes('helix.mjs') && out1.overwrite?.CommandLine.includes('lean'));

  // 2. Non-verbose command should be allowed without overwrite
  const inputSimple = JSON.stringify({
    toolCall: {
      name: 'run_command',
      args: { CommandLine: 'echo "hello"' }
    }
  });

  const res2 = spawnSync(process.execPath, [preToolHook], {
    input: inputSimple,
    encoding: 'utf8'
  });

  assert.equal(res2.status, 0);
  const out2 = JSON.parse(res2.stdout);
  assert.equal(out2.decision, 'allow');
  assert.equal(out2.overwrite, undefined);
});

test('post-tool-use hook runs without error and outputs empty object', (t) => {
  const input = JSON.stringify({
    toolCall: { name: 'run_command', args: { CommandLine: 'ls' } },
    stepIdx: 10
  });

  const res = spawnSync(process.execPath, [postToolHook], {
    input,
    encoding: 'utf8'
  });

  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out, {});
});

test('pre-tool-use hook bounds unbounded read_file calls to 300 lines max', (t) => {
  const inputUnbounded = JSON.stringify({
    toolCall: {
      name: 'read_file',
      args: { Path: '/some/large/file.py' }
    }
  });

  const res = spawnSync(process.execPath, [preToolHook], {
    input: inputUnbounded,
    encoding: 'utf8'
  });

  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'allow');
  assert.equal(out.overwrite?.StartLine, 1);
  assert.equal(out.overwrite?.EndLine, 300);

  // Bounded read_file should not be overwritten
  const inputBounded = JSON.stringify({
    toolCall: {
      name: 'read_file',
      args: { Path: '/some/file.py', StartLine: 10, EndLine: 50 }
    }
  });
  const res2 = spawnSync(process.execPath, [preToolHook], {
    input: inputBounded,
    encoding: 'utf8'
  });
  assert.equal(res2.status, 0);
  const out2 = JSON.parse(res2.stdout);
  assert.equal(out2.decision, 'allow');
  assert.equal(out2.overwrite, undefined);

  // Oversized read_file (> 350 lines) should be bounded
  const inputOversized = JSON.stringify({
    toolCall: {
      name: 'read_file',
      args: { Path: '/some/file.py', StartLine: 1, EndLine: 800 }
    }
  });
  const res3 = spawnSync(process.execPath, [preToolHook], {
    input: inputOversized,
    encoding: 'utf8'
  });
  assert.equal(res3.status, 0);
  const out3 = JSON.parse(res3.stdout);
  assert.equal(out3.decision, 'allow');
  assert.equal(out3.overwrite?.EndLine, 301);
});

test('session-start hook runs without error and outputs empty object', (t) => {
  const input = JSON.stringify({
    conversationId: 'test-session-start-01',
    workspacePaths: [root]
  });

  const res = spawnSync(process.execPath, [sessionStartHook], {
    input,
    encoding: 'utf8'
  });

  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out, {});
});

test('stop-monitor hook records step metrics and returns allow decision', (t) => {
  const input = JSON.stringify({
    conversationId: 'test-stop-01',
    workspacePaths: [root],
    terminationReason: 'NO_TOOL_CALL'
  });

  const res = spawnSync(process.execPath, [stopMonitorHook], {
    input,
    encoding: 'utf8'
  });

  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'allow');
});
