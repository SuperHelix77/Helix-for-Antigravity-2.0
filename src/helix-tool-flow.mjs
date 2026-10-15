import {createHash} from "node:crypto";
import {existsSync,readFileSync,realpathSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {createCompactReceipt,compactReceiptText} from "./helix-evidence.mjs";
import {bindFlowArtifacts,admitFlowCommand} from "./helix-flow-admission.mjs";

const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const keys=(value,allowed)=>{
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key))) throw new Error("Invalid Tool Flow fields.");
};
const identifier=value=>typeof value==="string"&&/^[a-zA-Z0-9_.-]{1,40}$/u.test(value);
const runtimeHash=()=>createHash("sha256").update(readFileSync(new URL(import.meta.url))).update(readFileSync(new URL("./helix-flow-admission.mjs",import.meta.url))).update(readFileSync(new URL("./helix-evidence-delta.mjs",import.meta.url))).digest("hex");
const gitRevision=project=>{
  if(!existsSync(`${project}/.git`))return null;
  const value=execFileSync("git",["-C",project,"rev-parse","HEAD"],{encoding:"utf8",timeout:5000}).trim();
  if(!/^[a-f0-9]{40,64}$/u.test(value))throw new Error("Workspace revision unavailable.");
  return value;
};

// Tool Flow moves already-declared evidence operations across a typed command
// result. It never invents argv, retries a failure, or labels semantics correct.
export class HelixToolFlow {
  constructor(engine,evidence,{verifyVisibility}={}){
    this.engine=engine;this.evidence=evidence;
    this.verifyVisibility=verifyVisibility;
    engine.db.exec("CREATE TABLE IF NOT EXISTS helix_flows(project TEXT,name TEXT,version TEXT,receipt TEXT NOT NULL,PRIMARY KEY(project,name,version));");
  }

  register({project,name,version,nodes,bind=[],max_operations=32,max_elapsed_ms=120000}){
    project=realpathSync(project);
    if(!identifier(name)||!identifier(version)||!Array.isArray(nodes)||!nodes.length||nodes.length>32)throw new Error("Tool Flow needs named/versioned 1..32 nodes.");
    if(!Number.isInteger(max_operations)||max_operations<1||max_operations>32||!Number.isInteger(max_elapsed_ms)||max_elapsed_ms<20||max_elapsed_ms>1200000)throw new Error("Invalid Tool Flow execution envelope.");
    const ids=new Set();
    const allowed={command:["id","kind","argv","timeout_ms","next","execution_class","guard","executor","artifacts"],receipt:["id","kind","from","next"],
      delta:["id","kind","from","before","next"],
      index:["id","kind","from","channel","next"],ranges:["id","kind","from","tail","next"],
      branch:["id","kind","from","zero","nonzero"],finish:["id","kind"]};
    for(const node of nodes){
      keys(node,allowed[node?.kind]??[]);
      if(!identifier(node.id)||ids.has(node.id))throw new Error("Invalid or duplicate flow node id.");
      ids.add(node.id);
      if(!allowed[node.kind])throw new Error("Unsupported flow node.");
      if(["receipt","delta","index","ranges","branch"].includes(node.kind)&&!identifier(node.from))throw new Error("Node requires explicit prior evidence reference.");
      if(node.kind==="delta"&&(typeof node.before!=="string"||!/^[a-f0-9]{64}$/.test(node.before)))throw new Error("Delta requires an exact prior compact receipt.");
      if(node.kind==="index"&&!["stdout","stderr"].includes(node.channel))throw new Error("Index channel must be explicit.");
      if(node.kind==="ranges"&&(!Number.isSafeInteger(node.tail)||node.tail<1||node.tail>100))throw new Error("Tail must be 1..100 exact lines.");
      if(node.kind==="command"){
        if(node.execution_class!==undefined&&!["deterministic","conditional","semantic"].includes(node.execution_class))throw new Error("Unknown execution class.");
        if(node.execution_class==="conditional"){
          keys(node.guard,["from","exit_code"]);
          if(!identifier(node.guard.from)||node.guard.exit_code!==0)throw new Error("Conditional execution requires a declared successful exit guard.");
        }else if(node.guard!==undefined)throw new Error("Only conditional commands may declare an exit guard.");
        if(node.executor!==undefined&&!identifier(node.executor))throw new Error("Invalid declared executor namespace.");
      }
    }
    const byId=new Map(nodes.map(node=>[node.id,node]));
    const visiting=new Set(),visited=new Set();
    const walk=id=>{
      if(visiting.has(id))throw new Error("Tool Flow cycles/retries are not allowed.");
      if(visited.has(id))return;
      const node=byId.get(id);if(!node)throw new Error("Unknown flow transition.");
      if(node.from&&!ids.has(node.from))throw new Error("Unknown flow evidence reference.");
      if(node.guard&&!ids.has(node.guard.from))throw new Error("Unknown conditional evidence reference.");
      visiting.add(id);
      if(node.kind!=="finish")for(const next of node.kind==="branch"?[node.zero,node.nonzero]:[node.next])walk(next);
      visiting.delete(id);visited.add(id);
    };
    walk(nodes[0].id);
    if(visited.size!==nodes.length)throw new Error("Unreachable flow nodes are not allowed.");
    const compiled=nodes.map(node=>{
      if(node.kind!=="command")return {...node};
      const artifact_bindings=bindFlowArtifacts(project,node.artifacts,{engine:this.engine,counters:this.evidence.counters});
      const registered=this.evidence.register({project,name:`${name}.${node.id}`,version,bind:[...new Set([...bind,...artifact_bindings.map(a=>a.file)])],
        steps:[{id:node.id,kind:"command",argv:node.argv,...(node.timeout_ms!==undefined?{timeout_ms:node.timeout_ms}:{})}]});
      return {...node,artifact_bindings,workflow:registered.workflow};
    });
    const recipe={schema:"helix.tool-flow.v1",project,name,version,nodes:compiled,revision:gitRevision(project),runtime_sha256:runtimeHash(),max_operations,max_elapsed_ms,semantic_success:null};
    const flow=this.engine.archive(recipe);
    this.engine.transaction(()=>{
      const prior=this.engine.db.prepare("SELECT receipt FROM helix_flows WHERE project=? AND name=? AND version=?").get(project,name,version);
      if(prior&&prior.receipt!==flow)throw new Error("Flow version is immutable; register a new version.");
      this.engine.db.prepare("INSERT OR IGNORE INTO helix_flows VALUES(?,?,?,?)").run(project,name,version,flow);
    });
    return {flow,nodes:nodes.length,executed:false,semantic_success:null};
  }

