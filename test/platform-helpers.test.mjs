import test from 'node:test';
import assert from 'node:assert/strict';
import {processStartIdentityProbe, processCommandLine, stateOwnsProcess} from '../src/process-identity.mjs';
import {codexPatchHookEndpoint, CODEX_PATCH_HOOK_BASE_PATH} from '../src/codex-patch-hook-endpoint.mjs';

test('identity probes distinguish absent, alive and unknown without treating PID alone as ownership', () => {
  for (const pid of [0, -1, NaN, '1']) {
    assert.deepEqual(processStartIdentityProbe(pid), {state: 'unknown'});
    assert.equal(processCommandLine(pid), undefined);
  }
  for (const platform of ['darwin', 'win32']) {
    const spawn = (_command, _args, options) => {
      assert.equal(options.encoding, 'utf8');
      if (platform === 'win32') { assert.equal(options.windowsHide, true); assert.ok(options.timeout > 0); }
      return {status: 0, stdout: 'start|public.exe\n'};
    };
    assert.deepEqual(processStartIdentityProbe(1, {spawn, platform}), {state: 'alive', identity: 'start|public.exe'});
    assert.equal(processCommandLine(1, {spawn, platform}), 'start|public.exe');
    assert.deepEqual(processStartIdentityProbe(1, {platform, spawn: () => ({status: platform === 'win32' ? 3 : 1})}), {state: 'absent'});
    assert.deepEqual(processStartIdentityProbe(1, {platform, spawn: () => { throw new Error('probe denied'); }}), {state: 'unknown'});
    assert.equal(processCommandLine(1, {platform, spawn: () => ({status: 1})}), undefined);
  }
  const state = {managed: true, pid: 1, processIdentity: 'start|public.exe'};
  assert.equal(stateOwnsProcess(state, {identity: () => state.processIdentity}), true);
  for (const change of [{managed: false}, {pid: 0}, {processIdentity: ''}])
    assert.equal(stateOwnsProcess({...state, ...change}, {identity: () => state.processIdentity}), false);
  assert.equal(stateOwnsProcess(state, {identity: () => 'another process'}), false);
});

test('structured patch capability normalizes exact authenticated path prefixes only', () => {
  assert.deepEqual(codexPatchHookEndpoint(CODEX_PATCH_HOOK_BASE_PATH), {pathname: '/v1', capability: 'structured-patch-v1'});
  assert.deepEqual(codexPatchHookEndpoint(CODEX_PATCH_HOOK_BASE_PATH + '/responses'), {pathname: '/v1/responses', capability: 'structured-patch-v1'});
  for (const pathname of [undefined, null, '/v1/responses', CODEX_PATCH_HOOK_BASE_PATH + '-foreign/responses'])
    assert.deepEqual(codexPatchHookEndpoint(pathname), {pathname});
});
