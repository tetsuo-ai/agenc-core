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

function formatAnswers(answers: Readonly<Record<string, string>>): string {
  return Object.entries(answers)
    .map(([question, answer]) => `${question}: ${answer}`)
    .join('\n')
}

export const AskUserQuestionTool = {
  name: ASK_USER_QUESTION_TOOL_NAME,
  aliases: [],
  maxResultSizeChars: 100_000,
  inputSchema,
  outputSchema: {
    safeParse(input: unknown) {
      return { success: true as const, data: input }
    },
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
    return true
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
  renderToolResultMessage(_output: Output) {
    return null
  },
  renderToolUseRejectedMessage() {
    return null
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
      content: `User has answered your questions: ${formatAnswers(output.answers)}.`,
    }
  },
}
