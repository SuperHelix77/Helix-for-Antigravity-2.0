#!/usr/bin/env node
import fs from 'node:fs';

/**
 * Helix Stop/Turn Completion Hook
 * 
 * Automatically audits token usage and updates prompt cache in the background:
 * 1. Records step token metrics into local SQLite token ledger with zero LLM calls.
 * 2. Runs fast auto-compaction and chunk synchronization if threshold reached.
 * 3. Completes in < 3ms with zero cost.
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
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
    return;
  }

  const transcriptPath = input.transcriptPath;
  const conversationId = input.conversationId || 'default';

  if (transcriptPath && fs.existsSync(transcriptPath)) {
    // 1. Record step metrics into zero-cost offline SQLite token ledger
    try {
      const { Helix2TokenMonitor } = await import('/Users/mert/.gemini/antigravity/scratch/HELIX-1.0/src/helix2-token-monitor.mjs');
      const monitor = new Helix2TokenMonitor();
      monitor.recordStepMetrics({
        transcriptPath,
        conversationId
      });
    } catch {}

    // 2. Check if transcript or prompt-cache chunks need compaction/syncing
    try {
      const { Helix2TranscriptShaper } = await import('/Users/mert/.gemini/antigravity/scratch/HELIX-1.0/src/helix2-transcript-shaper.mjs');
      const shaper = new Helix2TranscriptShaper({ maxUncompactedBytes: 300 * 1024, retainRecentSteps: 8 });
      if (shaper.needsShaping(transcriptPath)) {
        await shaper.shapeTranscript({ transcriptPath });
      }
    } catch {}
  }

  // Antigravity Stop contract: allow normal termination or continuation
  process.stdout.write(JSON.stringify({ decision: 'allow' }));
}

main().catch(() => {
  process.stdout.write(JSON.stringify({ decision: 'allow' }));
});
