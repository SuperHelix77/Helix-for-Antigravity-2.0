import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {GoalEngine} from "../src/helix-goal-engine.mjs";
import {HelixEvidence} from "../src/helix-evidence.mjs";
import {HelixToolFlow} from "../src/helix-tool-flow.mjs";
const fixture=(options={})=>{
  const project=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"flow-admission-")));
  const engine=new GoalEngine({directory:path.join(project,"store")});
  const flow=new HelixToolFlow(engine,new HelixEvidence(engine),options);
  fs.writeFileSync(path.join(project,"public-input"),"public fixture");
  return {project,engine,flow,close:()=>{engine.close();fs.rmSync(project,{recursive:true,force:true});}};
};
const command=(extra={})=>({id:"command",kind:"command",argv:[process.execPath,"-e","require('fs').appendFileSync('counter','x')"],next:"end",...extra});
const run=async(f,nodes)=>{const registered=f.flow.register({project:f.project,name:"fixture",version:"1",nodes});return f.flow.run({project:f.project,session:"explicit-current-task",request_id:"run",flow:registered.flow});};
test("semantic classification stops before command execution",async()=>{
  const f=fixture();try{const r=await run(f,[command({execution_class:"semantic"}),{id:"end",kind:"finish"}]);assert.equal(r.finished,false);assert.match(r.boundary,/Semantic decision/);assert.equal(fs.existsSync(path.join(f.project,"counter")),false);assert.equal(r.controller_model_calls,0);}finally{f.close();}
});
test("conditional command executes only after known declared successful exit",async()=>{
  const f=fixture();try{const r=await run(f,[{id:"check",kind:"command",argv:[process.execPath,"-e","console.log('known')"],next:"command"},command({execution_class:"conditional",guard:{from:"check",exit_code:0}}),{id:"end",kind:"finish"}]);assert.equal(r.finished,true);assert.equal(fs.readFileSync(path.join(f.project,"counter"),"utf8"),"x");assert.equal(r.admissions[1].classification,"conditional");}finally{f.close();}
});
test("forward or unavailable guard escalates without execution",async()=>{
  const f=fixture();try{const r=await run(f,[command({execution_class:"conditional",guard:{from:"end",exit_code:0}}),{id:"end",kind:"finish"}]);assert.equal(r.finished,false);assert.equal(fs.existsSync(path.join(f.project,"counter")),false);assert.match(r.boundary,/guard unavailable/);}finally{f.close();}
});
test("remote artifacts require a server-owned immutable namespace proof",async()=>{
  for(const options of [{},{verifyVisibility:async()=>({visible:true,immutable:false})}]){
    const f=fixture(options);try{const r=await run(f,[command({executor:"test-container",artifacts:["public-input"]}),{id:"end",kind:"finish"}]);assert.equal(r.finished,false);assert.equal(fs.existsSync(path.join(f.project,"counter")),false);}finally{f.close();}
  }
});
test("actual adapter can qualify declared byte-identical immutable visibility",async()=>{
  let probes=0;const f=fixture({verifyVisibility:async({executor,artifact})=>{probes++;return {executor,sha256:artifact.sha256,visible:true,immutable:true};}});
  try{const r=await run(f,[command({executor:"verified-public-container",artifacts:["public-input"]}),{id:"end",kind:"finish"}]);assert.equal(r.finished,true);assert.equal(probes,1);assert.equal(r.admissions[0].verified_artifacts,1);}finally{f.close();}
});
test("changed artifact invalidates admission before any mutation",async()=>{
  const f=fixture();try{const r=f.flow.register({project:f.project,name:"changed",version:"1",nodes:[command({artifacts:["public-input"]}),{id:"end",kind:"finish"}]});fs.writeFileSync(path.join(f.project,"public-input"),"changed");const result=await f.flow.run({project:f.project,session:"current",request_id:"run",flow:r.flow});assert.equal(result.finished,false);assert.match(result.boundary,/Artifact bytes changed/);assert.equal(fs.existsSync(path.join(f.project,"counter")),false);}finally{f.close();}
});
test("artifact escape, invented proof fields and nonzero conditional guards rejected",()=>{
  const f=fixture();try{
    for(const extra of [{artifacts:["../outside"]},{visibility_proof:{visible:true}},{execution_class:"conditional",guard:{from:"end",exit_code:1}}])assert.throws(()=>f.flow.register({project:f.project,name:"invalid",version:"1",nodes:[command(extra),{id:"end",kind:"finish"}]}));
  }finally{f.close();}
});
test("elapsed budget cancels an unresponsive visibility probe without running command",async()=>{
  const f=fixture({verifyVisibility:()=>new Promise(()=>{})});try{
    const registered=f.flow.register({project:f.project,name:"blocked-probe",version:"1",max_elapsed_ms:30,nodes:[command({executor:"remote",artifacts:["public-input"]}),{id:"end",kind:"finish"}]});
    const result=await f.flow.run({project:f.project,session:"current",request_id:"run",flow:registered.flow});
    assert.equal(result.finished,false);assert.match(result.boundary,/probe interrupted/);assert.equal(fs.existsSync(path.join(f.project,"counter")),false);
  }finally{f.close();}
});
