import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {EventEmitter} from "node:events";
import {GoalEngine} from "../src/helix-goal-engine.mjs";
import {createToolCallRetainer} from "../src/tool-call-retention.mjs";
import {HelixOperationBroker,captureBrokeredResponse} from "../src/helix-operation-broker.mjs";
const call={type:"custom_tool_call",id:"ctc_public",call_id:"public_call",name:"exec",status:"completed",input:'// HELIX_JSON\n{"op":"command","cmd":"printf public"}'};
const response={id:"resp_public",status:"completed",model:"gpt-6.1-sol",output:[{type:"reasoning",encrypted_content:"PUBLIC_OPAQUE"},call],usage:{input_tokens:100,output_tokens:10}};
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),"public-broker-"));let engine=new GoalEngine({directory:path.join(directory,"goals")});
  const retainer=createToolCallRetainer({directory:path.join(directory,"programs")});
  const make=(scope="public-scope",authorize=({task})=>task==="issue-01",options={})=>new HelixOperationBroker({engine,retainer,scope,authorize,...options});
  t.after(()=>{engine.close();fs.rmSync(directory,{recursive:true,force:true});});
  return {make,restart(){engine.close();engine=new GoalEngine({directory:path.join(directory,"goals")});}};
}
class Sink extends EventEmitter{destroyed=false;writableEnded=false;data="";write(data){this.data+=data;return true;}end(){this.writableEnded=true;}}
const frame=event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
async function* stream(events){for(const event of events){const data=Buffer.from(frame(event));for(let offset=0;offset<data.length;offset+=17)yield data.subarray(offset,offset+17);}}
const events=[{type:"response.created",response:{...response,status:"in_progress",output:[]}},{type:"response.output_item.added",output_index:1,item:call},{type:"response.output_item.done",output_index:1,item:call},{type:"response.completed",response}];
test('opt-in default foreground tests admit only current-epoch cell completion and recover exact calls after restart',t=>{
  const f=fixture(t),make=()=>f.make('foreground',({task})=>task==='3',{delegateForegroundTests:true});
  const broker=make(),original={...call,input:'text(await tools.exec_command({cmd:"bench test 03 \'public\'"}));'};
  const p=broker.prepare({...response,output:[original]},{task:'3',epoch:'public-epoch'});broker.issued(p.call_ids);
  const pending={type:'custom_tool_call_output',call_id:original.call_id,output:'Script running with cell ID PUBLIC_CELL\n'};
  const input=[p.response.output[0],pending];
  assert.throws(()=>broker.beforeInference(input,{epoch:'different',authorizeContinuation:()=>true}),/epoch/);
  const routed=broker.beforeInference(input,{epoch:'public-epoch',authorizeContinuation:()=>true});assert.equal(routed.external_model_calls,0);
  const wait=routed.continuation.output[0];assert.equal(wait.name,'wait');
  const done={type:'function_call_output',call_id:wait.call_id,output:'Script completed\nPUBLIC_TEST_COMPLETE'};
  f.restart();const finished=make().beforeInference([...input,wait,done],{epoch:'public-epoch',authorizeContinuation:()=>true});
  assert.deepEqual(finished.input[0],original);assert.match(finished.input[1].output,/PUBLIC_TEST_COMPLETE/);
  assert.equal(finished.continuation,undefined);
});
test('patch evidence cell completion needs current authority and preserves the failed-patch observation after restart',t=>{
  const f=fixture(t),options={delegatePatchEvidence:true,patchEvidenceBinding:()=>({project:'/workbench/tasks/03',evidence:'/workbench/.helix/goals',collector:'/engine/bin/helix-patch-evidence.mjs'})};
  const make=()=>f.make('patch-scope',({task})=>task==='3',options),broker=make();
  const patch='*** Begin Patch\n*** Update File: /workbench/tasks/03/source.py\n@@\n-old\n+new\n*** End Patch';
  const original={...call,input:`text(await tools.apply_patch(${JSON.stringify(patch)}));`};
  const p=broker.prepare({...response,output:[original]},{task:'3',epoch:'patch-epoch'});broker.issued(p.call_ids);
  const pending={type:'custom_tool_call_output',call_id:call.call_id,output:'Script running with cell ID PATCH_CELL\nPUBLIC_ORIGINAL_FAILURE'};
  const input=[p.response.output[0],pending];
  assert.throws(()=>broker.beforeInference(input,{epoch:'stale',authorizeContinuation:()=>true}),/epoch/);
  assert.throws(()=>broker.beforeInference(input,{epoch:'patch-epoch',authorizeContinuation:()=>false}),/authoriz/i);
  assert.throws(()=>broker.beforeInference(input,{epoch:'patch-epoch',authorizeContinuation:()=>true,signal:AbortSignal.abort()}));
  const routed=broker.beforeInference(input,{epoch:'patch-epoch',authorizeContinuation:()=>true}),wait=routed.continuation.output[0];
  const done={type:'function_call_output',call_id:wait.call_id,output:'Script completed\nPUBLIC_EXACT_SOURCE'};
  f.restart();const finished=make().beforeInference([...input,wait,done],{epoch:'patch-epoch',authorizeContinuation:()=>true});
  assert.deepEqual(finished.input[0],original);assert.match(finished.input[1].output,/PUBLIC_ORIGINAL_FAILURE/);assert.match(finished.input[1].output,/PUBLIC_EXACT_SOURCE/);
  assert.equal(finished.continuation,undefined);
});
test("persistent binding restores exact logical calls; duplicate dispatch never re-executes after restart",t=>{
  const f=fixture(t),broker=f.make(),p=broker.prepare(response,{task:"issue-01"});broker.issued(p.call_ids);
  const wire=p.response.output[1],output={type:"custom_tool_call_output",call_id:call.call_id,output:"public",id:"ctco_public"};
  f.restart();const reopened=f.make();assert.deepEqual(reopened.restore([wire,output])[0],call);assert.equal(reopened.row(call.call_id).phase,"acknowledged");
  assert.throws(()=>reopened.prepare(response,{task:"issue-01"}),/Repeated/);
  assert.throws(()=>reopened.restore([{...wire,input:wire.input.replace(/\n\/\/ HELIX_FUNCTION_ORIGINAL.*\n$/,'')},output]),/marker/);
  assert.throws(()=>reopened.restore([wire,{...output,output:"changed"}]),/output changed/);
});
test("authorization and cancelled preparation do not reserve or dispatch anything",t=>{
  const f=fixture(t),broker=f.make(),signal=AbortSignal.abort();assert.throws(()=>broker.prepare(response,{task:"issue-02"}),/authorize/);
  assert.throws(()=>broker.prepare(response,{task:"issue-01",signal}));assert.equal(broker.row(call.call_id),undefined);
});
test('async authorization is rejected synchronously and its rejection is consumed without reserving work',async t=>{
  const f=fixture(t);
  for(const authorize of [async()=>true,async()=>false,async()=>{throw new Error('synthetic authority unavailable');}]){
    const broker=f.make('async-authority',authorize);
    assert.throws(()=>broker.prepare(response,{task:'issue-01'}),/authoriz/i);
    assert.equal(broker.row(call.call_id),undefined);
  }
  // Node's test runner treats a leaked rejection as a test failure.
  await new Promise(resolve=>setImmediate(resolve));
});
test('raw dispatch requires its native result type before acknowledgement and accepts the matching result',t=>{
  const f=fixture(t),broker=f.make();
  for(const [type,expected,wrong] of [['custom_tool_call','custom_tool_call_output','function_call_output'],
    ['function_call','function_call_output','custom_tool_call_output']]){
    const original=type==='custom_tool_call'?{...call,call_id:'raw_custom',input:'text("public")'}:
      {type,name:'ordinary_tool',call_id:'raw_function',arguments:'{}'};
    const p=broker.prepare({...response,output:[original]},{task:'issue-01'});broker.issued(p.call_ids);
    const wire=p.response.output[0];
    assert.throws(()=>broker.restore([wire,{type:wrong,call_id:original.call_id,output:'public'}]),/binding changed/);
    assert.equal(broker.row(original.call_id).phase,'issued');
    const output={type:expected,call_id:original.call_id,output:'public'};
    assert.deepEqual(broker.restore([wire,output]),[original,output]);
    assert.equal(broker.row(original.call_id).phase,'acknowledged');
  }
});
test('async wait continuation authority cannot create a wait or leak its rejection',async t=>{
  const f=fixture(t),broker=f.make(),epoch='synthetic-epoch';
  const p=broker.prepare(response,{task:'issue-01',epoch});broker.issued(p.call_ids);
  const input=[...p.response.output,{type:'custom_tool_call_output',call_id:call.call_id,output:'Script running with cell ID PUBLIC_CELL\n'}];
  for(const authorizeContinuation of [async()=>true,async()=>false,async()=>{throw new Error('synthetic continuation unavailable');}]){
    assert.throws(()=>broker.beforeInference(input,{epoch,authorizeContinuation}),/authoriz/i);
    assert.equal(broker.engine.db.prepare('SELECT count(*) AS n FROM helix_native_waits').get().n,0);
  }
  await new Promise(resolve=>setImmediate(resolve));
});
test('declared upstream overload ends as a typed failure, never a generic incomplete stream or executable dispatch',async t=>{
  const f=fixture(t),broker=f.make(),sink=new Sink();let captured;
  const failed={...response,status:'failed',usage:null,error:{code:'server_is_overloaded',message:'Our servers are currently overloaded.'}};
  const failureEvents=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},
    {type:'response.output_item.added',output_index:1,item:call},{type:'error',code:failed.error.code,message:failed.error.message},
    {type:'response.failed',response:failed}];
  const r=await captureBrokeredResponse({body:stream(failureEvents),res:sink,broker,task:'issue-01',onCapture:value=>{captured=value;}});
  assert.equal(r.completed,false);assert.equal(r.eof,true);assert.equal(r.error,null);
  assert.deepEqual(r.provider_failure,failed.error);assert.equal(captured.provider_failure.code,'server_is_overloaded');
  assert.equal(broker.row(call.call_id),undefined);assert.equal(sink.data.includes('tools.exec_command'),false);
  const terminal=sink.data.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6))).at(-1);
  assert.equal(terminal.type,'response.failed');assert.deepEqual(terminal.response.output,[]);assert.equal(terminal.response.usage,null);
  assert.equal(sink.writableEnded,true);assert.ok(captured.raw.includes(JSON.stringify(call)));
});
test('malformed or contradictory terminal failures stay protocol errors with no guessed execution',async t=>{
  const f=fixture(t),broker=f.make();
  const failed={...response,status:'failed',output:[],error:{code:'server_is_overloaded',message:'Public failure'}};
  for(const sequence of [[{type:'response.failed',response:{...failed,status:'in_progress'}}],
    [{type:'response.failed',response:failed},{type:'response.completed',response}]]){
    const sink=new Sink();await assert.rejects(()=>captureBrokeredResponse({body:stream(sequence),res:sink,broker,task:'issue-01'}));
    assert.equal(broker.row(call.call_id),undefined);
  }
});
test('native provider-envelope omission is restored exactly; changed retained envelopes or execution fields reject',t=>{
  for(const typed of [false,true]){
    const f=fixture(t),broker=f.make();
    const original={...call,metadata:{turn_id:'PUBLIC'},internal_chat_message_metadata_passthrough:{create_time:123},
      input:typed?call.input:'text("public")'};
    const p=broker.prepare({...response,output:[original]},{task:'issue-01'});broker.issued(p.call_ids);
    const native={...p.response.output[0]};delete native.metadata;delete native.internal_chat_message_metadata_passthrough;
    const output={type:'custom_tool_call_output',call_id:call.call_id,output:'public'};
    f.restart();const reopened=f.make();assert.deepEqual(reopened.restore([native,output])[0],original);
    for(const change of [{metadata:{turn_id:'ALTERED'}},{input:native.input+'text(2)'},{name:'other'},{id:'different'},{namespace:'other'}])
      assert.throws(()=>reopened.restore([{...native,...change},output]),/binding changed|marker changed/);
  }
});
test("stream holds executable items until completion; preserves opaque data and usage",async t=>{
  const f=fixture(t),broker=f.make(),sink=new Sink();let capture;
  await captureBrokeredResponse({body:stream(events),res:sink,broker,task:"issue-01",onCapture:c=>capture=c});
  assert.equal(capture.completed,true);assert.equal(sink.writableEnded,true);assert.match(sink.data,/tools.exec_command/);
  const parsed=sink.data.split("\n").filter(l=>l.startsWith("data: ")).map(l=>JSON.parse(l.slice(6)));
  const completed=parsed.find(e=>e.type==="response.completed");assert.deepEqual(completed.response.usage,response.usage);assert.deepEqual(completed.response.output[0],response.output[0]);
  assert.equal(parsed.filter(e=>e.type==="response.output_item.done").length,1);assert.equal(broker.row(call.call_id).phase,"issued");
});
test('terminal delivery awaits asynchronous current-authority validation before issuing',async t=>{
  const f=fixture(t),broker=f.make(),sink=new Sink();let validated=false;
  const guarded={async prepare(value,args){await new Promise(r=>setTimeout(r,5));validated=true;return broker.prepare(value,args);},
    issued(ids){assert.equal(validated,true);broker.issued(ids);},uncertain(ids){broker.uncertain(ids);}};
  await captureBrokeredResponse({body:stream(events),res:sink,broker:guarded,task:'issue-01'});
  assert.equal(broker.row(call.call_id).phase,'issued');assert.match(sink.data,/response.completed/);
  const rejected={async prepare(){throw new Error('Current native authority changed');},issued(){throw new Error('Must not issue');},uncertain(){}};
  const second=new Sink();await assert.rejects(()=>captureBrokeredResponse({body:stream(events),res:second,broker:rejected,task:'issue-01'}),/authority changed/);
  assert.equal(second.data.includes('tools.exec_command'),false);
});
test("truncated stream and complete but stale authorization emit no executable calls",async t=>{
  const f=fixture(t);
  for(const [input,task] of [[events.slice(0,-1),"issue-01"],[events,"issue-02"]]){
    const broker=f.make(),sink=new Sink();await assert.rejects(()=>captureBrokeredResponse({body:stream(input),res:sink,broker,task}));
    assert.equal(sink.data.includes("tools.exec_command"),false);assert.equal(broker.row(call.call_id),undefined);
  }
});
test("delivery loss leaves non-replayable uncertain state",async t=>{
  const f=fixture(t),broker=f.make(),sink=new Sink();sink.write=function(data){this.data+=data;if(data.includes('tools.exec_command')){this.destroyed=true;throw new Error('public delivery loss');}return true;};
  await assert.rejects(()=>captureBrokeredResponse({body:stream(events),res:sink,broker,task:"issue-01"}));
  assert.equal(broker.row(call.call_id).phase,"uncertain");assert.throws(()=>broker.prepare(response,{task:"issue-01"}),/Repeated/);
});
test("only declared completion waits are automatic; synthetic waits collapse with exact observations",t=>{
  const f=fixture(t),broker=f.make(),original={...call,input:'// HELIX_JSON\n{"op":"code","program":"await new Promise(r=>setTimeout(r,2500));text(1)","wait_for_completion":true}'};
  const p=broker.prepare({...response,output:[original]},{task:"issue-01",epoch:"public-1"});broker.issued(p.call_ids);
  const pending={type:"custom_tool_call_output",call_id:call.call_id,output:[{type:"input_text",text:"Script running with cell ID 1\nWall time 1.0 seconds\nOutput:\n"}]};
  const input=[p.response.output[0],pending];
  assert.throws(()=>broker.beforeInference(input,{epoch:"different",authorizeContinuation:()=>true}),/epoch/);
  const routed=broker.beforeInference(input,{epoch:"public-1",authorizeContinuation:()=>true});assert.equal(routed.external_model_calls,0);assert.equal(routed.continuation.usage,undefined);
  const wait=routed.continuation.output[0];assert.equal(wait.name,"wait");
  const done={type:"function_call_output",call_id:wait.call_id,output:[{type:"input_text",text:"Script completed\nWall time 1.4 seconds\nOutput:\n"},{type:"input_text",text:"PUBLIC_RESULT"}]};
  f.restart();const reopened=f.make(),finished=reopened.beforeInference([...input,wait,done],{epoch:"public-1",authorizeContinuation:()=>true});
  assert.equal(finished.input.length,2);assert.deepEqual(finished.input[0],original);assert.match(finished.input[1].output,/PUBLIC_RESULT/);
  assert.throws(()=>reopened.beforeInference([...input,wait,{...done,output:"changed"}],{epoch:"public-1",authorizeContinuation:()=>true}),/result changed/);
});
test("raw code pending cells remain model decisions, and missing issued calls block fresh inference",t=>{
  const f=fixture(t),broker=f.make(),raw={...call,input:"await new Promise(r=>setTimeout(r,2500))"};
  const p=broker.prepare({...response,output:[raw]},{task:"issue-01",epoch:"one"});broker.issued(p.call_ids);
  assert.throws(()=>broker.beforeInference([],{epoch:"one",authorizeContinuation:()=>true}),/Unacknowledged/);
  const pending={type:"custom_tool_call_output",call_id:raw.call_id,output:"Script running with cell ID 1\n"};
  const routed=broker.beforeInference([raw,pending],{epoch:"one",authorizeContinuation:()=>true});assert.equal(routed.continuation,undefined);assert.equal(routed.input[1],pending);
});
test('opt-in explicit native waiting admits bounded same-cell continuation, never termination or a different cell',t=>{
  const f=fixture(t),broker=f.make('public-scope',()=>true,{delegateNativeWaits:true});
  const wait={type:'function_call',id:'fc_declared',call_id:'declared',name:'wait',arguments:'{"cell_id":"public_cell","yield_time_ms":1000}'};
  const p=broker.prepare({...response,output:[wait]},{task:'issue-01',epoch:'native-1'});broker.issued(p.call_ids);
  const pending={type:'function_call_output',call_id:wait.call_id,output:'Script running with cell ID public_cell\n'};
  assert.throws(()=>broker.beforeInference([wait,{...pending,output:'Script running with cell ID other_cell\n'}],{epoch:'native-1',authorizeContinuation:()=>true}),/cell changed/);
  const routed=broker.beforeInference([wait,pending],{epoch:'native-1',authorizeContinuation:()=>true});
  assert.equal(routed.external_model_calls,0);assert.equal(JSON.parse(routed.continuation.output[0].arguments).cell_id,'public_cell');
  const stopped={...wait,id:'fc_stop',call_id:'stop',arguments:'{"cell_id":"public_cell","terminate":true}'};
  const q=broker.prepare({...response,output:[stopped]},{task:'issue-01',epoch:'native-1'});broker.issued(q.call_ids);
  const stoppedOutput={type:'function_call_output',call_id:'stop',output:'Script running with cell ID public_cell\n'};
  assert.equal(broker.beforeInference([stopped,stoppedOutput],{epoch:'native-1',authorizeContinuation:()=>true}).continuation,undefined);
});
