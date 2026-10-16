import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreClient } from '../src/core-client.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-inspect-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('context batch_inspect retrieves multiple file slices in a single deterministic MCP call', async t => {
  const directory = fixture(t);
  const client = new CoreClient(directory);
  t.after(() => client.close());

  const result = await client.call('tools/call', {
    name: 'context',
    arguments: {
      action: 'batch_inspect',
      project: process.cwd(),
      files: [
        { path: 'package.json', start: 1, end: 15 },
        { path: 'src/paths.mjs', start: 1, end: 6 }
      ]
    }
  });

  assert.ok(result);
  assert.ok(result.content);
  const text = result.content[0].text;
  assert.ok(text.includes('--- FILE: package.json (lines 1-15/'));
  assert.ok(text.includes('"name": "helix-engine"'));
  assert.ok(text.includes('--- FILE: src/paths.mjs (lines 1-6/'));
  assert.ok(text.includes('STATE_DIR'));
});
