import { createAgenCVitestConfig } from './vitest.config.ts';

// Exact real-kernel bubblewrap allowlist for the disposable hosted Linux lane.
// The test fails closed unless the runner can create real user, PID, mount,
// and network namespaces.
export default createAgenCVitestConfig('kernel');
