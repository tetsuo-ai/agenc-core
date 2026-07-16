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
//     are left alone unless they are known ambient inputs. Credential
//     passphrases are explicitly stripped; tests that need one set a fixture
//     after setup rather than inheriting a developer's secret.
//   - Stripping happens at setup time, BEFORE any test module loads. A test
//     that sets its own env inside the test body (the hermetic pattern, e.g.
//     withProAuthSession in tests/commands/model.test.ts) is unaffected.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const HERMETIC_HOME_STATE = Symbol.for('agenc.test.hermetic-home.state')
const HERMETIC_RUNTIME_MARKER = Symbol.for(
  'agenc.test.hermetic-runtime.marker',
)
const HERMETIC_RUNTIME_MARKER_VERSION =
  'agenc-hermetic-network-tripwire-v1'

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
  'DASHSCOPE_API_KEY',
  'PROVIDER_CODE_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'HF_TOKEN',
  'HUGGINGFACE_TOKEN',
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
  'AWS_BEDROCK_ACCESS_KEY_ID',
  'AWS_BEDROCK_SECRET_ACCESS_KEY',
  'AWS_BEDROCK_SESSION_TOKEN',
  // web-search provider credentials (WebSearch auto-chain)
  'FIRECRAWL_API_KEY',
  'TAVILY_API_KEY',
  'EXA_API_KEY',
  'YOU_API_KEY',
  'JINA_API_KEY',
  'BING_API_KEY',
  'MOJEEK_API_KEY',
  'LINKUP_API_KEY',
  'AGENC_WEB_SEARCH_API_KEY',
  'WEB_KEY',
  'WEB_AUTH_HEADER',
  'WEB_HEADERS',
])

/**
 * Non-provider credentials and credential-bearing paths consumed by runtime
 * subsystems. These are separate from behavior/state overrides so reviewers
 * can compare the list directly with subprocessEnv.ts, gateway/run.ts, MCP
 * auth, mTLS, and session-ingress auth.
 */
export const HERMETIC_RUNTIME_AUTH_ENV_VARS = Object.freeze([
  // MCP OAuth / XAA
  'MCP_CLIENT_SECRET',
  'MCP_XAA_IDP_CLIENT_SECRET',
  // mTLS and cloud-client identity
  'AGENC_CLIENT_CERT',
  'AGENC_CLIENT_KEY',
  'AGENC_CLIENT_KEY_PASSPHRASE',
  'AZURE_CLIENT_SECRET',
  'AZURE_CLIENT_CERTIFICATE_PATH',
  // descriptor/path based hosted and session credentials
  'AGENC_API_KEY_FILE_DESCRIPTOR',
  'AGENC_WEBSOCKET_AUTH_FILE_DESCRIPTOR',
  'AGENC_SESSION_INGRESS_TOKEN_FILE',
  'AGENC_REMOTE_TOKEN_DIR',
  // gateway transport/data credentials
  'AGENC_GATEWAY_HELIUS_API_KEY',
  'AGENC_GATEWAY_HELIUS_KEY_FILE',
  'AGENC_GATEWAY_HOOKS_TOKEN',
  'AGENC_TELEGRAM_BOT_TOKEN',
  'AGENC_TELEGRAM_OWNER_CLAIM_CODE',
  'AGENC_WEBCHAT_TOKEN',
  'AGENC_DISCORD_BOT_TOKEN',
  'AGENC_SLACK_BOT_TOKEN',
  'AGENC_SLACK_APP_TOKEN',
  'AGENC_HOOKS_TOKEN',
  // CI credentials inherited by raw child-process tests
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_RUNTIME_TOKEN',
  'ACTIONS_RUNTIME_URL',
  'ALL_INPUTS',
  'OVERRIDE_GITHUB_TOKEN',
  'DEFAULT_WORKFLOW_TOKEN',
  'SSH_SIGNING_KEY',
])

