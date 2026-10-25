#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

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
  const transcriptPath = input.transcriptPath;
  const conversationId = input.conversationId || 'default';

  if (!fs.existsSync(workspaceDir) || !transcriptPath || !fs.existsSync(transcriptPath)) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  // Find the latest user message from the transcript
  let latestUserPrompt = '';
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n');
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

  try {
    const { Helix2ContextSharpener } = await import('/Users/mert/.gemini/antigravity/scratch/HELIX-1.0/src/helix2-context-sharpener.mjs');
    const sharpener = new Helix2ContextSharpener();
    const sharpContext = sharpener.shapePreInvocation({
      workspaceDir,
      transcriptPath,
      conversationId,
      latestUserPrompt
    });

    if (sharpContext && sharpContext.trim().length > 0) {
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
