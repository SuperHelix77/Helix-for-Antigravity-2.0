import test from "node:test";
import assert from "node:assert/strict";
import { CacheStableAging, CacheStableAgingSessions, commonPrefixBytes } from "../src/cache-stable-aging.mjs";
const text = "public source line\n".repeat(200);
const output = (id, value = text) => ({ type: "function_call_output", call_id: id, output: value });
const acted = { type: "message", role: "assistant", content: [{ type: "output_text", text: "checked" }] };
const options = { enabled: true, frontier: 1, minBytes: 256, compactReceipts: true, preserveSecurityEvidence: true,
  retainOriginal: () => "A".repeat(43) };
test("batches fresh replacements and keeps committed bytes stable", () => {
  const p = new CacheStableAging({ minSavedBytes: 100000, minResults: 2 });
  const first = [output("a"), acted, output("new")];
  const defer = p.shape(first, options); assert.deepEqual(defer.input, first); assert.equal(defer.stats.cacheStableDeferred, 1);
  const second = [output("a"), acted, output("b"), acted, output("new")];
  const commit = p.shape(second, options); assert.equal(commit.stats.cacheStableCommitted, 2);
  const third = [...second, acted, output("last")];
  const next = p.shape(third, options); assert.deepEqual(next.input[0], commit.input[0]);assert.deepEqual(next.input[2], commit.input[2]);
  assert.deepEqual(next.input[4], second[4]);assert.deepEqual(next.input.at(-1), third.at(-1));
});
test("changed original invalidates old decision; failed retention restores raw", () => {
  const p = new CacheStableAging({ minSavedBytes: 100000, minResults: 10 });
  const first = [output("a"), acted, output("new")];
  assert.notDeepEqual(p.shape(first, options, { force: true }).input, first);
  const changed = [output("a", text + "changed"), acted, output("new")];
  assert.deepEqual(p.shape(changed, options).input, changed);
  assert.deepEqual(p.shape(first, { ...options, retainOriginal: () => { throw new Error("offline"); } }).input, first);
});
test("frontier and lossless archive requirement cannot be bypassed", () => {
  const p = new CacheStableAging();const first=[output("a"), acted, output("new")];
  p.shape(first, options, {force:true});
  assert.deepEqual(p.shape([output("a")], options,{force:true}).input,[output("a")]);
  assert.deepEqual(p.shape(first,{...options,retainOriginal:undefined},{force:true}).input,first);
  assert.deepEqual(p.shape(first,{...options,enabled:false},{force:true}).input,first);
});
test("separate sessions cannot inherit decisions; memory is bounded",()=>{
  const a=new CacheStableAging({maxDecisions:1}),b=new CacheStableAging({minSavedBytes:100000,minResults:10});
  const first=[output("a"),acted,output("b"),acted,output("new")];a.shape(first,options,{force:true});
  assert.equal(a.decisions.size,1);assert.deepEqual(b.shape(first,options).input,first);
});
test("prefix metric is byte based and does not claim provider cache hits",()=>{
  assert.equal(commonPrefixBytes("abc","abz"),2);assert.equal(commonPrefixBytes("same","same"),4);
});
test("deferred candidates do not inflate actual saved or retained counters", () => {
  const p = new CacheStableAging({ minSavedBytes: 100000, minResults: 10 });
  const input = [output("a", [{type:"text", text}, {type:"input_text", text}]), acted, output("new")];
  const deferred = p.shape(input, options);
  assert.equal(deferred.stats.toolResultsAged, 0);
  assert.equal(deferred.stats.toolResultsRetained, 0);
  assert.equal(deferred.stats.toolResultBytesBefore, 0);
  assert.equal(deferred.stats.toolResultBytesSaved, 0);
  assert.ok(deferred.stats.candidateToolResultBytesSaved > 0);
  const applied = p.shape(input, options, {force:true});
  assert.equal(applied.stats.toolResultBytesBefore, Buffer.byteLength(text) * 2);
  assert.equal(applied.stats.toolResultBytesSaved, Buffer.byteLength(text) * 2 - Buffer.byteLength(applied.input[0].output));
});
test("session ledger isolates callers and models, expires and obeys opt-in", () => {
  let now = 0;
  const registry = new CacheStableAgingSessions({maxSessions:2, idleMs:100, now:()=>now, policy:{minSavedBytes:100000,minResults:10}});
  const input=[output("a"),acted,output("new")];
  const scope={enabled:true,session:"s",caller:"caller",model:"sol"};
  const committed=registry.shape(input,options,{...scope,force:true});
  assert.notDeepEqual(committed.input,input);
  assert.deepEqual(registry.shape(input,options,scope).input,committed.input);
  assert.deepEqual(registry.shape(input,options,{...scope,caller:"another"}).input,input);
  assert.deepEqual(registry.shape(input,options,{...scope,model:"astra"}).input,input);
  assert.equal(registry.sessions.size,2);
  now=101;
  assert.deepEqual(registry.shape(input,options,scope).input,input);
  assert.equal(registry.sessions.size,1);
  for(const identity of [{enabled:false},{session:undefined},{caller:undefined},{model:undefined}]) {
    assert.notDeepEqual(registry.shape(input,options,{...scope,...identity}).input,input);
  }
  assert.deepEqual(registry.shape(input,{...options,enabled:false},scope).input,input);
});
test("byte-stable receipt requires the same retention handle and call metadata", () => {
  const p=new CacheStableAging({minSavedBytes:100000,minResults:10});
  const input=[{type:"function_call",call_id:"a",name:"old",arguments:"{}"},output("a"),acted,output("new")];
  p.shape(input,options,{force:true});
  const changed=[{...input[0],name:"changed"},...input.slice(1)];
  assert.deepEqual(p.shape(changed,options).input,changed);
  assert.deepEqual(p.shape(input,{...options,retainOriginal:()=>"B".repeat(43)}).input,input);
});
