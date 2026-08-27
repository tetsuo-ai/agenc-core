// Suite-level test hermeticity (TODO task 30).
//
// Runs (via setupFiles in vitest.config.ts) in every worker BEFORE each test
// module loads, so no test can observe the developer's real provider keys,
// live ~/.agenc auth state, or shell-exported AgenC config overrides. See
// tests/helpers/hermetic-env.mjs for the full rationale and the explicit,
// documented strip list (no wildcard AGENC_* sweep).
//
// Network guard for auth: since 97f1baf88 the default auth backend is
// "remote", so an unpinned daemon/CLI test would device-code-login against
// production https://id.agenc.ag. AGENC_AUTH_BACKEND=local (set below) is the
// documented env override for auth.backend and is honored by every real CLI
// entry point that defaults its env snapshot to process.env. Contract tests
// that build synthetic host envs additionally pin `[auth] backend = "local"`
// in their own config.toml (task 27). Reporting id.agenc.ag's auto-approving
// mock device codes to the service owner is handled by the TODO task 30
// orchestrator, not this repo.
//
// AGENC_HOME is pointed at a per-fork temp dir so home-derived reads can never
// touch the developer's live ~/.agenc. Removed home aliases are cleared. Tests
// that need their own AGENC_HOME set it inside the test after this ran.

import {
  getOrCreateHermeticTestHome,
  sanitizeHermeticEnv,
} from './tests/helpers/hermetic-env.mjs'
import { beforeEach } from 'vitest'
// Register host-bound infrastructure mocks before importing ConfigStore or
// any other runtime module that can transitively load those boundaries.
import './tests/helpers/hermetic-managed-policy-mocks.js'
import './tests/helpers/hermetic-secure-storage-mocks.js'
import { ConfigStore } from './src/config/store.js'
import {
  enterStartupProviderSelectionSnapshotForTests as enterStartupProviderSelectionForTestingOnly,
} from './src/utils/model/provider-selection-context.js'
import { enterCanonicalSettingsAuthority } from './src/utils/settings/canonicalAuthority.js'
import { installWorkspaceMutationHomeResolverForTestingOnly } from './src/workspace/mutation-coordinator.js'
import { installNetworkTripwire } from './tests/helpers/network-tripwire.mjs'

// Re-assert at every test-file boundary. The helper also self-installs when
// preloaded into Node children via NODE_OPTIONS.
installNetworkTripwire()

// One hermetic home per worker process; setup files re-run per test file in
// the same fork, so reuse the dir already minted for this process instead of
// littering a new mkdtemp per file. (This also re-asserts the hermetic env
// at every file boundary, undoing cross-file env leaks.)
// The process-global state is created only by this worker; an ambient
// AGENC_TEST_HERMETIC_HOME is never trusted as an input.
const hermeticHome = getOrCreateHermeticTestHome()
sanitizeHermeticEnv(process.env, hermeticHome)
process.env.AGENC_TEST_HERMETIC_HOME = hermeticHome

// Production workspace-mutation state is partitioned by the ConfigStore
// authority. Low-level unit tests intentionally exercise the facade without a
// bootstrapped store, so bind their explicit hermetic home through a test-only
// resolver instead of letting production code rediscover process.env.
installWorkspaceMutationHomeResolverForTestingOnly(() => {
  const home = process.env.AGENC_HOME
  if (home === undefined || home.length === 0) {
    throw new Error('AGENC_HOME is required by the workspace test harness')
  }
  return home
})

// Ordinary unit tests execute without a bootstrapped Session. Give each test
// an explicit canonical startup authority so production code can remain
// fail-closed instead of falling back to mutable process.env selection.
// Provider-selection tests install narrower scopes around their assertions.
beforeEach(() => {
  // Individual tests may deliberately delete or replace process.env. Restore
  // the hermetic ingress before constructing the next test's authority.
  sanitizeHermeticEnv(process.env, hermeticHome)
  process.env.AGENC_TEST_HERMETIC_HOME = hermeticHome
  const environment = Object.freeze({ ...process.env })
  const home = environment.AGENC_HOME
  if (home === undefined || home.length === 0) {
    throw new Error('AGENC_HOME is required by the canonical settings test harness')
  }
  enterCanonicalSettingsAuthority(
    new ConfigStore({
      home,
      env: environment,
      cwd: process.cwd(),
    }),
  )
  enterStartupProviderSelectionForTestingOnly({
    provider: 'grok',
    model: 'grok-4.6',
    environment,
  })
})
