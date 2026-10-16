import path from 'node:path';
import {createHash} from 'node:crypto';
import {CacheStableAging} from './cache-stable-aging.mjs';
import {retainToolResult, readRetainedToolResult} from './tool-result-store.mjs';

export class RequestOptimizer {
  constructor(directory, {retain, recover, scopedOperations, scopeContext, cacheStable, continuousContext = false, twoTier = false, leanSwitch = null} = {}) {
    if ((scopedOperations !== undefined || scopeContext !== undefined) &&
        (typeof scopedOperations?.view !== 'function' || typeof scopeContext !== 'function')) throw new Error('Explicit scoped operations and current controller context required');
    this.directory = path.join(directory, 'programs');
    this.sessions = new Map();
    this.scopedOperations = scopedOperations;
    this.scopeContext = scopeContext;
    this.cacheStable = cacheStable;
    this.continuousContext = continuousContext;
    this.twoTier = twoTier;
    this.leanSwitch = leanSwitch;
    this.retain = retain || (text => retainToolResult(text, {directory: this.directory, ttlMs: 0}));
    this.recover = recover || (handle => readRetainedToolResult(handle, {directory: this.directory}));
  }
  shape(payload, {session, provider = 'openai', signal} = {}) {
    const isSupportedProvider = ['openai', 'gemini', 'antigravity'].includes(provider);
    const isSupportedModel = /^gpt-[a-zA-Z0-9._-]+$/.test(payload?.model || '') ||
      /^gemini-[a-zA-Z0-9._-]+$/.test(payload?.model || '') ||
      /^claude-[a-zA-Z0-9._-]+$/.test(payload?.model || '') ||
      payload?.model === 'antigravity';
    if (!isSupportedProvider || !isSupportedModel ||
        typeof session !== 'string' || !session || session.length > 512 || !Array.isArray(payload.input) ||
        !Array.isArray(payload.tools) || payload.tools.length === 0) return {payload, stats: {enabled: false}};
    if (this.scopedOperations) {
      if (payload.previous_response_id != null || payload.conversation != null) return {payload,
        stats: {enabled: false, mode: 'scoped', status: 'boundary', code: 'server_owned_history'}};
      try {
        const context = this.scopeContext({session, model: payload.model});
        if (context && typeof context.then === 'function') {
          Promise.resolve(context).catch(() => {});
          throw new Error('Synchronous current scope context required');
        }
        if (!context) return {payload, stats: {enabled: false, mode: 'scoped', status: 'unbound'}};
        const continuousContext = context.continuousContext ?? this.continuousContext;
        const result = this.scopedOperations.view(payload, {...context, signal, continuousContext});
        if (result.status === 'boundary' || (!this.twoTier && !context.twoTier)) {
          return {payload: result.request, stats: {enabled: result.status === 'retired', mode: 'scoped',
            status: result.status, code: result.code, retiredPairs: result.retiredPairs,
            retiredMessages: result.retiredMessages || 0,
            bytesRemoved: Math.max(0, (result.bytesBefore || 0) - (result.bytesAfter || 0))}};
        }

        const intermediatePayload = result.request;
        const key = createHash('sha256').update(JSON.stringify([session, payload.model])).digest('hex');
        let policy = this.sessions.get(key);
        if (!policy) {
          if (this.sessions.size >= 128) this.sessions.delete(this.sessions.keys().next().value);
          policy = new CacheStableAging(this.cacheStable || { minSavedBytes: 1024, minResults: 2 });
          this.sessions.set(key, policy);
        }
        const intraResult = policy.shape(intermediatePayload.input, {enabled: true, preserveSecurityEvidence: true,
          deduplicateExactResults: true, compactReceipts: true, minBytes: 256, frontierMaxBytes: 32768,
          previewCodeUnits: 24, retainOriginal: text => {
            const handle = this.retain(text);
            if (this.recover(handle) !== text) throw new Error('Exact recovery verification failed');
            return handle;
          }});
        const finalPayload = {...intermediatePayload, input: intraResult.input};
        const totalBytesRemoved = Math.max(0, (result.bytesBefore || 0) - Buffer.byteLength(JSON.stringify(finalPayload)));
        return {
          payload: finalPayload,
          stats: {
            enabled: result.status === 'retired' || intraResult.stats.toolResultsRetained > 0,
            mode: 'two-tier',
            status: result.status,
            code: result.code,
            retiredPairs: result.retiredPairs,
            retiredMessages: result.retiredMessages || 0,
            intraTaskAged: intraResult.stats.toolResultsAged || 0,
            bytesRemoved: totalBytesRemoved
          }
        };
      } catch {
        return {payload, stats: {enabled: false, mode: 'scoped', status: 'boundary', code: 'scope_context_unavailable'}};
      }
    }
    const key = createHash('sha256').update(JSON.stringify([session, payload.model])).digest('hex');
    let policy = this.sessions.get(key);
    if (!policy) {
      if (this.sessions.size >= 128) this.sessions.delete(this.sessions.keys().next().value);
      policy = new CacheStableAging(this.cacheStable || { minSavedBytes: 1024, minResults: 2 });
      this.sessions.set(key, policy);
    }
    const result = policy.shape(payload.input, {enabled: true, preserveSecurityEvidence: true,
      deduplicateExactResults: true, compactReceipts: true, minBytes: 256, frontierMaxBytes: 32768,
      previewCodeUnits: 24, retainOriginal: text => {
        const handle = this.retain(text);
        if (this.recover(handle) !== text) throw new Error('Exact recovery verification failed');
        return handle;
      }});
    return {payload: {...payload, input: result.input}, stats: {enabled: true, ...result.stats}};
  }
}
