import {spawnSync} from 'node:child_process';

export function rtkStatus({executable = process.env.HELIX_RTK_PATH || 'rtk', run = spawnSync} = {}) {
  const result = run(executable, ['--version'], {encoding: 'utf8', timeout: 1000, maxBuffer: 2000, windowsHide: true});
  const version = result.status === 0 ? result.stdout.trim().match(/^rtk\s+([0-9]+\.[0-9]+\.[0-9]+)$/)?.[1] : null;
  return {available: !!version, version: version || null, execution: 'optional; native commands remain available', background_model_calls: 0};
}
