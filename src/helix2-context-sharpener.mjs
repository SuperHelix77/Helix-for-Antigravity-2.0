import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { extractTargetContext } from './helix2-ast-inliner.mjs';
import { DeterministicMemory } from './memory.mjs';
import { Helix2LazyManager } from './helix2-lazy-manager.mjs';
import { STATE_DIR } from './paths.mjs';

const CACHE_DIR = path.join(STATE_DIR, 'cache');
try { fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 }); } catch {}

/**
 * Helix Context Sharpener
 * 
 * 1. Automatically extracts and evacuates intermediate tool output / settled facts
 *    into deterministic SQLite memory (~/.helix/memory.sqlite).
 * 2. Deterministically retrieves only the most relevant memories for the current prompt.
 * 3. Inlines AST loci with 100% precision.
 * 4. Automatically intercepts newly installed plugins, skills, and MCP servers to keep them lazy.
 * 5. Injects context as an ephemeral message so that transcript.jsonl NEVER bloats.
 */
export class Helix2ContextSharpener {
  constructor({ memory, stateDir = STATE_DIR, lazyManager } = {}) {
    this.memory = memory || new DeterministicMemory(stateDir);
    this.stateDir = stateDir;
    this.cacheDir = path.join(stateDir, 'cache');
    try { fs.mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 }); } catch {}
    this.lazyManager = lazyManager || new Helix2LazyManager();
  }

  /**
   * Evacuate completed, verbose steps into SQLite memory.
   */
  evacuateStaleContext({ transcriptPath, workspaceDir, conversationId }) {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return 0;

    const pointerFile = path.join(this.cacheDir, `${conversationId || 'default'}.last_step`);
    let lastStep = 0;
    try {
      if (fs.existsSync(pointerFile)) {
        lastStep = parseInt(fs.readFileSync(pointerFile, 'utf8').trim(), 10) || 0;
      }
    } catch {}

    const project = path.basename(workspaceDir || process.cwd()) || 'default';
    let lines = [];
    try {
      const content = fs.readFileSync(transcriptPath, 'utf8');
      lines = content.trim().split('\n');
    } catch {
      return 0;
    }

    if (lines.length <= lastStep) return 0;

    let evacuatedCount = 0;
    // Process new lines from lastStep up to the second-to-last (leave the very latest active turn alone)
    const scanEnd = Math.max(0, lines.length - 1);
    for (let i = lastStep; i < scanEnd; i++) {
      try {
        const item = JSON.parse(lines[i]);
        const stepIdx = item.step_index ?? i;

        // Evacuate tool outputs and verifiable results only (never save raw user prompt strings)
        if (item.type === 'PLANNER_RESPONSE' && item.tool_calls && item.tool_calls.length > 0) {
          for (const tc of item.tool_calls) {
            const toolName = tc.name || tc.tool || 'tool';
            const cmd = tc.arguments?.CommandLine || tc.arguments?.Path || '';
            if (cmd) {
              const title = `${toolName}: ${cmd.slice(0, 50)}`;
              const body = `Step ${stepIdx}: ${toolName} ${cmd.slice(0, 100)}`;
              try {
                this.memory.put({
                  project,
                  task: conversationId ? conversationId.slice(0, 36) : 'task',
                  title: title.slice(0, 100),
                  body,
                  kind: 'fact'
                });
                evacuatedCount++;
              } catch {}
            }
          }
        }
      } catch {}
    }

    try {
      fs.writeFileSync(pointerFile, String(scanEnd), { mode: 0o600 });
    } catch {}

    return evacuatedCount;
  }

  /**
   * Deterministically retrieve relevant memory items matching the current user prompt.
   * Near-zero token footprint: max 2 items, telegraphic 1-liners.
   */
  retrieveSharpContext({ workspaceDir, conversationId, userPrompt, limit = 2 }) {
    if (!userPrompt || typeof userPrompt !== 'string') return '';
    const project = path.basename(workspaceDir || process.cwd()) || 'default';
    
    // Extract domain search terms (words >= 4 chars, strictly excluding conversational stop words)
    const words = userPrompt.match(/\b[a-zA-Z_][a-zA-Z0-9_-]{3,}\b/g) || [];
    const stopWords = new Set([
      'what', 'when', 'where', 'which', 'make', 'sure', 'this', 'that', 'with', 'from',
      'have', 'been', 'want', 'need', 'also', 'look', 'your', 'about', 'these', 'those',
      'attack', 'automatic', 'cost', 'near', 'nothing', 'plus', 'please', 'working'
    ]);
    const queryTerms = words.filter(w => !stopWords.has(w.toLowerCase())).slice(0, 6);
    
    if (queryTerms.length === 0) return '';
    const query = queryTerms.join(' ');

    try {
      const results = this.memory.search({ project, query, limit, expand: false });
      if (!results || results.length === 0) return '';

      // Near-zero token format: single compact line per item (max 15 words)
      const items = results.map(r => `• ${r.title.slice(0, 45)}: ${r.body.replace(/\n+/g, ' ').slice(0, 50)}`).join('\n');
      return `[HELIX MEMORY (<25 tok)]\n${items}`;
    } catch {
      return '';
    }
  }

  /**
   * Build the complete ephemeral context for PreInvocation hook.
   */
  shapePreInvocation({ workspaceDir, transcriptPath, conversationId, latestUserPrompt }) {
    // 0. Auto-sync lazy manager (scopes newly added plugins/MCPs, matches JIT skills)
    let jitContext = '';
    try {
      const syncResult = this.lazyManager.autoSync({ userPrompt: latestUserPrompt });
      if (syncResult && syncResult.jitMatches && syncResult.jitMatches.length > 0) {
        jitContext = this.lazyManager.formatJitContext(syncResult.jitMatches) || '';
      }
    } catch {}

    // 1. Evacuate stale context to SQLite
    this.evacuateStaleContext({ transcriptPath, workspaceDir, conversationId });

    // 2. Retrieve relevant sharp memory
    const memorySnippet = this.retrieveSharpContext({ workspaceDir, conversationId, userPrompt: latestUserPrompt });

    // 3. Extract AST symbol locus with 100% precision
    let astSnippet = '';
    if (workspaceDir && latestUserPrompt) {
      try {
        astSnippet = extractTargetContext(workspaceDir, latestUserPrompt);
      } catch {}
    }

    const sections = [];
    if (astSnippet && astSnippet.trim().length > 0) {
      sections.push(astSnippet.trim());
    }
    if (memorySnippet && memorySnippet.trim().length > 0) {
      sections.push(memorySnippet.trim());
    }
    if (jitContext && jitContext.trim().length > 0) {
      sections.push(jitContext.trim());
    }

    if (sections.length === 0) return null;

    const sharpContext = (
      `[HELIX 2.0 PROTOCOL ACTIVATED - ZERO-BLOAT EPHEMERAL CONTEXT]\n` +
      sections.join('\n\n') +
      `\nInstructions: Stale context has been evacuated to SQLite memory (~/.helix/memory.sqlite). Proceed surgically.`
    );

    return sharpContext;
  }
}
