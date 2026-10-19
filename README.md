<p align="center">
  <img src="docs/assets/helix-engine-banner.svg" alt="HELIX Engine — less replay, exact evidence, more useful work" width="100%">
</p>

# HELIX Engine

**Make the model think about the problem. Not the same tool output for the twentieth time.**

<p align="center">
  <a href="https://buymeacoffee.com/superhelix7">
    <img src="https://img.shields.io/badge/BUY%20ME%20A%20COFFEE-SUPPORT%20HELIX-F5C542?style=for-the-badge&logo=buymeacoffee&logoColor=172027&labelColor=172027" alt="Buy me a coffee — support HELIX">
  </a>
</p>

[Latest release](https://github.com/SuperHelix77/HELIX-1.0/releases/latest) · [Install](docs/INSTALL.md) · [Architecture](docs/ARCHITECTURE.md) · [Benchmarks](docs/BENCHMARKS.md) · [Modules](docs/MODULES.md)

I spent a year getting here. It started with small token-saving tricks: tighter prompts, tool-output filtering, RTK. Those helped, but they didn't solve the underlying problem. Coding agents kept rereading old evidence, reconstructing decisions they had already made, and asking expensive models to coordinate work a deterministic program could do.

So I kept building. And failing. And measuring. HELIX is the result.

HELIX is a **local evidence, memory and deterministic execution layer for coding agents**, with an Electron monitor. It keeps original tool results recoverable, gives the model compact evidence when that is sufficient, and moves explicitly authorized mechanical operations out of the reasoning loop.

It is not a new model. It does not lower the configured reasoning effort. It is not a promise that compression preserves intelligence. The benchmark below includes failures, and I intend to keep them visible.

![HELIX desktop interface — public synthetic demonstration data](docs/assets/release-dark-desktop.png)

*The desktop image uses synthetic data. It is not a screenshot of the measured benchmark.*

## The result — and the cost

The completed V3 NEW50 experiment used the same 50 SWE issues and historical vanilla baseline. Both lanes retained a single native conversation across tasks, including infrastructure resumes.

| Measure | Vanilla | HELIX V3 |
| --- | ---: | ---: |
| Official solves | **38 / 50** | **34 / 50** |
| Primary model requests | 341 | 420 |
| All attempts, including overloads | 346 | 423 |
| Known input tokens | 50,630,785 | 11,212,326 |
| Known output tokens, including reasoning | 55,283 | 75,814 |
| Known total tokens | 50,686,068 | 11,288,140 |
| Primary requests with unknown usage | 0 | 1 |

**77.73% fewer known provider tokens. Four fewer verified solves. 37.14% more output tokens.**

That is the actual trade-off. HELIX demonstrated major input-efficiency gains; it **did not** demonstrate quality parity or output savings. Do not quote the token reduction as a subscription-quota multiplier, a complete billing estimate, or proof that the model became smarter.

The experiment is not a clean held-out randomized trial: V3 reused the known issue cohort and historical vanilla baseline. Confirmed overloads are excluded symmetrically from primary accounting but retained in the all-attempt ledger. Failed work, retries and two rejected post-completion operations remain counted. One request has unknown usage. Parent coordination, consultation and some recovery overhead were not metered.

All 100 official grades and 50 gold controls were audited. Cold recovery checked 261 result-store originals, 758 program-store originals, 417 archived pairs and 92 advertised handles. No native compaction occurred in the run. The solver was stopped after grading because the completion broker rejected further operations; I do not claim a clean native shutdown.

**Read the evidence, not just the percentage:** [V3 results](benchmarks/new50-v3/results.json) · [Per-issue trajectory](benchmarks/new50-v3/cumulative.csv) · [V1 comparison](benchmarks/new50-v1/results.json) · [Methodology and limitations](docs/BENCHMARKS.md).

The newer memory, RTK and desktop integrations have local tests; they are **not** credited with a fresh equivalent provider benchmark.

## What HELIX actually does

| Module | Job |
| --- | --- |
| **Goal engine** | Tracks the current task, ordered steps, scope, revision, acceptance and cancellation. Old goals never silently become new instructions. |
| **Tool Flow** | Executes bounded, already-authorized mechanical sequences. Ambiguity returns to model judgment instead of being guessed away. |
| **Lean Switch** | Condenses massive command and test outputs into verified compact status receipts while archiving 100% of exact originals for on-demand recovery. |
| **Continuous Context Control** | Encrypts and seals past task scopes upon completion (`helix.handoff.v1`), eliminating context cache bloat across multi-task sessions. |
| **Evidence archive** | Keeps exact tool outputs and generated programs recoverable while returning compact, typed receipts when appropriate. |
| **Context & Two-Tier Aging** | Combines scoped retirement with intra-task aging, index references, and retrieves originals on demand without loss of intelligence. |
| **Memory** | Stores explicit project/task notes in deterministic local SQLite. Search and note round trips do not require an LLM observer. |
| **Claude-Mem bridge** | Optional read-only lookup of an explicitly selected legacy store. It does not silently import private memories or start a background model. |
| **RTK integration** | Filters archived output through RTK where configured, without rerunning original commands. Unavailable or unsafe paths fall back to retained evidence. |
| **Electron monitor** | Shows observed runtime state, flow, evidence, memory and troubleshooting. Reasoning status is shown only when the provider actually exposes that state. |

These components are not all automatically active on every client request. The MCP interface and the opt-in HTTP proxy have different integration boundaries. HELIX does **not** silently patch ChatGPT or Codex, intercept every conversation, or expose private chain-of-thought.

See the [module-by-module guide](docs/MODULES.md) for implementation paths, automatic versus opt-in behavior, and limitations.

## Install and run

Requires **Node.js 22.19+**, npm and Git. Python 3 is optional for AST-aware Python indexing. Local memory, evidence and monitoring do not require an API key.

```sh
git clone https://github.com/SuperHelix77/HELIX-1.0.git
cd HELIX-1.0
npm ci
npm run build
node bin/helix.mjs start
npm run desktop
```

The desktop connects to an owner-private loopback service. Closing the window does not stop the service. Stop it explicitly with:

```sh
node bin/helix.mjs stop
```

The dependency install may download Electron. Platform-native packaging must be tested on its target OS; a source build is not evidence of a signed or notarized distribution. Full instructions: [INSTALL.md](docs/INSTALL.md).

### Connect Codex or another MCP client

```sh
node bin/helix.mjs install
```

This generates `~/.helix/codex-mcp.toml` for review; it does **not** change Codex authentication or settings. After inspection, register the adapter in a compatible Codex CLI:

```sh
codex mcp add helix -- node "$PWD/bin/helix.mjs" mcp
codex mcp list
```

Reload the client's tools. The adapter exposes `goal`, `context` and `memory` over the same local service. Other compatible clients can use the same stdio entrypoint. The optional Responses proxy is documented in [INSTALL.md](docs/INSTALL.md); it is not a global router and does not replace a client's native WebSocket stack.

### Connect Google Antigravity

HELIX integrates natively into Google Antigravity as both a plugin and an MCP server:

```sh
# 1. Symlink CLI to Antigravity binary directory
ln -sf "$PWD/bin/helix.mjs" ~/.gemini/antigravity/bin/helix

# 2. Check engine daemon status
helix status

# 3. Start background engine daemon if stopped
helix start
```

Antigravity automatically discovers HELIX tools (`goal`, `context`, `memory`) via `~/.gemini/antigravity/mcp/helix/` and activates the `/helixcontext` skill from `~/.gemini/config/plugins/helix/`.

## See what the engine is doing

The Electron application is an inspection and troubleshooting surface, not a second autonomous agent. It exposes retained operations, evidence references, explicit memories and observable request states. A reasoning indicator is **not** a window into hidden thoughts. If the native event feed is unavailable, the monitor cannot infer those states.

The default release app deliberately excludes the development benchmark monitor. To inspect a reviewed benchmark run:

```sh
npm run build:monitor
node bin/helix.mjs watch /path/to/a/reviewed/new50-run
npm run desktop:monitor
```

Monitoring never launches a benchmark. It displays known usage and official matched grades without silently treating unknown usage as zero.

## Build, test, inspect

```sh
npm test
npm run check
npm run build
npm run test:ui
npm run test:electron
npm run privacy
```

`npm run package` creates an unpacked app for the current platform. See [security and privacy](SECURITY.md), [architecture](docs/ARCHITECTURE.md), and [installation/recovery](docs/INSTALL.md).

HELIX executes authorized commands with the host account's permissions. **It is not a sandbox.** A declared tool operation is consequential authorization. Keep capability tokens private, review task scopes and do not expose local execution endpoints.

## What comes next

The first release is a foundation, not the end of the research. The immediate problem is clear: recover the four lost solves and investigate why HELIX generated 79 additional primary model requests and more reasoning/output. Context retirement is useful; it is not enough on its own.

Longer-term work on memory, continuous context control, model-independent handoffs and Lean Switch remains research. **95% savings is a target, not a result.** I will not label it achieved until the measurements justify it.

## Acknowledgments, licensing and support

The HELIX double-strand identity comes from [Helix Harness](https://github.com/SuperHelix77/Helix-Harness). This banner adapts that project's header rather than inventing a different brand. The mark retains its separate AGPL-3.0 attribution; see [visual credits](docs/ASSETS.md).

The engine code is MIT-licensed ([LICENSE](LICENSE)); third-party code and artwork retain their applicable licenses ([notices](THIRD_PARTY_NOTICES.md)). The engine core is adapted from the MIT-licensed codex-router working tree, with source hashes in [upstream provenance](docs/upstream-provenance.json). No affiliation or endorsement by OpenAI, Anthropic, RTK, Unsloth or Argon Bridge is implied.

I build HELIX because I want capable models to spend more of their time solving problems and less of it rediscovering their own work. A year of experiments went into this release. Some worked. Many didn't. The failures stay in the record.

If the project is useful, [buy me a coffee](https://buymeacoffee.com/superhelix7). It helps sustain the work.
