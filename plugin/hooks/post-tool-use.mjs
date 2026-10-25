#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

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

  // Fast background syntax pre-flight on edited files (<10ms)
  const toolName = input.toolCall?.name || '';
  const filePath = input.toolCall?.args?.Path || input.toolCall?.arguments?.Path || '';
  if (filePath && (toolName === 'edit_file' || toolName === 'write_file')) {
    try {
      const { spawnSync } = await import('node:child_process');
      const ext = path.extname(filePath);
      const isJs = ['.js', '.mjs', '.cjs'].includes(ext);
      const isPy = ext === '.py';
      const cacheDir = path.join(os.homedir(), '.helix', 'cache');
      try { fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 }); } catch {}
      const syntaxErrorFile = path.join(cacheDir, `${conversationId}.syntax_error`);

      if (isJs && fs.existsSync(filePath)) {
        const res = spawnSync(process.execPath, ['--check', filePath], { timeout: 1000, encoding: 'utf8' });
        if (res.status !== 0) {
          const errText = (res.stderr || res.stdout || '').trim().split('\n').slice(0, 3).join('\n');
          fs.writeFileSync(syntaxErrorFile, JSON.stringify({ file: filePath, error: errText, at: Date.now() }), 'utf8');
        } else {
          try { fs.unlinkSync(syntaxErrorFile); } catch {}
        }
      } else if (isPy && fs.existsSync(filePath)) {
        const res = spawnSync('python3', ['-m', 'py_compile', filePath], { timeout: 1000, encoding: 'utf8' });
        if (res.status !== 0) {
          const errText = (res.stderr || res.stdout || '').trim().split('\n').slice(0, 3).join('\n');
          fs.writeFileSync(syntaxErrorFile, JSON.stringify({ file: filePath, error: errText, at: Date.now() }), 'utf8');
        } else {
          try { fs.unlinkSync(syntaxErrorFile); } catch {}
        }
      }
    } catch {}
  }

  // Record verified command pass if exit code was 0 (<2ms)
  if (toolName === 'run_command' && !input.error) {
    try {
      const { Helix2SpeculativeWorker } = await import('/Users/mert/.gemini/antigravity/scratch/HELIX-1.0/src/helix2-speculative-worker.mjs');
      const worker = new Helix2SpeculativeWorker();
      const cmd = input.toolCall?.args?.CommandLine || input.toolCall?.arguments?.CommandLine || '';
      if (cmd) worker.recordVerifiedPass(cmd, workspaceDir, 0);
    } catch {}
  }

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
      const shaper = new Helix2TranscriptShaper({ maxUncompactedBytes: 40 * 1024, retainRecentSteps: 4, archiveThresholdLines: 15 });
      if (shaper.needsShaping(transcriptPath)) {
        shaper.shapeTranscript({ transcriptPath });
      }
    } catch {}
  }

  // Update Engine Circuit Breaker Turn State
  try {
    const candidateBreakers = [
      path.resolve(currentDir, '../src/helix2-engine-circuit-breaker.mjs'),
      path.resolve(currentDir, '../../src/helix2-engine-circuit-breaker.mjs'),
      '/Users/mert/.gemini/antigravity/scratch/HELIX-1.0/src/helix2-engine-circuit-breaker.mjs'
    ];
    const breakerPath = candidateBreakers.find(p => fs.existsSync(p)) || candidateBreakers[0];
    const { Helix2EngineCircuitBreaker } = await import(breakerPath);
    const breaker = new Helix2EngineCircuitBreaker();
    breaker.recordPostToolUse({
      toolCall: input.toolCall,
      error: input.error,
      conversationId,
      workspaceDir
    });
  } catch {}

  // Antigravity PostToolUse contract expects {}
  process.stdout.write(JSON.stringify({}));
}

main().catch(() => {
  process.stdout.write(JSON.stringify({}));
});
