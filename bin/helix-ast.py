#!/usr/bin/env python3
"""
Genuine AST Symbol Resolver using Python's native `ast` module.
Replaces regex heuristics with abstract syntax tree parsing.
"""
import ast
import json
import os
import sys

def find_python_files(root_dir):
    py_files = []
    ignores = {'.git', 'node_modules', '__pycache__', '.venv', '.venv311', 'build', 'dist', '.tox'}
    for root, dirs, files in os.walk(root_dir):
        dirs[:] = [d for d in dirs if d not in ignores]
        for f in files:
            if f.endswith('.py'):
                py_files.append(os.path.join(root, f))
    return py_files

class SymbolVisitor(ast.NodeVisitor):
    def __init__(self, target_symbol, target_class=None):
        self.target_symbol = target_symbol
        self.target_class = target_class
        self.current_class = None
        self.matches = []

    def visit_ClassDef(self, node):
        prev = self.current_class
        self.current_class = node.name
        if self.target_class is None and node.name == self.target_symbol:
            self.matches.append({
                "symbol": node.name,
                "kind": "class",
                "parentClass": None,
                "startLine": node.lineno,
                "endLine": getattr(node, "end_lineno", node.lineno + 10),
                "decorators": [ast.unparse(d) for d in node.decorator_list] if hasattr(ast, "unparse") else []
            })
        self.generic_visit(node)
        self.current_class = prev

    def visit_FunctionDef(self, node):
        self._record_func(node)
        self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node):
        self._record_func(node)
        self.generic_visit(node)

    def _record_func(self, node):
        if node.name == self.target_symbol:
            if self.target_class is None or self.current_class == self.target_class:
                self.matches.append({
                    "symbol": node.name,
                    "kind": "method" if self.current_class else "function",
                    "parentClass": self.current_class,
                    "startLine": node.lineno,
                    "endLine": getattr(node, "end_lineno", node.lineno + 5),
                    "decorators": [ast.unparse(d) for d in node.decorator_list] if hasattr(ast, "unparse") else []
                })

def resolve_symbol(query, root_dir="."):
    parts = query.split(".")
    target_symbol = parts[-1]
    target_class = parts[0] if len(parts) > 1 else None

    py_files = find_python_files(root_dir)
    all_candidates = []

    for f_path in py_files:
        try:
            with open(f_path, "r", encoding="utf-8") as f:
                content = f.read()
            if target_symbol not in content:
                continue
            tree = ast.parse(content, filename=f_path)
            visitor = SymbolVisitor(target_symbol, target_class)
            visitor.visit(tree)
            
            rel_file = os.path.relpath(f_path, root_dir)
            lines = content.splitlines()
            for m in visitor.matches:
                start = max(0, m["startLine"] - 1)
                end = min(len(lines), m["endLine"])
                m["file"] = rel_file
                m["preview"] = "\n".join(lines[start:end])
                all_candidates.append(m)
        except Exception:
            continue

    return {
        "status": "RESOLVED" if all_candidates else "NOT_FOUND",
        "query": query,
        "parser": "python_ast",
        "totalMatches": len(all_candidates),
        "displayedMatches": min(len(all_candidates), 8),
        "ambiguous": len(all_candidates) > 1,
        "candidates": all_candidates[:8]
    }

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"status": "ERROR", "message": "Usage: helix-ast.py <query> [rootDir]"}))
        sys.exit(1)
    q = sys.argv[1]
    r = sys.argv[2] if len(sys.argv) > 2 else "."
    print(json.dumps(resolve_symbol(q, r), indent=2))
