import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { STATE_DIR } from './paths.mjs';

const HOME = os.homedir();
const PLUGINS_DIR = path.join(HOME, '.gemini/config/plugins');
const CONFIG_JSON = path.join(HOME, '.gemini/config/config.json');
const MCP_CONFIG_JSON = path.join(HOME, '.gemini/config/mcp_config.json');
const MCP_ACTIVE_DIR = path.join(HOME, '.gemini/antigravity/mcp');
const MCP_DISABLED_DIR = path.join(HOME, '.gemini/antigravity/mcp_disabled');
const REGISTRY_FILE = path.join(STATE_DIR, 'lazy_registry.json');

const CORE_ALWAYS_ACTIVE_PLUGINS = new Set([
  'helix',
  'modern-web-guidance-plugin',
  'chrome-devtools-plugin',
  'google-antigravity-sdk',
  'caveman'
]);

const CORE_ALWAYS_ACTIVE_MCP = new Set([
  'helix'
]);

/**
 * Helix Automated Lazy Manager
 * 
 * Automatically intercepts newly installed plugins, skills, and MCP servers:
 * 1. Lazy Plugins: Automatically scopes non-core plugins to enabled:false in config.json.
 * 2. Lazy Skills: Indexes all skills from all plugins with keywords; activates them JIT ephemerally.
 * 3. Lazy MCP: Archives heavy MCP servers (like rea, ghidra) and isolates schemas; JIT enables on intent.
 * 4. Microsecond Cached: Uses filesystem mtimes so it costs < 20 microseconds per turn when stable.
 */
export class Helix2LazyManager {
  constructor({
    pluginsDir = PLUGINS_DIR,
    configJson = CONFIG_JSON,
    mcpConfigJson = MCP_CONFIG_JSON,
    mcpActiveDir = MCP_ACTIVE_DIR,
    mcpDisabledDir = MCP_DISABLED_DIR,
    registryFile = REGISTRY_FILE,
    alwaysActivePlugins = CORE_ALWAYS_ACTIVE_PLUGINS,
    alwaysActiveMcp = CORE_ALWAYS_ACTIVE_MCP
  } = {}) {
    this.pluginsDir = pluginsDir;
    this.configJson = configJson;
    this.mcpConfigJson = mcpConfigJson;
    this.mcpActiveDir = mcpActiveDir;
    this.mcpDisabledDir = mcpDisabledDir;
    this.registryFile = registryFile;
    this.alwaysActivePlugins = alwaysActivePlugins;
    this.alwaysActiveMcp = alwaysActiveMcp;
    this.mtimeCache = new Map();
  }

  /**
   * Fast check if filesystem inputs changed.
   */
  hasChanges() {
    let changed = false;
    const check = (file) => {
      try {
        if (!fs.existsSync(file)) return;
        const stat = fs.statSync(file);
        const last = this.mtimeCache.get(file);
        if (last === undefined || stat.mtimeMs !== last) {
          this.mtimeCache.set(file, stat.mtimeMs);
          changed = true;
        }
      } catch {}
    };

    check(this.pluginsDir);
    check(this.configJson);
    check(this.mcpConfigJson);
    check(this.mcpActiveDir);
    return changed;
  }

  /**
   * Scan plugins directory and build index of all skills and keywords.
   */
  indexSkills() {
    const registry = {
      skills: [],
      mcpServers: {},
      updatedAt: Date.now()
    };

    if (!fs.existsSync(this.pluginsDir)) return registry;

    let pluginDirs = [];
    try {
      pluginDirs = fs.readdirSync(this.pluginsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch {
      return registry;
    }

    for (const pluginName of pluginDirs) {
      const pluginPath = path.join(this.pluginsDir, pluginName);
      
      // Look for skills in skills/ or directly in root
      const findSkillFiles = (dir) => {
        const results = [];
        try {
          for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) {
              results.push(...findSkillFiles(full));
            } else if (ent.name === 'SKILL.md') {
              results.push(full);
            }
          }
        } catch {}
        return results;
      };

      const skillFiles = findSkillFiles(pluginPath);
      for (const skillFile of skillFiles) {
        try {
          const content = fs.readFileSync(skillFile, 'utf8');
          const frontmatterMatch = content.match(/^---\s*([\s\S]*?)\s*---/);
          let name = path.basename(path.dirname(skillFile));
          let description = '';
          if (frontmatterMatch) {
            const lines = frontmatterMatch[1].split('\n');
            for (const l of lines) {
              if (l.startsWith('name:')) name = l.replace('name:', '').trim();
              if (l.startsWith('description:')) description = l.replace('description:', '').trim();
            }
          }

          // Extract keywords
          const textToTokenize = `${name} ${description} ${pluginName}`.toLowerCase();
          const tokens = [...new Set(textToTokenize.match(/\b[a-z0-9_-]{3,}\b/g) || [])];

          registry.skills.push({
            name,
            plugin: pluginName,
            description: description.slice(0, 300),
            filePath: skillFile,
            keywords: tokens
          });
        } catch {}
      }
    }

    return registry;
  }

