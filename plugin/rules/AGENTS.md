# HELIX Execution Rules for Coding Agents

Antigravity operates under the HELIX (Hierarchical Evidence Loading and Intelligent eXecution) protocol for maximum token and context efficiency without quality loss.

## Core Operational Directives

### 1. Decisive Multi-File & Range Batching
- Inspect files in purposeful, complete spans (200–600 lines) or leverage `context` `batch_inspect` to read multiple files in a single turn.
- Strictly avoid fragmented micro-views (e.g., reading 30–50 lines across repeated turns).

### 2. Unified Command Execution & Single-Pass Verification
- Group related test files, diagnostics, and CLI commands into a unified invocation.
- Do not serialize commands across separate turns when they can be executed together or in parallel.
- Once a command output or receipt confirms execution exit codes, proceed without redundant reassurance re-runs.

### 3. Lean Switch Frontier Shaping
- For test executions and CLI commands with large or repetitive output, use Lean Switch compact status receipts (`[HELIX Lean Switch: run_command exit:0 raw:X bytes; Y passed in Zs; handle:...]`), preserving full error tracebacks on failure.
- Full uncompressed logs remain 100% recoverable on demand via `context raw { receipt: handle }`.

### 4. Chain-of-Draft Reasoning
- Keep thinking concise, telegraphic, and anchored purely on primary evidence and state transitions.
- Eliminate repetitive recitations of prior context or command outputs.

### 5. Continuous Context Control & Task Sealing
- When completing tasks in continuous multi-step sessions, seal completed task boundaries (`helix.handoff.v1`) using `context seal`.
- Past turns are archived into local encrypted stores, keeping prompt context lean ($O(N)$ instead of $O(N^2)$) while maintaining 100% lossless recovery.

### 6. Deterministic Memory
- Store key architectural decisions, settled facts, and rejected hypotheses in deterministic local SQLite memory (`memory put`).
- Query stored project facts deterministically (`memory search`) without requiring an LLM observer or repeating context.

### 7. AST Surgical Symbol Indexing (HELIX 2.0)
- Leverage `context` `ast_inspect` to extract targeted class, method, or function definitions (50–150 tokens) instead of reading entire files.

### 8. Speculative Execution Pipeline (HELIX 2.0)
- Group deterministic multi-step tool sequences (e.g. edit -> test -> diff) via `context` `pipeline` in a single model turn, halting at first failure boundary.

### 9. Elastic Diagnostic Escalation (HELIX 2.0)
- On repeat test failures, escalate to full stack frame locals and activate maximum reasoning effort to solve complex bugs without premature pruning.

### 10. Complete Visual Parity & Zero UI Artifacts (HELIX 2.0)
- The user interface and conversational prose must remain completely indistinguishable from vanilla execution.
- Never leak raw machine receipts, internal handles, micro-anchors, or storage hashes into user-facing chat responses.
- All compression, turn shaping, hash checks, and encryption remain strictly at the protocol, MCP, and tool layer. Answers must be natural, polished, and human-friendly.

### 11. Antigravity Native Sandboxing & Execution Isolation
- All shell and terminal command executions MUST be executed via Antigravity's native `run_command` tool to preserve the IDE's security sandbox (`BypassSandbox: false`) and user confirmation policies.
- Do not route unsandboxed host commands through MCP meta-tools; MCP tools are strictly reserved for static analysis (`ast_inspect`), deterministic memory (`memory`), evidence history recovery (`context raw`), and task sealing (`context seal`).

### 12. Strict One Flow Execution (Zero Serialized Exploratory Micro-Turns)
- Execute all inspection, mutations, verification, and git operations in a SINGLE COMPOUND FLOW per turn.
- Strictly eliminate serialized `thought -> tool -> thought -> tool` loops. Model must think ONCE, execute the compound batch or pipeline in ONE single compound tool invocation, and conclude directly.
- MAXIMUM 1 COMPOUND ACTION PER TURN: Never perform iterative, serialized micro-reads across turns (`thought -> read_file -> thought -> read_file`). If multiple files or checks are needed, compose them into a unified shell pipeline or 1-turn parallel batch, execute once, and deliver the user response immediately. Zero exploratory mid-turn pauses.

### 13. Pre-Resolved AST Locus & Turn-1 Immediacy Mandate
- When target symbol loci are pre-resolved in the ephemeral context (`[HELIX UNIVERSAL 100% AST TARGET]`), do NOT call `read_file` or `grep` to inspect them again.
- Formulate the minimal surgical edit and execute the mutation directly on Turn 1 via `edit_file` or a compound pipeline (`helix flow`).
- Stop at the lowest rung of the ladder: reuse existing patterns, shortest working diff, verify once, and conclude immediately. Eliminates redundant inspection turns entirely.
