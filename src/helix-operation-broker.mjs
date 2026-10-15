import {createHash} from "node:crypto";
import {randomUUID} from "node:crypto";
import {NativeFunctionBridge,nativeCallMatches,nativeProcessRead,nativeForegroundTest,parseNativeOperationArguments} from "./helix-native-function-bridge.mjs";

const canonical=value=>JSON.stringify(value,(_,item)=>item&&typeof item==="object"&&!Array.isArray(item)?
  Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const hash=value=>createHash("sha256").update(canonical(value)).digest("hex");
const executable=item=>["custom_tool_call","function_call"].includes(item?.type);
const normalize=value=>{const copy={...value};if(copy.status===undefined||copy.status==="completed")delete copy.status;return copy;};
function cellState(output){
  const first=typeof output==="string"?output:Array.isArray(output)&&output[0]?.type==="input_text"?output[0].text:null;
  if(typeof first!=="string")return {kind:"unknown"};
  const pending=/^Script running with cell ID ([A-Za-z0-9_-]+)(?:\n|$)/.exec(first);
  if(pending)return {kind:"pending",cell_id:pending[1]};
  if(/^Script (?:completed|failed)\n/.test(first))return {kind:"terminal"};
  return {kind:"unknown"};
}
export class HelixOperationBroker {
  constructor({engine,retainer,scope,authorize,delegateNativeWaits=false,delegateProcessReads=false,delegateForegroundTests=false,delegatePatchEvidence=false,patchEvidenceBinding,guardReceiptPrograms=false,checkpointBinding,checkpointPatches=false}={}) {
    if(!engine?.db||!retainer||typeof scope!=="string"||!scope||scope.length>200||typeof authorize!=="function")
      throw new Error("Bound controller scope, archive and authorization required");
    this.engine=engine;this.retainer=retainer;this.scope=scope;this.authorize=authorize;
    this.delegateNativeWaits=delegateNativeWaits;
    this.delegateProcessReads=delegateProcessReads;
    this.delegateForegroundTests=delegateForegroundTests;
    this.delegatePatchEvidence=delegatePatchEvidence;
    engine.db.exec(`CREATE TABLE IF NOT EXISTS helix_native_dispatch(
      scope TEXT NOT NULL,call_id TEXT NOT NULL,task TEXT NOT NULL,receipt TEXT NOT NULL,
      bridge_receipt TEXT,phase TEXT NOT NULL,output_sha256 TEXT,
      PRIMARY KEY(scope,call_id))`);
    engine.db.exec(`CREATE TABLE IF NOT EXISTS helix_native_waits(
      scope TEXT NOT NULL,parent_id TEXT NOT NULL,wait_id TEXT NOT NULL,cell_id TEXT NOT NULL,
      epoch TEXT NOT NULL,receipt TEXT NOT NULL,output_sha256 TEXT,
      PRIMARY KEY(scope,wait_id))`);
    this.bridge=new NativeFunctionBridge({...retainer,typedCustom:true,delegateProcessReads,delegateForegroundTests,delegatePatchEvidence,patchEvidenceBinding,guardReceiptPrograms,checkpointBinding,checkpointPatches,
      lookupReceipt:id=>this.row(id)?.bridge_receipt??undefined});
  }
  row(id){return this.engine.db.prepare("SELECT * FROM helix_native_dispatch WHERE scope=? AND call_id=?").get(this.scope,id);}
  prepare(response,{task,signal,epoch=null}={}) {
    signal?.throwIfAborted();
    if(response?.status!=="completed"||!Array.isArray(response.output)||typeof task!=="string"||!task)
      throw new Error("Complete response and current task required");
    const pending=[],ids=new Set();
    const output=response.output.map(item=>{
      if(!executable(item))return item;
      if(typeof item.call_id!=="string"||!item.call_id||ids.has(item.call_id)||this.row(item.call_id))
        throw new Error("Repeated or ambiguous dispatch; never replay a mutation");
      ids.add(item.call_id);
      const authorized=this.authorize(structuredClone({scope:this.scope,task,call:item}));
      if(authorized&&typeof authorized.then==='function'){
        Promise.resolve(authorized).catch(()=>{});
        throw new Error("Synchronous operation authorization required");
      }
      if(authorized!==true)
        throw new Error("Current task does not authorize this operation");
      const wire=this.bridge.toNative(item,{task});
      const args=item.type==="custom_tool_call"&&item.input?.startsWith("// HELIX_JSON\n")?parseNativeOperationArguments(item.input.slice("// HELIX_JSON\n".length)).args:
        item.type==="function_call"&&item.name==="helix"?parseNativeOperationArguments(item.arguments).args:this.delegateProcessReads?nativeProcessRead(item.input):null;
      let wait_cell_id=null;
      if(this.delegateNativeWaits&&item.type==='function_call'&&item.name==='wait'&&[undefined,'functions'].includes(item.namespace)){
        const declared=JSON.parse(item.arguments);
        if(declared.terminate!==true&&typeof declared.cell_id==='string'&&/^[A-Za-z0-9_-]+$/.test(declared.cell_id))wait_cell_id=declared.cell_id;
      }
      const foreground=this.delegateForegroundTests&&item.type==='custom_tool_call'&&item.name==='exec'&&nativeForegroundTest(item.input,{task});
      const patchEvidence=this.delegatePatchEvidence&&wire!==item&&
        (wire.input?.startsWith('let patchError=null;let patchFailed=false;\n')||wire.input?.startsWith('{\nlet patchError=null;let patchFailed=false;\n'));
      const delegate_wait=wait_cell_id!==null||!!foreground||!!patchEvidence||!!args&&(["command","mcp","process_wait","checkpoint"].includes(args.op)||(args.op==="code"&&args.wait_for_completion===true));
      if(epoch!==null&&(typeof epoch!=="string"||!epoch))throw new Error("Invalid native execution epoch");
      const packet=JSON.stringify({kind:"helix.dispatch.v1",scope:this.scope,task,epoch,original:item,wire,delegate_wait,...(wait_cell_id?{wait_cell_id}:{})});
      const receipt=this.retainer.retainOriginal(packet);
      if(!/^[A-Za-z0-9_-]{43}$/.test(receipt)||this.retainer.readOriginal(receipt)!==packet)
        throw new Error("Dispatch archive recovery failed");
      pending.push({call_id:item.call_id,receipt,bridge_receipt:wire===item?null:this.bridge.receipts.get(item.call_id)});
      return wire;
    });
    signal?.throwIfAborted();
    // All-or-none reservation precedes executable delivery. Reserved/issued
    // records remain non-replayable if the socket closes before acknowledgement.
    this.engine.transaction(()=>{
      for(const p of pending)this.engine.db.prepare("INSERT INTO helix_native_dispatch VALUES(?,?,?,?,?,'reserved',NULL)")
        .run(this.scope,p.call_id,task,p.receipt,p.bridge_receipt);
    });
    return {response:{...response,output},call_ids:pending.map(p=>p.call_id)};
  }
  issued(ids){
    this.engine.transaction(()=>{for(const id of ids){
      if(this.row(id)?.phase!=="reserved")throw new Error("Dispatch is not reserved");
      this.engine.db.prepare("UPDATE helix_native_dispatch SET phase='issued' WHERE scope=? AND call_id=?").run(this.scope,id);
    }});
  }
  uncertain(ids){
    for(const id of ids)this.engine.db.prepare("UPDATE helix_native_dispatch SET phase='uncertain' WHERE scope=? AND call_id=? AND phase!='acknowledged'").run(this.scope,id);
  }
  restore(input){
    const logical=this.bridge.restoreHistory(input);
    const calls=new Map(),outputs=new Map();
    input.forEach((item,index)=>{
      if(executable(item)){if(calls.has(item.call_id))throw new Error("Duplicate native call");calls.set(item.call_id,{item,index});}
      if(["custom_tool_call_output","function_call_output"].includes(item?.type)){
        if(outputs.has(item.call_id))throw new Error("Duplicate native result");outputs.set(item.call_id,{item,index});
      }
    });
    const acknowledged=[],originals=new Map();
    for(const [id,entry] of calls){
      const row=this.row(id);if(!row)continue;
      const saved=JSON.parse(this.retainer.readOriginal(row.receipt)),result=outputs.get(id);
      if(saved.kind!=="helix.dispatch.v1"||saved.scope!==this.scope||saved.task!==row.task)
        throw new Error("Dispatch scope archive mismatch");
      const wire={...entry.item};
      if(!nativeCallMatches(wire,saved.wire)||!result||result.index<=entry.index||
        result.item.type!==(saved.wire.type==='function_call'?'function_call_output':'custom_tool_call_output')||
        (typeof result.item.output!=="string"&&!Array.isArray(result.item.output))||
        (result.item.status!==undefined&&result.item.status!=="completed"))throw new Error("Dispatch/result binding changed");
      const observedCell=cellState(result.item.output);
      if(saved.wait_cell_id&&observedCell.kind==='pending'&&observedCell.cell_id!==saved.wait_cell_id)
        throw new Error('Declared native wait cell changed');
      const outputHash=hash(result.item);
      if(row.output_sha256&&row.output_sha256!==outputHash)throw new Error("Acknowledged native output changed");
      acknowledged.push({id,outputHash});
      originals.set(id,saved.original);
    }
    this.engine.transaction(()=>{for(const p of acknowledged)this.engine.db.prepare("UPDATE helix_native_dispatch SET phase='acknowledged',output_sha256=? WHERE scope=? AND call_id=?")
      .run(p.outputHash,this.scope,p.id);});
    return logical.map(item=>executable(item)&&originals.has(item.call_id)?originals.get(item.call_id):item);
  }
  beforeInference(input,{epoch,authorizeContinuation,maxWaits=32,signal,model="gpt-6.1-sol"}={}) {
    signal?.throwIfAborted();
    if(typeof epoch!=="string"||!epoch||typeof authorizeContinuation!=="function"||!Number.isSafeInteger(maxWaits)||maxWaits<1||maxWaits>32)
      throw new Error("Actual execution epoch and bounded continuation authority required");
    let logical=this.restore(input);const synthetic=new Set();
    const waitRows=this.engine.db.prepare("SELECT rowid,* FROM helix_native_waits WHERE scope=? ORDER BY rowid").all(this.scope);
    const byParent=new Map();
    for(const row of waitRows){synthetic.add(row.wait_id);const rows=byParent.get(row.parent_id)??[];rows.push(row);byParent.set(row.parent_id,rows);}
    for(const row of this.engine.db.prepare("SELECT * FROM helix_native_dispatch WHERE scope=?").all(this.scope)){
      if(row.phase!=="acknowledged")throw new Error("Unacknowledged dispatch requires review; do not infer/retry blindly");
      const initial=input.find(item=>item.call_id===row.call_id&&["custom_tool_call_output","function_call_output"].includes(item.type));
      if(!initial)continue; // Compacted acknowledged history is not rerun.
      const packet=JSON.parse(this.retainer.readOriginal(row.receipt));
      if(!packet.delegate_wait||cellState(initial.output).kind!=="pending")continue;
      const cell=cellState(initial.output).cell_id,rows=byParent.get(row.call_id)??[];
      if(packet.wait_cell_id&&packet.wait_cell_id!==cell)throw new Error('Declared native wait cell changed');
      let latest=initial,waiting=null;const chunks=[initial.output];
      for(const wait of rows){
        const record=JSON.parse(this.retainer.readOriginal(wait.receipt));
        const calls=input.filter(item=>item.call_id===wait.wait_id&&item.type==="function_call");
        const outputs=input.filter(item=>item.call_id===wait.wait_id&&item.type==="function_call_output");
        if(calls.length!==1||outputs.length!==1||canonical(normalize(calls[0]))!==canonical(normalize(record.call))||wait.cell_id!==cell)
          throw new Error("Deterministic wait delivery is missing or changed");
        const outputHash=hash(outputs[0]);if(wait.output_sha256&&wait.output_sha256!==outputHash)throw new Error("Deterministic wait result changed");
        this.engine.db.prepare("UPDATE helix_native_waits SET output_sha256=? WHERE scope=? AND wait_id=?").run(outputHash,this.scope,wait.wait_id);
        latest=outputs[0];chunks.push(latest.output);waiting=wait;
      }
      const state=cellState(latest.output);
      if(state.kind==="unknown"||(state.kind==="pending"&&state.cell_id!==cell))throw new Error("Unknown native cell state; no automatic guess");
      if(state.kind==="pending"){
        if(packet.epoch!==epoch)throw new Error("Execution epoch changed; stale cells cannot be resumed");
        if(rows.length>=maxWaits)throw new Error("Deterministic wait budget reached; review required");
        if(waiting&&waiting.epoch!==epoch)throw new Error("Execution epoch changed; stale cells cannot be resumed");
        const authorized=authorizeContinuation(structuredClone({scope:this.scope,task:row.task,parent_id:row.call_id,cell_id:cell,epoch}));
        if(authorized&&typeof authorized.then==='function'){
          Promise.resolve(authorized).catch(()=>{});
          throw new Error("Synchronous continuation authorization required");
        }
        if(authorized!==true)
          throw new Error("Current operation does not authorize further waiting");
        const wait_id="call_helix_wait_"+randomUUID().replaceAll("-","");
        const call={type:"function_call",id:"fc_"+wait_id,name:"wait",call_id:wait_id,
          arguments:JSON.stringify({cell_id:cell,yield_time_ms:30000,max_tokens:8000})};
        const serialized=JSON.stringify({kind:"helix.native-wait.v1",scope:this.scope,parent_id:row.call_id,cell_id:cell,epoch,call});
        const receipt=this.retainer.retainOriginal(serialized);if(this.retainer.readOriginal(receipt)!==serialized)throw new Error("Wait archive mismatch");
        signal?.throwIfAborted();
        this.engine.db.prepare("INSERT INTO helix_native_waits VALUES(?,?,?,?,?,?,NULL)").run(this.scope,row.call_id,wait_id,cell,epoch,receipt);
        return {continuation:{id:"resp_controller_"+randomUUID().replaceAll("-",""),object:"response",created_at:Math.floor(Date.now()/1000),status:"completed",model,output:[call]},
          origin:"controller",external_model_calls:0};
      }
      logical=logical.map(item=>item.call_id===row.call_id&&["custom_tool_call_output","function_call_output"].includes(item.type)?
        {...item,output:JSON.stringify({native_cell:"terminal",observations:chunks})}:item);
    }
    logical=logical.filter(item=>!synthetic.has(item.call_id));
    return {input:logical,deterministic_waits:waitRows.length};
  }
}

export async function captureBrokeredResponse({body,res,broker,task,epoch=null,onLine=()=>{},onCapture=()=>{},signal,maxBytes=16*1024*1024}) {
  const decoder=new TextDecoder("utf-8",{fatal:true}),held=new Set();let raw="",pending="",frame=[],completed=false,eof=false,error=null,ids=[],providerFailure=null;
  const send=async event=>{
    signal?.throwIfAborted();
    if(res.destroyed||res.writableEnded)throw new Error("Native response delivery closed");
    const data=`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    if(!res.write(data))await new Promise((resolve,reject)=>{
      const cleanup=()=>{res.off("drain",done);res.off("close",close);signal?.removeEventListener("abort",abort);};
      const done=()=>{cleanup();resolve();},close=()=>{cleanup();reject(new Error("Native delivery closed"));},abort=()=>{cleanup();reject(new Error("Native delivery cancelled"));};
      res.once("drain",done);res.once("close",close);signal?.addEventListener("abort",abort,{once:true});
    });
  };
  const consumeFrame=async()=>{
    if(!frame.length)return;
    const data=frame.filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trimStart()).join("\n");frame=[];
    if(!data||data==="[DONE]")return;
    const event=JSON.parse(data);
    if(providerFailure||completed)throw new Error('Provider event arrived after terminal response');
    if(event.type==="response.output_item.added"&&executable(event.item))held.add(event.output_index);
    if(event.type==="response.output_item.done"&&executable(event.item))held.add(event.output_index);
    if(event.type==="response.completed"){
      const prepared=await broker.prepare(event.response,{task,signal,epoch});ids=prepared.call_ids;
      broker.issued(ids);
      for(const [index,item] of prepared.response.output.entries())if(executable(item)){
        await send({type:"response.output_item.added",output_index:index,item});
        await send({type:"response.output_item.done",output_index:index,item});
      }
      await send({...event,response:prepared.response});completed=true;return;
    }
    if(event.type==='response.failed'){
      if(event.response?.status!=='failed'||!event.response.error||typeof event.response.error.code!=='string')
        throw new Error('Malformed provider failure; executable calls not dispatched');
      providerFailure={code:event.response.error.code,message:typeof event.response.error.message==='string'?event.response.error.message:null};
      await send({...event,response:{...event.response,output:[]}});return;
    }
    if(held.has(event.output_index))return;
    if(/(?:custom_tool_call_input|function_call_arguments)\.(?:delta|done)$/.test(event.type))throw new Error("Tool delta arrived without a declared held item");
    if(event.type==="response.created"&&event.response)await send({...event,response:{...event.response,output:[]}});
    else await send(event);
  };
  const consume=async text=>{
    pending+=text;let end;
    while((end=pending.indexOf("\n"))>=0){const line=pending.slice(0,end).replace(/\r$/,"");pending=pending.slice(end+1);onLine(line);
      if(!line)await consumeFrame();else frame.push(line);
    }
  };
  try{
    for await(const chunk of body){signal?.throwIfAborted();const text=decoder.decode(chunk,{stream:true});raw+=text;
      if(Buffer.byteLength(raw)>maxBytes)throw new Error("Provider stream capture cap exceeded");await consume(text);
    }
    const tail=decoder.decode();raw+=tail;await consume(tail);if(pending){onLine(pending);frame.push(pending);}await consumeFrame();eof=true;
    if(!completed&&!providerFailure)throw new Error("Incomplete provider stream; executable calls not dispatched");
  }catch(caught){error=String(caught.message);broker.uncertain(ids);throw caught;}
  finally{onCapture({raw,eof,error,bytes:Buffer.byteLength(raw),completed,provider_failure:providerFailure});}
  if(!res.destroyed&&!res.writableEnded)res.end();return {raw,eof,error,completed,provider_failure:providerFailure};
}
