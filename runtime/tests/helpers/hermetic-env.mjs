// Test-suite hermeticity: shared env sanitization (TODO task 30).
//
// Shared between the vitest suite (runtime/vitest.setup.ts, wired via
// setupFiles in runtime/vitest.config.ts) and the isolated bun runner
// (runtime/scripts/run-bun-tests-isolated.mjs), which spawns `bun test`
// children that never see vitest's setupFiles.
//
// Why this exists (verified finding, task 27 / TODO task 30):
//   (a) Without setup-time sanitization, tests touching provider-key
//       resolution or homedir auth state see the developer's REAL
//       credentials. On the reference machine an ambient XAI_API_KEY and a
//       live team-tier ~/.agenc/auth.json flipped 11 tests.
//   (b) Since commit 97f1baf88 (default auth backend local -> remote), a
//       daemon/CLI test whose config lacks an explicit `[auth]
//       backend = "local"` performs a REAL device-code login against
//       production https://id.agenc.ag. (That service currently returns
//       auto-approving mock device codes; reporting that to the service
//       owner is tracked by the TODO task 30 orchestrator, not here.)
//
// Design rules:
//   - The strip list is EXPLICIT and documented. No wildcard "delete every
//     AGENC_*" sweep: test-harness vars (AGENC_TRAJECTORY_*, CI plumbing)
//     and vault/key PASSPHRASES must survive. Never strip a passphrase
//     (e.g. AGENC_CLIENT_KEY_PASSPHRASE consumed by src/utils/mtls.ts) —
//     stripping one downgrades a secure re-prompt path.
//   - Stripping happens at setup time, BEFORE any test module loads. A test
//     that sets its own env inside the test body (the hermetic pattern, e.g.
//     withProAuthSession in tests/commands/model.test.ts) is unaffected.

/**
 * Provider credential env vars.
 *
 * Canonical source: BUILT_IN_PROVIDER_API_KEY_ENVS in
 * src/llm/registry/provider-info.ts (one env var per built-in provider slug,
 * including github -> GITHUB_TOKEN and amazon-bedrock -> AWS_ACCESS_KEY_ID),
 * unioned with the alias/companion names the codebase also resolves:
 *   - grok aliases: GROK_API_KEY, AGENC_XAI_API_KEY (src/config/env.ts
 *     resolveApiKey precedence XAI_API_KEY -> GROK_API_KEY -> AGENC_XAI_API_KEY)
 *   - SECRET_ENV_KEYS (src/utils/providerSecrets.ts): OPENAI_AUTH_HEADER_VALUE,
 *     AGENC_API_KEY, GOOGLE_API_KEY, BNKR_API_KEY, ...
 *   - the subprocess scrub precedent (src/utils/subprocessEnv.ts):
 *     ANTHROPIC_AUTH_TOKEN, GEMINI_ACCESS_TOKEN, GH_TOKEN, AWS session creds, ...
 *
 * An ambient value for ANY of these adds a legitimate BYOK provider row to
 * discovery/model-menu logic and breaks hermetic expectations.
 */
export const HERMETIC_PROVIDER_CREDENTIAL_ENV_VARS = Object.freeze([
  // grok (+ aliases)
  'XAI_API_KEY',
  'GROK_API_KEY',
  'AGENC_XAI_API_KEY',
  // openai (+ companions)
  'OPENAI_API_KEY',
  'OPENAI_AUTH_HEADER_VALUE',
  'OPENAI_COMPATIBLE_API_KEY',
  // anthropic (+ companions)
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',
  // remaining built-in providers
  'LMSTUDIO_API_KEY',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'DEEPSEEK_API_KEY',
  'MISTRAL_API_KEY',
  'NVIDIA_API_KEY',
  'MINIMAX_API_KEY',
  'BNKR_API_KEY',
  // gemini / google (+ companions)
  'GEMINI_API_KEY',
  'GEMINI_ACCESS_TOKEN',
  'GOOGLE_API_KEY',
  'GOOGLE_GENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  // github provider key env (BUILT_IN_PROVIDER_API_KEY_ENVS.github) + alias
  'GITHUB_TOKEN',
  'GH_TOKEN',
  // amazon-bedrock (BUILT_IN_PROVIDER_API_KEY_ENVS['amazon-bedrock']) + session creds
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
])

/**
 * AgenC developer-state env vars: hosted-auth/session credentials plus the
 * config-behavior overrides documented at the top of src/config/env.ts. Any
 * of these, exported in a developer's shell, silently reconfigures tests
 * (e.g. AGENC_MODEL flips default-model expectations, AGENC_USE_OPENAI flips
 * provider validation, AGENC_ENV_FILE injects arbitrary env).
 *
 * Deliberately NOT stripped:
 *   - AGENC_CLIENT_KEY_PASSPHRASE (or any *_PASSPHRASE): never strip
 *     passphrases.
 *   - AGENC_HOME / AGENC_AUTH_BACKEND: not stripped but FORCED to hermetic
 *     values below.
 *   - Test-harness vars tests themselves set after setup runs
 *     (AGENC_TRAJECTORY_*, AGENC_DAEMON_* timeout overrides, etc.).
 */
