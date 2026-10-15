import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync,
  openSync, readFileSync, readSync, realpathSync, renameSync, statSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { processStartIdentity, processStartIdentityProbe } from "./process-identity.mjs";
import { terminateProcessTree, windowsJobProcessInvocation } from "./process-tree.mjs";
import { createCompactReceipt, compactReceiptText, verifyWorkflowBinding, qualifiedFileDigest } from "./helix-evidence.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const terminal = new Set(["done", "stopped"]);
const allowedActions = new Set(["plan", "advance", "checkpoint", "status", "inspect", "steer"]);
const inside = (root, file) => file === root || !path.relative(root, file).startsWith(`..${path.sep}`)
  && path.relative(root, file) !== ".." && !path.isAbsolute(path.relative(root, file));

function text(value, label, max = 2000) {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new Error(`${label} must be nonempty text (maximum ${max} characters).`);
  }
  return value;
}

function fields(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`Invalid ${label} fields.`);
}

function digestFile(file) {
  const fd = openSync(file, "r");
  const h = createHash("sha256");
  const buffer = Buffer.alloc(65536);
  try {
    let size;
    while ((size = readSync(fd, buffer, 0, buffer.length, null))) h.update(buffer.subarray(0, size));
    return h.digest("hex");
  } finally { closeSync(fd); }
}

function stamp(file) {
  const s = statSync(file, { bigint: true });
  if (!s.isFile()) throw new Error("A regular file is required.");
  return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode].map(String).join(":");
}

function scopedFile(project, name) {
  text(name, "File path", 4096);
  const file = realpathSync(path.resolve(project, name));
  if (!inside(project, file) || !statSync(file).isFile()) throw new Error("Evidence must be a file inside this project.");
  return file;
}

function command(spec, project) {
  fields(spec, ["argv", "timeout_ms"], "command");
  if (!Array.isArray(spec.argv) || !spec.argv.length || spec.argv.length > 128
    || spec.argv.some((arg) => typeof arg !== "string" || arg.includes("\0") || arg.length > 50000)
    || !spec.argv[0]) throw new Error("Command requires a nonempty string argv array.");
  const timeout = spec.timeout_ms ?? 30000;
  if (!Number.isSafeInteger(timeout) || timeout < 50 || timeout > 600000) throw new Error("Invalid command timeout_ms (50..600000).");
  const requested = spec.argv[0];
  const candidates = path.isAbsolute(requested) ? [requested]
    : requested.includes(path.sep) ? [path.resolve(project, requested)]
      : (process.env.PATH ?? "").split(path.delimiter).map((dir) => path.join(dir, requested));
  const executable = candidates.find((file) => existsSync(file) && statSync(file).isFile());
  if (!executable) throw new Error(`Executable unavailable: ${requested}`);
  const resolved = realpathSync(executable);
  return { argv: [resolved, ...spec.argv.slice(1)], timeout_ms: timeout, executable_stamp: stamp(resolved) };
}

