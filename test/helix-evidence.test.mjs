import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync, statSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { GoalEngine } from "../src/helix-goal-engine.mjs";
import { HelixEvidence, digest, createCompactReceipt, compactReceiptText, verifyCompactReceipt } from "../src/helix-evidence.mjs";
import { archiveCompactionInput } from "../src/context-archive.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "helix-evidence-test-")); const engines = [];
  const f = { root, project: root, directory: path.join(root, "state"), open() {
    const engine = new GoalEngine({ directory: this.directory }); engines.push(engine);
    return { engine, evidence: new HelixEvidence(engine) };
  } };
  t.after(() => { for (const engine of engines) { try { engine.close(); } catch { /* closed for restart */ } } rmSync(root, { recursive: true, force: true }); });
  return f;
}
const command = (id, script, extra = {}) => ({ id, kind: "command", argv: [process.execPath, "-e", script], ...extra });
const output = (engine, stdout, stderr = "", exit_code = 0) => ({ exit_code, stdout: engine.archive(Buffer.from(stdout)), stderr: engine.archive(Buffer.from(stderr)), failure: null });

test("receipt verifies TAP candidates and diagnostics, not semantic success; bounded fallback preserves retrieval", (t) => {
  const { engine } = fixture(t).open();
  const r = createCompactReceipt(engine, output(engine, "TAP version 13\nnot ok 1 - regression\n# tests 3\n# pass 2\n# fail 1\n", "x.js:9: error: failed\n", 1));
  const packet = engine.objectJSON(r);
  assert.equal(verifyCompactReceipt(engine, packet), true);
  assert.deepEqual(packet.stdout.counts.map((c) => [c.label, c.value]), [["tests", 3], ["pass", 2], ["fail", 1]]);
  assert.equal(packet.semantic_success, null); assert.equal(packet.partial, true);
  assert.match(compactReceiptText(engine, r), /Exit 1/); assert.match(compactReceiptText(engine, r), /regression/);
  assert.ok(Buffer.byteLength(compactReceiptText(engine, r, { budget: 512 })) <= 512);
  assert.throws(() => compactReceiptText(engine, r, { budget: 100 }), /budget/);
});

test("independent verifier rejects boolean count, omitted count fraud, altered preview and source binding", (t) => {
  const { engine } = fixture(t).open();
  const r = createCompactReceipt(engine, output(engine, "# pass 0\n# fail 1\nnot ok 1 - failure\n"));
  const p = engine.objectJSON(r);
  for (const mutate of [
    (x) => { x.stdout.counts[0].value = false; }, (x) => { x.stdout.omitted_counts = 1; },
    (x) => { x.stdout.evidence[0].text = "invented"; }, (x) => { x.execution.exit_code = 8; },
    (x) => { x.stdout.raw = x.stderr.raw; },
  ]) { const copy = structuredClone(p); mutate(copy); assert.throws(() => verifyCompactReceipt(engine, copy), /mismatch/); }
});

test("over-budget diagnostics retain counts/exit/raw handles instead of collapsing into a pointer", t => {
  const {engine}=fixture(t).open();
  const log="# tests 15\n# pass 0\n# fail 15\n"+Array.from({length:15},(_,i)=>`not ok ${i+1} - ${"details ".repeat(100)}`).join("\n");
  const id=createCompactReceipt(engine,output(engine,log,"exception cause\n"+"extra ".repeat(150),1));
  const text=compactReceiptText(engine,id,{budget:1500,include_previews:false}),packet=engine.objectJSON(id);
  assert.ok(Buffer.byteLength(text)<=1500);assert.match(text,/Exit 1/);assert.match(text,/tap tests=15/);assert.match(text,/tap fail=15/);
  assert.ok(text.includes(packet.stdout.raw));assert.ok(text.includes(packet.stderr.raw));assert.match(text,/Budget omitted/);
  assert.match(text,/exception cause/);
});

