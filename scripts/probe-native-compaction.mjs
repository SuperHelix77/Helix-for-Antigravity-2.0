// Offline only. Synthetic reported usage locates the native client's trigger;
// it is not a provider-token or quality benchmark and uses no credentials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const catalog = process.argv[2];
if (!catalog) throw new Error('Supply the public native model catalog');
const reports = [];
for (const syntheticInput of [300000, 440000, 460000]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-native-compact-'));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), first = requests.length === 0;
    const tool = body.tools?.find(t => t.type === 'function' && t.name === 'shell_command');
    const item = first ? tool
      ? {type: 'function_call', id: 'fc_probe', call_id: 'call_probe', name: tool.name, arguments: '{"command":"true"}', status: 'completed'}
      : {type: 'function_call', id: 'fc_probe', call_id: 'call_probe', name: 'offline_unknown_tool', arguments: '{}', status: 'completed'}
      : {type: 'message', id: 'msg_probe_' + requests.length, role: 'assistant', phase: 'final_answer', status: 'completed', content: [{type: 'output_text', text: 'Offline probe complete.', annotations: []}]};
    const last = body.input?.at(-1);
    requests.push({url: req.url, tool_count: body.tools?.length ?? 0, last_type: last?.type,
      last_text: JSON.stringify(last?.content ?? '').slice(0, 160), synthetic_input: first ? syntheticInput : 100,
      effort: body.reasoning?.effort});
    const response = {id: 'resp_probe_' + requests.length, object: 'response', created_at: 1, status: 'completed', model: 'gpt-6.1-sol', output: [item],
      usage: {input_tokens: first ? syntheticInput : 100, output_tokens: 1, total_tokens: first ? syntheticInput + 1 : 101,
        input_tokens_details: {cached_tokens: 0}, output_tokens_details: {reasoning_tokens: 0}}};
    if (req.url.endsWith('/compact')) {
      response.object = 'response.compaction'; response.output = [{type: 'compaction', id: 'cmp_probe', encrypted_content: 'offline-probe-only'}];
      res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify(response)); return;
    }
    res.writeHead(200, {'content-type': 'text/event-stream'});
    for (const event of [{type: 'response.created', response: {...response, status: 'in_progress', output: []}},
      {type: 'response.output_item.added', output_index: 0, item: {...item, status: 'in_progress'}},
      {type: 'response.output_item.done', output_index: 0, item}, {type: 'response.completed', response}]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(home, 'config.toml'), `model="gpt-6.1-sol"\nmodel_provider="offline"\nmodel_reasoning_effort="high"\nmodel_catalog_json=${JSON.stringify(path.resolve(catalog))}\napproval_policy="never"\nsandbox_mode="danger-full-access"\n[features]\nremote_models=false\nresponses_websockets=false\nresponses_websockets_v2=false\nskip_host_skill_discovery=true\ncode_mode_host=false\n[model_providers.offline]\nname="Offline local fixture"\nbase_url="http://127.0.0.1:${server.address().port}/v1"\nwire_api="responses"\nsupports_websockets=false\n`);
  const child = spawn(process.env.CODEX_BINARY || 'codex', ['exec', '--strict-config', '--json', '--skip-git-repo-check', '--ignore-rules', '-C', home, 'Use one tool, then finish this offline test.'], {
    env: {...process.env, CODEX_HOME: home, OPENAI_API_KEY: '', CODEX_API_KEY: '', CHATGPT_TOKEN: ''}, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
  const timer = setTimeout(() => child.kill('SIGTERM'), 45000);
  const code = await new Promise(resolve => child.once('close', resolve)); clearTimeout(timer);
  await new Promise(resolve => server.close(resolve));
  const compactRequests = requests.filter(row => row.tool_count === 0 && row.last_text.includes('CONTEXT CHECKPOINT COMPACTION')).length;
  reports.push({synthetic_input_tokens: syntheticInput, exit: code, requests: requests.length,
    ordinary_responses_compaction_requests: compactRequests, native_threshold_override: null});
  fs.rmSync(home, {recursive: true, force: true});
  assert.ok(requests.length > 0, stderr);
}
assert.deepEqual(reports.map(row => row.ordinary_responses_compaction_requests), [0, 0, 1]);
const result = {schema: 'helix.native-compaction-probe.v1', external_model_calls: 0, native_threshold_override: null,
  public_catalog_sha256: createHash('sha256').update(fs.readFileSync(catalog)).digest('hex'),
  model: 'gpt-6.1-sol', effort: 'high', reports,
  limitations: ['Synthetic reported usage, not a model quality or token-savings benchmark.',
    'One intentionally unsupported inert tool produces a native tool-result boundary; no command runs.',
    'CodeMode host is disabled in this isolated transport fixture. The real benchmark retains its native CodeMode configuration.',
    'Native fallback compacts through ordinary Responses, not necessarily /responses/compact.']};
if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(result, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify(result, null, 2));
