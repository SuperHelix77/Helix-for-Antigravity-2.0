import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BenchmarkObserver} from '../src/benchmark-observer.mjs';
import {benchmarkSourceView} from '../src/benchmark-view.mjs';
import {processStartIdentity} from '../src/process-identity.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-monitor-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, 'controller'));
  const tasks = JSON.parse(fs.readFileSync(new URL('../benchmarks/new50-cohort.json', import.meta.url))).tasks;
  const put = (file, value) => fs.writeFileSync(path.join(root, file), JSON.stringify(value));
  const append = (lane, value) => fs.appendFileSync(path.join(root, `controller/${lane}-usage.jsonl`), JSON.stringify(value) + '\n');
  const graded = (order, pass, exit = 0) => ({order, grade_exit: exit, grade: {resolved_ids: pass ? [tasks[order - 1].instance_id] : []}});
  put('manifest.json', {tasks, model: 'gpt-6.1-sol', effort: 'high'});
  put('controller/historical-vanilla-state.json', {tasks: tasks.map(task => graded(task.order, true))});
  const row = (order, tokens, overrides = {}) => ({id: `request-${order}`, order, started: '2026-01-01T00:00:00Z', status: 200,
    completed: true, usage: tokens === null ? null : {input_tokens: tokens - 10, output_tokens: 10, total_tokens: tokens}, ...overrides});
  const observer = new BenchmarkObserver(root);
  return {root, tasks, put, append, graded, row, observer};
}

test('prepared monitor exposes no fictitious running process or unmatched savings', t => {
  const f = fixture(t);
  f.append('vanilla', f.row(1, 1000));
  const view = benchmarkSourceView(f.root);
  assert.equal(view.live.status, 'prepared');
  assert.equal(view.live.requests, 0);
  assert.equal(view.live.in_flight, 0);
  assert.equal(view.live.matched_pairs, 0);
  assert.equal(view.known_savings_percent, null);
  assert.equal(view.output_savings_percent, null);
  assert.equal(view.complete, false);
});

test('only officially graded contiguous pairs enter savings, all failed effort stays visible', t => {
  const f = fixture(t);
  f.append('vanilla', f.row(1, 1000));
  f.append('vanilla', f.row(2, 9000));
  f.append('modified', f.row(1, 100));
  f.append('modified', f.row(1, null, {status: 502, completed: false}));
  f.append('modified', f.row(2, 5000));
  f.put('controller/status.json', {lanes: {modified: {current: 2, requests: 3, tasks: [f.graded(1, false), f.graded(2, true, 1)]}}});
  const view = f.observer.view();
  assert.equal(view.live.status, 'unknown');
  assert.equal(view.live.matched_pairs, 1);
  assert.equal(view.known_savings_percent, 90);
  assert.equal(view.lanes.modified.tokens, 5100);
  assert.equal(view.lanes.modified.unknown, 1);
  assert.equal(view.lanes.modified.failed_requests, 1);
  assert.equal(view.lanes.modified.failed_issues, 1);
  assert.equal(view.lanes.modified.failed_issue_requests, 2);
  assert.equal(view.pairs[1].modified_pass, null);
  assert.equal(view.complete_savings_percent, null);
});

test('live controller identity, not timestamps or PID alone, controls running and in-flight status', t => {
  const f = fixture(t);
  f.put('controller/status.json', {lanes: {modified: {current: 1, requests: 2, tasks: []}}});
  f.append('modified', f.row(1, 100));
  const identity = processStartIdentity(process.pid);
  assert.ok(identity);
  f.put('controller/monitor-owner.json', {pid: process.pid, start_identity: identity});
  assert.equal(f.observer.view().live.status, 'running');
  assert.equal(f.observer.view().live.in_flight, 1);
  f.put('controller/monitor-owner.json', {pid: process.pid, start_identity: identity + '-different-start'});
  assert.equal(f.observer.view().live.status, 'unknown');
  assert.equal(f.observer.view().live.in_flight, 0);
});

test('incremental reads wait for complete JSONL records, survive rotation and do not expose raw outputs', t => {
  const f = fixture(t), file = path.join(f.root, 'controller/modified-usage.jsonl');
  const raw = JSON.stringify(f.row(1, 123, {secret: 'PRIVATE-SYNTHETIC-MARKER', output: 'RAW-SYNTHETIC-PROGRAM'}));
  fs.writeFileSync(file, raw.slice(0, 40));
  assert.equal(f.observer.view().lanes.modified.requests, 0);
  fs.appendFileSync(file, raw.slice(40) + '\n');
  const view = f.observer.view();
  assert.equal(view.live.status, 'unknown');
  assert.equal(view.lanes.modified.requests, 1);
  assert.equal(view.lanes.modified.tokens, 123);
  assert.ok(!JSON.stringify(view).includes('PRIVATE-SYNTHETIC-MARKER'));
  assert.ok(!JSON.stringify(view).includes('RAW-SYNTHETIC-PROGRAM'));
  fs.renameSync(file, file + '.old');
  f.append('modified', f.row(2, 456));
  assert.equal(f.observer.view().lanes.modified.tokens, 456);
});

test('completion requires 50 actual grades and a successful controller exit', t => {
  const f = fixture(t), tasks = f.tasks.map(task => f.graded(task.order, task.order !== 4));
  f.put('controller/status.json', {lanes: {modified: {current: 51, tasks, exit: {code: 1}}}});
  assert.equal(f.observer.view().live.status, 'stopped');
  f.put('controller/status.json', {lanes: {modified: {current: 51, tasks, exit: {code: 0}}}});
  const view = f.observer.view();
  assert.equal(view.live.status, 'completed');
  assert.equal(view.live.matched_pairs, 50);
  assert.equal(view.lanes.modified.solves, 49);
  assert.equal(view.lanes.modified.failed_issues, 1);
});

test('negative usage is unknown and symlink journals fail closed', t => {
  const f = fixture(t);
  f.append('modified', f.row(1, 100, {usage: {total_tokens: -1}}));
  assert.equal(f.observer.view().lanes.modified.unknown, 1);
  const file = path.join(f.root, 'controller/modified-usage.jsonl');
  fs.renameSync(file, file + '.old');
  fs.symlinkSync(file + '.old', file);
  assert.throws(() => f.observer.view(), /regular file/);
});

test('unrelated or reordered cohorts cannot acquire matched NEW50 savings labels', t => {
  const f = fixture(t);
  f.put('manifest.json', {tasks: f.tasks.map(task => ({...task, instance_id: 'unrelated__' + task.order}))});
  assert.throws(() => f.observer.view(), /fixed NEW50 cohort/);
});
