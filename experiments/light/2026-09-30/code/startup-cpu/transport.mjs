// Diagnostic-only CPU profiling. This is not a latency comparison.
import fs from 'node:fs';
import inspector from 'node:inspector';
const session = new inspector.Session();
session.connect();
session.post('Profiler.enable');
session.post('Profiler.setSamplingInterval', { interval: 1000 });
session.post('Profiler.start');
process.once('exit', () => {
  session.post('Profiler.stop', (error, result) => {
    if (error) throw error;
    fs.writeFileSync(`${process.env.LIGHT_BOUNDARY_CAPTURE}.${process.pid}.cpuprofile`,
      JSON.stringify(result.profile), { flag: 'wx', mode: 0o600 });
  });
  session.disconnect();
});
await import('../cli-boundary-diagnostic-v3/transport.mjs');
