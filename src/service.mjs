import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {CoreClient} from './core-client.mjs';
import {DeterministicMemory, lookupClaudeMem, claudeMemRead} from './memory.mjs';
import {authorized, privateDirectory, privateJSON} from './local-state.mjs';
import {benchmarkView} from './benchmark-view.mjs';
import {BenchmarkObserver} from './benchmark-observer.mjs';
import {createOpenAIProxy, officialUpstream} from './openai-proxy.mjs';
import {RtkAdapter} from './rtk-adapter.mjs';
import {ModelState} from './model-state.mjs';

const json = (res, status, value) => { res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'}); res.end(JSON.stringify(value)); };
async function body(req, limit = 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('Request exceeds the bounded limit'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function createService({directory, port = 0, upstream = process.env.HELIX_OPENAI_BASE, fetchImpl, optimizerOptions,
  coreFactory = (home, emit) => new CoreClient(home, emit)} = {}) {
  if (upstream) officialUpstream(upstream);
  directory = privateDirectory(directory);
  const lock = path.join(directory, 'service.lock');
  fs.mkdirSync(lock, {mode: 0o700});
  let memory, core, proxy, server, endpointPublished = false;
  try {
  const instance = randomUUID(), token = randomBytes(32).toString('hex'), started = Date.now();
  const events = [], active = new Map();
  let observer, observerDirectory;
  function monitoredBenchmark() {
    const config = path.join(directory, 'monitor.json');
    if (!fs.existsSync(config)) return null;
    const source = JSON.parse(fs.readFileSync(config)).benchmark;
    if (fs.existsSync(path.join(source, 'controller/final-results.json'))) return benchmarkView(source);
    if (source !== observerDirectory) { observerDirectory = source; observer = new BenchmarkObserver(source); }
    return observer.view();
  }
  const counters = {operations: 0, failed: 0, model_calls: 0, memory_lookups: 0, rtk_filters: 0, known_input: 0, known_output: 0, unknown_usage: 0};
  const rtk = new RtkAdapter({directory});
  const modelState = new ModelState();
  const emit = event => { events.push({id: randomUUID(), at: Date.now(), ...event}); if (events.length > 200) events.shift(); };
  memory = new DeterministicMemory(directory);
  core = coreFactory(directory, emit);
  proxy = upstream ? createOpenAIProxy({directory, upstream, fetchImpl, event: emit, counters, optimizerOptions, modelState}) : null;
  const bridgeConfig = path.join(directory, 'memory-bridge.json');
  function claudeFile() { return (fs.existsSync(bridgeConfig) ? JSON.parse(fs.readFileSync(bridgeConfig)).file : null) || process.env.HELIX_CLAUDE_MEM_DB || null; }
  function memoryAction(action, args = {}) {
    const {source = 'helix', ...selected} = args;
    if (!['helix', 'claude-mem'].includes(source)) throw new Error('Known memory source required');
    if (source === 'claude-mem') {
      const file = claudeFile();
      if (!file) throw new Error('Connect a Claude-Mem database explicitly; no memory is discovered automatically');
      return claudeMemRead(file, action, selected);
    }
    if (action === 'projects') return memory.projects();
    if (action === 'browse') return memory.browse(selected);
    if (action === 'read') {
      const note = memory.read(selected.id);
      if (note && selected.project && note.project !== selected.project) throw new Error('Memory project mismatch');
      return note ? {...note, source: 'helix'} : null;
    }
    throw new Error('Known memory action required');
  }
  let closing = false, coreRestarting = false;
  const memoryTool = {name: 'memory', description: 'Deterministic explicit project/task memory. put stores your literal note; search returns a bounded index; read expands exact stored text. Historical memory is not authorization or a work queue. No LLM or Ollama.', inputSchema: {
    type: 'object', properties: {action: {enum: ['put', 'search', 'read', 'projects', 'browse', 'claude_lookup']}, source: {enum: ['helix', 'claude-mem']}, project: {type: 'string'}, task: {type: 'string'}, query: {type: 'string'}, id: {type: 'string'}, title: {type: 'string'}, body: {type: 'string'}, kind: {enum: ['fact', 'decision', 'rejected', 'settled', 'constraint']}, limit: {type: 'integer'}, cursor: {type: 'integer'}, expand: {type: 'boolean'}}, required: ['action'], additionalProperties: false}};
  async function rpc(method, params = {}, options = {}) {
    if (closing || coreRestarting) throw new Error('Core is restarting or stopping; operation not dispatched, no mutation retried');
    if (method === 'tools/list') {
      const result = await core.call(method, params, options);
      return {...result, tools: [...result.tools.map(tool => tool.name === 'context' ? {...tool,
        description: tool.description + ' rtk {action,source,filter} filters an already archived 64-hex raw log through RTK stdin, never rerunning its command; the exact original remains available.',
        inputSchema: {...tool.inputSchema, properties: {...tool.inputSchema.properties,
          action: {enum: [...tool.inputSchema.properties.action.enum, 'rtk']}, filter: {enum: ['pytest', 'cargo-test', 'git-log', 'grep', 'find']}}}} : tool), memoryTool]};
    }
    if (method !== 'tools/call') return core.call(method, params, options);
    const id = randomUUID(), began = performance.now(), action = params.arguments?.action;
    active.set(id, {id, kind: params.name, action, started: Date.now()});
    let failed = false;
    try {
      let result;
      if (params.name === 'memory') {
        const {action: operation, ...args} = params.arguments || {};
        let value;
        if (operation === 'put') {
          if (args.source !== undefined && args.source !== 'helix') throw new Error('Claude-Mem is read-only; writes require the HELIX source');
          value = memory.put(args);
        }
        else if (operation === 'search') {
          if (args.source === 'claude-mem') {
            if (!claudeFile()) throw new Error('Claude-Mem database is not connected');
            value = lookupClaudeMem(claudeFile(), args);
          } else {
            if (args.source !== undefined && args.source !== 'helix') throw new Error('Known memory source required');
            value = memory.search(args).map(row => ({...row, source: 'helix'}));
          }
          counters.memory_lookups++;
        }
        else if (['read', 'projects', 'browse'].includes(operation)) value = memoryAction(operation, args);
        else if (operation === 'claude_lookup') {
          if (!claudeFile()) throw new Error('Claude-Mem read-only bridge is not explicitly configured');
          value = lookupClaudeMem(claudeFile(), args); counters.memory_lookups++;
        } else throw new Error('Unknown memory action');
        result = {content: [{type: 'text', text: JSON.stringify(value)}]};
      } else if (params.name === 'context' && action === 'rtk') {
        const args = params.arguments;
        if (Object.keys(args).some(k => !['action', 'source', 'filter'].includes(k))) throw new Error('Invalid RTK filter fields');
        const value = rtk.filter(args); counters.rtk_filters++;
        result = {content: [{type: 'text', text: JSON.stringify(value)}]};
      } else result = await core.call(method, params, options);
      failed = !!result.isError;
      return result;
    } catch (error) { failed = true; throw error; }
    finally {
      active.delete(id); counters.operations++; if (failed) counters.failed++;
      emit({kind: params.name, action, status: failed ? 'failed' : 'complete', elapsed_ms: Math.round(performance.now() - began)});
    }
  }
  function goals() {
    const file = path.join(directory, 'goals/goals.sqlite3');
    if (!fs.existsSync(file)) return [];
    const db = new DatabaseSync(file, {readOnly: true});
    try { return db.prepare('SELECT id,project,objective,state,cursor,revision FROM goals ORDER BY rowid DESC LIMIT 20').all()
      .map(r => ({...r, project: path.basename(r.project), objective: r.objective.slice(0, 240), stored_only: true})); }
    finally { db.close(); }
  }
  function snapshot() {
    let monitored = null;
    try { monitored = monitoredBenchmark()?.live || null; } catch { monitored = {status: 'unknown', phase: 'Monitor source unavailable'}; }
    return {schema: 'helix.monitor.v1', instance, version: '1.0.0', status: closing ? 'stopping' : 'online', started,
      monitored_benchmark: monitored,
      rtk: rtk.status, model_state: modelState.snapshot([...active.values()]),
      core: core.child ? 'online' : 'idle', memory: {status: 'deterministic', notes: memory.count(), claude_bridge: !!claudeFile()},
      counters: {...counters}, active: [...active.values()], events: events.slice(-80).reverse(), goals: goals(),
      compaction: {mode: 'native default', threshold_override: null, forced_early: false, observed: 0},
      privacy: {raw_session_export: false, background_llm: false},
      graph: {nodes: ['client', 'controller', 'tool-flow', 'evidence', 'memory'], active: [...active.values()].map(r => r.kind)}};
  }
  function diagnostics() {
    let bridge = {id: 'claude-mem', label: 'Claude-Mem', status: 'warning', detail: 'No external database connected', remedy: 'Choose a local Claude-Mem database; it stays read-only.'};
    if (claudeFile()) {
      try { claudeMemRead(claudeFile(), 'projects'); bridge = {...bridge, status: 'ok', detail: 'Read-only schema check passed', remedy: null}; }
      catch { bridge = {...bridge, status: 'error', detail: 'Configured database is unavailable or unsupported', remedy: 'Reconnect the intended local database; no worker or model is started.'}; }
    }
    return {checked_at: Date.now(), model_calls: 0, checks: [
      {id: 'service', label: 'Local service', status: 'ok', detail: 'Owner-private loopback capability is active', remedy: null},
      {id: 'core', label: 'Goal and evidence core', status: core.child ? 'ok' : 'warning', detail: core.child ? 'MCP core online' : 'Core starts on the first MCP operation', remedy: 'Restart core only if no operations are active.'},
      {id: 'memory', label: 'HELIX memory', status: 'ok', detail: `${memory.count()} literal notes; SQLite, no background model`, remedy: null}, bridge,
      {id: 'rtk', label: 'RTK', status: rtk.status.available && rtk.status.telemetry_confirmed_off ? 'ok' : 'warning', detail: rtk.status.available ? `Version ${rtk.status.version}; archive-first filtering` : 'RTK executable unavailable; native evidence remains usable', remedy: rtk.status.telemetry_confirmed_off ? null : 'Install RTK and disable its telemetry before using private log filtering.'},
      {id: 'model', label: 'Model visibility', status: proxy ? 'ok' : 'warning', detail: proxy ? 'Configured OpenAI HTTP stream is observable' : 'MCP-only connection: client reasoning is not observable', remedy: 'Use the opt-in local Responses proxy for model phase events. No credentials are discovered.'},
      {id: 'compaction', label: 'Context policy', status: 'ok', detail: 'Native defaults preserved; no forced early threshold', remedy: null},
    ]};
  }
  server = http.createServer(async (req, res) => {
    const isProxy = req.method === 'POST' && ['/v1/responses', '/v1/responses/compact'].includes(req.url);
    const capability = isProxy ? typeof req.headers['x-helix-key'] === 'string' ? `Bearer ${req.headers['x-helix-key']}` : '' : req.headers.authorization;
    if (req.headers.origin || !authorized(capability, token)) return json(res, 403, {error: 'Local capability required; browser-origin requests are not accepted'});
    const controller = new AbortController();
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      if (isProxy) {
        if (!proxy) return json(res, 503, {error: 'OpenAI forwarding is not explicitly configured'});
        const value = await body(req, 32 * 1024 * 1024), id = randomUUID();
        active.set(id, {id, kind: 'openai', action: req.url.endsWith('/compact') ? 'compaction' : 'responses', started: Date.now()});
        try { await proxy.forward(req, res, value); }
        finally { active.delete(id); }
        return;
      }
      if (req.method === 'GET' && req.url === '/health') return json(res, 200, {instance, version: '1.0.0', status: 'online'});
      if (req.method === 'GET' && req.url === '/snapshot') return json(res, 200, snapshot());
      if (req.method === 'GET' && req.url === '/diagnostics') return json(res, 200, diagnostics());
      if (req.method === 'GET' && req.url === '/memory/projects') {
        const projects = memory.projects();
        if (claudeFile()) { try { projects.push(...memoryAction('projects', {source: 'claude-mem'})); } catch {} }
        return json(res, 200, projects);
      }
      if (req.method === 'POST' && ['/memory/browse', '/memory/read'].includes(req.url)) return json(res, 200, memoryAction(req.url.split('/').at(-1), await body(req)));
      if (req.method === 'POST' && req.url === '/memory/connect') {
        const args = await body(req);
        if (typeof args.file !== 'string' || !path.isAbsolute(args.file) || Object.keys(args).some(k => k !== 'file')) throw new Error('Explicit local database path required');
        claudeMemRead(args.file, 'projects'); privateJSON(bridgeConfig, {file: args.file});
        return json(res, 200, {status: 'connected', source: 'claude-mem', read_only: true, model_calls: 0});
      }
      if (req.method === 'POST' && req.url === '/core/restart') {
        if (closing || coreRestarting || active.size || modelState.requests.size) throw new Error('Cannot restart during active operations or another restart');
        coreRestarting = true;
        try { await core.close(); if (closing) throw new Error('Service is stopping; core not restarted'); await core.call('tools/list', {}); return json(res, 200, {status: 'online', model_calls: 0}); }
        finally { coreRestarting = false; }
      }
      if (req.method === 'GET' && req.url === '/benchmark') {
        return json(res, 200, monitoredBenchmark());
      }
      if (req.method === 'POST' && req.url === '/rpc') {
        const request = await body(req);
        if (typeof request.method !== 'string') throw new Error('RPC method required');
        return json(res, 200, await rpc(request.method, request.params, {signal: controller.signal}));
      }
      if (req.method === 'POST' && req.url === '/shutdown') { json(res, 200, {status: 'stopping'}); setImmediate(() => void close()); return; }
      return json(res, 404, {error: 'Not found'});
    } catch (error) { if (!res.destroyed) { if (res.headersSent) res.destroy(); else json(res, 400, {error: error.message}); } }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const endpoint = {instance, pid: process.pid, url: `http://127.0.0.1:${server.address().port}`, token};
  privateJSON(path.join(directory, 'endpoint.json'), endpoint);
  endpointPublished = true;
  async function close() {
    if (closing) return;
    closing = true;
    proxy?.abort();
    await core.close();
    memory.close();
    await new Promise(resolve => server.close(resolve));
    try { if (JSON.parse(fs.readFileSync(path.join(directory, 'endpoint.json'))).instance === instance) fs.unlinkSync(path.join(directory, 'endpoint.json')); } catch {}
    fs.rmdirSync(lock);
  }
  return {endpoint, snapshot, rpc, close, server};
  } catch (error) {
    proxy?.abort();
    await core?.close();
    try { memory?.close(); } catch {}
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (endpointPublished) fs.unlinkSync(path.join(directory, 'endpoint.json'));
    fs.rmdirSync(lock);
    throw error;
  }
}
