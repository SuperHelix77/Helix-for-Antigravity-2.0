import assert from 'node:assert/strict';
import test from 'node:test';
import {isProviderOverload, summarizeUsage, compareBenchmarkUsage} from '../src/benchmark-accounting.mjs';

const message = 'Our servers are currently overloaded. Please try again later.';
const row = (tokens, overrides = {}) => ({status: 200, completed: true,
  usage: {input_tokens: tokens - 10, output_tokens: 10, total_tokens: tokens, reasoning_tokens: 0}, ...overrides});

test('excludes only an explicit failed provider overload', () => {
  assert.equal(isProviderOverload(row(100, {completed: false, error: message})), true);
  for (const overrides of [{error: message}, {completed: false, error: 'Unsupported parameter'},
    {completed: false, status: 429, error: 'Quota exceeded'}, {completed: false, error: {message}},
    {completed: false, error: 'Tool output: ' + message}, {completed: false}]) {
    assert.equal(isProviderOverload(row(100, overrides)), false);
  }
});

test('applies the same exclusions to both lanes and preserves all-attempt costs', () => {
  const overloaded = row(500, {completed: false, error: message});
  const result = compareBenchmarkUsage([row(100), overloaded], [row(80), overloaded]);
  assert.equal(result.vanilla.requests, 1);
  assert.equal(result.modified.requests, 1);
  assert.equal(result.known_tokens_saved, 20);
  assert.equal(result.known_savings_percent, 20);
  assert.equal(result.all_attempts.vanilla.known_tokens, 600);
  assert.equal(result.all_attempts.modified.known_tokens, 580);
  assert.equal(result.excluded_provider_overloads.vanilla.known_tokens, 500);
  assert.equal(result.excluded_provider_overloads.modified.known_tokens, 500);
});

test('unknown overload usage stays unknown in the excluded and all-attempts ledgers', () => {
  const result = compareBenchmarkUsage([row(100)], [row(80), row(0, {completed: false, error: message, usage: null})]);
  assert.equal(result.modified.unknown_usage, 0);
  assert.equal(result.all_attempts.modified.unknown_usage, 1);
  assert.equal(result.excluded_provider_overloads.modified.unknown_usage, 1);
  assert.equal(result.modified.known_tokens, 80);
  assert.equal(result.all_attempts.modified.known_tokens, 80);
});

test('counts engine failures, ordinary unknown usage and completed retries', () => {
  const rows = [row(100, {completed: false, status: 400, error: 'Invalid tool arguments'}),
    row(80), row(0, {completed: false, usage: null})];
  const before = structuredClone(rows);
  const result = compareBenchmarkUsage([], rows);
  assert.equal(result.modified.requests, 3);
  assert.equal(result.modified.failed_requests, 2);
  assert.equal(result.modified.unknown_usage, 1);
  assert.equal(result.modified.known_tokens, 180);
  assert.equal(result.known_savings_percent, null);
  assert.deepEqual(rows, before);
  assert.deepEqual(result.modified, summarizeUsage(rows));
});
