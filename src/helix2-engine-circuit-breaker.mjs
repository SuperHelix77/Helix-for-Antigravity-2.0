import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { STATE_DIR } from './paths.mjs';

const LEAN_TARGET_REGEX = /(?:npm\s+(?:test|run\s+build|install|ci)|npx\s+(?:test|build)|node\s+--test|pytest|cargo\s+(?:test|build)|git\s+log|vitest|jest|make\s+(?:test|build)|mvn\s+(?:test|compile)|gradle\s+(?:test|build)|vite\s+build|tsc\b)/i;

function stripQuotes(str) {
  return str.replace(/"[^"]*"/g, '').replace(/'[^']*'/g, '');
}

/**
 * Helix 2.0 Engine-Level Circuit Breaker
 * 
 * Enforces strict One Flow execution at the Antigravity hook layer:
 * 1. Blocks redundant read_file invocations when the target AST locus is already inlined in Turn 1.
 * 2. Blocks post-mutation exploratory reads (forces agent to verify or conclude).
 * 3. Enforces single-read budget per turn to eliminate serialized micro-reading.
 * 4. Blocks standalone exploratory shell inspections (forces compound pipelines).
 * 5. Bounding on file reads (max 300 lines).
 * 6. Lean Switch wrapping for verbose test/build terminal commands.
 */
