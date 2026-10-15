# Installation And Recovery

For worker-independent inheritance of an existing local Claude-Mem store, see
[Memory Inheritance](MEMORY-INHERITANCE.md). Preserve the original until import
verification and client reconnection both succeed.

## One Service

Run commands from the repository root. The source CLI requires Node.js 22.19 or newer. Electron embeds its own runtime. The supported source commands are:

```sh
node bin/helix.mjs install
node bin/helix.mjs start
node bin/helix.mjs status
node bin/helix.mjs mcp
node bin/helix.mjs stop
node bin/helix.mjs uninstall
```

`mcp` is a stdio adapter, not a second engine. Multiple adapters and the desktop attach to the same service. `start` and an MCP connection can start the service when absent. There is no automatic background LLM, extraction worker or local model server.

The default state directory is `~/.helix`. Set `HELIX_HOME` to an absolute, owner-private directory to isolate an installation. Give the desktop and all adapters the same value. Do not share the directory between accounts, publish it, or place it in a cloud-synced public folder.

The service binds to an ephemeral `127.0.0.1` port. Its bearer capability is stored in `HELIX_HOME/endpoint.json`, mode 0600 on POSIX. Its singleton directory is `service.lock`. Memory, goals, encrypted retention and raw evidence persist independently of the desktop window.

## Codex Registration

`install` generates `HELIX_HOME/codex-mcp.toml`, refusing to overwrite a differing registration. It does not modify the client. Review the entry and explicitly register:

```sh
codex mcp add helix -- node "$PWD/bin/helix.mjs" mcp
codex mcp list
```

If using an isolated state directory, supply the same `HELIX_HOME` through the client's MCP environment configuration. Review startup and tool timeouts from the generated TOML. No `max_tool_calls` parameter is added. Reasoning effort, visible verbosity and native compaction thresholds stay under the client's control.

After an MCP reload, start with `context` and `{ "action": "doctor" }`. A useful doctor result verifies local availability, not that a model will choose the tools correctly. Inspect the [policy](../skills/helixcontext/SKILL.md) before declaring executable steps.

## Deterministic Memory

The `memory` tool supports:

- `put`: explicit `project`, `task`, `title`, literal `body`, and optional `kind`.
- `search`: explicit `project`, literal `query`, optional `task`, `limit` (1-20), and `expand`.
- `read`: exact note `id`.
- `projects`: locally stored project names and counts, without note bodies.
- `browse`: explicit `project`, optional `task`, bounded `limit` and `cursor`.
- `claude_lookup`: explicit `project`, literal `query` and bounded `limit`, only when configured.

Kinds are `fact`, `decision`, `rejected`, `settled` and `constraint`. Search defaults to a bounded preview; `read` recovers the stored note exactly. Notes are durable but never automatically authorize execution or an old task's continuation.

Connect an existing Claude-Mem database through Memory's explicit native picker, or set `HELIX_CLAUDE_MEM_DB` for the service. A deliberate picker selection takes precedence over the startup default. Select `source: "claude-mem"` for read, browse or search. HELIX validates the observation schema, opens it read-only and never starts an observer, Ollama or extraction model. Writes to that source are rejected. Private memory is never copied into the release repository. The native HELIX store remains writable through explicit literal notes.

## RTK

RTK is an optional external executable, not a bundled background daemon. Put an operator-reviewed `rtk` binary on `PATH`, or set `HELIX_RTK_PATH`. The service checks its version and requires its telemetry status to be confirmed off before filtering private logs. Set `HELIX_RTK_ENABLED=0` to disable the adapter.

Use `context` with `{ "action": "rtk", "source": "64-hex-raw-log-hash", "filter": "pytest" }`, or `helix rtk HASH pytest`. Supported stdin filters are `pytest`, `cargo-test`, `git-log`, `grep` and `find`. Only already archived, hash-verified UTF-8 logs up to 1 MiB are filtered; the returned partial preview is bounded. The original command never runs again. Exact originals remain accessible through `context raw`. Missing binaries, unsupported/oversized input or unusable filtering return a native boundary, not a retry of the underlying operation. This is not a global shell rewrite hook.

