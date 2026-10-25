#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { extractTargetContext } from '/Users/mert/.gemini/antigravity/scratch/HELIX-1.0/harness/helix2.3-ast-inliner.mjs';

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
    const astSnippet = extractTargetContext(workspaceDir, latestUserPrompt);
    if (astSnippet && astSnippet.trim().length > 0) {
      const systemMessage = (
        `[HELIX 2.3c PROTOCOL ACTIVATED]\n` +
        astSnippet +
        `\nInstructions: The target locus has been resolved above with 100% precision.\n` +
        `Inspect surrounding lines or formulate your minimal edit directly without repository-wide search.`
      );

      const output = {
        injectSteps: [
          {
            systemMessage: {
              systemMessage
            }
          }
        ]
      };
      process.stdout.write(JSON.stringify(output));
      return;
    }
  } catch (e) {}

  process.stdout.write(JSON.stringify({}));
}

main().catch(() => {
  process.stdout.write(JSON.stringify({}));
});
