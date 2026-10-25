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

  // INSTANT RESOLUTION: Deliver {} immediately so Antigravity marks tool complete with zero delay
  process.stdout.write('{}');

  let input = {};
  try {
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (raw) input = JSON.parse(raw);
  } catch {
    return;
  }

  const toolName = input.toolCall?.name || '';
  const conversationId = input.conversationId || input.conversation_id || process.env.CONVERSATION_ID || process.env.ANTIGRAVITY_CONVERSATION_ID || 'default';
  const workspacePaths = input.workspacePaths || [];
  const workspaceDir = workspacePaths[0] || process.cwd();

  // Async non-blocking: Fast background syntax pre-flight on edited files
  const filePath = input.toolCall?.args?.Path || input.toolCall?.arguments?.Path || '';
  if (filePath && (toolName === 'edit_file' || toolName === 'write_file')) {
    try {
      const { spawn } = await import('node:child_process');
      const ext = path.extname(filePath);
      const isJs = ['.js', '.mjs', '.cjs'].includes(ext);
      const isPy = ext === '.py';
      const cacheDir = path.join(os.homedir(), '.helix', 'cache');
      try { fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 }); } catch {}
      const syntaxErrorFile = path.join(cacheDir, `${conversationId}.syntax_error`);

      if (isJs && fs.existsSync(filePath)) {
        const child = spawn(process.execPath, ['--check', filePath], { timeout: 1000 });
        let errText = '';
        child.stderr?.on('data', d => errText += d.toString());
        child.on('close', code => {
          if (code !== 0 && errText) {
            fs.writeFileSync(syntaxErrorFile, JSON.stringify({ file: filePath, error: errText.trim().split('\n').slice(0, 3).join('\n'), at: Date.now() }), 'utf8');
          } else {
            try { fs.unlinkSync(syntaxErrorFile); } catch {}
          }
        });
      } else if (isPy && fs.existsSync(filePath)) {
        const child = spawn('python3', ['-m', 'py_compile', filePath], { timeout: 1000 });
        let errText = '';
        child.stderr?.on('data', d => errText += d.toString());
        child.on('close', code => {
          if (code !== 0 && errText) {
            fs.writeFileSync(syntaxErrorFile, JSON.stringify({ file: filePath, error: errText.trim().split('\n').slice(0, 3).join('\n'), at: Date.now() }), 'utf8');
          } else {
            try { fs.unlinkSync(syntaxErrorFile); } catch {}
          }
        });
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
}

main().catch(() => {});