test("pytest repeated candidate summaries and overflow omissions are preserved, not combined into a false total", (t) => {
  const { engine } = fixture(t).open();
  const raw = "===== 2 passed, 1 failed, 3 skipped in 0.3s =====\n".repeat(20);
  const r = createCompactReceipt(engine, output(engine, raw)); const p = engine.objectJSON(r);
  assert.equal(p.stdout.counts.length, 32); assert.equal(p.stdout.omitted_counts, 28);
  assert.equal(verifyCompactReceipt(engine, p), true);
});

test("raw receipt survives restart byte for byte and corrupted archive fails closed", (t) => {
  const f = fixture(t); let { engine } = f.open(); const bytes = Buffer.from([0, 255, 10, 13, 240]);
  const o = output(engine, ""); o.stdout = engine.archive(bytes);
  const r = createCompactReceipt(engine, o); engine.close(); ({ engine } = f.open());
  assert.equal(verifyCompactReceipt(engine, engine.objectJSON(r)), true);
  assert.deepEqual(Buffer.from(engine.read(o.stdout).content, "base64"), bytes);
  writeFileSync(path.join(engine.objects, o.stdout), "corrupt");
  assert.throws(() => compactReceiptText(engine, r), /integrity/);
});

test("indexed multiranges preserve CRLF, Unicode, empty lines and last unterminated line after restart", (t) => {
  const f = fixture(t); let { engine, evidence } = f.open();
  const bytes = Buffer.from("first\r\n\n\u00e7\u0131\u011f\nlast"); const source = engine.archive(bytes); const index = evidence.index(source).index;
  engine.close(); ({ engine, evidence } = f.open());
  const selected = evidence.ranges({ index, source, ranges: [{ start: 2, end: 3 }, { start: 1, end: 1 }, { start: 4, end: 4 }] });
  assert.deepEqual(selected.map((r) => r.content), ["\n\u00e7\u0131\u011f\n", "first\r\n", "last"]);
  assert.throws(() => evidence.ranges({ index, source, ranges: [{ start: 0, end: 2 }] }), /bounds/);
  assert.throws(() => evidence.ranges({ index, source, ranges: [{ start: 1, end: 4 }], budget: 4 }), /budget/);
  assert.throws(() => evidence.ranges({ index, source: digest("other"), ranges: [{ start: 1, end: 1 }] }), /source mismatch/);
});

test("indexed leaf checks do not reread whole archive; binary and cross-leaf ranges are exact", (t) => {
  const { engine, evidence } = fixture(t).open();
  const lines = Array.from({ length: 20000 }, (_, i) => Buffer.from(`line ${i} ${"x".repeat(40)}\n`));
  lines[7] = Buffer.from([255, 0, 10]);
  const bytes = Buffer.concat(lines); const source = engine.archive(bytes); const index = evidence.index(source).index;
  const before = evidence.counters.evidence_bytes_read;
  const [binary, crossing] = evidence.ranges({ index, source, ranges: [{ start: 8, end: 8 }, { start: 1260, end: 1270 }] });
  assert.deepEqual(Buffer.from(binary.content, binary.encoding), lines[7]);
  assert.deepEqual(Buffer.from(crossing.content), Buffer.concat(lines.slice(1259, 1270)));
  assert.ok(evidence.counters.evidence_bytes_read - before < bytes.length / 2);
});

test("empty source indexes to zero lines; corrupted selected leaf is rejected", (t) => {
  const { engine, evidence } = fixture(t).open();
  assert.equal(evidence.index(engine.archive(Buffer.alloc(0))).lines, 0);
  const source = engine.archive(Buffer.from("a\nb\n")); const index = evidence.index(source).index;
  const root = engine.objectJSON(index); const leaf = engine.objectJSON(root.leaves[0].leaf);
  writeFileSync(path.join(engine.objects, leaf.raw), "tamper");
  assert.throws(() => evidence.ranges({ index, source, ranges: [{ start: 1, end: 1 }] }), /integrity/);
});

