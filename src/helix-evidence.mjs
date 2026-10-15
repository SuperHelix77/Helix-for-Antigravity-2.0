import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseTestReport, compareTestReports, testDeltaText } from "./helix-evidence-delta.mjs";

export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const decoder = () => new TextDecoder("utf8", { fatal: true, ignoreBOM: true });
const reference = (id) => { if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid evidence reference."); return id; };
const same = (a, b) => canonical(a) === canonical(b);
const stamp = (file) => {
  const s = statSync(file, { bigint: true });
  if (!s.isFile() || lstatSync(file).isSymbolicLink()) throw new Error("Regular non-symlink file required.");
  return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode].map(String).join(":");
};
function scoped(project, name) {
  if (typeof name !== "string" || !name || name.includes("\0")) throw new Error("Invalid project path.");
  const requested = path.resolve(project, name);
  if (lstatSync(requested).isSymbolicLink()) throw new Error("Symlink targets are not accepted.");
  const file = realpathSync(requested);
  const relative = path.relative(project, file);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Path escapes project.");
  stamp(file);
  return file;
}
export function fileDigest(file, counters) {
  const before = stamp(file); const fd = openSync(file, "r");
  const h = createHash("sha256"); const buf = Buffer.alloc(65536);
  try { let n; while ((n = readSync(fd, buf, 0, buf.length, null))) { h.update(buf.subarray(0, n)); if (counters) counters.binding_bytes_read += n; } }
  finally { closeSync(fd); }
  if (before !== stamp(file)) throw new Error("File changed during verification.");
  return h.digest("hex");
}
function exactObject(engine, id, counters) {
  const file = path.join(engine.objects, reference(id)); const before = stamp(file);
  const cache = engine.evidenceCache;
  const hit = cache?.objects.get(id);
  if (hit?.identity === before) {
    cache.objects.delete(id); cache.objects.set(id, hit);
    if (counters) counters.evidence_cache_hits++;
    return hit.bytes;
  }
  if (hit) { cache.objects.delete(id); cache.bytes -= hit.bytes.length; }
  const bytes = readFileSync(file);
  if (counters) counters.evidence_bytes_read += bytes.length;
  if (digest(bytes) !== id || before !== stamp(file)) throw new Error("Evidence archive integrity failure.");
  if (cache?.limit && bytes.length <= cache.limit) {
    while (cache.bytes + bytes.length > cache.limit && cache.objects.size) {
      const oldest = cache.objects.keys().next().value;
      cache.bytes -= cache.objects.get(oldest).bytes.length; cache.objects.delete(oldest);
    }
    cache.objects.set(id, { identity: before, bytes }); cache.bytes += bytes.length;
  }
  return bytes;
}
export function qualifiedFileDigest(engine, file, counters) {
  // Reuse only a content hash qualified in this process while inode/ctime/etc.
  // are unchanged. A restart always performs a fresh full hash.
  engine.workflowHashes ??= new Map();
  const identity = stamp(file); const previous = engine.workflowHashes.get(file);
  if (previous?.identity === identity) {
    engine.workflowHashes.delete(file); engine.workflowHashes.set(file, previous);
    if (counters) counters.binding_cache_hits++; return previous.sha256;
  }
  const sha256 = fileDigest(file, counters);
  engine.workflowHashes.set(file, { identity, sha256 });
  if (engine.workflowHashes.size > 512) engine.workflowHashes.delete(engine.workflowHashes.keys().next().value);
  return sha256;
}
const jsonObject = (engine, id, counters) => JSON.parse(exactObject(engine, id, counters));
const encode = (bytes) => {
  try { return { encoding: "utf8", content: decoder().decode(bytes) }; }
  catch { return { encoding: "base64", content: bytes.toString("base64") }; }
};

