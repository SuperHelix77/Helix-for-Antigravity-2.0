import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createToolCallRetainer} from "../src/tool-call-retention.mjs";
import {deferNativeToolHelp} from "../src/helix-lazy-tool-help.mjs";

const description="Run JavaScript code to orchestrate/compose tool calls\n"+
  ["apply_patch","create_goal","exec_command","get_goal","view_image","write_stdin"].map(name=>`### \`${name}\`\nPublic exact ${name} signature and controls\n${name.includes('goal')?'unused help '.repeat(1500):''}`).join("\n");
const tools=[{type:"custom",name:"exec",description,format:{type:"grammar",syntax:"lark",definition:"PUBLIC_EXACT_GRAMMAR"}},
  {type:"function",name:"wait",description:"Public wait controls",parameters:{type:"object",properties:{cell_id:{type:"string"}}}},
  {type:"namespace",name:"collaboration",tools:[{type:"function",name:"spawn_agent",description:"Unused in no-agent benchmark"}]}];
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),"public-tool-help-"));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return {...createToolCallRetainer({directory}),directory,enabled:true,profile:"public-swe-v1"};}
test("default leaves all tools unchanged; explicit profile retains exact original before deferral",t=>{
  assert.equal(deferNativeToolHelp(tools).tools,tools);const options=fixture(t),r=deferNativeToolHelp(tools,options);
  assert.equal(r.stats.deferred,true);assert.ok(r.stats.bytes_after<r.stats.bytes_before);assert.deepEqual(r.tools.map(t=>t.name),tools.map(t=>t.name));
  assert.deepEqual({...r.tools[0],description:tools[0].description},tools[0]);assert.equal(r.tools[1],tools[1]);
  assert.deepEqual(r.tools[2],tools[2]);
  assert.deepEqual(JSON.parse(options.readOriginal(r.stats.receipt)).tools,tools);
  for(const name of ["apply_patch","exec_command","view_image","write_stdin"])assert.match(r.tools[0].description,new RegExp(`Public exact ${name} signature and controls`));
  assert.match(r.tools[0].description,/Recover missing API details before guessing/);
});
test("unknown grammars, missing core declarations and failed recovery preserve full help",t=>{
  const options=fixture(t);
  for(const input of [[{...tools[0],format:{type:"text"}},tools[1]],[{...tools[0],description:"Unrecognized help"},tools[1]],
    [{...tools[0],description:description.replace('### `exec_command`','### `unknown`')},tools[1]]])assert.equal(deferNativeToolHelp(input,options).tools,input);
  const r=deferNativeToolHelp(tools,{...options,readOriginal:()=>"wrong"});assert.equal(r.tools,tools);assert.equal(r.stats.retention_failed,true);
  assert.throws(()=>deferNativeToolHelp(tools,{...options,profile:"arbitrary"}),/Explicit/);
});
test("exact full manifest remains recoverable through a new retainer instance",t=>{
  const options=fixture(t),r=deferNativeToolHelp(tools,options),reopened=createToolCallRetainer({directory:options.directory});
  assert.equal(JSON.parse(reopened.readOriginal(r.stats.receipt)).tools[0].description,description);
});
test('v2 checkpoint help is explicit and does not replace schemas or native core controls',t=>{
  const options={...fixture(t),profile:'public-swe-v2',typedOperations:true,checkpointOperations:true};
  const r=deferNativeToolHelp(tools,options);
  assert.equal(r.stats.deferred,true);assert.match(r.tools[0].description,/Bound checkpoint/);
  assert.match(r.tools[0].description,/review explicitly preauthorizes/);
  assert.match(r.tools[0].description,/Failure, unknown exit/);
  assert.deepEqual({...r.tools[0],description:tools[0].description},tools[0]);
  assert.deepEqual(JSON.parse(options.readOriginal(r.stats.receipt)).tools,tools);
  assert.throws(()=>deferNativeToolHelp(tools,{...options,profile:'public-swe-v1'}),/explicit v2/);
  assert.throws(()=>deferNativeToolHelp(tools,{...options,typedOperations:false}),/explicit v2/);
  const combined=deferNativeToolHelp(tools,{...options,checkpointPatches:true});
  assert.match(combined.tools[0].description,/Optional "patch"/);
  assert.ok(!r.tools[0].description.includes('Optional "patch"'));
  assert.deepEqual({...combined.tools[0],description:tools[0].description},tools[0]);
  assert.throws(()=>deferNativeToolHelp(tools,{...options,checkpointPatches:true,checkpointOperations:false}),/explicit checkpoint/);
});
