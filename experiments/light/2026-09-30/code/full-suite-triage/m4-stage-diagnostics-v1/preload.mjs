import { installPreload } from './diagnostics.mjs';

// Only the proposed test launcher sets this; no production environment changes.
const scope = process.env.AGENC_TEST_M4_DIAGNOSTIC_SCOPE;
if (['crash', 'recover', 'daemon'].includes(scope)) installPreload(scope);
