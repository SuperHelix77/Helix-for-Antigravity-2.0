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

export function qualifyTestExit(engine, result) {
  const stdout = engine.archive(Buffer.from(result.stdout)), stderr = engine.archive(Buffer.from(result.stderr));
  const receipt = createCompactReceipt(engine, {stdout, stderr, exit_code: result.exit_code, signal: result.signal ?? null, failure: result.tooLarge ? 'output capped' : null});
  const packet = engine.objectJSON(receipt);
  const counts = [...packet.stdout.counts, ...packet.stderr.counts];
  const failures = counts.filter(row => ['failed', 'fail', 'error', 'errors', 'cancelled'].includes(row.label) && row.value > 0);
  const empty = /(?:^|\n).*\b(?:no tests ran|collected 0 items)\b/.test(result.stdout + '\n' + result.stderr);
  const boundary = failures.length ? 'Reported test failures contradict successful shell exit' : empty ? 'No tests executed' : null;
  return {...result, ...(result.exit_code === 0 && boundary ? {verification_exit_code: 78, verification_boundary: boundary} : {}),
    verification_receipt: receipt, semantic_success: null};
}
