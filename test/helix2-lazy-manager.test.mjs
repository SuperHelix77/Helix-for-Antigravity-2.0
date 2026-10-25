import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Helix2LazyManager } from '../src/helix2-lazy-manager.mjs';

test('Helix2LazyManager automatically scopes plugins and MCP servers lazily with explicit JIT activation', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-lazy-test-'));
  const pluginsDir = path.join(tmpDir, 'plugins');
  const configJson = path.join(tmpDir, 'config.json');
  const mcpConfigJson = path.join(tmpDir, 'mcp_config.json');
  const mcpActiveDir = path.join(tmpDir, 'mcp');
  const mcpDisabledDir = path.join(tmpDir, 'mcp_disabled');
  const registryFile = path.join(tmpDir, 'lazy_registry.json');

  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.mkdirSync(mcpActiveDir, { recursive: true });

  // 1. Create a dummy plugin with a skill
  const dummyPluginDir = path.join(pluginsDir, 'dummy-biology');
  fs.mkdirSync(path.join(dummyPluginDir, 'skills/genomics'), { recursive: true });
  fs.writeFileSync(path.join(dummyPluginDir, 'plugin.json'), JSON.stringify({ name: 'dummy-biology' }));
  fs.writeFileSync(path.join(dummyPluginDir, 'skills/genomics/SKILL.md'), `---
name: genomics-analyzer
description: Analyze DNA sequence and genomic variants with BLAST and FASTA.
---
# Genomics Analyzer Instructions
Run genomics blast analysis.`);

  // 2. Setup config.json with newly installed plugin set to enabled: true
  fs.writeFileSync(configJson, JSON.stringify({
    plugins: {
      helix: { enabled: true },
      'dummy-biology': { enabled: true }
    }
  }));

  // 3. Setup mcp_config.json with newly added MCP server
  fs.mkdirSync(path.join(mcpActiveDir, 'ghidra_mcp'), { recursive: true });
  fs.writeFileSync(path.join(mcpActiveDir, 'ghidra_mcp/decompile.json'), '{}');
  fs.writeFileSync(mcpConfigJson, JSON.stringify({
    mcpServers: {
      helix: { command: 'node', args: ['helix.mjs'] },
      ghidra_mcp: { command: 'ghidra', args: ['run'] }
    }
  }));

  const manager = new Helix2LazyManager({
    pluginsDir,
    configJson,
    mcpConfigJson,
    mcpActiveDir,
    mcpDisabledDir,
    registryFile
  });

  // Execute autoSync with a generic prompt mentioning common words ("app", "skills", "user")
  const res1 = manager.autoSync({ userPrompt: 'We are working on this app and skills now' });

  // Verify plugin was automatically scoped to false
  assert.ok(res1.scopedPlugins.includes('dummy-biology'));
  const updatedConfig = JSON.parse(fs.readFileSync(configJson, 'utf8'));
  assert.equal(updatedConfig.plugins['dummy-biology'].enabled, false);
  assert.equal(updatedConfig.plugins.helix.enabled, true);

  // Verify MCP server was automatically scoped out of mcp_config.json and schemas moved
  assert.ok(res1.scopedMcp.includes('ghidra_mcp'));
  const updatedMcp = JSON.parse(fs.readFileSync(mcpConfigJson, 'utf8'));
  assert.equal(updatedMcp.mcpServers.ghidra_mcp, undefined);
  assert.ok(fs.existsSync(path.join(mcpDisabledDir, 'ghidra_mcp/decompile.json')));
  assert.ok(!fs.existsSync(path.join(mcpActiveDir, 'ghidra_mcp')));

  // Verify zero JIT match on conversational prompts (zero prompt tokens cost)
  assert.equal(res1.jitMatches.length, 0);

  // Execute autoSync with explicit skill invocation (/skill genomics-analyzer or use skill genomics-analyzer)
  const res2 = manager.autoSync({ userPrompt: 'Please /skill genomics-analyzer' });
  assert.ok(res2.jitMatches.length > 0);
  assert.equal(res2.jitMatches[0].name, 'genomics-analyzer');

  const formattedContext = manager.formatJitContext(res2.jitMatches);
  assert.ok(formattedContext.includes('[HELIX JIT SKILL ACTIVATED: genomics-analyzer (dummy-biology)]'));
  assert.ok(formattedContext.includes('Genomics Analyzer Instructions'));

  // Also test on-demand listSkills and readSkill
  const list = manager.listSkills();
  assert.ok(list.some(s => s.name === 'genomics-analyzer'));

  const content = manager.readSkill('genomics-analyzer');
  assert.ok(content.includes('Run genomics blast analysis'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
