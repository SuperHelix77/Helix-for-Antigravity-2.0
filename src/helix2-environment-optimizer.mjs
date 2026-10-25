import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const CONFIG_JSON = path.join(HOME, '.gemini/config/config.json');
const MCP_CONFIG_JSON = path.join(HOME, '.gemini/config/mcp_config.json');
const AGY_MCP_DIR = path.join(HOME, '.gemini/antigravity/mcp');
const AGY_MCP_DISABLED_DIR = path.join(HOME, '.gemini/antigravity/mcp_disabled');

export class Helix2EnvironmentOptimizer {
  constructor() {
    this.configJson = CONFIG_JSON;
    this.mcpConfigJson = MCP_CONFIG_JSON;
    this.mcpDir = AGY_MCP_DIR;
    this.mcpDisabledDir = AGY_MCP_DISABLED_DIR;
  }

  /**
   * Scope MCP servers to eliminate bloated schema injections.
   */
  optimizeMcp({ enableRea = false } = {}) {
    if (!fs.existsSync(this.mcpConfigJson)) return { status: 'no_mcp_config' };

    let mcpConfig = {};
    try {
      mcpConfig = JSON.parse(fs.readFileSync(this.mcpConfigJson, 'utf8'));
    } catch {
      return { status: 'parse_error' };
    }

    if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};

    let modified = false;
    let reaArchived = false;

    if (!enableRea && mcpConfig.mcpServers.rea) {
      // Save rea definition to backup
      const reaBackupPath = path.join(HOME, '.gemini/config/mcp_rea_definition.json');
      fs.writeFileSync(reaBackupPath, JSON.stringify(mcpConfig.mcpServers.rea, null, 2), { mode: 0o600 });
      delete mcpConfig.mcpServers.rea;
      modified = true;
      reaArchived = true;
    }

    if (modified) {
      fs.writeFileSync(this.mcpConfigJson, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });
    }

    // Move cached schema directories in ~/.gemini/antigravity/mcp
    try { fs.mkdirSync(this.mcpDisabledDir, { recursive: true, mode: 0o700 }); } catch {}

    const moveDir = (name) => {
      const src = path.join(this.mcpDir, name);
      const dst = path.join(this.mcpDisabledDir, name);
      if (fs.existsSync(src)) {
        try {
          if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
          fs.renameSync(src, dst);
          return true;
        } catch {}
      }
      return false;
    };

    let movedReaSchemas = false;
    let movedScienceSchemas = false;
    if (!enableRea) {
      movedReaSchemas = moveDir('rea');
      movedScienceSchemas = moveDir('science_biomolecular_structure_viewer_mcp');
    }

    return {
      status: 'optimized',
      reaArchived,
      movedReaSchemas,
      movedScienceSchemas,
      activeServers: Object.keys(mcpConfig.mcpServers)
    };
  }

  /**
   * Scope global plugins in config.json so unused plugins (science, huashu-design)
   * don't leak 47 skill summaries and megabytes of schemas into prompt turns.
   */
  optimizePlugins({
    keepActive = ['helix', 'chrome-devtools-plugin', 'modern-web-guidance-plugin', 'google-antigravity-sdk', 'caveman']
  } = {}) {
    if (!fs.existsSync(this.configJson)) return { status: 'no_config_json' };

    let config = {};
    try {
      config = JSON.parse(fs.readFileSync(this.configJson, 'utf8'));
    } catch {
      return { status: 'parse_error' };
    }

    if (!config.plugins) return { status: 'no_plugins_in_config' };

    const disabled = [];
    const active = [];

    for (const [pluginName, pluginMeta] of Object.entries(config.plugins)) {
      if (keepActive.includes(pluginName)) {
        pluginMeta.enabled = true;
        active.push(pluginName);
      } else {
        if (pluginMeta.enabled !== false) {
          pluginMeta.enabled = false;
          disabled.push(pluginName);
        }
      }
    }

    fs.writeFileSync(this.configJson, JSON.stringify(config, null, 2), { mode: 0o600 });

    return {
      status: 'optimized',
      activePlugins: active,
      disabledPlugins: disabled
    };
  }

  /**
   * Restore an MCP server or plugin if the user ever needs it.
   */
  restorePlugin(name) {
    if (!fs.existsSync(this.configJson)) return false;
    const config = JSON.parse(fs.readFileSync(this.configJson, 'utf8'));
    if (config.plugins?.[name]) {
      config.plugins[name].enabled = true;
      fs.writeFileSync(this.configJson, JSON.stringify(config, null, 2), { mode: 0o600 });
      return true;
    }
    return false;
  }
}
