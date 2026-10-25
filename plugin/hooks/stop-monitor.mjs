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

  const conversationId = input.conversationId || input.conversation_id || process.env.CONVERSATION_ID || process.env.ANTIGRAVITY_CONVERSATION_ID || 'default';
  
  // Robust transcript path resolution
  const brainDir = path.join(os.homedir(), '.gemini/antigravity/brain');
  let transcriptPath = input.transcriptPath || input.transcript_path;
  if (!transcriptPath && conversationId && conversationId !== 'default') {
    const candidate = path.join(brainDir, conversationId, '.system_generated/logs/transcript.jsonl');
    if (fs.existsSync(candidate)) transcriptPath = candidate;
  }
  if (!transcriptPath && fs.existsSync(brainDir)) {
    try {
      const convs = fs.readdirSync(brainDir).filter(c => !c.startsWith('.'));
      let newest = null, newestMtime = 0;
      for (const conv of convs) {
        const cand = path.join(brainDir, conv, '.system_generated/logs/transcript.jsonl');
        if (fs.existsSync(cand)) {
          const mtime = fs.statSync(cand).mtimeMs;
          if (mtime > newestMtime) { newestMtime = mtime; newest = cand; }
        }
      }
      if (newest && Date.now() - newestMtime < 15 * 60 * 1000) transcriptPath = newest;
    } catch {}
  }

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

    // 2. Automated transcript compaction & prompt-cache chunk sync (<15ms synchronous)
    try {
      const { Helix2TranscriptShaper } = await import('/Users/mert/.gemini/antigravity/scratch/HELIX-1.0/src/helix2-transcript-shaper.mjs');
      const shaper = new Helix2TranscriptShaper({ maxUncompactedBytes: 40 * 1024, retainRecentSteps: 4, archiveThresholdLines: 15 });
      if (shaper.needsShaping(transcriptPath)) {
        shaper.shapeTranscript({ transcriptPath });
      }
    } catch {}
  }

  // Antigravity Stop contract: allow normal termination or continuation
  process.stdout.write(JSON.stringify({ decision: 'allow' }));
}

main().catch(() => {
  process.stdout.write(JSON.stringify({ decision: 'allow' }));
});
