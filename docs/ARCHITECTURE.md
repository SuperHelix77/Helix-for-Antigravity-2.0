# Architecture

```text
Agent MCP adapter ----> local authenticated service <---- Electron preload
                              |
                    shared deterministic core
                       /       |         \
                 ordered    evidence    literal
                  goals    and Tool Flow memory
                              |
                     exact local originals

Optional compatible HTTP client --> explicit OpenAI proxy --> official API
Development monitor -------------> bounded local benchmark observer
```

The service owns one SQLite memory store and lazily starts one shared stdio goal/evidence core. MCP adapters are clients, not independent workers. Electron's sandboxed renderer has no Node API or direct network capability; its preload exposes bounded, allowlisted local operations. Benchmark IPC and its view are enabled only by the separate monitor mode.

## Information Boundaries

Compact receipts are typed projections of archived command output. They carry mechanical results and exact recovery handles, not semantic approval. Failed or unfamiliar output must remain available for judgment. Indexed ranges recover literal selected text. Exact edits bind before/after bytes to the expected original; reusable workflows bind declared commands and inputs rather than guessed intent.

Historical tool-result aging and tool-program retention address repeated replay, not a model's intrinsic tokenizer. Originals must survive restart and be exactly retrievable before a replacement can be considered evidence-preserving. The optional request optimizer fails conservatively when retention cannot be established. It does not rewrite opaque reasoning or arbitrary current programs.

Cache stability matters: a smaller request may reuse less cached input. The measurements therefore separate input, cached input, output, requests and unknown usage. Bytes removed are not actual provider-token savings or cost savings.

## Decisions And Execution

The model establishes the currently authorized goal, permitted commands, dependencies and acceptance criteria. The deterministic engine executes already-declared operations with bounded time and operation counts. Exit-code branches can continue only within that declaration. Unknown states, unfamiliar failures and new semantic decisions return to the model.

Checkpoint acceptance needs current scope, revision and step plus explicit semantic review. Mechanical checks do not decide whether the patch actually solves the problem. Repeat requests use idempotency guards; failures are not permission to blindly retry a mutation. Cancellation propagates to owned execution. Execution permissions are those of the host service, not a replacement sandbox.

One uninterrupted user task can contain many model requests. Tool Flow can avoid requests for already-decided mechanical work, but cannot make every task one provider request or guarantee an infinite context.

## Memory And Context

Memory writes are literal model/operator notes with explicit project and task scope. FTS5 retrieval is deterministic and bounded; no model summarizes or embeds notes in the background. The optional Claude-Mem connection is read-only and explicit.

Stored goals, notes and old handoffs are retrieval evidence, never an automatic task queue. After compaction, recover the current constraints and relevant originals, verify freshness, and follow the newest request. Do not revive settled or unrelated work simply because it exists in memory.

Native model context defaults remain unchanged. The benchmark SDK probe observed ordinary no-tools Responses for native compaction at synthetic 460k input, but not at 440k. It did not establish a universal exact threshold or task-quality parity. The v2 native adapter passes that no-tools path through without tool-only transformations; string matching is telemetry, not execution authorization.

## Runtime And Benchmark Separation

The released service is a portable extraction; the private benchmark uses a frozen native adapter, containers, official harness and controlled public task workspaces. The development observer reads bounded projections of that controller's artifacts. It never starts the benchmark or sends an inference request.

Observed runtime counters refer to the service that produced them. Historical vanilla totals and current modified totals are labelled separately; cumulative savings use only a contiguous officially graded matched prefix. A PID must match its kernel start identity before the observer calls a controller running. A timestamp alone establishes no liveness.

The benchmark's combined treatment includes native program aging and an operation broker beyond the standalone proxy's default result aging. Exported benchmark data is evidence for that treatment, not a claim that every packaged feature is always active or individually causal.
