/**
 * SEC-01: prevent LIVE shell children from inheriting provider API keys and
 * other secrets from the host/daemon process environment.
 *
 * Strategy: start from full env (tools need PATH/locale/terminal vars) and
 * drop keys that look like credentials. Explicit per-call env maps are scrubbed
 * the same way so a leaked key cannot be reintroduced via options.env.
 */

const SECRET_ENV_KEY =
  /(?:^|_)(API[_-]?KEY|ACCESS[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY|AUTH|CREDENTIAL|BEARER|COOKIE)(?:[_-]|$)/i;

/** Exact keys that are secrets even without a matching pattern. */
const SECRET_ENV_EXACT = new Set(
  [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "XAI_API_KEY",
    "GROK_API_KEY",
    "AGENC_XAI_API_KEY",
    "OPENROUTER_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GROQ_API_KEY",
    "DEEPSEEK_API_KEY",
    "MISTRAL_API_KEY",
    "NVIDIA_API_KEY",
    "MINIMAX_API_KEY",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SESSION_TOKEN",
    "AZURE_OPENAI_API_KEY",
    "HF_TOKEN",
    "HUGGINGFACE_TOKEN",
    "AGENC_DAEMON_COOKIE",
    "AGENC_GATEWAY_HOOKS_TOKEN",
    "AGENC_TELEGRAM_BOT_TOKEN",
    "AGENC_DISCORD_BOT_TOKEN",
    "AGENC_SLACK_BOT_TOKEN",
    "AGENC_SLACK_APP_TOKEN",
  ].map((k) => k.toUpperCase()),
);

export function isSecretEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (SECRET_ENV_EXACT.has(upper)) return true;
  // Keep harmless locale/UI keys that happen to match loosely.
  if (
    upper === "PATH" ||
    upper === "HOME" ||
    upper === "USER" ||
    upper === "LANG" ||
    upper === "LC_ALL" ||
    upper === "TERM" ||
    upper === "SHELL" ||
    upper === "PWD" ||
    upper === "TMPDIR" ||
    upper === "TMP" ||
    upper === "TEMP" ||
    upper === "COLORTERM" ||
    upper === "DISPLAY" ||
    upper.startsWith("XDG_") ||
    upper.startsWith("LC_")
  ) {
    return false;
  }
  return SECRET_ENV_KEY.test(key);
}

/**
 * Copy env entries, dropping secret keys. Undefined values are skipped.
 */
export function scrubEnvForChildProcess(
  source: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (source === undefined) return out;
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isSecretEnvKey(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Build spawn env for unified-exec: scrubbed process.env + scrubbed overrides.
 */
export function buildScrubbedSpawnEnv(
  overrides?: Record<string, string> | undefined,
): Record<string, string> {
  return {
    ...scrubEnvForChildProcess(process.env),
    ...scrubEnvForChildProcess(overrides),
  };
}
