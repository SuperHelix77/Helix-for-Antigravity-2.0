import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { STATE_DIR } from './paths.mjs';

const LEAN_TARGET_REGEX = /(?:npm\s+(?:test|run\s+build|install|ci)|npx\s+(?:test|build)|node\s+--test|pytest|cargo\s+(?:test|build)|git\s+log|vitest|jest|make\s+(?:test|build)|mvn\s+(?:test|compile)|gradle\s+(?:test|build)|vite\s+build|tsc\b)/i;

/**
 * Helix 2.0 Engine-Level Circuit Breaker
 *
 * Enforces strict One Flow execution at the Antigravity hook layer.
 *
 * Architecture:
 *   PreToolUse  → allow + overwrite only (line bounding, lean switch).
 *                 NEVER deny. Denials add thinking turns, not remove them.
 *   PostInvocation → hard-cap the invocation loop via terminationBehavior.
 *                    This is the ONLY correct enforcement point.
 *
 * Design principles:
 *   1. Read bounding: cap unbounded read_file to 300 lines (overwrite).
 *   2. Lean Switch: wrap verbose test/build commands for 90%+ output compression (overwrite).
 *   3. Invocation cap: terminate the model loop after max 2 inferences per user turn.
 *   4. State tracking: record tool activity per turn for PostInvocation decisions.
 */
export class Helix2EngineCircuitBreaker {
  constructor({ stateDir = path.join(STATE_DIR, 'turns'), maxInvocations = 2 } = {}) {
    this.stateDir = stateDir;
    this.maxInvocations = maxInvocations;
    try {
      fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    } catch {}
  }

  _getStatePath(conversationId) {
    const safeId = (conversationId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    return path.join(this.stateDir, `turn_${safeId}.json`);
  }

  getState(conversationId) {
    const p = this._getStatePath(conversationId);
    try {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      }
    } catch {}
    return null;
  }

  saveState(conversationId, state) {
    const p = this._getStatePath(conversationId);
    try {
      state.updatedAt = Date.now();
      fs.writeFileSync(p, JSON.stringify(state, null, 2), { mode: 0o600 });
    } catch {}
  }

  /**
   * Initialize (or reset) turn state at the start of a new model invocation.
   * Called from PreInvocation hook.
   */
  initTurn({ conversationId, workspaceDir = process.cwd(), userPrompt = '', astInlinedFile = null, invocationNum = 0 }) {
    const prev = this.getState(conversationId);
    const now = Date.now();
    const promptSummary = (userPrompt || '').trim().slice(0, 200);

    // Fresh turn if: new prompt, no prior state, or state expired (> 10 min)
    const isNewTurn = !prev
      || (now - (prev.updatedAt || 0) > 10 * 60 * 1000)
      || (promptSummary && prev.userPrompt !== promptSummary);

    let resolvedAstFile = null;
    if (astInlinedFile) {
      resolvedAstFile = path.isAbsolute(astInlinedFile)
        ? astInlinedFile
        : path.resolve(workspaceDir, astInlinedFile);
    } else if (!isNewTurn && prev?.astInlinedFile) {
      resolvedAstFile = prev.astInlinedFile;
    }

    const state = {
      conversationId: conversationId || 'default',
      invocationNum,
      userPrompt: promptSummary,
      toolCallsCount: isNewTurn ? 0 : (prev?.toolCallsCount || 0),
      mutationsCount: isNewTurn ? 0 : (prev?.mutationsCount || 0),
      readsCount: isNewTurn ? 0 : (prev?.readsCount || 0),
      commandsCount: isNewTurn ? 0 : (prev?.commandsCount || 0),
      astInlinedFile: resolvedAstFile,
      lastMutationFile: isNewTurn ? null : (prev?.lastMutationFile || null),
      lastCommand: isNewTurn ? null : (prev?.lastCommand || null),
      verifiedPasses: isNewTurn ? [] : (prev?.verifiedPasses || []),
      createdAt: isNewTurn ? now : (prev?.createdAt || now),
      updatedAt: now
    };

    this.saveState(conversationId, state);
    return state;
  }

