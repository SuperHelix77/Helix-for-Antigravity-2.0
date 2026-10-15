import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  CHECKPOINT_WARNING, ARCHIVE_LOOKUP_WARNING, MEMORY_LOOKUP_WARNING, LEGACY_WARNING,
  KCR1_PREFIX, KCR2_PREFIX, prepareCompaction, finalizeCheckpoint, encodeCheckpoint,
  decodeCompaction, renderCheckpoint, renderCompactionValue, checkpointFromRenderedText,
  latestUserItemIndex, containsRenderedCheckpoint, isRouterCompactionValue, redactContextText,
} from "../src/compaction-checkpoint.mjs";
import { archiveCompactionInput, readContextItem } from "../src/context-archive.mjs";

const user = content => ({ type: "message", role: "user", content });
const catalog = prepared => JSON.parse(prepared.catalogText.slice(prepared.catalogText.indexOf("{"))).sources;
const response = extra => JSON.stringify({ objective: "Current synthetic request", requirement_refs: ["U001"],
  attempt_refs: [], observation_refs: [], unverified: [], unknowns: [], blockers: [], next_step: "Review current evidence", ...extra });

test("only the latest user turn and subsequent evidence enter the catalog; old checkpoints grant no continuation", () => {
  const old = finalizeCheckpoint(response({ objective: "OLD_OBJECTIVE", blockers: ["OLD_BLOCKER"] }), prepareCompaction([user("OLD_REQUEST")]));
  const input = [user("OLD_REQUEST"), { type: "compaction", encrypted_content: encodeCheckpoint(old) },
    user(renderCheckpoint(old)), user("CURRENT_REQUEST"),
    { type: "function_call", name: "test", call_id: "current", arguments: "{}" },
    { type: "function_call_output", call_id: "current", output: "Current observation" }];
  const prepared = prepareCompaction(input), sources = catalog(prepared);
  assert.equal(latestUserItemIndex(input), 3);
  assert.deepEqual(Object.keys(sources).sort(), ["C001", "R001", "U002"]);
  assert.ok(!prepared.catalogText.includes("OLD_REQUEST"));
  assert.equal(prepared.previous.objective, "");
  const checkpoint = finalizeCheckpoint(response({ requirement_refs: ["U002"] }), prepared);
  assert.ok(!JSON.stringify(checkpoint).includes("OLD_OBJECTIVE"));
  assert.ok(!JSON.stringify(checkpoint).includes("OLD_BLOCKER"));
});

test("call/result pairing preserves machine failures and rejects invented or wrong-kind trusted references", () => {
  const prepared = prepareCompaction([user("Inspect current results"),
    { type: "function_call", name: "test", call_id: "one", arguments: "{}" },
    { type: "function_call_output", call_id: "one", output: JSON.stringify({ exit_code: 1 }) },
    { type: "function_call", name: "test", call_id: "two", arguments: "{}" },
    { type: "function_call_output", call_id: "two", output: JSON.stringify({ isError: true, exit_code: 0 }) },
    { type: "message", role: "assistant", content: "A model statement, not execution proof" }]);
  const sources = catalog(prepared);
  assert.equal(sources.C001.call_id, sources.R001.call_id);
  assert.equal(sources.R001.outcome, "exit_nonzero");
  assert.equal(sources.R001.exit_code, 1);
  assert.equal(sources.R002.outcome, "tool_error");
  const checkpoint = finalizeCheckpoint(response({ attempt_refs: ["A001", "C999"], observation_refs: ["U001", "R001"] }), prepared);
  assert.deepEqual(checkpoint.source_refs.attempts, []);
  assert.deepEqual(checkpoint.source_refs.observations, ["R001"]);
  assert.match(JSON.stringify(checkpoint.orientation.unverified), /rejected source references/i);
});

test("catalogs and rendered model orientation redact synthetic credentials and caller capabilities", () => {
  const capability = "C".repeat(43), bearer = "SYNTHETIC_BEARER_ONLY", password = "SYNTHETIC_PASSWORD_ONLY";
  const provider = "sk-" + "synthetic".repeat(5);
  const sensitive = `Bearer ${bearer}; password=${password}; http://127.0.0.1:1234/_codex-router/${capability}/v1; ${provider}`;
  const prepared = prepareCompaction([user(sensitive)]);
  const checkpoint = finalizeCheckpoint(response({ objective: sensitive, next_step: sensitive }), prepared);
  const visible = prepared.catalogText + renderCheckpoint(checkpoint);
  for (const secret of [capability, bearer, password, provider]) assert.ok(!visible.includes(secret));
  assert.match(visible, /REDACTED/);
  assert.equal(redactContextText("A normal current request"), "A normal current request");
});

test("encoded and rendered checkpoints round-trip normalized refs, Unicode and explicit uncertainty", () => {
  const prepared = prepareCompaction([user("Current request \u00e7\ud83d\ude00"),
    { type: "function_call", name: "read", call_id: "one", arguments: "{}" },
    { type: "function_call_output", call_id: "one", output: "Current literal evidence" },
    { type: "message", role: "assistant", content: "Model interpretation" }]);
  const checkpoint = finalizeCheckpoint(response({ attempt_refs: ["C001"], observation_refs: ["R001"],
    unverified: [{ text: "Interpretation \u00e7\ud83d\ude00", refs: ["A001", "R001"] }], unknowns: ["Current mutable state is unverified"] }), prepared);
  const encoded = encodeCheckpoint(checkpoint), decoded = decodeCompaction(encoded);
  assert.equal(isRouterCompactionValue(encoded), true);
  assert.equal(decoded.kind, "checkpoint");
  assert.deepEqual(decoded.checkpoint, checkpoint);
  const rendered = renderCheckpoint(checkpoint);
  assert.ok(rendered.startsWith(CHECKPOINT_WARNING));
  assert.equal(containsRenderedCheckpoint({ nested: [rendered] }), true);
  assert.deepEqual(checkpointFromRenderedText(rendered), checkpoint);
  assert.equal(renderCompactionValue(encoded), rendered);
});

