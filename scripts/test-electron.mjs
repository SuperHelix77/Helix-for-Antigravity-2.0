import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {_electron as electron} from 'playwright';
import {request} from '../src/connection.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-electron-public-fixture-'));
let app;
const monitor = process.argv.includes('--monitor');
const packagedIndex = process.argv.indexOf('--packaged');
const packaged = packagedIndex < 0 ? null : fs.realpathSync(process.argv[packagedIndex + 1]);
if (packaged && monitor) throw new Error('The packaged release intentionally has no development monitor');
const errors = [];
try {
  app = await electron.launch({...packaged ? {executablePath: packaged, args: ['--monitor']} : {args: [root, ...(monitor ? ['--monitor'] : [])]}, env: {...process.env, HELIX_HOME: directory, ELECTRON_RUN_AS_NODE: ''}});
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', {name: 'Engine overview', exact: true}).waitFor();
  await page.getByText('Local snapshot only', {exact: true}).waitFor();
  assert.equal(await page.getByText('DEMO / PLAYBACK', {exact: true}).count(), 0);
  assert.equal((await page.evaluate(() => window.helix.snapshot())).privacy.background_llm, false);
  const rpc = (name, args) => request('/rpc', {directory, value: {method: 'tools/call', params: {name, arguments: args}}});
  await rpc('context', {action: 'doctor'});
  await rpc('memory', {action: 'put', project: 'public-fixture', task: 'current', title: 'Literal recovery', body: 'Public synthetic verification note. No personal data.'});
  await page.getByRole('button', {name: 'Refresh snapshot'}).click();
  await page.getByRole('link', {name: 'Memory', exact: true}).click();
  const state = await page.evaluate(() => window.helix.snapshot());
  assert.equal(state.memory.notes, 1, 'IPC must remain trusted after hash navigation');
  const notes = await page.evaluate(() => window.helix.memorySearch({project: 'public-fixture', query: 'Literal'}));
  assert.ok(notes.content[0].text.includes('Public synthetic verification note'));
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  const prefs = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.sandbox, true);
  if (monitor) assert.equal(await page.evaluate(() => window.helix.benchmark()), null);
  else { assert.equal(await page.evaluate(() => typeof window.helix.benchmark), 'undefined'); assert.equal(await page.getByRole('link', {name: 'Benchmarks', exact: true}).count(), 0); }
  await page.getByRole('link', {name: 'Overview', exact: true}).click();
  await page.getByRole('heading', {name: 'Engine overview', exact: true}).waitFor();
  await page.screenshot({path: path.join(root, 'docs/assets', packaged ? 'packaged-release.png' : monitor ? 'monitor-electron.png' : 'release-electron.png'), fullPage: true});
  assert.deepEqual(errors, []);
  const proof = {schema: 'helix.electron-smoke.v1', actual_electron: true, explicit_synthetic_local_memory: true,
    live_service_ipc: true, hash_navigation_ipc: true, context_isolation: true, sandbox: true, node_in_renderer: false, monitor_build: monitor,
    packaged_release: !!packaged, packaged_monitor_flag_ignored: !!packaged, platform: process.platform, arch: process.arch,
    versions: await app.evaluate(() => ({electron: process.versions.electron, node: process.versions.node})),
    background_model_calls: 0, page_errors: errors.length, personal_data_used: false};
  fs.writeFileSync(path.join(root, 'docs', packaged ? 'packaged-electron-proof.json' : monitor ? 'monitor-electron-proof.json' : 'electron-smoke-proof.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof));
} finally {
  if (app) await app.close();
  try { await request('/shutdown', {directory, value: {}}); } catch {}
  for (let i = 0; i < 30 && fs.existsSync(path.join(directory, 'service.lock')); i++) await new Promise(resolve => setTimeout(resolve, 100));
  if (fs.existsSync(path.join(directory, 'service.lock'))) throw new Error('Owned test service did not stop; preserve fixture for review');
  fs.rmSync(directory, {recursive: true, force: true});
}