/**
 * AgenC developer-state env vars: hosted-auth/session credentials plus the
 * config-behavior overrides documented at the top of src/config/env.ts. Any
 * of these, exported in a developer's shell, silently reconfigures tests
 * (e.g. AGENC_MODEL flips default-model expectations, AGENC_USE_OPENAI flips
 * provider validation, AGENC_ENV_FILE injects arbitrary env).
 *
 * Deliberately NOT stripped:
 *   - AGENC_HOME / AGENC_CONFIG_DIR / AGENC_AUTH_BACKEND: not stripped but
 *     FORCED to hermetic values below.
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
  'AGENC_REMOTE',
  'AGENC_CREDENTIAL_SOURCE',
  // wallet path and unlock secret (real signing material must not reach tests)
  'AGENC_WALLET',
  'AGENC_WALLET_VAULT_PASSPHRASE',
  // arbitrary env-file injection
  'AGENC_ENV_FILE',
  // config-behavior overrides (src/config/env.ts applyEnvOverrides et al.)
  'AGENC_PROFILE',
  'AGENC_PROVIDER',
  'AGENC_MODEL',
  'AGENC_WORKSPACE',
  'AGENC_SIMPLE',
  'AGENC_BARE',
  'AGENC_AUTONOMOUS',
  'AGENC_MAX_OUTPUT_TOKENS',
  'AGENC_CAPPED_DEFAULT_MAX_OUTPUT_TOKENS',
  'AGENC_MAX_BUDGET_USD',
  'AGENC_AUTH_MANAGED_KEYS_ENABLED',
  // ambient authorization/profile switches must not weaken a default worker
  'AGENC_ALLOW_UNTRUSTED_HOOKS',
  'AGENC_DISABLE_COMMAND_INJECTION_CHECK',
  'AGENC_DISABLE_STRICT_TOOLS',
  'AGENC_ADDITIONAL_PROTECTION',
  'AGENC_SUBPROCESS_ENV_NO_SCRUB',
  'AGENC_SUBPROCESS_ENV_SCRUB',
  'AGENC_PROVIDER_PROFILE_ENV_APPLIED',
  'AGENC_PROVIDER_PROFILE_ENV_APPLIED_ID',
  'USER_TYPE',
  // endpoints and subprocess/service activation
  'AGENC_BACKEND_URL',
  'AGENC_DAEMON_URL',
  'AGENC_DAEMON_AUTOSTART',
  'AGENC_IDE_HOST_OVERRIDE',
  'AGENC_SSE_PORT',
  'AGENC_INTERNAL_ARTIFACTORY_BASE_URL',
  'AGENC_INTERNAL_ARTIFACTORY_REGISTRY_URL',
  'BEDROCK_BASE_URL',
  'VERTEX_BASE_URL',
  'AGENC_REMOTE_SEND_KEEPALIVES',
  'AGENC_ENABLE_PROMPT_SUGGESTION',
  'AGENC_PROMPT_SUGGESTION_ENABLED',
  'AGENC_AUTO_BACKGROUND_TASKS',
  'AGENC_SYNC_PLUGIN_INSTALL',
  'AGENC_USE_COWORK_PLUGINS',
  'FORCE_VCR',
  'VCR_RECORD',
  // provider-family toggles (providerValidation.ts / provider profiles)
  'AGENC_USE_OPENAI',
  'AGENC_USE_GEMINI',
  'AGENC_USE_MISTRAL',
  'AGENC_USE_GITHUB',
  'AGENC_USE_BEDROCK',
  'AGENC_USE_VERTEX',
  'AGENC_USE_FOUNDRY',
  'AGENC_USE_MINIMAX',
  'AGENC_PROVIDER_MANAGED_BY_HOST',
  'AGENC_SKIP_BEDROCK_AUTH',
  'AGENC_SKIP_VERTEX_AUTH',
  'AGENC_SKIP_FOUNDRY_AUTH',
  // MCP process injection, mutation, OAuth, and sizing overrides
  'AGENC_MCP_SERVERS',
  'AGENC_MCP_ALLOW_MUTATIONS',
  'AGENC_SHELL_PREFIX',
  'AGENC_ENABLE_XAA',
  'MCP_OAUTH_CLIENT_METADATA_URL',
  'MCP_OAUTH_CALLBACK_PORT',
  'MCP_TIMEOUT',
  'MCP_TOOL_TIMEOUT',
  'MCP_SERVER_CONNECTION_BATCH_SIZE',
  'MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE',
  'AGENC_MCP_INSTR_DELTA',
  'AGENC_AGENT_SDK_MCP_NO_PREFIX',
  'ENABLE_MCP_LARGE_OUTPUT_FILES',
  'MAX_MCP_OUTPUT_TOKENS',
  // transaction-guard behavior and live wallet/RPC inputs (the live config
  // has no hermetic setup, so explicit operator values still survive there)
  'AGENC_TRANSACTION_GUARD',
  'AGENC_TRANSACTION_GUARD_MODEL',
  'AGENC_TRANSACTION_GUARD_OLLAMA_URL',
  'AGENC_TRANSACTION_GUARD_FAIL_MODE',
  'AGENC_TRANSACTION_GUARD_TIMEOUT_MS',
  'AGENC_TRANSACTION_GUARD_MAX_DOCKET_BYTES',
  'AGENC_TRANSACTION_GUARD_DEVNET_RPC',
  'AGENC_TRANSACTION_GUARD_DEVNET_RPC_ALLOWED_HOSTS',
  'AGENC_TRANSACTION_GUARD_DEVNET_KEYPAIR',
  // provider profile, model, account, and cloud-routing overrides
  'OPENAI_MODEL',
  'OPENAI_API_FORMAT',
  'OPENAI_AUTH_HEADER',
  'OPENAI_AUTH_SCHEME',
  'OPENAI_ORGANIZATION',
  'OPENAI_PROJECT',
  'ANTHROPIC_MODEL',
  'OLLAMA_MODEL',
  'LMSTUDIO_MODEL',
  'OPENAI_COMPATIBLE_MODEL',
  'OPENROUTER_MODEL',
  'GROQ_MODEL',
  'DEEPSEEK_MODEL',
  'GEMINI_MODEL',
  'MISTRAL_MODEL',
  'NVIDIA_MODEL',
  'MINIMAX_MODEL',
  'GITHUB_MODEL',
  'AWS_BEDROCK_MODEL',
  'BANKR_MODEL',
  'NVIDIA_NIM',
  'GEMINI_AUTH_MODE',
  'GEMINI_CACHED_CONTENT',
  'CHATGPT_ACCOUNT_ID',
  'AGENC_ACCOUNT_ID',
  'PROVIDER_CODE_ACCOUNT_ID',
  'PROVIDER_CODE_AUTH_JSON_PATH',
  'PROVIDER_CODE_HOME',
  'AWS_BEDROCK_REGION',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'GEMINI_VERTEX_LOCATION',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_REGION',
  'CLOUD_ML_REGION',
  'GOOGLE_CLOUD_PROJECT',
  'GCLOUD_PROJECT',
  'GOOGLE_PROJECT_ID',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  // web-search selection and custom routing
  'WEB_SEARCH_PROVIDER',
  'WEB_SEARCH_API',
  'WEB_PROVIDER',
  'WEB_URL_TEMPLATE',
  'WEB_AUTH_SCHEME',
  'WEB_BODY_TEMPLATE',
  'WEB_CUSTOM_ALLOW_ARBITRARY_HEADERS',
  'WEB_CUSTOM_ALLOW_HTTP',
  'WEB_CUSTOM_ALLOW_PRIVATE',
  'WEB_CUSTOM_MAX_BODY_KB',
  'WEB_CUSTOM_TIMEOUT_SEC',
  'WEB_JSON_PATH',
  'WEB_METHOD',
  'WEB_PARAMS',
  'WEB_QUERY_PARAM',
  'AGENC_WEB_SEARCH_KIND',
  'AGENC_WEB_SEARCH_ENDPOINT',
  // provider endpoint overrides; literal-loopback values would otherwise
  // bypass the JS tripwire while silently changing test routing
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_COMPATIBLE_BASE_URL',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'OLLAMA_BASE_URL',
  'LMSTUDIO_BASE_URL',
  'OPENROUTER_BASE_URL',
  'GROQ_BASE_URL',
  'DEEPSEEK_BASE_URL',
  'GEMINI_BASE_URL',
  'MISTRAL_BASE_URL',
  'NVIDIA_BASE_URL',
  'MINIMAX_BASE_URL',
  'GITHUB_BASE_URL',
  'AWS_BEDROCK_BASE_URL',
  'BANKR_BASE_URL',
  'ATOMIC_CHAT_BASE_URL',
  'ANTHROPIC_UNIX_SOCKET',
  // OAuth endpoint and session-ingress routing
  'USE_LOCAL_OAUTH',
  'USE_STAGING_OAUTH',
  'AGENC_CUSTOM_OAUTH_URL',
  'AGENC_LOCAL_OAUTH_API_BASE',
  'AGENC_LOCAL_OAUTH_APPS_BASE',
  'AGENC_LOCAL_OAUTH_CONSOLE_BASE',
  'AGENC_OAUTH_CLIENT_ID',
  'SESSION_INGRESS_URL',
  // gateway/channel activation, behavior, and permission overrides
  'AGENC_GATEWAY_AGENT_PERMISSION_MODE',
  'AGENC_GATEWAY_AGENT_UNATTENDED_ALLOW',
  'AGENC_GATEWAY_AGENT_UNATTENDED_DENY',
  'AGENC_GATEWAY_HELIUS_ENABLED',
  'AGENC_GATEWAY_HELIUS_DAILY_LIMIT',
  'AGENC_GATEWAY_HELIUS_MAX_TOKEN_ACCOUNTS',
  'AGENC_GATEWAY_HELIUS_PER_PEER_LIMIT',
  'AGENC_GATEWAY_HELIUS_REQUESTS_PER_SECOND',
  'AGENC_GATEWAY_HELIUS_TOKEN_ALIASES',
  'AGENC_GATEWAY_MEME_ENABLED',
  'AGENC_GATEWAY_MEME_DAILY_LIMIT',
  'AGENC_GATEWAY_MEME_MODEL',
  'AGENC_GATEWAY_VOICE_ENABLED',
  'AGENC_GATEWAY_VOICE_DAILY_LIMIT',
  'AGENC_GATEWAY_VOICE_DEFAULT_VOICE',
  'AGENC_GATEWAY_VOICE_FEMALE_VOICE',
  'AGENC_GATEWAY_VOICE_LANGUAGE',
  'AGENC_GATEWAY_VOICE_MALE_VOICE',
  'AGENC_GATEWAY_X_SEARCH_ENABLED',
  'AGENC_GATEWAY_X_SEARCH_DAILY_LIMIT',
  'AGENC_GATEWAY_X_SEARCH_MAX_ATTEMPTS',
  'AGENC_GATEWAY_X_SEARCH_MAX_TURNS',
  'AGENC_GATEWAY_X_SEARCH_MODEL',
  'AGENC_GATEWAY_X_SEARCH_PER_PEER_LIMIT',
  'AGENC_GATEWAY_X_SEARCH_TIMEOUT_MS',
  'AGENC_TELEGRAM_ADMIN_PEER_IDS',
  'AGENC_TELEGRAM_BOT_USERNAME',
  'AGENC_TELEGRAM_DEBUG_UPDATES',
  'AGENC_TELEGRAM_GROUP_ADDRESSING',
  'AGENC_TELEGRAM_RICH_MESSAGES',
  'AGENC_DISCORD_GROUP_ADDRESSING',
  'AGENC_SLACK_GROUP_ADDRESSING',
  'AGENC_HEARTBEAT',
  'AGENC_HEARTBEAT_ACTIVE_HOURS',
  'AGENC_HEARTBEAT_AGENT',
  'AGENC_HEARTBEAT_INTERVAL',
  'AGENC_HEARTBEAT_MODEL',
  'AGENC_HEARTBEAT_TARGET',
  // alternate persistent-state and output paths
  'AGENC_MANAGED_SETTINGS_PATH',
  'AGENC_MANAGED_INSTRUCTIONS',
  'AGENC_MANAGED_AGENTS_DIR',
  'AGENC_REMOTE_MEMORY_DIR',
  'AGENC_COWORK_MEMORY_PATH_OVERRIDE',
  'AGENC_PLUGIN_CACHE_DIR',
  'AGENC_PLUGIN_SEED_DIR',
  'AGENC_BROWSER_PROFILE_DIR',
  'AGENC_PROJECT_DIR',
  'AGENC_JOB_DIR',
  'AGENC_MESSAGING_SOCKET',
  'AGENC_FILESYSTEM_HISTORY_ROOT',
  'AGENC_SESSION_LOG',
  'AGENC_COMMIT_LOG',
  'AGENC_JSONL_TRANSCRIPT',
  'AGENC_DIAGNOSTICS_FILE',
  'AGENC_DEBUG_LOGS_DIR',
  'AGENC_ENABLE_LEGACY_WINDOWS_PASSWORDVAULT',
  // proxy routing can redirect a nominal public request through an allowed
  // loopback endpoint, so default workers must not inherit it
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'FTP_PROXY',
  'ftp_proxy',
  'YARN_HTTP_PROXY',
  'yarn_http_proxy',
  'YARN_HTTPS_PROXY',
  'yarn_https_proxy',
  'NPM_CONFIG_PROXY',
  'npm_config_proxy',
  'NPM_CONFIG_HTTP_PROXY',
  'npm_config_http_proxy',
  'NPM_CONFIG_HTTPS_PROXY',
  'npm_config_https_proxy',
  'BUNDLE_HTTP_PROXY',
  'bundle_http_proxy',
  'BUNDLE_HTTPS_PROXY',
  'bundle_https_proxy',
  'PIP_PROXY',
  'pip_proxy',
  'DOCKER_HTTP_PROXY',
  'docker_http_proxy',
  'DOCKER_HTTPS_PROXY',
  'docker_https_proxy',
  // TLS/CA trust changes can make an otherwise-failing route succeed
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'AGENC_PROXY_RESOLVES_HOSTS',
])

/**
 * Explicit switches that turn otherwise-local test files into browser,
 * provider, chain, or design-snapshot live tests. Ambient shell values must
 * never opt the default suite into one of these paths. Explicit live/design
 * configs preserve only the inputs required by their operator surfaces.
 */
