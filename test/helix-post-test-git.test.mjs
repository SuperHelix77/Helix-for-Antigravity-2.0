import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {GoalEngine} from '../src/helix-goal-engine.mjs';
import {postTestGit,postTestGitText,initialRuntimeFact} from '../src/helix-post-test-git.mjs';

function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'post-test-git-')),project=path.join(directory,'repo'),store=path.join(directory,'evidence');fs.mkdirSync(project);
  const git=args=>{const r=spawnSync('git',args,{cwd:project,encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git(['init','-q']);git(['config','user.name','Public Fixture']);git(['config','user.email','fixture@localhost']);
  fs.writeFileSync(path.join(project,'source.py'),'value = 1\n');git(['add','.']);git(['commit','-qm','public base']);
  const head=git(['rev-parse','HEAD']),engine=new GoalEngine({directory:store}),executed=[];
  const execute=async op=>{
    executed.push(op);const r=spawnSync(op.argv[0],op.argv.slice(1),{cwd:project,encoding:'buffer',timeout:op.timeout_ms,
      env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_OPTIONAL_LOCKS:'0'}});
    return {exit_code:r.status,signal:r.signal,stdout:r.stdout.toString(),stderr:r.stderr.toString(),stdout_raw:r.stdout,stderr_raw:r.stderr};
  };
  const run=options=>postTestGit({engine,execute,currentTask:()=>1,task:1,expectedHead:head,...options});
  t.after(()=>{engine.close();fs.rmSync(directory,{recursive:true,force:true});});
  return {directory,project,store,engine,head,execute,executed,run,git};
}
test('revision-bracketed inspection returns the bound tracked diff without executing source or changing files',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.project,'source.py'),'value = 2\n');fs.writeFileSync(path.join(f.project,'untracked.py'),'UNTRACKED_BODY = 7\n');
  const before=fs.readFileSync(path.join(f.project,'source.py')),packet=await f.run(),text=postTestGitText(f.engine,packet);
  assert.equal(packet.boundary,null);assert.equal(packet.controller_operations,5);assert.equal(packet.model_calls,0);assert.equal(packet.semantic_success,null);
  assert.deepEqual(f.executed.map(x=>x.id),['head','check','status','diff','head-final']);assert.match(text,/\+value = 2/);
  for(const op of f.executed.filter(x=>['check','diff'].includes(x.id))){assert.ok(op.argv.includes(f.head));assert.ok(!op.argv.includes('HEAD'));}
  assert.match(text,/untracked.py/);assert.ok(!text.includes('UNTRACKED_BODY'));assert.match(text,/untracked bodies are not captured/);
  assert.deepEqual(fs.readFileSync(path.join(f.project,'source.py')),before);assert.equal(f.engine.db.prepare('SELECT count(*) n FROM goals').get().n,0);
  const cold=new GoalEngine({directory:f.store});try{
    const ref=/inspection packet: context raw receipt ([a-f0-9]{64})/.exec(text)[1];assert.deepEqual(cold.objectJSON(ref),packet);
    const diff=packet.observations.find(x=>x.id==='diff');assert.match(cold.read(diff.stdout,{limit:24000}).content,/\+value = 2/);
  }finally{cold.close();}
});
test('HEAD drift and whitespace failures stop at a typed boundary without retry or downstream work',async t=>{
  const f=fixture(t);const changed=await f.run({expectedHead:'0'.repeat(40)});assert.match(changed.boundary,/HEAD changed/);assert.equal(changed.observations.length,1);
  fs.writeFileSync(path.join(f.project,'source.py'),'value = 2  \n');const failed=await f.run();assert.match(failed.boundary,/failed/);
  assert.equal(failed.observations.length,2);assert.equal(failed.observations[1].exit_code,2);
});
test('mid-chain HEAD drift cannot qualify pinned inspection evidence as current',async t=>{
  const f=fixture(t);let changedHead;
  const packet=await f.run({execute:async op=>{
    const result=await f.execute(op);
    if(op.id==='head'){
      f.git(['commit','--allow-empty','-qm','synthetic concurrent commit']);
      changedHead=f.git(['rev-parse','HEAD']);
    }
    return result;
  }});
  assert.notEqual(changedHead,f.head);assert.match(packet.boundary,/HEAD changed/);
  assert.equal(packet.expected_head,f.head);assert.equal(packet.observations.at(-1).id,'head-final');
  assert.equal(f.engine.read(packet.observations.at(-1).stdout).content.trim(),changedHead);
  for(const op of f.executed.filter(x=>['check','diff'].includes(x.id)))assert.ok(op.argv.includes(f.head));
  assert.equal(packet.semantic_success,null);
});
test('scope changes, cancellation and unknown process results cannot advance the chain',async t=>{
  const f=fixture(t);assert.equal((await f.run({currentTask:()=>2})).observations.length,0);
  const controller=new AbortController();controller.abort();assert.equal((await f.run({signal:controller.signal})).observations.length,0);
  let calls=0;const changed=await f.run({currentTask:()=>calls?2:1,execute:async op=>{calls++;return {exit_code:0,stdout:f.head+'\n',stderr:''};}});
  assert.equal(changed.observations.length,1);assert.match(changed.boundary,/task changed/);
  const unknown=await f.run({execute:async()=>({stdout:'partial',stderr:'',exit_code:null})});assert.match(unknown.boundary,/unknown/);assert.equal(unknown.observations.length,1);
});
test('views are bounded while full packet and raw binary observations remain recoverable',async t=>{
  const f=fixture(t);let calls=0;
  const packet=await f.run({execute:async op=>{calls++;const bytes=op.id.startsWith('head')?Buffer.from(f.head+'\n'):Buffer.from([0xff,0xfe,0x00]);
    return {exit_code:0,stdout:bytes.toString(),stderr:'',stdout_raw:bytes};}});
  const view=postTestGitText(f.engine,packet,{budget:1024});assert.ok(Buffer.byteLength(view)<=1024);assert.ok(view.includes('inspection packet'));
  const raw=f.engine.read(packet.observations[1].stdout,{limit:24000});assert.deepEqual(Buffer.from(raw.content,raw.encoding==='base64'?'base64':'utf8'),Buffer.from([0xff,0xfe,0x00]));
  assert.equal(calls,5);
});
test('runtime facts apply only to the exact verified first-issue image, not later issues',()=>{
  const runtime={python:'3.9.20',pytest_available:false,bundled_runner:'bin/test',verified_image:'sha256:public'};
  assert.equal(initialRuntimeFact(runtime,{order:1,imageId:'sha256:public'}).pytest_available,false);
  assert.equal(initialRuntimeFact(runtime,{order:2,imageId:'sha256:other'}),null);
  assert.throws(()=>initialRuntimeFact(runtime,{order:1,imageId:'sha256:other'}));
});
