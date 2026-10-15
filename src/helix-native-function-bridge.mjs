import {bindCheckpointOperation,CheckpointOperationRejection} from './helix-checkpoint-operation.mjs';
import {NativeOperationRejection} from './native-operation-rejection.mjs';
import {patchEvidenceRequest} from './helix-patch-evidence.mjs';
import {verificationCommand,verificationBoundary} from './verification.mjs';

export function parseNativeOperationArguments(value){
  try{return {args:JSON.parse(value)};}
  catch(error){if(!(error instanceof SyntaxError))throw error;return {rejection:'invalid_typed_json'};}
}

const marker=/\n\/\/ HELIX_FUNCTION_ORIGINAL ([A-Za-z0-9_-]{43})\n$/;
const canonical=value=>JSON.stringify(value,(_,item)=>item&&typeof item==="object"&&!Array.isArray(item)?
  Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
// Native0.156.1 omits these provider-only envelopes when replaying tool calls.
// Validate any envelope that remains, and recover the complete original later.
export function nativeCallMatches(observed,expected){
  const left={...observed},right={...expected};
  for(const key of ['metadata','internal_chat_message_metadata_passthrough']){
    if(Object.hasOwn(left,key)&&canonical(left[key])!==canonical(right[key]))return false;
    delete left[key];delete right[key];
  }
  for(const item of [left,right])if(item.status===undefined||item.status==='completed')delete item.status;
  return canonical(left)===canonical(right);
}
const keys=(args,allowed)=>{
  if(!args||typeof args!=="object"||Array.isArray(args)||Object.keys(args).some(key=>!allowed.includes(key)))
    throw new NativeOperationRejection('invalid_operation_fields',"Invalid typed operation fields");
};
const text=(value,label)=>{if(typeof value!=="string"||!value||value.length>100000)throw new NativeOperationRejection('invalid_operation_value',`Invalid ${label}`);return value;};

// A fixed literal-only template grammar, not a JavaScript interpreter. Any
// expression, extra statement, input characters or unknown field stays raw.
export function nativeProcessRead(program){
  if(typeof program!=='string')return null;
  const matched=/^\s*text\s*\(\s*await\s+tools\.write_stdin\s*\(\s*(\{[^{}]*\})\s*\)\s*\)\s*;?\s*$/.exec(program);
  if(!matched)return null;
  const args=Object.create(null),parts=matched[1].slice(1,-1).split(',');
  if(parts.at(-1).trim()==='')parts.pop();
  for(const part of parts){
    const field=/^\s*(?:([a-z_]+)|"([a-z_]+)"|'([a-z_]+)')\s*:\s*(\d+|""|'')\s*$/.exec(part);
    if(!field)return null;
    const key=field[1]??field[2]??field[3],value=field[4];
    if(!['session_id','chars','yield_time_ms','max_output_tokens'].includes(key)||Object.hasOwn(args,key))return null;
    if(key==='chars'){if(!['""',"''"].includes(value))return null;args.chars='';}
    else {const number=Number(value);if(!Number.isSafeInteger(number)||number<0)return null;args[key]=number;}
  }
  if(!Object.hasOwn(args,'session_id'))return null;
  return {op:'process_wait',...args};
}

// Only literal native statements, not arbitrary JavaScript rewriting. Explicit
// async/interactive options, computed arguments and trailing work stay raw.
export function nativeForegroundTest(program,{task}={}){
  const ordinal=String(task??'');
  if(typeof program!=='string'||program.length>100000||!/^[1-9]\d*$/.test(ordinal)||!Number.isSafeInteger(Number(ordinal)))return null;
  const string='"(?:[^"\\\\\r\n]|\\\\[\\s\\S])*"';
  const patch=new RegExp('^\\s*text\\s*\\(\\s*await\\s+tools\\.apply_patch\\s*\\(\\s*('+string+')\\s*\\)\\s*\\)\\s*;');
  const prefix=patch.exec(program);let patchText=null;
  try{if(prefix)patchText=JSON.parse(prefix[1]);}catch{return null;}
  const rest=prefix?program.slice(prefix[0].length):program;
  const command=/^\s*text\s*\(\s*await\s+tools\.exec_command\s*\(\s*(\{[\s\S]*\})\s*\)\s*\)\s*;?\s*$/.exec(rest);
  if(!command)return null;
  const field=new RegExp('\\s*(?:"(cmd|workdir|max_output_tokens)"|(cmd|workdir|max_output_tokens))\\s*:\\s*('+string+'|[0-9]+)\\s*(,|$)','y');
  const body=command[1].slice(1,-1),args=Object.create(null);let offset=0;
  while(offset<body.length){
    field.lastIndex=offset;const match=field.exec(body);if(!match)return null;
    const key=match[1]??match[2];if(Object.hasOwn(args,key))return null;
    try{args[key]=JSON.parse(match[3]);}catch{return null;}
    offset=field.lastIndex;
    if(match[4]===''&&offset!==body.length)return null;
    if(match[4]===','&&body.slice(offset).trim()===''){offset=body.length;break;}
  }
  if(typeof args.cmd!=='string'||args.workdir!==undefined&&typeof args.workdir!=='string'||
    args.max_output_tokens!==undefined&&(!Number.isSafeInteger(args.max_output_tokens)||args.max_output_tokens<1))return null;
  // One foreground bench invocation with one shell-quoted test argument.
  const bench=/^bench test (0*[1-9]\d*) '(?:[^']|'"'"')*'\s*$/.exec(args.cmd);
  if(!bench||!Number.isSafeInteger(Number(bench[1]))||Number(bench[1])!==Number(ordinal))return null;
  return {command:{op:'command',...args},patch:patchText};
}