  // ---------------------------------------------------------------------------
  // PreToolUse: allow + overwrite ONLY. Never deny.
  // ---------------------------------------------------------------------------
  checkPreToolUse({ toolCall, workspaceDir = process.cwd(), conversationId = 'default', leanRunner = 'helix' }) {
    if (!toolCall || !toolCall.name) {
      return { decision: 'allow' };
    }

    const toolName = toolCall.name;
    const args = toolCall.args || toolCall.arguments || {};

    // --- read_file: bound to 300 lines max ---
    if (toolName === 'read_file') {
      const start = typeof args.StartLine === 'number' ? args.StartLine : (args.StartLine ? parseInt(args.StartLine, 10) : 1);
      const end = typeof args.EndLine === 'number' ? args.EndLine : (args.EndLine ? parseInt(args.EndLine, 10) : null);

      if (end === null) {
        return { decision: 'allow', overwrite: { StartLine: start, EndLine: start + 299 } };
      } else if (end - start > 350) {
        return { decision: 'allow', overwrite: { EndLine: start + 300 } };
      }
      return { decision: 'allow' };
    }

    // --- run_command: lean switch wrapping ---
    if (toolName === 'run_command') {
      const cmd = (args.CommandLine || '').trim();

      // Lean Switch: wrap verbose test/build commands for 90%+ output compression
      if (cmd && !cmd.includes('helix.mjs lean') && !cmd.startsWith('helix lean') && LEAN_TARGET_REGEX.test(cmd)) {
        const isWin = process.platform === 'win32';
        const escapedCmd = isWin
          ? cmd.replace(/"/g, '""')
          : cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const overwrittenCmd = isWin
          ? `node "${path.normalize(leanRunner)}" lean -- ${cmd}`
          : `node "${leanRunner}" lean -- "${escapedCmd}"`;

        return { decision: 'allow', overwrite: { CommandLine: overwrittenCmd } };
      }

      return { decision: 'allow' };
    }

    return { decision: 'allow' };
  }

  // ---------------------------------------------------------------------------
  // PostInvocation: the ONLY correct place to enforce the invocation cap.
  // ---------------------------------------------------------------------------
  checkPostInvocation({ conversationId = 'default', invocationNum = 0 }) {
    // invocationNum is 0-based.
    // Cap at maxInvocations (default 2) → max 2 model inferences per user turn.
    //   invocation 0: model does its work (edit, read, etc.)
    //   invocation 1: model sees results and responds
    //   → terminate before invocation 2
    if (invocationNum >= this.maxInvocations - 1) {
      return { terminationBehavior: 'terminate' };
    }

    // Soft cap: if mutation already applied and we're past invocation 0,
    // the model has already edited + seen the result. Terminate.
    const state = this.getState(conversationId);
    if (state && state.mutationsCount >= 1 && invocationNum >= 1) {
      return { terminationBehavior: 'terminate' };
    }

    return {};
  }

  // ---------------------------------------------------------------------------
  // PostToolUse: state tracking (no decisions, just bookkeeping).
  // ---------------------------------------------------------------------------
  recordPostToolUse({ toolCall, error = null, conversationId = 'default', workspaceDir = process.cwd() }) {
    if (!toolCall || !toolCall.name) return;

    let state = this.getState(conversationId) || this.initTurn({ conversationId, workspaceDir });
    const toolName = toolCall.name;
    const args = toolCall.args || toolCall.arguments || {};

    state.toolCallsCount = (state.toolCallsCount || 0) + 1;

    if (toolName === 'edit_file' || toolName === 'write_file') {
      state.mutationsCount = (state.mutationsCount || 0) + 1;
      const targetPath = args.Path || args.path || args.file_path || args.filePath || '';
      if (targetPath) {
        state.lastMutationFile = path.resolve(workspaceDir, targetPath);
      }
    } else if (toolName === 'read_file') {
      state.readsCount = (state.readsCount || 0) + 1;
    } else if (toolName === 'run_command') {
      state.commandsCount = (state.commandsCount || 0) + 1;
      const cmd = (args.CommandLine || '').trim();
      state.lastCommand = cmd;
      if (!error && cmd && LEAN_TARGET_REGEX.test(cmd)) {
        if (!state.verifiedPasses) state.verifiedPasses = [];
        if (!state.verifiedPasses.includes(cmd)) {
          state.verifiedPasses.push(cmd);
        }
      }
    }

    this.saveState(conversationId, state);
  }
}
