// Critical system constants extracted to break circular dependencies

const DEFAULT_PREFIX =
  `You are AgenC, an open-source coding agent and CLI.`
const AGENT_SDK_AGENC_PRESET_PREFIX =
  `You are AgenC, an open-source coding agent and CLI running within the AgenC Agent SDK.`
const AGENT_SDK_PREFIX =
  `You are AgenC, built on the AgenC Agent SDK.`

const CLI_SYSPROMPT_PREFIX_VALUES = [
  DEFAULT_PREFIX,
  AGENT_SDK_AGENC_PRESET_PREFIX,
  AGENT_SDK_PREFIX,
] as const

export type CLISyspromptPrefix = (typeof CLI_SYSPROMPT_PREFIX_VALUES)[number]

/**
 * All possible CLI system-prompt prefix values.
 */
export const CLI_SYSPROMPT_PREFIXES: ReadonlySet<string> = new Set(
  CLI_SYSPROMPT_PREFIX_VALUES,
)

export function getCLISyspromptPrefix(options?: {
  isNonInteractive: boolean
  hasAppendSystemPrompt: boolean
}): CLISyspromptPrefix {
  if (options?.isNonInteractive) {
    if (options.hasAppendSystemPrompt) {
      return AGENT_SDK_AGENC_PRESET_PREFIX
    }
    return AGENT_SDK_PREFIX
  }
  return DEFAULT_PREFIX
}