test("unregistered indexes cannot relabel different archived bytes as an original source", (t) => {
  const { engine, evidence } = fixture(t).open();
  const source = engine.archive(Buffer.from("ORIGINAL\n")), raw = engine.archive(Buffer.from("FORGED\n"));
  const leaf = engine.archive({ schema: "helix.lines.leaf.v1", raw, offsets: [0, 7], bytes: 7 });
  const index = engine.archive({ schema: "helix.lines.v1", source, bytes: 7, lines: 1,
    leaves: [{ first: 1, count: 1, offset: 0, bytes: 7, leaf }] });
  assert.throws(() => evidence.ranges({ index, source, ranges: [{ start: 1, end: 1 }] }), /reconstruct its source/);
  assert.equal(evidence.verifiedLegacyIndexes.size, 0);
  const malformedLeaf = engine.archive({ schema: "helix.lines.leaf.v1", raw: source, offsets: [0, 3, 9], bytes: 9 });
  const malformed = engine.archive({ schema: "helix.lines.v1", source, bytes: 9, lines: 2,
    leaves: [{ first: 1, count: 2, offset: 0, bytes: 9, leaf: malformedLeaf }] });
  assert.throws(() => evidence.ranges({ index: malformed, source, ranges: [{ start: 1, end: 1 }] }), /line index leaf/);
});

test("legacy indexes prove full reconstruction once per process and recheck after restart", (t) => {
  const f = fixture(t); let { engine, evidence } = f.open();
  const bytes = Buffer.from(Array.from({ length: 20000 }, (_, i) => `public historical line ${i}\r\n`).join("") + "unterminated \u00e7");
  const source = engine.archive(bytes), index = evidence.index(source).index;
  const root = engine.objectJSON(index), lastLeaf = engine.objectJSON(root.leaves.at(-1).leaf);
  engine.db.prepare("DELETE FROM helix_indexes WHERE source=?").run(source);
  engine.close(); ({ engine, evidence } = f.open());
  const before = evidence.counters.evidence_bytes_read;
  const [selected] = evidence.ranges({ index, source, ranges: [{ start: 1, end: 1 }] });
  assert.equal(selected.content, "public historical line 0\r\n");
  assert.ok(evidence.counters.evidence_bytes_read - before >= bytes.length, "Unregistered roots require full reconstruction");
  const warm = evidence.counters.evidence_bytes_read;
  evidence.ranges({ index, source, ranges: [{ start: 2, end: 2 }] });
  assert.ok(evidence.counters.evidence_bytes_read - warm < bytes.length / 2, "The same proven root keeps selected-leaf reads cheap");
  writeFileSync(path.join(engine.objects, lastLeaf.raw), "tampered unselected leaf");
  engine.close(); ({ engine, evidence } = f.open());
  assert.throws(() => evidence.ranges({ index, source, ranges: [{ start: 1, end: 1 }] }), /integrity/);
});

test("registered indexes retain cheap exact selected-leaf reads after restart", (t) => {
  const f = fixture(t); let { engine, evidence } = f.open();
  const bytes = Buffer.from("public registered line\n".repeat(20000));
  const source = engine.archive(bytes), index = evidence.index(source).index;
  engine.close(); ({ engine, evidence } = f.open());
  assert.equal(evidence.ranges({ index, source, ranges: [{ start: 2, end: 2 }] })[0].content, "public registered line\n");
  assert.ok(evidence.counters.evidence_bytes_read < bytes.length / 2);
  const root = engine.objectJSON(index), leaf = engine.objectJSON(root.leaves[0].leaf);
  writeFileSync(path.join(engine.objects, leaf.raw), "tampered selected leaf");
  assert.throws(() => evidence.ranges({ index, source, ranges: [{ start: 2, end: 2 }] }), /integrity/);
});

