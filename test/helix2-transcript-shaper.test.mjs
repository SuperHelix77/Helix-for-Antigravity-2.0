import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Helix2TranscriptShaper } from '../src/helix2-transcript-shaper.mjs';

test('Helix2TranscriptShaper safely shapes older transcript lines while preserving full raw history', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-shaper-test-'));
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  const fullTranscriptPath = path.join(tmpDir, 'transcript_full.jsonl');

  // Create synthetic transcript with 10 lines
  const lines = [];
  for (let i = 0; i < 10; i++) {
    if (i % 2 === 0) {
      lines.push(JSON.stringify({
        step_index: i,
        type: 'PLANNER_RESPONSE',
        thinking: 'This is a very long thinking block '.repeat(20),
        tool_calls: [{ name: 'run_command', arguments: { CommandLine: 'npm test' } }]
      }));
    } else {
      lines.push(JSON.stringify({
        step_index: i,
        type: 'GENERIC',
        content: 'This is very verbose command output line from tests '.repeat(30)
      }));
    }
  }

  fs.writeFileSync(transcriptPath, lines.join('\n') + '\n');
  fs.writeFileSync(fullTranscriptPath, lines.join('\n') + '\n');

  const shaper = new Helix2TranscriptShaper({ retainRecentSteps: 3 });
  const res = await shaper.shapeTranscript({
    transcriptPath,
    fullTranscriptPath,
    retainRecentSteps: 3
  });

  assert.equal(res.status, 'shaped');
  assert.ok(res.savedBytes > 0, 'Should have saved bytes');

  // Verify shaped transcript
  const shapedContent = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n');
  assert.equal(shapedContent.length, 10, 'Should keep exact same line count');

  // First line (older) should have truncated_fields
  const line0 = JSON.parse(shapedContent[0]);
  assert.ok(line0.truncated_fields.includes('thinking'));
  assert.ok(line0.thinking.length < 150);

  const line1 = JSON.parse(shapedContent[1]);
  assert.ok(line1.truncated_fields.includes('content'));
  assert.ok(line1.content.includes('[helix:raw]'));

  // Last 3 lines (recent) must be 100% UNMODIFIED
  const lastLine = JSON.parse(shapedContent[9]);
  assert.equal(lastLine.truncated_fields, undefined);
  assert.ok(lastLine.content.length > 500);

  // Full transcript must remain 100% complete and uncompressed
  const fullContent = fs.readFileSync(fullTranscriptPath, 'utf8').trim().split('\n');
  const fullLine1 = JSON.parse(fullContent[1]);
  assert.equal(fullLine1.truncated_fields, undefined);
  assert.ok(fullLine1.content.length > 500);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
