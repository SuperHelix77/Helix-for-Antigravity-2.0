import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Helix2EngineCircuitBreaker } from '../src/helix2-engine-circuit-breaker.mjs';

test('Helix2EngineCircuitBreaker - Gate 1: Denies redundant read_file when AST locus is pre-resolved', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-cb-test-'));
  const breaker = new Helix2EngineCircuitBreaker({ stateDir: tmpDir });
  const convId = 'conv-gate1-test';
  const targetRel = 'src/service.py';

  // Initialize turn with inlined AST target
  breaker.initTurn({
    conversationId: convId,
    workspaceDir: tmpDir,
    userPrompt: 'Fix bug in ServiceHandler in src/service.py',
    astInlinedFile: targetRel
  });

  // Attempting to read the inlined target file must be DENIED
  const res = breaker.checkPreToolUse({
    toolCall: {
      name: 'read_file',
      args: { Path: targetRel }
    },
    workspaceDir: tmpDir,
    conversationId: convId
  });

  assert.equal(res.decision, 'deny');
  assert.ok(res.reason.includes('[HELIX ENGINE 1-FLOW BREAKER]'));
  assert.ok(res.reason.includes('already 100% pre-resolved'));

  // Attempting to read an unrelated file is allowed (bounded)
  const resOther = breaker.checkPreToolUse({
    toolCall: {
      name: 'read_file',
      args: { Path: 'src/other.py' }
    },
    workspaceDir: tmpDir,
    conversationId: convId
  });

  assert.equal(resOther.decision, 'allow');
  assert.equal(resOther.overwrite?.StartLine, 1);
  assert.equal(resOther.overwrite?.EndLine, 300);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Helix2EngineCircuitBreaker - Gate 2: Denies post-mutation exploratory reads', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-cb-test-'));
  const breaker = new Helix2EngineCircuitBreaker({ stateDir: tmpDir });
  const convId = 'conv-gate2-test';

  breaker.initTurn({
    conversationId: convId,
    workspaceDir: tmpDir,
    userPrompt: 'Refactor auth module'
  });

  // Record an edit_file mutation
  breaker.recordPostToolUse({
    toolCall: {
      name: 'edit_file',
      args: { Path: 'src/auth.ts' }
    },
    conversationId: convId,
    workspaceDir: tmpDir
  });

  // Any subsequent read_file must be DENIED
  const res = breaker.checkPreToolUse({
    toolCall: {
      name: 'read_file',
      args: { Path: 'src/auth.ts' }
    },
    workspaceDir: tmpDir,
    conversationId: convId
  });

  assert.equal(res.decision, 'deny');
  assert.ok(res.reason.includes('[HELIX ENGINE 1-FLOW BREAKER]'));
  assert.ok(res.reason.includes('Post-mutation read is blocked by engine'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Helix2EngineCircuitBreaker - Gate 3: Enforces single-read budget per turn', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-cb-test-'));
  const breaker = new Helix2EngineCircuitBreaker({ stateDir: tmpDir });
  const convId = 'conv-gate3-test';

  breaker.initTurn({
    conversationId: convId,
    workspaceDir: tmpDir,
    userPrompt: 'Investigate system crash'
  });

  // First read is allowed
  const res1 = breaker.checkPreToolUse({
    toolCall: {
      name: 'read_file',
      args: { Path: 'logs/crash.log' }
    },
    workspaceDir: tmpDir,
    conversationId: convId
  });
  assert.equal(res1.decision, 'allow');

  // Record that the first read executed
  breaker.recordPostToolUse({
    toolCall: {
      name: 'read_file',
      args: { Path: 'logs/crash.log' }
    },
    conversationId: convId,
    workspaceDir: tmpDir
  });

  // Second serial read_file must be DENIED
  const res2 = breaker.checkPreToolUse({
    toolCall: {
      name: 'read_file',
      args: { Path: 'logs/secondary.log' }
    },
    workspaceDir: tmpDir,
    conversationId: convId
  });

  assert.equal(res2.decision, 'deny');
  assert.ok(res2.reason.includes('[HELIX ENGINE 1-FLOW BREAKER]'));
  assert.ok(res2.reason.includes('Multiple serial read_file calls across turns are blocked'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Helix2EngineCircuitBreaker - Gate 4: Denies standalone exploratory shell commands', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-cb-test-'));
  const breaker = new Helix2EngineCircuitBreaker({ stateDir: tmpDir });
  const convId = 'conv-gate4-test';

  breaker.initTurn({
    conversationId: convId,
    workspaceDir: tmpDir,
    userPrompt: 'Fix parser in src/parser.rs',
    astInlinedFile: 'src/parser.rs'
  });

  // Standalone cat must be DENIED
  const resCat = breaker.checkPreToolUse({
    toolCall: {
      name: 'run_command',
      args: { CommandLine: 'cat src/parser.rs' }
    },
    workspaceDir: tmpDir,
    conversationId: convId
  });
  assert.equal(resCat.decision, 'deny');
  assert.ok(resCat.reason.includes('Standalone exploratory shell command'));

  // Standalone python inspect must be DENIED
  const resInspect = breaker.checkPreToolUse({
    toolCall: {
      name: 'run_command',
      args: { CommandLine: 'python3 -c "import inspect; print(inspect.getsource(x))"' }
    },
    workspaceDir: tmpDir,
    conversationId: convId
  });
  assert.equal(resInspect.decision, 'deny');

  // Compound pipeline command (&&) is ALLOWED
  const resCompound = breaker.checkPreToolUse({
    toolCall: {
      name: 'run_command',
      args: { CommandLine: 'npm run build && npm test' }
    },
    workspaceDir: tmpDir,
    conversationId: convId
  });
  assert.equal(resCompound.decision, 'allow');

  // helix flow command is ALLOWED
  const resFlow = breaker.checkPreToolUse({
    toolCall: {
      name: 'run_command',
      args: { CommandLine: 'helix flow --edit src/parser.rs --target "foo" --replace "bar" --test "cargo test"' }
    },
    workspaceDir: tmpDir,
    conversationId: convId
  });
  assert.equal(resFlow.decision, 'allow');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Helix2EngineCircuitBreaker - Turn reset on new prompt', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-cb-test-'));
  const breaker = new Helix2EngineCircuitBreaker({ stateDir: tmpDir });
  const convId = 'conv-reset-test';

  // Turn 1
  breaker.initTurn({
    conversationId: convId,
    workspaceDir: tmpDir,
    userPrompt: 'First prompt'
  });
  breaker.recordPostToolUse({
    toolCall: { name: 'edit_file', args: { Path: 'a.js' } },
    conversationId: convId,
    workspaceDir: tmpDir
  });

  let state = breaker.getState(convId);
  assert.equal(state.mutationsCount, 1);

  // Turn 2 with new prompt
  breaker.initTurn({
    conversationId: convId,
    workspaceDir: tmpDir,
    userPrompt: 'Second prompt with different requirements'
  });

  state = breaker.getState(convId);
  assert.equal(state.mutationsCount, 0, 'Counters must reset on new prompt');
  assert.equal(state.readsCount, 0);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
