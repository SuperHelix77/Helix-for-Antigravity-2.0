import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {GoalEngine} from "../src/helix-goal-engine.mjs";
import {HelixEvidence,createCompactReceipt,digest} from "../src/helix-evidence.mjs";
import {HelixToolFlow} from "../src/helix-tool-flow.mjs";
import {parseTestReport,compareTestReports} from "../src/helix-evidence-delta.mjs";

const report = (tests, extra={}) => ({schema:"helix.tests.v1",scope:"current-goal",suite:"unit",selection:digest("selected"),environment:digest("env"),runner:digest("runner"),source_revision:digest("source"),complete:true,tests,...extra});
const bytes = value => Buffer.from(JSON.stringify(value));
function fixture(t) {
  const root=mkdtempSync(path.join(os.tmpdir(),"helix-delta-")),directory=path.join(root,"store"),engines=[];
  t.after(()=>{for(const engine of engines)try{engine.close();}catch{/* Already closed. */}rmSync(root,{recursive:true,force:true});});
  return {root,open(){const engine=new GoalEngine({directory});engines.push(engine);return {engine,evidence:new HelixEvidence(engine)};}};
}
function archiveReport(engine, value, extra={}) {
  const exit_code=value.tests.some(entry=>["fail","error"].includes(entry.status))?1:0;
  return createCompactReceipt(engine,{argv:[process.execPath,"tests.cjs"],stdout:engine.archive(bytes(value)),stderr:engine.archive(Buffer.alloc(0)),exit_code,signal:null,failure:null,...extra});
}

test("identity delta: failures to pass count, failures to skip do not, order is irrelevant",()=>{
  const old=report([{id:"a",status:"fail"},{id:"b",status:"fail"},{id:"c",status:"pass"},{id:"d",status:"error",traceback:"old"}]);
  const next=report([{id:"d",status:"error",traceback:"new"},{id:"c",status:"fail"},{id:"b",status:"skip"},{id:"a",status:"pass"}],{source_revision:digest("patch")});
  const delta=compareTestReports(parseTestReport(bytes(old)),parseTestReport(bytes(next)));
  assert.deepEqual(delta.resolved,["a"]);assert.deepEqual(delta.introduced,["c"]);
  assert.deepEqual(delta.remaining.map(entry=>entry.id),["d","c"]);
  assert.equal(delta.changed.length,4);assert.equal(delta.semantic_success,null);
});

test("changed identities or any compatibility fingerprint returns a boundary",()=>{
  const old=report([{id:"a",status:"fail"}]);
  for(const key of ["scope","suite","selection","environment","runner"]){
    const value=["scope","suite"].includes(key)?"another":digest("another");
    assert.equal(compareTestReports(old,{...old,[key]:value}).compatible,false);
  }
  assert.equal(compareTestReports(old,report([{id:"b",status:"pass"}])).compatible,false);
});

test("15 failing IDs to 3 proves exactly 12 observed resolutions only with complete identical coverage",()=>{
  const before=report(Array.from({length:30},(_,i)=>({id:`test_${i}`,status:i<15?"fail":"pass"})));
  const after=report(before.tests.map((entry,i)=>({...entry,status:i<3?"fail":"pass"})));
  const delta=compareTestReports(before,after);
  assert.equal(delta.resolved.length,12);assert.equal(delta.remaining.length,3);assert.equal(delta.total,30);
  assert.equal(compareTestReports(before,{...after,tests:after.tests.slice(0,3)}).compatible,false);
});

test("malformed, incomplete, duplicate or unsupported reports cannot produce deltas",()=>{
  const old=report([{id:"a",status:"fail"}]);
  for(const value of [{...old,complete:false},{...old,extra:true},{...old,source_revision:"a".repeat(41)},
    {...old,tests:[{id:"a",status:"unknown"}]},{...old,tests:[old.tests[0],old.tests[0]]}])assert.equal(parseTestReport(bytes(value)),null);
  assert.equal(parseTestReport(Buffer.from([255])),null);
  assert.equal(parseTestReport(Buffer.from("# pass 15\n# fail 3")),null);
});