export const HERMETIC_AGENC_STATE_ENV_VARS = Object.freeze([
  // hosted-identity / session credentials (subprocessEnv.ts precedent)
  'AGENC_API_KEY',
  'AGENC_OAUTH_TOKEN',
  'AGENC_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'AGENC_REMOTE_AUTH_TOKEN',
  'AGENC_SESSION_ACCESS_TOKEN',
  // wallet path (a real mainnet vault path must never reach tests);
  // note: the vault PASSPHRASE vars are intentionally left alone
  'AGENC_WALLET',
  // real-config location override (would re-point tests at the developer's
  // live config/auth even after AGENC_HOME is replaced, because
  // AGENC_CONFIG_DIR wins over AGENC_HOME in getAgenCConfigHomeDir)
  'AGENC_CONFIG_DIR',
  // arbitrary env-file injection
  'AGENC_ENV_FILE',
  // config-behavior overrides (src/config/env.ts applyEnvOverrides et al.)
  'AGENC_PROFILE',
  'AGENC_PROVIDER',
  'AGENC_MODEL',
  'AGENC_WORKSPACE',
  'AGENC_SIMPLE',
  'AGENC_AUTONOMOUS',
  'AGENC_MAX_OUTPUT_TOKENS',
  'AGENC_CAPPED_DEFAULT_MAX_OUTPUT_TOKENS',
  'AGENC_MAX_BUDGET_USD',
  'AGENC_AUTH_MANAGED_KEYS_ENABLED',
  // provider-family toggles (providerValidation.ts / provider profiles)
  'AGENC_USE_OPENAI',
  'AGENC_USE_GEMINI',
  'AGENC_USE_MISTRAL',
  'AGENC_USE_GITHUB',
  'AGENC_USE_BEDROCK',
  'AGENC_USE_VERTEX',
  'AGENC_USE_FOUNDRY',
])

/**
 * Explicit switches that turn otherwise-local test files into browser,
 * provider, chain, or design-snapshot live tests. Ambient shell values must
 * never opt the default suite into one of these paths. The dedicated live
 * Vitest config intentionally skips this sanitizer so operator-provided
 * values survive there.
 */
export const HERMETIC_LIVE_TEST_OPT_IN_ENV_VARS = Object.freeze([
  'AGENC_BROWSER_E2E',
  'AGENC_RUN_PROVIDER_INTEGRATION_TESTS',
  'AGENC_RUN_LOCAL_PROVIDER_TESTS',
  'AGENC_TRANSACTION_GUARD_LIVE_E2E',
  'AGENC_TUI_DESIGN_BROWSER',
  'AGENC_TUI_DESIGN_BROWSER_REPORT',
  'AGENC_TUI_DESIGN_DUMP_LIVE',
])

export const HERMETIC_STRIPPED_ENV_VARS = Object.freeze([
  ...HERMETIC_PROVIDER_CREDENTIAL_ENV_VARS,
  ...HERMETIC_AGENC_STATE_ENV_VARS,
  ...HERMETIC_LIVE_TEST_OPT_IN_ENV_VARS,
])

/** Marker proving the hermetic setup ran in this process. */
export const HERMETIC_MARKER_ENV_VAR = 'AGENC_TEST_HERMETIC_ENV'

/**
 * Sanitize `env` in place for hermetic test runs.
 *
 * - Deletes every var in HERMETIC_STRIPPED_ENV_VARS.
 * - Forces AGENC_HOME to `agencHome` (a per-run temp dir) so code that
 *   resolves ~/.agenc (getAgenCConfigHomeDir honors AGENC_CONFIG_DIR then
 *   AGENC_HOME then $HOME) can never read the developer's live auth.json.
 *   Tests that need their own AGENC_HOME set it inside the test, after this
 *   runs, and win.
 * - Forces AGENC_AUTH_BACKEND=local: the documented env override for
 *   auth.backend (src/config/env.ts applyEnvOverrides). Every real CLI entry
 *   point defaults its env snapshot to process.env (src/bin/auth-cli.ts,
 *   src/bin/providers-cli.ts, src/app-server/daemon-cli.ts via host.env), so
 *   this pins the default away from the remote device-code login. Tests that
 *   exercise the remote backend pass their own env snapshot or write
 *   `[auth] backend = "remote"` config and are unaffected; tests built on
 *   synthetic host env objects (daemon-cli contract tests) still pin
 *   `[auth] backend = "local"` in their own config.toml — see the
 *   task-27 breadcrumbs in tests/app-server/daemon-cli.contract.test.ts.
 */
export function sanitizeHermeticEnv(env, agencHome) {
  for (const name of HERMETIC_STRIPPED_ENV_VARS) {
    delete env[name]
  }
  env.AGENC_HOME = agencHome
  env.AGENC_AUTH_BACKEND = 'local'
  env[HERMETIC_MARKER_ENV_VAR] = '1'
  return env
}