  async run({project,session,request_id,flow},options){
    project=realpathSync(project);
    if(typeof session!=="string"||!session||session.length>200||typeof request_id!=="string"||!request_id||request_id.length>100)throw new Error("Explicit current-task session and request id required.");
    const recipe=this.engine.objectJSON(flow);
    if(recipe.schema!=="helix.tool-flow.v1"||recipe.project!==project)throw new Error("Flow scope mismatch.");
    const registered=this.engine.db.prepare("SELECT receipt FROM helix_flows WHERE project=? AND name=? AND version=?").get(project,recipe.name,recipe.version);
    if(registered?.receipt!==flow)throw new Error("Flow is not an accepted immutable recipe.");
    if(recipe.runtime_sha256!==runtimeHash())throw new Error("Tool Flow runtime changed; register a new version.");
    const byId=new Map(recipe.nodes.map(node=>[node.id,node]));
    const values=new Map(),trace=[],summaries=[],admissions=[];
    let cursor=recipe.nodes[0].id,failed=false,boundary=null;
    const controller=new AbortController(),started=Date.now();
    const abort=()=>controller.abort("interrupted");
    options?.signal?.addEventListener("abort",abort,{once:true});
    if(options?.signal?.aborted)abort();
    const timer=setTimeout(()=>controller.abort("elapsed budget reached"),recipe.max_elapsed_ms);
    try { for(let count=0;cursor&&count<recipe.max_operations;count++){
      if(Date.now()-started>=recipe.max_elapsed_ms)controller.abort("elapsed budget reached");
      if(controller.signal.aborted){boundary=controller.signal.reason;break;}
      if(gitRevision(project)!==recipe.revision){boundary="Workspace revision changed; model review required.";break;}
      const node=byId.get(cursor);if(!node){boundary="unknown node";break;}
      try{
        const prior=node.from?values.get(node.from):null;
        if(node.from&&!prior)throw new Error("Selected path lacks required evidence; model review needed.");
        let value;
        if(node.kind==="command"){
          if(failed){boundary="Command failure requires reviewed retry; no downstream command executed.";break;}
          const admission=await admitFlowCommand(node,{project,session,values,verifyVisibility:this.verifyVisibility,signal:controller.signal,engine:this.engine,counters:this.evidence.counters});
          admissions.push({node:node.id,...admission});
          if(!admission.admitted){boundary=admission.reason;break;}
          const scope=`flow-${hash([session,flow,node.id]).slice(0,40)}`;
          const executionKey=hash([request_id,flow,node.id]);
          const result=await this.evidence.run({project,session:scope,request_id:executionKey,workflow:node.workflow},{signal:controller.signal});
          // A replay exposes current goal state, not old result bodies. Recover
          // only this exact attempt's archived receipts, never a recent event.
          const saved=this.engine.db.prepare("SELECT result FROM requests WHERE goal=? AND key=?").get(result.goal,`${executionKey}:run`);
          const receipt=result.receipts?.at(-1)??JSON.parse(saved?.result??"[]").at(-1);
          const step=receipt?this.engine.objectJSON(receipt):null;
          const output=step?.outputs?.at(-1);
          if(!output){boundary=result.note??"No complete command evidence; model review required.";break;}
          const knownExit=Number.isInteger(output.exit_code)&&!output.signal&&!output.failure&&
            (!step.failure||step.failure===`Command exited ${output.exit_code}.`);
          value={...output,failure:output.failure??step.failure??null,known_exit:knownExit,goal:result.goal,step_receipt:receipt,mechanical_success:result.state==="done",semantic_success:null};
          failed=!value.mechanical_success;
        }else if(node.kind==="receipt"){
          if(!prior.stdout||!prior.stderr)throw new Error("Receipt requires command output.");
          value={receipt:createCompactReceipt(this.engine,prior,this.evidence.counters)};
          summaries.push(compactReceiptText(this.engine,value.receipt,{budget:1500,include_previews:false}));
        }else if(node.kind==="delta"){
          if(!prior.compact_receipt)throw new Error("Delta requires archived command evidence.");
          value=this.evidence.delta({before:node.before,after:prior.compact_receipt});
          summaries.push(value.text);
          if(!value.compatible){values.set(node.id,value);trace.push({node:node.id,kind:node.kind,value});boundary=value.reason;break;}
        }else if(node.kind==="index"){
          if(!prior[node.channel])throw new Error("Index requires selected command output channel.");
          value=this.evidence.index(prior[node.channel]);
        }else if(node.kind==="ranges"){
          if(!Number.isSafeInteger(prior.lines))throw new Error("Ranges require an exact line index.");
          const ranges=prior.lines?this.evidence.ranges({index:prior.index,source:prior.source,ranges:[{start:Math.max(1,prior.lines-node.tail+1),end:prior.lines}],budget:3000}):[];
          value={source:prior.source,index:prior.index,ranges};
          summaries.push(...ranges.map(range=>`Exact source ${range.source}, lines ${range.start}-${range.end}:\n${range.content}`));
        }else if(node.kind==="branch"){
          if(!prior.known_exit){boundary="Command outcome unknown or interrupted; model review required.";break;}
          value={selected:prior.exit_code===0?node.zero:node.nonzero,exit_code:prior.exit_code,semantic_success:null};
        }else if(node.kind==="finish"){
          trace.push({node:node.id,kind:node.kind});cursor=null;break;
        }else throw new Error("Unsupported flow node.");
        values.set(node.id,value);trace.push({node:node.id,kind:node.kind,value});
        cursor=node.kind==="branch"?value.selected:node.next;
      }catch(error){boundary=error.message;break;}
    } } finally {clearTimeout(timer);options?.signal?.removeEventListener("abort",abort);}
    if(cursor&&!boundary)boundary="Flow execution bound reached; model review required.";
    const receipt=this.engine.archive({schema:"helix.tool-flow-result.v1",flow,project,session,request_id,trace,boundary,
      execution_failed:failed,admissions,elapsed_ms:Date.now()-started,semantic_success:null});
    return {flow,receipt,nodes_executed:trace.length,finished:cursor===null,boundary,execution_failed:failed,
      controller_model_calls:0,semantic_success:null,admissions,summaries:summaries.slice(0,4)};
  }
}
