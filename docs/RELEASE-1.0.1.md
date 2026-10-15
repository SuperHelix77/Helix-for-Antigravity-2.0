# HELIX 1.0.1: Memory, Native Activity And Integrity

This patch completes two integration gaps in the first release and hardens the module boundaries found during the release audit.

- Worker-independent Claude-Mem inheritance preserves a verified point-in-time SQLite copy, all tables and explicitly selected auxiliary files. Originals remain unchanged. Pending jobs and embeddings are retained as data, never executed. Literal search is deterministic, not a claim of identical semantic ranking.
- Compatibility MCP adapters share HELIX's service for scoped memory read/write and exact recovery, including inherited parent-project aliases for new submodule callers. New notes and work state use HELIX's writable overlay; the inherited baseline stays read-only. Old work does not become new authorization.
- Native Codex activity can follow an explicitly selected local chat without rerouting model traffic. Reasoning, generation, tool work, compaction and idle are distinct. Updates push to Electron; the reasoning light does not depend on a two-second poll.
- The owner-private native feed is bounded, scoped and version-checked. Only metadata is retained. Conversation data present in transit is discarded during projection, not logged or exported. Unsupported protocols and lost connections report unknown.
- Native verification blocks known failed/empty/incomplete test evidence even when a shell exits zero. MCP dispatch requires an unambiguous registration. Goal checks stop on changed bindings; Git inspections pin the reviewed revision and recheck HEAD afterward.
- Archived line indexes must have trusted creation provenance or reconstruct their claimed source exactly before selected reads. Broker outputs must match their call type; asynchronous authorization callbacks fail safely without unhandled rejection.
- Process capture preserves multibyte text across output chunks. Retention rejects unsafe root aliases. Proxy cancellation also interrupts a backpressured client stream, without retrying a request. Official API tool budgets are preserved while known native Codex/Lite compatibility adaptations remain.
- UI checks compile production code in an isolated environment. Both UI and privacy checks reject development transforms and personal source paths in generated JavaScript; source-file checks alone were not sufficient.

The actual packaged macOS app was observed displaying native reasoning, generation and tool activity, with the reasoning light switching correctly. Local tests separately cover idle/completion, disconnects, revision recovery, memory inheritance, exact retrieval and capability boundaries. The [module audit](MODULE-AUDIT.md) records the coverage boundary and remaining limits. Memory and RTK remain deterministic integrations: no Ollama, extraction model, embedding worker or background inference is started by HELIX.

There is no new savings benchmark in this patch. The V3 evidence remains 34/50 solves versus vanilla's 38/50, 77.73% fewer known total tokens and 37.14% more output. Unknown usage, failures and the finalization defect remain disclosed. No quality-equivalence, billed-cost or subscription-savings claim is added.

The macOS ARM64 archive is unsigned and not notarized. Source installation remains supported; Windows/Linux binaries and every future Codex desktop protocol are not claimed as verified. Private memories, raw sessions and local configuration are not release assets. The original 1.0.0 release is preserved.
