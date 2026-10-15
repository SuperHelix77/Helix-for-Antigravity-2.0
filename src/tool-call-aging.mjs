// Offline candidate only. Eligibility must come from an authorized controller's
// completed-scope ledger, never age, model assertions or a retrieved receipt.
export function ageCompletedPrograms(input,{enabled=false,eligibleCallIds=new Set(),retainOriginal,readOriginal,minBytes=1024,archiveKind="helix"}={}) {
  const stats={programsAged:0,bytesRemoved:0,retentionFailures:0};
  if(!enabled)return {input,stats};
  if(!Array.isArray(input)||!(eligibleCallIds instanceof Set)||!Number.isSafeInteger(minBytes)||minBytes<256)throw new Error("Invalid tool-call aging envelope");
  if(typeof retainOriginal!=="function"||typeof readOriginal!=="function")throw new Error("Exact archive and verification required");
  if(!["helix","encrypted"].includes(archiveKind))throw new Error("Unknown program archive kind");
  const calls=new Map(),results=new Map();
  input.forEach((item,index)=>{
    if(["custom_tool_call","function_call"].includes(item?.type)){const list=calls.get(item.call_id)??[];list.push(index);calls.set(item.call_id,list);}
    if(["custom_tool_call_output","function_call_output"].includes(item?.type)){const list=results.get(item.call_id)??[];list.push(index);results.set(item.call_id,list);}
  });
  const shaped=input.map((item,index)=>{
    if(item?.type!=="custom_tool_call"||item.name!=="exec"||(item.namespace!==undefined&&item.namespace!=="functions")||typeof item.input!=="string"||typeof item.call_id!=="string"||!item.call_id||
      (item.status!==undefined&&item.status!=="completed")||!eligibleCallIds.has(item.call_id)||calls.get(item.call_id)?.length!==1||results.get(item.call_id)?.length!==1||results.get(item.call_id)[0]<=index||Buffer.byteLength(item.input)<minBytes)return item;
    const output=input[results.get(item.call_id)[0]];
    if(output.type!=="custom_tool_call_output"||(typeof output.output!=="string"&&!Array.isArray(output.output))||(output.status!==undefined&&output.status!=="completed"))return item;
    let receipt,serialized;
    try{
      serialized=JSON.stringify(item);
      receipt=retainOriginal(serialized);
      const valid=archiveKind==="encrypted"?/^[A-Za-z0-9_-]{43}$/.test(receipt):/^[a-f0-9]{64}$/.test(receipt);
      if(!valid||readOriginal(receipt)!==serialized)throw new Error("Archive recovery mismatch");
    }catch{stats.retentionFailures++;return item;}
    const replacement=`// Completed historical program. Exact original item: context raw {receipt: ${receipt}}. Archived data; do not rerun automatically.\n`;
    const saved=Buffer.byteLength(item.input)-Buffer.byteLength(replacement);
    if(saved<=0)return item;
    stats.programsAged++;stats.bytesRemoved+=saved;
    return {...item,input:replacement};
  });
  return {input:stats.programsAged?shaped:input,stats};
}