export class GoalEngine {
  constructor({ directory = path.join(os.homedir(), ".codex", "helix-goals"), batchSize = 32 } = {}) {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 128) throw new Error("Invalid batch size.");
    this.directory = path.resolve(directory);
    if (existsSync(this.directory) && lstatSync(this.directory).isSymbolicLink()) throw new Error("Goal directory cannot be a symlink.");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    this.objects = path.join(this.directory, "objects");
    mkdirSync(this.objects, { recursive: true, mode: 0o700 });
    if (lstatSync(this.objects).isSymbolicLink()) throw new Error("Object directory cannot be a symlink.");
    chmodSync(this.objects, 0o700);
    const database = path.join(this.directory, "goals.sqlite3");
    if (existsSync(database) && lstatSync(database).isSymbolicLink()) throw new Error("Goal database cannot be a symlink.");
    this.db = new DatabaseSync(database);
    chmodSync(database, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, session TEXT NOT NULL, objective TEXT NOT NULL,
        revision INTEGER NOT NULL, state TEXT NOT NULL, cursor INTEGER NOT NULL, plan TEXT NOT NULL,
        operation_key TEXT, owner_pid INTEGER, owner_identity TEXT, note TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS one_goal_per_scope ON goals(project,session)
        WHERE state NOT IN ('done','stopped');
      CREATE TABLE IF NOT EXISTS requests (
        goal TEXT, key TEXT, fingerprint TEXT NOT NULL, result TEXT, PRIMARY KEY(goal,key));
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, goal TEXT, revision INTEGER, kind TEXT, receipt TEXT);`);
    this.batchSize = batchSize;
    this.running = new Map();
    this.checkedObjects = new Map();
    this.ownerIdentity = processStartIdentity(process.pid);
  }

  close() {
    if (this.running.size) throw new Error("Cannot close while a command is running; cancel and await it first.");
    this.db.close();
  }

  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  archive(value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    const id = hash(bytes);
    const file = path.join(this.objects, id);
    if (!existsSync(file)) writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
    else if (lstatSync(file).isSymbolicLink() || digestFile(file) !== id) throw new Error("Evidence archive integrity failure.");
    return id;
  }

  archiveFile(file) {
    const temp = path.join(this.objects, `${randomUUID()}.tmp`);
    copyFileSync(file, temp);
    chmodSync(temp, 0o600);
    const id = digestFile(temp);
    const target = path.join(this.objects, id);
    if (existsSync(target)) {
      if (lstatSync(target).isSymbolicLink() || digestFile(target) !== id) throw new Error("Evidence archive integrity failure.");
      unlinkSync(temp);
    } else renameSync(temp, target);
    return id;
  }

  read(id, { offset = 0, limit = 12000 } = {}) {
    if (typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id)) throw new Error("Invalid evidence reference.");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 4 || limit > 24000) throw new Error("Invalid byte range.");
    const file = path.join(this.objects, id);
    const before = stamp(file);
    if (lstatSync(file).isSymbolicLink()) throw new Error("Evidence archive integrity failure.");
    if (this.checkedObjects.get(id) !== before) {
      if (digestFile(file) !== id || stamp(file) !== before) throw new Error("Evidence archive integrity failure.");
      this.checkedObjects.set(id, before);
    }
    const fd = openSync(file, "r");
    const size = statSync(file).size;
    if (offset > size) { closeSync(fd); throw new Error("Offset exceeds evidence size."); }
    const bytes = Buffer.alloc(Math.min(limit, size - offset));
    try { readSync(fd, bytes, 0, bytes.length, offset); } finally { closeSync(fd); }
    if (stamp(file) !== before) throw new Error("Evidence changed during read.");
    let part = bytes;
    let content = bytes.length === 0 ? "" : undefined;
    let encoding = "utf8";
    for (let trim = 0; trim <= Math.min(3, bytes.length - 1); trim++) {
      try {
        part = bytes.subarray(0, bytes.length - trim);
        content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(part);
        break;
      } catch { /* preserve complete UTF-8 code points at the boundary */ }
    }
    if (content === undefined) { part = bytes; content = part.toString("base64"); encoding = "base64"; }
    const next = offset + part.length;
    return { id, offset, bytes: part.length, total: size, next_offset: next < size ? next : null, encoding, content };
  }

  objectJSON(id) {
    if (typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id)) throw new Error("Invalid evidence reference.");
    const file = path.join(this.objects, id);
    if (lstatSync(file).isSymbolicLink()) throw new Error("Evidence archive integrity failure.");
    const bytes = readFileSync(file);
    if (hash(bytes) !== id) throw new Error("Evidence archive integrity failure.");
    return JSON.parse(bytes);
  }

  normalizeSteps(steps, project) {
    if (!Array.isArray(steps) || !steps.length || steps.length > 256) throw new Error("Plan requires 1..256 steps.");
    const ids = new Set();
    return steps.map((step) => {
      fields(step, ["id", "title", "kind", "acceptance", "argv", "timeout_ms", "checks", "artifacts", "bind", "workflow_binding"], "step");
      const id = text(step.id, "Step id", 64);
      if (ids.has(id)) throw new Error("Step ids must be unique.");
      ids.add(id);
      const kind = step.kind ?? "model";
      if (!["model", "command"].includes(kind)) throw new Error("Invalid step kind.");
      const checks = step.checks ?? [];
      const artifacts = step.artifacts ?? [];
      const bind = step.bind ?? [];
      if (![checks, artifacts, bind].every((v) => Array.isArray(v) && v.length <= 32)) throw new Error("Invalid checks, artifacts, or bindings.");
      artifacts.forEach((name) => {
        text(name, "Artifact", 4096);
        if (!inside(project, path.resolve(project, name))) throw new Error("Artifact escapes project.");
      });
      if (kind === "model" && !checks.length && !artifacts.length) throw new Error("A model step requires checks or evidence artifacts.");
      if (kind === "model" && (step.argv !== undefined || step.timeout_ms !== undefined)) throw new Error("Model steps cannot specify an execution argv.");
      return {
        id, title: text(step.title ?? (kind === "command" ? id : undefined), "Step title", 600), kind,
        acceptance: text(step.acceptance ?? (kind === "command" ? "Declared command succeeds without interruption." : undefined), "Acceptance criterion", 2000),
        command: kind === "command" ? command({ argv: step.argv, timeout_ms: step.timeout_ms }, project) : null,
        workflow_binding: step.workflow_binding ?? null,
        checks: checks.map((check) => command(check, project)), artifacts,
        bindings: bind.map((name) => {
          const file = scopedFile(project, name);
          return { name, sha256: qualifiedFileDigest(this, file, this.evidenceCounters) };
        }), status: "pending", receipt: null,
      };
    });
  }

  get(args) {
    const row = this.db.prepare("SELECT * FROM goals WHERE id=?").get(text(args.goal, "Goal", 80));
    const project = realpathSync(text(args.project, "Project", 4096));
    if (!row || row.project !== project || row.session !== text(args.session, "Session/task scope", 200)) throw new Error("Goal does not belong to this project and session.");
    return row;
  }

  view(row, extra = {}) {
    const steps = JSON.parse(row.plan);
    const step = steps[row.cursor];
    return {
      goal: row.id, revision: row.revision, state: row.state, progress: `${row.cursor}/${steps.length}`,
      busy: Boolean(row.operation_key),
      next: step && row.state !== "stopped" ? { id: step.id, kind: step.kind, title: step.title, acceptance: step.acceptance, status: step.status } : null,
      ...(row.note ? { note: row.note } : {}), ...extra,
    };
  }

  plan(args) {
    const project = realpathSync(text(args.project, "Project", 4096));
    if (!statSync(project).isDirectory()) throw new Error("Project must be a directory.");
    const session = text(args.session, "Explicit session/task scope", 200);
    const objective = text(args.objective, "Objective", 4000);
    const key = text(args.request_id, "Request id", 128);
    const id = `g_${hash(JSON.stringify([project, session, key])).slice(0, 24)}`;
    const fingerprint = hash(canonical(args));
    return this.transaction(() => {
      const prior = this.db.prepare("SELECT * FROM requests WHERE goal=? AND key=?").get(id, key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error("Request id was already used with different arguments.");
        return this.view(this.db.prepare("SELECT * FROM goals WHERE id=?").get(id), { replayed: true });
      }
      if (this.db.prepare("SELECT id FROM goals WHERE project=? AND session=? AND state NOT IN ('done','stopped')").get(project, session)) throw new Error("This scope already has a goal. Steer it or choose an explicit new scope.");
      const steps = this.normalizeSteps(args.steps, project);
      this.db.prepare("INSERT INTO goals VALUES(?,?,?,?,1,'active',0,?,NULL,NULL,NULL,NULL)").run(id, project, session, objective, JSON.stringify(steps));
      const receipt = this.archive({ kind: "plan", goal: id, objective, project, session, steps, semantic_success: null });
      this.db.prepare("INSERT INTO events(goal,revision,kind,receipt) VALUES(?,1,'plan',?)").run(id, receipt);
      this.db.prepare("INSERT INTO requests VALUES(?,?,?,?)").run(id, key, fingerprint, receipt);
      return this.view(this.db.prepare("SELECT * FROM goals WHERE id=?").get(id), { receipt });
    });
  }

  verifyBindings(row, step) {
    if (step.workflow_binding) {
      const contract = verifyWorkflowBinding(this, step.workflow_binding, row.project, this.evidenceCounters);
      const spec = contract.steps.find((candidate) => candidate.id === step.id);
      if (!spec) throw new Error("Step is absent from bound workflow.");
      const expected = this.normalizeSteps([spec], row.project)[0];
      const execution = ({ status, receipt, workflow_binding, ...rest }) => rest;
      if (canonical(execution(expected)) !== canonical(execution(step))) throw new Error("Step differs from bound workflow contract.");
    }
    for (const binding of step.bindings) {
      if (qualifiedFileDigest(this, scopedFile(row.project, binding.name), this.evidenceCounters) !== binding.sha256) throw new Error(`Bound input changed: ${binding.name}. Replan explicitly.`);
    }
    for (const cmd of [step.command, ...step.checks].filter(Boolean)) {
      if (stamp(cmd.argv[0]) !== cmd.executable_stamp) throw new Error("Bound executable identity changed; replan explicitly.");
    }
  }

  async runCommand(cmd, row, signal) {
    if (signal?.aborted) {
      const empty = this.archive(Buffer.alloc(0));
      const output = { argv: cmd.argv, exit_code: null, signal: null, failure: "interrupted", stdout: empty, stderr: empty };
      output.compact_receipt = createCompactReceipt(this, output, this.evidenceCounters);
      return output;
    }
    const logs = ["stdout", "stderr"].map((name) => path.join(this.objects, `${randomUUID()}-${name}.tmp`));
    const fds = logs.map((file) => openSync(file, "wx", 0o600));
    const invocation = process.platform === "win32"
      ? windowsJobProcessInvocation(cmd.argv[0], cmd.argv.slice(1), { environment: process.env, windowsHide: true })
      : { command: cmd.argv[0], args: cmd.argv.slice(1) };
    let result;
    try {
      result = await new Promise((resolve, reject) => {
        const child = spawn(invocation.command, invocation.args, {
          cwd: row.project, shell: false, detached: process.platform !== "win32",
          windowsHide: true, stdio: ["ignore", ...fds],
        });
        child.once("spawn", () => {
          try {
            const started = this.archive({ kind: "command_started", operation: row.operation_key, pid: child.pid,
              identity: processStartIdentity(child.pid) ?? null, logs: logs.map((file) => path.basename(file)), argv: cmd.argv });
            this.db.prepare("INSERT INTO events(goal,revision,kind,receipt) VALUES(?,?,'command_started',?)")
              .run(row.id, row.revision, started);
          } catch (error) { stop(`Command journal failed: ${error.message}`); }
        });
        let reason;
        let cleanup;
        const stop = (why) => {
          if (cleanup) return;
          reason = why;
          cleanup = terminateProcessTree(child).catch((error) => { reason = `${why}; cleanup: ${error.message}`; });
        };
        const timer = setTimeout(() => stop("timeout"), cmd.timeout_ms);
        const abort = () => stop("interrupted");
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        child.once("error", reject);
        child.once("close", async (code, killedBy) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          if (cleanup) await cleanup;
          else {
            try { await terminateProcessTree(child); }
            catch (error) { reason = `Process cleanup failed: ${error.message}`; }
          }
          resolve({ exit_code: code, signal: killedBy, failure: reason ?? null });
        });
      });
    } catch (error) { result = { exit_code: null, failure: error.message }; }
    finally { fds.forEach(closeSync); }
    const output = { argv: cmd.argv, ...result, stdout: this.archiveFile(logs[0]), stderr: this.archiveFile(logs[1]) };
    logs.forEach(unlinkSync);
    output.compact_receipt = createCompactReceipt(this, output, this.evidenceCounters);
    return output;
  }

  async execute(row, step, review, signal) {
    const outputs = [];
    const artifacts = [];
    let failure;
    const controller = new AbortController();
    this.running.set(row.id, controller);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const monitor = setInterval(() => {
      const current = this.db.prepare("SELECT state FROM goals WHERE id=?").get(row.id);
      if (current.state !== "running") controller.abort();
    }, 100);
    try {
      this.verifyBindings(row, step);
      for (const cmd of [step.command, ...step.checks].filter(Boolean)) {
        controller.signal.throwIfAborted();
        this.verifyBindings(row, step);
        const output = await this.runCommand(cmd, row, controller.signal);
        outputs.push(output);
        if (output.exit_code !== 0 || output.failure) throw new Error(output.failure ?? `Command exited ${output.exit_code}.`);
      }
      controller.signal.throwIfAborted();
      for (const name of step.artifacts) {
        const file = scopedFile(row.project, name);
        const before = stamp(file);
        const receipt = this.archiveFile(file);
        if (stamp(file) !== before || digestFile(file) !== receipt) throw new Error("Artifact changed during capture.");
        artifacts.push({ name, receipt });
      }
      this.verifyBindings(row, step);
    } catch (error) { failure = error.message; }
    finally {
      clearInterval(monitor);
      signal?.removeEventListener("abort", abort);
      this.running.delete(row.id);
    }
    const receipt = this.archive({ kind: "step", goal: row.id, step: step.id, acceptance: step.acceptance,
      bindings: step.bindings, workflow_binding: step.workflow_binding ?? null,
      review: review ?? null, mechanical_success: !failure, semantic_success: null,
      outputs, artifacts, failure: failure ?? null });
    return this.transaction(() => {
      const current = this.db.prepare("SELECT * FROM goals WHERE id=?").get(row.id);
      const steps = JSON.parse(current.plan);
      const accepted = !failure && current.state === "running";
      steps[current.cursor].status = accepted ? "done" : "blocked";
      steps[current.cursor].receipt = receipt;
      const cursor = current.cursor + (accepted ? 1 : 0);
      const state = ["paused", "stopped"].includes(current.state) ? current.state
        : accepted ? cursor === steps.length ? "done" : "active" : "blocked";
      this.db.prepare("UPDATE goals SET revision=revision+1,state=?,cursor=?,plan=?,note=? WHERE id=?")
        .run(state, cursor, JSON.stringify(steps), accepted ? null : failure ?? "Interrupted by steering; completion was not accepted.", row.id);
      this.db.prepare("INSERT INTO events(goal,revision,kind,receipt) VALUES(?,?,?,?)")
        .run(row.id, current.revision + 1, accepted ? "accepted" : "blocked", receipt);
      return { accepted, receipt, compact: outputs.map((output) => output.compact_receipt).filter(Boolean) };
    });
  }

  async advance(args, signal) {
    const key = text(args.request_id, "Request id", 128);
    const fingerprint = hash(canonical(args));
    const first = this.transaction(() => {
      const row = this.get(args);
      const prior = this.db.prepare("SELECT * FROM requests WHERE goal=? AND key=?").get(row.id, key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error("Request id was already used with different arguments.");
        return { replay: this.view(row, { replayed: true }) };
      }
      if (row.revision !== args.revision) throw new Error("Stale revision; read status before acting.");
      if (row.operation_key) throw new Error("Another operation owns this goal; read status.");
      if (row.state !== "active") throw new Error(`Goal is ${row.state}; it cannot advance.`);
      const step = JSON.parse(row.plan)[row.cursor];
      if (args.action === "checkpoint") {
        if (step.kind !== "model" || step.id !== args.step) throw new Error("Checkpoint must address the current model step.");
        text(args.review, "Model review against the acceptance criterion", 2000);
      }
      this.db.prepare("INSERT INTO requests VALUES(?,?,?,NULL)").run(row.id, key, fingerprint);
      this.db.prepare("UPDATE goals SET operation_key=?,owner_pid=?,owner_identity=? WHERE id=?")
        .run(key, process.pid, this.ownerIdentity ?? null, row.id);
      return { row };
    });
    if (first.replay) return first.replay;
    const receipts = [];
    const compact = [];
    try {
      for (let index = 0; index < this.batchSize; index++) {
        let row = this.get(args);
        if (row.state !== "active" || signal?.aborted) break;
        const step = JSON.parse(row.plan)[row.cursor];
        if (step.kind === "model" && !(index === 0 && args.action === "checkpoint")) break;
        this.transaction(() => {
          row = this.get(args);
          if (row.state !== "active" || row.operation_key !== key) throw new Error("Goal was steered before execution.");
          this.db.prepare("UPDATE goals SET state='running',revision=revision+1 WHERE id=?").run(row.id);
        });
        row = this.get(args);
        const result = await this.execute(row, step, index === 0 ? args.review : undefined, signal);
        receipts.push(result.receipt);
        compact.push(...result.compact);
        if (!result.accepted) break;
      }
    } catch (error) {
      // A storage or runtime exception leaves an uncertain attempt, never a
      // reusable success or an implicitly replayable command.
      this.db.prepare("UPDATE goals SET state=CASE WHEN state IN ('paused','stopped') THEN state ELSE 'blocked' END,revision=revision+1,note=? WHERE id=?")
        .run(`Attempt interrupted: ${error.message}. Inspect before retry.`, first.row.id);
      throw error;
    } finally {
      this.transaction(() => {
        const row = this.get(args);
        if (signal?.aborted && row.state === "active") this.db.prepare("UPDATE goals SET state='blocked',revision=revision+1,note='Request cancelled; explicit retry required.' WHERE id=?").run(row.id);
        this.db.prepare("UPDATE goals SET operation_key=NULL,owner_pid=NULL,owner_identity=NULL WHERE id=? AND operation_key=?").run(row.id, key);
        this.db.prepare("UPDATE requests SET result=? WHERE goal=? AND key=?").run(JSON.stringify(receipts), row.id, key);
      });
    }
    // Keep the response bounded; all omitted projections remain recoverable by receipt.
    const summaries = []; let remaining = 6000;
    for (const id of compact) {
      const summary = compactReceiptText(this, id, { budget: Math.min(1500, remaining), counters: this.evidenceCounters, include_previews: false });
      const bytes = Buffer.byteLength(summary);
      if (bytes > remaining) break;
      summaries.push(summary); remaining -= bytes;
      if (remaining < 512) break;
    }
    return this.view(this.get(args), { attempt_count: receipts.length, receipts, summaries, omitted_summaries: compact.length - summaries.length });
  }

  steer(args) {
    const key = text(args.request_id, "Request id", 128);
    const fingerprint = hash(canonical(args));
    return this.transaction(() => {
      const row = this.get(args);
      const prior = this.db.prepare("SELECT * FROM requests WHERE goal=? AND key=?").get(row.id, key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error("Request id was already used with different arguments.");
        return this.view(row, { replayed: true });
      }
      if (row.revision !== args.revision) throw new Error("Stale revision; read status before steering.");
      if (terminal.has(row.state)) throw new Error("Terminal goals cannot be revived; create a new explicitly authorized goal.");
      const op = args.operation;
      if (!["pause", "stop", "resume", "retry", "replan", "recover"].includes(op)) throw new Error("Invalid steering operation.");
      if (row.operation_key && !["pause", "stop", "recover"].includes(op)) throw new Error("Wait for the owned operation to finish before resuming or replanning.");
      let state = row.state;
      let plan = row.plan;
      let clearOwner = false;
      let note = null;
      const recoveredLogs = [];
      if (op === "pause") state = "paused";
      if (op === "stop") state = "stopped";
      if (op === "resume") {
        if (row.state !== "paused") throw new Error("Resume requires a paused goal.");
        const step = JSON.parse(plan)[row.cursor];
        state = step?.status === "blocked" ? "blocked" : "active";
      }
      if (op === "retry") {
        if (row.state !== "blocked") throw new Error("Retry requires a blocked goal and explicit review of the previous attempt.");
        text(args.review, "Review of the prior attempt before retry", 2000);
        state = "active";
      }
      if (op === "recover") {
        if (!row.operation_key) throw new Error("No interrupted owner to recover.");
        const probe = processStartIdentityProbe(row.owner_pid);
        if (probe.state !== "absent" && !(probe.state === "alive" && row.owner_identity && probe.identity !== row.owner_identity)) throw new Error("Owner is alive or unverifiable; recovery refused.");
        const commands = this.db.prepare("SELECT receipt FROM events WHERE goal=? AND kind='command_started'").all(row.id)
          .map((event) => this.objectJSON(event.receipt))
          .filter((event) => event.operation === row.operation_key);
        for (const cmd of commands) {
          if (process.platform === "win32") {
            const child = processStartIdentityProbe(cmd.pid);
            if (child.state !== "absent" && !(child.state === "alive" && cmd.identity && child.identity !== cmd.identity)) throw new Error("Interrupted command may still be alive; inspect and stop its verified owner before recovery.");
          } else {
            try { process.kill(-cmd.pid, 0); }
            catch (error) { if (error.code === "ESRCH") continue; }
            throw new Error("Interrupted command process group may still be alive; stop its verified owner before recovery.");
          }
        }
        text(args.review, "Review of interrupted command effects before recovery", 2000);
        for (const cmd of commands) {
          const raw = cmd.logs.map((name) => {
            if (!/^[a-zA-Z0-9-]+\.tmp$/.test(name)) throw new Error("Invalid interrupted log identity.");
            const file = path.join(this.objects, name);
            if (!existsSync(file)) return null;
            const id = this.archiveFile(file);
            unlinkSync(file);
            return id;
          });
          if (raw.some(Boolean)) recoveredLogs.push({ stdout: raw[0], stderr: raw[1], complete: false });
        }
        state = "blocked";
        clearOwner = true;
        note = "Owner exited during execution; outcome unknown. Inspect files and receipts before explicit retry.";
      }
      if (op === "replan") {
        const completed = JSON.parse(plan).slice(0, row.cursor);
        const replacement = this.normalizeSteps(args.steps, row.project);
        if (replacement.some((step) => completed.some((old) => old.id === step.id))) throw new Error("Replacement step ids collide with completed steps.");
        plan = JSON.stringify([...completed, ...replacement]);
        state = "active";
      }
      const receipt = this.archive({ kind: "steer", goal: row.id, operation: op, from_revision: row.revision,
        review: args.review ?? null, replacement: op === "replan" ? JSON.parse(plan) : null, recovered_logs: recoveredLogs, note });
      this.db.prepare("UPDATE goals SET state=?,plan=?,revision=revision+1,note=? WHERE id=?").run(state, plan, note, row.id);
      if (clearOwner) this.db.prepare("UPDATE goals SET operation_key=NULL,owner_pid=NULL,owner_identity=NULL WHERE id=?").run(row.id);
      this.db.prepare("INSERT INTO requests VALUES(?,?,?,?)").run(row.id, key, fingerprint, receipt);
      this.db.prepare("INSERT INTO events(goal,revision,kind,receipt) VALUES(?,?,'steer',?)").run(row.id, row.revision + 1, receipt);
      if (["paused", "stopped"].includes(state)) this.running.get(row.id)?.abort();
      return this.view(this.get(args), { receipt });
    });
  }

  async handle(args, { signal } = {}) {
    fields(args, ["action", "project", "session", "request_id", "goal", "revision", "objective", "steps", "step", "review", "operation"], "goal request");
    if (!allowedActions.has(args.action)) throw new Error(`Invalid goal action. Allowed: ${[...allowedActions].join(", ")}.`);
    if (args.action === "plan") return this.plan(args);
    if (args.action === "advance" || args.action === "checkpoint") return this.advance(args, signal);
    if (args.action === "steer") return this.steer(args);
    const row = this.get(args);
    if (args.action === "inspect") {
      const snapshot = this.archive({ objective: row.objective, steps: JSON.parse(row.plan),
        events: this.db.prepare("SELECT revision,kind,receipt FROM events WHERE goal=? ORDER BY id").all(row.id) });
      return this.view(row, { snapshot });
    }
    return this.view(row);
  }
}

export function goalText(result) {
  const lines = [`${result.goal} r${result.revision} ${result.state} ${result.progress}${result.busy ? " (owned operation in progress)" : ""}`];
  if (result.replayed) lines.push("Already recorded; no command rerun. Showing current state.");
  if (result.next) lines.push(`Next ${result.next.id} [${result.next.kind}]: ${result.next.title}`, `Accept: ${result.next.acceptance}`);
  if (result.note) lines.push(result.note);
  if (result.receipt) lines.push(`Receipt ${result.receipt}`);
  if (result.receipts?.length) lines.push(`Attempt receipts: ${result.receipts.join(" ")}`);
  if (result.summaries?.length) lines.push(...result.summaries);
  if (result.omitted_summaries) lines.push(`${result.omitted_summaries} further projections archived in attempt receipts; inspect relevant receipts before unsupported conclusions.`);
  if (result.snapshot) lines.push(`Plan/evidence snapshot ${result.snapshot}; use context raw to expand only relevant bytes.`);
  if (result.state === "done") lines.push("Declared steps accepted for checked bindings. Reuse these mechanical results; review semantics and write the normal final.");
  return lines.join("\n");
}