Run unsupported commands natively. A filtered read is a projection, not a substitute for missing evidence. Retry unusable read-only output once natively; never blindly replay a mutation. HELIX's exact recovery archives apply to observations it actually retains, not to arbitrary third-party terminal output.

Neither the v1 nor V3 solver benchmark ran an RTK executable. Do not attribute their measured savings to this new release adapter.

## Live App And Troubleshooting

Overview can observe a selected local Codex chat without changing provider routing:

```sh
node bin/helix.mjs observe-codex ACTUAL_THREAD_ID
```

Inside a Codex runtime, omit the argument to use its `CODEX_THREAD_ID`. No thread is guessed. This selection persists locally; select a different chat explicitly when needed. The observer subscribes to the desktop's owner-private Unix socket, retains only phase metadata, and pushes changes to Electron. Reasoning, generation, tool work, compaction and idle are distinct. It neither starts a model request nor reads authentication. Native snapshots contain conversation data in transit; text is discarded during projection, never logged, archived or sent to the renderer. The internal desktop protocol is version-checked and bounded; disconnects or incompatible state show unknown. This local desktop integration is not a guarantee for every Codex version or operating system.

The optional HTTP proxy can separately observe the stream it actually carries. The reasoning panel never lights for mere waiting, tool activity, a completed reasoning item, or an MCP-only connection. Memory supports source/project selection, bounded search, pagination and exact note inspection.

Troubleshooting runs local, no-model diagnostics. Core restart requires explicit confirmation and is rejected while operations are active. It never starts a local model or edits authentication. The app's light/dark/system setting persists locally. The production build omits the benchmark screen.

## Optional OpenAI HTTP Proxy

This is explicit opt-in, not a global application patch. Start the service with `HELIX_OPENAI_BASE=https://api.openai.com/v1` (or the official Codex HTTPS base for an independently supported native client). Existing services must be stopped before a changed startup configuration takes effect.

A compatible caller sends Responses HTTP requests to the service's local `/v1/responses` or `/v1/responses/compact`, with its own OpenAI `Authorization` header and the local capability in `x-helix-key`. A stable `session_id` or `conversation_id` is needed for request aging. Never print or publish those headers. HELIX does not discover client authentication or select a fallback model. Only explicitly selected `gpt-*` model identifiers and the two official HTTPS upstream bases are accepted; redirects are refused.

The proxy preserves reasoning effort and output verbosity. It removes unsupported `max_tool_calls` only on the native Codex or Lite route, and sets `parallel_tool_calls=false` when the Lite header requires it. The ordinary official API route preserves the caller's built-in-tool budget, as specified in the [Responses reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create). It does not provide a Responses WebSocket server. Native no-tools compaction behavior must remain with the client's supported transport; the offline benchmark probe is not a universal client compatibility claim.

Without this opt-in, MCP remains useful but ordinary model traffic is unchanged. Merely opening the monitor does not route a client's model requests through HELIX.

## Recovery And Removal

`status` is a local snapshot; stored goal status is not process liveness or permission to continue it. A lock with an unreachable service is not automatically deleted, and an unknown PID is never killed. Inspect the owned process and endpoint before any manual recovery. Preserve the directory for diagnosis rather than repeatedly starting services.

`stop` shuts down the HELIX service and owned shared MCP core. Closing Electron alone does not. `uninstall` stops it and removes only the generated HELIX registration, preserving memory and original evidence. It does not remove a registration previously added through a client's own CLI. Remove that separately through the same client after checking the exact name.

Do not delete the state directory to resolve a display problem: it contains the exact recovery originals and their keys. Back up the whole owner-private directory before an intentional migration. Archive recovery establishes historical bytes, not the current truth of a claim.
