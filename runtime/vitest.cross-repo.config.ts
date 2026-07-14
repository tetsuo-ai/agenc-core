import { createAgenCVitestConfig } from './vitest.config.ts';

// Explicit non-gating contracts for separately checked-out AgenC repositories.
// The normal hermetic setup still strips credentials and installs the JS
// network tripwire; only the sibling-repository filesystem dependency differs.
export default createAgenCVitestConfig('cross-repo');
