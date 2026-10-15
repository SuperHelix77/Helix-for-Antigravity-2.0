# HELIX 1.0

<img src="docs/assets/helix-mark.svg" width="48" height="48" alt="HELIX double-strand logo">

[Buy me a coffee](https://buymeacoffee.com/superhelix7)

![HELIX: plans, compact receipts, recoverable originals and memory](docs/assets/release-illustration.png)

It took a year of experiments to get here. HELIX started with a simple frustration: an agent should not have to read the same log, rediscover the same decision, or ask a model to wait for a process again and again. This is the first public engine release, built around that problem. It is useful, unfinished, and open about both.

A local evidence, memory and deterministic Tool Flow engine for coding agents, with an Electron monitor.

HELIX keeps exact originals outside repeated context, returns compact evidence where appropriate, and executes already-authorized mechanical steps without asking a model to decide them again. It does not lower reasoning effort, force terse thinking, or promise unchanged task quality.

![HELIX release interface in dark mode](docs/assets/release-dark-desktop.png)

The screenshot uses explicitly labelled public synthetic data, not a live benchmark or savings result. The release app has Overview, Flow, Evidence, Memory and Troubleshooting. Benchmark monitoring is a separate development build. The double-strand mark comes home from [Helix-Harness](https://github.com/SuperHelix77/Helix-Harness); see [visual credits](docs/ASSETS.md).

## Current Evidence

The V3 NEW50 comparison did **not** achieve output reduction or solve parity. It did substantially reduce known input-token replay:

| Measure | Vanilla | HELIX V3 |
| --- | ---: | ---: |
| Officially solved | 38 / 50 | 34 / 50 |
| Primary model requests | 341 | 420 |
| All attempts, including overloads | 346 | 423 |
| Known input tokens | 50,630,785 | 11,212,326 |
| Known output tokens, including reasoning | 55,283 | 75,814 |
| Known total tokens | 50,686,068 | 11,288,140 |
| Primary requests with unknown usage | 0 | 1 |

Known total tokens fell **77.73%**; output rose **37.14%**, with four fewer verified solves. Only confirmed provider-overload errors are excluded from primary accounting in both lanes (vanilla 5, V3 3); they remain in the all-attempt ledger. Failed-task effort, successful retries, ordinary unknown usage and two rejected post-completion operations are included. These are known provider subtotals, not complete billed cost or subscription savings. Parent, consultation and recovery overhead was not metered.

V3 reused the **same known 50 issues** and historical vanilla baseline, not a fresh holdout or simultaneous A/B trial. Both lanes kept one native conversation across issues, with infrastructure resumes. All 100 official grades and 50 gold controls were audited. Exact cold recovery verified 261 result-store originals, 758 program-store originals, 417 archived pairs and 92 advertised handles. No real compaction occurred. The final solver was stopped after grading because its completion broker rejected further operations; a clean native exit is not claimed.

See [V3 aggregate data and failed-task effort](benchmarks/new50-v3/results.json), [cumulative per-issue savings](benchmarks/new50-v3/cumulative.csv), [earlier v1 results](benchmarks/new50-v1/results.json), and [methodology](docs/BENCHMARKS.md). New release memory/RTK/UI integrations have local tests; they have not been credited with a fresh provider benchmark.

## Run Locally

Source installation requires Node.js 22.19 or newer, npm, and Git. Python 3 is optional for AST-aware Python source indexing. No API key is required for local memory, evidence or the monitor.

```sh
git clone https://github.com/SuperHelix77/HELIX-1.0.git
cd HELIX-1.0
npm ci
npm run build
node bin/helix.mjs start
npm run desktop
```

The desktop connects to one owner-private loopback service. Closing the window leaves that service available to MCP clients. To stop it:

```sh
node bin/helix.mjs stop
```

The Electron distribution is downloaded by npm's normal installation script. Installing dependencies, building and packaging require network access to their registries. Fonts and icons are bundled; the renderer makes no external requests.

## Connect An Agent

First generate and inspect the local MCP registration:

```sh
node bin/helix.mjs install
```

This writes `~/.helix/codex-mcp.toml`; it does **not** edit Codex settings or authentication. After reviewing it, register the adapter with a compatible Codex CLI:

```sh
codex mcp add helix -- node "$PWD/bin/helix.mjs" mcp
codex mcp list
```

Reload the client's MCP tools. The adapter exposes `goal`, `context` and `memory`, sharing the same service and stores. Use only the current authorized task; memory and stored goals are historical evidence, not instructions to resume old work. The [bundled policy](skills/helixcontext/SKILL.md) is available on demand through `context policy`; it is not automatically installed into another client's skill directory.

Other MCP-capable clients can run the same stdio command. A stock ChatGPT conversation without an explicitly supported local connector is not automatically intercepted. This installation does not patch the ChatGPT or Codex desktop applications.

See [installation and recovery](docs/INSTALL.md) for configuration, optional Claude-Mem lookup, RTK, uninstall and an opt-in OpenAI proxy.

## What Is Included

- Ordered goals with revision, scope, explicit acceptance review and cancellation checks.
- Compact command receipts, evidence deltas, exact edits, indexed ranges and immutable reusable workflows.
- Bounded Tool Flow with declared commands and typed transitions. Unknown states return to model judgment.
- Recoverable original tool results and programs. Retention/retrieval checks are not semantic correctness guarantees.
- Deterministic SQLite memory with explicit project/task notes and bounded search. No LLM extraction, Ollama, embedding daemon or background model worker.
- An integrated memory browser and read-only Claude-Mem bridge, connected through an explicit local database picker or service environment setting. No automatic personal-memory discovery or copying.
- RTK stdin filtering of already archived logs through `context rtk`. Original commands are never rerun; exact source handles remain available. Missing RTK, unverified telemetry-off state or unusable output falls back to retained native evidence.
- An opt-in official-OpenAI Responses HTTP proxy with exact result retention. It does not replace a client's native WebSocket implementation or install itself as a global router.
- A local Electron app with light, dark and system themes, memory browsing, exact note inspection and troubleshooting. Its reasoning indicator lights only on observed provider reasoning events; MCP-only clients correctly show reasoning as unobservable.

Some primitives are available through MCP but are not enabled on every request automatically. In particular, the standalone proxy does not install the benchmark's full native operation broker. The benchmark's combined treatment is not evidence that each component independently saves tokens.

## Development

```sh
npm test
npm run check
npm run build
npm run test:ui
npm run test:electron
npm run privacy
```

The separate benchmark monitor is intentionally not the release application:

```sh
npm run build:monitor
node bin/helix.mjs watch /path/to/a/reviewed/new50-run
npm run desktop:monitor
```

Monitoring never starts a run. It shows known usage, failed attempts, unknown counts and cumulative savings only for officially graded matched pairs. The default release build excludes the benchmark component, navigation and direct hash route. The source repository retains sanitized benchmark evidence for scrutiny.

`npm run package` builds an unpacked application for the current platform. Native platform packaging must be verified on that platform; source tests do not establish Windows/Linux binary support. This repository does not distribute signing credentials.

## Architecture And Safety

See [architecture](docs/ARCHITECTURE.md), [security and privacy](SECURITY.md), and [benchmark methodology](docs/BENCHMARKS.md). Model calls occur only through an explicitly configured proxy or an independently launched benchmark; local memory and the goal engine issue none. A single user turn can still contain many provider requests.

The [module guide](docs/MODULES.md) explains each subsystem, where it runs, and what is automatic versus opt-in. This release does not make arbitrary ChatGPT conversations run through HELIX or expose private chain-of-thought.

The engine's command execution has the host account's permissions. Declaring a command is consequential authorization, not a sandbox. Do not expose its local capability token, mount private credentials into agents, or register commands outside a task's permitted scope.

## License And Attribution

Engine code is MIT; see [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md). The separately licensed harness SVG mark retains AGPL-3.0; its source and license are included. See [visual credits](docs/ASSETS.md). The engine core is adapted from the MIT-licensed codex-router working tree, with imported source hashes in [provenance](docs/upstream-provenance.json). Upstream attribution does not imply that its unrelated workspace changes were audited.

The supplied interface reference informed neutral surfaces, sidebar proportions and restrained controls. HELIX does not copy that application's branding or chat functionality and is not affiliated with OpenAI, Anthropic, RTK or Argon Bridge.
