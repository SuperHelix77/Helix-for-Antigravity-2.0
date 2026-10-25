import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Helix2SpeculativePreAnalyzer } from '../src/helix2-speculative-pre-analyzer.mjs';

test('Helix2SpeculativePreAnalyzer detects target file and symbol locus from prompt', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix2-spec-test-'));
  const testFile = path.join(tmpDir, 'calculator.js');
  fs.writeFileSync(testFile, `
function add(a, b) {
  return a + b;
}

function multiply(a, b) {
  return a * b;
}
`, 'utf8');

  const analyzer = new Helix2SpeculativePreAnalyzer();
  const analysis = analyzer.analyzeWorkspace({
    workspaceDir: tmpDir,
    userPrompt: 'Please fix calculator.js in function multiply(a, b)'
  });

  assert.ok(analysis);
  assert.ok(analysis.includes('[HELIX SPECULATIVE PRE-ANALYSIS]'));
  assert.ok(analysis.includes('multiply'));
  assert.ok(analysis.includes('calculator.js'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Helix2SpeculativePreAnalyzer detects git status and diff', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix2-spec-git-'));
  execFileSync('git', ['init'], { cwd: tmpDir });
  execFileSync('git', ['config', 'user.name', 'Helix'], { cwd: tmpDir });
  execFileSync('git', ['config', 'user.email', 'helix@example.com'], { cwd: tmpDir });

  const testFile = path.join(tmpDir, 'file.txt');
  fs.writeFileSync(testFile, 'initial line\n', 'utf8');
  execFileSync('git', ['add', 'file.txt'], { cwd: tmpDir });
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: tmpDir });

  // Modify file
  fs.writeFileSync(testFile, 'modified line\n', 'utf8');

  const analyzer = new Helix2SpeculativePreAnalyzer();
  const analysis = analyzer.analyzeWorkspace({
    workspaceDir: tmpDir,
    userPrompt: 'What is the status?'
  });

  assert.ok(analysis);
  assert.ok(analysis.includes('Working Tree: 1 changed file'));
  assert.ok(analysis.includes('file.txt'));
  assert.ok(analysis.includes('modified line'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Helix2SpeculativePreAnalyzer detects last tool failure in transcript', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix2-spec-trans-'));
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  
  const entries = [
    { type: 'USER_INPUT', content: 'run tests' },
    { type: 'PLANNER_RESPONSE', content: 'Command exited with code 1.\nError: AssertionError [ERR_ASSERTION]: Expected true but got false' }
  ];
  fs.writeFileSync(transcriptPath, entries.map(e => JSON.stringify(e)).join('\n'), 'utf8');

  const analyzer = new Helix2SpeculativePreAnalyzer();
  const analysis = analyzer.analyzeWorkspace({
    workspaceDir: tmpDir,
    userPrompt: 'fix the bug',
    transcriptPath
  });

  assert.ok(analysis);
  assert.ok(analysis.includes('Last Command Failure (exit 1)'));
  assert.ok(analysis.includes('AssertionError'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
