#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Helix2ContextSharpener } from '../src/helix2-context-sharpener.mjs';
import { Helix2SpeculativeWorker } from '../src/helix2-speculative-worker.mjs';

const sharpener = new Helix2ContextSharpener();
const worker = new Helix2SpeculativeWorker();

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
    process.stdout.write('{}');
    return;
  }

  const workspacePaths = input.workspacePaths || [];
  const workspaceDir = workspacePaths[0] || process.cwd();
  const conversationId = input.conversationId || input.conversation_id || process.env.CONVERSATION_ID || process.env.ANTIGRAVITY_CONVERSATION_ID || 'default';

  // Fast direct transcript resolution
  const brainDir = path.join(os.homedir(), '.gemini/antigravity/brain');
  let transcriptPath = input.transcriptPath || input.transcript_path;
  if (!transcriptPath && conversationId && conversationId !== 'default') {
    const candidate = path.join(brainDir, conversationId, '.system_generated/logs/transcript.jsonl');
    if (fs.existsSync(candidate)) transcriptPath = candidate;
  }

  if (!fs.existsSync(workspaceDir) || !transcriptPath || !fs.existsSync(transcriptPath)) {
    process.stdout.write('{}');
    return;
  }

  // Fast 32KB Reverse Tail Seek (<0.2ms)
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
    process.stdout.write('{}');
    return;
  }

  // Non-blocking speculative preflight
  try {
    worker.launchSpeculativePreFlight({
      workspaceDir,
      userPrompt: latestUserPrompt,
      conversationId
    });
  } catch {}

  try {
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
  } catch (e) {}

  process.stdout.write('{}');
}

main().catch(() => {
  process.stdout.write('{}');
});
