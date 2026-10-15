import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {GoalEngine} from "../src/helix-goal-engine.mjs";
import {HelixEvidence} from "../src/helix-evidence.mjs";
import {HelixToolFlow} from "../src/helix-tool-flow.mjs";
import {execFileSync} from "node:child_process";

const fixture=()=>{
  const project=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"helix-tool-flow-")));
  const engine=new GoalEngine({directory:path.join(project,"store")});
  return {project,engine,flow:new HelixToolFlow(engine,new HelixEvidence(engine)),close:()=>{engine.close();fs.rmSync(project,{recursive:true,force:true});}};
};
test("failed check automatically yields verified receipt and exact indexed tail in one invocation, no model calls",async()=>{
  const f=fixture();try{
    fs.writeFileSync(path.join(f.project,"fixed-input"),"public fixed input");
    const nodes=[{id:"test",kind:"command",argv:[process.execPath,"-e",`console.log(${JSON.stringify("first\nsecond\nFAILED public check")});process.exit(1)`],next:"pick"},
      {id:"pick",kind:"branch",from:"test",zero:"ok",nonzero:"receipt"},
      {id:"receipt",kind:"receipt",from:"test",next:"index"},
      {id:"index",kind:"index",from:"test",channel:"stdout",next:"tail"},
      {id:"tail",kind:"ranges",from:"index",tail:2,next:"failed"},
      {id:"failed",kind:"finish"},{id:"ok",kind:"finish"}];
    const registered=f.flow.register({project:f.project,name:"check-diagnostics",version:"1",nodes,bind:["fixed-input"]});
    assert.equal(registered.executed,false);
    const args={project:f.project,session:"current-authorized-task",request_id:"run",flow:registered.flow};
    const first=await f.flow.run(args);
    assert.equal(first.controller_model_calls,0);assert.equal(first.finished,true);assert.equal(first.execution_failed,true);
    assert.equal(first.semantic_success,null);
    assert.match(first.summaries.join("\n"),/second\nFAILED public check/u);
    const trace=f.engine.objectJSON(first.receipt).trace;
    const index=trace.find(node=>node.kind==="index").value;
    assert.equal(f.engine.read(index.source,{limit:24000}).content,"first\nsecond\nFAILED public check\n");
    const rerun=await f.flow.run(args);assert.equal(rerun.finished,true);
    assert.equal(f.engine.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='command_started'").get().n,1);
  }finally{f.close();}
});
test("positive branch batches declared tools, but exit zero is not semantic success",async()=>{
  const f=fixture();try{
    const registered=f.flow.register({project:f.project,name:"success",version:"1",nodes:[
      {id:"one",kind:"command",argv:[process.execPath,"-e","console.log('0 semantic claim');"],next:"branch"},
      {id:"branch",kind:"branch",from:"one",zero:"two",nonzero:"end"},
      {id:"two",kind:"command",argv:[process.execPath,"-e","console.log('declared second tool');"],next:"receipt"},
      {id:"receipt",kind:"receipt",from:"two",next:"end"},{id:"end",kind:"finish"}]});
    const result=await f.flow.run({project:f.project,session:"authorized",request_id:"run",flow:registered.flow});
    assert.equal(result.finished,true);assert.equal(result.semantic_success,null);
    assert.equal(f.engine.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='command_started'").get().n,2);
  }finally{f.close();}
});
test("failed commands cannot trigger retries or mutations even on an explicitly selected branch",async()=>{
  const f=fixture();try{
    const registered=f.flow.register({project:f.project,name:"failure",version:"1",nodes:[
      {id:"one",kind:"command",argv:[process.execPath,"-e","process.exit(1)"],next:"branch"},
      {id:"branch",kind:"branch",from:"one",zero:"end",nonzero:"retry"},
      {id:"retry",kind:"command",argv:[process.execPath,"-e","require('fs').writeFileSync('must-not-exist','bad')"],next:"end"},
      {id:"end",kind:"finish"}]});
    const result=await f.flow.run({project:f.project,session:"authorized",request_id:"run",flow:registered.flow});
    assert.equal(result.finished,false);assert.match(result.boundary,/reviewed retry/u);
    assert.equal(fs.existsSync(path.join(f.project,"must-not-exist")),false);
  }finally{f.close();}
});
test("changed fixed inputs and invalid graphs fail without hidden command execution",async()=>{
  const f=fixture();try{
    fs.writeFileSync(path.join(f.project,"fixed"),"before");
    const command={id:"cmd",kind:"command",argv:[process.execPath,"-e","console.log('public')"],next:"end"};
    const args={project:f.project,name:"bound",version:"1",nodes:[command,{id:"end",kind:"finish"}],bind:["fixed"]};
    const registered=f.flow.register(args);fs.writeFileSync(path.join(f.project,"fixed"),"changed");
    const result=await f.flow.run({project:f.project,session:"authorized",request_id:"run",flow:registered.flow});
    assert.match(result.boundary,/changed|stale/iu);
    assert.equal(f.engine.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='command_started'").get().n,0);
    assert.throws(()=>f.flow.register({...args,name:"cycle",nodes:[{...command,next:"cmd"}]}),/cycles/u);
    assert.throws(()=>f.flow.register({...args,name:"missing",nodes:[command]}),/Unknown/u);
    assert.throws(()=>f.flow.register({...args,name:"bad",nodes:[{...command,model:"anything"},{id:"end",kind:"finish"}]}),/fields/u);
  }finally{f.close();}
});
test("operation budget and cancellation stop before a downstream mutation",async()=>{
  const f=fixture();try{
    const nodes=[{id:"one",kind:"command",argv:[process.execPath,"-e","console.log('public')"],next:"two"},
      {id:"two",kind:"command",argv:[process.execPath,"-e","require('fs').writeFileSync('must-not-exist','bad')"],next:"end"},{id:"end",kind:"finish"}];
    const bounded=f.flow.register({project:f.project,name:"bounded",version:"1",nodes,max_operations:1});
    const result=await f.flow.run({project:f.project,session:"authorized",request_id:"run",flow:bounded.flow});
    assert.match(result.boundary,/bound reached/u);assert.equal(fs.existsSync(path.join(f.project,"must-not-exist")),false);
    const cancelled=new AbortController();cancelled.abort();
    const stopped=await f.flow.run({project:f.project,session:"authorized",request_id:"cancel",flow:bounded.flow},{signal:cancelled.signal});
    assert.equal(stopped.nodes_executed,0);assert.equal(stopped.boundary,"interrupted");
  }finally{f.close();}
});
test("elapsed budget propagates to the live command and retains interruption evidence",async()=>{
  const f=fixture();try{
    const bounded=f.flow.register({project:f.project,name:"timed",version:"1",max_elapsed_ms:80,nodes:[
      {id:"wait",kind:"command",argv:[process.execPath,"-e","console.log('started');setTimeout(()=>{},5000)"],next:"end"},{id:"end",kind:"finish"}]});
    const started=Date.now();
    const result=await f.flow.run({project:f.project,session:"authorized",request_id:"run",flow:bounded.flow});
    assert.ok(Date.now()-started<2000);assert.equal(result.finished,false);
    assert.match(result.boundary,/elapsed/u);
    const trace=f.engine.objectJSON(result.receipt).trace;
    assert.ok(trace[0].value.failure);assert.equal(trace[0].value.mechanical_success,false);
  }finally{f.close();}
});
test("a changed Git revision escalates before execution",async()=>{
  const f=fixture();try{
    const git=args=>execFileSync("git",["-C",f.project,...args],{stdio:"pipe"});
    git(["init","--quiet"]);git(["-c","user.name=Public Test","-c","user.email=public@example.invalid","commit","--quiet","--allow-empty","-m","initial"]);
    const registered=f.flow.register({project:f.project,name:"revision",version:"1",nodes:[
      {id:"one",kind:"command",argv:[process.execPath,"-e","console.log('public')"],next:"end"},{id:"end",kind:"finish"}]});
    git(["-c","user.name=Public Test","-c","user.email=public@example.invalid","commit","--quiet","--allow-empty","-m","changed"]);
    const result=await f.flow.run({project:f.project,session:"authorized",request_id:"run",flow:registered.flow});
    assert.match(result.boundary,/revision changed/u);assert.equal(result.nodes_executed,0);
  }finally{f.close();}
});
