import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {GoalEngine} from '../src/helix-goal-engine.mjs';
import {HelixEvidence,digest} from '../src/helix-evidence.mjs';
import {patchEvidenceRequest,patchFailureEvidence,renderPatchFailureEvidence} from '../src/helix-patch-evidence.mjs';
import {NativeFunctionBridge,nativePatchLiteral,nativePatchLiterals} from '../src/helix-native-function-bridge.mjs';
import {createToolCallRetainer} from '../src/tool-call-retention.mjs';
function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'public-patch-evidence-')),project=path.join(directory,'repo'),store=path.join(directory,'store');
  fs.mkdirSync(project);const texts={a:'from public import First, Second\r\n\r\nvalue = 7\r\n',b:'import public_other\n\nraise RuntimeError("MUST_NOT_EXECUTE")\n'};
  for(const [file,text] of Object.entries(texts))fs.writeFileSync(path.join(project,file+'.py'),text);
  const engine=new GoalEngine({directory:store}),evidence=new HelixEvidence(engine),binding={project,evidence:store,collector:'/engine/bin/helix-patch-evidence.mjs'};
  const patch=`*** Begin Patch\n*** Update File: ${project}/a.py\n@@\n-from public import First\n+from public import Third\n*** Update File: ${project}/b.py\n@@\n-import missing\n+import repaired\n*** End Patch`;
  t.after(()=>{engine.close();fs.rmSync(directory,{recursive:true,force:true});});
  return {directory,project,store,texts,engine,evidence,binding,patch};
}
test('selectors are restricted to declared absolute current-project Python updates; no authority from other patch forms',t=>{
  const f=fixture(t),r=patchEvidenceRequest(f.patch,f.binding);assert.deepEqual(r.files.map(r=>r.file),['a.py','b.py']);
  for(const patch of [f.patch.replace(f.project+'/a.py','/outside/a.py'),f.patch.replace('/a.py','/../a.py'),
    f.patch.replace('*** Update File','*** Delete File'),f.patch.replace('/b.py','/.private.py'),f.patch.replace('/b.py','/a.py'),
    f.patch+'\ntext(1)',f.patch.replace('/a.py','/a.js')])assert.equal(patchEvidenceRequest(patch,f.binding),null);
  assert.equal(patchEvidenceRequest(f.patch,{...f.binding,evidence:'relative'}),null);
  assert.equal(nativePatchLiteral(`text(await tools.apply_patch(${JSON.stringify(f.patch)}));`),f.patch);
  assert.equal(nativePatchLiteral(`text(await tools.apply_patch(${JSON.stringify(f.patch)}));text(1);`),null);
});
test('all declared files yield exact imports and missing-anchor counts; source and indexed bytes recover after edits and restart',t=>{
  const f=fixture(t),r=patchEvidenceRequest(f.patch,f.binding),p=patchFailureEvidence({...r,engine:f.engine,evidence:f.evidence});
  assert.equal(p.files.length,2);assert.equal(p.patch_retries,0);assert.equal(p.semantic_success,null);
  assert.ok(renderPatchFailureEvidence(p).includes('from public import First, Second\r\n'));
  assert.ok(renderPatchFailureEvidence(p).includes('import public_other'));assert.ok(!renderPatchFailureEvidence(p).includes('MUST_NOT_EXECUTE'));
  assert.equal(p.files[0].anchor_counts.missing,1);assert.equal(f.engine.db.prepare('SELECT count(*) n FROM goals').get().n,0);
  for(const r of p.files)fs.writeFileSync(path.join(f.project,r.file),'# changed\n');
  const program=`import {GoalEngine} from ${JSON.stringify(new URL('../src/helix-goal-engine.mjs',import.meta.url).href)};
import {HelixEvidence} from ${JSON.stringify(new URL('../src/helix-evidence.mjs',import.meta.url).href)};
const e=new GoalEngine({directory:process.argv[1]}),p=JSON.parse(process.argv[2]);try{console.log(JSON.stringify(p.files.map(r=>({raw:e.read(r.source,{limit:24000}).content,ranges:new HelixEvidence(e).ranges({source:r.source,index:r.index,ranges:r.ranges.map(({start,end})=>({start,end})),budget:24000})}))));}finally{e.close();}`;
  const out=spawnSync(process.execPath,['--input-type=module','-e',program,f.store,JSON.stringify(p)],{encoding:'utf8'});
  assert.equal(out.status,0,out.stderr);const restored=JSON.parse(out.stdout);
  for(const [i,r] of restored.entries()){assert.equal(r.raw,f.texts[['a','b'][i]]);assert.deepEqual(r.ranges,p.files[i].ranges);}
});
test('unsafe, unavailable, oversized, ambiguous, syntax and encoding states never fabricate source or execute it',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.directory,'outside.py'),'PRIVATE_OUTSIDE\n');fs.symlinkSync(path.join(f.directory,'outside.py'),path.join(f.project,'link.py'));
  for(const [file,bytes] of [['binary.py',Buffer.from([255])],['broken.py',Buffer.from('def broken(:\n')],['large.py',Buffer.alloc(513*1024,65)]])fs.writeFileSync(path.join(f.project,file),bytes);
  for(const file of ['link.py','missing.py','binary.py','broken.py','large.py']){
    const p=patchFailureEvidence({project:f.project,files:[{file,anchors:[]}],engine:f.engine,evidence:f.evidence});assert.ok(p.files[0].boundary);
    if(['binary.py','broken.py'].includes(file))assert.ok(p.files[0].source);else assert.equal(p.files[0].source,null);
    assert.ok(!renderPatchFailureEvidence(p).includes('PRIVATE_OUTSIDE'));
  }
  assert.throws(()=>patchFailureEvidence({project:f.project,files:[{file:'../outside.py',anchors:[]}],engine:f.engine,evidence:f.evidence}));
  fs.writeFileSync(path.join(f.project,'repeat.py'),'value = 1\nvalue = 1\n');
  const p=patchFailureEvidence({project:f.project,files:[{file:'repeat.py',anchors:['value = 1']}],engine:f.engine,evidence:f.evidence});
  assert.equal(p.files[0].anchor_counts.ambiguous,1);assert.equal(p.files[0].ranges[0].content,'value = 1\nvalue = 1\n');
});
test('default-off and unrelated errors preserve native behavior; known mismatch makes one patch attempt and one read',async t=>{
  const f=fixture(t),retainer=createToolCallRetainer({directory:path.join(f.directory,'programs')}),original={type:'custom_tool_call',name:'exec',call_id:'patch-public',input:`text(await tools.apply_patch(${JSON.stringify(f.patch)}));`};
  assert.equal(new NativeFunctionBridge(retainer).toNative(original,{task:'1'}),original);
  const bridge=new NativeFunctionBridge({...retainer,delegatePatchEvidence:true,patchEvidenceBinding:()=>f.binding});
  const wire=bridge.toNative(original,{task:'1'}),AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  for(const mode of ['success','mismatch','mismatch-string','unrelated']){
    let patches=0,reads=0;const output=[];
    const message=mode.startsWith('mismatch')?'apply_patch verification failed: Failed to find expected lines in '+f.project+'/a.py:\nfrom public import First':'PUBLIC_UNRELATED_ERROR';
    const e=mode==='mismatch-string'?message:new Error(message);
    const run=()=>new AsyncFunction('tools','text','exit',wire.input)({apply_patch:async bytes=>{patches++;assert.equal(bytes,f.patch);if(mode!=='success')throw e;return {};},
      exec_command:async args=>{reads++;assert.ok(args.cmd.includes('helix-patch-evidence.mjs'));return {exit_code:0,output:'PUBLIC_EXACT_CONTEXT'};}},v=>output.push(v),()=>{throw new Error('PUBLIC_BOUNDARY');});
    if(mode==='unrelated')await assert.rejects(run(),error=>error===e);else await run().catch(error=>{if(error.message!=='PUBLIC_BOUNDARY')throw error;});
    assert.equal(patches,1);assert.equal(reads,mode.startsWith('mismatch')?1:0);
    if(mode.startsWith('mismatch')){assert.equal(output[0].status,'patch_failed');assert.equal(output[0].error.message,message);assert.equal(output[0].original_error,String(e));assert.equal(output[0].mutation_retries,0);}
  }
  const output={type:'custom_tool_call_output',call_id:original.call_id,output:'PUBLIC_EXACT_CONTEXT'};
  assert.deepEqual(new NativeFunctionBridge(retainer).restoreHistory([wire,output]),[original,output]);
  for(const thrown of ['',null,undefined,false]){
    let reads=0,caught=false;
    try{await new AsyncFunction('tools','text','exit',wire.input)({apply_patch:async()=>{throw thrown;},exec_command:async()=>{reads++;}},()=>{},()=>{});}
    catch(error){caught=true;assert.equal(error,thrown);}
    assert.equal(caught,true);assert.equal(reads,0);
  }
});
test('changed source and delivery overflow stay explicit; no partial source is presented as complete',t=>{
  const f=fixture(t),read=fs.readFileSync,changed=fs.realpathSync(path.join(f.project,'a.py'));
  try{
    fs.readFileSync=(file,...args)=>{const bytes=read(file,...args);if(file===changed)fs.appendFileSync(file,'# concurrently changed\n');return bytes;};
    const p=patchFailureEvidence({project:f.project,files:[{file:'a.py',anchors:[]}],engine:f.engine,evidence:f.evidence});
    assert.ok(p.files[0].boundary);assert.equal(p.files[0].source,null);assert.deepEqual(p.files[0].ranges,[]);
  }finally{fs.readFileSync=read;}
  const raw=Array.from({length:500},(_,i)=>'import public_long_module_'+i+'_'+('x'.repeat(100))+'\n').join('');
  fs.writeFileSync(path.join(f.project,'many.py'),raw);
  const p=patchFailureEvidence({project:f.project,files:[{file:'many.py',anchors:[]}],budget:4096,engine:f.engine,evidence:f.evidence});
  assert.ok(p.files[0].boundary);assert.deepEqual(p.files[0].ranges,[]);assert.equal(p.files[0].source,digest(Buffer.from(raw)));
  assert.ok(Buffer.byteLength(renderPatchFailureEvidence(p))<=4096);
});
test('a failed patch plus default foreground test stops before test execution; unsafe binding and malformed typed fields stay native',async t=>{
  const f=fixture(t),retainer=createToolCallRetainer({directory:path.join(f.directory,'programs')});
  const bridge=new NativeFunctionBridge({...retainer,typedCustom:true,delegateForegroundTests:true,delegatePatchEvidence:true,patchEvidenceBinding:()=>f.binding});
  const call={type:'custom_tool_call',name:'exec',call_id:'batch-public',input:`text(await tools.apply_patch(${JSON.stringify(f.patch)}));\ntext(await tools.exec_command({cmd:"bench test 01 'public'"}));`};
  const wire=bridge.toNative(call,{task:'1'}),AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;let reads=0;
  await new AsyncFunction('tools','text','exit',wire.input)({apply_patch:async()=>{throw new Error('apply_patch verification failed: Failed to find expected lines in '+f.project+'/a.py:\nold');},
    exec_command:async args=>{reads++;assert.ok(args.cmd.startsWith('node '));return {exit_code:0,output:'PUBLIC_CONTEXT'};}},()=>{},()=>{throw new Error('PUBLIC_BOUNDARY');})
    .catch(e=>{if(e.message!=='PUBLIC_BOUNDARY')throw e;});
  assert.equal(reads,1);
  const unsafe=new NativeFunctionBridge({...retainer,delegatePatchEvidence:true,patchEvidenceBinding:()=>({...f.binding,project:'/other'})});
  const plain={...call,call_id:'unsafe-public',input:`text(await tools.apply_patch(${JSON.stringify(f.patch)}));`};assert.equal(unsafe.toNative(plain,{task:'1'}),plain);
  const malformed=bridge.toNative({...call,call_id:'malformed-public',input:'// HELIX_JSON\n'+JSON.stringify({op:'patch',patch:f.patch,unknown:true})},{task:'1'});
  assert.ok(malformed.input.includes('no_work_executed'));assert.ok(!malformed.input.includes('patchError'));
});
test('literal patch batches preserve order; first failure reads all declared files once and never runs later mutations',async t=>{
  const f=fixture(t),retainer=createToolCallRetainer({directory:path.join(f.directory,'programs')});
  const first=`*** Begin Patch\n*** Update File: ${f.project}/a.py\n@@\n-old\n+new\n*** End Patch`,second=first.replace('/a.py','/b.py');
  const program=[first,second].map(p=>`text(await tools.apply_patch(${JSON.stringify(p)}));`).join('\n');
  assert.deepEqual(nativePatchLiterals(program),[first,second]);assert.equal(nativePatchLiteral(program),null);
  assert.equal(nativePatchLiterals(program+'\ntext(1)'),null);
  const bridge=new NativeFunctionBridge({...retainer,delegatePatchEvidence:true,patchEvidenceBinding:()=>f.binding});
  const original={type:'custom_tool_call',name:'exec',call_id:'batch-two',input:program},wire=bridge.toNative(original,{task:'1'});
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  for(const failed of [0,1]){
    const attempts=[];let reads=0;
    await new AsyncFunction('tools','text','exit',wire.input)({apply_patch:async p=>{const index=attempts.length;attempts.push(p);if(index===failed)throw 'apply_patch verification failed: Failed to find expected lines in '+f.project+'/a.py:\nold';return {};},
      exec_command:async args=>{reads++;assert.ok(args.cmd.includes('"file":"a.py"'));assert.ok(args.cmd.includes('"file":"b.py"'));return {exit_code:0,output:'PUBLIC_CURRENT_SOURCES'};}},()=>{},()=>{throw new Error('PUBLIC_BOUNDARY');})
      .catch(e=>{if(e.message!=='PUBLIC_BOUNDARY')throw e;});
    assert.deepEqual(attempts,[first,second].slice(0,failed+1));assert.equal(reads,1);
  }
  const output={type:'custom_tool_call_output',call_id:original.call_id,output:'PUBLIC_CURRENT_SOURCES'};
  assert.deepEqual(new NativeFunctionBridge(retainer).restoreHistory([wire,output]),[original,output]);
});
