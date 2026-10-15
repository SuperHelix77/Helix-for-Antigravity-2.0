import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {STATE_DIR} from './paths.mjs';
import {privateDirectory, readPrivateJSON} from './local-state.mjs';

export function endpoint(directory = STATE_DIR) {
  const info = readPrivateJSON(path.join(directory, 'endpoint.json'));
  if (!/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(info.url) || !/^[a-f0-9]{64}$/.test(info.token)) throw new Error('Invalid local endpoint');
  return info;
}
export async function request(route, {directory = STATE_DIR, value, signal} = {}) {
  const info = endpoint(directory);
  const response = await fetch(info.url + route, {method: value === undefined ? 'GET' : 'POST',
    headers: {authorization: `Bearer ${info.token}`, ...(value === undefined ? {} : {'content-type': 'application/json'})},
    body: value === undefined ? undefined : JSON.stringify(value), signal: signal || AbortSignal.timeout(value ? 650000 : 5000)});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HELIX returned ${response.status}`);
  if (route === '/health' && data.instance !== info.instance) throw new Error('Endpoint instance mismatch');
  return data;
}
export async function ensureService(directory = STATE_DIR) {
  privateDirectory(directory);
  try { await request('/health', {directory}); return endpoint(directory); } catch {}
  const lock = path.join(directory, 'service.lock');
  if (!fs.existsSync(lock)) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/helix.mjs', import.meta.url)), 'serve'], {
      detached: true, stdio: 'ignore', env: {...process.env, HELIX_HOME: directory, ELECTRON_RUN_AS_NODE: '1'},
    });
    child.unref();
  }
  for (let i = 0; i < 50; i++) {
    try { await request('/health', {directory}); return endpoint(directory); } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('HELIX did not become healthy. Inspect the owned lock; an unknown old process is never killed automatically.');
}

export async function watchModel(onState, {directory = STATE_DIR, signal} = {}) {
  while (!signal?.aborted) {
    try {
      const info = endpoint(directory);
      const response = await fetch(info.url + '/model/events', {headers: {authorization: `Bearer ${info.token}`}, signal});
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Model event feed unavailable');
      const decoder = new TextDecoder(); let pending = '';
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, {stream: true});
        if (pending.length > 65536) throw new Error('Model event frame exceeds limit');
        let end;
        while ((end = pending.indexOf('\n\n')) !== -1) {
          const frame = pending.slice(0, end); pending = pending.slice(end + 2);
          const line = frame.split('\n').find(value => value.startsWith('data: '));
          if (!line) continue;
          const value = JSON.parse(line.slice(6));
          if (!value || typeof value.state !== 'string' || typeof value.observed !== 'boolean') throw new Error('Invalid model event');
          onState(value);
        }
      }
    } catch { if (signal?.aborted) break; }
    if (!signal?.aborted) {
      onState({state: 'unknown', observed: false, source: 'none', model: null, updated_at: null, detail: 'Live model event connection interrupted'});
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, 1000); signal?.addEventListener('abort', done, {once: true});
      });
    }
  }
}
