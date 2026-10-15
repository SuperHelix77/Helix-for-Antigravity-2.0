# Security And Privacy

HELIX is a local development tool, not a hardened multi-user service or command sandbox.

## Boundaries

- The service binds only to `127.0.0.1` and requires an owner-private random capability. Browser-origin HTTP requests are rejected.
- Electron uses context isolation, sandboxing and no renderer Node integration. Navigation, new windows, downloads and permissions are denied. The renderer CSP blocks external network access. IPC checks the owned top-level frame and exposes bounded operations only.
- Release mode exposes no benchmark IPC or view. Monitor mode reads a selected local directory; it does not start runs.
- Local memory and goal execution do not call a model. Optional OpenAI traffic requires explicit startup configuration and caller-supplied authorization. No authentication discovery, third-party model fallback or automatic model retry is performed by that proxy.
- The optional Claude-Mem database is opened read-only after explicit configuration. No observer or Ollama worker is started.
- Explicit memory inheritance copies the complete selected database and auxiliary data into owner-private storage, with verification before activation. Historical jobs are data only. New writes use HELIX's overlay; originals and a shared Claude installation are not modified.
- Optional native Codex monitoring follows only the selected local chat through an owner-private Unix socket. Internal protocol versions, frames, scope and revisions are checked. Conversation data may arrive in a snapshot, but only activity metadata is retained or sent to Electron. Text is not logged, archived or exported. An incompatible or disconnected feed is unknown, not proof of idle or reasoning.

The same local account can access the service capability, execute tools and read state. HELIX does not protect that account's data from the account itself, a compromised agent, a malicious dependency or an administrator. POSIX permission checks are not a substitute for a Windows ACL audit.

The pinned Electron 43.7.11 updates the earlier vulnerable runtime; see the
[upstream release](https://github.com/electron/electron/releases/tag/v43.7.11)
and [preload-cache advisory](https://github.com/electron/electron/security/advisories/GHSA-qmv3-fv6v-rmhq).
The packaging-only `global-agent` override uses 4.1.3 to avoid the obsolete
formatter dependency chain. Its public bootstrap API and actual macOS
packaging are checked. A clean npm advisory scan is time-bound evidence,
not proof that dependencies contain no vulnerabilities.

## Execution And Recovery

Goal/workflow commands run with the service account's permissions. Only declare commands already authorized for the active task. Revision checks, fixed argv, cancellation, bounded operations and idempotency reduce mistakes; they do not turn untrusted shell commands into safe code.

Retained originals may contain sensitive tool output. Keep the entire state directory and retention keys private. Exact recovery is a local capability, not automatic redaction or semantic validation. Do not publish a raw archive merely because a compact receipt looks harmless.

Native process supervision acts only on owned identities. Unknown stale service locks and processes are not killed automatically. The private benchmark launcher reserves ownership atomically, validates a reviewed contract and bound runner, reserves its log before spawning, and stops its child on publication/log failure or cancellation. Failed launches preserve evidence and are not permission to retry model work blindly.

## Publication

Only curated source, license notices, public synthetic screenshots and reconstructed aggregate benchmark data belong in the repository. Exclude personal memory, raw sessions, provider captures, hidden test patches, authentication files, capabilities, `.env`, database files and exact private recovery archives.

`npm run privacy` is a mechanical detector, not a universal privacy guarantee. Its negatives must be tested and every public file reviewed. Dependency advisories, license obligations, packaged resources and actual exported JSON/CSV require separate checks. An HTTP response, active process or PASS receipt alone is not release approval.

Report vulnerabilities through a private GitHub security report when that facility is enabled. Do not post live credentials, private logs or personal memory in a public issue. If no private channel is available, open a minimal issue asking for one without including sensitive details.
