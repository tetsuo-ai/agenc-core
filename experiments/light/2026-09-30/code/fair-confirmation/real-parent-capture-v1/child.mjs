// Synthetic IPC protocol producer ONLY: does not import observer or touch ledgers.
const [mode='normal',raw]=process.argv.slice(2);
const ack=JSON.parse(raw);
const send=message=>new Promise((resolve,reject)=>process.send(message,error=>error?reject(error):resolve()));
if(mode==='owner-exit')process.exit(73);
if(mode==='task-noop') {
  process.disconnect();
} else if(mode==='wrong-owner-task') {
  await send(ack);process.disconnect();
} else {
  if(mode==='light-wait') {
    process.on('message',async message=>{
      if(message==='publish')await send(ack);
      else if(message==='shutdown')process.disconnect();
    });
  }
  await send({kind:'lifecycle-probe-v5',pid:process.pid,ordinal:1,connected:true});
  if(mode==='unknown')await send({kind:'unknown'});
  else if(mode==='malformed')await send({...ack,extra:true});
  else if(mode==='wrong-channel')await send({...ack,channel_id:'other-owner'});
  else if(mode==='wrong-order')await send({...ack,call_ordinal:2});
  else if(mode!=='capture-failure'&&mode!=='light-wait') {
    await send(ack);
    if(mode==='duplicate')await send(ack);
  }
  if(mode!=='light-wait') {
    if(mode==='nonzero')process.exitCode=7;
    process.disconnect();
  }
}
