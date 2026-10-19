import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('MCP context lean_run and seal extensions round-trip correctly', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-mcp-test-'));
  t.after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  const mcpProcess = spawn(process.execPath, [path.join(root, 'bin/helix-context-mcp.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HELIX_GOAL_DIR: path.join(tmpDir, 'goals'),
      HELIX_PROGRAM_RETENTION_DIR: path.join(tmpDir, 'programs'),
    }
  });

  const lines = readline.createInterface({ input: mcpProcess.stdout });
  let nextId = 1;
  const pending = new Map();

  lines.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      const handler = pending.get(msg.id);
      if (handler) {
        pending.delete(msg.id);
        if (msg.error) handler.reject(new Error(msg.error.message));
        else handler.resolve(msg.result);
      }
    } catch (e) {}
  });

  t.after(() => {
    mcpProcess.kill('SIGTERM');
  });

  const send = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      mcpProcess.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };

  // 1. Initialize
  const init = await send('initialize', { protocolVersion: '2024-11-05' });
  assert.ok(init.serverInfo);

  // 2. tools/list
  const tools = await send('tools/list', {});
  assert.ok(tools.tools.some(t => t.name === 'context'));
  assert.ok(tools.tools.some(t => t.name === 'goal'));

  // 3. context action: lean_run
  const leanRunResult = await send('tools/call', {
    name: 'context',
    arguments: {
      action: 'lean_run',
      project: root,
      command: 'echo "TEST_OUTPUT_12345"'
    }
  });
  assert.ok(typeof leanRunResult.content[0].text === 'string');
  assert.ok(leanRunResult.content[0].text.includes('TEST_OUTPUT_12345') || leanRunResult.content[0].text.includes('LEAN_SWITCH'));

  // 4. context action: seal
  const sealResult = await send('tools/call', {
    name: 'context',
    arguments: {
      action: 'seal',
      project: root,
      session: 'test-session-001',
      task: 'test-task-1',
      status: 'PASS',
      summary: 'Verified fix across test files'
    }
  });
  const sealText = sealResult.content[0].text;
  assert.ok(sealText.includes('helix.handoff.v1'));
  assert.ok(sealText.includes('Task: test-task-1 [PASS]'));
  assert.ok(sealText.includes('Handle: '));

  // Extract handle from seal
  const handleMatch = sealText.match(/Handle:\s+([A-Za-z0-9_-]{43})/);
  assert.ok(handleMatch, 'Should find 43-char handle in seal receipt');
  const handle = handleMatch[1];

  // 5. context action: raw to retrieve archived seal payload
  const rawResult = await send('tools/call', {
    name: 'context',
    arguments: {
      action: 'raw',
      receipt: handle
    }
  });
  const rawText = rawResult.content[0].text;
  assert.ok(rawText.includes('helix.handoff.v1'));
  assert.ok(rawText.includes('test-task-1'));
  assert.ok(rawText.includes('Verified fix across test files'));
});