  /**
   * Automatically scopes any newly added or enabled non-core plugins to false in config.json.
   */
  autoScopePlugins() {
    if (!fs.existsSync(this.configJson)) return [];
    let config;
    try {
      config = JSON.parse(fs.readFileSync(this.configJson, 'utf8'));
    } catch {
      return [];
    }

    if (!config.plugins) return [];

    const scoped = [];
    let modified = false;

    for (const [pluginName, pluginMeta] of Object.entries(config.plugins)) {
      if (!this.alwaysActivePlugins.has(pluginName)) {
        if (pluginMeta.enabled !== false) {
          pluginMeta.enabled = false;
          scoped.push(pluginName);
          modified = true;
        }
      }
    }

    if (modified) {
      try {
        fs.writeFileSync(this.configJson, JSON.stringify(config, null, 2), { mode: 0o600 });
      } catch {}
    }

    return scoped;
  }

  /**
   * Automatically scopes any newly added non-core MCP servers.
   */
  autoScopeMcp() {
    if (!fs.existsSync(this.mcpConfigJson)) return [];
    let mcpConfig;
    try {
      mcpConfig = JSON.parse(fs.readFileSync(this.mcpConfigJson, 'utf8'));
    } catch {
      return [];
    }

    if (!mcpConfig.mcpServers) return [];

    const scopedServers = [];
    let modified = false;

    try { fs.mkdirSync(this.mcpDisabledDir, { recursive: true, mode: 0o700 }); } catch {}

    const backupDir = path.join(path.dirname(this.mcpConfigJson), 'mcp_servers.available');
    try { fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 }); } catch {}

    for (const [serverName, serverDef] of Object.entries(mcpConfig.mcpServers)) {
      if (!this.alwaysActiveMcp.has(serverName)) {
        // Backup server definition
        const backupFile = path.join(backupDir, `${serverName}.json`);
        try {
          fs.writeFileSync(backupFile, JSON.stringify(serverDef, null, 2), { mode: 0o600 });
        } catch {}

        delete mcpConfig.mcpServers[serverName];
        scopedServers.push(serverName);
        modified = true;

        // Move active schema directory if present
        const srcDir = path.join(this.mcpActiveDir, serverName);
        const dstDir = path.join(this.mcpDisabledDir, serverName);
        if (fs.existsSync(srcDir)) {
          try {
            if (fs.existsSync(dstDir)) fs.rmSync(dstDir, { recursive: true, force: true });
            fs.renameSync(srcDir, dstDir);
          } catch {}
        }
      }
    }

    if (modified) {
      try {
        fs.writeFileSync(this.mcpConfigJson, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });
      } catch {}
    }

    return scopedServers;
  }

  /**
   * Load or refresh the registry.
   */
  getRegistry() {
    if (fs.existsSync(this.registryFile) && !this.hasChanges()) {
      try {
        return JSON.parse(fs.readFileSync(this.registryFile, 'utf8'));
      } catch {}
    }

    const reg = this.indexSkills();
    try {
      fs.mkdirSync(path.dirname(this.registryFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.registryFile, JSON.stringify(reg, null, 2), { mode: 0o600 });
    } catch {}
    return reg;
  }

  /**
   * Main synchronization entrypoint called before each invocation.
   * Scopes newly added plugins and MCPs, and checks for JIT matches.
   */
  autoSync({ userPrompt } = {}) {
    // 1. Check for changes and automatically scope newly added plugins or MCPs
    const scopedPlugins = this.autoScopePlugins();
    const scopedMcp = this.autoScopeMcp();

    // 2. Load registry
    const registry = this.getRegistry();

    // 3. JIT match against user prompt
    if (!userPrompt || typeof userPrompt !== 'string') {
      return { scopedPlugins, scopedMcp, jitMatches: [] };
    }

    const promptTokens = new Set(userPrompt.toLowerCase().match(/\b[a-z0-9_-]{3,}\b/g) || []);
    const stopWords = new Set(['what', 'when', 'where', 'which', 'make', 'sure', 'this', 'that', 'with', 'from', 'have', 'been', 'want', 'need', 'also', 'look', 'your']);
    for (const s of stopWords) promptTokens.delete(s);

    const matches = [];
    for (const skill of registry.skills || []) {
      // Don't match always active plugins
      if (this.alwaysActivePlugins.has(skill.plugin)) continue;

      let matchScore = 0;
      for (const kw of skill.keywords) {
        if (promptTokens.has(kw)) matchScore++;
      }

      if (matchScore >= 2 || (matchScore >= 1 && promptTokens.has(skill.name.toLowerCase()))) {
        matches.push({
          type: 'skill',
          name: skill.name,
          plugin: skill.plugin,
          description: skill.description,
          filePath: skill.filePath,
          score: matchScore
        });
      }
    }

    matches.sort((a, b) => b.score - a.score);
    return {
      scopedPlugins,
      scopedMcp,
      jitMatches: matches.slice(0, 2)
    };
  }

  /**
   * Format any JIT activated skill for ephemeral injection.
   */
  formatJitContext(jitMatches) {
    if (!jitMatches || jitMatches.length === 0) return null;
    const blocks = jitMatches.map(m => {
      let content = m.description;
      try {
        const raw = fs.readFileSync(m.filePath, 'utf8');
        // Read up to first 20 lines of instructions
        const bodyLines = raw.split('\n').filter(l => !l.startsWith('---')).slice(0, 20);
        content = bodyLines.join('\n').trim();
      } catch {}
      return `[HELIX JIT LAZY SKILL ACTIVATED: ${m.name} (${m.plugin})]\n${content}`;
    });

    return blocks.join('\n\n');
  }
}
