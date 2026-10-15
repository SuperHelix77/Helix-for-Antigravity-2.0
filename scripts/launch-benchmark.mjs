import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {finished} from 'node:stream/promises';
import {processStartIdentity} from '../src/process-identity.mjs';
import {privateJSON} from '../src/local-state.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function launchBenchmark(directory, approved, {writeOwner = privateJSON, stopAfterMs = 30000} = {}) {
  if (!Number.isInteger(stopAfterMs) || stopAfterMs < 1 || stopAfterMs > 30000) throw new Error('Bounded cancellation deadline required');
  if (!directory || !/^[a-f0-9]{64}$/.test(approved || '')) throw new Error('Explicit benchmark directory and reviewed launch hash required');
  const root = fs.realpathSync(directory), runner = path.join(root, 'runner.mjs');
  const contractBytes = fs.readFileSync(path.join(root, 'controller/launch-contract.json'));
  if (hash(contractBytes) !== approved) throw new Error('Launch contract hash mismatch');
  const contract = JSON.parse(contractBytes);
  if (contract.schema !== 'helix1.new50-launch.v2' || !Array.isArray(contract.bindings) || contract.bindings.length < 980 ||
      !['runner.mjs', 'helix1-readiness.mjs'].every(file => contract.bindings.some(binding => binding.file === file)) ||
      new Set(contract.bindings.map(binding => binding.file)).size !== contract.bindings.length) throw new Error('Complete reviewed runner and readiness bindings required');
  for (const binding of contract.bindings) {
    if (typeof binding.file !== 'string' || path.isAbsolute(binding.file) || binding.file.split('/').includes('..')) throw new Error('Unsafe launch binding');
    const file = path.join(root, binding.file), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || hash(fs.readFileSync(file)) !== binding.sha256 || (stat.mode & 0o777) !== binding.mode) throw new Error('Changed launch input: ' + binding.file);
  }
  const {checkNew50Launch} = await import(pathToFileURL(path.join(root, 'helix1-readiness.mjs')).href);
  const gate = checkNew50Launch({directory: root, approvedHash: approved});
  if (!gate.ready || gate.contract_sha256 !== approved) throw new Error('Benchmark readiness rejected: ' + (gate.failures || []).join('; '));
  const lock = path.join(root, 'controller/monitor-launch.lock'), ownerFile = path.join(root, 'controller/monitor-owner.json');
  fs.mkdirSync(lock, {mode: 0o700});
  let child, exited, output, owner, stopping, settled = false, spawned = false, ownsLog = false, outputError;
  const log = path.join(root, 'controller/controller-console.log'), handlers = new Map();
  async function stopChild(signal = 'SIGTERM') {
    if (!spawned || settled) return;
    if (!stopping) stopping = (async () => {
      child.kill(signal);
      let timer;
      await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, stopAfterMs); })]);
      clearTimeout(timer);
      if (!settled) { child.kill('SIGKILL'); await exited; }
    })();
    await stopping;
  }
  try {
    if (fs.existsSync(ownerFile)) throw new Error('A prior launch owner exists; review it rather than restart a benchmark blindly');
    const fd = fs.openSync(log, 'wx', 0o600); ownsLog = true;
    output = fs.createWriteStream(log, {fd});
    output.on('error', error => { outputError = error; void stopChild(); });
    child = spawn(process.execPath, [runner], {cwd: root, env: {...process.env, HELIX_NEW50_APPROVED_SHA256: approved}, stdio: ['ignore', 'pipe', 'pipe']});
    let spawnError;
    child.once('error', error => { spawnError = error; });
    exited = new Promise(resolve => child.once('close', (code, signal) => { settled = true; resolve({code, signal, error: spawnError}); }));
    spawned = Number.isSafeInteger(child.pid);
    if (!spawned) { const result = await exited; throw result.error || new Error('Benchmark did not start'); }
    owner = {pid: child.pid, start_identity: processStartIdentity(child.pid), runner_sha256: hash(fs.readFileSync(runner)), contract_sha256: approved};
    if (!owner.start_identity) throw new Error('Cannot bind controller liveness');
    writeOwner(ownerFile, owner);
    child.stdout.on('data', bytes => { process.stdout.write(bytes); output.write(bytes); });
    child.stderr.on('data', bytes => { process.stderr.write(bytes); output.write(bytes); });
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = () => { void stopChild(signal); }; handlers.set(signal, handler); process.once(signal, handler);
    }
    const result = await exited;
    if (result.error || outputError) throw result.error || outputError;
    owner.exit = {code: result.code, signal: result.signal}; writeOwner(ownerFile, owner);
    output.end(); await finished(output);
    return result.code ?? 1;
  } catch (error) {
    await stopChild();
    if (spawned) {
      const result = await exited;
      owner ||= {pid: child.pid, contract_sha256: approved};
      owner.exit = {code: result.code, signal: result.signal}; owner.launch_error = error.message;
      try { privateJSON(ownerFile, owner); } catch {}
    }
    throw error;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    if (output && !output.writableFinished) { output.end(); await finished(output).catch(() => {}); }
    if (!spawned) {
      if (ownsLog) fs.unlinkSync(log);
      fs.rmdirSync(lock);
    }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await launchBenchmark(process.argv[2], process.argv[3]);
}
