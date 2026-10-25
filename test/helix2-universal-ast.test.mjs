import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { extractTargetContext } from '../src/helix2-ast-inliner.mjs';

test('Universal AST Engine: Multi-language Symbol Extraction', (t) => {
  // 1. Python Class + Method
  const tmpPy = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-ast-py-'));
  const pyDir = path.join(tmpPy, 'mypkg');
  fs.mkdirSync(pyDir, { recursive: true });
  fs.writeFileSync(path.join(pyDir, 'models.py'), `
class CustomerAccount:
    def __init__(self, name):
        self.name = name

    def calculate_discount(self, percent):
        return self.balance * (percent / 100)
`);

  const pyPrompt = 'Fix calculate_discount in CustomerAccount when percent is negative';
  const pyExtracted = extractTargetContext(tmpPy, pyPrompt);
  assert.ok(pyExtracted.includes('[HELIX UNIVERSAL 100% AST TARGET]'), 'Python class+method must be extracted');
  assert.ok(pyExtracted.includes('CustomerAccount.calculate_discount'));
  assert.ok(pyExtracted.includes('```python'));

  // 2. JavaScript / TypeScript Class & Exported Function
  const tmpTs = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-ast-ts-'));
  const jsDir = path.join(tmpTs, 'src');
  fs.mkdirSync(jsDir, { recursive: true });
  fs.writeFileSync(path.join(jsDir, 'token-engine.ts'), `
export class TokenEngine {
  constructor(private budget: number) {}

  public pruneContextWindow(tokens: number): number {
    return Math.max(0, this.budget - tokens);
  }
}

export function formatTokenReceipt(id: string): string {
  return "receipt:" + id;
}
`);

  const tsPrompt = 'Explain how pruneContextWindow works in TokenEngine';
  const tsExtracted = extractTargetContext(tmpTs, tsPrompt);
  assert.ok(tsExtracted.includes('[HELIX UNIVERSAL 100% AST TARGET]'), 'TypeScript class+method must be extracted');
  assert.ok(tsExtracted.includes('TokenEngine.pruneContextWindow'));
  assert.ok(tsExtracted.includes('```typescript'));

  // 3. Unique Function Match (formatTokenReceipt)
  const fnPrompt = 'Update formatTokenReceipt to return json';
  const fnExtracted = extractTargetContext(tmpTs, fnPrompt);
  assert.ok(fnExtracted.includes('[HELIX UNIVERSAL 100% AST TARGET]'), 'Unique top-level function must be extracted');
  assert.ok(fnExtracted.includes('formatTokenReceipt'));

  // 4. Node.js Stack Trace Locus
  const nodeTrace = `
Error: Context overflow
    at TokenEngine.pruneContextWindow (${path.join(jsDir, 'token-engine.ts')}:6:12)
    at runTest (/tmp/runner.js:10:5)
`;
  const tbExtracted = extractTargetContext(tmpTs, nodeTrace);
  assert.ok(tbExtracted.includes('[HELIX UNIVERSAL 100% AST TARGET]'), 'Node.js stack trace locus must be extracted');
  assert.ok(tbExtracted.includes('CORROBORATED_TRACEBACK_CRASH_LOCUS'));

  fs.rmSync(tmpPy, { recursive: true, force: true });
  fs.rmSync(tmpTs, { recursive: true, force: true });
});
