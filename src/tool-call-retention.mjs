import {retainToolResult,readRetainedToolResult} from "./tool-result-store.mjs";

// Dedicated store: tool-result TTL/purge must not expire historical programs.
// Capacity fails closed; this adapter does not expire or evict any originals.
export function createToolCallRetainer({directory}) {
  if(typeof directory!=="string"||!directory)throw new Error("Explicit program archive directory required.");
  return {archiveKind:"encrypted",retainOriginal:value=>retainToolResult(value,{directory}),
    readOriginal:handle=>readRetainedToolResult(handle,{directory})};
}

export function readToolCallOriginal(handle,{directory,offset=0,limit=8000}={}) {
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<4||limit>24000)throw new Error("Invalid program recovery range.");
  let original;
  try{original=readRetainedToolResult(handle,{directory});}
  catch{throw new Error("Encrypted program original unavailable or failed integrity verification; tool-result handles belong to a separate store.");}
  const bytes=Buffer.from(original,"utf8");
  if(offset>bytes.length)throw new Error("Program recovery offset outside original.");
  const part=bytes.subarray(offset,Math.min(bytes.length,offset+limit));
  let encoding="utf8",content;
  try{content=new TextDecoder("utf8",{fatal:true,ignoreBOM:true}).decode(part);}
  catch{encoding="base64";content=part.toString("base64");}
  return {id:handle,kind:"retained_program",offset,bytes:part.length,total:bytes.length,next_offset:offset+part.length<bytes.length?offset+part.length:null,encoding,content};
}
