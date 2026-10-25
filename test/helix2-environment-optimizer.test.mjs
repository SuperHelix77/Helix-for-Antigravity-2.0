import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Helix2EnvironmentOptimizer } from '../src/helix2-environment-optimizer.mjs';

test('Helix2EnvironmentOptimizer scopes MCP servers and plugins accurately', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-env-opt-test-'));
  const configJson = path.join(tmpDir, 'config.json');
  const mcpConfigJson = path.join(tmpDir, 'mcp_config.json');
  const mcpDir = path.join(tmpDir, 'mcp');
  const mcpDisabledDir = path.join(tmpDir, 'mcp_disabled');

  fs.mkdirSync(mcpDir, { recursive: true });
  fs.mkdirSync(path.join(mcpDir, 'rea'), { recursive: true });
  fs.writeFileSync(path.join(mcpDir, 'rea', 'tool1.json'), '{}');

  fs.writeFileSync(configJson, JSON.stringify({
    plugins: {
      helix: { enabled: true },
      science: { enabled: true },
      'huashu-design': { enabled: true },
      'chrome-devtools-plugin': { enabled: true }
    }
  }));

  fs.writeFileSync(mcpConfigJson, JSON.stringify({
    mcpServers: {
      helix: { command: 'node', args: ['helix.mjs'] },
      rea: { command: 'rea', args: ['mcp'] }
    }
  }));

  const opt = new Helix2EnvironmentOptimizer();
  opt.configJson = configJson;
  opt.mcpConfigJson = mcpConfigJson;
  opt.mcpDir = mcpDir;
  opt.mcpDisabledDir = mcpDisabledDir;

  // 1. Optimize MCP
  const mcpResult = opt.optimizeMcp({ enableRea: false });
  assert.equal(mcpResult.status, 'optimized');
  assert.equal(mcpResult.reaArchived, true);
  assert.deepEqual(mcpResult.activeServers, ['helix']);
  assert.ok(!fs.existsSync(path.join(mcpDir, 'rea')));
  assert.ok(fs.existsSync(path.join(mcpDisabledDir, 'rea')));

  // 2. Optimize Plugins
  const pluginResult = opt.optimizePlugins({ keepActive: ['helix', 'chrome-devtools-plugin'] });
  assert.equal(pluginResult.status, 'optimized');
  assert.ok(pluginResult.disabledPlugins.includes('science'));
  assert.ok(pluginResult.disabledPlugins.includes('huashu-design'));

  const updatedConfig = JSON.parse(fs.readFileSync(configJson, 'utf8'));
  assert.equal(updatedConfig.plugins.science.enabled, false);
  assert.equal(updatedConfig.plugins['huashu-design'].enabled, false);
  assert.equal(updatedConfig.plugins.helix.enabled, true);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
