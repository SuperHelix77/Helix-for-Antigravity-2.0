import { createHash } from "node:crypto";
import { ageToolResults } from "./tool-result-aging.mjs";

const outputs = new Set(["function_call_output", "custom_tool_call_output"]);
const key = (item, replacement) => createHash("sha256").update(JSON.stringify([item.type, item.call_id, item.output, replacement.output])).digest("hex");
const outputText = (value) => typeof value === "string" ? value : value.map(part => part.text).join("");

// Commit new receipt replacements in batches. Already-committed replacements
// remain byte-stable while their originals and retention proof still qualify.
export class CacheStableAging {
  constructor({ minSavedBytes = 16384, minResults = 8, maxDecisions = 4096 } = {}) {
    for (const v of [minSavedBytes, minResults, maxDecisions]) if (!Number.isSafeInteger(v) || v < 1) throw new Error("Invalid cache-stable aging limit.");
    this.minSavedBytes = minSavedBytes;
    this.minResults = minResults;
    this.maxDecisions = maxDecisions;
    this.decisions = new Map();
  }

  shape(input, options, { force = false } = {}) {
    if (options?.denseShaping) return ageToolResults(input, options);
    if (!Array.isArray(input) || !options?.enabled || typeof options.retainOriginal !== "function") {
      return { input, stats: { cacheStableEnabled: false, cacheStableCommitted: 0, cacheStableDeferred: 0 } };
    }
    // The original pass rechecks the frontier, security evidence, changed
    // outputs, and successful retention. A stale decision cannot bypass it.
    const candidate = ageToolResults(input, options);
    const changes = [];
    input.forEach((item, index) => {
      if (outputs.has(item?.type) && JSON.stringify(item.output) !== JSON.stringify(candidate.input[index].output)) {
        const id = key(item, candidate.input[index]);
        const before = Buffer.byteLength(outputText(item.output));
        const after = Buffer.byteLength(outputText(candidate.input[index].output));
        changes.push({ index, id, item: candidate.input[index], before, after, saved: before - after, existing: this.decisions.has(id) });
      }
    });
    const fresh = changes.filter(c => !c.existing);
    const commit = force || fresh.length >= this.minResults || fresh.reduce((n, c) => n + c.saved, 0) >= this.minSavedBytes;
    const replacements = new Map();
    for (const c of changes) {
      if (!c.existing && !commit) continue;
      replacements.set(c.index, c.item);
      this.decisions.delete(c.id);
      this.decisions.set(c.id, true);
      while (this.decisions.size > this.maxDecisions) this.decisions.delete(this.decisions.keys().next().value);
    }
    const shaped = replacements.size ? input.map((item, index) => replacements.get(index) ?? item) : input;
    const applied = changes.filter(c => replacements.has(c.index));
    const stats = { ...candidate.stats, cacheStableEnabled: true, cacheStableCommitted: commit ? fresh.length : 0,
      cacheStableDeferred: commit ? 0 : fresh.length, cacheStableDecisions: this.decisions.size,
      // Candidate savings are not actual forwarded-payload savings.
      candidateToolResultBytesSaved: candidate.stats.toolResultBytesSaved,
      candidateToolResultsRetained: candidate.stats.toolResultsRetained,
      toolResultBytesBefore: applied.reduce((n, c) => n + c.before, 0),
      toolResultBytesAfter: applied.reduce((n, c) => n + c.after, 0),
      toolResultBytesSaved: applied.reduce((n, c) => n + c.saved, 0),
      toolResultDuplicateBytesSaved: applied.filter(c => c.item.output.startsWith("[Exact duplicate tool result")).reduce((n, c) => n + c.saved, 0),
      toolResultsDeduplicated: applied.filter(c => c.item.output.startsWith("[Exact duplicate tool result")).length,
      toolResultsShaped: 0,
      toolResultShapeBytesSaved: 0,
      toolResultsRetained: applied.length,
      toolResultsAged: applied.length };
    return { input: shaped, stats };
  }
}

// Decisions contain hashes only; a caller/session/model boundary never shares
// them with another request scope. Missing identities use the existing policy.
export class CacheStableAgingSessions {
  constructor({ maxSessions = 128, idleMs = 6 * 60 * 60 * 1000, policy = {}, now = Date.now } = {}) {
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || !Number.isSafeInteger(idleMs) || idleMs < 1) throw new Error("Invalid session aging limit.");
    this.maxSessions = maxSessions;
    this.idleMs = idleMs;
    this.policy = policy;
    this.now = now;
    this.sessions = new Map();
  }

  shape(input, options, { enabled = false, session, caller, model, force = false } = {}) {
    if (!enabled || !options?.enabled || ![session, caller, model].every(v => typeof v === "string" && v.length > 0 && v.length <= 8192)) {
      return ageToolResults(input, options);
    }
    const id = createHash("sha256").update(JSON.stringify([caller, session, model])).digest("hex");
    const now = this.now();
    for (const [name, entry] of this.sessions) if (now - entry.at >= this.idleMs) this.sessions.delete(name);
    const entry = this.sessions.get(id) ?? { policy: new CacheStableAging(this.policy) };
    entry.at = now;
    this.sessions.delete(id);
    this.sessions.set(id, entry);
    while (this.sessions.size > this.maxSessions) this.sessions.delete(this.sessions.keys().next().value);
    return entry.policy.shape(input, options, { force });
  }
}

export function commonPrefixBytes(previous, current) {
  const a = Buffer.from(previous), b = Buffer.from(current);
  let index = 0; while (index < a.length && index < b.length && a[index] === b[index]) index++;
  return index;
}
