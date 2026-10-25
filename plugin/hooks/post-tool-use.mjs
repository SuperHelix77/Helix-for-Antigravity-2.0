#!/usr/bin/env node
import fs from 'node:fs';

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

  const workspacePaths = input.workspacePaths || [];
  const workspaceDir = workspacePaths[0] || process.cwd();
  const transcriptPath = input.transcriptPath;
  const conversationId = input.conversationId || 'default';

  if (transcriptPath && fs.existsSync(transcriptPath)) {
    try {
      const { Helix2ContextSharpener } = await import('/Users/mert/.gemini/antigravity/scratch/HELIX-1.0/src/helix2-context-sharpener.mjs');
      const sharpener = new Helix2ContextSharpener();
      sharpener.evacuateStaleContext({
        workspaceDir,
        transcriptPath,
        conversationId
      });
    } catch {}

    // Auto-shape transcript if it exceeds bounded limit (Solution A: O(1) auto-compaction)
    try {
      const { Helix2TranscriptShaper } = await import('/Users/mert/.gemini/antigravity/scratch/HELIX-1.0/src/helix2-transcript-shaper.mjs');
      const shaper = new Helix2TranscriptShaper({ maxUncompactedBytes: 500 * 1024, retainRecentSteps: 25 });
      if (shaper.needsShaping(transcriptPath)) {
        await shaper.shapeTranscript({ transcriptPath });
      }
    } catch {}
  }

  // Antigravity PostToolUse contract expects {}
  process.stdout.write(JSON.stringify({}));
}

main().catch(() => {
  process.stdout.write(JSON.stringify({}));
});
