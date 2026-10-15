import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const [source, directory] = process.argv.slice(2);
if (!source || !directory) throw new Error('Usage: node scripts/export-v3.mjs PRIVATE_AUDIT OUTPUT_DIRECTORY');
const bytes = fs.readFileSync(source), data = JSON.parse(bytes);
assert.equal(createHash('sha256').update(bytes).digest('hex'), 'ff69598e778874ceb404bd31d35728ce8c650299a930a294e75d8e9a7118c2a1', 'Reviewed V3 audit binding changed');
assert.equal(data.schema, 'helix.v3.final-evidence.v1');
assert.equal(data.official_task_cohort_complete, true);
assert.equal(data.provenance.official_grades, 100);
assert.equal(data.cumulative.length, 50);
const integer = n => { assert.ok(Number.isSafeInteger(n) && n >= 0); return n; };
const summary = value => Object.fromEntries(['requests', 'failed_requests', 'known_input', 'known_output', 'known_reasoning', 'known_tokens', 'unknown_usage', 'unknown_output'].map(k => [k, integer(value[k])]));
const comparison = value => ({vanilla: summary(value.vanilla), modified: summary(value.modified),
  known_tokens_saved: value.vanilla.known_tokens - value.modified.known_tokens,
  known_savings_percent: 100 * (value.vanilla.known_tokens - value.modified.known_tokens) / value.vanilla.known_tokens,
  known_output_growth_percent: 100 * (value.modified.known_output - value.vanilla.known_output) / value.vanilla.known_output});
const result = {schema: 'helix.public-v3.v1', engine: 'HELIX 1.0', treatment: 'V3', model: 'gpt-6.1-sol', effort: 'high', verbosity: 'medium',
  tasks: 50, official_grades_complete: true, clean_native_exit: false,
  comparison: 'Post-hoc same50 historical vanilla versus modified package, one continuous native conversation per lane; infrastructure resumes, no per-issue reset',
  acceptance: {output_reduction: false, solve_parity: false, overall_savings_target_85_percent: false},
  solves: {vanilla: integer(data.lanes.vanilla.solves), modified: integer(data.lanes.modified.solves)},
  primary: comparison(data.accounting), all_attempts: comparison(data.accounting.all_attempts),
  excluded_confirmed_overloads: {vanilla: summary(data.accounting.excluded_provider_overloads.vanilla), modified: summary(data.accounting.excluded_provider_overloads.modified)},
  finalization: Object.fromEntries(['vanilla', 'modified'].map(k => [k, summary(data.finalization[k])])),
  failed_tasks: Object.fromEntries(['vanilla', 'modified'].map(k => [k, {issues: integer(data.failed_effort[k].issues), primary: summary(data.failed_effort[k].primary),
    per_task: data.failed_effort[k].per_task.map(t => ({order: integer(t.order), instance_id: String(t.instance_id), ...summary(t), environment_commands: integer(t.environment_commands), native_tool_calls: integer(t.native_tool_calls)}))}])),
  recovery: {retained_originals: integer(data.provenance.cold_recovery.retained.originals), program_originals: integer(data.provenance.cold_recovery.programs.originals),
    archived_pairs: integer(data.provenance.cold_exact_pairs), advertised_handles_verified: integer(data.provenance.advertised_aged_original_handles_verified)},
  native_compactions: integer(data.provenance.native_compactions),
  source_audit_sha256: createHash('sha256').update(bytes).digest('hex'),
  limitations: ['Known provider counters are not billed cost or subscription savings. One non-overload modified request has unknown usage.',
    'Only exact confirmed server-overload errors are excluded symmetrically; they remain in all-attempt totals.',
    'Failed tasks, ordinary errors, successful retries and two rejected finalization operations remain included.',
    'The solver was terminated after all official grades because the post-completion broker rejected further operations; clean exit is not claimed.',
    'Root, consultation and infrastructure orchestration inference overhead is unmeasured.',
    'V3 benchmark did not run RTK or import personal Claude-Mem. New release adapters have local integration tests, not a new paid savings benchmark.',
    'No actual native compaction occurred; compaction-quality parity is unestablished.',
    'This is not a fresh holdout, simultaneous A/B test or causal component ablation.'],
};
const cumulative = data.cumulative.map((p, i) => {
  assert.equal(p.order, i + 1); assert.match(p.instance_id, /^[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+$/);
  return {order: i + 1, instance_id: p.instance_id, vanilla_pass: p.vanilla_pass === true, modified_pass: p.modified_pass === true, ...comparison(p)};
});
fs.mkdirSync(directory, {recursive: true});
fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify({...result, cumulative}, null, 2) + '\n', {flag: 'wx'});
const headings = ['order', 'instance_id', 'vanilla_pass', 'modified_pass', 'vanilla_cumulative_known_tokens', 'modified_cumulative_known_tokens', 'cumulative_known_tokens_saved', 'cumulative_known_savings_percent'];
const csv = [headings.join(','), ...cumulative.map(p => [p.order, p.instance_id, p.vanilla_pass, p.modified_pass, p.vanilla.known_tokens, p.modified.known_tokens, p.known_tokens_saved, p.known_savings_percent].join(','))].join('\n') + '\n';
fs.writeFileSync(path.join(directory, 'cumulative.csv'), csv, {flag: 'wx'});
console.log(JSON.stringify({issues: cumulative.length, raw_records_exported: 0, source_audit_sha256: result.source_audit_sha256}));
