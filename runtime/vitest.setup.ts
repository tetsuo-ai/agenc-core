// Suite-level test hermeticity (TODO task 30).
//
// Runs (via setupFiles in vitest.config.ts) in every worker BEFORE each test
// module loads, so no test can observe the developer's real provider keys,
// live ~/.agenc auth state, or shell-exported AgenC config overrides. See
// tests/helpers/hermetic-env.mjs for the full rationale and the explicit,
// documented strip list (no wildcard AGENC_* sweep; passphrases survive).
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
// AGENC_HOME is pointed at a per-fork temp dir so homedir-derived reads
// (getAgenCConfigHomeDir: AGENC_CONFIG_DIR > AGENC_HOME > $HOME/.agenc) can
// never touch the developer's live ~/.agenc. Tests that need their own
// AGENC_HOME set it inside the test — after this ran — and win.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sanitizeHermeticEnv } from './tests/helpers/hermetic-env.mjs'

// One hermetic home per worker process; setup files re-run per test file in
// the same fork, so reuse the dir already minted for this process instead of
// littering a new mkdtemp per file. (This also re-asserts the hermetic env
// at every file boundary, undoing cross-file env leaks.)
// Stored in its own env var (not AGENC_HOME, which tests legitimately
// reassign) so a test file that leaks its own AGENC_HOME can never become the
// next file's baseline.
const hermeticHome =
  process.env.AGENC_TEST_HERMETIC_HOME ??
  mkdtempSync(join(tmpdir(), 'agenc-vitest-hermetic-home-'))
process.env.AGENC_TEST_HERMETIC_HOME = hermeticHome

sanitizeHermeticEnv(process.env, hermeticHome)
