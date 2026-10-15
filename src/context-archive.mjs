import { createHash } from "node:crypto";
import path from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { STATE_DIR } from "./paths.mjs";
import { retainToolResult, readRetainedToolResult } from "./tool-result-store.mjs";
import { redactContextText, latestUserItemIndex } from "./compaction-checkpoint.mjs";

export const CONTEXT_ARCHIVE_DIR = process.env.MODEL_ROUTER_CONTEXT_ARCHIVE_DIR || path.join(STATE_DIR, "context-archive");
const MAX_RAW_BYTES = 64 * 1024 * 1024;
const sha = (value) => createHash("sha256").update(value).digest("hex");

function decode(handle, directory) {
  const value = JSON.parse(readRetainedToolResult(handle, { directory }));
  if (value.schema !== "router.context.v1" || !Number.isSafeInteger(value.bytes) || value.bytes < 2 || value.bytes > MAX_RAW_BYTES
    || !/^[a-f0-9]{64}$/.test(value.sha256) || typeof value.deflate !== "string") throw new Error("Invalid context archive contract.");
  const raw = inflateRawSync(Buffer.from(value.deflate, "base64"), { maxOutputLength: MAX_RAW_BYTES });
  if (raw.length !== value.bytes || sha(raw) !== value.sha256) throw new Error("Context archive integrity failure.");
  const input = JSON.parse(raw);
  if (!Array.isArray(input)) throw new Error("Context archive is not an input array.");
  return { input, raw, sha256: value.sha256 };
}

export function archiveCompactionInput(input, { directory = CONTEXT_ARCHIVE_DIR } = {}) {
  if (!Array.isArray(input)) throw new Error("Context input must be an array.");
  const raw = Buffer.from(JSON.stringify(input));
  if (raw.length > MAX_RAW_BYTES) throw new Error("Context archive exceeds 64 MiB; no local compression accepted.");
  const sha256 = sha(raw);
  const envelope = JSON.stringify({ schema: "router.context.v1", bytes: raw.length, sha256, deflate: deflateRawSync(raw, { level: 1 }).toString("base64") });
  const handle = retainToolResult(envelope, { directory, ttlMs: 0 });
  // Prove restoration before publishing a receipt that replaces history.
  if (!decode(handle, directory).raw.equals(raw)) throw new Error("Context archive recovery check failed.");
  const latest_user_index = latestUserItemIndex(input);
  return { handle, sha256, bytes: raw.length, items: input.length, latest_user_index };
}

export function recoverCompactionInput(handle, { directory = CONTEXT_ARCHIVE_DIR } = {}) {
  return decode(handle, directory).input;
}

function credentialLike(value, key = "") {
  if (/^(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|authorization|password|secret|access[_-]?token|refresh[_-]?token|token)$/i.test(key) && value != null && value !== "") return true;
  if (typeof value === "string") return redactContextText(value) !== value;
  if (Array.isArray(value)) return value.some((entry) => credentialLike(entry));
  if (value && typeof value === "object") return Object.entries(value).some(([name, entry]) => credentialLike(entry, name));
  return false;
}

export function readContextItem({ receipt, item, offset = 0, limit = 12000, query }, { directory = CONTEXT_ARCHIVE_DIR } = {}) {
  const restored = decode(receipt, directory);
  if (!Number.isSafeInteger(item) || item < 0 || item >= restored.input.length) throw new Error("Context item index out of bounds.");
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 4 || limit > 24000) throw new Error("Invalid context byte range.");
  const original = JSON.stringify(restored.input[item]);
  const safe = redactContextText(original);
  // Credential-bearing records stay local; no misleading 'exact' redacted replay.
  if (safe !== original || credentialLike(restored.input[item])) throw new Error("Context item contains credential-like material; withheld from model retrieval. Inspect the encrypted original locally.");
  const bytes = Buffer.from(original);
  if (query !== undefined) {
    if (typeof query !== "string" || !query || Buffer.byteLength(query) > 256) throw new Error("Literal query must be 1..256 UTF-8 bytes.");
    const needle = Buffer.from(query); const matches = []; let count = 0; let cursor = 0;
    while ((cursor = bytes.indexOf(needle, cursor)) >= 0) {
      if (matches.length < 16) matches.push({ offset: cursor, bytes: needle.length });
      count++; cursor += needle.length;
    }
    return { archive: receipt, input_sha256: restored.sha256, item, total: bytes.length, match_count: count, matches,
      omitted_matches: count - matches.length, query_scope: "literal bytes in serialized record, not semantic search" };
  }
  if (offset > bytes.length || offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) throw new Error("Offset must be an exact UTF-8 boundary.");
  let end = Math.min(offset + limit, bytes.length);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return { archive: receipt, input_sha256: restored.sha256, item, offset, bytes: end - offset,
    total: bytes.length, next_offset: end < bytes.length ? end : null, content: bytes.subarray(offset, end).toString("utf8") };
}