export const HERMETIC_DESIGN_INPUT_ENV_VARS = Object.freeze([
  'AGENC_TUI_CHROME_PATH',
  'AGENC_TUI_DESIGN_BROWSER',
  'AGENC_TUI_DESIGN_BROWSER_REPORT',
  'AGENC_TUI_DESIGN_DUMP_STATE',
  'AGENC_TUI_DESIGN_DUMP_LIVE',
  'AGENC_TUI_DESIGN_EXACT_CELLS',
  'AGENC_TUI_DESIGN_HTML',
])

export const HERMETIC_LIVE_TEST_OPT_IN_ENV_VARS = Object.freeze([
  'AGENC_BROWSER_E2E',
  'AGENC_RUN_PROVIDER_INTEGRATION_TESTS',
  'AGENC_RUN_LOCAL_PROVIDER_TESTS',
  'AGENC_TRANSACTION_GUARD_LIVE_E2E',
  ...HERMETIC_DESIGN_INPUT_ENV_VARS,
])

// Harness-owned paths are overwritten by the supported prelauncher. The
// synchronous preload captures that launch contract before worker setup,
// which strips the mutable process env and restores the captured values.
// Direct `vitest` invocation is not a provenance boundary; use npm test/the
// prelauncher for the hermetic contract.
export const HERMETIC_HARNESS_INPUT_ENV_VARS = Object.freeze([
  'AGENC_TEST_HERMETIC_RUN_ROOT',
  'AGENC_TEST_NETWORK_ATTEMPT_LEDGER',
])

