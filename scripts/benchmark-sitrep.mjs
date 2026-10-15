import fs from 'node:fs';
import path from 'node:path';
import {BenchmarkObserver} from '../src/benchmark-observer.mjs';
import {ACCOUNTING_POLICY, compareBenchmarkUsage} from '../src/benchmark-accounting.mjs';

const [directory, afterValue = '0'] = process.argv.slice(2), after = Number(afterValue);
if (!directory || !Number.isInteger(after) || after < 0 || after > 50) throw new Error('Selected run directory and last reported issue 0-50 required');
const view = new BenchmarkObserver(directory).view();
const rows = Object.fromEntries(['vanilla', 'modified'].map(lane => {
  const file = path.join(directory, 'controller', `${lane}-usage.jsonl`);
  return [lane, fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []];
}));
function comparison(order, cumulative) {
  const selected = lane => rows[lane].filter(row => cumulative ? row.order <= order : row.order === order);
  return compareBenchmarkUsage(selected('vanilla'), selected('modified'));
}
const graded = view.pairs.filter(pair => pair.order > after && pair.modified_pass !== null && pair.vanilla_pass !== null);
const {activity: _activity, ...live} = view.live;
console.log(JSON.stringify({accounting_policy: ACCOUNTING_POLICY, live_accounting: 'all-attempts', live, new_grades: graded.map(pair => ({order: pair.order, instance_id: pair.instance_id,
  vanilla_pass: pair.vanilla_pass, modified_pass: pair.modified_pass, ...comparison(pair.order, false),
  cumulative: pair.order <= view.live.matched_pairs ? comparison(pair.order, true) : null})),
  matched_pairs: view.live.matched_pairs, complete: view.complete, complete_billed_savings: null}));
