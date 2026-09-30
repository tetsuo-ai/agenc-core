// Inert IPC fixture only: no observer, provider, runtime, filesystem or ledger.
const [mode, raw] = process.argv.slice(2);
const acknowledgments = JSON.parse(raw);
const watchdog = setTimeout(() => finish(70), 8000);
let finished = false;
function finish(code = 0) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  process.exitCode = code;
  if (process.connected) process.disconnect();
}
const send = message => new Promise((resolve, reject) => {
  process.send(message, error => error ? reject(error) : resolve());
});
async function publications() {
  for (const acknowledgment of acknowledgments) await send(acknowledgment);
}
try {
  if (mode === 'task-noop') {
    finish();
  } else if (mode === 'light-owner') {
    // Serialize the two parent commands; do not create detached async handlers.
    let commands = Promise.resolve();
    process.on('message', command => {
      commands = commands.then(async () => {
        if (command === 'publish') await publications();
        else if (command === 'shutdown') finish();
        else finish(71);
      }).catch(() => finish(72));
    });
    await send({kind: 'lifecycle-probe-v5', pid: process.pid, ordinal: 1, connected: true});
  } else if (mode === 'pi-owner' || mode === 'late-invalid') {
    await send({kind: 'lifecycle-probe-v5', pid: process.pid, ordinal: 1, connected: true});
    await publications();
    // Real live IPC after both accepted ACKs, not fabricated post-close events.
    if (mode === 'late-invalid') await send({kind: 'unknown-after-publications'});
    finish();
  } else finish(73);
} catch { finish(74); }
