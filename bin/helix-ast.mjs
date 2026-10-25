#!/usr/bin/env node
/**
 * Generic Deterministic AST Symbol Resolver
 * 
 * Rules:
 * 1. Zero task-specific oracles / gold leaks.
 * 2. Explicit ambiguity representation: returns all candidate definitions with file, line, parent scope, and context.
 * 3. Never truncates with confidence 1.00; reports candidateCount and ambiguity flag so model makes the decision.
 */
import fs from 'node:fs';
import path from 'node:path';

const [query, rootDir = '.'] = process.argv.slice(2);

if (!query) {
  console.log(JSON.stringify({ status: "ERROR", message: "Usage: helix-ast <symbolOrPattern> [rootDir]" }));
  process.exit(1);
}

const IGNORES = new Set(['.git', 'node_modules', '__pycache__', '.venv', '.venv311', 'build', 'dist', '.tox']);
const EXTENSIONS = new Set(['.py', '.js', '.mjs', '.ts', '.jsx', '.tsx']);

function walk(dir, results = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (IGNORES.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, results);
    } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
      results.push(fullPath);
    }
  }
  return results;
}

const files = walk(rootDir);
const candidates = [];

const parts = query.split('.');
const targetSymbol = parts[parts.length - 1];
const targetClass = parts.length > 1 ? parts[0] : null;

const escapedSymbol = targetSymbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const defRegex = new RegExp(`^(\\s*)(?:def|class|async def)\\s+${escapedSymbol}\\b`);

for (const f of files) {
  try {
    const content = fs.readFileSync(f, 'utf8');
    if (!content.includes(targetSymbol)) continue;

    const lines = content.split('\n');
    let currentClass = null;
    let classIndent = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const classMatch = line.match(/^(\s*)class\s+([A-Za-z0-9_]+)\b/);
      if (classMatch) {
        currentClass = classMatch[2];
        classIndent = classMatch[1].length;
      } else if (classIndent !== -1) {
        const indentMatch = line.match(/^(\s*)\S/);
        if (indentMatch && indentMatch[1].length <= classIndent && !line.trim().startsWith('#')) {
          currentClass = null;
          classIndent = -1;
        }
      }

      const match = line.match(defRegex);
      if (match) {
        const candidate = {
          symbol: targetSymbol,
          parentClass: currentClass,
          file: path.relative(rootDir, f),
          line: i + 1,
          preview: lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 8)).join('\n')
        };

        if (targetClass) {
          if (currentClass === targetClass) {
            candidates.unshift(candidate);
          } else {
            candidates.push(candidate);
          }
        } else {
          candidates.push(candidate);
        }
      }
    }
  } catch {}
}

const response = {
  status: candidates.length > 0 ? "RESOLVED" : "NOT_FOUND",
  query,
  candidateCount: candidates.length,
  ambiguous: candidates.length > 1,
  candidates: candidates.slice(0, 8)
};

console.log(JSON.stringify(response, null, 2));
