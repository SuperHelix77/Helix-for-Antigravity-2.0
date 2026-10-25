#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {STATE_DIR} from '../src/paths.mjs';
import {createService} from '../src/service.mjs';
import {ensureService, request} from '../src/connection.mjs';
import {privateDirectory, privateJSON} from '../src/local-state.mjs';
import {inheritMemory} from '../src/memory-inheritance.mjs';
import {memoryCompatibilityTools} from '../src/memory-compat.mjs';

const command = process.argv[2] || 'status';
if (command === 'serve') {
  const service = await createService({directory: STATE_DIR});
  console.log(JSON.stringify({status: 'online', version: '1.0.1', model_workers: 0}));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void service.close());
} else if (command === 'start') {
  await ensureService(); console.log('HELIX online. No background model workers.');
} else if (command === 'status') {
  try { const state = await request('/snapshot'); console.log(JSON.stringify(state, null, 2)); }
  catch (error) { console.error('HELIX offline: ' + error.message); process.exitCode = 1; }
} else if (command === 'stop') {
  console.log(JSON.stringify(await request('/shutdown', {value: {}})));
} else if (command === 'observe-codex') {
  const threadId = process.argv[3] || process.env.CODEX_THREAD_ID;
  if (!threadId) throw new Error('Supply the actual Codex thread ID or use the runtime CODEX_THREAD_ID; no thread is guessed');
  await ensureService();
  console.log(JSON.stringify(await request('/model/native', {value: {threadId, hostId: 'local'}})));
} else if (['mcp', 'memory-mcp', 'memory-write-mcp'].includes(command)) {
  await ensureService();
  const compatibility = command !== 'mcp';
  const memoryTools = memoryCompatibilityTools.filter(tool => command === 'memory-write-mcp' ? tool.name === 'save_memory' : tool.name !== 'save_memory');
  const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
  const pending = new Map();
  const reply = value => process.stdout.write(JSON.stringify(value) + '\n');
  input.on('line', line => {
    let message;
    try { if (Buffer.byteLength(line) > 1024 * 1024) throw new Error(); message = JSON.parse(line); }
    catch { reply({jsonrpc: '2.0', id: null, error: {code: -32700, message: 'Invalid bounded JSON-RPC request'}}); return; }
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      reply({jsonrpc: '2.0', id: null, error: {code: -32600, message: 'Invalid JSON-RPC request'}}); return;
    }
    if (message.method === 'notifications/cancelled') { pending.get(message.params?.requestId)?.abort(); return; }
    if (message.id === undefined) return;
    if (pending.has(message.id)) { reply({jsonrpc: '2.0', id: message.id, error: {code: -32600, message: 'Request id in flight'}}); return; }
    if (compatibility && ['initialize', 'ping', 'tools/list'].includes(message.method)) {
      const result = message.method === 'initialize' ? {protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: {tools: {}}, serverInfo: {name: 'helix-deterministic-memory', version: '1.0.1'}} : message.method === 'tools/list' ? {tools: memoryTools} : {};
      reply({jsonrpc: '2.0', id: message.id, result}); return;
    }
    if (compatibility && (message.method !== 'tools/call' || !memoryTools.some(tool => tool.name === message.params?.name))) {
      reply({jsonrpc: '2.0', id: message.id, error: {code: -32601, message: 'Unknown deterministic memory method or tool'}}); return;
    }
    const controller = new AbortController(); pending.set(message.id, controller);
    const params = compatibility ? {...message.params, name: 'memory:' + message.params.name, caller_cwd: process.cwd()} : message.params;
    request('/rpc', {value: {method: message.method, params}, signal: controller.signal})
      .then(result => reply({jsonrpc: '2.0', id: message.id, result}))
      .catch(error => reply({jsonrpc: '2.0', id: message.id, error: {code: -32603, message: error.message}}))
      .finally(() => pending.delete(message.id));
  });
  await new Promise(resolve => input.once('close', resolve));
  for (const controller of pending.values()) controller.abort();
} else if (command === 'inherit-memory') {
  const result = await inheritMemory({directory: STATE_DIR, source: process.argv[3], auxiliary: process.argv.slice(4)});
  console.log(JSON.stringify({status: 'inherited', observations: result.database.tables.observations?.rows,
    summaries: result.database.tables.session_summaries?.rows, work_state_entries: result.database.tables.work_state_entries?.rows,
    verified_tables: Object.keys(result.database.tables).length, auxiliary_files: result.auxiliary.length,
    source_preserved: true, model_calls: 0}));
} else if (command === 'memory-hook') {
  await ensureService();
  const state = await request('/snapshot');
  console.log(`<!-- HELIX memory: deterministic SQLite; inherited=${!!state.memory.inherited}; legacy worker not required; no background model. Retrieve only relevant prior evidence, never resume old tasks automatically. -->`);
} else if (command === 'watch') {
  const directory = fs.realpathSync(process.argv[3]);
  if (!fs.statSync(directory).isDirectory()) throw new Error('Benchmark directory required');
  privateJSON(path.join(privateDirectory(), 'monitor.json'), {benchmark: directory});
  console.log('Benchmark source selected locally. Raw requests and session files are not exported.');
} else if (command === 'rtk') {
  await ensureService();
  const result = await request('/rpc', {value: {method: 'tools/call', params: {name: 'context', arguments: {action: 'rtk', source: process.argv[3], filter: process.argv[4] || 'pytest'}}}});
  console.log(result.content.map(item => item.text || '').join('\n'));
} else if (command === 'install') {
  privateDirectory();
  const entry = fileURLToPath(import.meta.url);
  const template = `[mcp_servers.helix]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(entry)}, "mcp"]\nstartup_timeout_sec = 15\ntool_timeout_sec = 650\n`;
  const file = path.join(STATE_DIR, 'codex-mcp.toml');
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== template) throw new Error('Existing installation differs; no configuration overwritten');
  fs.writeFileSync(file, template, {mode: 0o600});
  console.log('Installation registered in HELIX_HOME/codex-mcp.toml. Existing client config/auth untouched.');

  // Antigravity Native Plugin & MCP registration
  const installer = path.join(path.dirname(path.dirname(entry)), 'scripts', 'install-antigravity.mjs');
  if (fs.existsSync(installer)) {
    try {
      const { spawnSync } = await import('node:child_process');
      const res = spawnSync(process.execPath, [installer], { stdio: 'inherit' });
      if (res.status === 0) console.log('Antigravity Desktop App and CLI integration installed successfully.');
    } catch (e) {
      console.log('Note: Antigravity plugin installation skipped:', e.message);
    }
  }
} else if (command === 'lean') {
  const { HelixLeanSwitch } = await import('../src/helix-lean-switch.mjs');
  const { spawn } = await import('node:child_process');
  const { STATE_DIR } = await import('../src/paths.mjs');
  const path = await import('node:path');
  const cmdArgs = process.argv.slice(3);
  if (cmdArgs[0] === '--') cmdArgs.shift();
  const fullCmd = cmdArgs.join(' ');
  if (!fullCmd) {
    console.error('Usage: helix lean -- <command>');
    process.exit(1);
  }

  const child = spawn(fullCmd, { shell: true, stdio: ['inherit', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => stdout += d.toString());
  child.stderr.on('data', d => stderr += d.toString());
  child.on('close', code => {
    const combined = (stdout + (stderr ? '\n' + stderr : '')).trim();
    const lean = new HelixLeanSwitch({ directory: path.join(STATE_DIR, 'programs') });
    const shaped = lean.shapeCommandOutput(combined, { command: fullCmd, exitCode: code, toolName: 'run_command' });
    process.stdout.write((shaped.output || combined) + '\n');
    process.exit(code);
  });
} else if (command === 'skills') {
  const { Helix2LazyManager } = await import('../src/helix2-lazy-manager.mjs');
  const lm = new Helix2LazyManager();
  const query = process.argv[3];
  if (query) {
    const content = lm.readSkill(query);
    if (content) console.log(content);
    else console.log(`Skill "${query}" not found.`);
  } else {
    const list = lm.listSkills();
    console.log(JSON.stringify(list, null, 2));
  }
} else if (command === 'scope') {
  const { Helix2EnvironmentOptimizer } = await import('../src/helix2-environment-optimizer.mjs');
  const optimizer = new Helix2EnvironmentOptimizer();
  const sub = process.argv[3];
  if (sub === 'enable' && process.argv[4]) {
    optimizer.restorePlugin(process.argv[4]);
    console.log(`Enabled ${process.argv[4]}`);
  } else {
    const mcpRes = optimizer.optimizeMcp({ enableRea: false });
    const pluginRes = optimizer.optimizePlugins();
    console.log(JSON.stringify({ mcp: mcpRes, plugins: pluginRes }, null, 2));
  }
} else if (command === 'shape') {
  const { Helix2TranscriptShaper } = await import('../src/helix2-transcript-shaper.mjs');
  const targetPath = process.argv[3];
  const shaper = new Helix2TranscriptShaper({ retainRecentSteps: 25 });
  if (targetPath) {
    const res = await shaper.shapeTranscript({ transcriptPath: targetPath });
    console.log(JSON.stringify(res, null, 2));
  } else {
    const brainDir = path.join(os.homedir(), '.gemini/antigravity/brain');
    let shaped = 0;
    if (fs.existsSync(brainDir)) {
      for (const conv of fs.readdirSync(brainDir)) {
        const tPath = path.join(brainDir, conv, '.system_generated/logs/transcript.jsonl');
        if (fs.existsSync(tPath) && shaper.needsShaping(tPath)) {
          const res = await shaper.shapeTranscript({ transcriptPath: tPath });
          console.log(`Shaped ${conv}: ${res.savedPercent} (${res.savedBytes}B saved)`);
          shaped++;
        }
      }
    }
    console.log(`Transcript shaping complete: ${shaped} conversations processed.`);
  }
} else if (command === 'pipeline') {
  const { Helix2ToolPipeline } = await import('../src/helix2-tool-pipeline.mjs');
  const specPath = process.argv[3];
  if (!specPath) {
    console.error('Usage: helix pipeline <spec.json>');
    process.exit(1);
  }
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const pipeline = new Helix2ToolPipeline({ directory: process.cwd() });
  const result = await pipeline.executePipeline(spec.project || process.cwd(), spec.operations || spec.steps || []);
  console.log(result.summary);
  if (!result.success) process.exit(1);
} else if (command === 'uninstall') {
  try { await request('/shutdown', {value: {}}); } catch {}
  const file = path.join(STATE_DIR, 'codex-mcp.toml');
  if (fs.existsSync(file)) fs.unlinkSync(file);
  const binTarget = path.join(os.homedir(), '.gemini/antigravity/bin/helix');
  if (fs.existsSync(binTarget) || (() => { try { return fs.lstatSync(binTarget).isSymbolicLink(); } catch { return false; } })()) {
    try { fs.unlinkSync(binTarget); } catch {}
  }
  console.log('HELIX stopped; owned registration removed. Goals, memory and exact recovery archives preserved.');
} else throw new Error('Commands: install, start, serve, status, stop, observe-codex [THREAD_ID], mcp, memory-mcp, memory-write-mcp, memory-hook, inherit-memory SOURCE [AUXILIARY...], rtk HASH FILTER, watch DIRECTORY, lean, skills, scope, shape, pipeline, uninstall');
