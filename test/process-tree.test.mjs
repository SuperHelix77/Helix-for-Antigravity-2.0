import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runProcessTree, remainingOperationMs, contractOperationDeadline, windowsJobProcessInvocation} from '../src/process-tree.mjs';

test('captured process output preserves split multibyte sequences on both streams', async () => {
  const script = `process.stdout.write(Buffer.from([0xc3]));process.stderr.write(Buffer.from([0xf0,0x9f]));
    setTimeout(()=>{process.stdout.write(Buffer.from([0xa9]));process.stderr.write(Buffer.from([0x98,0x80]));},60);`;
  const result = await runProcessTree(process.execPath, ['-e', script], {deadline: Date.now() + 10000});
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '\u00e9');
  assert.equal(result.stderr, '\ud83d\ude00');
  const partial = await runProcessTree(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0xc3]))']);
  assert.equal(partial.stdout, '\ufffd', 'Incomplete terminal bytes follow normal decoder behavior');
});

test('output caps, cancellation and absolute deadlines reject rather than report success', async () => {
  await assert.rejects(runProcessTree(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], {maxOutputBytes: 8}),
    error => error.code === 'router_operation_output_limit');
  await assert.rejects(runProcessTree(process.execPath, ['-e', 'setInterval(()=>{},100)'], {deadline: Date.now() + 150}),
    error => error.code === 'router_operation_timeout');
  const controller = new AbortController();
  const cancellation = new Error('Synthetic caller cancellation');
  const running = runProcessTree(process.execPath, ['-e', 'setInterval(()=>{},100)'], {signal: controller.signal});
  controller.abort(cancellation);
  await assert.rejects(running, error => error === cancellation);
  assert.throws(() => runProcessTree(process.execPath, ['-e', 'process.exit(0)'], {encoding: 'invalid-encoding'}), /encoding/i);
});

test('POSIX completion retires owned descendants before returning', {skip: process.platform === 'win32'}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-process-tree-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const marker = path.join(directory, 'descendant');
  const script = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',
    ${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'orphan'),400);setInterval(()=>{},1000);`)}],{stdio:'ignore'});c.unref();`;
  const result = await runProcessTree(process.execPath, ['-e', script], {graceMs: 20, deadline: Date.now() + 10000});
  assert.equal(result.status, 0);
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal(fs.existsSync(marker), false, 'No descendant may mutate after returned completion');
});

test('deadline arithmetic and Windows helper construction are checked without claiming Windows execution', () => {
  assert.equal(remainingOperationMs(1500, undefined, {now: () => 1000}), 500);
  assert.throws(() => remainingOperationMs(1000, undefined, {now: () => 1000}), /deadline/);
  assert.ok(contractOperationDeadline(Date.now() + 30000) < Date.now() + 30000);
  const invocation = windowsJobProcessInvocation('public.exe', ['literal; & argument'], {environment: {SystemRoot: 'C:\\Windows'}});
  assert.match(invocation.command, /powershell/i);
  assert.ok(invocation.args.some(arg => arg.endsWith('windows-process-tree.ps1')));
});
