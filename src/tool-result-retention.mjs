import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";

import { STATE_DIR } from "./paths.mjs";

// Where compaction parks exact tool-result text before replacing it with a
// receipt. The directory is owner-private and excluded from support bundles.
// The writer and this reader/purger share the same environment override, so
// retention status and cleanup inspect the store the router actually uses.
export const TOOL_RESULT_RETENTION_DIR =
  process.env.MODEL_ROUTER_TOOL_RESULT_RETENTION_DIR ||
  path.join(STATE_DIR, "retained-tool-results");

// Retention is bounded rather than evicting: at either cap the store stops
// accepting new results and eligible results pass through uncompacted. That is
// a safe failure, but it is also permanent until somebody empties the store,
// so it is the one state worth reporting louder than "here is a directory".
export const RETENTION_MAX_FILES = 32_768;
export const RETENTION_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

// The three name shapes retention itself produces. Purge removes nothing else:
// a name the writer could not have produced is somebody else's file that
// happens to sit in this directory, and deleting it is not this command's
// business. These mirror the writer's own validation.
const RESULT_FILE_PATTERN = /^[A-Za-z0-9_-]{43}\.result$/u;
const STAGE_FILE_PATTERN = /^\.[^/\\]+\.stage\.[0-9a-f]{32}$/u;
const RETENTION_KEY_NAME = ".retention-key";

const DAY_MS = 24 * 60 * 60 * 1000;

// How long a retained original is worth keeping, by default.
//
// This is an explicit expiry policy, not an exact-recovery guarantee forever.
// Recovery-dependent writers select ttlMs: 0. Never replay a mutation merely
// because its archived result has expired.
//
// The cap failure the TTL actually fixes: a store parked at its file or byte
// limit stops accepting new results. With a TTL it drains itself a week later
// instead of waiting for somebody to notice.
export const RETENTION_DEFAULT_TTL_DAYS = 7;
export const RETENTION_DEFAULT_TTL_MS = RETENTION_DEFAULT_TTL_DAYS * DAY_MS;

// A stored TTL is the operator's own answer, so it is bounded only where a
// value stops meaning anything: below a day it would expire a store while the
// session that filled it is still running, and ten years is past any disk this
// would be measured on.
export const RETENTION_MIN_TTL_DAYS = 1;
export const RETENTION_MAX_TTL_DAYS = 3_650;

export function retentionTtlDaysFromMs(ttlMs) {
  return Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs / DAY_MS : 0;
}

export function retentionTtlMsFromDays(days) {
  const value = Number(days);
  return Number.isFinite(value) && value > 0 ? value * DAY_MS : 0;
}

export function describeRetentionTtl(ttlMs) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return "off";
  const days = retentionTtlDaysFromMs(ttlMs);
  return Number.isInteger(days) ? `${days}d` : `${days.toFixed(1)}d`;
}

function isRetentionEntry(name) {
  if (name === RETENTION_KEY_NAME) return true;
  return RESULT_FILE_PATTERN.test(name) || STAGE_FILE_PATTERN.test(name);
}

// The key is not a retained result and does not age out with one. It is what
// binds the store's names to this install, so dropping it while retained
// results are still live would orphan the entries the TTL just decided to
// keep. Purge removes it because purge empties the store; expiry never does.
function isExpirable(name) {
  return RESULT_FILE_PATTERN.test(name) || STAGE_FILE_PATTERN.test(name);
}

// A directory entry name is not a path. Joining one that is `..`, or that
// carries a separator on a filesystem that allowed it, would let a purge reach
// outside the store, so the join is checked rather than trusted: the parent of
// the resolved target must be the retention directory itself.
function retentionEntryPath(root, name) {
  if (
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new Error(`Retained-result storage contains an unusable entry name: ${name}`);
  }
  const target = path.resolve(root, name);
  if (path.dirname(target) !== root || path.basename(target) !== name) {
    throw new Error("Retained-result purge refused a path outside the retention directory.");
  }
  return target;
}

