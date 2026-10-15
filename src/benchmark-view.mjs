import fs from 'node:fs';
import path from 'node:path';
import {BenchmarkObserver} from './benchmark-observer.mjs';

export function benchmarkSourceView(directory) {
  return fs.existsSync(path.join(directory, 'controller/final-results.json'))
    ? benchmarkView(directory) : new BenchmarkObserver(directory).view();
}

export function benchmarkView(directory) {
  const candidates = ['controller/final-results.json', 'controller/current-results.json', 'controller/results.json'];
  const file = candidates.map(name => path.join(directory, name)).find(name => fs.existsSync(name));
  if (!file) throw new Error('No aggregate HELIX result in the selected benchmark directory');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!data.lanes || !Array.isArray(data.pairs)) throw new Error('Unsupported benchmark schema');
  const lanes = {};
  for (const name of ['vanilla', 'modified']) {
    const source = data.lanes[name];
    if (!source) continue;
    const known = key => source.observed_usage?.[key]?.tokens ?? source.total_usage?.[key] ?? null;
    lanes[name] = {solves: source.verified_solves, submitted: source.submitted, graded: source.officially_graded,
      requests: source.requests, input: known('input_tokens'), output: known('output_tokens'), reasoning: known('reasoning_tokens'),
      tokens: known('total_tokens'), unknown: source.observed_usage?.total_tokens?.unreported_requests ?? null,
      failed_requests: source.failed_or_undelivered, compactions: source.compactions,
      failed_issues: source.failure_effort?.failed_tasks?.length ?? null,
      failed_issue_requests: source.failure_effort?.failed_tasks?.reduce((n, row) => n + row.model_requests, 0) ?? null};
  }
  const v = lanes.vanilla?.output, m = lanes.modified?.output;
  return {name: path.basename(directory), complete: data.complete === true, model: data.model, effort: data.effort, lanes,
    pairs: data.pairs.map(row => Object.fromEntries(['order', 'instance_id', 'vanilla_pass', 'modified_pass', 'vanilla_tokens', 'modified_tokens'].map(key => [key, row[key] ?? null]))),
    known_savings_percent: data.known_subtotal_savings_percent ?? null,
    output_savings_percent: v > 0 && typeof m === 'number' ? 100 * (v - m) / v : null,
    complete_savings_percent: data.complete_token_savings_percent ?? null,
    limitations: (data.limitations || []).map(value => typeof value === 'string' ? value : 'See benchmark methodology')};
}
