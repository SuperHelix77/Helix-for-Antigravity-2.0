import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { constants } from "node:fs";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  linkSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  RETENTION_MAX_FILES,
  RETENTION_MAX_TOTAL_BYTES,
  TOOL_RESULT_RETENTION_DIR,
  expireRetainedToolResults,
  retainedToolResultsUsage,
} from "./tool-result-retention.mjs";

const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const RESULT_PATTERN = /^[A-Za-z0-9_-]{43}\.result$/u;
const STAGE_PATTERN = /^\.[^/\\]+\.stage\.[0-9a-f]{32}$/u;
const KEY_NAME = ".retention-key";
const MAGIC = Buffer.from("CRTR1", "ascii");
const MAX_RESULT_BYTES = RETENTION_MAX_TOTAL_BYTES;

function assertPrivateFile(stat, label) {
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} is not an owner-private regular file.`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${label} is not owned by this user.`);
  }
}

function readPrivateFile(filePath, label) {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const descriptor = openSync(filePath, flags);
  try {
    const stat = fstatSync(descriptor);
    assertPrivateFile(stat, label);
    return { bytes: readFileSync(descriptor), stat };
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(root) {
  const descriptor = openSync(root, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function privateRoot(directory) {
  const root = path.resolve(directory);
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const stat = lstatSync(root);
  if (
    !stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new Error("Retained-result directory is not an owner-private directory.");
  }
  return root;
}

function retentionKey(root, { create = false } = {}) {
  const keyPath = path.join(root, KEY_NAME);
  if (!existsSync(keyPath) && create) {
    const descriptor = openSync(keyPath, "wx", 0o600);
    try {
      writeFileSync(descriptor, randomBytes(32));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    syncDirectory(root);
  }
  const key = readPrivateFile(keyPath, "Retained-result key").bytes;
  if (key.length !== 32) throw new Error("Retained-result key has an invalid size.");
  return key;
}

function resultPath(root, handle) {
  if (typeof handle !== "string" || !HANDLE_PATTERN.test(handle)) {
    throw new Error("Invalid retained-result handle.");
  }
  const name = `${handle}.result`;
  if (!RESULT_PATTERN.test(name)) throw new Error("Invalid retained-result handle.");
  return path.join(root, name);
}

function decryptEnvelope(envelope, key) {
  if (envelope.length < MAGIC.length + 12 + 16 || !envelope.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("Retained result has an invalid envelope.");
  }
  const nonceStart = MAGIC.length;
  const nonce = envelope.subarray(nonceStart, nonceStart + 12);
  const tag = envelope.subarray(nonceStart + 12, nonceStart + 28);
  const ciphertext = envelope.subarray(nonceStart + 28);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const value = JSON.parse(plaintext.toString("utf8"));
  if (typeof value !== "string") throw new Error("Retained result is not text.");
  return { value, plaintext };
}

export function retainToolResult(value, {
  directory = TOOL_RESULT_RETENTION_DIR,
  ttlMs,
  now = Date.now(),
  maxFiles = RETENTION_MAX_FILES,
} = {}) {
  if (typeof value !== "string") throw new TypeError("Tool result must be text.");
  const root = privateRoot(directory);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const handle = createHash("sha256").update(plaintext).digest("base64url");
  const target = resultPath(root, handle);

  if (existsSync(target)) {
    const prior = decryptEnvelope(
      readPrivateFile(target, "Retained result").bytes,
      retentionKey(root),
    );
    if (!prior.plaintext.equals(plaintext)) throw new Error("Retained-result handle collision.");
    return handle;
  }

  if (ttlMs > 0) expireRetainedToolResults({ directory: root, ttlMs, now });
  const usage = retainedToolResultsUsage({ directory: root, now, maxFiles });
  if (
    usage.foreign.length || usage.results >= maxFiles ||
    usage.bytes + plaintext.length + 65 > RETENTION_MAX_TOTAL_BYTES
  ) {
    throw new Error("Retained-result store is unsafe or at capacity.");
  }

  const key = retentionKey(root, { create: true });
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), ciphertext]);
  const stageName = `.${handle}.stage.${randomBytes(16).toString("hex")}`;
  if (!STAGE_PATTERN.test(stageName)) throw new Error("Invalid retained-result stage name.");
  const stagePath = path.join(root, stageName);
  try {
    writeFileSync(stagePath, envelope, { flag: "wx", mode: 0o600 });
    chmodSync(stagePath, 0o600);
    const stageDescriptor = openSync(stagePath, "r");
    try { fsyncSync(stageDescriptor); } finally { closeSync(stageDescriptor); }
    linkSync(stagePath, target);
    unlinkSync(stagePath);
    syncDirectory(root);
  } catch (error) {
    try { unlinkSync(stagePath); } catch {}
    throw error;
  }
  return handle;
}

export function readRetainedToolResult(handle, {
  directory = TOOL_RESULT_RETENTION_DIR,
  lines,
} = {}) {
  const root = privateRoot(directory);
  const target = resultPath(root, handle);
  const stored = readPrivateFile(target, "Retained result");
  if (stored.stat.size > MAX_RESULT_BYTES) {
    throw new Error("Retained result exceeds the configured limit.");
  }
  const { value, plaintext } = decryptEnvelope(stored.bytes, retentionKey(root));
  const expected = createHash("sha256").update(plaintext).digest("base64url");
  if (expected !== handle) throw new Error("Retained-result integrity check failed.");
  if (lines === undefined) return value;
  const [first, last] = lines;
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first) {
    throw new Error("Line range must be inclusive, 1-based, and ordered.");
  }
  const all = value.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  if (all.at(-1) === "") all.pop();
  return all.slice(first - 1, last).join("");
}
