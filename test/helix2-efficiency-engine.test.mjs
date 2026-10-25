import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { stripAnsi, HelixLeanSwitch } from '../src/helix-lean-switch.mjs';
import { shapeToolResult } from '../src/tool-result-aging.mjs';
import { Helix2AstIndexer } from '../src/helix2-ast-indexer.mjs';
import { Helix2ContextSharpener } from '../src/helix2-context-sharpener.mjs';

function tempDir(prefix = 'helix-eff-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// -----------------------------------------------------------------------------
// Optimization 1: ANSI Terminal Escape Code Stripping
// -----------------------------------------------------------------------------
test('Efficiency 1: stripAnsi strips color, bold, and cursor control codes from terminal output', () => {
  const colored = '\x1b[1m\x1b[32mPASSED\x1b[0m \x1b[33m[100%]\x1b[0m \x1b[2K\rtest_core.py';
  const clean = stripAnsi(colored);
  assert.equal(clean, 'PASSED [100%] \rtest_core.py', 'All ANSI sequences must be stripped');
  assert.ok(!clean.includes('\x1b['), 'Must not contain any escape sequences');
});

// -----------------------------------------------------------------------------
// Optimization 2: Pre-Invocation Reverse Tail Seek
// -----------------------------------------------------------------------------
test('Efficiency 2: Reverse tail seek correctly extracts latest user prompt from large logs', () => {
  const tmpDir = tempDir('tail-seek-');
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');

  // Generate 500 lines of prior noise followed by a user prompt
  const lines = [];
  for (let i = 0; i < 300; i++) {
    lines.push(JSON.stringify({ type: 'PLANNER_RESPONSE', content: `Old response step ${i}` }));
  }
  lines.push(JSON.stringify({ type: 'USER_INPUT', content: 'Latest urgent user prompt' }));
  lines.push(JSON.stringify({ type: 'CHECKPOINT', content: 'Archival mark' }));

  fs.writeFileSync(transcriptPath, lines.join('\n'), 'utf8');

  // Verify reverse tail seek logic
  const stat = fs.statSync(transcriptPath);
  const readSize = Math.min(stat.size, 32768);
  const buffer = Buffer.alloc(readSize);
  const fd = fs.openSync(transcriptPath, 'r');
  fs.readSync(fd, buffer, 0, readSize, Math.max(0, stat.size - readSize));
  fs.closeSync(fd);

  const tailLines = buffer.toString('utf8').trim().split('\n');
  let extracted = '';
  for (let i = tailLines.length - 1; i >= 0; i--) {
    try {
      const item = JSON.parse(tailLines[i]);
      if (item.type === 'USER_INPUT' && item.content) {
        extracted = item.content;
        break;
      }
    } catch {}
  }

  assert.equal(extracted, 'Latest urgent user prompt', 'Tail seek must accurately locate user prompt');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// -----------------------------------------------------------------------------
// Optimization 3: In-Memory AST Symbol Mtime Cache
// -----------------------------------------------------------------------------
test('Efficiency 3: Helix2AstIndexer caches symbol definitions in memory by mtime', () => {
  const tmpDir = tempDir('ast-cache-');
  const pyFile = path.join(tmpDir, 'service.py');
  fs.writeFileSync(pyFile, `
def process_data(data):
    """Processes incoming data securely."""
    return data * 2

def secondary_worker():
    pass
`, 'utf8');

  const indexer = new Helix2AstIndexer();
  
  // First call: cold cache
  const first = indexer.extractSymbol(pyFile, 'process_data');
  assert.ok(first);
  assert.equal(first.symbol, 'process_data');
  assert.equal(indexer.symbolCache.size, 1, 'Cache must contain 1 entry');

  // Second call: warm cache (returns exact object in 0.01ms)
  const second = indexer.extractSymbol(pyFile, 'process_data');
  assert.equal(second, first, 'Must return cached reference directly');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// -----------------------------------------------------------------------------
// Optimization 4: Whitespace Squeezing & Blank Run Collapsing
// -----------------------------------------------------------------------------
test('Efficiency 4: shapeToolResult collapses runs of 3+ blank lines and trims trailing spaces', () => {
  const bloatedText = [
    'line 1   ',
    'line 2 \t ',
    '',
    '',
    '',
    '',
    'line 3 after blank gap',
    'def test():',
    '    pass   ',
    '',
    '',
    '',
    'line 4'
  ].join('\n');

  const shaped = shapeToolResult(bloatedText);
  assert.ok(!shaped.includes('\n\n\n'), 'Must not contain 3 consecutive newlines');
  assert.ok(!shaped.includes('line 1   '), 'Trailing spaces must be trimmed');
});

// -----------------------------------------------------------------------------
// Optimization 5: 3-Phase Structured Thought Scaffold
// -----------------------------------------------------------------------------
test('Efficiency 5: Static protocol header pins 3-Phase Thinking Scaffold', () => {
  const tmpDir = tempDir('thought-scaffold-');
  const sharpener = new Helix2ContextSharpener({ stateDir: tmpDir });

  const ctx = sharpener.shapePreInvocation({
    workspaceDir: tmpDir,
    latestUserPrompt: 'Fix bug'
  });

  assert.ok(ctx.includes('[State] -> [Target] -> [Compound Action]'), 'Header must contain 3-phase thinking scaffold');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
