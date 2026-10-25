import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { privateDirectory } from './local-state.mjs';

/**
 * Helix2TokenMonitor
 * 
 * High-performance, zero-cost, offline token ledger and monitor.
 * Automatically runs in background hooks to audit token savings and context efficiency
 * with ZERO model calls, ZERO token cost, and sub-millisecond execution.
 */
export class Helix2TokenMonitor {
  constructor({ directory } = {}) {
    this.directory = directory;
    const dbFile = path.join(privateDirectory(directory), 'memory.sqlite');
    this.db = new DatabaseSync(dbFile);
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS token_audit_ledger(
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          step_index INTEGER NOT NULL,
          input_tokens INTEGER NOT NULL,
          cache_read_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          total_tokens INTEGER NOT NULL,
          baseline_tokens INTEGER NOT NULL,
          saved_percent REAL NOT NULL,
          timestamp INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_token_ledger_unique ON token_audit_ledger(conversation_id, step_index);
        CREATE INDEX IF NOT EXISTS idx_token_ledger_conv ON token_audit_ledger(conversation_id);
      `);
    } catch {}
  }

  /**
   * Reads the latest step from transcript_full.jsonl or transcript.jsonl
   * and records its token usage in SQLite without calling any model.
   */
  recordStepMetrics({ transcriptPath, conversationId = 'default', baselineTokens = 263265 }) {
    if (!transcriptPath) return { recorded: false, reason: 'no_transcript_path' };

    const fullPath = transcriptPath.replace(/transcript\.jsonl$/, 'transcript_full.jsonl');
    const targetPath = fs.existsSync(fullPath) ? fullPath : transcriptPath;
    if (!fs.existsSync(targetPath)) return { recorded: false, reason: 'file_not_found' };

    try {
      // Fast tail-read: read last 64KB of the file to inspect the latest planner response
      const stat = fs.statSync(targetPath);
      const readSize = Math.min(stat.size, 64 * 1024);
      const buffer = Buffer.alloc(readSize);
      const fd = fs.openSync(targetPath, 'r');
      fs.readSync(fd, buffer, 0, readSize, Math.max(0, stat.size - readSize));
      fs.closeSync(fd);

      const lines = buffer.toString('utf8').trim().split('\n');
      let latestMetrics = null;

      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const item = JSON.parse(lines[i]);
          if (item.type === 'PLANNER_RESPONSE' && (item.input_tokens !== undefined || item.cache_read_tokens !== undefined)) {
            latestMetrics = item;
            break;
          }
        } catch {}
      }

      if (!latestMetrics) return { recorded: false, reason: 'no_metrics_found' };

      const stepIndex = latestMetrics.step_index || 0;
      const inputTokens = latestMetrics.input_tokens || 0;
      const cacheReadTokens = latestMetrics.cache_read_tokens || 0;
      const outputTokens = latestMetrics.output_tokens || 0;
      const totalTokens = inputTokens + cacheReadTokens + outputTokens;

      const dynamicBaseline = Math.max(baselineTokens, totalTokens);
      const savedPercent = dynamicBaseline > 0
        ? Number((((dynamicBaseline - totalTokens) / dynamicBaseline) * 100).toFixed(2))
        : 0;

      // Check if already recorded
      const existing = this.db.prepare('SELECT id FROM token_audit_ledger WHERE conversation_id=? AND step_index=?').get(conversationId, stepIndex);
      if (existing) {
        return { recorded: false, reason: 'already_recorded', stepIndex, totalTokens };
      }

      const id = randomUUID();
      this.db.prepare(`
        INSERT INTO token_audit_ledger (id, conversation_id, step_index, input_tokens, cache_read_tokens, output_tokens, total_tokens, baseline_tokens, saved_percent, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, conversationId, stepIndex, inputTokens, cacheReadTokens, outputTokens, totalTokens, dynamicBaseline, savedPercent, Date.now());

      return {
        recorded: true,
        conversationId,
        stepIndex,
        inputTokens,
        cacheReadTokens,
        outputTokens,
        totalTokens,
        baselineTokens: dynamicBaseline,
        savedPercent
      };
    } catch (e) {
      return { recorded: false, error: e.message };
    }
  }

  /**
   * Retrieves summary audit statistics for a conversation.
   */
  getConversationSummary(conversationId) {
    try {
      const rows = this.db.prepare(`
        SELECT * FROM token_audit_ledger WHERE conversation_id=? ORDER BY step_index ASC
      `).all(conversationId);

      if (!rows || rows.length === 0) {
        return { totalSteps: 0, totalTokens: 0, averageSavedPercent: 0 };
      }

      let totalTokens = 0;
      let totalBaseline = 0;
      for (const row of rows) {
        totalTokens += row.total_tokens;
        totalBaseline += row.baseline_tokens;
      }

      const overallSavedPercent = totalBaseline > 0
        ? Number((((totalBaseline - totalTokens) / totalBaseline) * 100).toFixed(2))
        : 0;

      return {
        totalSteps: rows.length,
        totalTokens,
        totalBaseline,
        overallSavedPercent,
        latestStep: rows[rows.length - 1]
      };
    } catch (e) {
      return { error: e.message };
    }
  }
}
