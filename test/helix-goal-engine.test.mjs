import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { GoalEngine, goalText } from "../src/helix-goal-engine.mjs";

function fixture(t, options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "helix-goal-test-"));
  const directory = path.join(root, "state");
  const engines = [];
  // A real workspace isolates every command and exact recovery fixture.
  writeFileSync(path.join(root, "marker"), "fixture");
  const f = {
    root, project: root, directory, scope: { project: root, session: "this-test" },
    engine: () => {
      const engine = new GoalEngine({ directory, ...(options.batchSize ? { batchSize: options.batchSize } : {}) });
      engines.push(engine);
      return engine;
    },
  };
  t.after(() => {
    for (const engine of engines) { try { engine.close(); } catch { /* already closed by restart test */ } }
    rmSync(root, { recursive: true, force: true });
  });
  return f;
}

const argv = (script) => [process.execPath, "-e", script];
const model = (id, artifact = "result.txt") => ({ id, title: `Produce ${id}`, kind: "model", acceptance: "Review the requested result and its exact evidence.", artifacts: [artifact] });
const command = (id, script, extras = {}) => ({ id, title: `Execute ${id}`, kind: "command", acceptance: "Declared command passes.", argv: argv(script), ...extras });
const plan = (f, engine, steps, key = "plan") => engine.handle({ ...f.scope, action: "plan", objective: "Finish this authorized fixture", request_id: key, steps });
const call = (f, engine, state, action, extra = {}) => engine.handle({ ...f.scope, goal: state.goal, revision: state.revision, action, request_id: `${action}-${state.revision}`, ...extra });
const status = (f, engine, state) => engine.handle({ ...f.scope, goal: state.goal, action: "status" });
const receipt = (engine, id) => JSON.parse(engine.read(id, { limit: 24000 }).content);

test("batch obeys order, stops at model work, and checkpoint advances to normal-final boundary", async (t) => {
  const f = fixture(t); const engine = f.engine();
  const s = await plan(f, engine, [
    command("first", "require('fs').writeFileSync('order','1')"),
    command("second", "const fs=require('fs'); if(fs.readFileSync('order','utf8')!=='1')process.exit(9); fs.appendFileSync('order','2')"),
    model("review"),
    command("last", "require('fs').appendFileSync('order','3')"),
  ]);
  const a = await call(f, engine, s, "advance");
  assert.equal(a.progress, "2/4"); assert.equal(a.next.id, "review");
  assert.equal(readFileSync(path.join(f.project, "order"), "utf8"), "12");
  writeFileSync(path.join(f.project, "result.txt"), "Complete reviewed evidence\r\n");
  const done = await call(f, engine, a, "checkpoint", { step: "review", review: "Reviewed evidence satisfies the declared criterion." });
  assert.equal(done.state, "done"); assert.equal(done.progress, "4/4");
  assert.equal(readFileSync(path.join(f.project, "order"), "utf8"), "123");
  assert.match(goalText(done), /normal final/);
});

test("failure blocks downstream commands and preserves exact stdout/stderr", async (t) => {
  const f = fixture(t); const engine = f.engine();
  const s = await plan(f, engine, [command("fail", "process.stdout.write('proof\\r\\n'); process.stderr.write('reason'); process.exit(7)"), command("never", "require('fs').writeFileSync('bad','ran')")]);
  const a = await call(f, engine, s, "advance");
  assert.equal(a.state, "blocked"); assert.equal(a.progress, "0/2"); assert.equal(existsSync(path.join(f.project, "bad")), false);
  const r = receipt(engine, a.receipts[0]);
  assert.equal(r.mechanical_success, false); assert.equal(r.semantic_success, null);
  assert.equal(engine.read(r.outputs[0].stdout).content, "proof\r\n");
  assert.equal(engine.read(r.outputs[0].stderr).content, "reason");
  await assert.rejects(call(f, engine, a, "advance"), /blocked/);
});

