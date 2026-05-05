import { ASK_USER_QUESTION_TOOL_NAME as LIVE_ASK_USER_QUESTION_TOOL_NAME } from '../ask-user-question/tool.js'

export const ASK_USER_QUESTION_TOOL_NAME = LIVE_ASK_USER_QUESTION_TOOL_NAME

export const ASK_USER_QUESTION_TOOL_CHIP_WIDTH = 12

export const DESCRIPTION =
  'Asks the user multiple choice questions to gather information, clarify ambiguity, understand preferences, make decisions or offer them choices.'

export const PREVIEW_FEATURE_PROMPT = {
  markdown: `
Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare. Preview content is rendered as markdown in a monospace box. Do not use previews for simple preference questions where labels and descriptions suffice.
`,
  html: `
Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare. Preview content must be a self-contained HTML fragment with no scripts or styles. Do not use previews for simple preference questions where labels and descriptions suffice.
`,
} as const

export const ASK_USER_QUESTION_TOOL_PROMPT = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices
4. Offer choices to the user about what direction to take.

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label
`
