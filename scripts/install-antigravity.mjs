import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const home = os.homedir();
const pluginSrc = path.join(root, 'plugin');
const pluginDst = path.join(home, '.gemini/config/plugins/helix');
const mcpDst = path.join(home, '.gemini/antigravity/mcp/helix');
const binDst = path.join(home, '.gemini/antigravity/bin');

console.log('Installing Helix for Antigravity - 2.0 native plugin and MCP layer...');

// 1. Copy plugin files
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

copyDir(pluginSrc, pluginDst);
// Remove mcp subdir from pluginDst if copied
if (fs.existsSync(path.join(pluginDst, 'mcp'))) {
  fs.rmSync(path.join(pluginDst, 'mcp'), { recursive: true, force: true });
}

// 2. Copy MCP schemas
fs.mkdirSync(mcpDst, { recursive: true });
const mcpSrc = path.join(pluginSrc, 'mcp');
if (fs.existsSync(mcpSrc)) {
  for (const file of fs.readdirSync(mcpSrc)) {
    fs.copyFileSync(path.join(mcpSrc, file), path.join(mcpDst, file));
  }
}

// 3. Make hook executable
const hookPath = path.join(pluginDst, 'hooks/pre-invocation.mjs');
if (fs.existsSync(hookPath)) {
  fs.chmodSync(hookPath, 0o755);
}

// 4. Create symlink in ~/.gemini/antigravity/bin/helix if bin dir exists
if (fs.existsSync(binDst)) {
  const symTarget = path.join(binDst, 'helix');
  try {
    if (fs.existsSync(symTarget) || fs.lstatSync(symTarget).isSymbolicLink()) {
      fs.unlinkSync(symTarget);
    }
  } catch {}
  try {
    fs.symlinkSync(path.join(root, 'bin/helix.mjs'), symTarget);
    console.log(`Symlinked CLI: ${symTarget} -> ${path.join(root, 'bin/helix.mjs')}`);
  } catch (err) {
    console.log(`Note: could not symlink CLI: ${err.message}`);
  }
}

console.log('Helix for Antigravity - 2.0 successfully installed:');
console.log(`- Plugin: ${pluginDst}`);
console.log(`- MCP Schemas: ${mcpDst}`);
console.log(`- Hook: ${hookPath}`);
