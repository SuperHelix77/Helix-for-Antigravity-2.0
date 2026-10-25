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

// Generic stop words that must NEVER trigger a skill injection
const GENERIC_STOP_WORDS = new Set([
  'app', 'apps', 'skill', 'skills', 'plugin', 'plugins', 'mcp', 'server', 'servers',
  'tool', 'tools', 'make', 'sure', 'this', 'that', 'with', 'from', 'have', 'been',
  'want', 'need', 'also', 'look', 'your', 'user', 'users', 'code', 'cli', 'command',
  'instance', 'price', 'paying', 'invoke', 'easily', 'changes', 'help', 'review',
  'commit', 'test', 'tests', 'testing', 'work', 'working', 'please', 'here', 'there',
  'android', 'firebase', 'design', 'science'
]);

/**
 * Helix Automated Lazy Manager
 * 
 * 1. Zero Prompt Cost: Non-core plugins and MCP servers are scoped off by default.
 * 2. Explicit or High-Specificity JIT Skill Invocation: Skills are ONLY invoked when explicitly
 *    called (e.g. `/skill <name>`, `use skill <name>`) or when exact domain identifiers match.
 * 3. Never triggers on generic English or conversational words.
 * 4. Microsecond cached execution.
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
   * Scan plugins directory and build index of all skills and unique domain keywords.
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

          // Extract ONLY high-specificity domain tokens (>= 5 chars, not in GENERIC_STOP_WORDS)
          const allTokens = `${name} ${description}`.toLowerCase().match(/\b[a-z0-9_-]{5,}\b/g) || [];
          const domainKeywords = [...new Set(allTokens.filter(t => !GENERIC_STOP_WORDS.has(t)))];

          registry.skills.push({
            name,
            plugin: pluginName,
            description: description.slice(0, 300),
            filePath: skillFile,
            keywords: domainKeywords
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
   * Get list of all available lazy skills (for on-demand browsing).
   */
  listSkills() {
    const reg = this.getRegistry();
    return (reg.skills || []).map(s => ({
      name: s.name,
      plugin: s.plugin,
      description: s.description
    }));
  }

  /**
   * Read exact content of a skill on-demand.
   */
  readSkill(skillName) {
    const reg = this.getRegistry();
    const target = (reg.skills || []).find(s => s.name.toLowerCase() === skillName.toLowerCase());
    if (!target) return null;
    try {
      return fs.readFileSync(target.filePath, 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * Main synchronization entrypoint called before each invocation.
   * Scopes newly added plugins and MCPs, and checks for explicit JIT skill invocations.
   */
  autoSync({ userPrompt } = {}) {
    // 1. Check for changes and automatically scope newly added plugins or MCPs
    const scopedPlugins = this.autoScopePlugins();
    const scopedMcp = this.autoScopeMcp();

    // 2. Load registry
    const registry = this.getRegistry();

    if (!userPrompt || typeof userPrompt !== 'string') {
      return { scopedPlugins, scopedMcp, jitMatches: [] };
    }

    // 3. Explicit skill invocation triggers ONLY:
    // e.g. "/skill <name>", "use skill <name>", "invoke skill <name>", "@skill/<name>"
    const explicitMatch = userPrompt.match(/(?:\/skill|invoke-skill|invoke skill|@skill\/|use skill)\s+([a-zA-Z0-9_-]{3,})/i);
    if (!explicitMatch) {
      return { scopedPlugins, scopedMcp, jitMatches: [] };
    }

    const requestedSkill = explicitMatch[1].toLowerCase().replace(/_/g, '-');
    const stopWordsAfterSkill = new Set(['while', 'that', 'with', 'from', 'when', 'more', 'some', 'each', 'what', 'this', 'here', 'without']);
    if (requestedSkill.length < 3 || stopWordsAfterSkill.has(requestedSkill)) {
      return { scopedPlugins, scopedMcp, jitMatches: [] };
    }

    const matches = [];
    for (const skill of registry.skills || []) {
      if (this.alwaysActivePlugins.has(skill.plugin)) continue;

      const skillNameLower = skill.name.toLowerCase().replace(/_/g, '-');
      if (skillNameLower === requestedSkill) {
        matches.push({ ...skill, score: 100 });
        break;
      } else if (requestedSkill.length >= 4 && (skillNameLower.startsWith(requestedSkill) || skillNameLower.endsWith(requestedSkill))) {
        matches.push({ ...skill, score: 60 });
      }
    }

    matches.sort((a, b) => b.score - a.score);
    return {
      scopedPlugins,
      scopedMcp,
      jitMatches: matches.slice(0, 1) // strictly at most 1 skill to preserve context economy
    };
  }

  /**
   * Format any JIT activated skill for ephemeral injection.
   */
  formatJitContext(jitMatches) {
    if (!jitMatches || jitMatches.length === 0) return null;
    const m = jitMatches[0];
    let content = m.description;
    try {
      const raw = fs.readFileSync(m.filePath, 'utf8');
      // Extract only actionable instructions (skip frontmatter, take first 15 lines max)
      const lines = raw.replace(/^---[\s\S]*?---/, '').trim().split('\n');
      const snippet = lines.filter(l => l.trim().length > 0).slice(0, 12).join('\n');
      content = snippet || m.description;
    } catch {}

    return `[HELIX JIT SKILL ACTIVATED: ${m.name} (${m.plugin})]\n${content}\n(Ephemerally loaded for this turn only)`;
  }
}