// Projection candidates are observations of the log, not proof that the task passed.
function projectLog(bytes) {
  const lines = bytes.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const report = parseTestReport(bytes);
  if (report) {
    const counts = [{kind:"helix.tests",label:"tests",value:report.tests.length,line:1},
      ...["pass", "fail", "error", "skip"].map(label => ({kind:"helix.tests",label,value:report.tests.filter(test => test.status === label).length,line:1}))];
    const diagnostics = report.tests.flatMap((test, i) => ["fail", "error"].includes(test.status) && test.traceback
      ? [{line:1,json_path:`/tests/${i}/traceback`,text:`${test.id}: ${test.traceback.length > 400 ? test.traceback.slice(0,200)+"\n[... omitted ...]\n"+test.traceback.slice(-200) : test.traceback}`,shortened:test.traceback.length > 400}] : []);
    return {bytes:bytes.length,lines:lines.length,counts,omitted_counts:0,evidence:diagnostics.slice(0,8),omitted_evidence:Math.max(0,diagnostics.length-8),partial:true};
  }
  const counts = []; const evidence = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const tap = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\r?$/.exec(line);
    if (tap) counts.push({ kind: "tap", label: tap[1], value: Number(tap[2]), line: i + 1 });
    const pytest = /(?:^|[, =])(\d+) (passed|failed|skipped|error[s]?|xfailed|xpassed)(?=[, =]|$)/g;
    if (/=+.*\d+ (?:passed|failed|skipped|errors?).*=+/.test(line)) {
      for (const match of line.matchAll(pytest)) counts.push({ kind: "pytest", label: match[2], value: Number(match[1]), line: i + 1 });
    }
    if (/^not ok\b|^FAILED\b|\b(?:error|warning)(?:\[|:)|^Traceback\b/i.test(line) || i < 2 || i === lines.length - 1) {
      evidence.push({ line: i + 1, text: line.slice(0, 400), shortened: line.length > 400 });
    }
  }
  return { bytes: bytes.length, lines: lines.length, counts: counts.slice(0, 32), omitted_counts: Math.max(0, counts.length - 32),
    evidence: evidence.slice(0, 8), omitted_evidence: Math.max(0, evidence.length - 8), partial: true };
}

