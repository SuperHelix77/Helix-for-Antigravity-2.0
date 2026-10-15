import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {GoalEngine} from "../src/helix-goal-engine.mjs";
import {initialToolObservation} from "../src/helix-initial-observation.mjs";

function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),"public-observation-"));let engine=new GoalEngine({directory});t.after(()=>{engine.close();fs.rmSync(directory,{recursive:true,force:true});});return {get engine(){return engine;},restart(){engine.close();engine=new GoalEngine({directory});}};}
const output=()=>({stdout:"test_public.py::test_case PASSED\n".repeat(250)+"================ 250 passed in 0.02s ================\n",stderr:"",exit_code:0,signal:null,tooLarge:false});
test("successful large test observation is shorter; captured original recovers after restart",t=>{
  const f=fixture(t),raw=output(),r=initialToolObservation(f.engine,raw,{kind:"test"});
  assert.equal(r.stats.projected,true);assert.ok(r.stats.bytes_after<r.stats.bytes_before);
  assert.match(r.result.stdout,/250/);assert.match(r.result.stdout,/semantic result unknown/);
  const packet=f.engine.objectJSON(r.stats.receipt);f.restart();
  assert.equal(f.engine.read(packet.stdout.raw,{limit:24000}).content,raw.stdout);
  assert.equal(r.result.exit_code,raw.exit_code);
});
test("failed, interrupted, partial, short and stderr-bearing observations remain literal",t=>{
  const f=fixture(t);
  for(const delta of [{exit_code:1},{signal:"SIGTERM"},{tooLarge:true},{failure:"timeout"},{stderr:"warning: inspect this"},{stdout:"1 passed"}]){
    const raw={...output(),...delta},r=initialToolObservation(f.engine,raw,{kind:"test"});
    assert.equal(r.stats.projected,false);assert.equal(r.result.exit_code,raw.exit_code);assert.equal(r.result.stderr,raw.stderr);
    if(r.stats.raw){assert.ok(r.result.stdout.endsWith(raw.stdout));assert.equal(f.engine.read(r.stats.raw.stdout,{limit:24000}).content,raw.stdout);assert.ok(r.stats.bytes_after>r.stats.bytes_before);}
    else assert.equal(r.result,raw);
  }
});
test("unknown/source text and contradictory failure summaries stay literal",t=>{
  const f=fixture(t);
  for(const stdout of ["public source code\n".repeat(1000),"public log\n".repeat(1000)+"================ 2 failed, 248 passed ================\n"]){
    const raw={...output(),stdout},r=initialToolObservation(f.engine,raw,{kind:"test"});
    assert.equal(r.stats.projected,false);assert.ok(r.result.stdout.endsWith(raw.stdout));assert.equal(f.engine.read(r.stats.raw.stdout,{limit:24000}).content,raw.stdout);
  }
  const raw=output();assert.equal(initialToolObservation(f.engine,raw).result,raw);
  assert.throws(()=>initialToolObservation(f.engine,output(),{budget:9000}),/budget/);
});
