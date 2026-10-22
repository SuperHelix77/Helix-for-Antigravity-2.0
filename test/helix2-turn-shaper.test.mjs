import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Helix2TurnShaper } from '../src/helix2-turn-shaper.mjs';

test('Helix2TurnShaper folds older intermediate turns into micro-anchors', t => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix2-shaper-'));
  fs.chmodSync(tmpDir, 0o700);
  t.after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  const shaper = new Helix2TurnShaper({ directory: tmpDir, activeWindow: 2 });
  
  const messages = [
    { role: 'user', content: 'Fix the bug in widgets.py where id_for_label returns wrong id' },
    { role: 'tool', content: 'Huge file content:\n' + 'def foo(): pass\n'.repeat(60) }, // Turn 1 (foldable)
    { role: 'assistant', content: 'I have analyzed the file and will replace id_for_label' }, // Turn 2 (foldable)
    { role: 'tool', content: 'Another big tool output:\n' + 'test line\n'.repeat(50) }, // Turn 3 (foldable)
    { role: 'assistant', content: 'Editing the file now...' }, // Turn 4 (boundary)
    { role: 'tool', content: 'Edit applied successfully' }, // Turn 5 (active window)
    { role: 'assistant', content: 'Running tests now' }, // Turn 6 (active window)
    { role: 'tool', content: 'Tests passed 100%' } // Turn 7 (active window)
  ];

  const res = shaper.shapeTurns(messages);

  assert.ok(res.foldedCount >= 2, 'Should fold older intermediate turns');
  assert.ok(res.savedBytes > 500, 'Should achieve substantial byte savings');
  assert.ok(res.messages[1].content.includes('[HELIX 2.0 Micro-Anchor:'));
  assert.ok(res.messages[3].content.includes('[HELIX 2.0 Micro-Anchor:'));

  // Ensure active window remains untouched
  assert.equal(res.messages[5].content, 'Edit applied successfully');
  assert.equal(res.messages[7].content, 'Tests passed 100%');

  // Verify round-trip rehydration
  const rehydrated = shaper.rehydrateTurn(res.messages[1].content);
  assert.equal(rehydrated, messages[1].content);
});
