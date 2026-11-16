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
import {
  askUserQuestionDisplayFromModelText,
  buildAskUserQuestionDisplay,
  formatAskUserQuestionDisplay,
  parseAskUserQuestionDisplay,
  QUESTIONS_ANSWERED_TEXT,
  resolveAskUserQuestionDisplay,
  type AskUserQuestionDisplay,
} from './display.js'

export type Question = AskUserQuestion
export type QuestionOption = AskUserQuestionOption

/**
 * What the result row needs. Rows come in several shapes: the daemon
 * transcript passes the display built from the tool's result metadata, the
 * in-process path passes `{questions, answers, annotations}` or the runtime
 * result `{content, metadata}`, and sessions recorded by older builds pass
 * the model-facing result string. All normalize to one display here, so the
 * renderer never falls back to printing the text written for the model.
 */
export type Output = AskUserQuestionDisplay

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeAskUserQuestionOutput(input: unknown): Output | null {
  if (typeof input === 'string') {
    return askUserQuestionDisplayFromModelText(input)
  }
  if (!isRecord(input)) return null
  const direct = parseAskUserQuestionDisplay(input)
  if (direct !== null) return direct
  if (isRecord(input.metadata) || typeof input.content === 'string') {
    const resolved = resolveAskUserQuestionDisplay({
      result: input.content,
      metadata: input.metadata,
    })
    if (resolved !== null) return resolved
  }
  if (input.skipped === true) return { outcome: 'skipped', entries: [] }
  if (
    input.planInterviewAction === 'chat_about_this' ||
    input.planInterviewAction === 'skip_plan_interview'
  ) {
    return { outcome: input.planInterviewAction, entries: [] }
  }
  if (isRecord(input.answers)) {
    return buildAskUserQuestionDisplay({
      outcome: 'answered',
      questions: input.questions,
      answers: input.answers,
      annotations: isRecord(input.annotations) ? input.annotations : undefined,
    })
  }
  return null
}

// Validation only: the row value passes through unchanged (the in-process
// call output still feeds mapToolResultToToolResultBlockParam), and
// renderToolResultMessage normalizes whatever shape it receives.
function parseOutput(input: unknown):
  | { success: true; data: unknown }
  | { success: false; error: Error } {
  return normalizeAskUserQuestionOutput(input) === null
    ? { success: false, error: new Error('not an AskUserQuestion result') }
    : { success: true, data: input }
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

type CallOutput = {
  questions: readonly Question[]
  answers: Readonly<Record<string, string>>
  annotations?: Readonly<Record<string, AskUserQuestionAnnotation>>
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
  renderToolResultMessage(output: unknown) {
    const display = normalizeAskUserQuestionOutput(output)
    if (display === null || display.outcome !== 'answered' || display.entries.length === 0) {
      return (
        <Text dimColor>
          {display === null ? QUESTIONS_ANSWERED_TEXT : formatAskUserQuestionDisplay(display)}
        </Text>
      )
    }
    return (
      <Box flexDirection="column">
        {display.entries.map((entry, index) => (
          <Box key={index} flexDirection="column">
            <Text>
              <Text dimColor>{entry.question}</Text>
              {'  '}
              <Text bold>{entry.answer}</Text>
            </Text>
            {entry.note !== undefined ? <Text dimColor>{`  Note: ${entry.note}`}</Text> : null}
          </Box>
        ))}
      </Box>
    )
  },
  renderToolUseRejectedMessage() {
    return <Text dimColor>Questions declined</Text>
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
  mapToolResultToToolResultBlockParam(output: CallOutput, toolUseID: string) {
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
