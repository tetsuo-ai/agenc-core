import { createAgenCVitestConfig } from './vitest.config.ts';

// Exact PowerShell-only allowlist for the hosted capability lane. The normal
// hermetic setup still strips credentials, isolates AgenC state, and installs
// the public-network tripwire.
export default createAgenCVitestConfig('powershell');
