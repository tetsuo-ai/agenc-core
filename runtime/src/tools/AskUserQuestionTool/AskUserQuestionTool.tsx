import type {
  AskUserQuestion,
  AskUserQuestionAnnotation,
  AskUserQuestionInput,
  AskUserQuestionOption,
} from '../ask-user-question/tool.js'

export { AskUserQuestionTool } from '../ask-user-question/tui-tool.js'

export type Question = AskUserQuestion
export type QuestionOption = AskUserQuestionOption
export type Output = AskUserQuestionInput & {
  readonly answers: Readonly<Record<string, string>>
}
export type { AskUserQuestionAnnotation }