test("workflow registration is immutable, does not execute, and repeated run after restart shows current frontier", async (t) => {
  const f = fixture(t); let { engine, evidence } = f.open(); writeFileSync(path.join(f.root, "input"), "fixed");
  const args = { project: f.project, name: "check", version: "1", bind: ["input"], steps: [command("one", "require('fs').appendFileSync('count','1');console.log('# pass 1')")] };
  const registered = evidence.register(args); assert.equal(existsSync(path.join(f.root, "count")), false);
  assert.equal(evidence.register(args).workflow, registered.workflow);
  assert.equal(evidence.register({ ...args, steps: args.steps.map((s) => Object.fromEntries(Object.entries(s).reverse())) }).workflow, registered.workflow);
  assert.throws(() => evidence.register({ ...args, steps: [command("two", "console.log('different')")] }), /immutable/);
  const run = { project: f.project, session: "current-task", request_id: "run1", workflow: registered.workflow };
  const done = await evidence.run(run); assert.equal(done.state, "done");
  assert.match(done.summaries.join("\n"), /tap pass=1/);
  engine.close(); ({ engine, evidence } = f.open());
  assert.equal((await evidence.run(run)).replayed, true);
  assert.equal(readFileSync(path.join(f.root, "count"), "utf8"), "1");
  assert.ok(evidence.counters.binding_bytes_read > 0);
});

test("workflow rejects changed scripts and environment; no background revival", async (t) => {
  const f = fixture(t); const { evidence } = f.open(); writeFileSync(path.join(f.root, "script.cjs"), "console.log('ok')");
  const r = evidence.register({ project: f.root, name: "script", version: "1", bind: ["script.cjs"], steps: [{ id: "s", kind: "command", argv: [process.execPath, "script.cjs"] }] });
  const run = { project: f.root, session: "this-task", request_id: "run", workflow: r.workflow };
  process.env.HELIX_NEGATIVE_CONTROL = "changed";
  try { await assert.rejects(evidence.run(run), /environment changed/); } finally { delete process.env.HELIX_NEGATIVE_CONTROL; }
  writeFileSync(path.join(f.root, "script.cjs"), "console.log('not ok')");
  await assert.rejects(evidence.run(run), /input changed/);
});

test("failed workflow blocks downstream, preserves failure receipts and replay does not retry", async (t) => {
  const f = fixture(t); const { engine, evidence } = f.open();
  const r = evidence.register({ project: f.root, name: "fail", version: "1", steps: [command("fail", "console.log('not ok 1 - known failure');process.exit(7)"), command("never", "require('fs').writeFileSync('bad','yes')")] });
  const args = { project: f.root, session: "failure-task", request_id: "run", workflow: r.workflow };
  const failed = await evidence.run(args); assert.equal(failed.state, "blocked");
  assert.equal(existsSync(path.join(f.root, "bad")), false); assert.match(failed.summaries[0], /Exit 7/);
  assert.equal(engine.objectJSON(failed.receipts[0]).mechanical_success, false);
  assert.equal((await evidence.run(args)).replayed, true);
});

test("exact simultaneous edits preserve unchanged bytes, reject stale/ambiguous/overlap and recover after restart", (t) => {
  const f = fixture(t); let { engine, evidence } = f.open(); const file = path.join(f.root, "code.txt");
  const source = "alpha\r\n\u00e7\u0131\u011f\nbeta\n"; writeFileSync(file, source);
  const args = { project: f.root, file: "code.txt", expected_sha256: digest(source), request_id: "edit1", edits: [{ old: "alpha", new: "ALPHA" }, { old: "beta", new: "BETA" }] };
  const r = evidence.edit(args); assert.equal(readFileSync(file, "utf8"), "ALPHA\r\n\u00e7\u0131\u011f\nBETA\n");
  assert.equal(engine.read(r.before).content, source); assert.equal(engine.read(r.after).content, readFileSync(file, "utf8"));
  engine.close(); ({ engine, evidence } = f.open()); assert.equal(evidence.edit(args).replayed, true);
  assert.throws(() => evidence.edit({ ...args, request_id: "stale" }), /Stale/);
  assert.throws(() => evidence.edit({ ...args, edits: [{ old: "alpha", new: "other" }] }), /conflict/);
  writeFileSync(file, "aaa");
  assert.throws(() => evidence.edit({ ...args, expected_sha256: digest("aaa"), request_id: "ambiguous", edits: [{ old: "aa", new: "x" }] }), /ambiguous/);
  assert.throws(() => evidence.edit({ ...args, expected_sha256: digest("aaa"), request_id: "overlap", edits: [{ old: "aaa", new: "x" }, { old: "aa", new: "y" }] }), /ambiguous|Overlapping/);
  assert.equal(readFileSync(file, "utf8"), "aaa");
});

