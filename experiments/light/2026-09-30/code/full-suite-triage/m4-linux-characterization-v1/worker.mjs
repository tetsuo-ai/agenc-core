import { parentPort } from 'node:worker_threads';
const helper = await import(process.env.M4_CHARACTERIZATION_HELPER);
parentPort.postMessage({ scopeAbsent: process.env.AGENC_TEST_M4_DIAGNOSTIC_SCOPE === undefined,
  emitterAbsent: helper.mark('fixture_entry') === false });