test("cannot skip a model checkpoint, reuse a stale revision or claim absent evidence", async (t) => {
  const f = fixture(t); const engine = f.engine(); const s = await plan(f, engine, [model("one"), model("two")]);
  await assert.rejects(call(f, engine, s, "checkpoint", { step: "two", review: "done" }), /current model step/);
  const failed = await call(f, engine, s, "checkpoint", { step: "one", review: "attempted" });
  assert.equal(failed.state, "blocked");
  await assert.rejects(call(f, engine, s, "steer", { operation: "retry", review: "inspected" }), /Stale revision/);
});

test("replayed plan and advance after restart never rerun a command", async (t) => {
  const f = fixture(t); let engine = f.engine(); const steps = [command("count", "require('fs').appendFileSync('count','1')")];
  const s = await plan(f, engine, steps);
  const args = { ...f.scope, goal: s.goal, action: "advance", revision: s.revision, request_id: "once" };
  const done = await engine.handle(args); assert.equal(done.state, "done");
  engine.close(); engine = f.engine();
  assert.equal((await engine.handle(args)).replayed, true);
  assert.equal((await engine.handle(Object.fromEntries(Object.entries(args).reverse()))).replayed, true);
  assert.equal((await plan(f, engine, steps)).state, "done");
  assert.equal(readFileSync(path.join(f.project, "count"), "utf8"), "1");
  await assert.rejects(engine.handle({ ...args, revision: 999 }), /different arguments/);
});

test("read-only status cannot revive or cross-bind a saved goal", async (t) => {
  const f = fixture(t); const engine = f.engine(); const s = await plan(f, engine, [model("one")]);
  const stopped = await call(f, engine, s, "steer", { operation: "stop" });
  assert.equal((await status(f, engine, stopped)).state, "stopped"); assert.equal(stopped.next, null);
  await assert.rejects(engine.handle({ ...f.scope, session: "other", goal: s.goal, action: "status" }), /does not belong/);
  await assert.rejects(call(f, engine, stopped, "steer", { operation: "resume" }), /Terminal/);
});

test("fixed input hashes invalidate a command before any execution", async (t) => {
  const f = fixture(t); const engine = f.engine(); writeFileSync(path.join(f.project, "input"), "before");
  const s = await plan(f, engine, [command("check", "require('fs').writeFileSync('bad','ran')", { bind: ["input"] })]);
  writeFileSync(path.join(f.project, "input"), "after");
  const a = await call(f, engine, s, "advance");
  assert.equal(a.state, "blocked"); assert.match(a.note, /Bound input changed/);
  assert.equal(existsSync(path.join(f.project, "bad")), false);
});

test("bound input drift between checks blocks the next command without replay", async (t) => {
  const f = fixture(t); const engine = f.engine();
  writeFileSync(path.join(f.project, "input"), "before");
  const s = await plan(f, engine, [{
    ...model("review", "input"), bind: ["input"], checks: [
      { argv: argv("require('fs').writeFileSync('input','after')") },
      { argv: argv("require('fs').writeFileSync('bad','ran')") },
    ],
  }]);
  const args = { step: "review", review: "Accept only for the declared unchanged input." };
  const a = await call(f, engine, s, "checkpoint", args);
  assert.equal(a.state, "blocked"); assert.match(a.note, /Bound input changed/);
  assert.equal(existsSync(path.join(f.project, "bad")), false);
  assert.equal(receipt(engine, a.receipts[0]).outputs.length, 1);
  assert.equal((await call(f, engine, s, "checkpoint", args)).replayed, true);
  assert.equal(engine.db.prepare("SELECT count(*) AS n FROM events WHERE kind='command_started'").get().n, 1);
});

