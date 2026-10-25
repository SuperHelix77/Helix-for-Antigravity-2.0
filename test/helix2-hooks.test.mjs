import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const preToolHook = path.join(root, 'plugin/hooks/pre-tool-use.mjs');
const postToolHook = path.join(root, 'plugin/hooks/post-tool-use.mjs');

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
  assert.ok(out1.overwrite?.CommandLine.includes('helix.mjs lean -- npm test'));

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
