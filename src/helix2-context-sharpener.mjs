import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { extractTargetContext } from './helix2-ast-inliner.mjs';
import { DeterministicMemory } from './memory.mjs';
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
 * 4. Injects context as an ephemeral message so that transcript.jsonl NEVER bloats.
 */
export class Helix2ContextSharpener {
  constructor({ memory, stateDir = STATE_DIR } = {}) {
    this.memory = memory || new DeterministicMemory(stateDir);
    this.stateDir = stateDir;
    this.cacheDir = path.join(stateDir, 'cache');
    try { fs.mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 }); } catch {}
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

        // Evacuate tool outputs that are large or informative (e.g. test runs, benchmarks, file edits)
        if (item.type === 'PLANNER_RESPONSE' && item.tool_calls && item.tool_calls.length > 0) {
          for (const tc of item.tool_calls) {
            const toolName = tc.name || tc.tool || 'tool';
            const cmd = tc.arguments?.CommandLine || tc.arguments?.Path || '';
            if (cmd) {
              const title = `Tool Execution: ${toolName} ${cmd.slice(0, 60)}`;
              const body = `Step ${stepIdx}: ${toolName} args: ${JSON.stringify(tc.arguments).slice(0, 500)}`;
              try {
                this.memory.put({
                  project,
                  task: conversationId ? conversationId.slice(0, 36) : 'task',
                  title: title.slice(0, 200),
                  body,
                  kind: 'fact'
                });
                evacuatedCount++;
              } catch {}
            }
          }
        } else if (item.type === 'USER_INPUT' && item.content) {
          const prompt = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
          if (prompt.length > 50 && prompt.length < 2000) {
            try {
              this.memory.put({
                project,
                task: conversationId ? conversationId.slice(0, 36) : 'task',
                title: `User Intent: ${prompt.slice(0, 60)}...`,
                body: prompt,
                kind: 'decision'
              });
              evacuatedCount++;
            } catch {}
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
   */
  retrieveSharpContext({ workspaceDir, conversationId, userPrompt, limit = 3 }) {
    if (!userPrompt || typeof userPrompt !== 'string') return '';
    const project = path.basename(workspaceDir || process.cwd()) || 'default';
    
    // Extract search terms (words >= 4 chars, not common stop words)
    const words = userPrompt.match(/\b[a-zA-Z_][a-zA-Z0-9_-]{3,}\b/g) || [];
    const stopWords = new Set(['what', 'when', 'where', 'which', 'make', 'sure', 'this', 'that', 'with', 'from', 'have', 'been', 'want', 'need', 'also', 'look', 'your']);
    const queryTerms = words.filter(w => !stopWords.has(w.toLowerCase())).slice(0, 8);
    
    if (queryTerms.length === 0) return '';
    const query = queryTerms.join(' ');

    try {
      const results = this.memory.search({ project, query, limit, expand: false });
      if (!results || results.length === 0) return '';

      const items = results.map(r => `• [${r.kind.toUpperCase()}] ${r.title}: ${r.body.replace(/\n+/g, ' ').slice(0, 160)}`).join('\n');
      return `[HELIX DETERMINISTIC MEMORY RECALL]\n${items}`;
    } catch {
      return '';
    }
  }

  /**
   * Build the complete ephemeral context for PreInvocation hook.
   */
  shapePreInvocation({ workspaceDir, transcriptPath, conversationId, latestUserPrompt }) {
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

    if (sections.length === 0) return null;

    const sharpContext = (
      `[HELIX 2.0 PROTOCOL ACTIVATED - ZERO-BLOAT EPHEMERAL CONTEXT]\n` +
      sections.join('\n\n') +
      `\nInstructions: Stale context has been evacuated to SQLite memory (~/.helix/memory.sqlite). Proceed surgically.`
    );

    return sharpContext;
  }
}
