import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
const operations=[
  {id:'head',argv:['git','-c','core.fsmonitor=false','rev-parse','HEAD']},
  {id:'check',argv:['git','-c','core.fsmonitor=false','diff','--check','--no-ext-diff','--no-textconv','HEAD','--']},
  {id:'status',argv:['git','-c','core.fsmonitor=false','status','--porcelain=v1','-z']},
  {id:'diff',argv:['git','-c','core.fsmonitor=false','diff','--binary','--no-ext-diff','--no-textconv','HEAD','--']},
  {id:'head-final',argv:['git','-c','core.fsmonitor=false','rev-parse','HEAD']},
];

// Caller declares this read-only chain in its trial policy. It observes current
// source after a test; it cannot run another test, patch, retry or checkpoint.
export async function postTestGit({engine,execute,currentTask,task,expectedHead,signal,maxElapsedMs=20000}){
  if(typeof engine?.archive!=='function'||typeof execute!=='function'||typeof currentTask!=='function'||
    !Number.isInteger(task)||task<1||!/^[a-f0-9]{40}$/.test(expectedHead)||!Number.isInteger(maxElapsedMs)||maxElapsedMs<1||maxElapsedMs>20000)
    throw new Error('Explicit task, bound head and read-only executor required');
  const began=Date.now(),observations=[];
  const finish=boundary=>({schema:'helix.post-test-git.v1',task,expected_head:expectedHead,observations,
    boundary:boundary??null,controller_ms:Date.now()-began,controller_operations:observations.length,
    model_calls:0,semantic_success:null,coverage:'Tracked HEAD diff and untracked path inventory only; untracked bodies are not captured.'});
  for(const op of operations){
    if(signal?.aborted)return finish('Cancelled; no further inspection');
    if(currentTask()!==task)return finish('Active task changed; no further inspection');
    const left=maxElapsedMs-(Date.now()-began);if(left<=0)return finish('Inspection elapsed budget reached');
    let result;
    const argv=op.argv.map(arg=>['check','diff'].includes(op.id)&&arg==='HEAD'?expectedHead:arg);
    try{result=await execute({id:op.id,argv,timeout_ms:Math.min(left,5000)},signal);}
    catch{return finish('Inspection executor failed; model review required, no retry');}
    if(typeof result?.stdout!=='string'||typeof result?.stderr!=='string')return finish('Unknown inspection result; model review required');
    const out=Buffer.isBuffer(result.stdout_raw)?result.stdout_raw:Buffer.from(result.stdout);
    const err=Buffer.isBuffer(result.stderr_raw)?result.stderr_raw:Buffer.from(result.stderr);
    const stdout=engine.archive(out),stderr=engine.archive(err);
    const row={id:op.id,exit_code:result.exit_code??null,signal:result.signal??null,capped:!!result.tooLarge,
      stdout,stderr,stdout_bytes:out.length,stderr_bytes:err.length,stdout_sha256:hash(out)};
    observations.push(row);
    if(signal?.aborted)return finish('Cancelled; no further inspection');
    if(currentTask()!==task)return finish('Active task changed; no further inspection');
    if(!Number.isInteger(row.exit_code)||row.signal||row.capped)return finish('Inspection completion unknown or capped; model review required');
    if(row.exit_code!==0)return finish('Inspection failed; model review required, no retry');
    if(op.id.startsWith('head')&&result.stdout.trim()!==expectedHead)return finish('Repository HEAD changed; inspection is historical, no downstream inspection');
  }
  return finish(null);
}

export function postTestGitText(engine,packet,{budget=6000}={}){
  if(!Number.isInteger(budget)||budget<1024||budget>8000)throw new Error('Bounded inspection view required');
  const source=engine.archive(packet);
  let text=`Post-test read-only Git inspection; no semantic acceptance. ${packet.coverage}\nExact full inspection packet: context raw receipt ${source}.\n`;
  if(packet.boundary)text+=packet.boundary+'\n';
  for(const row of packet.observations){
    const header=`${row.id}: exit ${row.exit_code}${row.signal?'; signal '+row.signal:''}${row.capped?'; capped':''}; stdout ${row.stdout} (${row.stdout_bytes} bytes)${row.stderr_bytes?'; stderr '+row.stderr+' ('+row.stderr_bytes+' bytes)':''}.\n`;
    if(Buffer.byteLength(text+header)>budget)break;
    text+=header;
    for(const source of [row.stdout,row.stderr]){
      if(source===row.stderr&&!row.stderr_bytes)continue;
      const raw=engine.read(source,{limit:24000});
      const content=raw.encoding==='utf8'?raw.content.replaceAll('\0','\\0'):null;
      if(content!==null&&raw.next_offset===null&&Buffer.byteLength(text+content+'\n')<=budget)text+=content+'\n';
      else if(Buffer.byteLength(text)+90<=budget)text+='Body omitted from this view; recover the exact source above when relevant.\n';
    }
  }
  if(Buffer.byteLength(text)>budget)throw new Error('Inspection view exceeded budget');
  return text;
}

export function initialRuntimeFact(runtime,{order,imageId}){
  if(order!==1)return null;
  if(runtime?.verified_image!==imageId||typeof runtime.python!=='string'||!/^\d+\.\d+\.\d+$/.test(runtime.python)||
    typeof runtime.pytest_available!=='boolean'||runtime.bundled_runner!=='bin/test')throw new Error('Current initial-image runtime binding required');
  return {python:runtime.python,pytest_available:runtime.pytest_available,bundled_runner:runtime.bundled_runner,
    scope:'Verified initial issue image only; dependency/environment mutations invalidate these facts. No test result or semantic approval.'};
}
