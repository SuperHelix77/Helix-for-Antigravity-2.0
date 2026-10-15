import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {publicBenchmark, publicCSV} from './public-benchmark.mjs';

const [source, output] = process.argv.slice(2);
if (!source || !output) throw new Error('Usage: node scripts/export-benchmark.mjs PRIVATE_RUN OUTPUT_DIRECTORY');
const bytes = fs.readFileSync(path.join(source, 'controller/final-results.json'));
const auditBytes = fs.readFileSync(path.join(source, 'controller/completion-audit.json'));
const data = JSON.parse(bytes), audit = JSON.parse(auditBytes);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
if (audit.verified !== true || audit.final_results_sha256 !== sha(bytes)) throw new Error('Final result is not bound to its verified completion audit');
const report = publicBenchmark(data, path.basename(output));
const csv = publicCSV(fs.readFileSync(path.join(source, 'controller/per-task-results.csv'), 'utf8'), report.pairs);
report.source_results_sha256 = sha(bytes); report.audit_receipt_sha256 = sha(auditBytes);
fs.mkdirSync(output, {recursive: true});
// Both documents have been reconstructed from validated allowlists before write.
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
fs.writeFileSync(path.join(output, 'per-issue.csv'), csv);
console.log(JSON.stringify({published_issues: report.pairs.length, complete: report.complete, raw_requests_exported: 0, source_results_sha256: report.source_results_sha256}));
