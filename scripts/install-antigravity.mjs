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

// 1.5 Copy src and bin so plugin is completely standalone and self-contained
copyDir(path.join(root, 'src'), path.join(pluginDst, 'src'));
copyDir(path.join(root, 'bin'), path.join(pluginDst, 'bin'));

// 2. Copy MCP schemas
fs.mkdirSync(mcpDst, { recursive: true });
const mcpSrc = path.join(pluginSrc, 'mcp');
if (fs.existsSync(mcpSrc)) {
  for (const file of fs.readdirSync(mcpSrc)) {
    fs.copyFileSync(path.join(mcpSrc, file), path.join(mcpDst, file));
  }
}

// 3. Make all hooks and binaries executable
const hooksDir = path.join(pluginDst, 'hooks');
if (fs.existsSync(hooksDir)) {
  for (const f of fs.readdirSync(hooksDir)) {
    try { fs.chmodSync(path.join(hooksDir, f), 0o755); } catch {}
  }
}
const pluginBinDir = path.join(pluginDst, 'bin');
if (fs.existsSync(pluginBinDir)) {
  for (const f of fs.readdirSync(pluginBinDir)) {
    try { fs.chmodSync(path.join(pluginBinDir, f), 0o755); } catch {}
  }
}

// 4. Create CLI executable (symlink on Unix/macOS, batch/powershell shim on Windows, wrapper fallback)
if (fs.existsSync(binDst)) {
  const symTarget = path.join(binDst, 'helix');
  const entryPath = path.join(root, 'bin/helix.mjs');
  
  if (process.platform === 'win32') {
    // Windows: create .cmd batch shim and .ps1 script
    try {
      const cmdShim = path.join(binDst, 'helix.cmd');
      const psShim = path.join(binDst, 'helix.ps1');
      fs.writeFileSync(cmdShim, `@ECHO OFF\r\nnode "${entryPath}" %*\r\n`);
      fs.writeFileSync(psShim, `& node "${entryPath}" $args\r\n`);
      console.log(`Created Windows CLI shims: ${cmdShim}, ${psShim}`);
    } catch (err) {
      console.log(`Note: could not write Windows shims: ${err.message}`);
    }
  } else {
    // macOS / Linux: try symlink, fallback to executable shell script wrapper
    try {
      if (fs.existsSync(symTarget) || (() => { try { return fs.lstatSync(symTarget).isSymbolicLink(); } catch { return false; } })()) {
        fs.unlinkSync(symTarget);
      }
    } catch {}
    
    let symlinked = false;
    try {
      fs.symlinkSync(entryPath, symTarget);
      console.log(`Symlinked CLI: ${symTarget} -> ${entryPath}`);
      symlinked = true;
    } catch (err) {
      // Fallback: create executable POSIX wrapper script
      try {
        const shContent = `#!/bin/sh\nexec node "${entryPath}" "$@"\n`;
        fs.writeFileSync(symTarget, shContent, { mode: 0o755 });
        console.log(`Created CLI wrapper script: ${symTarget}`);
        symlinked = true;
      } catch (wrapperErr) {
        console.log(`Note: could not create CLI binary: ${wrapperErr.message}`);
      }
    }
  }
}

console.log('Helix for Antigravity - 2.0 successfully installed:');
console.log(`- Plugin: ${pluginDst}`);
console.log(`- MCP Schemas: ${mcpDst}`);
console.log(`- Hooks: ${hooksDir}`);