/** OS launch inputs that cannot be synthesized portably. */
export const HERMETIC_LAUNCH_PASSTHROUGH_ENV_VARS = Object.freeze([
  'COMSPEC',
  'ComSpec',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'Path',
  'PROCESSOR_ARCHITECTURE',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
])

/** Explicit inputs used only by nested hermetic-contract regression tests. */
export const HERMETIC_LAUNCH_TEST_INPUT_ENV_VARS = Object.freeze([
  'AGENC_TEST_DESIGN_ENV_PROBE',
  'AGENC_TEST_NETWORK_ATTEMPT_CHILD_MODE',
])

/**
 * Create a short supervisor-owned root without trusting TEMP/TMP/TMPDIR.
 * Unix-domain socket paths are capped at 104 bytes on macOS and 108 bytes on
 * Linux, so nesting the harness beneath an arbitrary developer TMPDIR makes
 * otherwise-correct tests fail. Windows has no fixed `/tmp`; its system temp
 * directory is derived from the OS root rather than user temp overrides.
 */
export function createHermeticRunRoot(prefix, explicitBase) {
  let base
  if (explicitBase !== undefined) {
    if (typeof explicitBase !== 'string' || !isAbsolute(explicitBase) || explicitBase.includes('\0')) {
      throw new Error('Hermetic test run base must be an absolute path')
    }
    base = explicitBase
  } else if (process.platform === 'win32') {
    const systemRoot =
      process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.WINDIR
    if (typeof systemRoot !== 'string' || !isAbsolute(systemRoot)) {
      throw new Error('Hermetic test prelauncher requires an absolute Windows system root')
    }
    base = join(systemRoot, 'Temp')
  } else {
    base = '/tmp'
  }
  mkdirSync(base, { mode: 0o700, recursive: true })
  return mkdtempSync(join(base, prefix))
}