test("exact edits reject symlink escape and binary input without mutation", (t) => {
  const f = fixture(t); const { evidence } = f.open(); writeFileSync(path.join(f.root, "binary"), Buffer.from([255, 0]));
  const args = { project: f.root, file: "binary", expected_sha256: digest(Buffer.from([255, 0])), request_id: "x", edits: [{ old: "a", new: "b" }] };
  assert.throws(() => evidence.edit(args), /encoded data/);
  symlinkSync(path.join(f.root, "binary"), path.join(f.root, "link"));
  assert.throws(() => evidence.edit({ ...args, file: "link" }), /Symlink/);
  assert.deepEqual(readFileSync(path.join(f.root, "binary")), Buffer.from([255, 0]));
});

test("workflow verifies bound inputs after execution, blocking downstream after a successful command mutates a binding", async (t) => {
  const f = fixture(t); const { engine, evidence } = f.open(); writeFileSync(path.join(f.root, "bound"), "old");
  const r = evidence.register({ project: f.root, name: "mutating-input", version: "1", bind: ["bound"], steps: [command("change", "require('fs').writeFileSync('bound','new')"), command("never", "require('fs').writeFileSync('bad','ran')")] });
  const result = await evidence.run({ project: f.root, session: "mutation", request_id: "run", workflow: r.workflow });
  assert.equal(result.state, "blocked"); assert.equal(existsSync(path.join(f.root, "bad")), false);
  const receipt = engine.objectJSON(result.receipts[0]); assert.equal(receipt.outputs[0].exit_code, 0);
  assert.equal(receipt.mechanical_success, false); assert.match(receipt.failure, /input changed/);
});

test("a valid workflow handle cannot qualify a different command or acceptance contract", async (t) => {
  const f = fixture(t); const { engine, evidence } = f.open();
  const registered = evidence.register({ project: f.root, name: "bound-command", version: "1", steps: [command("one", "console.log('allowed')")] });
  const scope = { project: f.root, session: "different-command" };
  const p = await engine.handle({ ...scope, action: "plan", request_id: "plan", objective: "negative control", steps: [command("one", "require('fs').writeFileSync('bad','ran')", { workflow_binding: registered.workflow })] });
  const failed = await engine.handle({ ...scope, action: "advance", goal: p.goal, revision: p.revision, request_id: "run" });
  assert.equal(failed.state, "blocked"); assert.equal(existsSync(path.join(f.root, "bad")), false);
  assert.match(engine.objectJSON(failed.receipts[0]).failure, /differs from bound workflow/);
});

test("qualified receipt reuse avoids raw reads; mutation invalidates even a warm cache", (t) => {
  const { engine, evidence } = fixture(t).open();
  const raw = "evidence trace\n".repeat(20000) + "# pass 1\n";
  const original = output(engine, raw); const id = createCompactReceipt(engine, original, evidence.counters);
  const first = compactReceiptText(engine, id, { counters: evidence.counters });
  const before = evidence.counters.evidence_bytes_read;
  assert.equal(compactReceiptText(engine, id, { counters: evidence.counters }), first);
  assert.equal(evidence.counters.evidence_bytes_read, before);
  assert.ok(evidence.counters.receipt_verification_cache_hits >= 2);
  const rawFile = path.join(engine.objects, original.stdout); const beforeStamp = statSync(rawFile);
  const corrupt = Buffer.from(raw); corrupt[0] ^= 1;
  writeFileSync(rawFile, corrupt); utimesSync(rawFile, beforeStamp.atime, beforeStamp.mtime);
  assert.throws(() => compactReceiptText(engine, id, { counters: evidence.counters }), /integrity/);
});

