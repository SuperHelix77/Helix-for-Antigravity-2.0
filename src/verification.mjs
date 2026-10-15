import {createCompactReceipt} from './helix-evidence.mjs';

export function verificationCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k => !['cmd', 'argv', 'workdir'].includes(k)) ||
      value.workdir !== undefined && (typeof value.workdir !== 'string' || !value.workdir.trim())) throw new Error('Invalid declared verification');
  if (value.argv !== undefined) {
    if (value.cmd !== undefined || !Array.isArray(value.argv) || !value.argv.length || value.argv.length > 128 ||
        value.argv.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 100000) || !value.argv[0]) throw new Error('One explicit argv verifier required');
    if (process.platform === 'win32') throw new Error('Native argv verification adapter not yet verified on Windows');
    const quote = arg => "'" + arg.replaceAll("'", "'\\''") + "'";
    return {cmd: 'exec ' + value.argv.map(quote).join(' '), ...(value.workdir === undefined ? {} : {workdir: value.workdir})};
  }
  // Conservative admission, not a shell parser. Complex scripts belong in an
  // explicitly selected argv program, not an implicitly successful final clause.
  if (typeof value.cmd !== 'string' || !value.cmd.trim() || value.cmd.length > 100000 || /[;&|`\n\r<>$()]/.test(value.cmd)) throw new Error('Compound shell verification is not admitted; supply one explicit argv verifier or separate reviewed checks');
  return {cmd: value.cmd, ...(value.workdir === undefined ? {} : {workdir: value.workdir})};
}

// Self-contained so the native execution template uses this exact same guard.
// Recognized contradictions block acceptance; absence of one is not semantic PASS.
export function verificationBoundary(result) {
  if (!result || result.exit_code !== 0 || result.signal || result.boundary)
    return 'Declared verification failed or its completion is unknown';
  if (result.tooLarge || result.truncated || result.output_truncated)
    return 'Verification output is incomplete';
  const outputs = typeof result.output === 'string' ? [result.output]
    : typeof result.stdout === 'string' && typeof result.stderr === 'string' ? [result.stdout, result.stderr] : null;
  if (!outputs) return 'Verification output is unavailable';
  for (const output of outputs) {
    if (/^\s*not ok(?:\s|$)|^\s*FAILED(?:\s+\(|\s+\S+::)/m.test(output))
      return 'Reported test failures contradict successful shell exit';
    for (const line of output.split('\n')) {
      if (/\b(?:no tests ran|collected 0 items)\b/i.test(line) ||
          /^\s*(?:#\s*|\u2139\s*)?tests\s*[:=]?\s+0\s*$/i.test(line)) return 'No tests executed';
      if (/^\s*(?:#\s*|\u2716\s*)?(?:fail(?:ed|ures)?|errors?|cancelled)\s*[:=]?\s+[1-9]\d*\b/i.test(line) ||
          /\b[1-9]\d*\s+(?:failed|failures?|errors?|cancelled)\b/i.test(line))
        return 'Reported test failures contradict successful shell exit';
    }
    let report;
    try { report = JSON.parse(output); } catch { continue; }
    if (report?.schema !== 'helix.tests.v1') continue;
    if (report.complete !== true || !Array.isArray(report.tests) ||
        report.tests.some(item => !['pass', 'fail', 'error', 'skip'].includes(item?.status)))
      return 'Verification report is incomplete';
    if (!report.tests.some(item => item.status !== 'skip')) return 'No tests executed';
    if (report.tests.some(item => ['fail', 'error'].includes(item.status)))
      return 'Reported test failures contradict successful shell exit';
  }
  return null;
}

export function qualifyTestExit(engine, result) {
  const stdout = engine.archive(Buffer.from(result.stdout)), stderr = engine.archive(Buffer.from(result.stderr));
  const receipt = createCompactReceipt(engine, {stdout, stderr, exit_code: result.exit_code, signal: result.signal ?? null, failure: result.tooLarge ? 'output capped' : null});
  const boundary = verificationBoundary(result);
  return {...result, ...(result.exit_code === 0 && boundary ? {verification_exit_code: 78, verification_boundary: boundary} : {}),
    verification_receipt: receipt, semantic_success: null};
}
