const {app, BrowserWindow, ipcMain, dialog} = require('electron');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const fs = require('node:fs');

if (process.env.HELIX_HOME) {
  const data = path.join(process.env.HELIX_HOME, 'desktop-data');
  fs.mkdirSync(data, {recursive: true, mode: 0o700});
  app.setPath('userData', data);
}

let request, home;
const monitor = !app.isPackaged && process.argv.includes('--monitor');
if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(async () => {
  const connection = await import('../src/connection.mjs');
  const state = await import('../src/paths.mjs');
  request = connection.request; home = state.STATE_DIR;
  await connection.ensureService(home);
  const icon = path.join(__dirname, '../docs/assets/app-icon.png');
  if (fs.existsSync(icon)) app.dock?.setIcon(icon);
  const url = pathToFileURL(path.join(__dirname, monitor ? '../dist-monitor/index.html' : '../dist/index.html')).href;
  const window = new BrowserWindow({width: 1440, height: 960, minWidth: 760, minHeight: 600, show: false,
    title: 'HELIX', icon, backgroundColor: '#191d1c', webPreferences: {preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      additionalArguments: monitor ? ['--helix-monitor'] : []}});
  const trusted = event => {
    const source = new URL(event.senderFrame?.url || 'about:blank'); source.hash = '';
    if (event.sender !== window.webContents || event.senderFrame?.parent || source.href !== url) throw new Error('Untrusted frame');
  };
  ipcMain.handle('helix:snapshot', event => { trusted(event); return request('/snapshot'); });
  if (monitor) ipcMain.handle('helix:benchmark', event => { trusted(event); return request('/benchmark'); });
  if (monitor) ipcMain.handle('helix:choose-benchmark', async event => {
    trusted(event);
    const result = await dialog.showOpenDialog(window, {properties: ['openDirectory'], title: 'Select a HELIX benchmark'});
    if (result.canceled) return null;
    const {benchmarkSourceView} = await import('../src/benchmark-view.mjs');
    const {privateJSON} = await import('../src/local-state.mjs');
    const view = benchmarkSourceView(result.filePaths[0]);
    privateJSON(path.join(home, 'monitor.json'), {benchmark: result.filePaths[0]});
    return view;
  });
  ipcMain.handle('helix:evidence', (event, handle, offset = 0, limit = 12000) => {
    trusted(event);
    if (!/^(?:[A-Za-z0-9_-]{43}|[a-f0-9]{64})$/.test(handle) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 24000) throw new Error('Invalid evidence range');
    return request('/rpc', {value: {method: 'tools/call', params: {name: 'context', arguments: {action: 'raw', receipt: handle, offset, limit}}}});
  });
  ipcMain.handle('helix:memory-search', (event, args) => {
    trusted(event);
    if (!args || Object.keys(args).some(k => !['project', 'task', 'source', 'query', 'limit'].includes(k))) throw new Error('Invalid memory search');
    return request('/rpc', {value: {method: 'tools/call', params: {name: 'memory', arguments: {...args, action: 'search'}}}});
  });
  ipcMain.handle('helix:memory-projects', event => { trusted(event); return request('/memory/projects'); });
  for (const action of ['browse', 'read']) ipcMain.handle(`helix:memory-${action}`, (event, args) => {
    trusted(event);
    if (!args || Object.keys(args).some(k => !['project', 'task', 'source', 'id', 'limit', 'cursor'].includes(k))) throw new Error('Invalid memory request');
    return request(`/memory/${action}`, {value: args});
  });
  ipcMain.handle('helix:memory-connect', async event => {
    trusted(event);
    const result = await dialog.showOpenDialog(window, {properties: ['openFile'], title: 'Connect Claude-Mem read-only', filters: [{name: 'SQLite database', extensions: ['db', 'sqlite', 'sqlite3']}]});
    if (result.canceled) return null;
    return request('/memory/connect', {value: {file: result.filePaths[0]}});
  });
  ipcMain.handle('helix:diagnostics', event => { trusted(event); return request('/diagnostics'); });
  ipcMain.handle('helix:restart-core', event => { trusted(event); return request('/core/restart', {value: {}}); });
  window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.on('will-download', event => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  await window.loadURL(url);
  const modelFeed = new AbortController();
  void connection.watchModel(value => { if (!window.isDestroyed()) window.webContents.send('helix:model-state', value); }, {directory: home, signal: modelFeed.signal});
  window.once('closed', () => modelFeed.abort());
  app.on('second-instance', () => { if (window.isMinimized()) window.restore(); window.focus(); });
}).catch(error => { console.error(error.message); app.quit(); });
app.on('window-all-closed', () => app.quit());