function applyHermeticGitEnv(env, stateRoot) {
  env.GIT_AUTHOR_EMAIL = 'agenc-hermetic-test@invalid'
  env.GIT_AUTHOR_NAME = 'AgenC Hermetic Test'
  env.GIT_COMMITTER_EMAIL = 'agenc-hermetic-test@invalid'
  env.GIT_COMMITTER_NAME = 'AgenC Hermetic Test'
  env.GIT_CONFIG_GLOBAL = join(stateRoot, 'gitconfig')
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GIT_PAGER = 'cat'
  env.GIT_TERMINAL_PROMPT = '0'
}

/**
 * Construct the supported prelaunch environment from an allowlist. Product,
 * provider, proxy, locale, terminal, loader, package-manager, and CI knobs are
 * intentionally absent unless forced below or explicitly preserved by a
 * reviewed design/test contract.
 */
export function createHermeticLaunchEnv(source, runRoot, options = {}) {
  const env = {}
  for (const name of HERMETIC_LAUNCH_PASSTHROUGH_ENV_VARS) {
    if (typeof source[name] === 'string') env[name] = source[name]
  }
  for (const name of HERMETIC_LAUNCH_TEST_INPUT_ENV_VARS) {
    if (typeof source[name] === 'string') env[name] = source[name]
  }
  for (const name of options.preserve ?? []) {
    if (typeof source[name] === 'string') env[name] = source[name]
  }

  const tempRoot = join(runRoot, 'tmp')
  mkdirSync(tempRoot, { mode: 0o700, recursive: true })
  env.FORCE_COLOR = '0'
  applyHermeticGitEnv(env, runRoot)
  env.LANG = 'C.UTF-8'
  env.LC_ALL = 'C.UTF-8'
  env.LOGNAME = 'agenc-test'
  env.NODE_ENV = 'test'
  env.NO_COLOR = '1'
  env.NPM_CONFIG_AUDIT = 'false'
  env.NPM_CONFIG_CACHE = join(runRoot, 'npm-cache')
  env.NPM_CONFIG_FUND = 'false'
  env.NPM_CONFIG_OFFLINE = 'true'
  env.NPM_CONFIG_UPDATE_NOTIFIER = 'false'
  env.PAGER = 'cat'
  env.SHELL = process.platform === 'win32'
    ? source.ComSpec ?? source.COMSPEC ?? 'cmd.exe'
    : '/bin/sh'
  env.TEMP = tempRoot
  env.TERM = 'dumb'
  env.TMP = tempRoot
  env.TMPDIR = tempRoot
  env.TZ = 'UTC'
  env.USER = 'agenc-test'
  env.USERNAME = 'agenc-test'
  env.npm_config_audit = 'false'
  env.npm_config_fund = 'false'
  env.npm_config_offline = 'true'
  env.npm_config_update_notifier = 'false'
  return env
}