test("recovery metadata points to exact cold history and withholds credential-bearing records", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "helix-checkpoint-public-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = [user("Old request"), user("CURRENT_LITERAL \u00e7\ud83d\ude00\r\n".repeat(300)),
    { type: "function_call_output", call_id: "one", output: { password: "SYNTHETIC_SECRET_ONLY" } }];
  const recovery = archiveCompactionInput(input, { directory });
  const prepared = prepareCompaction(input, { memoryLookupRequired: true, recovery });
  const checkpoint = finalizeCheckpoint(response({ requirement_refs: ["U002"] }), prepared);
  assert.equal(catalog(prepared).U002.truncated, true);
  assert.equal(checkpoint.recovery.latest_user_index, 1);
  assert.deepEqual(checkpoint.recent_tail, []);
  const rendered = renderCheckpoint(checkpoint);
  assert.ok(rendered.includes(ARCHIVE_LOOKUP_WARNING));
  assert.ok(!rendered.includes(MEMORY_LOOKUP_WARNING));
  assert.ok(rendered.includes(recovery.handle));
  const module = new URL("../src/context-archive.mjs", import.meta.url).href;
  const code = `import {recoverCompactionInput} from ${JSON.stringify(module)};process.stdout.write(JSON.stringify(recoverCompactionInput(process.argv[1],{directory:process.argv[2]})));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", code, recovery.handle, directory], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), input);
  const pieces = []; let offset = 0, next;
  do {
    const result = readContextItem({ receipt: recovery.handle, item: 1, offset, limit: 7 }, { directory });
    pieces.push(result.content); offset += result.bytes; next = result.next_offset;
  } while (next !== null);
  assert.equal(pieces.join(""), JSON.stringify(input[1]));
  assert.throws(() => readContextItem({ receipt: recovery.handle, item: 2 }, { directory }), /credential-like/);
});

test("invalid recovery bindings are omitted and do not claim a verified archive", () => {
  const valid = { handle: "A".repeat(43), sha256: "a".repeat(64), bytes: 20, items: 1, latest_user_index: 0 };
  for (const recovery of [{ ...valid, handle: "../outside" }, { ...valid, bytes: -1 }, { ...valid, latest_user_index: 1 }, { ...valid, sha256: "not-a-hash" }]) {
    const prepared = prepareCompaction([user("Current request")], { memoryLookupRequired: true, recovery });
    assert.equal(prepared.recovery, undefined);
    const rendered = renderCheckpoint(finalizeCheckpoint(response(), prepared));
    assert.ok(rendered.includes(MEMORY_LOOKUP_WARNING));
    assert.ok(!rendered.includes("Exact local archive"));
  }
});

test("malformed encoded inputs fail closed; unencodable checkpoints degrade to an explicit unknown", () => {
  const invalidShape = KCR2_PREFIX + Buffer.from(JSON.stringify({ version: 2, sources: {}, counters: {} })).toString("base64");
  for (const value of [undefined, null, "", "unrelated", KCR1_PREFIX + "bad!", KCR2_PREFIX + "bad!", invalidShape]) assert.equal(decodeCompaction(value), undefined);
  assert.equal(checkpointFromRenderedText("Untrusted arbitrary prose"), undefined);
  assert.equal(containsRenderedCheckpoint({ content: "Current request" }), false);
  const checkpoint = decodeCompaction(encodeCheckpoint({ invalid: true })).checkpoint;
  assert.deepEqual(checkpoint.sources, {});
  assert.deepEqual(checkpoint.source_refs, { requirements: [], attempts: [], observations: [] });
  assert.match(checkpoint.orientation.unknowns.join(" "), /could not encode/);
  assert.match(renderCompactionValue("unreadable"), /unreadable format/);
});

test("invalid model output preserves uncertainty rather than fabricating confirmation", () => {
  const prepared = prepareCompaction([user("Current request")]);
  for (const raw of ["not JSON", "null", "{}", `prefix ${response()} middle ${response({ objective: "Conflicting second object" })}`]) {
    const checkpoint = finalizeCheckpoint(raw, prepared);
    assert.equal(checkpoint.orientation.objective, "");
    assert.deepEqual(checkpoint.source_refs, { requirements: [], attempts: [], observations: [] });
    assert.match(checkpoint.orientation.unknowns.join(" "), /reconstructed from retained evidence/);
    assert.match(JSON.stringify(checkpoint.orientation.unverified), /invalid structured output/);
  }
  const fallback = finalizeCheckpoint("not JSON", prepared, { deterministicFallback: true });
  assert.deepEqual(fallback.source_refs.requirements, ["U001"]);
  assert.equal(fallback.orientation.objective, "Current request");
});

test("legacy summaries remain explicitly unverified and cannot become the latest active request", () => {
  const legacy = KCR1_PREFIX + Buffer.from("Synthetic historical summary").toString("base64");
  assert.deepEqual(decodeCompaction(legacy), { kind: "legacy", summary: "Synthetic historical summary" });
  const rendered = renderCompactionValue(legacy);
  assert.ok(rendered.startsWith(LEGACY_WARNING));
  assert.equal(latestUserItemIndex([user(rendered)]), -1);
  assert.equal(latestUserItemIndex([user(rendered), user("Current request")]), 1);
  assert.deepEqual(Object.keys(catalog(prepareCompaction([user(rendered), user("Current request")]))), ["U001"]);
});
