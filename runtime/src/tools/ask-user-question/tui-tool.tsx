import { Box, Text } from '../../tui/ink.js'
import {
  getAllowedChannels,
  getQuestionPreviewFormat,
} from '../../bootstrap/state.js'
import {
  ASK_USER_QUESTION_TOOL_NAME,
  parseAskUserQuestionInput,
  type AskUserQuestion,
  type AskUserQuestionAnnotation,
  type AskUserQuestionOption,
} from './tool.js'

export type Question = AskUserQuestion
export type QuestionOption = AskUserQuestionOption

export type Output = {
  questions: readonly Question[]
  answers: Readonly<Record<string, string>>
  annotations?: Readonly<Record<string, AskUserQuestionAnnotation>>
}

const inputSchema = {
  safeParse(input: unknown):
    | { success: true; data: { questions: readonly Question[]; metadata?: Readonly<Record<string, unknown>> } }
    | { success: false; error: Error } {
    const parsed = parseAskUserQuestionInput(input)
    if (!parsed.ok) {
      return { success: false, error: new Error(parsed.error) }
    }
    return { success: true, data: parsed.input }
  },
}

function parseOutput(input: unknown):
  | { success: true; data: Output }
  | { success: false; error: Error } {
  const parsed = parseAskUserQuestionInput(input)
  if (!parsed.ok) {
    return { success: false, error: new Error(parsed.error) }
  }
  const answers = parsed.input.answers
  if (answers === undefined) {
    return { success: false, error: new Error('answers are required') }
  }
  return {
    success: true,
    data: {
      questions: parsed.input.questions,
      answers,
      ...(parsed.input.annotations !== undefined
        ? { annotations: parsed.input.annotations }
        : {}),
    },
  }
}

function formatAnswers(
  answers: Readonly<Record<string, string>>,
  annotations?: Readonly<Record<string, AskUserQuestionAnnotation>>,
): string {
  return Object.entries(answers)
    .map(([question, answer]) => {
      const annotation = annotations?.[question]
      const parts = [`"${question}"="${answer}"`]
      if (annotation?.preview) {
        parts.push(`selected preview:\n${annotation.preview}`)
      }
      if (annotation?.notes) {
        parts.push(`user notes: ${annotation.notes}`)
      }
      return parts.join(' ')
    })
    .join('\n')
}

export const AskUserQuestionTool = {
  name: ASK_USER_QUESTION_TOOL_NAME,
  aliases: [],
  maxResultSizeChars: 100_000,
  inputSchema,
  outputSchema: {
    safeParse: parseOutput,
  },
  async description() {
    return 'Ask the user multiple-choice questions.'
  },
  async prompt() {
    return 'Ask the user 1-4 multiple-choice questions when you need clarification.'
  },
  userFacingName() {
    return ''
  },
  isEnabled() {
    return getAllowedChannels().length === 0
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  requiresUserInteraction() {
    return true
  },
  async validateInput(input: { questions: readonly Question[] }) {
    if (getQuestionPreviewFormat() !== 'html') {
      return { result: true as const }
    }
    for (const question of input.questions) {
      for (const option of question.options) {
        const error = validateHtmlPreview(option.preview)
        if (error) {
          return {
            result: false as const,
            message: `Option "${option.label}" in question "${question.question}": ${error}`,
            errorCode: 1,
          }
        }
      }
    }
    return { result: true as const }
  },
  toAutoClassifierInput(input: { questions?: readonly Question[] }) {
    return input.questions?.map(q => q.question).join(' | ') ?? ''
  },
  async checkPermissions(input: unknown) {
    return {
      behavior: 'ask' as const,
      message: 'Answer questions?',
      updatedInput: input,
    }
  },
  renderToolUseMessage() {
    return null
  },
  renderToolUseProgressMessage() {
    return null
  },
  renderToolResultMessage(output: Output) {
    return (
      <Box flexDirection="column">
        <Text>User answered AgenC's questions:</Text>
        <Text>{formatAnswers(output.answers, output.annotations)}</Text>
      </Box>
    )
  },
  renderToolUseRejectedMessage() {
    return <Text>User declined to answer questions</Text>
  },
  renderToolUseErrorMessage() {
    return null
  },
  async call(input: { questions: readonly Question[]; answers?: Record<string, string>; annotations?: Record<string, AskUserQuestionAnnotation> }) {
    return {
      data: {
        questions: input.questions,
        answers: input.answers ?? {},
        ...(input.annotations ? { annotations: input.annotations } : {}),
      },
    }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: `User has answered your questions: ${formatAnswers(output.answers, output.annotations)}. You can now continue with the user's answers in mind.`,
    }
  },
}

function validateHtmlPreview(preview: string | undefined): string | null {
  if (preview === undefined) return null
  if (/<\s*(html|body|!doctype)\b/i.test(preview)) {
    return 'preview must be an HTML fragment, not a full document (no <html>, <body>, or <!DOCTYPE>)'
  }
  if (/<\s*(script|style)\b/i.test(preview)) {
    return 'preview must not contain <script> or <style> tags. Use inline styles via the style attribute if needed.'
  }
  if (!/<[a-z][^>]*>/i.test(preview)) {
    return 'preview must contain HTML (previewFormat is set to "html"). Wrap content in a tag like <div> or <pre>.'
  }
  return null
}
