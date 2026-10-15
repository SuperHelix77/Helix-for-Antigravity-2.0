import test from 'node:test';
import assert from 'node:assert/strict';
import {compileNativeOperation, nativeForegroundTest} from '../src/helix-native-function-bridge.mjs';

const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
async function execute(operation, tools) {
  const observations = [], stop = Symbol('boundary');
  try {
    await new AsyncFunction('tools', 'text', 'exit', compileNativeOperation(operation))(
      tools, value => observations.push(value), () => { throw stop; });
  } catch (error) { if (error !== stop) throw error; }
  return observations.at(-1);
}

test('foreground admission covers all NEW50 ordinals without loosening the literal grammar', () => {
  for (const task of ['1', '10', '11', '24', '46', '50', '51']) {
    const program = `text(await tools.exec_command({cmd:"bench test ${task} 'public'"}));`;
    assert.deepEqual(nativeForegroundTest(program, {task}), {command: {op: 'command', cmd: `bench test ${task} 'public'`}, patch: null});
    assert.equal(nativeForegroundTest(program, {task: String(Number(task) + 1)}), null);
    assert.equal(nativeForegroundTest(program + 'text("extra");', {task}), null);
    assert.equal(nativeForegroundTest(program.replace('}));', ',yield_time_ms:1000}));'), {task}), null);
  }
  for (const task of ['0', '-1', '1.5', '01', 'issue-50', '9007199254740992']) {
    assert.equal(nativeForegroundTest(`text(await tools.exec_command({cmd:"bench test ${task} 'public'"}));`, {task}), null);
  }
});

test('command termination signals stop supervision without any further process read', async () => {
  let executions = 0, polls = 0;
  const result = await execute({op: 'command', cmd: 'synthetic'}, {
    exec_command: async () => { executions++; return {session_id: 7, output: 'interrupted evidence', signal: 'SIGTERM'}; },
    write_stdin: async () => { polls++; throw new Error('must not poll a signalled process'); },
  });
  assert.equal(executions, 1); assert.equal(polls, 0);
  assert.equal(result.output, 'interrupted evidence'); assert.equal(result.signal, 'SIGTERM');
  assert.match(result.boundary, /exit status unavailable/);
});

test('process-read termination signals preserve the observation without further polling', async () => {
  let polls = 0;
  const result = await execute({op: 'process_wait', session_id: 7, chars: ''}, {
    write_stdin: async () => { polls++; return {session_id: 7, output: 'cancelled evidence', signal: 'SIGTERM'}; },
  });
  assert.equal(polls, 1); assert.equal(result.output, 'cancelled evidence');
  assert.equal(result.observations.length, 1); assert.equal(result.signal, 'SIGTERM');
  assert.match(result.boundary, /exit status unavailable/);
});

test('command poll exceptions return complete collected chunks and never replay the command', async () => {
  let executions = 0, polls = 0;
  const result = await execute({op: 'command', cmd: 'synthetic'}, {
    exec_command: async () => { executions++; return {session_id: 7, output: 'first chunk\n'}; },
    write_stdin: async args => {
      assert.equal(args.session_id, 7); assert.equal(args.chars, '');
      if (++polls === 1) return {session_id: 7, output: 'second chunk\n'};
      throw new Error('synthetic transport failure');
    },
  });
  assert.equal(executions, 1); assert.equal(polls, 2);
  assert.equal(result.output, 'first chunk\nsecond chunk\n');
  assert.match(result.boundary, /wait failed/); assert.equal(result.error.message, 'synthetic transport failure');
});

test('process-read poll exceptions preserve full observations without blind retries', async () => {
  let polls = 0;
  const first = {session_id: 7, output: 'partial evidence'};
  const result = await execute({op: 'process_wait', session_id: 7, chars: ''}, {
    write_stdin: async () => { if (++polls === 1) return first; throw new Error('synthetic read failure'); },
  });
  assert.equal(polls, 2); assert.deepEqual(result.observations, [first]);
  assert.equal(result.output, first.output); assert.match(result.boundary, /wait failed/);
});

test('invalid numeric exit states require review rather than successful completion', async () => {
  for (const exit_code of [NaN, Infinity, 0.5]) {
    const command = await execute({op: 'command', cmd: 'synthetic'}, {
      exec_command: async () => ({exit_code, output: 'unknown exit evidence'}),
      write_stdin: async () => assert.fail('must not poll unknown terminal state'),
    });
    const wait = await execute({op: 'process_wait', session_id: 7, chars: ''}, {
      write_stdin: async () => ({exit_code, output: 'unknown exit evidence'}),
    });
    for (const result of [command, wait]) assert.match(result.boundary, /exit status unavailable/);
  }
});
