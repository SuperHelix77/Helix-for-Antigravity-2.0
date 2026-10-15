import {createHash} from "node:crypto";
import {readFileSync,realpathSync,statSync} from "node:fs";
import path from "node:path";
import {qualifiedFileDigest} from "./helix-evidence.mjs";

export function bindFlowArtifacts(project,artifacts=[],{engine,counters}={}) {
  if(!Array.isArray(artifacts)||artifacts.length>32)throw new Error("Invalid flow artifact declarations.");
  return artifacts.map(file=>{
    if(typeof file!=="string"||!file||path.isAbsolute(file))throw new Error("Artifacts must be project-relative files.");
    let resolved;
    try{resolved=realpathSync(path.resolve(project,file));}catch{throw new Error("Declared flow artifact is unavailable.");}
    if(!resolved.startsWith(project+path.sep)||!statSync(resolved).isFile())throw new Error("Flow artifact escapes its project or is not a file.");
    return {file,sha256:engine?qualifiedFileDigest(engine,resolved,counters):createHash("sha256").update(readFileSync(resolved)).digest("hex")};
  });
}

// Adapt only at declared mechanical boundaries. Never synthesize a repair.
export async function admitFlowCommand(node,{project,session,values,verifyVisibility,signal,engine,counters}) {
  const classification=node.execution_class??"deterministic";
  const reject=reason=>({admitted:false,classification,reason});
  if(classification==="semantic")return reject("Semantic decision required; return to model.");
  if(classification==="conditional"){
    const prior=values.get(node.guard?.from);
    if(!prior?.known_exit||prior.failure||prior.exit_code!==node.guard.exit_code)return reject("Declared exit guard unavailable, failed or unsatisfied; model review required.");
  }
  let actual;
  try{actual=bindFlowArtifacts(project,(node.artifact_bindings??[]).map(a=>a.file),{engine,counters});}
  catch{return reject("Declared artifact unavailable in producer namespace; model review required.");}
  if(JSON.stringify(actual)!==JSON.stringify(node.artifact_bindings??[]))return reject("Artifact bytes changed; register a reviewed new version.");
  if(node.executor&&node.executor!=="local"){
    if(!verifyVisibility)return reject("Consumer namespace visibility unverified; command not executed.");
    if(!actual.length)return reject("Remote command requires explicit visible artifact bindings.");
    for(const artifact of actual){
      signal?.throwIfAborted();
      // Only a server-owned adapter can measure the consumer namespace. A
      // caller-provided receipt or mapping never qualifies visibility.
      let proof,abort;
      try{
        const pending=Promise.resolve().then(()=>verifyVisibility({project,session,executor:node.executor,artifact,signal}));
        proof=signal?await Promise.race([pending,new Promise((resolve,reject)=>{
          abort=()=>reject(new Error("Namespace probe interrupted"));signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();
        })]):await pending;
      }catch{return reject(signal?.aborted?"Namespace probe interrupted; command not executed.":"Consumer namespace probe failed; command not executed.");}
      finally{if(abort)signal.removeEventListener("abort",abort);}
      if(proof?.visible!==true||proof.immutable!==true||proof.sha256!==artifact.sha256||proof.executor!==node.executor)return reject("Artifact not verified immutable and byte-identical in consumer namespace; command not executed.");
    }
  }
  return {admitted:true,classification,verified_artifacts:actual.length};
}
