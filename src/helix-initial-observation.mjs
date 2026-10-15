import {createCompactReceipt,compactReceiptText} from "./helix-evidence.mjs";

// Opt-in initial observation treatment. Failed/unknown/source outputs remain
// literal; a successful exit still does not establish semantic correctness.
export function initialToolObservation(engine,result,{kind="unknown",budget=2400,minBytes=4096}={}) {
  if(!Number.isSafeInteger(budget)||budget<1024||budget>8000||!Number.isSafeInteger(minBytes)||minBytes<=budget)
    throw new Error("Invalid initial observation budget");
  const stats={projected:false,bytes_before:0,bytes_after:0,receipt:null,raw:null};
  if(typeof result?.stdout!=="string"||typeof result?.stderr!=="string")return {result,stats};
  stats.bytes_before=stats.bytes_after=Buffer.byteLength(result.stdout)+Buffer.byteLength(result.stderr);
  if(kind!=="test"||stats.bytes_before<minBytes)return {result,stats};
  const raw={stdout:engine.archive(Buffer.from(result.stdout)),stderr:engine.archive(Buffer.from(result.stderr))};
  stats.raw=raw;
  const literal=()=>{
    const prefix=`Captured test output; partial if interrupted/capped. Exact stdout ${raw.stdout}; stderr ${raw.stderr}. Recover relevant omissions with context raw.\n`;
    stats.bytes_after=stats.bytes_before+Buffer.byteLength(prefix);
    return {result:{...result,stdout:prefix+result.stdout},stats};
  };
  if(result.exit_code!==0||result.signal||result.failure||result.tooLarge||result.stderr)return literal();
  const receipt=createCompactReceipt(engine,{...raw,exit_code:result.exit_code,signal:null,failure:null});
  const packet=engine.objectJSON(receipt);
  if(!packet.stdout.counts.length||packet.stdout.omitted_counts||packet.stdout.counts.some(c=>!["pytest","tap","helix.tests"].includes(c.kind)||
    (["failed","fail","error","errors","cancelled"].includes(c.label)&&c.value>0)))return literal();
  const compact=compactReceiptText(engine,receipt,{budget})+"\n";
  if(Buffer.byteLength(compact)>=stats.bytes_before)return literal();
  stats.projected=true;stats.bytes_after=Buffer.byteLength(compact);stats.receipt=receipt;
  return {result:{...result,stdout:compact,stderr:""},stats};
}