export const HERMETIC_STRIPPED_ENV_VARS = Object.freeze([
  ...HERMETIC_PROVIDER_CREDENTIAL_ENV_VARS,
  ...HERMETIC_RUNTIME_AUTH_ENV_VARS,
  ...HERMETIC_AGENC_STATE_ENV_VARS,
  ...HERMETIC_LIVE_TEST_OPT_IN_ENV_VARS,
])

/** Marker proving the hermetic setup ran in this process. */
export const HERMETIC_MARKER_ENV_VAR = 'AGENC_TEST_HERMETIC_ENV'

/** Test-only managed-policy root, honored only by a marked Vitest worker. */
export const HERMETIC_MANAGED_SETTINGS_ENV_VAR =
  'AGENC_TEST_MANAGED_SETTINGS_PATH'

/** Mint once per worker; never reuse an environment-provided path. */
function lockedHermeticRuntimeMarker() {
  const markerDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    HERMETIC_RUNTIME_MARKER,
  )
  const marker = markerDescriptor?.value
  return (
    markerDescriptor?.configurable === false &&
    markerDescriptor.writable === false &&
    marker?.version === HERMETIC_RUNTIME_MARKER_VERSION &&
    Object.isFrozen(marker)
  ) ? marker : undefined
}

/** Mint once per worker; never reuse an environment-provided path. */
export function getOrCreateHermeticTestHome() {
  const existing = globalThis[HERMETIC_HOME_STATE]
  if (existing !== undefined) return existing.path

  const marker = lockedHermeticRuntimeMarker()
  const runRoot = typeof marker?.runRoot === 'string' ? marker.runRoot : tmpdir()
  const officialRun = typeof marker?.runRoot === 'string'
  const homePrefix = officialRun
    ? `h-${process.pid}-`
    : 'agenc-vitest-hermetic-home-'
  const tempPrefix = officialRun
    ? `t-${process.pid}-`
    : 'agenc-vitest-hermetic-temp-'
  const path = mkdtempSync(join(runRoot, homePrefix))
  const tempPath = mkdtempSync(join(runRoot, tempPrefix))
  const state = Object.freeze({ path, tempPath })
  Object.defineProperty(globalThis, HERMETIC_HOME_STATE, {
    configurable: false,
    enumerable: false,
    value: state,
    writable: false,
  })
  process.once('exit', () => {
    rmSync(path, { force: true, recursive: true })
    rmSync(tempPath, { force: true, recursive: true })
  })
  return path
}

