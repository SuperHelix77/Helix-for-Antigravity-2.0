import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {digest} from './helix-evidence.mjs';

const parser=fileURLToPath(new URL('../bin/helix-source-bundle.py',import.meta.url));
const same=(a,b)=>['dev','ino','size','mtimeNs','ctimeNs'].every(k=>a[k]===b[k]);
const safeFile=file=>typeof file==='string'&&file.length<=512&&file.endsWith('.py')&&!file.includes('\\')&&
  !file.includes('\0')&&!path.posix.isAbsolute(file)&&file.split('/').every(p=>p&&p!=='.'&&p!=='..'&&!p.startsWith('.'));

// Extract evidence selectors only; native apply_patch remains the patch parser.
export function patchEvidenceRequest(patch,binding){
  if(typeof patch!=='string'||patch.length>100000||!binding||
    !['project','evidence','collector'].every(k=>typeof binding[k]==='string'&&path.posix.isAbsolute(binding[k])&&
      !/[\0\r\n]/.test(binding[k])&&binding[k].length<=1024))return null;
  const project=path.posix.normalize(binding.project),lines=patch.split('\n');
  if(lines[0]!=='*** Begin Patch'||lines.at(-1)!=='*** End Patch')return null;
  const files=[];let current=null;
  for(const line of lines.slice(1,-1)){
    if(line.startsWith('*** Update File: ')){
      const target=line.slice(17);
      if(!target.startsWith(project+'/'))return null;
      const file=target.slice(project.length+1);
      if(!safeFile(file)||files.some(r=>r.file===file)||files.length>=8)return null;
      current={file,anchors:[]};files.push(current);
    }else if(line.startsWith('***'))return null;
    else if(!current)return null;
    else if(line.startsWith('@@')||line===''||line.startsWith('+'))continue;
    else if(line.startsWith('-')||line.startsWith(' ')){
      const anchor=line.slice(1);
      if(anchor.trim()&&anchor.length<=1024&&current.anchors.length<32&&!current.anchors.includes(anchor))current.anchors.push(anchor);
    }else return null;
  }
  if(!files.length)return null;
  return {project,evidence:binding.evidence,collector:binding.collector,files};
}

export function patchFailureEvidence({engine,evidence,project,files,budget=8000}){
  if(!Array.isArray(files)||!files.length||files.length>8||new Set(files.map(r=>r.file)).size!==files.length||
    files.some(r=>!safeFile(r.file)||!Array.isArray(r.anchors)||r.anchors.length>32||r.anchors.some(a=>typeof a!=='string'||a.length>1024))||
    !Number.isSafeInteger(budget)||budget<4096||budget>16000)throw new Error('Bound declared Python files and evidence budgets required');
  project=fs.realpathSync(project);const deadline=Date.now()+5000,rows=[];
  for(const record of files){
    const row={file:record.file,source:null,index:null,ranges:[],boundary:null};rows.push(row);
    try{
      if(Date.now()>=deadline)throw new Error('budget');
      const requested=path.join(project,record.file),resolved=fs.realpathSync(requested);
      if(fs.lstatSync(requested).isSymbolicLink()||!resolved.startsWith(project+path.sep))throw new Error('path');
      const before=fs.statSync(resolved,{bigint:true});
      if(!before.isFile()||before.size>512n*1024n)throw new Error('size');
      const bytes=fs.readFileSync(resolved),after=fs.statSync(resolved,{bigint:true});
      if(!same(before,after)||fs.realpathSync(requested)!==resolved)throw new Error('changed');
      row.source=engine.archive(bytes);row.sha256=digest(bytes);row.bytes=bytes.length;
      const text=new TextDecoder('utf8',{fatal:true}).decode(bytes);
      if(/\r(?!\n)/.test(text))throw new Error('encoding');
      const indexed=evidence.index(row.source);row.index=indexed.index;row.lines=indexed.lines;
      const inspected=spawnSync('python3',[parser],{input:JSON.stringify({text,selectors:[],follow_calls:false}),
        encoding:'utf8',timeout:Math.max(1,Math.min(5000,deadline-Date.now())),maxBuffer:2*1024*1024});
      if(inspected.error||inspected.status!==0)throw new Error('syntax');
      const syntax=JSON.parse(inspected.stdout);if(syntax.boundary)throw new Error('syntax');
      const lines=text.split('\n').map(line=>line.replace(/\r$/,'')),intervals=[...syntax.imports];
      let missing=0,ambiguous=0;
      for(const anchor of record.anchors){
        const matches=[];for(let i=0;i<lines.length;i++)if(lines[i]===anchor)matches.push(i+1);
        if(!matches.length)missing++;if(matches.length>1)ambiguous++;
        for(const line of matches.slice(0,2))intervals.push({start:Math.max(1,line-3),end:Math.min(indexed.lines,line+3)});
      }
      row.anchor_counts={requested:record.anchors.length,missing,ambiguous};
      const merged=[];
      for(const range of intervals.sort((a,b)=>a.start-b.start)){
        const last=merged.at(-1);
        if(last&&range.start<=last.end+1)last.end=Math.max(last.end,range.end);else merged.push({...range});
      }
      if(merged.length>32)throw new Error('ranges');
      if(merged.length)row.ranges=evidence.ranges({source:row.source,index:row.index,ranges:merged,budget:Math.max(4,Math.floor(budget/files.length)-512)});
    }catch{
      row.boundary='Source selection unavailable or exceeds budget; no guessed context or repair. Recover retained raw/index evidence when present.';
    }
  }
  const packet={schema:'helix.patch-failure-evidence.v1',files:rows,semantic_success:null,patch_retries:0,
    scope:'Exact historical source imports and literal anchor neighborhoods; not diagnosis, a repair, or current-source approval.'};
  return {...packet,receipt:engine.archive(packet),budget};
}

export function renderPatchFailureEvidence(packet){
  const header=`Patch failed; source inspection only, no mutation retry. Exact packet: context raw receipt ${packet.receipt}.\n${packet.scope}\n`;
  const view=header+packet.files.map(r=>`\n${r.file}; source ${r.source}; index ${r.index}; sha256 ${r.sha256??'unavailable'}.\n`+
    (r.boundary?r.boundary+'\n':'')+JSON.stringify(r.anchor_counts??{})+'\n'+r.ranges.map(s=>`${r.file}:${s.start}-${s.end}\n${s.content}`).join('\n')).join('');
  return Buffer.byteLength(view)<=packet.budget?view:header+'Selection exceeds delivery budget; recover the exact packet and narrower indexed ranges.\n';
}