test("cache capacity is bounded; disabled cache forces validation, restart requalifies", (t) => {
  const f = fixture(t); let { engine } = f.open(); let evidence = new HelixEvidence(engine, { cacheBytes: 1024 });
  const o = output(engine, "raw\n".repeat(1000)); const id = createCompactReceipt(engine, o, evidence.counters);
  compactReceiptText(engine, id, { counters: evidence.counters });
  assert.ok(engine.evidenceCache.bytes <= 1024); engine.close();
  ({ engine } = f.open()); evidence = new HelixEvidence(engine, { cacheBytes: 0 });
  const before = evidence.counters.evidence_bytes_read;
  compactReceiptText(engine, id, { counters: evidence.counters });
  assert.ok(evidence.counters.evidence_bytes_read > before);
  assert.equal(evidence.counters.receipt_verification_cache_hits, 0);
  assert.equal(engine.evidenceCache.bytes, 0);
});

test("attestation reuses only declared inputs/artifacts in this task; changes fail stale and failed attempts stay FAIL", async (t) => {
  const f = fixture(t); let { engine, evidence } = f.open(); writeFileSync(path.join(f.root, "input"), "fixed");
  const scope = { project: f.root, session: "attest-task" };
  const p = await engine.handle({ ...scope, action: "plan", request_id: "p", objective: "fixture", steps: [command("one", "require('fs').writeFileSync('out','result');console.log('# pass 1')", { bind: ["input"], artifacts: ["out"] })] });
  const done = await engine.handle({ ...scope, goal: p.goal, revision: p.revision, action: "advance", request_id: "a" });
  const args = { ...scope, receipt: done.receipts[0] };
  assert.match(evidence.attest(args), /declared files match/);
  const copied = engine.objectJSON(args.receipt); copied.acceptance = "invented acceptance";
  assert.throws(() => evidence.attest({ ...args, receipt: engine.archive(copied) }), /not a recorded engine attempt/);
  assert.match(evidence.attest(args), /Attempt mechanical result: PASS/);
  assert.throws(() => evidence.attest({ ...args, session: "other-task" }), /does not belong/);
  writeFileSync(path.join(f.root, "input"), "changed");
  assert.throws(() => evidence.attest(args), /input input changed/);
  writeFileSync(path.join(f.root, "input"), "fixed"); writeFileSync(path.join(f.root, "out"), "changed");
  assert.throws(() => evidence.attest(args), /artifact out changed/);
  writeFileSync(path.join(f.root, "out"), "result"); engine.close(); ({ engine, evidence } = f.open());
  assert.match(evidence.attest(args), /Attempt mechanical result: PASS/); assert.ok(evidence.counters.binding_bytes_read > 0);
  const p2 = await engine.handle({ ...scope, action: "plan", request_id: "p2", objective: "failed fixture", steps: [command("failed", "process.exit(7)", { bind: ["input"] })] });
  const failed = await engine.handle({ ...scope, goal: p2.goal, revision: p2.revision, action: "advance", request_id: "a2" });
  assert.match(evidence.attest({ ...scope, receipt: failed.receipts[0] }), /Attempt mechanical result: FAIL/);
});

test("unbound successful execution cannot attest current code correctness", async (t) => {
  const f = fixture(t); const { engine, evidence } = f.open(); const scope = { project: f.root, session: "unbound-task" };
  const p = await engine.handle({ ...scope, action: "plan", request_id: "p", objective: "unbound fixture", steps: [command("one", "")] });
  const done = await engine.handle({ ...scope, goal: p.goal, revision: p.revision, action: "advance", request_id: "a" });
  assert.match(evidence.attest({ ...scope, receipt: done.receipts[0] }), /historical execution only/);
});

