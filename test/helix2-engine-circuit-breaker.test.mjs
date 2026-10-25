import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Helix2EngineCircuitBreaker } from '../src/helix2-engine-circuit-breaker.mjs';

// =============================================================================
// PreToolUse: allow + overwrite only, NEVER deny
// =============================================================================

test('PreToolUse: read_file unbounded → overwrite to 300 lines (never deny)', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-cb-'));
  const breaker = new Helix2EngineCircuitBreaker({ stateDir: tmpDir });

  // Unbounded read → bounded to 300
  const res1 = breaker.checkPreToolUse({
    toolCall: { name: 'read_file', args: { Path: '/any/file.py' } }
  });
  assert.equal(res1.decision, 'allow');
  assert.equal(res1.overwrite.StartLine, 1);
  assert.equal(res1.overwrite.EndLine, 300);

  // Bounded read within range → no overwrite
  const res2 = breaker.checkPreToolUse({
    toolCall: { name: 'read_file', args: { Path: '/any/file.py', StartLine: 10, EndLine: 50 } }
  });
  assert.equal(res2.decision, 'allow');
  assert.equal(res2.overwrite, undefined);

  // Oversized read → bounded
  const res3 = breaker.checkPreToolUse({
    toolCall: { name: 'read_file', args: { Path: '/any/file.py', StartLine: 1, EndLine: 800 } }
  });
  assert.equal(res3.decision, 'allow');
  assert.equal(res3.overwrite.EndLine, 301);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('PreToolUse: read_file is ALWAYS allowed even with AST pre-resolved or post-mutation', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-cb-'));
  const breaker = new Helix2EngineCircuitBreaker({ stateDir: tmpDir });
  const convId = 'test-no-deny';

  // Set up state: AST inlined + mutation applied
  breaker.initTurn({
    conversationId: convId,
    workspaceDir: tmpDir,
    userPrompt: 'Fix bug in service.py',
    astInlinedFile: 'src/service.py'
  });
  breaker.recordPostToolUse({
    toolCall: { name: 'edit_file', args: { Path: 'src/service.py' } },
    conversationId: convId,
    workspaceDir: tmpDir
  });

  // read_file on the AST-resolved file → ALLOWED (not denied!)
  const res = breaker.checkPreToolUse({
    toolCall: { name: 'read_file', args: { Path: 'src/service.py' } },
    conversationId: convId
  });
  assert.equal(res.decision, 'allow', 'Must be allow, never deny');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('PreToolUse: run_command wraps verbose commands with lean switch', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-cb-'));
  const breaker = new Helix2EngineCircuitBreaker({ stateDir: tmpDir });

  const res = breaker.checkPreToolUse({
    toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } },
    leanRunner: '/path/to/helix.mjs'
  });
  assert.equal(res.decision, 'allow');
  assert.ok(res.overwrite?.CommandLine.includes('helix.mjs'));
  assert.ok(res.overwrite?.CommandLine.includes('lean'));

  // Non-verbose command → no overwrite
  const res2 = breaker.checkPreToolUse({
    toolCall: { name: 'run_command', args: { CommandLine: 'echo hello' } }
  });
  assert.equal(res2.decision, 'allow');
  assert.equal(res2.overwrite, undefined);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('PreToolUse: standalone cat/grep is ALLOWED (no deny)', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-cb-'));
  const breaker = new Helix2EngineCircuitBreaker({ stateDir: tmpDir });

  // Even exploratory commands are allowed — PostInvocation handles the loop cap
  const res = breaker.checkPreToolUse({
    toolCall: { name: 'run_command', args: { CommandLine: 'cat src/service.py' } }
  });
  assert.equal(res.decision, 'allow');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// =============================================================================
// PostInvocation: the actual enforcement point
// =============================================================================

test('PostInvocation: terminates at invocation cap (default 2)', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-cb-'));
  const breaker = new Helix2EngineCircuitBreaker({ stateDir: tmpDir, maxInvocations: 2 });
  const convId = 'test-post-inv';

  breaker.initTurn({ conversationId: convId, workspaceDir: tmpDir, userPrompt: 'Fix bug' });

  // invocationNum 0 → allow
  const r0 = breaker.checkPostInvocation({ conversationId: convId, invocationNum: 0 });
  assert.equal(r0.terminationBehavior, undefined);

  // invocationNum 1 → TERMINATE (>= maxInvocations - 1)
  const r1 = breaker.checkPostInvocation({ conversationId: convId, invocationNum: 1 });
  assert.equal(r1.terminationBehavior, 'terminate');

  // invocationNum 2 → TERMINATE
  const r2 = breaker.checkPostInvocation({ conversationId: convId, invocationNum: 2 });
  assert.equal(r2.terminationBehavior, 'terminate');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('PostInvocation: soft-terminates after mutation + invocation 1', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-cb-'));
  const breaker = new Helix2EngineCircuitBreaker({ stateDir: tmpDir, maxInvocations: 3 });
  const convId = 'test-post-inv-soft';

  breaker.initTurn({ conversationId: convId, workspaceDir: tmpDir, userPrompt: 'Fix bug' });

  // Record a mutation
  breaker.recordPostToolUse({
    toolCall: { name: 'edit_file', args: { Path: 'src/service.py' } },
    conversationId: convId,
    workspaceDir: tmpDir
  });

  // invocationNum 0 → allow (mutation done, but let model see the result)
  const r0 = breaker.checkPostInvocation({ conversationId: convId, invocationNum: 0 });
  assert.equal(r0.terminationBehavior, undefined);

  // invocationNum 1 with mutation → TERMINATE (soft cap)
  const r1 = breaker.checkPostInvocation({ conversationId: convId, invocationNum: 1 });
  assert.equal(r1.terminationBehavior, 'terminate');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('PostInvocation: respects configurable maxInvocations', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-cb-'));

  // Very tight cap: 1 invocation max
  const breaker1 = new Helix2EngineCircuitBreaker({ stateDir: tmpDir, maxInvocations: 1 });
  const convId = 'test-tight-cap';
  breaker1.initTurn({ conversationId: convId, workspaceDir: tmpDir, userPrompt: 'Fix bug' });

  const r0 = breaker1.checkPostInvocation({ conversationId: convId, invocationNum: 0 });
  assert.equal(r0.terminationBehavior, 'terminate', 'maxInvocations=1 should terminate after invocation 0');

  // Loose cap: 5 invocations
  const breaker5 = new Helix2EngineCircuitBreaker({ stateDir: tmpDir, maxInvocations: 5 });
  const r3 = breaker5.checkPostInvocation({ conversationId: convId, invocationNum: 3 });
  assert.equal(r3.terminationBehavior, undefined, 'maxInvocations=5 should allow invocation 3');
  const r4 = breaker5.checkPostInvocation({ conversationId: convId, invocationNum: 4 });
  assert.equal(r4.terminationBehavior, 'terminate', 'maxInvocations=5 should terminate at invocation 4');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// =============================================================================
// Turn reset
// =============================================================================

test('Turn state resets on new user prompt', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-cb-'));
  const breaker = new Helix2EngineCircuitBreaker({ stateDir: tmpDir });
  const convId = 'test-reset';

  breaker.initTurn({ conversationId: convId, workspaceDir: tmpDir, userPrompt: 'First prompt' });
  breaker.recordPostToolUse({
    toolCall: { name: 'edit_file', args: { Path: 'a.js' } },
    conversationId: convId,
    workspaceDir: tmpDir
  });

  let state = breaker.getState(convId);
  assert.equal(state.mutationsCount, 1);

  // New prompt → counters reset
  breaker.initTurn({ conversationId: convId, workspaceDir: tmpDir, userPrompt: 'Different prompt' });
  state = breaker.getState(convId);
  assert.equal(state.mutationsCount, 0);
  assert.equal(state.readsCount, 0);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
