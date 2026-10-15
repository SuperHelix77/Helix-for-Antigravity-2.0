import test from "node:test";
import assert from "node:assert/strict";
import { authenticatedRoute, validCallerSecret, callerBaseUrl, geminiBaseUrl, claudeBaseUrl, panelUrl, redactCallerUrl } from "../src/caller-auth.mjs";

const secret = "A".repeat(43);

test("invalid expected capabilities cannot authenticate even an identical path value", () => {
  for (const expected of [undefined, null, "", "short", "!".repeat(43), 123]) {
    assert.equal(validCallerSecret(expected), false);
    assert.equal(authenticatedRoute(`/_codex-router/${expected ?? ""}/v1`, expected), undefined);
  }
});

test("only the exact valid capability and path boundary authenticate", () => {
  assert.equal(authenticatedRoute(`/_codex-router/${secret}/v1/responses`, secret), "/v1/responses");
  assert.equal(authenticatedRoute(`/_codex-router/${secret}/`, secret), "/");
  for (const pathname of [undefined, `/_codex-router/${secret}`, `/_codex-router/${secret}B/v1`, `/_codex-router/${"B".repeat(43)}/v1`, `/other/${secret}/v1`]) {
    assert.equal(authenticatedRoute(pathname, secret), undefined);
  }
});

test("supported caller URLs redact the capability without removing the route", () => {
  for (const build of [callerBaseUrl, geminiBaseUrl, claudeBaseUrl, panelUrl]) {
    const url = build(12345, secret), redacted = redactCallerUrl(url);
    assert.equal(redacted.includes(secret), false);
    assert.ok(redacted.includes("[REDACTED]"));
    assert.ok(redacted.startsWith("http://127.0.0.1:12345/_codex-router/"));
  }
});
