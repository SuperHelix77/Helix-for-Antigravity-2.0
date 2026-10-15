import fs from 'node:fs';
import {createHash} from 'node:crypto';
const [source, output] = process.argv.slice(2);
const bytes = fs.readFileSync(source);
const sha = createHash('sha256').update(bytes).digest('hex');
if (sha !== '319b2210b275a54a3062e97b63c496557d6c72cdd88c6594017af1b4ffa2afa0') throw new Error('Cohort selection binding changed');
const data = JSON.parse(bytes);
const tasks = data.tasks.map(row => ({order: row.order, instance_id: row.instance_id, repo: row.repo, base_commit: row.base_commit}));
if (tasks.length !== 50 || new Set(tasks.map(r => r.instance_id)).size !== 50) throw new Error('Expected fixed 50 distinct public tasks');
fs.writeFileSync(output, JSON.stringify({schema: 'helix.public-cohort.v1', dataset: 'SWE-bench/SWE-bench_Lite',
  revision: data.revision, split: data.split, selection_sha256: sha, tasks}, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({public_issues: tasks.length, source_binding: sha}));
