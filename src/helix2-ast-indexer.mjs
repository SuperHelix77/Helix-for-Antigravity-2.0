import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Helix2AstIndexer
 * 
 * Provides surgical symbol-level inspection rather than reading 400-line blocks.
 * Extracts function, class, and method definitions with signature, docstring,
 * and body without pulling the entire file into conversation context.
 */
export class Helix2AstIndexer {
  constructor() {}

  /**
   * Extracts a specific symbol (class, function, or method) from a file.
   */
  extractSymbol(filePath, symbolName) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File does not exist: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.py') {
      return this.#extractPythonSymbol(content, symbolName, filePath);
    } else if (['.js', '.mjs', '.cjs', '.ts'].includes(ext)) {
      return this.#extractJsSymbol(content, symbolName, filePath);
    } else {
      // Fallback: literal search
      return this.#extractGenericSymbol(content, symbolName, filePath);
    }
  }

  /**
   * Surgical Python symbol extraction using structural indentation parsing.
   */
  #extractPythonSymbol(content, symbolName, filePath) {
    const lines = content.split('\n');
    const targetRegex = new RegExp(`^(?:async\\s+)?(?:def|class)\\s+${symbolName}\\b`);
    
    let startLine = -1;
    let baseIndent = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(/^(\s*)(?:async\s+)?(?:def|class)\s+([a-zA-Z0-9_]+)\b/);
      if (match && match[2] === symbolName) {
        startLine = i;
        baseIndent = match[1].length;
        break;
      }
    }

    if (startLine === -1) {
      return null;
    }

    // Determine symbol end line based on indentation
    let endLine = startLine;
    for (let i = startLine + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') continue; // Skip blank lines inside body

      const currentIndent = line.search(/\S/);
      if (currentIndent !== -1 && currentIndent <= baseIndent) {
        // Indentation returned to base level or lower -> end of symbol
        break;
      }
      endLine = i;
    }

    const extractedCode = lines.slice(startLine, endLine + 1).join('\n');
    const digest = createHash('sha256').update(extractedCode, 'utf8').digest('hex');

    return {
      symbol: symbolName,
      filePath,
      startLine: startLine + 1,
      endLine: endLine + 1,
      totalLines: endLine - startLine + 1,
      code: extractedCode,
      sha256: digest
    };
  }

  /**
   * Surgical JS/TS symbol extraction using brace-depth parsing.
   */
  #extractJsSymbol(content, symbolName, filePath) {
    const lines = content.split('\n');
    let startLine = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (new RegExp(`(?:function|class|const|let|var|export)\\s+${symbolName}\\b`).test(line) ||
          new RegExp(`^\\s*${symbolName}\\s*\\([^)]*\\)\\s*\\{`).test(line)) {
        startLine = i;
        break;
      }
    }

    if (startLine === -1) return null;

    let endLine = startLine;
    let openBraces = 0;
    let foundFirstBrace = false;

    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i];
      for (const char of line) {
        if (char === '{') {
          openBraces++;
          foundFirstBrace = true;
        } else if (char === '}') {
          openBraces--;
        }
      }

      endLine = i;
      if (foundFirstBrace && openBraces <= 0) {
        break;
      }
    }

    const extractedCode = lines.slice(startLine, endLine + 1).join('\n');
    const digest = createHash('sha256').update(extractedCode, 'utf8').digest('hex');

    return {
      symbol: symbolName,
      filePath,
      startLine: startLine + 1,
      endLine: endLine + 1,
      totalLines: endLine - startLine + 1,
      code: extractedCode,
      sha256: digest
    };
  }

  #extractGenericSymbol(content, symbolName, filePath) {
    const lines = content.split('\n');
    const index = lines.findIndex(l => l.includes(symbolName));
    if (index === -1) return null;

    const start = Math.max(0, index - 2);
    const end = Math.min(lines.length - 1, index + 25);
    const slice = lines.slice(start, end + 1).join('\n');

    return {
      symbol: symbolName,
      filePath,
      startLine: start + 1,
      endLine: end + 1,
      totalLines: end - start + 1,
      code: slice,
      sha256: createHash('sha256').update(slice).digest('hex')
    };
  }
}
