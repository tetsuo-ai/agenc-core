import { SECRET_ENV_KEYS } from './providerSecrets.js'

// Environment names that are sensitive even when their spelling does not
// contain a generic credential marker. Keep this inventory in one module so
// every child-process surface applies the same deny set.
const CHILD_PROCESS_SECRET_ENV_BASE = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',
  'OPENAI_API_KEY',
  'OPENAI_AUTH_HEADER_VALUE',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'DEEPSEEK_API_KEY',
  'GEMINI_API_KEY',
  'GEMINI_ACCESS_TOKEN',
  'GOOGLE_API_KEY',
  'GOOGLE_GENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'XAI_API_KEY',
  'GROK_API_KEY',
  'AGENC_XAI_API_KEY',
  'AGENC_API_KEY',
  'AGENC_OAUTH_TOKEN',
  'AGENC_REMOTE_AUTH_TOKEN',
  'AGENC_SESSION_ACCESS_TOKEN',
  'MISTRAL_API_KEY',
  'MINIMAX_API_KEY',
  'NVIDIA_API_KEY',
  'BNKR_API_KEY',
  'MCP_CLIENT_SECRET',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AZURE_CLIENT_SECRET',
  'AZURE_CLIENT_CERTIFICATE_PATH',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_RUNTIME_TOKEN',
  'ACTIONS_RUNTIME_URL',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'ALL_INPUTS',
  'OVERRIDE_GITHUB_TOKEN',
  'DEFAULT_WORKFLOW_TOKEN',
  'SSH_SIGNING_KEY',
  'AWS_ACCESS_KEY_ID',
  'AZURE_OPENAI_API_KEY',
  'HF_TOKEN',
  'HUGGINGFACE_TOKEN',
  'AGENC_DAEMON_COOKIE',
  'AGENC_GATEWAY_HOOKS_TOKEN',
  'AGENC_TELEGRAM_BOT_TOKEN',
  'AGENC_DISCORD_BOT_TOKEN',
  'AGENC_SLACK_BOT_TOKEN',
  'AGENC_SLACK_APP_TOKEN',
] as const

export const SUBPROCESS_SECRET_ENV: readonly string[] = [
  ...new Set<string>([...CHILD_PROCESS_SECRET_ENV_BASE, ...SECRET_ENV_KEYS]),
]

const SUBPROCESS_SECRET_ENV_SET = new Set(
  SUBPROCESS_SECRET_ENV.map(key => key.toUpperCase()),
)

const CREDENTIAL_KEY_PATTERN =
  /(?:^|_)(API[_-]?KEY|ACCESS[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY|AUTH|CREDENTIAL|BEARER|COOKIE)(?:[_-]|$)/i

const HARMLESS_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'TERM',
  'SHELL',
  'PWD',
  'TMPDIR',
  'TMP',
  'TEMP',
  'COLORTERM',
  'DISPLAY',
])

export function isSecretEnvKey(key: string): boolean {
  const upper = key.toUpperCase()
  if (SUBPROCESS_SECRET_ENV_SET.has(upper)) return true
  if (upper.startsWith('INPUT_')) {
    return isSecretEnvKey(upper.slice('INPUT_'.length))
  }
  if (
    HARMLESS_ENV_KEYS.has(upper) ||
    upper.startsWith('XDG_') ||
    upper.startsWith('LC_')
  ) {
    return false
  }
  return CREDENTIAL_KEY_PATTERN.test(upper)
}
