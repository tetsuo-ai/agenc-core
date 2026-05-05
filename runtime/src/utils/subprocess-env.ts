/**
 * Ports the donor subprocess environment scrubber onto AgenC-owned env names.
 *
 * LSP servers are repo-configured child processes. They inherit enough process
 * state to resolve PATH/HOME/proxy settings, but not in-process provider keys,
 * OAuth tokens, or CI credential material. Callers can still opt in explicit
 * child env by overlaying their own config after this helper.
 */

const SUBPROCESS_SECRET_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_CUSTOM_HEADERS",
  "OPENAI_API_KEY",
  "XAI_API_KEY",
  "GROK_API_KEY",
  "AGENC_XAI_API_KEY",
  "AGENC_OAUTH_TOKEN",
  "AGENC_REMOTE_AUTH_TOKEN",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "AZURE_CLIENT_SECRET",
  "AZURE_CLIENT_CERTIFICATE_PATH",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_RUNTIME_URL",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "ALL_INPUTS",
  "OVERRIDE_GITHUB_TOKEN",
  "DEFAULT_WORKFLOW_TOKEN",
  "SSH_SIGNING_KEY",
] as const;

export function subprocessEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  for (const key of SUBPROCESS_SECRET_ENV) {
    delete env[key];
    delete env[`INPUT_${key}`];
  }
  return env;
}
