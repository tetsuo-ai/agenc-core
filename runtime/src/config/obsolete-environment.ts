/** Shared ingress guard without loading settings schemas or model registries. */
export const OBSOLETE_CONFIG_ENV_REPLACEMENTS = Object.freeze({
  AGENC_XAI_API_KEY: "XAI_API_KEY or GROK_API_KEY",
  AGENC_MCP_SERVERS: "mcp_servers in config.toml or agenc mcp add",
  AGENC_ENV_FILE:
    "Setup or SessionStart hooks that write to their injected AGENC_ENV_FILE",
  AGENC_SUBPROCESS_ENV_SCRUB:
    "no replacement; subprocess secret scrubbing is always enabled by default",
  OPENAI_MODEL: "AGENC_MODEL, --model, or model in config.toml",
  OPENAI_COMPATIBLE_MODEL: "AGENC_MODEL, --model, or model in config.toml",
  ANTHROPIC_MODEL: "AGENC_MODEL, --model, or model in config.toml",
  OLLAMA_MODEL: "AGENC_MODEL, --model, or model in config.toml",
  LMSTUDIO_MODEL: "AGENC_MODEL, --model, or model in config.toml",
  OPENROUTER_MODEL: "AGENC_MODEL, --model, or model in config.toml",
  GROQ_MODEL: "AGENC_MODEL, --model, or model in config.toml",
  DEEPSEEK_MODEL: "AGENC_MODEL, --model, or model in config.toml",
  GEMINI_MODEL: "AGENC_MODEL, --model, or model in config.toml",
  MISTRAL_MODEL: "AGENC_MODEL, --model, or model in config.toml",
  NVIDIA_MODEL: "AGENC_MODEL, --model, or model in config.toml",
  MINIMAX_MODEL: "AGENC_MODEL, --model, or model in config.toml",
  GITHUB_MODEL: "AGENC_MODEL, --model, or model in config.toml",
  AWS_BEDROCK_MODEL: "AGENC_MODEL, --model, or model in config.toml",
  ANTHROPIC_DEFAULT_HAIKU_MODEL:
    "AGENC_MODEL, --model, or model in config.toml",
  ANTHROPIC_DEFAULT_OPUS_MODEL:
    "AGENC_MODEL, --model, or model in config.toml",
  ANTHROPIC_DEFAULT_SONNET_MODEL:
    "AGENC_MODEL, --model, or model in config.toml",
  ANTHROPIC_SMALL_FAST_MODEL:
    "the session-owned canonical model selection",
  ANTHROPIC_CUSTOM_MODEL_OPTION:
    "a model catalog entry plus AGENC_MODEL, --model, or model in config.toml",
  AGENC_SUBAGENT_MODEL:
    "an agent definition, an explicit Agent tool model, or inherited session model",
  AGENC_AUTO_MODE_MODEL: "the session-owned canonical model selection",
  DISABLE_AUTO_COMPACT: "AGENC_DISABLE_AUTO_COMPACT",
  DISABLE_COMPACT: "AGENC_DISABLE_COMPACT",
  AGENC_DISABLE_STREAM_WATCHDOG: "AGENC_STREAM_IDLE_TIMEOUT_MS=0",
  AGENC_ENABLE_STREAM_WATCHDOG:
    "a positive AGENC_STREAM_IDLE_TIMEOUT_MS or stream_watchdog_timeout_ms in config.toml",
  AGENC_ALWAYS_ENABLE_EFFORT:
    "the canonical provider capability configuration",
  AGENC_HEARTBEAT_MODEL:
    "the model selected by the canonical gateway daemon session",
  AGENC_HEARTBEAT_AGENT:
    "the canonical heartbeat session",
  AGENC_GATEWAY_HOOKS_TOKEN: "AGENC_HOOKS_TOKEN",
  AGENC_SPECULATION_ENABLED: "speculationEnabled in config.toml",
  AGENC_DISABLE_GIT_INSTRUCTIONS: "includeGitInstructions in config.toml",
  AGENC_DISABLE_AUTO_MEMORY: "autoMemoryEnabled in config.toml",
  AGENC_DISABLE_FILE_CHECKPOINTING:
    "fileCheckpointingEnabled in config.toml",
  AGENC_ENABLE_SDK_FILE_CHECKPOINTING:
    "fileCheckpointingEnabled in config.toml",
  AGENC_USE_READABLE_STDIN: "AGENC_USE_DATA_STDIN=1",
  AGENC_USE_POWERSHELL_TOOL:
    "automatic Windows capability discovery plus defaultShell in config.toml",
} as const);

/** Reject removed environment authorities instead of silently ignoring them. */
export function assertNoObsoleteConfigEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const present = Object.entries(OBSOLETE_CONFIG_ENV_REPLACEMENTS).filter(
    ([name]) => env[name] !== undefined,
  );
  if (present.length === 0) return;
  const details = present
    .map(([name, replacement]) => `${name} (use ${replacement})`)
    .join(", ");
  throw new Error(
    `obsolete configuration environment variable${present.length === 1 ? "" : "s"} ` +
      `${details} ${present.length === 1 ? "is" : "are"} set; remove ` +
      `${present.length === 1 ? "it" : "them"}. Defined values such as \"0\" or \"false\" are still rejected.`,
  );
}
