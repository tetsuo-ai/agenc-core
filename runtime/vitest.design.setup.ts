import {
  getOrCreateHermeticTestHome,
  HERMETIC_DESIGN_INPUT_ENV_VARS,
  sanitizeHermeticEnv,
} from './tests/helpers/hermetic-env.mjs';
import './tests/helpers/hermetic-managed-policy-mocks.js';
import './tests/helpers/hermetic-secure-storage-mocks.js';
import { installNetworkTripwire } from './tests/helpers/network-tripwire.mjs';

installNetworkTripwire();

const hermeticHome = getOrCreateHermeticTestHome();
sanitizeHermeticEnv(process.env, hermeticHome, {
  preserve: HERMETIC_DESIGN_INPUT_ENV_VARS,
});
process.env.AGENC_TEST_HERMETIC_HOME = hermeticHome;
