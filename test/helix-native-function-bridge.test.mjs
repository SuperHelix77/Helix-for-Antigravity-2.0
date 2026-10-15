import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createToolCallRetainer} from "../src/tool-call-retention.mjs";
import {NativeFunctionBridge,compileNativeOperation,nativeProcessRead} from "../src/helix-native-function-bridge.mjs";
test('fixed process-read grammar excludes expressions, interactive input and extra statements',()=>{
  const source='text(await tools.write_stdin({session_id:84856,chars:"",yield_time_ms:1000,max_output_tokens:5000}));';
  assert.deepEqual({...nativeProcessRead(source)},{op:'process_wait',session_id:84856,chars:'',yield_time_ms:1000,max_output_tokens:5000});
  for(const program of [source+'text(2);',source.replace('84856','getId()'),source.replace('chars:""','chars:"yes\\n"'),source.replace('session_id:84856','session_id:84856,session_id:2'),source.replace('max_output_tokens:5000','unknown:5000')])
    assert.equal(nativeProcessRead(program),null);
});
test('supervised process read retains all observations and stops on changed identity or unknown data',async()=>{
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const execute=async results=>{let result,calls=0;const code=compileNativeOperation({op:'process_wait',session_id:7,chars:'',yield_time_ms:1000});
    await new AsyncFunction('tools','text','exit',code)({write_stdin:async args=>{assert.equal(args.session_id,7);return results[calls++];}},value=>result=value,()=>{throw new Error('PUBLIC_BOUNDARY');}).catch(error=>{if(error.message!=='PUBLIC_BOUNDARY')throw error;});
    return {result,calls};};
  const initial={session_id:7,output:'first',chunk_id:'one'},final={exit_code:0,output:'last',chunk_id:'two'};
  const good=await execute([initial,final]);assert.equal(good.result.output,'firstlast');assert.deepEqual(good.result.observations,[initial,final]);assert.equal(good.calls,2);
  const changed=await execute([{session_id:8,output:'changed'}]);assert.equal(changed.calls,1);assert.match(changed.result.boundary,/identity changed/);
  const unknown=await execute([{unexpected:true}]);assert.equal(unknown.calls,1);assert.deepEqual(unknown.result.raw,{unexpected:true});
});
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),"public-function-bridge-"));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return {directory,bridge:new NativeFunctionBridge(createToolCallRetainer({directory}))};}
const call={type:"function_call",id:"fc_public",call_id:"call_public",name:"helix",arguments:' {"op":"command","cmd":"printf \\\"public\\\"","workdir":"/workbench"} ',status:"completed"};
test("typed call returns to exact provider representation after encrypted native translation",t=>{
  const f=fixture(t),wire=f.bridge.toNative(call),reasoning={type:"reasoning",encrypted_content:"PUBLIC_OPAQUE_UNCHANGED"};
  assert.equal(wire.name,"exec");assert.equal(wire.type,"custom_tool_call");assert.match(wire.input,/tools.exec_command/);
  const reordered=Object.fromEntries(Object.entries(wire).reverse());
  const output={type:"custom_tool_call_output",id:"ctco_public",call_id:call.call_id,output:[{type:"input_text",text:"public result"}]};
  const reopened=new NativeFunctionBridge(createToolCallRetainer({directory:f.directory}));
  const history=reopened.restoreHistory([reasoning,reordered,output]);assert.equal(history[0],reasoning);assert.deepEqual(history[1],call);
  assert.equal(history[2].type,"function_call_output");assert.equal(history[2].id,"ftco_public");assert.equal(history[2].output,output.output);
});
test("corruption, tampered code and duplicate IDs reject instead of guessing",t=>{
  const {bridge}=fixture(t),wire=bridge.toNative(call);
  assert.throws(()=>bridge.restoreHistory([{...wire,input:wire.input.replace('text(', 'exit();text(')}]),/binding/);
  assert.throws(()=>bridge.restoreHistory([wire,wire]),/Ambiguous/);
  const result={type:"custom_tool_call_output",call_id:call.call_id,output:"public"};
  assert.throws(()=>bridge.restoreHistory([wire,result,result]),/complete native output/);
  assert.throws(()=>bridge.restoreHistory([result,wire]),/output binding/);
  assert.throws(()=>bridge.restoreHistory([wire,{...result,type:"function_call_output"}]),/output binding/);
  assert.throws(()=>bridge.restoreHistory([wire,{...result,status:"in_progress"}]),/output binding/);
  assert.throws(()=>bridge.restoreHistory([wire]),/complete native output/);
  assert.throws(()=>bridge.restoreHistory([{...wire,input:wire.input.replace(/\n\/\/ HELIX_FUNCTION_ORIGINAL.*\n$/,'')},result]),/marker changed/);
  const bad=new NativeFunctionBridge({retainOriginal:()=>"a".repeat(43),readOriginal:()=>"wrong"});assert.throws(()=>bad.toNative(call),/recovery/);
});
test("all ordinary items untouched; raw code/pragma and patch literals preserved",t=>{
  const {bridge}=fixture(t);const ordinary={type:"custom_tool_call",name:"exec",call_id:"other",input:"text('public')"};
  assert.equal(bridge.toNative(ordinary),ordinary);assert.equal(bridge.restoreHistory([ordinary])[0],ordinary);
  const program='// @exec: {"yield_time_ms":1000}\ntext("public");';
  const code=bridge.toNative({...call,arguments:JSON.stringify({op:"code",program})});assert.ok(code.input.startsWith(program));
  const patch="*** Begin Patch\n*** End Patch";assert.equal(compileNativeOperation({op:"patch",patch}),`text(await tools.apply_patch(${JSON.stringify(patch)}));`);
  assert.throws(()=>compileNativeOperation({op:"command",cmd:"public",unsafe:true}),/fields/);
  assert.throws(()=>compileNativeOperation({op:"mcp",tool:"unrelated",args:{}}),/selection/);
});
test("opt-in JSON directive uses existing native custom type/identity and exact round-trip",t=>{
  const f=fixture(t),bridge=new NativeFunctionBridge({...createToolCallRetainer({directory:f.directory}),typedCustom:true});
  const original={type:"custom_tool_call",name:"exec",id:"ctc_public_typed",call_id:"typed_public",input:'// HELIX_JSON\n {"op":"command","cmd":"printf public"} ',status:"completed"};
  assert.equal(f.bridge.toNative(original),original);
  const native=bridge.toNative(original);assert.equal(native.type,original.type);assert.equal(native.id,original.id);assert.equal(native.name,original.name);
  const result={type:"custom_tool_call_output",id:"ctco_public_typed",call_id:original.call_id,output:"public"};
  const history=bridge.restoreHistory([native,result]);assert.deepEqual(history[0],original);assert.equal(history[1],result);
});
