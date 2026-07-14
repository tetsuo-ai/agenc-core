import { createAgenCVitestConfig } from './vitest.config.ts';

// Explicit least-privilege design-audit surface. Its dedicated setup preserves
// only design inputs while stripping provider credentials, isolating AGENC_HOME,
// pinning local auth, and installing the Node-process network tripwire. An
// explicitly requested external browser is not covered by that JavaScript guard.
export default createAgenCVitestConfig('design');