test("exact overlapping unique edits and missing literals fail without changing bytes", (t) => {
  const f = fixture(t); const { evidence } = f.open(); writeFileSync(path.join(f.root, "code"), "abcdef");
  const args = { project: f.root, file: "code", expected_sha256: digest("abcdef"), request_id: "overlap", edits: [{ old: "abcd", new: "a" }, { old: "cdef", new: "b" }] };
  assert.throws(() => evidence.edit(args), /Overlapping/);
  assert.throws(() => evidence.edit({ ...args, request_id: "missing", edits: [{ old: "absent", new: "x" }] }), /missing/);
  assert.equal(readFileSync(path.join(f.root, "code"), "utf8"), "abcdef");
});

test("MCP exposes and executes all four mechanisms, rejects unknown mutation fields and preserves normal-final contract", async (t) => {
  const f = fixture(t); const historyDirectory = path.join(f.root, "history");
  const archived = archiveCompactionInput([{ type: "message", role: "user", content: "Exact current request." }], { directory: historyDirectory });
  const child = spawn(process.execPath, [path.resolve("bin/helix-context-mcp.mjs")], { env: { ...process.env, HELIX_GOAL_DIR: f.directory, MODEL_ROUTER_CONTEXT_ARCHIVE_DIR: historyDirectory }, stdio: ["pipe", "pipe", "ignore"] });
  t.after(() => child.kill("SIGKILL")); let next = 0; let buffer = ""; const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk; let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) { const r = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); pending.get(r.id)?.(r); }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++next; const timer = setTimeout(() => reject(new Error("MCP timeout")), 5000);
    pending.set(id, (r) => { clearTimeout(timer); pending.delete(id); resolve(r); }); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const call = async (args) => (await rpc("tools/call", { name: "context", arguments: args })).result;
  const init = await rpc("initialize", {}); assert.match(init.result.instructions, /normal model-written answers/);
  const tools = (await rpc("tools/list", {})).result.tools; assert.equal(tools[1].annotations.readOnlyHint, false);
  assert.match((await call({ action: "history", receipt: archived.handle, item: 0 })).content[0].text, /Exact current request/);
  assert.match((await call({ action: "history", receipt: archived.handle, item: 0, query: "current" })).content[0].text, /"match_count":1/);
  const registered = await call({ action: "register", project: f.root, name: "mcp", version: "1", steps: [command("one", "console.log('# pass 1');require('fs').writeFileSync('out','one\\ntwo\\n')", { artifacts: ["out"] })] });
  assert.equal(registered.isError, undefined); const workflow = registered.content[0].text.match(/Workflow ([a-f0-9]{64})/)[1];
  const done = await call({ action: "run", project: f.root, session: "mcp-current", request_id: "run", workflow });
  assert.match(done.content[0].text, /normal final/); const compact = done.content[0].text.match(/Verified receipt ([a-f0-9]{64})/)[1];
  const stepReceipt = done.content[0].text.match(/Attempt receipts: ([a-f0-9]{64})/)[1];
  const attested = await call({ action: "attest", receipt: stepReceipt, project: f.root, session: "mcp-current" });
  assert.match(attested.content[0].text, /declared files match/);
  assert.match(attested.content[0].text, /no duplicate checks solely for reassurance/);
  assert.match((await call({ action: "receipt", receipt: compact })).content[0].text, /tap pass=1/);
  const source = digest("one\ntwo\n"); const indexed = await call({ action: "index", source });
  const index = indexed.content[0].text.match(/Index ([a-f0-9]{64})/)[1];
  assert.match((await call({ action: "ranges", index, source, ranges: [{ start: 2, end: 2 }] })).content[0].text, /\ntwo\n$/);
  const edit = await call({ action: "edit", project: f.root, file: "out", expected_sha256: source, request_id: "edit", edits: [{ old: "two", new: "three" }] });
  assert.match(edit.content[0].text, /Exact edits published/); assert.equal(readFileSync(path.join(f.root, "out"), "utf8"), "one\nthree\n");
  assert.equal((await call({ action: "attest", receipt: stepReceipt, project: f.root, session: "mcp-current" })).isError, true);
  assert.equal((await call({ action: "raw", receipt: source, unknown: true })).isError, true);
  child.stdin.end(); await new Promise((resolve) => child.once("close", resolve));
});
