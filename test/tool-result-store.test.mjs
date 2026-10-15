import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readRetainedToolResult,
  retainToolResult,
} from "../src/tool-result-store.mjs";
import { ageToolResults } from "../src/tool-result-aging.mjs";

function withStore(run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "tool-result-store-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("retained tool results round-trip exact text and encrypt content at rest", () => {
  withStore((directory) => {
    const value = "line 1\r\nemoji: 🧪\nodd surrogate: \ud800\n";
    const handle = retainToolResult(value, { directory });
    assert.match(handle, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(readRetainedToolResult(handle, { directory }), value);
    const result = readFileSync(path.join(directory, `${handle}.result`));
    assert.equal(result.includes(Buffer.from("emoji")), false);
    assert.equal(result.includes(Buffer.from("line 1")), false);
    assert.deepEqual(readdirSync(directory).sort(), [".retention-key", `${handle}.result`]);
  });
});

test("file-cap failure preserves existing archives and refuses the new result", () => {
  withStore((directory) => {
    const first = "first exact result";
    const handle = retainToolResult(first, { directory, maxFiles: 1 });
    assert.throws(
      () => retainToolResult("second distinct result", { directory, maxFiles: 1 }),
      /at capacity/u,
    );
    assert.equal(readRetainedToolResult(handle, { directory }), first);
    assert.deepEqual(readdirSync(directory).sort(), [".retention-key", `${handle}.result`]);
  });
});

test("retained tool results recover exact text in a fresh process", () => {
  withStore((directory) => {
    const value = "CRLF\r\nUnicode: 𐐷 🧪\nLone surrogate: \ud800\n";
    const handle = retainToolResult(value, { directory });
    const moduleUrl = new URL("../src/tool-result-store.mjs", import.meta.url).href;
    const script = [
      `import { readRetainedToolResult } from ${JSON.stringify(moduleUrl)};`,
      "process.stdout.write(JSON.stringify(readRetainedToolResult(process.argv[1], { directory: process.argv[2] })));",
    ].join("\n");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, handle, directory], {
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout), value);
  });
});

test("compact receipt points to the byte-exact original in a fresh process", () => {
  withStore((directory) => {
    const value = "public diagnostic\r\n".repeat(200);
    const result = ageToolResults([{type:"function_call_output",call_id:"old",output:value},
      {type:"message",role:"assistant",content:"acted"}], {
      frontier:0,compactReceipts:true,minBytes:256,previewCodeUnits:24,
      retainOriginal:raw=>retainToolResult(raw,{directory}),
    });
    const handle = /context raw receipt ([A-Za-z0-9_-]{43})/u.exec(result.input[0].output)?.[1];
    assert.ok(handle);
    const moduleUrl = new URL("../src/tool-result-store.mjs",import.meta.url).href;
    const child=spawnSync(process.execPath,["--input-type=module","-e",
      `import {readRetainedToolResult} from ${JSON.stringify(moduleUrl)};process.stdout.write(JSON.stringify(readRetainedToolResult(process.argv[1],{directory:process.argv[2]})));`,handle,directory],{encoding:"utf8"});
    assert.equal(child.status,0,child.stderr);
    assert.equal(JSON.parse(child.stdout),value);
  });
});

test("line retrieval is inclusive, 1-based, and preserves original line endings", () => {
  withStore((directory) => {
    const handle = retainToolResult("one\r\ntwo\nthree", { directory });
    assert.equal(readRetainedToolResult(handle, { directory, lines: [1, 2] }), "one\r\ntwo\n");
    assert.equal(readRetainedToolResult(handle, { directory, lines: [3, 3] }), "three");
    assert.throws(
      () => readRetainedToolResult(handle, { directory, lines: [0, 1] }),
      /Line range/u,
    );
  });
});

test("retained result integrity and handle validation fail closed", () => {
  withStore((directory) => {
    const handle = retainToolResult("private output", { directory });
    assert.throws(() => readRetainedToolResult("../outside", { directory }), /handle/u);
    const file = path.join(directory, `${handle}.result`);
    const corrupted = readFileSync(file);
    corrupted[corrupted.length - 1] ^= 1;
    writeFileSync(file, corrupted, { mode: 0o600 });
    assert.throws(() => readRetainedToolResult(handle, { directory }));
  });
});

test("unsafe retention directory fails without following a symlink", () => {
  withStore((directory) => {
    const target = path.join(directory, "target");
    const link = path.join(directory, "link");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, link);
    assert.throws(() => retainToolResult("secret", { directory: link }));
  });
});
