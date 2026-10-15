import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const [source, output] = process.argv.slice(2);
if (!source) throw new Error('Supply the private benchmark directory');
const result = {schema: 'helix.output-attribution.v1', method: 'Exact provider per-item output attribution, joined by item ID to captured response items. No byte-token estimate.', lanes: {}};
for (const lane of ['vanilla', 'modified']) {
  const usageFile = path.join(source, 'controller', `${lane}-usage.jsonl`);
  const rows = fs.readFileSync(usageFile, 'utf8').trim().split('\n').map(JSON.parse);
  const counts = {programs: 0, prose: 0, reasoning: 0, unmatched: 0, reported_output: 0, unknown_requests: 0};
  for (const row of rows) {
    if (row.usage?.output_tokens === null || row.usage?.output_tokens === undefined) { counts.unknown_requests++; continue; }
    counts.reported_output += row.usage.output_tokens;
    const file = path.join(source, 'controller', `${lane}-${row.id}-response.txt`);
    const items = new Map();
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) if (line.startsWith('data:')) {
      try {
        const value = JSON.parse(line.slice(5));
        if (value.item?.id) items.set(value.item.id, value.item);
        for (const item of value.response?.output || []) if (item.id) items.set(item.id, item);
      } catch {}
    }
    let total = 0;
    for (const [id, item] of Object.entries(row.provider_usage?.attribution?.items || {})) {
      const n = item.output_tokens || 0; if (!n) continue; total += n;
      const type = items.get(id)?.type;
      counts[type === 'reasoning' ? 'reasoning' : type === 'message' ? 'prose' : ['custom_tool_call', 'function_call'].includes(type) ? 'programs' : 'unmatched'] += n;
    }
    if (total !== row.usage.output_tokens) throw new Error('Item attribution does not reconcile with reported request output');
  }
  if (counts.unmatched) throw new Error('Unmatched output item types');
  result.lanes[lane] = {...counts, usage_evidence_sha256: createHash('sha256').update(fs.readFileSync(usageFile)).digest('hex')};
}
if (output) fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify(result));
