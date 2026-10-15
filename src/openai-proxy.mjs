import {RequestOptimizer} from './request-optimizer.mjs';
import {randomUUID} from 'node:crypto';

export function officialUpstream(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash ||
      !(url.hostname === 'api.openai.com' && url.pathname.replace(/\/$/, '') === '/v1' ||
        url.hostname === 'chatgpt.com' && url.pathname.replace(/\/$/, '') === '/backend-api/codex')) throw new Error('Only the explicitly configured official OpenAI HTTPS API base is accepted');
  return url.href.replace(/\/$/, '');
}

export function createOpenAIProxy({directory, upstream, fetchImpl = fetch, event, counters, optimizerOptions, modelState}) {
  upstream = officialUpstream(upstream);
  const optimizer = new RequestOptimizer(directory, optimizerOptions);
  const controllers = new Set();
  return {
    abort() { for (const controller of controllers) controller.abort(); },
    async forward(req, res, payload) {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
          payload.input !== undefined && typeof payload.input !== 'string' && !Array.isArray(payload.input)) throw new Error('Responses input must be text or an array');
      const suffix = req.url.endsWith('/compact') ? '/responses/compact' : '/responses';
      if (!/^gpt-[a-zA-Z0-9._-]+$/.test(payload.model || '')) throw new Error('This release only proxies explicitly selected OpenAI GPT models; no aliases or fallback models');
      if (!req.headers.authorization) throw new Error('The client must supply its own OpenAI authorization; HELIX never discovers credentials');
      const controller = new AbortController(); controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), 1200000);
      res.once('close', () => { if (!res.writableEnded) controller.abort(); });
      const headers = {'content-type': 'application/json', accept: 'text/event-stream'};
      for (const key of ['authorization', 'chatgpt-account-id', 'openai-organization', 'session_id', 'conversation_id',
        'x-codex-turn-metadata', 'x-openai-internal-codex-responses-lite', 'originator', 'user-agent']) if (typeof req.headers[key] === 'string') headers[key] = req.headers[key];
      const id = randomUUID();
      let usage = null, status = 0, stream = '', oversizedEvent = false, sent = false, finished = false, failed = false;
      let shaped = {stats: {enabled: false}}, bytesBefore = 0, bytesAfter = 0;
      const compact = suffix.endsWith('/compact') || payload.input?.at(-1)?.type === 'compaction_trigger';
      try {
        shaped = compact ? {payload, stats: {enabled: false}} : optimizer.shape(payload, {session: req.headers.session_id || req.headers.conversation_id, signal: controller.signal});
        const outgoing = {...shaped.payload};
        delete outgoing.max_tool_calls;
        if (headers['x-openai-internal-codex-responses-lite']) outgoing.parallel_tool_calls = false;
        bytesBefore = Buffer.byteLength(JSON.stringify(payload)); bytesAfter = Buffer.byteLength(JSON.stringify(outgoing));
        counters.model_calls++; sent = true; modelState?.start(id, payload.model);
        const response = await fetchImpl(upstream + suffix, {method: 'POST', headers, body: JSON.stringify(outgoing), signal: controller.signal, redirect: 'error'});
        status = response.status;
        res.writeHead(status, {'content-type': response.headers.get('content-type') || 'application/json', 'cache-control': 'no-store'});
        const decoder = new TextDecoder();
        const sse = response.headers.get('content-type')?.includes('text/event-stream');
        const consume = line => {
          if (!line.startsWith('data:')) return;
          try {
            const record = JSON.parse(line.slice(5)); modelState?.event(id, record);
            if (['response.completed', 'response.failed', 'response.incomplete'].includes(record.type)) {
              usage = record.response?.usage || usage;
              finished = record.type === 'response.completed'; failed = !finished;
            }
          } catch {}
        };
        for await (const chunk of response.body || []) {
          if (!res.write(chunk)) await new Promise((resolve, reject) => {
            const stop = () => { cleanup(); reject(new Error('Client disconnected')); };
            const ready = () => { cleanup(); resolve(); };
            const cleanup = () => { res.off('drain', ready); res.off('close', stop); };
            res.once('drain', ready); res.once('close', stop);
          });
          if (oversizedEvent) continue;
          stream += decoder.decode(chunk, {stream: true});
          if (stream.length > 8 * 1024 * 1024) { stream = ''; oversizedEvent = true; continue; }
          if (sse) { const lines = stream.split('\n'); stream = lines.pop(); for (const line of lines) consume(line); }
        }
        if (!oversizedEvent) {
          stream += decoder.decode();
          if (sse) consume(stream);
          else { try { const value = JSON.parse(stream); usage = value.usage || null; finished = !value.error && value.status === 'completed'; failed = !!value.error || ['failed', 'incomplete'].includes(value.status); } catch {} }
        }
        res.end();
      } finally {
        clearTimeout(timer); controllers.delete(controller);
        modelState?.finish(id, finished && status >= 200 && status < 300 ? 'complete' : failed || status < 200 || status >= 300 ? 'failed' : 'unknown');
        if (sent && Number.isSafeInteger(usage?.input_tokens) && usage.input_tokens >= 0 && Number.isSafeInteger(usage?.output_tokens) && usage.output_tokens >= 0) {
          counters.known_input += usage.input_tokens; counters.known_output += usage.output_tokens;
        } else if (sent) counters.unknown_usage++;
        event({kind: 'openai', action: compact ? 'compaction' : 'responses', status: finished && status >= 200 && status < 300 && usage ? 'complete' : 'failed_or_unknown',
          input_tokens: usage?.input_tokens ?? null, output_tokens: usage?.output_tokens ?? null,
          history_policy: shaped.stats.mode || (shaped.stats.enabled ? 'result-aging' : 'passthrough'),
          archived_pairs: shaped.stats.retiredPairs || 0, optimizer_boundary: shaped.stats.code || null,
          payload_bytes_removed: Math.max(0, bytesBefore - bytesAfter), estimated_token_savings: null});
      }
    },
  };
}