test("unchanged bindings permit every declared check and preserve their outputs", async (t) => {
  const f = fixture(t); const engine = f.engine();
  writeFileSync(path.join(f.project, "input"), "before");
  const s = await plan(f, engine, [{
    ...model("review", "input"), bind: ["input"], checks: [
      { argv: argv("process.stdout.write('first')") },
      { argv: argv("process.stdout.write('second')") },
    ],
  }]);
  const a = await call(f, engine, s, "checkpoint", { step: "review", review: "Reviewed the exact input and both checks." });
  assert.equal(a.state, "done");
  const saved = receipt(engine, a.receipts[0]);
  assert.deepEqual(saved.outputs.map(output => engine.read(output.stdout).content), ["first", "second"]);
  assert.equal(readFileSync(path.join(f.project, "input"), "utf8"), "before");
});

test("exact evidence survives restart, UTF-8 chunk boundaries, binary bytes and tamper rejection", async (t) => {
  const f = fixture(t); let engine = f.engine();
  const original = Buffer.from("\ufeffprefix\r\n" + "abc\u00e7\u4e2d\ud83d\ude80".repeat(10000));
  const id = engine.archive(original); engine.close(); engine = f.engine();
  let offset = 0; const recovered = [];
  do {
    const part = engine.read(id, { offset, limit: 4097 });
    recovered.push(Buffer.from(part.content, part.encoding === "base64" ? "base64" : "utf8"));
    offset = part.next_offset;
  } while (offset !== null);
  assert.deepEqual(Buffer.concat(recovered), original);
  const binary = Buffer.from([0xff, 0, 0x80, 0x61]); const b = engine.archive(binary);
  assert.deepEqual(Buffer.from(engine.read(b).content, "base64"), binary);
  writeFileSync(path.join(engine.objects, id), "tampered");
  assert.throws(() => engine.read(id), /integrity/);
});

test("artifact symlink escaping the project fails closed", async (t) => {
  const f = fixture(t); const engine = f.engine();
  symlinkSync(process.execPath, path.join(f.project, "outside"));
  const s = await plan(f, engine, [model("one", "outside")]);
  const a = await call(f, engine, s, "checkpoint", { step: "one", review: "reviewed" });
  assert.equal(a.state, "blocked"); assert.match(a.note, /inside this project/);
});

test("paused state needs explicit resume; failed attempt needs reviewed retry", async (t) => {
  const f = fixture(t); const engine = f.engine(); const s = await plan(f, engine, [model("one")]);
  const p = await call(f, engine, s, "steer", { operation: "pause" });
  await assert.rejects(call(f, engine, p, "advance"), /paused/);
  const a = await call(f, engine, p, "steer", { operation: "resume" });
  const blocked = await call(f, engine, a, "checkpoint", { step: "one", review: "attempted" });
  await assert.rejects(call(f, engine, blocked, "steer", { operation: "retry" }), /Review of the prior/);
  writeFileSync(path.join(f.project, "result.txt"), "reviewed result");
  const retry = await call(f, engine, blocked, "steer", { operation: "retry", review: "No mutation occurred; added missing evidence and reviewed it." });
  const done = await call(f, engine, retry, "checkpoint", { step: "one", review: "Acceptance met." });
  assert.equal(done.state, "done");
});

test("replan replaces only unfinished work and retains the completed prefix", async (t) => {
  const f = fixture(t); const engine = f.engine(); const s = await plan(f, engine, [command("one", "process.exit(0)"), model("two")]);
  const a = await call(f, engine, s, "advance");
  const r = await call(f, engine, a, "steer", { operation: "replan", steps: [model("new")] });
  const expanded = receipt(engine, (await call(f, engine, r, "inspect")).snapshot);
  assert.deepEqual(expanded.steps.map((step) => step.id), ["one", "new"]);
  assert.equal(expanded.steps[0].status, "done"); assert.ok(expanded.steps[0].receipt);
});

