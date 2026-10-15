import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {bindCheckpointOperation} from '../src/helix-checkpoint-operation.mjs';
import {compileNativeOperation} from '../src/helix-native-function-bridge.mjs';
import {HelixOperationBroker} from '../src/helix-operation-broker.mjs';
import {GoalEngine} from '../src/helix-goal-engine.mjs';
import {createToolCallRetainer} from '../src/tool-call-retention.mjs';

const args={op:'checkpoint',revision:1,step:'fix-01',review:'If declared verification succeeds, the reviewed public patch satisfies the stated criterion.',request_id:'public-review-01'};
const binding={task:'issue-01',state:'active',kind:'model',busy:false,revision:1,step:'fix-01',scope:{project:'/public',session:'public-session',goal:'public-goal'}};
const options={task:'issue-01',checkpointBinding:()=>binding};
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
async function execute(program,{results=[{exit_code:0,output:'exact successful verification'}],names=['mcp__helix_context__goal']}={}){
  const observations=[],operations=[];const stop=Symbol('stop');let n=0;
  const tools={exec_command:async value=>{operations.push(['exec',value]);return results[n++];},
    write_stdin:async value=>{operations.push(['wait',value]);return results[n++];}};
  for(const name of names)tools[name]=async value=>{operations.push(['goal',value]);return {status:'accepted'};};
  const programFn=new AsyncFunction('tools','ALL_TOOLS','text','exit',program);
  try{await programFn(tools,names.map(name=>({name})),value=>observations.push(value),()=>{throw stop;});}
  catch(error){if(error!==stop)throw error;}
  return {observations,operations};
}
test('scope injection is explicit, current-task bound and keeps the model review exact',()=>{
  const bound=bindCheckpointOperation(args,{binding,task:'issue-01'});
  assert.deepEqual(bound.args,{action:'checkpoint',...binding.scope,revision:1,step:'fix-01',review:args.review,request_id:args.request_id});
  assert.throws(()=>compileNativeOperation(args),/not enabled/);
  for(const change of [{task:'issue-02'},{revision:2},{step:'fix-02'},{state:'paused'},{state:'done'},{busy:true},{kind:'command'},
    {scope:{...binding.scope,unexpected:true}}])assert.throws(()=>bindCheckpointOperation(args,{binding:{...binding,...change},task:'issue-01'}),/frontier/);
  for(const change of [{revision:0},{review:''},{review:'x'.repeat(2001)},{request_id:'x'.repeat(129)},{project:'/model-injected'},
    {verify:{cmd:'test',unknown:true}},{verify:{cmd:''}},{verify:{cmd:'test',workdir:3}}])assert.throws(()=>bindCheckpointOperation({...args,...change},{binding,task:'issue-01'}));
  assert.throws(()=>compileNativeOperation(args,{...options,checkpointBinding:async()=>binding}),/Synchronous/);
});
test('ordinary checkpoint invokes only the uniquely selected goal MCP with literal data',async()=>{
  const maliciousText='review: "); tools.exec_command({cmd:"bad"}); //';
  const program=compileNativeOperation({...args,review:maliciousText},options),r=await execute(program);
  assert.equal(r.operations.length,1);assert.equal(r.operations[0][0],'goal');assert.equal(r.operations[0][1].review,maliciousText);
  for(const names of [[],['mcp__helix_a__goal','mcp__helix_b__goal']])await assert.rejects(()=>execute(program,{names}),/Unique/);
});
test('expected argument/frontier rejections are nonexecuting observations, not transport failures',async()=>{
  for(const [request,current] of [[{...args,review:''},binding],[{...args,private_field:'PUBLIC_NO_ECHO'},binding],
    [{...args,verify:{cmd:'test',unexpected:true}},binding],[args,{...binding,revision:2}],[args,{...binding,task:'issue-02'}]]){
    const r=await execute(compileNativeOperation(request,{...options,checkpointBinding:()=>current}));
    assert.equal(r.operations.length,0);assert.equal(r.observations.length,1);
    assert.equal(r.observations[0].status,'checkpoint_not_executed');
    assert.equal(JSON.stringify(r.observations).includes('PUBLIC_NO_ECHO'),false);
    assert.match(r.observations[0].recovery,/correct once/);
  }
  assert.throws(()=>compileNativeOperation(args,{...options,checkpointBinding:()=>{throw new Error('Unexpected controller failure');}}),/Unexpected/);
});
test('preauthorized verification checkpoints only after a known successful exit',async()=>{
  const program=compileNativeOperation({...args,verify:{cmd:'public test',workdir:'/public'}},options);
  const r=await execute(program);assert.deepEqual(r.operations.map(o=>o[0]),['exec','goal']);
  assert.equal(r.observations[0].output,'exact successful verification');assert.equal(r.operations[0][1].workdir,'/public');
  for(const results of [[{exit_code:1,output:'exact failure'}],[{output:'unknown completion'}],[{exit_code:0,output:'uncertain',boundary:'review'}],
    [{exit_code:0,output:'interrupted',signal:'SIGTERM'}],[null],['unknown']]){
    const failed=await execute(program,{results});assert.equal(failed.operations.some(o=>o[0]==='goal'),false);
    assert.equal(failed.observations.at(-1).status,'checkpoint_not_executed');
  }
  const pending=await execute(program,{results:[{session_id:7,output:'first'}, {session_id:7,exit_code:0,output:'second'}]});
  assert.deepEqual(pending.operations.map(o=>o[0]),['exec','wait','goal']);assert.equal(pending.observations[0].output,'firstsecond');
  const failure=await execute(program,{results:[{session_id:7,output:'first'}, {session_id:7,exit_code:2,output:'failed'}]});
  assert.deepEqual(failure.operations.map(o=>o[0]),['exec','wait']);assert.equal(failure.observations[0].output,'firstfailed');
  const changed=await execute(program,{results:[{session_id:7,output:'first'}, {session_id:8,exit_code:0,output:'wrong process'}]});
  assert.deepEqual(changed.operations.map(o=>o[0]),['exec','wait']);assert.equal(changed.observations.at(-1).status,'checkpoint_not_executed');
  await assert.rejects(()=>execute(program,{names:[]}),/Unique/);
  const pendingBudget=await execute(program,{results:Array.from({length:22},()=>({session_id:7,output:'tick'}))});
  assert.equal(pendingBudget.operations.some(o=>o[0]==='goal'),false);
  assert.equal(pendingBudget.observations.at(-1).status,'checkpoint_not_executed');
  let checkpoints=0;
  const interrupted=new AsyncFunction('tools','ALL_TOOLS','text','exit',program);
  await assert.rejects(()=>interrupted({exec_command:async()=>{throw new Error('public cancellation');},
    mcp__helix_context__goal:async()=>{checkpoints++;}},[{name:'mcp__helix_context__goal'}],()=>{},()=>{}),/cancellation/);
  assert.equal(checkpoints,0);
});
test('broker archives and restores the exact semantic checkpoint after restart without re-execution',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'public-checkpoint-op-'));
  let engine=new GoalEngine({directory:path.join(directory,'goals')});
  const retainer=createToolCallRetainer({directory:path.join(directory,'programs')});
  const make=()=>new HelixOperationBroker({engine,retainer,scope:'public-scope',authorize:({task})=>task==='issue-01',checkpointBinding:options.checkpointBinding});
  t.after(()=>{engine.close();fs.rmSync(directory,{recursive:true,force:true});});
  const call={type:'custom_tool_call',id:'ctc_public',call_id:'call_public',name:'exec',input:'// HELIX_JSON\n'+JSON.stringify(args)};
  const response={status:'completed',output:[{type:'reasoning',encrypted_content:'public-opaque'},call]};
  const broker=make(),prepared=broker.prepare(response,{task:'issue-01',epoch:'public-epoch'});broker.issued(prepared.call_ids);
  const output={type:'custom_tool_call_output',call_id:call.call_id,output:'exact original result'};
  engine.close();engine=new GoalEngine({directory:path.join(directory,'goals')});const reopened=make();
  assert.deepEqual(reopened.restore([...prepared.response.output,output]),[...response.output,output]);
  assert.throws(()=>reopened.prepare(response,{task:'issue-01',epoch:'public-epoch'}),/Repeated/);
});
test('malformed typed JSON and known operation-field failures are archived diagnostics, with no dispatch',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'public-invalid-native-op-'));
  let engine=new GoalEngine({directory:path.join(directory,'goals')});
  const retainer=createToolCallRetainer({directory:path.join(directory,'programs')});
  const make=()=>new HelixOperationBroker({engine,retainer,scope:'public-scope',authorize:()=>true,checkpointBinding:options.checkpointBinding});
  t.after(()=>{engine.close();fs.rmSync(directory,{recursive:true,force:true});});
  const inputs=['// HELIX_JSON\n{','// HELIX_JSON\n'+JSON.stringify({op:'command',cmd:'public',private_field:'PUBLIC_NO_ECHO'}),
    '// HELIX_JSON\n'+JSON.stringify({op:'unknown',private_field:'PUBLIC_NO_ECHO'}),'// HELIX_JSON\n'+JSON.stringify({op:'process_wait',session_id:1,chars:'interactive input'})];
  for(const [i,input] of inputs.entries()){
    const call={type:'custom_tool_call',call_id:'call_invalid_'+i,id:'ctc_invalid_'+i,name:'exec',input};
    const broker=make(),p=broker.prepare({status:'completed',output:[call]},{task:'issue-01'});broker.issued(p.call_ids);
    const wire=p.response.output[0],r=await execute(wire.input);assert.equal(r.operations.length,0);
    assert.equal(r.observations[0].status,'no_work_executed');assert.equal(JSON.stringify(r.observations).includes('PUBLIC_NO_ECHO'),false);
    const output={type:'custom_tool_call_output',call_id:call.call_id,output:JSON.stringify(r.observations[0])};
    engine.close();engine=new GoalEngine({directory:path.join(directory,'goals')});
    assert.deepEqual(make().restore([wire,output]),[call,output]);
  }
});