/**
 * Sanitize `env` in place for hermetic test runs.
 *
 * - Deletes every var in HERMETIC_STRIPPED_ENV_VARS.
 * - Forces AGENC_HOME and AGENC_CONFIG_DIR to `agencHome` (a per-run temp
 *   dir), scopes native secure-storage service names to that unique config
 *   dir, and redirects OS/XDG home roots there. This isolates AgenC auth,
 *   native vaults, gcloud ADC, ProviderCode auth, plugins, user-level managed
 *   settings, platform managed policy, and generic homedir-derived state.
 *   Tests that need another home set it explicitly inside the test, after
 *   setup runs.
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
export function sanitizeHermeticEnv(env, agencHome, options = {}) {
  const marker = lockedHermeticRuntimeMarker()
  // Harness output, never an accepted outer-shell input. setupFiles writes the
  // process-minted value back only after sanitization.
  delete env.AGENC_TEST_HERMETIC_HOME
  const preserved = new Set(options.preserve ?? [])
  for (const name of HERMETIC_HARNESS_INPUT_ENV_VARS) delete env[name]
  for (const name of HERMETIC_STRIPPED_ENV_VARS) {
    if (!preserved.has(name)) delete env[name]
  }
  if (typeof marker?.runRoot === 'string') {
    env.AGENC_TEST_HERMETIC_RUN_ROOT = marker.runRoot
  }
  if (typeof marker?.attemptLedger === 'string') {
    env.AGENC_TEST_NETWORK_ATTEMPT_LEDGER = marker.attemptLedger
  }
  env.AGENC_HOME = agencHome
  env.AGENC_CONFIG_DIR = agencHome
  env.AGENC_MANAGED_HOME = join(agencHome, 'managed-home')
  env.AGENC_MANAGED_SETTINGS = join(agencHome, 'managed-settings.json')
  env[HERMETIC_MANAGED_SETTINGS_ENV_VAR] = join(
    agencHome,
    'managed-policy',
  )
  env.AGENC_AUTH_BACKEND = 'local'
  env.HOME = agencHome
  env.USERPROFILE = agencHome
  env.APPDATA = join(agencHome, 'appdata')
  env.LOCALAPPDATA = join(agencHome, 'local-appdata')
  env.XDG_CONFIG_HOME = join(agencHome, 'xdg-config')
  env.XDG_DATA_HOME = join(agencHome, 'xdg-data')
  env.XDG_STATE_HOME = join(agencHome, 'xdg-state')
  env.XDG_CACHE_HOME = join(agencHome, 'xdg-cache')
  // Keep Unix-domain socket paths below platform limits without sharing a
  // temp directory between parallel workers. The worker-minted path is bound
  // to the same locked runtime marker as `agencHome`; direct helper calls use
  // a home-local fallback instead.
  const homeState = globalThis[HERMETIC_HOME_STATE]
  const tempRoot =
    typeof marker?.runRoot === 'string' && homeState?.path === agencHome
      ? homeState.tempPath
      : join(agencHome, 'tmp')
  mkdirSync(tempRoot, { mode: 0o700, recursive: true })
  env.FORCE_COLOR = '0'
  applyHermeticGitEnv(env, agencHome)
  env.LANG = 'C.UTF-8'
  env.LC_ALL = 'C.UTF-8'
  env.LOGNAME = 'agenc-test'
  env.NODE_ENV = 'test'
  env.NO_COLOR = '1'
  env.NPM_CONFIG_AUDIT = 'false'
  env.NPM_CONFIG_CACHE = join(agencHome, 'npm-cache')
  env.NPM_CONFIG_FUND = 'false'
  env.NPM_CONFIG_OFFLINE = 'true'
  env.NPM_CONFIG_UPDATE_NOTIFIER = 'false'
  env.SHELL = process.platform === 'win32'
    ? env.ComSpec ?? env.COMSPEC ?? 'cmd.exe'
    : '/bin/sh'
  env.TEMP = tempRoot
  env.TERM = 'dumb'
  env.TMP = tempRoot
  env.TMPDIR = tempRoot
  env.TZ = 'UTC'
  env.USER = 'agenc-test'
  env.USERNAME = 'agenc-test'
  env.npm_config_audit = 'false'
  env.npm_config_fund = 'false'
  env.npm_config_offline = 'true'
  env.npm_config_update_notifier = 'false'
  env[HERMETIC_MARKER_ENV_VAR] = '1'
  return env
}
