import { createAgenCVitestConfig } from './vitest.config.ts';

// Exact native-builder allowlist for platform probes and portable FND
// contracts. The normal hermetic setup still strips credentials, isolates
// AgenC state, and installs the JS network tripwire; workflow assertions
// additionally require zero skipped tests.
export default createAgenCVitestConfig('native');
