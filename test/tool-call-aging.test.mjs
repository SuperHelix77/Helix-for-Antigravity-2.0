import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {ageCompletedPrograms} from "../src/tool-call-aging.mjs";
const call={type:"custom_tool_call",id:"ctc_1",call_id:"call_1",name:"exec",input:"// public historical fixture\n".repeat(100),status:"completed",metadata:{public:true}};
const output={type:"custom_tool_call_output",call_id:"call_1",output:"checked public result"};
const fixture=()=>{const store=new Map();return {store,enabled:true,eligibleCallIds:new Set(["call_1"]),retainOriginal:value=>{const h=createHash("sha256").update(value).digest("hex");store.set(h,value);return h;},readOriginal:h=>store.get(h)};};
test("disabled by default and no implicit completed-scope authority",()=>{
  const input=[call,output];assert.equal(ageCompletedPrograms(input).input,input);
  assert.equal(ageCompletedPrograms(input,{...fixture(),eligibleCallIds:new Set()}).input,input);
});
test("archives exact serialized item and preserves call/result relationships and metadata",()=>{
  const options=fixture(),r=ageCompletedPrograms([call,output],options);
  assert.equal(r.stats.programsAged,1);assert.equal(r.input[1],output);
  const {input,...other}=r.input[0],{input:old,...expected}=call;assert.deepEqual(other,expected);
  const h=/receipt: ([a-f0-9]{64})/.exec(input)[1];assert.equal(options.readOriginal(h),JSON.stringify(call));
  assert.deepEqual(JSON.parse(options.readOriginal(h)),call);assert.ok(r.stats.bytesRemoved>0);
});
test("unconsumed, duplicate, unresolved and schema-constrained function calls stay intact",()=>{
  for(const items of [[call],[call,output,output],[call,call,output],[{...call,type:"function_call",arguments:"{}"},output],
    [call,{...call,type:"function_call",arguments:"{}"},output],[call,output,{...output,type:"function_call_output"}],
    [call,{...output,type:"function_call_output"}]]){
    const r=ageCompletedPrograms(items,fixture());assert.equal(r.input,items);assert.equal(r.stats.programsAged,0);
  }
});
test("retention failure leaves the program byte-identical",()=>{
  const input=[call,output],r=ageCompletedPrograms(input,{...fixture(),readOriginal:()=>"wrong"});
  assert.equal(r.input,input);assert.equal(r.stats.retentionFailures,1);
  const cyclic={...call};cyclic.metadata=cyclic;
  const circular=[cyclic,output];assert.equal(ageCompletedPrograms(circular,fixture()).input,circular);
});
test("pending calls, empty IDs and non-CodeMode custom grammars stay unchanged",()=>{
  for(const entry of [{...call,status:"in_progress"},{...call,call_id:""},{...call,name:"sql"},{...call,namespace:"unverified"}]){
    const result={...output,call_id:entry.call_id};const input=[entry,result];
    assert.equal(ageCompletedPrograms(input,{...fixture(),eligibleCallIds:new Set([entry.call_id])}).input,input);
  }
  for(const result of [{...output,output:null},{...output,status:"in_progress"}]){
    const input=[call,result];assert.equal(ageCompletedPrograms(input,fixture()).input,input);
  }
});
