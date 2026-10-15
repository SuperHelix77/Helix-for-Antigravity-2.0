# Worker-Independent Memory

HELIX can inherit a local Claude-Mem store without running its observer,
embedding service, Ollama, or another model. Historical memory is evidence,
not permission to resume old work.

```sh
node bin/helix.mjs inherit-memory /absolute/path/claude-mem.db \
  /absolute/path/chroma /absolute/path/corpora /absolute/path/state
```

Paths are explicit. SQLite's online backup includes committed WAL data and the
entire database: observations, facts, summaries, prompts, sessions, tool history,
append-only work state, indexes, and other tables. Every table's schema and typed
row digest are compared with the same source read transaction; the copy must pass
`quick_check`. Raw text bytes, BLOBs, and 64-bit integers are covered. Auxiliary
files are archived and hashed. Links and files that change during copying fail.
Raw SQLite sidecars are isolated from independently verified database snapshots.

The private versioned archive lives under `HELIX_HOME/inherited/`. Originals are
not deleted or modified. Only a verified import becomes the read source. Failed
partial imports stay private and inactive. Pending jobs, hook spools, and
embeddings are historical data, never executed. This is a point-in-time import,
not ongoing synchronization with Claude.

## Compatibility

`node bin/helix.mjs memory-mcp` exposes `work_state_read`, `work_state_write`,
`search`, `get_observations`, and `memory_record`. `memory-write-mcp` exposes only
`save_memory`. Both attach to the same HELIX service and pass their actual caller
working directory; the service's startup directory is not the memory scope.

Inherited work state folds in original ID order. New explicit updates live in
HELIX SQLite; the baseline stays read-only. Null clearing, closed-item filtering,
project scopes, and recorded checkout names are retained. No old to-do list is
injected automatically. `memory_record` recovers complete inherited records or
new HELIX notes in bounded JSON ranges.

Search uses deterministic literal matching, not the old semantic/embedding
ranking. Unsupported filters fail rather than silently broadening retrieval.
The embedding archive remains available for a separately authorized adapter.

## Cutover

Back up client registration and hooks first. Replace only that client's legacy
memory startup/capture hooks. `memory-hook` starts/checks HELIX, never an observer.
Reload the client to reconnect existing MCP sessions; editing registration does
not hot-swap an already connected process.

A shared worker may still serve Claude. Do not stop it, disable its LaunchAgent,
or modify the separate Claude engine just to decouple Codex. Personal archives
must never enter a source release or Git commit.
