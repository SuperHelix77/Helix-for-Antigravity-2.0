import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Helix2AstIndexer } from '../src/helix2-ast-indexer.mjs';

test('Helix2AstIndexer extracts Python functions and classes accurately', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix2-ast-py-'));
  const pyFile = path.join(tmpDir, 'example.py');
  
  const pyCode = `import os

def helper_one():
    return 1

class TargetWidget:
    """Widget class docstring."""
    def __init__(self, name):
        self.name = name

    def render(self):
        return f"<div>{self.name}</div>"

def helper_two():
    x = 10
    return x * 2
`;
  fs.writeFileSync(pyFile, pyCode, 'utf8');

  const indexer = new Helix2AstIndexer();

  const fnResult = indexer.extractSymbol(pyFile, 'helper_one');
  assert.ok(fnResult, 'Expected helper_one to be found');
  assert.equal(fnResult.symbol, 'helper_one');
  assert.equal(fnResult.startLine, 3);
  assert.equal(fnResult.endLine, 4);
  assert.ok(fnResult.code.includes('return 1'));

  const classResult = indexer.extractSymbol(pyFile, 'TargetWidget');
  assert.ok(classResult, 'Expected TargetWidget to be found');
  assert.equal(classResult.symbol, 'TargetWidget');
  assert.equal(classResult.startLine, 6);
  assert.equal(classResult.endLine, 12);
  assert.ok(classResult.code.includes('def render(self):'));

  const missing = indexer.extractSymbol(pyFile, 'non_existent_func');
  assert.equal(missing, null);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Helix2AstIndexer extracts JavaScript/TypeScript functions and classes accurately', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix2-ast-js-'));
  const jsFile = path.join(tmpDir, 'sample.mjs');

  const jsCode = `export function calculateMetric(a, b) {
  const sum = a + b;
  return sum * 2;
}

export class Engine {
  start() {
    return true;
  }
}
`;
  fs.writeFileSync(jsFile, jsCode, 'utf8');

  const indexer = new Helix2AstIndexer();

  const fnResult = indexer.extractSymbol(jsFile, 'calculateMetric');
  assert.ok(fnResult);
  assert.equal(fnResult.symbol, 'calculateMetric');
  assert.equal(fnResult.startLine, 1);
  assert.equal(fnResult.endLine, 4);
  assert.ok(fnResult.code.includes('return sum * 2;'));

  const classResult = indexer.extractSymbol(jsFile, 'Engine');
  assert.ok(classResult);
  assert.equal(classResult.symbol, 'Engine');
  assert.equal(classResult.startLine, 6);
  assert.equal(classResult.endLine, 10);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
