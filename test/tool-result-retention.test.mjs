import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  RETENTION_DEFAULT_TTL_MS, RETENTION_DEFAULT_TTL_DAYS, retentionTtlDaysFromMs,
  retentionTtlMsFromDays, describeRetentionTtl, formatRetentionBytes, describeRetentionAge,
  retainedToolResultsUsage, expireRetainedToolResults, purgeRetainedToolResults,
} from "../src/tool-result-retention.mjs";
import { retainToolResult, readRetainedToolResult } from "../src/tool-result-store.mjs";

const now = 1700000000000, day = 86400000;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "helix-retention-public-")), directory = path.join(root, "store");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(directory, { mode: 0o700 });
  const age = (name, milliseconds) => { const date = new Date(now - milliseconds); fs.utimesSync(path.join(directory, name), date, date); };
  const store = (value, milliseconds) => { const handle = retainToolResult(value, { directory }); age(`${handle}.result`, milliseconds); return handle; };
  return { root, directory, age, store };
}
function coldRead(handle, directory) {
  const module = new URL("../src/tool-result-store.mjs", import.meta.url).href;
  const code = `import {readRetainedToolResult} from ${JSON.stringify(module)};process.stdout.write(JSON.stringify(readRetainedToolResult(process.argv[1],{directory:process.argv[2]})));`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code, handle, directory], { encoding: "utf8", timeout: 5000 });
}

test("TTL conversions and diagnostic units preserve off and fractional-day values", () => {
  assert.equal(RETENTION_DEFAULT_TTL_MS, RETENTION_DEFAULT_TTL_DAYS * day);
  assert.equal(retentionTtlMsFromDays(1.5), day * 1.5);
  assert.equal(retentionTtlDaysFromMs(day * 1.5), 1.5);
  for (const value of [0, -1, NaN, Infinity]) {
    assert.equal(retentionTtlDaysFromMs(value), 0);
    assert.equal(retentionTtlMsFromDays(value), 0);
    assert.equal(describeRetentionTtl(value), "off");
  }
  assert.equal(describeRetentionTtl(day), "1d");
  assert.equal(describeRetentionTtl(day * 1.5), "1.5d");
  assert.equal(formatRetentionBytes(1024), "1.0 KiB");
  assert.equal(formatRetentionBytes(1024 * 1024), "1.0 MiB");
  assert.equal(describeRetentionAge(1000), "1m");
  assert.equal(describeRetentionAge(2 * 3600000), "2h");
});

test("missing and non-directory stores are reported without creating or removing paths", t => {
  const f = fixture(t), missing = path.join(f.root, "missing"), file = path.join(f.root, "plain-file");
  assert.equal(retainedToolResultsUsage({ directory: missing }).exists, false);
  assert.equal(purgeRetainedToolResults({ directory: missing }).removed, 0);
  assert.equal(expireRetainedToolResults({ directory: missing }).removed, 0);
  assert.equal(fs.existsSync(missing), false);
  fs.writeFileSync(file, "PUBLIC_UNRELATED_FILE");
  assert.deepEqual(retainedToolResultsUsage({ directory: file }).foreign, ["plain-file"]);
  assert.equal(purgeRetainedToolResults({ directory: file }).removed, 0);
  assert.equal(fs.readFileSync(file, "utf8"), "PUBLIC_UNRELATED_FILE");
});

test("usage counts regular owned-shape entries, capacity and future mtimes without treating clock skew as expiry", t => {
  const f = fixture(t);
  f.store("PUBLIC_OLD", 3000); f.store("PUBLIC_FUTURE", -3000);
  const usage = retainedToolResultsUsage({ directory: f.directory, now, ttlMs: 1000, maxFiles: 2 });
  assert.equal(usage.results, 2);
  assert.equal(usage.files, 3);
  assert.equal(usage.expiredResults, 1);
  assert.equal(usage.oldestAgeMs, 3000);
  assert.equal(usage.capacityReached, true);
  assert.ok(usage.entries.some(entry => entry.ageMs === 0 && !entry.expired));
  assert.equal(usage.bytes, usage.entries.reduce((sum, entry) => sum + fs.statSync(path.join(f.directory, entry.name)).size, 0));
});

