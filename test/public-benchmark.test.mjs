import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parse} from 'csv-parse/sync';
import {publicBenchmark, publicCSV} from '../scripts/public-benchmark.mjs';

const published = JSON.parse(fs.readFileSync(new URL('../benchmarks/new50-v1/results.json', import.meta.url)));
function fixture() {
  const data = {model: 'gpt-6.1-sol', effort: 'high', complete: true, pairs: structuredClone(published.pairs), limitations: ['PRIVATE_SENTINEL_447'], lanes: {}};
  for (const name of ['vanilla','modified']) {
    const source = published.lanes[name], observed_usage = {};
    for (const [field, key] of [['input_tokens','input'],['output_tokens','output'],['reasoning_tokens','reasoning'],['total_tokens','tokens']]) observed_usage[field] = {tokens: source[key], unreported_requests: source.unknown};
    data.lanes[name] = {verified_solves: source.solves, submitted: source.submitted, officially_graded: source.graded,
      requests: source.requests, failed_or_undelivered: source.failed_requests, compactions: source.compactions,
      observed_usage, failure_effort: {failed_tasks: Array.from({length: source.failed_issues}, (_, i) => ({model_requests: i ? 0 : source.failed_issue_requests}))}};
  }
  return data;
}
test('public JSON reconstructs typed fields; arbitrary source prose and IDs never pass through', () => {
  const input = fixture(); input.name = 'PRIVATE_SENTINEL_447'; input.prompt = 'PRIVATE_SENTINEL_447';
  input.pairs[0].prompt = 'PRIVATE_SENTINEL_447';
  const output = publicBenchmark(input);
  assert.ok(!JSON.stringify(output).includes('PRIVATE_SENTINEL_447'));
  assert.equal(output.lanes.vanilla.unknown, 5); assert.equal(output.lanes.modified.unknown, 3);
  assert.equal(output.complete_savings_percent, null);
  assert.throws(() => publicBenchmark({...input, model: 'PRIVATE_SENTINEL_447'}));
  assert.throws(() => publicBenchmark({...input, pairs: [{...input.pairs[0], instance_id: 'private__project-123'}]}));
  assert.throws(() => publicBenchmark({...input, lanes: {...input.lanes, modified: {...input.lanes.modified, requests: -1}}}));
});
test('CSV extra private columns are dropped, metrics validated and public cohort/outcomes bound', () => {
  const text = fs.readFileSync(new URL('../benchmarks/new50-v1/per-issue.csv', import.meta.url), 'utf8');
  const records = parse(text, {columns: true}); const fields = Object.keys(records[0]);
  const quote = value => '"' + String(value).replaceAll('"', '""') + '"';
  const malicious = [fields.concat(['prompt','private_path']), ...records.map(row => fields.map(key => row[key]).concat(['PRIVATE_SENTINEL_447', '/home/synthetic-private-fixture/note']))]
    .map(row => row.map(quote).join(',')).join('\n');
  const output = publicCSV(malicious, published.pairs);
  assert.ok(!output.includes('PRIVATE_SENTINEL_447')); assert.ok(!output.includes('synthetic-private-fixture'));
  assert.equal(parse(output, {columns: true}).length, 50);
  assert.throws(() => publicCSV(text.replace('"165437"', '"SECRET_NONNUMBER"'), published.pairs));
});
