# Module Audit: 1.0.1

This inventory covers the shipped runtime, its adapters and development-only benchmark support. Tests exercise observable contracts and negative controls. Passing checks are not proof of flawless software, universal quality parity or all-platform behavior. No paid model or SWE benchmark was launched for this audit.

## Runtime Coverage

Names below refer to files in `src/`; matching test names refer to `test/`.

| Modules | Verification Surface |
| --- | --- |
| `helix-goal-engine.mjs` | Ordered revisions, authorization, restart, cancellation, bound-input drift between checks; `helix-goal-engine.test.mjs` |
| `helix-tool-flow.mjs`, `helix-flow-admission.mjs` | Declared graphs, budgets, scope, guards, namespaces, stopping unknown/failed operations; matching test suites |
| `helix-evidence.mjs`, `helix-evidence-delta.mjs`, `helix-initial-observation.mjs` | Independently checked receipts, forged index rejection, exact cold retrieval, byte-bound edits, compatible test identities, diagnostic preservation; matching suites |
| `helix-operation-broker.mjs`, `helix-native-function-bridge.mjs` | Exact protocol roundtrip, output-type bindings, safe synchronous authorization, unique MCP selection, supervision and cancellation; matching suites and `native-supervision.test.mjs` |
| `helix-checkpoint-operation.mjs`, `verification.mjs`, `native-operation-rejection.mjs` | Current frontier, literal verification arguments, contradictory/empty/incomplete evidence, nonexecuting typed failures; checkpoint and verification suites |
| `helix-patch-evidence.mjs`, `helix-post-test-git.mjs` | Bounded selectors and exact recovery, pinned Git diffs, final HEAD drift, unknown/capped output; matching suites |
| `helix-scoped-operations.mjs`, `helix-lazy-tool-help.mjs` | Atomic retirement, passthrough on uncertainty, scope retirement, exact help recovery; `scoped-request-optimizer.test.mjs` and lazy-help suite |
| `tool-call-aging.mjs`, `tool-call-retention.mjs`, `cache-stable-aging.mjs` | Safe pair replacement, cache boundaries, opaque provider fields, exact originals after restart and tamper rejection; matching suites |
| `tool-result-aging.mjs`, `tool-result-store.mjs`, `tool-result-retention.mjs` | Result projections, encrypted exact recovery, caps, cold reads, explicit TTL/dry-run/purge, foreign-file preservation, symlink-root rejection; store, retention, cache and proxy suites |
| `context-archive.mjs`, `compaction-checkpoint.mjs` | Current-turn isolation, literal compressed recovery, Unicode offsets, credential withholding, redaction and invalid bindings; `compaction-checkpoint.test.mjs` and runtime MCP tests |
| `request-optimizer.mjs`, `openai-proxy.mjs` | Official-only explicit routes, no model fallback, unchanged effort/prose, exact recovery, usage accounting, controls and abort/backpressure; proxy, controls and scoped-optimizer suites |
| `memory.mjs`, `memory-compat.mjs`, `memory-inheritance.mjs` | Read-only baseline, writable overlay, table/typed-row inheritance, project aliases, new submodule callers, exact recovery and scope isolation; inheritance and release-module suites |
| `rtk-adapter.mjs`, `runtime-status.mjs` | Archived stdin only, no command replay, raw integrity, availability/telemetry boundaries and failure passthrough; release-module and runtime suites |
| `model-state.mjs`, `native-codex-activity.mjs`, `connection.mjs` | Metadata-only phases, typed framing/scope/revision continuity, resync/disconnect, push subscriptions and authentication; native-activity, model-feed and runtime suites |
| `service.mjs`, `core-client.mjs`, `local-state.mjs`, `paths.mjs` | Loopback capability, origin checks, private state, service ownership, MCP startup/restart and zero background model calls; release-runtime and release-module suites |
| `caller-auth.mjs`, `codex-patch-hook-endpoint.mjs` | Invalid expected secrets fail closed; exact route boundaries and capability redaction; caller-auth and platform-helper suites. These compatibility helpers do not authenticate the main HELIX service. |
| `process-identity.mjs`, `process-tree.mjs`, `windows-process-tree.ps1` | Synthetic identity probes, split UTF-8 capture, output caps, deadline/cancel, owned POSIX descendant cleanup, Windows invocation construction; platform-helper/process-tree tests and goal/launcher recovery tests. Native Windows execution remains unverified. |
| `helix-candidate-cost.mjs`, `benchmark-accounting.mjs`, `benchmark-observer.mjs`, `benchmark-view.mjs` | Failure/unknown-usage accounting, fixture extraction, ownership and bounded read-only viewing; candidate-cost, accounting, observer, public-benchmark and launcher suites. No new inference run. |

## Entrypoints And App

- `bin/helix.mjs`, `bin/helix-context-mcp.mjs`: isolated install/start/status/MCP/shutdown tests; deterministic memory compatibility and inherited reads. Installing MCP does not intercept all native model requests.
- `bin/helix-source-bundle.py`: source-bundle/privacy checks; local private state is excluded, not exported.
- `desktop/main.cjs`, `desktop/preload.cjs`: packaged Electron smoke checks, isolated renderer, narrow IPC, shared service capability and public synthetic fixture. The real native feed is verified separately without collecting conversation text.
- `ui/main.jsx`, `ui/ThemeControl.jsx`, `ui/playback.mjs`, `ui/styles.css`: Playwright desktop/mobile layouts, dark/light/system persistence, keyboard behavior, offline/error/loading states, evidence and memory views.
- `ui/BenchmarkMonitor.jsx`: development-only read-only fixture checks, nonoverlapping polling, pause/stale/recovery/stop-on-leave; excluded from release navigation and bundle.
- `scripts/`: syntax checks plus fixture-driven exporter/launcher tests. Paid probes and full benchmarks were not executed as a substitute for deterministic module tests.

## Known Limits

Native macOS testing does not establish Windows/Linux process containment or packaged behavior. Mock transport tests do not establish every upstream server response. The native desktop observer uses a version-checked local protocol and reports unknown when unsupported. Retention expiry/purge is explicitly destructive and cannot promise indefinite recovery; recovery-dependent writers disable TTL. Full adversarial filesystem races by another process running as the same user are not certified away. Mechanical receipt verification is never semantic task acceptance. The existing V3 quality and finalization limitations remain disclosed.
