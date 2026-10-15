import fs from 'node:fs';
import {parse} from 'csv-parse/sync';

const cohort = JSON.parse(fs.readFileSync(new URL('../benchmarks/new50-cohort.json', import.meta.url)));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const fields = ['order','instance_id','vanilla_outcome','vanilla_model_requests','vanilla_environment_commands','vanilla_known_tokens','vanilla_unknown_usage_requests',
  'modified_outcome','modified_model_requests','modified_environment_commands','modified_known_tokens','modified_unknown_usage_requests',
  'cumulative_known_tokens_saved','cumulative_known_reduction_percent','cumulative_unknown_usage_requests'];
const limitations = [
  'Known provider-reported subtotals, not complete billed cost or subscription savings.',
  'Unknown request usage is retained as unknown, never assigned zero.',
  'Failed tasks, failed or undelivered requests and recovery effort are included.',
  'Root orchestration, infrastructure and any usage unavailable from the provider are unmeasured.',
  'Same fixed NEW50 cohort. Later v2 tuning and historical-baseline reuse are post-hoc, not a new holdout.',
];
export function publicBenchmark(data, label = 'new50-v1') {
  if (!['new50-v1','new50-v2'].includes(label) || data.model !== 'gpt-6.1-sol' || data.effort !== 'high' ||
      typeof data.complete !== 'boolean' || !Array.isArray(data.pairs) || data.pairs.length > 50) throw new Error('Unsupported public benchmark binding');
  const pairs = data.pairs.map((row, index) => {
    if (row.order !== index + 1 || row.instance_id !== cohort.tasks[index].instance_id ||
        ![row.vanilla_pass, row.modified_pass].every(value => typeof value === 'boolean') ||
        ![row.vanilla_tokens, row.modified_tokens].every(value => value === null || integer(value))) throw new Error('Public cohort, outcome or token binding mismatch');
    return Object.fromEntries(['order','instance_id','vanilla_pass','modified_pass','vanilla_tokens','modified_tokens'].map(key => [key, row[key]]));
  });
  const lanes = {};
  for (const name of ['vanilla','modified']) {
    const row = data.lanes?.[name]; if (!row) throw new Error('Missing lane');
    const known = key => row.observed_usage?.[key]?.tokens;
    const result = {solves: row.verified_solves, submitted: row.submitted, graded: row.officially_graded, requests: row.requests,
      input: known('input_tokens'), output: known('output_tokens'), reasoning: known('reasoning_tokens'), tokens: known('total_tokens'),
      unknown: row.observed_usage?.total_tokens?.unreported_requests, failed_requests: row.failed_or_undelivered, compactions: row.compactions,
      failed_issues: row.failure_effort?.failed_tasks?.length,
      failed_issue_requests: row.failure_effort?.failed_tasks?.reduce((sum, task) => {
        if (!integer(task.model_requests)) throw new Error('Invalid failed-task effort'); return sum + task.model_requests;
      }, 0)};
    if (!Object.values(result).every(integer) || result.solves > result.graded || result.graded > result.submitted || result.submitted > 50 || result.unknown > result.requests) throw new Error('Invalid public lane counts');
    lanes[name] = result;
  }
  const {vanilla: v, modified: m} = lanes;
  return {schema: 'helix.public-benchmark.v1', name: label, complete: data.complete, model: 'gpt-6.1-sol', effort: 'high', lanes, pairs,
    known_savings_percent: v.tokens ? 100 * (v.tokens - m.tokens) / v.tokens : null,
    output_savings_percent: v.output ? 100 * (v.output - m.output) / v.output : null,
    complete_savings_percent: null, limitations,
    privacy: 'Allowlisted typed counts and fixed public issue IDs only; no source prose, user IDs, native sessions, private paths or raw requests.'};
}
export function publicCSV(text, pairs) {
  const records = parse(text, {columns: true, skip_empty_lines: true, max_record_size: 1000000});
  if (records.length !== pairs.length) throw new Error('CSV pair count mismatch');
  const safe = records.map((row, index) => {
    const pair = pairs[index], result = {};
    if (Number(row.order) !== pair.order || row.instance_id !== pair.instance_id) throw new Error('CSV cohort mismatch');
    for (const name of fields) {
      if (!(name in row)) throw new Error('Missing public CSV metric');
      if (name === 'instance_id') result[name] = pair.instance_id;
      else if (name.endsWith('_outcome')) {
        if (!['PASS','FAIL'].includes(row[name]) || (row[name] === 'PASS') !== pair[name.startsWith('vanilla') ? 'vanilla_pass' : 'modified_pass']) throw new Error('CSV outcome mismatch');
        result[name] = row[name];
      } else {
        if (!row[name].trim()) throw new Error('Missing numeric metric');
        const n = Number(row[name]);
        if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER ||
            name !== 'cumulative_known_reduction_percent' && !Number.isInteger(n) ||
            !name.startsWith('cumulative_known_') && n < 0) throw new Error('Invalid numeric CSV metric');
        result[name] = n;
      }
    }
    for (const lane of ['vanilla','modified']) {
      if (pair[`${lane}_tokens`] === null) {
        if (result[`${lane}_unknown_usage_requests`] < 1) throw new Error('Unknown totals require recorded unknown usage');
      } else if (result[`${lane}_known_tokens`] !== pair[`${lane}_tokens`]) throw new Error('CSV token mismatch');
    }
    return result;
  });
  const quote = value => '"' + String(value).replaceAll('"', '""') + '"';
  return [fields, ...safe.map(row => fields.map(key => row[key]))].map(row => row.map(quote).join(',')).join('\n') + '\n';
}