test("TTL dry-run is nonmutating; expiry removes only old results/stages and retains the old key for cold recovery", t => {
  const f = fixture(t), old = f.store("PUBLIC_OLD", 3000), live = f.store("PUBLIC_LIVE\r\n\u00e7\ud83d\ude00", 100);
  const stage = `.${"A".repeat(43)}.stage.${"a".repeat(32)}`;
  fs.writeFileSync(path.join(f.directory, stage), "PUBLIC_STAGE"); f.age(stage, 3000); f.age(".retention-key", 10000);
  const key = fs.readFileSync(path.join(f.directory, ".retention-key"));
  const before = fs.readdirSync(f.directory).sort();
  const dry = expireRetainedToolResults({ directory: f.directory, now, ttlMs: 1000, dryRun: true });
  assert.equal(dry.removed, 2); assert.equal(dry.expiredResults, 1);
  assert.deepEqual(fs.readdirSync(f.directory).sort(), before);
  assert.equal(readRetainedToolResult(old, { directory: f.directory }), "PUBLIC_OLD");
  const actual = expireRetainedToolResults({ directory: f.directory, now, ttlMs: 1000 });
  assert.equal(actual.removed, 2); assert.equal(actual.failed.length, 0);
  assert.ok(!fs.existsSync(path.join(f.directory, `${old}.result`)));
  assert.deepEqual(fs.readFileSync(path.join(f.directory, ".retention-key")), key);
  const child = coldRead(live, f.directory);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout), "PUBLIC_LIVE\r\n\u00e7\ud83d\ude00");
});

test("disabled TTL preserves old originals, including an explicitly zero lifetime", t => {
  const f = fixture(t), handle = f.store("PUBLIC_RETAINED", day * 100);
  for (const ttlMs of [0, -1, NaN]) {
    assert.equal(expireRetainedToolResults({ directory: f.directory, now, ttlMs }).removed, 0);
    assert.equal(readRetainedToolResult(handle, { directory: f.directory }), "PUBLIC_RETAINED");
  }
});

test("purge dry-run and removal preserve foreign files/directories/symlinks; a new store works after restart", t => {
  const f = fixture(t), old = f.store("PUBLIC_OLD", 100), other = f.store("PUBLIC_OTHER", 100);
  const outside = path.join(f.root, "outside.txt"), link = `${"L".repeat(43)}.result`;
  fs.writeFileSync(outside, "PUBLIC_OUTSIDE");
  fs.writeFileSync(path.join(f.directory, "foreign.txt"), "PUBLIC_FOREIGN");
  fs.mkdirSync(path.join(f.directory, "foreign-directory"));
  fs.symlinkSync(outside, path.join(f.directory, link));
  const before = fs.readdirSync(f.directory).sort();
  const dry = purgeRetainedToolResults({ directory: f.directory, now, dryRun: true });
  assert.equal(dry.removed, 3);
  assert.deepEqual(fs.readdirSync(f.directory).sort(), before);
  assert.ok(dry.foreign.includes(link));
  const actual = purgeRetainedToolResults({ directory: f.directory, now });
  assert.equal(actual.removed, 3); assert.equal(actual.failed.length, 0);
  assert.ok(fs.statSync(f.directory).isDirectory());
  assert.ok(fs.lstatSync(path.join(f.directory, link)).isSymbolicLink());
  assert.equal(fs.readFileSync(outside, "utf8"), "PUBLIC_OUTSIDE");
  assert.equal(fs.readFileSync(path.join(f.directory, "foreign.txt"), "utf8"), "PUBLIC_FOREIGN");
  assert.throws(() => readRetainedToolResult(old, { directory: f.directory }));
  assert.throws(() => readRetainedToolResult(other, { directory: f.directory }));
  fs.unlinkSync(path.join(f.directory, link)); fs.unlinkSync(path.join(f.directory, "foreign.txt")); fs.rmdirSync(path.join(f.directory, "foreign-directory"));
  const fresh = retainToolResult("PUBLIC_AFTER_PURGE", { directory: f.directory });
  const child = coldRead(fresh, f.directory);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout), "PUBLIC_AFTER_PURGE");
});

test("a symlink store root cannot authorize deletion from its target directory", t => {
  const f = fixture(t), handle = f.store("PUBLIC_ROOT_TARGET_MUST_REMAIN", 3000), link = path.join(f.root, "store-link");
  fs.symlinkSync(f.directory, link);
  let result;
  try { result = purgeRetainedToolResults({ directory: link, now }); }
  catch (error) { assert.match(error.message, /symlink|unsafe|private|directory/i); }
  assert.equal(fs.existsSync(path.join(f.directory, `${handle}.result`)), true, "Purge followed a root symlink and deleted an original in its target");
  if (result) assert.equal(result.removed, 0);
  assert.throws(() => expireRetainedToolResults({ directory: link, now, ttlMs: 1 }), /symlink|unsafe|private|directory/i);
  assert.throws(() => retainedToolResultsUsage({ directory: link, now }), /symlink|unsafe|private|directory/i);
  assert.equal(readRetainedToolResult(handle, { directory: f.directory }), "PUBLIC_ROOT_TARGET_MUST_REMAIN");
});
