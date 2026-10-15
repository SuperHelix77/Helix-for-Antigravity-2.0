const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fields = (value, allowed) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).every(key => allowed.includes(key));
const label = value => typeof value === "string" && value.length > 0 && value.length <= 500;
const failed = value => value === "fail" || value === "error";

// Compare exporter observations, never infer test identity from log counts.
export function parseTestReport(bytes) {
  if (bytes.length > 8 * 1024 * 1024) return null;
  let report;
  try { report = JSON.parse(new TextDecoder("utf8", {fatal:true}).decode(bytes)); }
  catch { return null; }
  if (!fields(report, ["schema", "scope", "suite", "selection", "environment", "runner", "source_revision", "complete", "tests"])
    || report.schema !== "helix.tests.v1" || report.complete !== true
    || !label(report.scope) || !label(report.suite)
    || ![report.selection, report.environment, report.runner].every(sha)
    || typeof report.source_revision !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(report.source_revision)
    || !Array.isArray(report.tests) || report.tests.length > 10000) return null;
  const ids = new Set();
  for (const entry of report.tests) {
    if (!fields(entry, ["id", "status", "traceback"]) || !label(entry.id) || ids.has(entry.id)
      || !["pass", "fail", "error", "skip"].includes(entry.status)
      || (entry.traceback !== undefined && (typeof entry.traceback !== "string" || entry.traceback.length > 1024 * 1024))) return null;
    ids.add(entry.id);
  }
  return report;
}

export function compareTestReports(before, after) {
  if (!before || !after) return {compatible:false, reason:"Incomplete or unsupported structured test report."};
  if (["scope", "suite", "selection", "environment", "runner"].some(key => before[key] !== after[key]))
    return {compatible:false, reason:"Test scope, selection, runner or environment changed."};
  const prior = new Map(before.tests.map(entry => [entry.id, entry]));
  if (prior.size !== after.tests.length || after.tests.some(entry => !prior.has(entry.id)))
    return {compatible:false, reason:"Test identities changed; counts alone cannot establish a delta."};
  const resolved = [], introduced = [], remaining = [], changed = [];
  const counts = report => report.tests.reduce((all, entry) => { all[entry.status]++; return all; }, {pass:0, fail:0, error:0, skip:0});
  for (const entry of after.tests) {
    const old = prior.get(entry.id);
    if (failed(old.status) && entry.status === "pass") resolved.push(entry.id);
    if (failed(entry.status)) {
      remaining.push(entry);
      if (!failed(old.status)) introduced.push(entry.id);
    }
    if (old.status !== entry.status || old.traceback !== entry.traceback)
      changed.push({id:entry.id, before:old.status, after:entry.status, traceback_changed:old.traceback !== entry.traceback});
  }
  return {compatible:true, schema:"helix.test-delta.v1", scope:after.scope, suite:after.suite,
    source_before:before.source_revision, source_after:after.source_revision,
    total:after.tests.length, counts_before:counts(before), counts_after:counts(after),
    resolved, introduced, remaining, changed, semantic_success:null};
}

export function testDeltaText(result, receipt, before, after) {
  const header = `Observed test delta ${receipt}; originals before ${before}, after ${after}. Historical exporter observations, not semantic acceptance.\n`;
  if (!result.compatible) return `${header}Review boundary: ${result.reason} No resolved-test claim.`;
  const counts = value => `pass=${value.pass}, fail=${value.fail}, error=${value.error}, skip=${value.skip}`;
  let text = `${header}${result.total} identical test IDs; before ${counts(result.counts_before)}; after ${counts(result.counts_after)}.\n`
    + `${result.resolved.length} failures now reported passing; ${result.introduced.length} new failures; ${result.remaining.length} failures remain. Source bindings ${result.source_before} -> ${result.source_after}.\n`;
  let shown = 0;
  for (const entry of result.remaining.slice(0, 8)) {
    const line = `${JSON.stringify(entry.id)} ${entry.status}: ${JSON.stringify((entry.traceback ?? "No traceback recorded.").slice(0, 600))}\n`;
    if (Buffer.byteLength(text + line) > 2300) break;
    text += line; shown++;
  }
  if (shown < result.remaining.length) text += "Additional failures/traceback bytes available in exact delta/originals.\n";
  return text;
}