// Verify source bindings and each selected statement independently of projection construction.
export function verifyCompactReceipt(engine, packet, counters) {
  if (packet?.schema !== "helix.compact.v1" || packet.semantic_success !== null || packet.partial !== true) throw new Error("Invalid compact receipt contract.");
  const source = jsonObject(engine, packet.source, counters);
  if (source.kind !== "command_output" || !same(packet.execution, { exit_code: source.exit_code, signal: source.signal ?? null, failure: source.failure ?? null })) throw new Error("Execution projection mismatch.");
  for (const channel of ["stdout", "stderr"]) {
    if (packet[channel].raw !== source[channel]) throw new Error("Raw source mismatch.");
    const bytes = exactObject(engine, source[channel], counters);
    const p = packet[channel]; const text = bytes.toString("utf8");
    const lines = text.split("\n"); if (lines.at(-1) === "") lines.pop();
    if (p.bytes !== bytes.length || p.lines !== lines.length || p.partial !== true) throw new Error("Size projection mismatch.");
    const structured = parseTestReport(bytes);
    // Older receipts used ordinary literal-line previews even for structured
    // reports. Verify that historical representation instead of invalidating it.
    if (structured && p.counts.some(count => count.kind === "helix.tests")) {
      const expected = [{kind:"helix.tests",label:"tests",value:structured.tests.length,line:1}];
      for (const status of ["pass", "fail", "error", "skip"]) {
        let count = 0;
        for (const entry of structured.tests) if (entry.status === status) count++;
        expected.push({kind:"helix.tests",label:status,value:count,line:1});
      }
      const diagnostics = [];
      structured.tests.forEach((entry, i) => {
        if (!["fail", "error"].includes(entry.status) || !entry.traceback) return;
        const shortened = entry.traceback.length > 400;
        const excerpt = shortened ? `${entry.traceback.substring(0,200)}\n[... omitted ...]\n${entry.traceback.substring(entry.traceback.length-200)}` : entry.traceback;
        diagnostics.push({line:1,json_path:`/tests/${i}/traceback`,text:`${entry.id}: ${excerpt}`,shortened});
      });
      if (!same(p.counts, expected) || p.omitted_counts !== 0 || !same(p.evidence, diagnostics.slice(0,8)) || p.omitted_evidence !== Math.max(0,diagnostics.length-8))
        throw new Error("Structured source projection mismatch.");
      continue;
    }
    // Recount every eligible summary and selected diagnostic in source order.
    const expectedCounts = []; const expectedEvidence = [];
    lines.forEach((line, i) => {
      if (line.startsWith("# ")) {
        const parts = line.replace(/\r$/, "").split(" ");
        if (parts.length === 3 && ["tests", "pass", "fail", "cancelled", "skipped", "todo"].includes(parts[1]) && /^\d+$/.test(parts[2])) expectedCounts.push({ kind: "tap", label: parts[1], value: Number(parts[2]), line: i + 1 });
      }
      if (/=+.*\d+ (?:passed|failed|skipped|errors?).*=+/.test(line)) {
        for (const m of line.matchAll(/(?:^|[, =])(\d+) (passed|failed|skipped|error[s]?|xfailed|xpassed)(?=[, =]|$)/g)) expectedCounts.push({ kind: "pytest", label: m[2], value: Number(m[1]), line: i + 1 });
      }
      if (i < 2 || i === lines.length - 1 || /^not ok\b|^FAILED\b|\b(?:error|warning)(?:\[|:)|^Traceback\b/i.test(line)) expectedEvidence.push({ line: i + 1, text: line.slice(0, 400), shortened: line.length > 400 });
    });
    if (!same(p.counts, expectedCounts.slice(0, 32)) || p.omitted_counts !== Math.max(0, expectedCounts.length - 32)
      || !same(p.evidence, expectedEvidence.slice(0, 8)) || p.omitted_evidence !== Math.max(0, expectedEvidence.length - 8)) throw new Error("Source projection mismatch.");
  }
  return true;
}

export function createCompactReceipt(engine, output, counters) {
  const source = engine.archive({ kind: "command_output", ...output });
  const packet = { schema: "helix.compact.v1", source, partial: true, semantic_success: null,
    execution: { exit_code: output.exit_code, signal: output.signal ?? null, failure: output.failure ?? null } };
  for (const channel of ["stdout", "stderr"]) packet[channel] = { raw: output[channel], ...projectLog(exactObject(engine, output[channel], counters)) };
  const refs = [source, output.stdout, output.stderr];
  const identities = refs.map((id) => stamp(path.join(engine.objects, id)));
  verifyCompactReceipt(engine, packet, counters);
  const id = engine.archive(packet);
  if (!same(identities, refs.map((ref) => stamp(path.join(engine.objects, ref))))) throw new Error("Evidence changed during receipt publication.");
  const cache = engine.evidenceCache?.receipts;
  if (cache) { cache.set(id, [stamp(path.join(engine.objects, id)), ...identities]); if (cache.size > 256) cache.delete(cache.keys().next().value); }
  return id;
}

function checkedReceipt(engine, id, counters) {
  const packet = jsonObject(engine, id, counters);
  const source = jsonObject(engine, packet.source, counters);
  const dependencies = [id, packet.source, source.stdout, source.stderr];
  const identities = dependencies.map((ref) => stamp(path.join(engine.objects, reference(ref))));
  const cache = engine.evidenceCache?.receipts;
  const prior = cache?.get(id);
  if (prior && same(prior, identities)) {
    cache.delete(id); cache.set(id, prior);
    if (counters) counters.receipt_verification_cache_hits++;
  } else {
    verifyCompactReceipt(engine, packet, counters);
    if (!same(identities, dependencies.map((ref) => stamp(path.join(engine.objects, ref))))) throw new Error("Evidence changed during receipt verification.");
    if (cache) { cache.set(id, identities); if (cache.size > 256) cache.delete(cache.keys().next().value); }
  }
  return packet;
}

export function compactReceiptText(engine, id, { budget = 3000, counters, include_previews = true } = {}) {
  if (!Number.isSafeInteger(budget) || budget < 512 || budget > 24000) throw new Error("Receipt budget must be 512..24000 bytes.");
  const packet = checkedReceipt(engine, id, counters);
  const lines = [`Verified receipt ${id}; partial log projection, semantic result unknown.`,
    `Exit ${packet.execution.exit_code}; signal ${packet.execution.signal ?? "none"}; failure ${packet.execution.failure ?? "none"}`];
  const mandatory = [...lines], diagnostics = [];
  for (const channel of ["stdout", "stderr"]) {
    const p = packet[channel];
    lines.push(`${channel}: ${p.bytes} bytes, ${p.lines} lines; raw ${p.raw}`);
    mandatory.push(lines.at(-1));
    for (const count of p.counts) { lines.push(`${channel}:${count.line} ${count.kind} ${count.label}=${count.value}`); mandatory.push(lines.at(-1)); }
    for (const e of p.evidence) {
      const failedStderrBoundary=channel==="stderr"&&(packet.execution.exit_code!==0||packet.execution.signal||packet.execution.failure)&&(e.line<=2||e.line===p.lines);
      const structuredFailure=channel==="stdout"&&packet.execution.exit_code===1&&/^\/tests\/\d+\/traceback$/.test(e.json_path??"");
      if (include_previews || failedStderrBoundary || structuredFailure || /^not ok\b|^FAILED\b|\b(?:error|warning)(?:\[|:)|^Traceback\b|\b\w*(?:Error|Exception):/i.test(e.text)) {
        lines.push(`${channel}:${e.line} ${e.text}${e.shortened ? " [preview shortened]" : ""}`);
        diagnostics.push({text:lines.at(-1),priority:structuredFailure?0:failedStderrBoundary?1:2});
      }
    }
    if (p.omitted_counts || p.omitted_evidence) { lines.push(`Not shown: ${p.omitted_counts} summary candidates, ${p.omitted_evidence} evidence candidates.`); mandatory.push(lines.at(-1)); }
  }
  const suffix = "Reuse these archived facts; live files unbound. Exact logs: context raw {receipt: RAW_HASH}.";
  const full = [...lines, suffix].join("\n");
  if (Buffer.byteLength(full) <= budget) return full;
  // Keep exit/counts/recovery handles before spending the remaining budget on
  // whole excerpts. Never manufacture savings by losing the entire summary.
  const selected = [];
  const footer = count => `Budget omitted ${count} selected diagnostics; exact originals remain available.`;
  if (Buffer.byteLength([...mandatory,footer(diagnostics.length),suffix].join("\n")) <= budget) {
    for (const candidate of diagnostics.sort((a,b)=>a.priority-b.priority)) {
      if (Buffer.byteLength([...mandatory,...selected,candidate.text,footer(diagnostics.length-selected.length-1),suffix].join("\n")) <= budget) selected.push(candidate.text);
    }
    return [...mandatory,...selected,footer(diagnostics.length-selected.length),suffix].join("\n");
  }
  const minimal = `Verified receipt ${id}; projection exceeds budget. Exit ${packet.execution.exit_code}; semantic result unknown. Counts/diagnostics omitted. Exact stdout ${packet.stdout.raw}; stderr ${packet.stderr.raw}. Use context raw or a larger receipt budget.`;
  return minimal;
}

export function verifyWorkflowBinding(engine, id, project, counters) {
  project = realpathSync(project);
  const binding = jsonObject(engine, id, counters);
  if (binding.schema !== "helix.workflow.v1" || binding.project !== realpathSync(project)) throw new Error("Workflow scope mismatch.");
  for (const b of binding.files) if (qualifiedFileDigest(engine, scoped(project, b.name), counters) !== b.sha256) throw new Error(`Workflow input changed: ${b.name}. Register a new version explicitly.`);
  for (const b of binding.executables) if (qualifiedFileDigest(engine, b.file, counters) !== b.sha256) throw new Error("Workflow executable changed.");
  for (const b of binding.runtime) if (qualifiedFileDigest(engine, b.file, counters) !== b.sha256) throw new Error("Workflow runtime changed.");
  if (digest(canonical(process.env)) !== binding.environment_sha256) throw new Error("Workflow environment changed; register a new version.");
  return binding;
}

export class HelixEvidence {
  constructor(engine, { cacheBytes = 8 * 1024 * 1024 } = {}) {
    if (!Number.isSafeInteger(cacheBytes) || cacheBytes < 0 || cacheBytes > 64 * 1024 * 1024) throw new Error("Evidence cache must be 0..64 MiB.");
    this.engine = engine;
    engine.evidenceCache = { limit: cacheBytes, bytes: 0, objects: new Map(), receipts: cacheBytes ? new Map() : undefined };
    this.counters = { binding_bytes_read: 0, binding_cache_hits: 0, evidence_bytes_read: 0, evidence_cache_hits: 0, receipt_verification_cache_hits: 0 };
    engine.evidenceCounters = this.counters;
    engine.db.exec(`CREATE TABLE IF NOT EXISTS helix_workflows(project TEXT,name TEXT,version TEXT,receipt TEXT NOT NULL,PRIMARY KEY(project,name,version));
      CREATE TABLE IF NOT EXISTS helix_indexes(source TEXT PRIMARY KEY,receipt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS helix_edits(project TEXT,request TEXT,fingerprint TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(project,request));`);
  }

  attest({ receipt, project, session }) {
    const r = jsonObject(this.engine, receipt, this.counters);
    if (r.kind !== "step" || !Array.isArray(r.bindings) || !Array.isArray(r.artifacts)) throw new Error("Receipt lacks input bindings; use it as historical evidence only.");
    this.engine.get({ goal: r.goal, project, session });
    const event = this.engine.db.prepare("SELECT kind FROM events WHERE goal=? AND receipt=? AND kind IN ('accepted','blocked') ORDER BY id LIMIT 1").get(r.goal, receipt);
    if (!event) throw new Error("Receipt is not a recorded engine attempt.");
    if (event.kind === "accepted" && r.mechanical_success !== true) throw new Error("Receipt conflicts with recorded acceptance.");
    project = realpathSync(project);
    let inputCount = r.bindings.length;
    if (r.workflow_binding) inputCount += verifyWorkflowBinding(this.engine, r.workflow_binding, project, this.counters).files.length;
    for (const binding of r.bindings) if (qualifiedFileDigest(this.engine, scoped(project, binding.name), this.counters) !== binding.sha256) throw new Error(`Attestation stale: input ${binding.name} changed.`);
    for (const artifact of r.artifacts) if (qualifiedFileDigest(this.engine, scoped(project, artifact.name), this.counters) !== artifact.receipt) throw new Error(`Attestation stale: artifact ${artifact.name} changed.`);
    const projections = r.outputs.map((o) => o.compact_receipt).filter(Boolean);
    for (const id of projections) checkedReceipt(this.engine, id, this.counters);
    const scope = inputCount || r.artifacts.length ? "declared files match now" : "no declared files; historical execution only";
    return `Verified ${receipt}: ${scope}; ${inputCount} input bindings, ${r.artifacts.length} artifacts. Attempt mechanical result: ${r.mechanical_success ? "PASS" : "FAIL"}; goal acceptance: ${event.kind}. Reuse the recorded mechanical facts within this scope; no duplicate checks solely for reassurance. Undeclared dependencies and semantic correctness remain unverified.`;
  }

  register({ project, name, version, steps, bind = [] }) {
    project = realpathSync(project);
    if (![name, version].every((v) => typeof v === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(v))) throw new Error("Workflow name/version must be explicit short identifiers.");
    if (!Array.isArray(bind) || bind.length > 128) throw new Error("Invalid workflow bindings.");
    const normalized = this.engine.normalizeSteps(steps, project);
    if (normalized.some((s) => s.kind !== "command" || s.workflow_binding)) throw new Error("Reusable workflows are predeclared command-only, without nested bindings; model decisions stay outside.");
    const files = [...new Set([...bind, ...steps.flatMap((s) => s.bind ?? [])])].map((name) => ({ name, sha256: qualifiedFileDigest(this.engine, scoped(project, name), this.counters) }));
    const executables = [...new Set(normalized.flatMap((s) => [s.command, ...s.checks].map((c) => c.argv[0])))].map((file) => ({ file, sha256: qualifiedFileDigest(this.engine, file, this.counters) }));
    const runtime = [new URL(import.meta.url), new URL("./helix-goal-engine.mjs", import.meta.url), new URL("./process-tree.mjs", import.meta.url), new URL("./process-identity.mjs", import.meta.url)]
      .map((url) => { const file = realpathSync(url); return { file, sha256: qualifiedFileDigest(this.engine, file, this.counters) }; });
    const contract = { schema: "helix.workflow.v1", project, name, version, steps, files, executables, runtime, environment_sha256: digest(canonical(process.env)), semantic_success: null };
    const receipt = this.engine.archive(Buffer.from(canonical(contract)));
    this.engine.transaction(() => {
      const previous = this.engine.db.prepare("SELECT receipt FROM helix_workflows WHERE project=? AND name=? AND version=?").get(project, name, version);
      if (previous && previous.receipt !== receipt) throw new Error("Workflow version is immutable; use a new version.");
      this.engine.db.prepare("INSERT OR IGNORE INTO helix_workflows VALUES(?,?,?,?)").run(project, name, version, receipt);
    });
    return { workflow: receipt, name, version, steps: steps.length, semantic_success: null };
  }

  async run(args, options) {
    if (typeof args.request_id !== "string" || !args.request_id || args.request_id.length > 120) throw new Error("Workflow run requires request_id (1..120 characters).");
    const binding = verifyWorkflowBinding(this.engine, args.workflow, args.project, this.counters);
    const steps = binding.steps.map((s) => ({ ...s, workflow_binding: args.workflow }));
    const planned = await this.engine.handle({ action: "plan", project: args.project, session: args.session, request_id: `${args.request_id}:plan`, objective: `Run explicitly selected workflow ${binding.name}@${binding.version}`, steps });
    return this.engine.handle({ action: "advance", project: args.project, session: args.session, goal: planned.goal, revision: 1, request_id: `${args.request_id}:run` }, options);
  }

  delta({ before, after }) {
    const packets = [before, after].map(id => checkedReceipt(this.engine, id, this.counters));
    const executions = packets.map(packet => jsonObject(this.engine, packet.source, this.counters));
    const normal = executions.every(output => [0, 1].includes(output.exit_code) && !output.signal && !output.failure);
    const sameInvocation = same(executions[0].argv, executions[1].argv) && Array.isArray(executions[0].argv);
    const reports = packets.map(packet => parseTestReport(exactObject(this.engine, packet.stdout.raw, this.counters)));
    const consistentExit = reports.every((report, i) => report && (report.tests.some(test => ["fail", "error"].includes(test.status)) ? 1 : 0) === executions[i].exit_code);
    const result = !normal || !sameInvocation
      ? { compatible: false, reason: "Interrupted/unknown execution or changed command invocation." }
      : reports.some(report => !report)
        ? { compatible: false, reason: "Incomplete or unsupported structured test report." }
        : !consistentExit
          ? { compatible: false, reason: "Exporter statuses conflict with the recorded command exit." }
          : compareTestReports(...reports);
    const receipt = this.engine.archive({ ...result, before, after, semantic_success: null });
    return { ...result, receipt, text: testDeltaText(result, receipt, before, after) };
  }

  index(source) {
    reference(source);
    const prior = this.engine.db.prepare("SELECT receipt FROM helix_indexes WHERE source=?").get(source);
    if (prior) { const root = jsonObject(this.engine, prior.receipt, this.counters); if (root.source !== source) throw new Error("Index source mismatch."); return { index: prior.receipt, ...root }; }
    const bytes = exactObject(this.engine, source, this.counters);
    const leaves = []; let start = 0; let offsets = [0]; let line = 1;
    const publish = (end) => {
      const raw = bytes.subarray(start, end);
      const leaf = this.engine.archive(raw);
      const meta = this.engine.archive({ schema: "helix.lines.leaf.v1", raw: leaf, offsets, bytes: raw.length });
      leaves.push({ first: line, count: offsets.length - 1, offset: start, bytes: raw.length, leaf: meta });
      line += offsets.length - 1; start = end; offsets = [0];
    };
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 10) { offsets.push(i + 1 - start); if (i + 1 - start >= 65536) publish(i + 1); }
    }
    if (start < bytes.length) { if (offsets.at(-1) !== bytes.length - start) offsets.push(bytes.length - start); publish(bytes.length); }
    const root = { schema: "helix.lines.v1", source, bytes: bytes.length, lines: line - 1, leaves };
    const index = this.engine.archive(root);
    // Reconstruct once at acceptance. Later requests verify only the selected leaves.
    const reconstructed = Buffer.concat(leaves.map((l) => exactObject(this.engine, jsonObject(this.engine, l.leaf, this.counters).raw, this.counters)));
    if (!reconstructed.equals(bytes)) throw new Error("Index reconstruction failed.");
    this.engine.db.prepare("INSERT OR IGNORE INTO helix_indexes VALUES(?,?)").run(source, index);
    return { index, ...root };
  }

  ranges({ index, source, ranges, budget = 24000 }) {
    const root = jsonObject(this.engine, index, this.counters);
    if (root.schema !== "helix.lines.v1" || root.source !== reference(source)) throw new Error("Index source mismatch.");
    if (!Array.isArray(ranges) || !ranges.length || ranges.length > 32 || !Number.isSafeInteger(budget) || budget < 4 || budget > 24000) throw new Error("Invalid range request.");
    const cache = new Map(); let total = 0;
    return ranges.map(({ start, end }) => {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > root.lines) throw new Error("Line range out of bounds.");
      const chunks = [];
      for (const leaf of root.leaves) {
        if (leaf.first > end || leaf.first + leaf.count <= start) continue;
        if (!cache.has(leaf.leaf)) {
          const meta = jsonObject(this.engine, leaf.leaf, this.counters); const raw = exactObject(this.engine, meta.raw, this.counters);
          if (meta.schema !== "helix.lines.leaf.v1" || meta.bytes !== raw.length || meta.offsets.length !== leaf.count + 1 || meta.offsets[0] !== 0 || meta.offsets.at(-1) !== raw.length) throw new Error("Invalid line index leaf.");
          cache.set(leaf.leaf, { meta, raw });
        }
        const { meta, raw } = cache.get(leaf.leaf);
        const from = Math.max(start, leaf.first) - leaf.first; const to = Math.min(end + 1, leaf.first + leaf.count) - leaf.first;
        chunks.push(raw.subarray(meta.offsets[from], meta.offsets[to]));
      }
      const bytes = Buffer.concat(chunks); const encoded = encode(bytes); total += Buffer.byteLength(encoded.content);
      if (total > budget) throw new Error("Ranges exceed output budget; request smaller ranges. No partial range was returned.");
      return { source, start, end, bytes: bytes.length, ...encoded };
    });
  }

  edit({ project, file, expected_sha256, edits, request_id }) {
    project = realpathSync(project); reference(expected_sha256);
    if (typeof request_id !== "string" || !request_id || request_id.length > 128) throw new Error("Explicit edit request_id required.");
    if (!Array.isArray(edits) || !edits.length || edits.length > 128) throw new Error("Specify 1..128 literal edits.");
    const fingerprint = digest(canonical({ file, expected_sha256, edits }));
    const lockDir = path.join(this.engine.directory, "edit-locks"); mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    const target = scoped(project, file); const lock = path.join(lockDir, digest(target));
    const lockFd = openSync(lock, "wx", 0o600); let temp;
    try {
      const old = this.engine.db.prepare("SELECT * FROM helix_edits WHERE project=? AND request=?").get(project, request_id);
      if (old) {
        if (old.fingerprint !== fingerprint) throw new Error("Edit request id conflict.");
        const result = jsonObject(this.engine, old.receipt, this.counters);
        return { ...result, receipt: old.receipt, replayed: true, current_sha256: fileDigest(target, this.counters) };
      }
      const beforeStamp = stamp(target); const source = readFileSync(target);
      decoder().decode(source);
      if (digest(source) !== expected_sha256) throw new Error("Stale edit source; no file changed.");
      const resolved = edits.map((e) => {
        if (!e || Object.keys(e).some((k) => !["old", "new"].includes(k)) || typeof e.old !== "string" || !e.old || typeof e.new !== "string"
          || decoder().decode(Buffer.from(e.old)) !== e.old || decoder().decode(Buffer.from(e.new)) !== e.new) throw new Error("Exact UTF-8 old/new literals required.");
        const needle = Buffer.from(e.old); const offset = source.indexOf(needle);
        if (offset < 0 || source.indexOf(needle, offset + 1) >= 0) throw new Error("Literal match missing or ambiguous; no fuzzy repair.");
        return { offset, end: offset + needle.length, bytes: Buffer.from(e.new) };
      }).sort((a, b) => a.offset - b.offset);
      if (resolved.some((e, i) => i && e.offset < resolved[i - 1].end)) throw new Error("Overlapping edits rejected.");
      const parts = []; let cursor = 0;
      for (const e of resolved) { parts.push(source.subarray(cursor, e.offset), e.bytes); cursor = e.end; }
      parts.push(source.subarray(cursor)); const output = Buffer.concat(parts);
      const before = this.engine.archive(source); const after = this.engine.archive(output);
      const result = { schema: "helix.edit.v1", before, after, edits: edits.length, semantic_success: null };
      const receipt = this.engine.archive(result);
      temp = path.join(path.dirname(target), `.helix-${randomUUID()}.tmp`);
      const fd = openSync(temp, "wx", statSync(target).mode & 0o777);
      try { writeFileSync(fd, output); fsyncSync(fd); } finally { closeSync(fd); }
      if (stamp(target) !== beforeStamp || fileDigest(target, this.counters) !== before || scoped(project, file) !== target) throw new Error("Destination changed before publication.");
      renameSync(temp, target); temp = null;
      if (process.platform !== "win32") { const parent = openSync(path.dirname(target), "r"); try { fsyncSync(parent); } finally { closeSync(parent); } }
      this.engine.db.prepare("INSERT INTO helix_edits VALUES(?,?,?,?)").run(project, request_id, fingerprint, receipt);
      return { ...result, receipt };
    } finally { if (temp && existsSync(temp)) unlinkSync(temp); closeSync(lockFd); unlinkSync(lock); }
  }
}
