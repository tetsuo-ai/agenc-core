import { createAgenCVitestConfig } from './vitest.config.ts';

// This is an explicit operator surface. Unlike the default suite it preserves
// provider credentials and live-test opt-ins, and it does not install the
// public-network tripwire. The factory constructs a complete config so the
// empty setupFiles array cannot be undone by Vite's array-merge semantics.
export default createAgenCVitestConfig('live');
