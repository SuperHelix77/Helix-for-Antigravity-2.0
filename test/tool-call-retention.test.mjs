import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync,writeFileSync,readdirSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {createToolCallRetainer,readToolCallOriginal} from "../src/tool-call-retention.mjs";
import {ageCompletedPrograms} from "../src/tool-call-aging.mjs";

const fixture=t=>{const directory=mkdtempSync(path.join(os.tmpdir(),"encrypted-program-"));t.after(()=>rmSync(directory,{recursive:true,force:true}));return directory;};
test("encrypted original item recovers code units byte-exact in a fresh process; disk is not plaintext",t=>{
  const directory=fixture(t),original={type:"custom_tool_call",id:"ctc_public",call_id:"call_public",name:"exec",status:"completed",
    input:"// PUBLIC_PROGRAM_MARKER \u00e7 \ud83d\ude00 \ud800\r\n".repeat(100),metadata:{public:true}};
  const result={type:"custom_tool_call_output",call_id:original.call_id,output:"public result"};
  const input=[original,result],aged=ageCompletedPrograms(input,{enabled:true,eligibleCallIds:new Set([original.call_id]),...createToolCallRetainer({directory})});
  assert.equal(aged.stats.programsAged,1);assert.equal(aged.input[1],result);
  const handle=/receipt: ([A-Za-z0-9_-]{43})/.exec(aged.input[0].input)[1];
  for(const name of readdirSync(directory))assert.equal(readFileSync(path.join(directory,name)).includes(Buffer.from("PUBLIC_PROGRAM_MARKER")),false);
  const child=spawnSync(process.execPath,["--input-type=module","-e",`import {createToolCallRetainer} from ${JSON.stringify(new URL("../src/tool-call-retention.mjs",import.meta.url).href)};process.stdout.write(createToolCallRetainer({directory:${JSON.stringify(directory)}}).readOriginal(${JSON.stringify(handle)}));`]);
  assert.equal(child.status,0,child.stderr.toString());assert.deepEqual(child.stdout,Buffer.from(JSON.stringify(original)));
  assert.deepEqual(JSON.parse(child.stdout),original);
});
test("every ranged byte recovers across split Unicode boundaries; invalid ranges reject",t=>{
  const directory=fixture(t),retainer=createToolCallRetainer({directory}),source=JSON.stringify({input:"\u00e7\ud83d\ude00".repeat(30)}),handle=retainer.retainOriginal(source);
  const parts=[];let offset=0,next;
  do{const r=readToolCallOriginal(handle,{directory,offset,limit:7});parts.push(Buffer.from(r.content,r.encoding));offset+=r.bytes;next=r.next_offset;}while(next!==null);
  assert.deepEqual(Buffer.concat(parts),Buffer.from(source));
  assert.throws(()=>readToolCallOriginal(handle,{directory,offset:-1}),/range/);
  assert.throws(()=>readToolCallOriginal(handle,{directory,offset:10000}),/outside/);
});
test("corruption fails closed and never changes the original call",t=>{
  const directory=fixture(t),retainer=createToolCallRetainer({directory}),call={type:"custom_tool_call",name:"exec",call_id:"x",input:"PUBLIC_RECOVERY".repeat(200)},input=[call,{type:"custom_tool_call_output",call_id:"x",output:"done"}];
  const handle=retainer.retainOriginal(JSON.stringify(call));writeFileSync(path.join(directory,`${handle}.result`),"corrupted");
  assert.equal(ageCompletedPrograms(input,{enabled:true,eligibleCallIds:new Set(["x"]),...retainer}).input,input);
  assert.throws(()=>readToolCallOriginal(handle,{directory}));
});
