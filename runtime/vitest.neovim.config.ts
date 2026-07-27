import { createAgenCVitestConfig } from './vitest.config.ts';

// Exact real-Neovim allowlist for the hosted capability lane. The normal
// hermetic setup strips credentials, isolates AgenC state, and installs the
// public-network tripwire.
export default createAgenCVitestConfig('neovim');
