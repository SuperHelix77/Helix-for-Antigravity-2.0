import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const preToolHook = path.join(root, 'plugin/hooks/pre-tool-use.mjs');
const postToolHook = path.join(root, 'plugin/hooks/post-tool-use.mjs');
const postInvocationHook = path.join(root, 'plugin/hooks/post-invocation.mjs');
const sessionStartHook = path.join(root, 'plugin/hooks/session-start.mjs');
const stopMonitorHook = path.join(root, 'plugin/hooks/stop-monitor.mjs');

test('pre-tool-use hook wraps verbose commands with Helix lean switch', (t) => {
  const res1 = spawnSync(process.execPath, [preToolHook], {
    input: JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } } }),
    encoding: 'utf8'
  });
  assert.equal(res1.status, 0);
  const out1 = JSON.parse(res1.stdout);
  assert.equal(out1.decision, 'allow');
  assert.ok(out1.overwrite?.CommandLine.includes('lean'));

  // Non-verbose → no overwrite
  const res2 = spawnSync(process.execPath, [preToolHook], {
    input: JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'echo "hello"' } } }),
    encoding: 'utf8'
  });
  assert.equal(res2.status, 0);
  const out2 = JSON.parse(res2.stdout);
  assert.equal(out2.decision, 'allow');
  assert.equal(out2.overwrite, undefined);
});

test('pre-tool-use hook bounds unbounded read_file to 300 lines (never denies)', (t) => {
  // Unbounded
  const res = spawnSync(process.execPath, [preToolHook], {
    input: JSON.stringify({ toolCall: { name: 'read_file', args: { Path: '/some/file.py' } } }),
    encoding: 'utf8'
  });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'allow');
  assert.equal(out.overwrite?.StartLine, 1);
  assert.equal(out.overwrite?.EndLine, 300);

  // Bounded → no overwrite
  const res2 = spawnSync(process.execPath, [preToolHook], {
    input: JSON.stringify({ toolCall: { name: 'read_file', args: { Path: '/some/file.py', StartLine: 10, EndLine: 50 } } }),
    encoding: 'utf8'
  });
  const out2 = JSON.parse(res2.stdout);
  assert.equal(out2.decision, 'allow');
  assert.equal(out2.overwrite, undefined);

  // Oversized → bounded
  const res3 = spawnSync(process.execPath, [preToolHook], {
    input: JSON.stringify({ toolCall: { name: 'read_file', args: { Path: '/some/file.py', StartLine: 1, EndLine: 800 } } }),
    encoding: 'utf8'
  });
  const out3 = JSON.parse(res3.stdout);
  assert.equal(out3.decision, 'allow');
  assert.equal(out3.overwrite?.EndLine, 301);
});

test('pre-tool-use NEVER returns deny (allow only)', (t) => {
  // read_file, edit_file, run_command, unknown tools → all must be allow
  const tools = [
    { name: 'read_file', args: { Path: '/foo.py' } },
    { name: 'edit_file', args: { Path: '/foo.py', Target: 'x', Replacement: 'y' } },
    { name: 'run_command', args: { CommandLine: 'cat /foo.py' } },
    { name: 'write_file', args: { Path: '/foo.py', Content: 'x' } },
    { name: 'search_web', args: { query: 'test' } },
  ];

  for (const toolCall of tools) {
    const res = spawnSync(process.execPath, [preToolHook], {
      input: JSON.stringify({ toolCall }),
      encoding: 'utf8'
    });
    assert.equal(res.status, 0, `Hook must exit 0 for ${toolCall.name}`);
    const out = JSON.parse(res.stdout);
    assert.equal(out.decision, 'allow', `${toolCall.name} must be allow, got ${out.decision}`);
  }
});

test('post-invocation hook terminates at invocation cap', (t) => {
  // invocationNum 0 → allow (empty object or no terminationBehavior)
  const res0 = spawnSync(process.execPath, [postInvocationHook], {
    input: JSON.stringify({ invocationNum: 0, conversationId: 'test-hook-cap' }),
    encoding: 'utf8'
  });
  assert.equal(res0.status, 0);
  const out0 = JSON.parse(res0.stdout);
  assert.notEqual(out0.terminationBehavior, 'terminate', 'invocation 0 should not terminate');

  // invocationNum 1 → TERMINATE
  const res1 = spawnSync(process.execPath, [postInvocationHook], {
    input: JSON.stringify({ invocationNum: 1, conversationId: 'test-hook-cap' }),
    encoding: 'utf8'
  });
  assert.equal(res1.status, 0);
  const out1 = JSON.parse(res1.stdout);
  assert.equal(out1.terminationBehavior, 'terminate', 'invocation 1 must terminate');
});

test('post-tool-use hook runs without error and outputs empty object', (t) => {
  const res = spawnSync(process.execPath, [postToolHook], {
    input: JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'ls' } }, stepIdx: 10 }),
    encoding: 'utf8'
  });
  assert.equal(res.status, 0);
  assert.deepEqual(JSON.parse(res.stdout), {});
});

test('session-start hook runs without error', (t) => {
  const res = spawnSync(process.execPath, [sessionStartHook], {
    input: JSON.stringify({ conversationId: 'test-session-01', workspacePaths: [root] }),
    encoding: 'utf8'
  });
  assert.equal(res.status, 0);
  assert.deepEqual(JSON.parse(res.stdout), {});
});

test('stop-monitor hook returns allow decision', (t) => {
  const res = spawnSync(process.execPath, [stopMonitorHook], {
    input: JSON.stringify({ conversationId: 'test-stop-01', workspacePaths: [root], terminationReason: 'NO_TOOL_CALL' }),
    encoding: 'utf8'
  });
  assert.equal(res.status, 0);
  assert.equal(JSON.parse(res.stdout).decision, 'allow');
});
