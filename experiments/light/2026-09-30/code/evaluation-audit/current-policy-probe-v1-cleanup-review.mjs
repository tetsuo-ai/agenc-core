// Executes only the pinned source's finally block with inert stubs. No Core,
// provider, process, filesystem journal or resource constructor is imported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const ts=require('/private/tmp/light-clean-recovery-CDlDMw/source/node_modules/typescript/lib/typescript.js');
const path='/private/tmp/light-takeover/fair-confirmation/current-policy-probe-v1/probe.test.ts';
const raw=readFileSync(path,'utf8');
assert.equal(createHash('sha256').update(raw).digest('hex'),'308a401d8678f0c9d381c92615f20f51803a9762c5f0f2988bc19969c686a0ee');
const ast=ts.createSourceFile(path,raw,ts.ScriptTarget.Latest,true);
const probe=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='probe');
const guarded=probe.body.statements.find(node=>ts.isTryStatement(node));
assert(guarded?.finallyBlock);
const body=guarded.finallyBlock.statements.map(node=>node.getText(ast)).join('\n');
const cleanup=new Function('unbind','session','store','seed','kernel',`return (async()=>{${body}})();`);

async function exercise(failAt) {
  const events=[],marker=new Error('synthetic cleanup failure');
  const step=name=>{events.push(name);if(name===failAt)throw marker;};
  let caught;
  try { await cleanup(()=>step('unbind'),
    {shutdown:async()=>step('session.shutdown'),mountRolloutStore:()=>step('unmount')},
    {close:()=>step('store.close')},{session:{shutdown:async()=>step('seed.shutdown')}},
    {close:()=>step('kernel.close')}); }
  catch(error){caught=error;}
  return {events,marker,caught};
}
test('normal extracted cleanup attempts every registered resource',async()=>{
  assert.deepEqual((await exercise()).events,['unbind','session.shutdown','unmount','store.close','seed.shutdown','kernel.close']);
});
test('session shutdown failure must not skip store/seed/kernel cleanup',async()=>{
  const observed=await exercise('session.shutdown');assert.equal(observed.caught,observed.marker);
  assert(observed.events.includes('store.close'));assert(observed.events.includes('seed.shutdown'));assert(observed.events.includes('kernel.close'));
});
test('store close failure must not skip remaining owned cleanup',async()=>{
  const observed=await exercise('store.close');assert.equal(observed.caught,observed.marker);
  assert(observed.events.includes('seed.shutdown'));assert(observed.events.includes('kernel.close'));
});
