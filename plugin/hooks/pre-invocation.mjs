#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  let input = {};
  try {
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (raw) input = JSON.parse(raw);
  } catch (e) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const workspacePaths = input.workspacePaths || [];
  const workspaceDir = workspacePaths[0] || process.cwd();
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

  if (!fs.existsSync(workspaceDir) || !transcriptPath || !fs.existsSync(transcriptPath)) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  // Optimization 2: Fast 32KB Reverse Tail Seek (Zero full-file transcript read overhead)
  let latestUserPrompt = '';
  try {
    const stat = fs.statSync(transcriptPath);
    const readSize = Math.min(stat.size, 32768);
    const buffer = Buffer.alloc(readSize);
    const fd = fs.openSync(transcriptPath, 'r');
    fs.readSync(fd, buffer, 0, readSize, Math.max(0, stat.size - readSize));
    fs.closeSync(fd);
    const tailContent = buffer.toString('utf8');
    const lines = tailContent.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const item = JSON.parse(lines[i]);
        if (item.type === 'USER_INPUT' && item.content) {
          latestUserPrompt = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
          break;
        }
      } catch (e) {}
    }
  } catch (e) {}

  if (!latestUserPrompt) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  // Launch non-blocking background speculative execution concurrently while model is thinking (<1ms)
  try {
    const { Helix2SpeculativeWorker } = await import('/Users/mert/.gemini/antigravity/scratch/HELIX-1.0/src/helix2-speculative-worker.mjs');
    const worker = new Helix2SpeculativeWorker();
    worker.launchSpeculativePreFlight({
      workspaceDir,
      userPrompt: latestUserPrompt,
      conversationId
    });
  } catch {}

  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(__dirname, '../../src/helix2-context-sharpener.mjs'),
      path.resolve(__dirname, '../src/helix2-context-sharpener.mjs'),
      '/Users/mert/.gemini/antigravity/scratch/HELIX-1.0/src/helix2-context-sharpener.mjs'
    ];
    let sharpenerPath = candidates.find(p => fs.existsSync(p)) || candidates[0];
    const { Helix2ContextSharpener } = await import(sharpenerPath);
    const sharpener = new Helix2ContextSharpener();
    const sharpContext = sharpener.shapePreInvocation({
      workspaceDir,
      transcriptPath,
      conversationId,
      latestUserPrompt
    });

    if (sharpContext && sharpContext.trim().length > 0) {
      let astInlinedFile = null;
      const astMatch = sharpContext.match(/\[HELIX UNIVERSAL 100% AST TARGET\][\s\S]*?File:\s*([^\s(]+)/);
      if (astMatch) astInlinedFile = astMatch[1];

      try {
        const candidateBreakers = [
          path.resolve(__dirname, '../src/helix2-engine-circuit-breaker.mjs'),
          path.resolve(__dirname, '../../src/helix2-engine-circuit-breaker.mjs'),
          '/Users/mert/.gemini/antigravity/scratch/HELIX-1.0/src/helix2-engine-circuit-breaker.mjs'
        ];
        const breakerPath = candidateBreakers.find(p => fs.existsSync(p)) || candidateBreakers[0];
        const { Helix2EngineCircuitBreaker } = await import(breakerPath);
        const breaker = new Helix2EngineCircuitBreaker();
        breaker.initTurn({
          conversationId,
          workspaceDir,
          userPrompt: latestUserPrompt,
          astInlinedFile,
          invocationNum: input.invocationNum ?? 0
        });
      } catch {}

      const output = {
        injectSteps: [
          {
            ephemeralMessage: sharpContext
          }
        ]
      };
      process.stdout.write(JSON.stringify(output));
      return;
    }
  } catch (e) {
    // Fallback: minimal AST extraction if sharpener encounters any issue
    try {
      const { extractTargetContext } = await import('./ast-inliner.mjs');
      const astSnippet = extractTargetContext(workspaceDir, latestUserPrompt);
      if (astSnippet && astSnippet.trim().length > 0) {
        const output = {
          injectSteps: [
            {
              ephemeralMessage: `[HELIX 2.0 PROTOCOL ACTIVATED]\n${astSnippet}`
            }
          ]
        };
        process.stdout.write(JSON.stringify(output));
        return;
      }
    } catch {}
  }

  process.stdout.write(JSON.stringify({}));
}

main().catch(() => {
  process.stdout.write(JSON.stringify({}));
});
