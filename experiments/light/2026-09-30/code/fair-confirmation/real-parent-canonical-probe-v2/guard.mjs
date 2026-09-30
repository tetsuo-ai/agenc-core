// Pinned child preload. No transport synthesis, credentials, history, or model.
globalThis.fetch=async()=>{
  if(typeof process.send==='function')process.send({kind:'forbidden-provider-fetch'});
  throw new Error('canonical probe forbids fetch');
};
if(process.env.LIGHT_CANONICAL_PROBE_CASE==='owner-exit-before-readiness')process.exit(73);
