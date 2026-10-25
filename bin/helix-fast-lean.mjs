#!/usr/bin/env node
import { spawn } from 'node:child_process';

const cmdArgs = process.argv.slice(2);
if (cmdArgs[0] === '--') cmdArgs.shift();
const fullCmd = cmdArgs.join(' ');

if (!fullCmd) {
  process.exit(1);
}

const child = spawn(fullCmd, { shell: true, stdio: ['inherit', 'pipe', 'pipe'] });
let stdout = '';
let stderr = '';

child.stdout.on('data', d => stdout += d.toString());
child.stderr.on('data', d => stderr += d.toString());

child.on('close', async (code) => {
  const combined = (stdout + (stderr ? '\n' + stderr : '')).trim();
  if (!combined || combined.length < 256) {
    if (combined) process.stdout.write(combined + '\n');
    process.exit(code);
  }

  try {
    const { HelixLeanSwitch } = await import('../src/helix-lean-switch.mjs');
    const lean = new HelixLeanSwitch();
    const shaped = lean.shapeCommandOutput(combined, { command: fullCmd, exitCode: code, toolName: 'run_command' });
    process.stdout.write((shaped.output || combined) + '\n');
  } catch {
    process.stdout.write(combined + '\n');
  }
  process.exit(code);
});