function retentionRootStat(root) {
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || stat.isDirectory() &&
      ((stat.mode & 0o077) || typeof process.getuid === 'function' && stat.uid !== process.getuid()))
    throw new Error('Retained-result directory must be owner-private and cannot be a symlink.');
  return stat;
}

export function formatRetentionBytes(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export function describeRetentionAge(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return "unknown";
  if (ageMs < 60 * 60 * 1000) return `${Math.max(1, Math.round(ageMs / 60_000))}m`;
  if (ageMs < DAY_MS) return `${Math.round(ageMs / (60 * 60 * 1000))}h`;
  return `${Math.round(ageMs / DAY_MS)}d`;
}

/**
 * What is on disk right now, without changing any of it.
 *
 * `results` counts retained originals; `files` counts everything retention
 * wrote, including the key and any interrupted stage. `foreign` counts entries
 * this store did not write, which purge will refuse to touch and which are
 * worth naming rather than silently ignoring.
 *
 * With a `ttlMs`, it also reports how much of that is already past its
 * lifetime. Reporting is all this does: expiry happens on the next write to
 * the store or on an explicit sweep, the same way a provider cooldown is read
 * as gone long before anything deletes it.
 */
export function retainedToolResultsUsage({
  directory = TOOL_RESULT_RETENTION_DIR,
  now = Date.now(),
  ttlMs = 0,
  maxFiles = RETENTION_MAX_FILES,
} = {}) {
  const root = path.resolve(directory);
  const lifetime = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 0;
  const empty = {
    path: root,
    exists: false,
    results: 0,
    files: 0,
    bytes: 0,
    foreign: [],
    oldestMs: undefined,
    oldestAgeMs: undefined,
    entries: [],
    capacityReached: false,
    ttlMs: lifetime,
    expired: 0,
    expiredResults: 0,
    expiredBytes: 0,
  };
  let listing;
  try {
    const stat = retentionRootStat(root);
    if (!stat.isDirectory()) return {...empty, exists: true, foreign: [path.basename(root)]};
    listing = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    // A store that was never created is the normal state on an install that
    // has never compacted a result, not a fault to report.
    if (error?.code === "ENOENT") return empty;
    if (error?.code === "ENOTDIR") {
      return { ...empty, exists: true, foreign: [path.basename(root)] };
    }
    throw error;
  }
  const entries = [];
  const foreign = [];
  let results = 0;
  let bytes = 0;
  let oldestMs;
  let expiredCount = 0;
  let expiredResults = 0;
  let expiredBytes = 0;
  for (const entry of listing) {
    const name = entry.name;
    let stat;
    try {
      // lstat, never stat: a symlink parked in this directory is not a
      // retained result, and following one is how a purge ends up reading or
      // reporting a file that lives somewhere else entirely.
      stat = lstatSync(path.join(root, name));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || !isRetentionEntry(name)) {
      foreign.push(name);
      continue;
    }
    // A future mtime is a clock that moved, not an entry that has aged
    // backwards, so age floors at zero and such an entry simply survives.
    const ageMs = Math.max(0, now - stat.mtimeMs);
    const expired = lifetime > 0 && isExpirable(name) && ageMs > lifetime;
    entries.push({ name, bytes: stat.size, mtimeMs: stat.mtimeMs, ageMs, expired });
    bytes += stat.size;
    if (expired) {
      expiredCount += 1;
      expiredBytes += stat.size;
    }
    if (RESULT_FILE_PATTERN.test(name)) {
      results += 1;
      if (expired) expiredResults += 1;
      if (oldestMs === undefined || stat.mtimeMs < oldestMs) oldestMs = stat.mtimeMs;
    }
  }
  return {
    path: root,
    exists: true,
    results,
    files: entries.length,
    bytes,
    foreign,
    oldestMs,
    oldestAgeMs: oldestMs === undefined ? undefined : Math.max(0, now - oldestMs),
    entries,
    capacityReached: results >= maxFiles || bytes >= RETENTION_MAX_TOTAL_BYTES,
    ttlMs: lifetime,
    expired: expiredCount,
    expiredResults,
    expiredBytes,
  };
}

/**
 * Empty the store, or report what emptying it would remove.
 *
 * The directory itself is left in place: it is created and permission-hardened
 * by the writer, and removing it under a concurrent write buys nothing that
 * removing its contents does not.
 */
export function purgeRetainedToolResults({
  directory = TOOL_RESULT_RETENTION_DIR,
  dryRun = false,
  now = Date.now(),
} = {}) {
  const usage = retainedToolResultsUsage({ directory, now });
  const summary = {
    path: usage.path,
    exists: usage.exists,
    dryRun: dryRun === true,
    results: usage.results,
    files: usage.files,
    bytes: usage.bytes,
    foreign: usage.foreign,
    oldestAgeMs: usage.oldestAgeMs,
    removed: 0,
    reclaimedBytes: 0,
    failed: [],
  };
  if (!usage.exists || usage.files === 0) return summary;
  removeRetentionEntries(usage.path, usage.entries, summary);
  return summary;
}

/**
 * Drop retained results the TTL has outlived, or report which ones it would.
 *
 * Same containment as a purge, because it is the same removal: only names
 * retention itself produces, only entries whose resolved parent is this one
 * directory, `lstat` never `stat`, no recursion, and no symlink followed or
 * removed. The key is never expired -- see `isExpirable`.
 *
 * Nothing sweeps on a timer. This runs when the store is next written to, the
 * way `writeCooldownDocument` trims the cooldown store on its next write, and
 * on an operator's explicit `purge --expired`. A TTL of zero means the operator
 * asked to keep everything, and this removes nothing at all.
 */
export function expireRetainedToolResults({
  directory = TOOL_RESULT_RETENTION_DIR,
  ttlMs = RETENTION_DEFAULT_TTL_MS,
  dryRun = false,
  now = Date.now(),
  maxFiles = RETENTION_MAX_FILES,
} = {}) {
  const lifetime = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 0;
  const usage = retainedToolResultsUsage({ directory, now, ttlMs: lifetime, maxFiles });
  const summary = {
    path: usage.path,
    exists: usage.exists,
    dryRun: dryRun === true,
    ttlMs: lifetime,
    results: usage.results,
    files: usage.files,
    bytes: usage.bytes,
    foreign: usage.foreign,
    oldestAgeMs: usage.oldestAgeMs,
    expired: usage.expired,
    expiredResults: usage.expiredResults,
    expiredBytes: usage.expiredBytes,
    removed: 0,
    reclaimedBytes: 0,
    failed: [],
  };
  if (!usage.exists || lifetime === 0 || usage.expired === 0) return summary;
  removeRetentionEntries(
    usage.path,
    usage.entries.filter((entry) => entry.expired),
    summary,
  );
  return summary;
}

// One removal path for both commands: whatever a caller decided to remove, it
// still leaves this module through the same containment check.
function removeRetentionEntries(root, entries, summary) {
  const bound = retentionRootStat(root);
  for (const entry of entries) {
    const current = retentionRootStat(root);
    if (!current.isDirectory() || current.dev !== bound.dev || current.ino !== bound.ino)
      throw new Error('Retained-result directory changed during removal; no further deletion.');
    const target = retentionEntryPath(root, entry.name);
    let stat;
    try { stat = lstatSync(target); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) { summary.failed.push({name: entry.name, error: 'Retention entry type changed; not removed'}); continue; }
    if (summary.dryRun) {
      summary.removed += 1;
      summary.reclaimedBytes += entry.bytes;
      continue;
    }
    try {
      unlinkSync(target);
      summary.removed += 1;
      summary.reclaimedBytes += entry.bytes;
    } catch (error) {
      // Something removed it between the scan and the unlink; that is the
      // outcome this command wanted anyway.
      if (error?.code === "ENOENT") continue;
      summary.failed.push({
        name: entry.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return summary;
}