test("two owners cannot execute one goal concurrently; stop aborts the owned process", async (t) => {
  const f = fixture(t); const one = f.engine(); const two = f.engine();
  const s = await plan(f, one, [command("slow", "require('fs').writeFileSync('pid',String(process.pid)); setInterval(()=>{},1000)", { timeout_ms: 10000 }), command("never", "require('fs').writeFileSync('bad','ran')")]);
  const pending = call(f, one, s, "advance");
  while (!existsSync(path.join(f.project, "pid"))) await new Promise((resolve) => setTimeout(resolve, 5));
  const running = await status(f, two, s);
  await assert.rejects(call(f, two, running, "advance", { request_id: "other-owner" }), /Another operation/);
  await call(f, two, running, "steer", { operation: "stop" });
  const stopped = await pending;
  assert.equal(stopped.state, "stopped"); assert.equal(stopped.progress, "0/2");
  assert.equal(existsSync(path.join(f.project, "bad")), false);
  const pid = Number(readFileSync(path.join(f.project, "pid"), "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("pre-cancelled process supervisor does not spawn or journal a command", async (t) => {
  const f=fixture(t),engine=f.engine(),controller=new AbortController();controller.abort();
  const state=await plan(f,engine,[model("review")]);
  const row=engine.db.prepare("SELECT * FROM goals WHERE id=?").get(state.goal);
  const result=await engine.runCommand({argv:argv("require('fs').writeFileSync('bad','ran')"),timeout_ms:1000},row,controller.signal);
  assert.equal(result.failure,"interrupted");assert.equal(result.exit_code,null);
  assert.equal(existsSync(path.join(f.root,"bad")),false);
  assert.equal(engine.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='command_started'").get().n,0);
  assert.equal(engine.read(result.stdout).content,"");assert.ok(result.compact_receipt);
});

test("timeout blocks completion and records a failed receipt", async (t) => {
  const f = fixture(t); const engine = f.engine(); const s = await plan(f, engine, [command("timeout", "setInterval(()=>{},1000)", { timeout_ms: 75 })]);
  const a = await call(f, engine, s, "advance");
  assert.equal(a.state, "blocked"); assert.match(a.note, /timeout/);
  assert.equal(receipt(engine, a.receipts[0]).outputs[0].failure, "timeout");
});

test("large real command output is archived byte for byte instead of truncated", async (t) => {
  const f = fixture(t); const engine = f.engine();
  const original = Buffer.alloc(250003, 0x61); original[12] = 0xff; original[250002] = 0;
  writeFileSync(path.join(f.project, "long.bin"), original);
  const s = await plan(f, engine, [command("long", "process.stdout.write(require('fs').readFileSync('long.bin'))")]);
  const a = await call(f, engine, s, "advance");
  assert.equal(a.state, "done"); assert.ok(goalText(a).length < 1000);
  const id = receipt(engine, a.receipts[0]).outputs[0].stdout;
  let offset = 0; const parts = [];
  do {
    const raw = engine.read(id, { offset });
    parts.push(Buffer.from(raw.content, raw.encoding === "base64" ? "base64" : "utf8"));
    offset = raw.next_offset;
  } while (offset !== null);
  assert.deepEqual(Buffer.concat(parts), original);
});

test("a cancelled call does not run the next command or accept completion", async (t) => {
  const f = fixture(t); const engine = f.engine();
  const s = await plan(f, engine, [command("never", "require('fs').writeFileSync('bad','ran')")]);
  const controller = new AbortController(); controller.abort();
  const a = await engine.handle({ ...f.scope, goal: s.goal, revision: s.revision, action: "advance", request_id: "cancelled" }, { signal: controller.signal });
  assert.equal(a.state, "blocked"); assert.equal(existsSync(path.join(f.project, "bad")), false);
});

test("owner crash refuses recovery while an orphan runs; later recovers its partial raw logs", async (t) => {
  const f = fixture(t);
  const module = new URL("../src/helix-goal-engine.mjs", import.meta.url).href;
  const script = `import {GoalEngine} from ${JSON.stringify(module)};
    import {writeFileSync} from 'node:fs';
    const e=new GoalEngine({directory:${JSON.stringify(f.directory)}});
    const s=await e.handle(${JSON.stringify({ ...f.scope, action: "plan", request_id: "crash-plan", objective: "Crash fixture", steps: [command("slow", "require('fs').writeFileSync('orphan-pid',String(process.pid)); process.stdout.write('partial proof\\r\\n'); setInterval(()=>{},1000)", { timeout_ms: 10000 })] })});
    writeFileSync(${JSON.stringify(path.join(f.project, "goal.json"))},JSON.stringify(s));
    await e.handle({...${JSON.stringify(f.scope)},goal:s.goal,revision:s.revision,action:'advance',request_id:'crash-run'});`;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
  let pid;
  t.after(() => { owner.kill("SIGKILL"); if (pid) { try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } } });
  while (!existsSync(path.join(f.project, "orphan-pid"))) await new Promise((resolve) => setTimeout(resolve, 5));
  pid = Number(readFileSync(path.join(f.project, "orphan-pid"), "utf8"));
  owner.kill("SIGKILL"); await new Promise((resolve) => owner.once("close", resolve));
  const engine = f.engine(); const s = JSON.parse(readFileSync(path.join(f.project, "goal.json")));
  const running = await status(f, engine, s);
  await assert.rejects(call(f, engine, running, "steer", { operation: "recover", review: "inspected" }), /process group may still be alive/);
  process.kill(-pid, "SIGKILL");
  while (true) {
    try { process.kill(-pid, 0); await new Promise((resolve) => setTimeout(resolve, 5)); }
    catch (error) { if (error.code === "ESRCH" || error.code === "EPERM") break; throw error; }
  }
  const recovered = await call(f, engine, running, "steer", { operation: "recover", review: "Owned orphan terminated; inspected the partial effects.", request_id: "recover-after-stop" });
  assert.equal(recovered.state, "blocked"); assert.equal(recovered.progress, "0/1");
  const r = receipt(engine, recovered.receipt);
  assert.equal(r.recovered_logs[0].complete, false);
  assert.equal(engine.read(r.recovered_logs[0].stdout).content, "partial proof\r\n");
});

test("model checks fail even when an artifact and a positive review are supplied", async (t) => {
  const f = fixture(t); const engine = f.engine(); writeFileSync(path.join(f.project, "result.txt"), "looks fine");
  const s = await plan(f, engine, [{ ...model("one"), checks: [{ argv: argv("process.exit(3)") }] }]);
  const a = await call(f, engine, s, "checkpoint", { step: "one", review: "I think this passes." });
  assert.equal(a.state, "blocked"); assert.equal(a.progress, "0/1");
});

test("batch boundary does not invent semantic work and replay shows current frontier", async (t) => {
  const f = fixture(t, { batchSize: 1 }); const engine = f.engine(); const s = await plan(f, engine, [command("one", "process.exit(0)"), command("two", "process.exit(0)")]);
  const args = { ...f.scope, goal: s.goal, revision: s.revision, action: "advance", request_id: "first" };
  const a = await engine.handle(args); assert.equal(a.progress, "1/2");
  const done = await call(f, engine, a, "advance"); assert.equal(done.state, "done");
  const replay = await engine.handle(args); assert.equal(replay.state, "done"); assert.equal(replay.next, null);
});

test("uncertain crashed owner cannot be recovered while its identity is alive", async (t) => {
  const f = fixture(t); const engine = f.engine(); const s = await plan(f, engine, [model("one")]);
  engine.db.prepare("UPDATE goals SET operation_key='lost',owner_pid=?,owner_identity=?,state='running' WHERE id=?")
    .run(process.pid, engine.ownerIdentity, s.goal);
  await assert.rejects(call(f, engine, s, "steer", { operation: "recover" }), /alive or unverifiable/);
  engine.db.prepare("UPDATE goals SET owner_identity='different-start-identity' WHERE id=?").run(s.goal);
  const recovered = await call(f, engine, s, "steer", { operation: "recover", request_id: "recovery", review: "No command had started; inspected the fixture state." });
  assert.equal(recovered.state, "blocked"); assert.equal(recovered.busy, false);
  assert.match(recovered.note, /outcome unknown/);
});

test("plan validates duplicate steps, empty evidence and unknown fields", async (t) => {
  const f = fixture(t); const engine = f.engine();
  await assert.rejects(plan(f, engine, [model("same"), model("same")]), /unique/);
  await assert.rejects(plan(f, engine, [{ id: "one", title: "one", acceptance: "done" }]), /requires checks or/);
  await assert.rejects(plan(f, engine, [{ ...model("one"), arbitrary: true }]), /Invalid step fields/);
});

test("minimal command plans need no model-written title or redundant criterion", async (t) => {
  const f = fixture(t); const engine = f.engine();
  const s = await plan(f, engine, [{ id: "check", kind: "command", argv: argv("process.exit(0)") }]);
  assert.equal(s.next.title, "check"); assert.match(s.next.acceptance, /without interruption/);
  assert.equal((await call(f, engine, s, "advance")).state, "done");
});

test("MCP handshake, lazy policy, tool calls and errors use clean stdio envelopes", async (t) => {
  const f = fixture(t);
  const child = spawn(process.execPath, [path.resolve("bin/helix-context-mcp.mjs")], { env: { ...process.env, HELIX_GOAL_DIR: f.directory }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  const pending = new Map(); let buffer = ""; let id = 0;
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      pending.get(message.id)?.(message); pending.delete(message.id);
    }
  });
  const rpc = (method, params = {}) => new Promise((resolve) => {
    const key = ++id; pending.set(key, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: key, method, params }) + "\n");
  });
  const init = await rpc("initialize", { protocolVersion: "2024-11-05" });
  assert.match(init.result.instructions, /normal model-written answers/);
  assert.deepEqual((await rpc("tools/list")).result.tools.map((tool) => tool.name), ["goal", "context"]);
  const policy = await rpc("resources/read", { uri: "helix://context/policy" });
  assert.match(policy.result.contents[0].text, /sha256=/);
  const created = await rpc("tools/call", { name: "goal", arguments: { ...f.scope, action: "plan", request_id: "mcp", objective: "test", steps: [command("one", "process.stdout.write('raw stdout')")] } });
  assert.equal(created.result.isError, undefined); assert.match(created.result.content[0].text, /active 0\/1/);
  const [, goal, revision] = created.result.content[0].text.match(/^(\S+) r(\d+)/);
  const advanced = await rpc("tools/call", { name: "goal", arguments: { ...f.scope, action: "advance", goal, revision: Number(revision), request_id: "mcp-run" } });
  assert.match(advanced.result.content[0].text, /done 1\/1/);
  assert.doesNotMatch(advanced.result.content[0].text, /raw stdout/);
  const slow = await rpc("tools/call", { name: "goal", arguments: { ...f.scope, action: "plan", request_id: "mcp-slow", objective: "cancel test", steps: [command("slow", "require('fs').writeFileSync('mcp-pid',String(process.pid)); setInterval(()=>{},1000)")] } });
  const [, slowGoal, slowRevision] = slow.result.content[0].text.match(/^(\S+) r(\d+)/);
  const activeId = id + 1;
  const running = rpc("tools/call", { name: "goal", arguments: { ...f.scope, action: "advance", goal: slowGoal, revision: Number(slowRevision), request_id: "mcp-cancel" } });
  while (!existsSync(path.join(f.project, "mcp-pid"))) await new Promise((resolve) => setTimeout(resolve, 5));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: activeId } }) + "\n");
  assert.match((await running).result.content[0].text, /blocked 0\/1/);
  const bad = await rpc("tools/call", { name: "goal", arguments: { action: "unknown" } });
  assert.equal(bad.result.isError, true);
  child.stdin.end();
  await new Promise((resolve) => child.once("close", resolve));
});
