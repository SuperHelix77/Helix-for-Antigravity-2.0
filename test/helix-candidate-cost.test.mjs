import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateCostAdmission} from '../src/helix-candidate-cost.mjs';
test('default disabled preserves normal inference; explicit candidate ceiling uses actual total tokens',()=>{
  const rows=[{usage:{total_tokens:544141,cached_input_tokens:500000,reasoning_tokens:20000}}];
  assert.equal(candidateCostAdmission(rows).admitted,true);
  const rejected=candidateCostAdmission(rows,{enabled:true});assert.equal(rejected.admitted,false);assert.equal(rejected.known_tokens,544141);
  assert.equal(candidateCostAdmission([{usage:{total_tokens:544140}}],{enabled:true}).admitted,true);
});
test('unknown and pending usage remains explicit and is not silently assigned zero',()=>{
  const result=candidateCostAdmission([{usage:{total_tokens:20}},{usage:{total_tokens:null}},{}],{enabled:true,target:25});
  assert.equal(result.admitted,true);assert.equal(result.known_tokens,20);assert.equal(result.unreported_requests,2);
  assert.match(result.reason,/unknown usage/i);
});
test('invalid, negative and overflowing usage is a boundary instead of a cheap fabricated count',()=>{
  for(const value of [-1,1.5,'544141',NaN])assert.throws(()=>candidateCostAdmission([{usage:{total_tokens:value}}],{enabled:true}));
  assert.throws(()=>candidateCostAdmission([{usage:{total_tokens:Number.MAX_SAFE_INTEGER}},{usage:{total_tokens:1}}],{enabled:true}));
});