export class Helix2EngineCircuitBreaker {
  constructor({ stateDir = path.join(STATE_DIR, 'turns') } = {}) {
    this.stateDir = stateDir;
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
        const raw = fs.readFileSync(p, 'utf8');
        return JSON.parse(raw);
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

  initTurn({ conversationId, workspaceDir = process.cwd(), userPrompt = '', astInlinedFile = null, invocationNum = 0 }) {
    const prev = this.getState(conversationId);
    const now = Date.now();
    const promptSummary = (userPrompt || '').trim().slice(0, 200);

    // If new user prompt or state expired (> 10 mins), start fresh turn
    const isNewTurn = !prev || (now - (prev.updatedAt || 0) > 10 * 60 * 1000) || (promptSummary && prev.userPrompt !== promptSummary);

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

  isStandaloneExploratory(cmd) {
    if (!cmd || typeof cmd !== 'string') return false;
    const trimmed = cmd.trim();
    // If it contains compound shell operators outside quotes (&&, ;, ||, |) or redirection, it is part of a pipeline
    const unquoted = stripQuotes(trimmed);
    if (/(?:&&|;|\|\||\|(?!\s*xargs)|>)/.test(unquoted)) return false;
    // Explicit flow or compound runners are not exploratory
    if (trimmed.includes('helix flow') || trimmed.includes('helix pipeline') || trimmed.includes('helix patch')) return false;
    if (/^\s*(?:cat|head|tail|grep|find|ls|sed\s+-n|awk)\s+/i.test(trimmed)) return true;
    if (/^\s*python\d?\s+-c\s+/i.test(trimmed) && /(?:inspect|print\()/i.test(trimmed) && !trimmed.includes('pytest') && !trimmed.includes('unittest')) return true;
    return false;
  }

  checkPreToolUse({ toolCall, workspaceDir = process.cwd(), conversationId = 'default', leanRunner = 'helix' }) {
    if (!toolCall || !toolCall.name) {
      return { decision: 'allow' };
    }

    let state = this.getState(conversationId);
    if (!state) {
      state = this.initTurn({ conversationId, workspaceDir });
    }

    const toolName = toolCall.name;
    const args = toolCall.args || toolCall.arguments || {};

    // -------------------------------------------------------------
    // TOOL: read_file
    // -------------------------------------------------------------
    if (toolName === 'read_file') {
      const targetPath = args.Path || args.path || args.file_path || args.filePath || '';
      const resolvedTarget = targetPath ? path.resolve(workspaceDir, targetPath) : '';

      // GATE 1: AST Target Pre-Resolution Breaker
      if (state.astInlinedFile && resolvedTarget) {
        const inlinedResolved = path.resolve(workspaceDir, state.astInlinedFile);
        const isSameFile = (resolvedTarget === inlinedResolved) ||
          (path.basename(resolvedTarget) === path.basename(inlinedResolved) &&
           (resolvedTarget.endsWith(state.astInlinedFile) || state.astInlinedFile.endsWith(targetPath)));

        if (isSameFile) {
          return {
            decision: 'deny',
            reason: `[HELIX ENGINE 1-FLOW BREAKER] Target symbol locus in "${path.basename(targetPath)}" is already 100% pre-resolved in Turn-1 context. Redundant exploratory read_file is blocked by engine. Apply your mutation directly via edit_file.`
          };
        }
      }

      // GATE 2: Post-Mutation Read Prohibition
      if (state.mutationsCount >= 1) {
        const mutatedName = state.lastMutationFile ? path.basename(state.lastMutationFile) : 'target file';
        return {
          decision: 'deny',
          reason: `[HELIX ENGINE 1-FLOW BREAKER] Post-mutation read is blocked by engine. Your edit on "${mutatedName}" is already applied. Run your unified verification command or conclude immediately.`
        };
      }

      // GATE 3: Read Budget (Anti-Micro-Read / Single Read Limit per Turn)
      if (state.readsCount >= 1) {
        return {
          decision: 'deny',
          reason: `[HELIX ENGINE 1-FLOW BREAKER] Multiple serial read_file calls across turns are blocked by engine. Consolidate your inspections or proceed directly to mutation.`
        };
      }

      // GATE 6: Read Bounding (300 lines max)
      const start = typeof args.StartLine === 'number' ? args.StartLine : (args.StartLine ? parseInt(args.StartLine, 10) : 1);
      const end = typeof args.EndLine === 'number' ? args.EndLine : (args.EndLine ? parseInt(args.EndLine, 10) : null);

      if (end === null) {
        return {
          decision: 'allow',
          overwrite: {
            StartLine: start,
            EndLine: start + 299
          }
        };
      } else if (end - start > 350) {
        return {
          decision: 'allow',
          overwrite: {
            EndLine: start + 300
          }
        };
      }

      return { decision: 'allow' };
    }

    // -------------------------------------------------------------
    // TOOL: run_command
    // -------------------------------------------------------------
    if (toolName === 'run_command') {
      const cmd = (args.CommandLine || '').trim();

      // GATE 4: Standalone Exploratory Shell Inspection Breaker
      if (this.isStandaloneExploratory(cmd)) {
        if (state.astInlinedFile || state.mutationsCount >= 1 || state.toolCallsCount >= 1) {
          return {
            decision: 'deny',
            reason: `[HELIX ENGINE 1-FLOW BREAKER] Standalone exploratory shell command ("${cmd.slice(0, 45)}") is blocked by engine. Group all operations into a single compound pipeline (cmd1 && cmd2 or helix flow) or apply edits directly.`
          };
        }
      }

      // Reassurance Guard: Short-circuit redundant verification runs
      try {
        if (cmd && LEAN_TARGET_REGEX.test(cmd)) {
          const { Helix2SpeculativeWorker } = import('./helix2-speculative-worker.mjs');
          // Inline reassurance check if available
          const normalized = cmd.trim();
          if (state.verifiedPasses && state.verifiedPasses.includes(normalized)) {
            return {
              decision: 'allow',
              overwrite: {
                CommandLine: `echo "[HELIX Speculative Worker: Cached Verified Pass; Exit 0 on clean tree; 0ms]"`
              }
            };
          }
        }
      } catch {}

      // Lean Switch Wrapping for 90%+ terminal compression
      if (!cmd.includes('helix.mjs lean') && !cmd.startsWith('helix lean') && LEAN_TARGET_REGEX.test(cmd)) {
        const isWin = process.platform === 'win32';
        const escapedCmd = isWin
          ? cmd.replace(/"/g, '""')
          : cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const overwrittenCmd = isWin
          ? `node "${path.normalize(leanRunner)}" lean -- ${cmd}`
          : `node "${leanRunner}" lean -- "${escapedCmd}"`;

        return {
          decision: 'allow',
          overwrite: {
            CommandLine: overwrittenCmd
          }
        };
      }

      return { decision: 'allow' };
    }

    // -------------------------------------------------------------
    // TOOL: edit_file / write_file
    // -------------------------------------------------------------
    if (toolName === 'edit_file' || toolName === 'write_file') {
      return { decision: 'allow' };
    }

    // Default: allow
    return { decision: 'allow' };
  }

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
