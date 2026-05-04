export const BRIEF_TOOL_NAME = 'SendUserMessage'
export const LEGACY_BRIEF_TOOL_NAME = 'Brief'

export const DESCRIPTION = 'Send a message to the user'

export const BRIEF_TOOL_PROMPT =
  'Send a concise message that the user will read. Use markdown when it helps.'

export const BRIEF_PROACTIVE_SECTION = `## Talking to the user

${BRIEF_TOOL_NAME} is where replies the user should actually read go. Keep messages tight, direct, and useful. For longer work, acknowledge once, send meaningful checkpoints when the state changes, then send the result.`
