import { describe, it, expect } from 'vitest';
import { recoveryPendingLineCeiling, isLegacyConfiguredCacheWithinCeiling, MAX_LEGACY_SESSION_CONFIGURED_CACHE_BYTES } from '../../src/state/session-configured-cache.js';
import { MAX_RECOVERY_CANONICAL_LINE_BYTES } from '../../src/state/recovery-contract.js';
const cap=MAX_RECOVERY_CANONICAL_LINE_BYTES;
function cache(initialMessages:unknown[],extra={}) { return Buffer.from(JSON.stringify({type:'event_msg',payload:{id:'config',msg:{type:'session_configured',payload:{sessionId:'run',model:'test',modelProviderId:'test',cwd:'/workspace',historyLogId:0,historyEntryCount:1,initialMessages,...extra}},seq:1,eventId:'event:1'},eventVersion:1})); }
describe('legacy session configured display cache',()=>{
 it('reads a valid oversized cache without raising ordinary row or caller budgets',()=>{
  const row=cache([{type:'agent_message',payload:{message:'x'.repeat(cap)}}]);
  expect(isLegacyConfiguredCacheWithinCeiling(row,cap)).toBe(true);
  expect(recoveryPendingLineCeiling([row.subarray(0,30),row.subarray(30)],cap)).toBe(MAX_LEGACY_SESSION_CONFIGURED_CACHE_BYTES);
  expect(recoveryPendingLineCeiling(row,128)).toBe(128);
  expect(isLegacyConfiguredCacheWithinCeiling(row,128)).toBe(false);
 });
 it('keeps oversized authority, malformed caches and oversized metadata fail closed',()=>{
  const row=Buffer.from(JSON.stringify({type:'response_item',payload:{role:'user',content:'x'.repeat(cap)}}));
  expect(recoveryPendingLineCeiling(row,cap)).toBe(cap);
  expect(isLegacyConfiguredCacheWithinCeiling(row,cap)).toBe(false);
  expect(isLegacyConfiguredCacheWithinCeiling(cache([{type:'unknown',payload:{message:'x'.repeat(cap)}}]),cap)).toBe(false);
  expect(isLegacyConfiguredCacheWithinCeiling(cache([],{cwd:'x'.repeat(cap)}),cap)).toBe(false);
 });
});
