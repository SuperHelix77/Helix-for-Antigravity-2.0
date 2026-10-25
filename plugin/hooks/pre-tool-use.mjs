#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LEAN_TARGET_REGEX = /(?:npm\s+(?:test|run\s+build|install|ci)|npx\s+(?:test|build)|node\s+--test|pytest|cargo\s+(?:test|build)|git\s+(?:diff|status|log)|vitest|jest|make\s+(?:test|build)|mvn\s+(?:test|compile)|gradle\s+(?:test|build)|vite\s+build|tsc\b|\b(?:env|printenv)\b)/i;
const BINARY_EXT_REGEX = /\.(?:wasm|sqlite|sqlite3|db|bin|exe|pyc|class|so|dylib|dll|png|jpg|jpeg|gif|ico|webp|pdf|zip|tar|gz)$/i;
const LOCKFILE_OR_MIN_REGEX = /(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|\.min\.(?:js|css)|\.map)$/i;

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const fastLeanRunner = path.resolve(currentDir, '../bin/helix-fast-lean.mjs');

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
    process.stdout.write('{"decision":"allow"}');
    return;
  }

  const toolCall = input.toolCall;
  if (!toolCall || !toolCall.name) {
    process.stdout.write('{"decision":"allow"}');
    return;
  }

  const toolName = toolCall.name;
  const args = toolCall.args || toolCall.arguments || {};

  // Fast path: read_file line and binary bounds
  if (toolName === 'read_file') {
    const filePath = args.Path || args.path || args.file_path || '';
    const start = typeof args.StartLine === 'number' ? args.StartLine : (args.StartLine ? parseInt(args.StartLine, 10) : 1);
    const end = typeof args.EndLine === 'number' ? args.EndLine : (args.EndLine ? parseInt(args.EndLine, 10) : null);

    if (BINARY_EXT_REGEX.test(filePath)) {
      process.stdout.write(JSON.stringify({ decision: 'allow', overwrite: { StartLine: 1, EndLine: 1 } }));
      return;
    }

    if (LOCKFILE_OR_MIN_REGEX.test(filePath)) {
      const boundEnd = Math.min(end !== null ? end : start + 24, start + 24);
      process.stdout.write(JSON.stringify({ decision: 'allow', overwrite: { StartLine: start, EndLine: boundEnd } }));
      return;
    }

    if (end === null) {
      process.stdout.write(JSON.stringify({ decision: 'allow', overwrite: { StartLine: start, EndLine: start + 299 } }));
      return;
    } else if (end - start > 350) {
      process.stdout.write(JSON.stringify({ decision: 'allow', overwrite: { EndLine: start + 300 } }));
      return;
    }

    process.stdout.write('{"decision":"allow"}');
    return;
  }

  // Fast path: run_command lean switch wrapping
  if (toolName === 'run_command') {
    const cmd = (args.CommandLine || '').trim();
    if (cmd && !cmd.includes('helix-fast-lean') && !cmd.startsWith('helix lean') && LEAN_TARGET_REGEX.test(cmd)) {
      const isWin = process.platform === 'win32';
      const escapedCmd = isWin
        ? cmd.replace(/"/g, '""')
        : cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const overwrittenCmd = isWin
        ? `node "${fastLeanRunner}" -- ${cmd}`
        : `node "${fastLeanRunner}" -- "${escapedCmd}"`;

      process.stdout.write(JSON.stringify({ decision: 'allow', overwrite: { CommandLine: overwrittenCmd } }));
      return;
    }

    process.stdout.write('{"decision":"allow"}');
    return;
  }

  // Fast path: invoke_subagent model tier guard
  if (toolName === 'invoke_subagent') {
    const model = args.Model;
    if (!model || model === 'inherit' || model === 'pro') {
      process.stdout.write(JSON.stringify({ decision: 'allow', overwrite: { Model: 'flash' } }));
      return;
    }
    process.stdout.write('{"decision":"allow"}');
    return;
  }

  // Default instant allow
  process.stdout.write('{"decision":"allow"}');
}

main().catch(() => {
  process.stdout.write('{"decision":"allow"}');
});
