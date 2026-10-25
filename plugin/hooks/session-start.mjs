#!/usr/bin/env node
import fs from 'node:fs';

/**
 * Helix SessionStart Hook
 * 
 * Automatically initializes HELIX 2.0 when a user starts any chat session.
 * 1. Prepares SQLite memory and token audit tables.
 * 2. Purges stale cache bloat and syncs chunks if resuming an existing conversation.
 * 3. Operates completely in the background with zero token cost and sub-3ms latency.
 */
async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  let input = {};
  try {
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (raw) input = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const transcriptPath = input.transcriptPath;
  const conversationId = input.conversationId || 'default';

  try {
    // 1. Ensure SQLite memory and token audit tables are initialized
    const { Helix2TokenMonitor } = await import('/Users/mert/.gemini/antigravity/scratch/HELIX-1.0/src/helix2-token-monitor.mjs');
    new Helix2TokenMonitor();
  } catch {}

  // 2. If resuming a session with an existing transcript, shape and sync prompt-cache chunks immediately
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    try {
      const { Helix2TranscriptShaper } = await import('/Users/mert/.gemini/antigravity/scratch/HELIX-1.0/src/helix2-transcript-shaper.mjs');
      const shaper = new Helix2TranscriptShaper({ maxUncompactedBytes: 300 * 1024, retainRecentSteps: 8 });
      if (shaper.needsShaping(transcriptPath)) {
        await shaper.shapeTranscript({ transcriptPath });
      }
    } catch {}
  }

  // Antigravity SessionStart contract
  process.stdout.write(JSON.stringify({}));
}

main().catch(() => {
  process.stdout.write(JSON.stringify({}));
});
