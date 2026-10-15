// Early rejection of a failed experiment, never a smaller acceptance gate.
// Reported totals include cached input and output; reasoning is not added twice.
export function candidateCostAdmission(rows,{enabled=false,target=544140}={}){
  if(!enabled)return {admitted:true,enabled:false};
  if(!Array.isArray(rows)||!Number.isSafeInteger(target)||target<0)throw new Error('Bound candidate rows and actual-token target required');
  let known=0,unknown=0;
  for(const row of rows){
    const tokens=row?.usage?.total_tokens;
    if(tokens===null||tokens===undefined){unknown++;continue;}
    if(!Number.isSafeInteger(tokens)||tokens<0||known+tokens>Number.MAX_SAFE_INTEGER)throw new Error('Invalid measured provider usage');
    known+=tokens;
  }
  return {admitted:known<=target,enabled:true,known_tokens:known,unreported_requests:unknown,target_tokens:target,
    reason:known>target?'Known nonnegative provider tokens exceed this candidate acceptance ceiling; reject further inference, preserve all work and costs.':
      'Known cost is within ceiling; unknown usage still prevents complete-run acceptance.'};
}