export function nativePatchLiteral(program){
  const patches=nativePatchLiterals(program);return patches?.length===1?patches[0]:null;
}

export function nativePatchLiterals(program){
  if(typeof program!=='string'||program.length>120000)return null;
  const statement=/\s*text\s*\(\s*await\s+tools\.apply_patch\s*\(\s*("(?:[^"\\\r\n]|\\[\s\S])*")\s*\)\s*\)\s*;?/y;
  const patches=[];let offset=0;
  while(program.slice(offset).trim()){
    if(patches.length>=8)return null;
    statement.lastIndex=offset;const match=statement.exec(program);if(!match)return null;
    try{patches.push(JSON.parse(match[1]));}catch{return null;}offset=statement.lastIndex;
  }
  return patches.length?patches:null;
}

function patchBatchEvidenceProgram(patches,{task,patchEvidenceBinding}){
  if(typeof patchEvidenceBinding!=='function')return null;
  const binding=patchEvidenceBinding({task});
  if(binding&&typeof binding.then==='function'){
    Promise.resolve(binding).catch(()=>{});throw new Error('Synchronous current native source binding required');
  }
  const requests=patches.map(p=>patchEvidenceRequest(p,binding));if(requests.some(r=>!r))return null;
  const request={...requests[0],files:[]};
  for(const {files} of requests)for(const row of files){
    const previous=request.files.find(r=>r.file===row.file);
    if(previous)previous.anchors=[...new Set([...previous.anchors,...row.anchors])].slice(0,32);
    else request.files.push({...row,anchors:[...row.anchors]});
  }
  if(request.files.length>8)return null;
  return patches.map(p=>patches.length===1?compilePatchEvidenceProgram(p,request):'{\n'+compilePatchEvidenceProgram(p,request)+'\n}').join('\n');
}

function patchEvidenceProgram(patch,options){return patchBatchEvidenceProgram([patch],options);}

function compilePatchEvidenceProgram(patch,request){
  const shell=value=>"'"+value.replaceAll("'","'\\''")+"'";
  const command='node '+shell(request.collector)+" <<'HELIX_PATCH_EVIDENCE_REQUEST'\n"+
    JSON.stringify({project:request.project,evidence:request.evidence,files:request.files})+'\nHELIX_PATCH_EVIDENCE_REQUEST';
  const read=compileNativeOperation({op:'command',cmd:command});
  return `let patchError=null;let patchFailed=false;
try{text(await tools.apply_patch(${JSON.stringify(patch)}));}catch(error){patchError=error;patchFailed=true;}
if(patchFailed){
  const patchMessage=String(patchError?.message??patchError);
  if(!patchMessage.startsWith('apply_patch verification failed: Failed to find expected lines in '))throw patchError;
  text({kind:'helix.model_boundary',status:'patch_failed',patch_attempts:1,mutation_retries:0,original_error:String(patchError),error:{name:patchError?.name??'NativeToolError',message:patchMessage},source_inspection_only:true});
  ${read}
  exit();
}`;
}

function supervisedForegroundTest(foreground,patchProgram){
  const {op,...args}=foreground.command;
  const patch=foreground.patch===null?'':(patchProgram??`text(await tools.apply_patch(${JSON.stringify(foreground.patch)}));`)+"\n";
  return patch+`const deadline=Date.now()+600000;
let result=await tools.exec_command(${JSON.stringify({...args,yield_time_ms:30000})});
const observations=[];let polls=0;const processId=result?.session_id;
while(true){
  observations.push(result);
  if(!result||typeof result!=='object'||typeof result.output!=='string'){text({boundary:'Unknown native test result; model review required',observations});exit();}
  if(typeof result.session_id==='number'&&result.session_id!==processId){text({boundary:'Native test process identity changed; model review required',observations});exit();}
  if(result.signal||typeof result.exit_code==='number')break;
  if(!Number.isSafeInteger(result.session_id)){text({boundary:'Native test completion unavailable; model review required',observations});exit();}
  if(++polls>20||Date.now()>deadline){text({boundary:'Foreground test wait budget reached; model review required',observations});exit();}
  try{result=await tools.write_stdin({session_id:processId,chars:'',yield_time_ms:Math.max(1,Math.min(30000,deadline-Date.now()))${args.max_output_tokens!==undefined?',max_output_tokens:'+args.max_output_tokens:''}});}
  catch(error){text({boundary:'Native test wait failed; model review required',observations,error:{name:error?.name,message:error?.message}});exit();}
}
text({...result,output:observations.map(item=>item.output).join(''),observations,polls});`;
}

function supervisedProcessRead(args){
  const {op,...first}=args;
  return `let result=await tools.write_stdin(${JSON.stringify(first)});
const observations=[];const deadline=Date.now()+600000;let polls=0;
while(true){
  if(!result||typeof result!=='object'||typeof result.output!=='string'){text({boundary:'Unknown native process result; model review required',raw:result,observations});exit();}
  observations.push(result);
  if(typeof result.session_id==='number'&&result.session_id!==${args.session_id}){text({boundary:'Native process identity changed; model review required',observations});exit();}
  if(result.signal||typeof result.exit_code==='number'||typeof result.session_id!=='number')break;
  if(++polls>20||Date.now()>deadline){text({boundary:'Process wait budget reached; review required',observations});exit();}
  try{result=await tools.write_stdin({session_id:result.session_id,chars:'',yield_time_ms:30000${args.max_output_tokens!==undefined?',max_output_tokens:'+args.max_output_tokens:''}});}
  catch(error){text({...result,output:observations.map(item=>item.output).join(''),observations,polls,boundary:'Native process wait failed; model review required',error:{name:error?.name,message:error?.message}});exit();}
}
text({...result,output:observations.map(item=>item.output).join(''),observations,polls,...(!Number.isSafeInteger(result.exit_code)?{boundary:'Native exit status unavailable; model review required'}:{})});`;
}

export function compileNativeOperation(args, {checkpointBinding, task, call_id, checkpointPatches=false, delegatePatchEvidence=false, patchEvidenceBinding}={}) {
  switch(args?.op){
    case 'checkpoint': {
      if(typeof checkpointBinding!=='function')throw new NativeOperationRejection('checkpoint_unavailable','Bound checkpoint operation is not enabled');
      const binding=checkpointBinding({task,call_id});
      if(binding&&typeof binding.then==='function'){
        Promise.resolve(binding).catch(()=>{});
        throw new Error('Synchronous current checkpoint binding required');
      }
      let bound;
      try{bound=bindCheckpointOperation(args,{binding,task,allowPatch:checkpointPatches});}
      catch(error){
        if(!(error instanceof CheckpointOperationRejection))throw error;
        return `text(${JSON.stringify({kind:'helix.model_boundary',status:'checkpoint_not_executed',code:error.code,
          reason:error.message,allowed_fields:['op','revision','step','review','request_id','verify',...(checkpointPatches?['patch']:[])],
          recovery:'Use the current controller frontier and documented fields; correct once. If still rejected, report the boundary instead of guessing or retrying a mutation.'})});`;
      }
      const select="const matches=ALL_TOOLS.filter(t=>t.name.includes('helix')&&t.name.endsWith('__goal'));\nif(matches.length!==1)throw new Error('Unique Helix goal MCP required; no checkpoint executed');\nconst name=matches[0].name;\n";
      const checkpoint=`text(await tools[name](${JSON.stringify(bound.args)}));`;
      if(!bound.verify)return select+checkpoint;
      const patchProgram=bound.patch===undefined?'':
        (delegatePatchEvidence?patchEvidenceProgram(bound.patch,{task,patchEvidenceBinding}):null)??compileNativeOperation({op:'patch',patch:bound.patch});
      const command=compileNativeOperation({op:'command',...verificationCommand(bound.verify)});
      return select+patchProgram+'\n'+`const observations=[];const stop=Symbol('verification boundary');
async function verify(){const text=value=>observations.push(value);const exit=()=>{throw stop;};
${command}
}
try{await verify();}catch(error){if(error!==stop)throw error;}
for(const observation of observations)text(observation);
const result=observations.at(-1);
const boundary=(${verificationBoundary.toString()})(result);
if(boundary){text({kind:'helix.model_boundary',status:'checkpoint_not_executed',reason:boundary+'; model review required.'});exit();}
${checkpoint}`;
    }
    case 'process_wait':
      keys(args,['op','session_id','chars','yield_time_ms','max_output_tokens']);
      if(!Number.isSafeInteger(args.session_id)||args.session_id<0||args.chars!==undefined&&args.chars!=='')throw new NativeOperationRejection('invalid_process_read','Only a nonmutating declared process read can be supervised');
      for(const key of ['yield_time_ms','max_output_tokens'])if(args[key]!==undefined&&(!Number.isSafeInteger(args[key])||args[key]<0))throw new NativeOperationRejection('invalid_process_budget','Invalid process read budget');
      return supervisedProcessRead(args);
    case "command":{
      keys(args,["op","cmd","workdir"]);text(args.cmd,"command");if(args.workdir!==undefined)text(args.workdir,"workdir");
      return `let result=await tools.exec_command(${JSON.stringify({cmd:args.cmd,yield_time_ms:30000,...(args.workdir!==undefined?{workdir:args.workdir}:{})})});
const chunks=[];const deadline=Date.now()+600000;let polls=0;let incomplete=false;
if(!result||typeof result!=='object'||typeof result.output!=='string'){text({boundary:'Unknown native command result; model review required',raw:result});exit();}
const processId=result.session_id;
while(result&&!result.signal&&typeof result.session_id==='number'&&(result.exit_code===undefined||result.exit_code===null)){
  incomplete ||= !!(result.truncated||result.output_truncated||result.tooLarge);
  if(typeof result.output==='string')chunks.push(result.output);
  if(++polls>20||Date.now()>deadline){text({...result,output:chunks.join(''),boundary:'Command wait budget reached; review before further action'});exit();}
  try{result=await tools.write_stdin({session_id:result.session_id,chars:'',yield_time_ms:30000});}
  catch(error){text({...result,output:chunks.join(''),polls,boundary:'Native command wait failed; model review required',error:{name:error?.name,message:error?.message}});exit();}
  if(!result||typeof result!=='object'||typeof result.output!=='string'){text({boundary:'Unknown native wait result; model review required',raw:result,observations:chunks});exit();}
  if(typeof result.session_id==='number'&&result.session_id!==processId){text({...result,output:chunks.join('')+result.output,boundary:'Native process identity changed; model review required'});exit();}
}
if(typeof result?.output==='string')chunks.push(result.output);
text({...result,output:chunks.join(''),polls,...(incomplete?{truncated:true}:{}),...(!Number.isSafeInteger(result.exit_code)?{boundary:'Native exit status unavailable; model review required'}:{})});`;
    }
    case "patch":keys(args,["op","patch"]);return `text(await tools.apply_patch(${JSON.stringify(text(args.patch,"patch"))}));`;
    case "code":keys(args,["op","program","wait_for_completion"]);
      if(args.wait_for_completion!==undefined&&typeof args.wait_for_completion!=="boolean")throw new NativeOperationRejection('invalid_wait_authorization',"Invalid explicit wait authorization");
      return text(args.program,"program");
    case "mcp":{
      keys(args,["op","tool","args"]);
      if(!["goal","context"].includes(args.tool)||!args.args||typeof args.args!=="object"||Array.isArray(args.args))throw new NativeOperationRejection('invalid_mcp_selection',"Invalid Helix MCP selection");
      return `const matches=ALL_TOOLS.filter(t=>t.name.includes('helix')&&t.name.endsWith(${JSON.stringify(`__${args.tool}`)}));\nif(matches.length!==1)throw new Error('Unique Helix MCP required; no operation executed');\nconst name=matches[0].name;\ntext(await tools[name](${JSON.stringify(args.args)}));`;
    }
    default:throw new NativeOperationRejection('unsupported_operation',"Unknown typed operation; allowed: command, patch, code, mcp; checkpoint requires explicit controller binding");
  }
}

// Protocol core only: no tool dispatch, semantic judgment or live installation.
// The future broker must enforce current authorization, dispatch/retry ledgers,
// streaming/cancellation and process-wait admission before using this adapter.
export class NativeFunctionBridge {
  constructor({retainOriginal,readOriginal,lookupReceipt,typedCustom=false,delegateProcessReads=false,delegateForegroundTests=false,delegatePatchEvidence=false,patchEvidenceBinding,guardReceiptPrograms=false,checkpointBinding,checkpointPatches=false}={}) {
    if(typeof retainOriginal!=="function"||typeof readOriginal!=="function")throw new Error("Exact encrypted recovery required");
    this.retainOriginal=retainOriginal;this.readOriginal=readOriginal;
    this.guardReceiptPrograms=guardReceiptPrograms;
    this.checkpointBinding=checkpointBinding;
    this.checkpointPatches=checkpointPatches;
    this.receipts=new Map();this.lookupReceipt=lookupReceipt;
    this.typedCustom=typedCustom;
    this.delegateProcessReads=delegateProcessReads;
    this.delegateForegroundTests=delegateForegroundTests;
    if(delegatePatchEvidence&&typeof patchEvidenceBinding!=='function')throw new Error('Explicit native patch evidence binding required');
    this.delegatePatchEvidence=delegatePatchEvidence;this.patchEvidenceBinding=patchEvidenceBinding;
  }
  toNative(call, {task}={}) {
    const receiptOnly=this.guardReceiptPrograms&&call?.type==='custom_tool_call'&&call.name==='exec'&&
      /^\/\/ Completed historical program\. Exact original item: context raw \{receipt: [A-Za-z0-9_-]{43}\}\. Archived data; do not rerun automatically\.\r?\n?$/.test(call.input??'');
    const processRead=this.delegateProcessReads&&call?.type==='custom_tool_call'&&call.name==='exec'?nativeProcessRead(call.input):null;
    const foreground=this.delegateForegroundTests&&call?.type==='custom_tool_call'&&call.name==='exec'?nativeForegroundTest(call.input,{task}):null;
    const literalPatches=this.delegatePatchEvidence&&call?.type==='custom_tool_call'&&call.name==='exec'?nativePatchLiterals(call.input):null;
    const literalProgram=literalPatches?patchBatchEvidenceProgram(literalPatches,{task,patchEvidenceBinding:this.patchEvidenceBinding}):null;
    const custom=this.typedCustom&&call?.type==="custom_tool_call"&&call.name==="exec"&&typeof call.input==="string"&&call.input.startsWith("// HELIX_JSON\n");
    if(!custom&&!processRead&&!foreground&&!literalProgram&&!receiptOnly&&(call?.type!=="function_call"||call.name!=="helix"))return call;
    const argumentsText=receiptOnly?'{}':literalProgram?JSON.stringify({op:'patch',patch:literalPatches[0]}):foreground?JSON.stringify(foreground.command):processRead?JSON.stringify(processRead):custom?call.input.slice("// HELIX_JSON\n".length):call.arguments;
    if(typeof call.call_id!=="string"||!call.call_id||typeof argumentsText!=="string"||
      (call.status!==undefined&&call.status!=="completed"))throw new Error("Incomplete typed function call");
    let program;
    if(receiptOnly)program=`text(${JSON.stringify({kind:"helix.model_boundary",status:"no_work_executed",reason:"An archived historical-program marker is data, not executable work or a verified recovery handle. Use ordinary commands, code or MCP for the active step; do not copy historical receipt comments as new tool calls."})});`;
    else{
      const parsed=parseNativeOperationArguments(argumentsText);
      try{
        if(parsed.rejection)throw new NativeOperationRejection(parsed.rejection,'Typed operations require one JSON object after the HELIX_JSON directive; no fences or extra text.');
        const options={task,patchEvidenceBinding:this.patchEvidenceBinding};
        const foregroundPatch=foreground?.patch&&this.delegatePatchEvidence?patchEvidenceProgram(foreground.patch,options):null;
        program=literalProgram??(foreground?supervisedForegroundTest(foreground,foregroundPatch):compileNativeOperation(parsed.args,{checkpointBinding:this.checkpointBinding,task,call_id:call.call_id,checkpointPatches:this.checkpointPatches,delegatePatchEvidence:this.delegatePatchEvidence,patchEvidenceBinding:this.patchEvidenceBinding}));
        if(!literalProgram&&parsed.args?.op==='patch'&&this.delegatePatchEvidence)program=patchEvidenceProgram(parsed.args.patch,options)??program;
      }catch(error){
        if(!(error instanceof NativeOperationRejection))throw error;
        program=`text(${JSON.stringify({kind:'helix.model_boundary',status:'no_work_executed',code:error.code,reason:error.message,
          recovery:'Use the documented typed operation or ordinary raw JavaScript. Correct once; do not repeatedly guess or replay a mutation.'})});`;
      }
    }
    const wire={...call,type:"custom_tool_call",name:"exec",status:"completed",input:program};delete wire.arguments;
    const serialized=JSON.stringify({kind:"helix.native-function.v1",original:call,wire});
    const receipt=this.retainOriginal(serialized);
    if(!/^[A-Za-z0-9_-]{43}$/.test(receipt)||this.readOriginal(receipt)!==serialized)throw new Error("Typed call archive recovery failed");
    this.receipts.set(call.call_id,receipt);
    return {...wire,input:program+`\n// HELIX_FUNCTION_ORIGINAL ${receipt}\n`};
  }
  restoreHistory(input) {
    if(!Array.isArray(input))throw new Error("Native history must be an array");
    const restored=new Map(),positions=new Map(),ids=new Set();
    for(const [position,item] of input.entries()){
      if(!["custom_tool_call","function_call"].includes(item?.type))continue;
      if(ids.has(item.call_id))throw new Error("Ambiguous native call IDs");ids.add(item.call_id);
      const match=item.type==="custom_tool_call"&&typeof item.input==="string"?marker.exec(item.input):null;
      const expected=this.lookupReceipt?.(item.call_id)??this.receipts.get(item.call_id);
      if(expected&&(!match||match[1]!==expected))throw new Error("Known typed call marker changed");
      if(!match)continue;
      const record=JSON.parse(this.readOriginal(match[1]));
      if(record.kind!=="helix.native-function.v1")throw new Error("Wrong typed call archive");
      const wire={...item,input:item.input.slice(0,match.index)};
      if(!nativeCallMatches(wire,record.wire)||record.original.call_id!==item.call_id)throw new Error("Native typed call binding changed");
      restored.set(item.call_id,record.original);
      positions.set(item.call_id,position);
    }
    const counts=new Map(),outputs=new Map();
    for(const [position,item] of input.entries())if(["custom_tool_call_output","function_call_output"].includes(item?.type)){
      counts.set(item.call_id,(counts.get(item.call_id)??0)+1);outputs.set(item.call_id,{item,position});
    }
    for(const id of restored.keys()){
      if(counts.get(id)!==1)throw new Error("Typed call needs one complete native output");
      const {item,position}=outputs.get(id);
      if(item.type!=="custom_tool_call_output"||position<=positions.get(id)||(typeof item.output!=="string"&&!Array.isArray(item.output))||
        (item.status!==undefined&&item.status!=="completed"))throw new Error("Invalid typed output binding");
    }
    return input.map((item,position)=>{
      if(item?.type==="custom_tool_call"&&restored.has(item.call_id))return restored.get(item.call_id);
      if(item?.type!=="custom_tool_call_output"||!restored.has(item.call_id))return item;
      if(position<=positions.get(item.call_id)||(typeof item.output!=="string"&&!Array.isArray(item.output)))throw new Error("Invalid typed output binding");
      if(item.status!==undefined&&item.status!=="completed")throw new Error("Incomplete typed output");
      if(restored.get(item.call_id).type==="custom_tool_call")return item;
      const output={...item,type:"function_call_output"};
      if(typeof output.id==="string"&&output.id.startsWith("ctco_"))output.id="ftco_"+output.id.slice(5);
      return output;
    });
  }
}