test("exact observations and large Unicode traceback survive restart; visible delta stays bounded",t=>{
  const f=fixture(t);let {engine,evidence}=f.open();
  const trace="\u00e7\u0131\u011f\r\n".repeat(10000),old=report([{id:"a",status:"fail",traceback:trace}]),next=report([{id:"a",status:"error",traceback:trace+"end"}]);
  const before=archiveReport(engine,old),after=archiveReport(engine,next),delta=evidence.delta({before,after});
  assert.equal(delta.compatible,true);assert.ok(Buffer.byteLength(delta.text)<=2400);
  const raw=engine.objectJSON(after).stdout.raw;
  engine.close();({engine,evidence}=f.open());
  assert.equal(evidence.delta({before,after}).receipt,delta.receipt);
  assert.deepEqual(readFileSync(path.join(engine.objects,raw)),bytes(next));
  assert.equal(engine.objectJSON(delta.receipt).remaining[0].traceback,trace+"end");
});

test("interruption, changed argv, unsupported logs and contradictory exit refuse resolved claims",t=>{
  const {engine,evidence}=fixture(t).open(),old=report([{id:"a",status:"fail"}]),next=report([{id:"a",status:"pass"}]);
  const before=archiveReport(engine,old);
  for(const extra of [{failure:"timeout"},{signal:"SIGTERM"},{exit_code:9},{argv:["other"]},{exit_code:1},
    {stdout:engine.archive(Buffer.from("1 passed"))}]){
    const after=archiveReport(engine,next,extra),delta=evidence.delta({before,after});
    assert.equal(delta.compatible,false);assert.match(delta.text,/No resolved-test claim/);
  }
});

test("tampered report is rejected, not converted into a trustworthy fallback",t=>{
  const {engine,evidence}=fixture(t).open(),before=archiveReport(engine,report([{id:"a",status:"fail"}])),after=archiveReport(engine,report([{id:"a",status:"pass"}]));
  writeFileSync(path.join(engine.objects,engine.objectJSON(after).stdout.raw),"tampered");
  assert.throws(()=>evidence.delta({before,after}),/integrity/);
});

test("one Flow command waits, archives and delivers delta; replay does not execute again",async t=>{
  const f=fixture(t);const {engine,evidence}=f.open(),flow=new HelixToolFlow(engine,evidence);
  writeFileSync(path.join(f.root,"tests.cjs"),"const fs=require('fs');fs.appendFileSync('executions','1');const r=JSON.parse(fs.readFileSync('report.json'));console.log(JSON.stringify(r));process.exit(r.tests.some(t=>['fail','error'].includes(t.status))?1:0)");
  const before=archiveReport(engine,report([{id:"a",status:"fail"}]));
  writeFileSync(path.join(f.root,"report.json"),bytes(report([{id:"a",status:"pass"}])));
  const recipe=flow.register({project:f.root,name:"test-delta",version:"1",nodes:[
    {id:"run",kind:"command",argv:[process.execPath,"tests.cjs"],next:"delta"},
    {id:"delta",kind:"delta",from:"run",before,next:"end"},{id:"end",kind:"finish"}]});
  const args={project:f.root,session:"current-goal",request_id:"execute",flow:recipe.flow};
  const result=await flow.run(args);
  assert.equal(result.finished,true);assert.equal(result.nodes_executed,3);assert.equal(result.controller_model_calls,0);
  assert.match(result.summaries[0],/1 failures now reported passing/);
  assert.equal((await flow.run(args)).finished,true);
  assert.equal(readFileSync(path.join(f.root,"executions"),"utf8"),"1");
});

test("incompatible delta stops Flow before a downstream mutation",async t=>{
  const f=fixture(t),{engine,evidence}=f.open(),flow=new HelixToolFlow(engine,evidence);
  writeFileSync(path.join(f.root,"tests.cjs"),"console.log(require('fs').readFileSync('report.json','utf8'))");
  const before=archiveReport(engine,report([{id:"a",status:"fail"}]));
  writeFileSync(path.join(f.root,"report.json"),bytes(report([{id:"b",status:"pass"}])));
  const recipe=flow.register({project:f.root,name:"reject-delta",version:"1",nodes:[
    {id:"run",kind:"command",argv:[process.execPath,"tests.cjs"],next:"delta"},
    {id:"delta",kind:"delta",from:"run",before,next:"never"},
    {id:"never",kind:"command",argv:[process.execPath,"-e","require('fs').writeFileSync('bad','ran')"],next:"end"},
    {id:"end",kind:"finish"}]});
  const result=await flow.run({project:f.root,session:"current-goal",request_id:"execute",flow:recipe.flow});
  assert.equal(result.finished,false);assert.match(result.boundary,/identities changed/);
  assert.equal(result.nodes_executed,2);
  assert.throws(()=>readFileSync(path.join(f.root,"bad")),/ENOENT/);
});
