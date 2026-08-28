import type { ExtensionDialog, ToolRun } from './state.ts'

export const ASK_USER_QUESTION_TOOL = 'ask_user_question'

export interface AskUserOption {
  label: string
  description: string
  preview?: string
}

export interface AskUserQuestion {
  question: string
  header: string
  multiSelect: boolean
  options: AskUserOption[]
}

export interface AskUserQuestionnaire {
  toolCallId: string
  questions: AskUserQuestion[]
}

export type AskUserSubmissionAnswer =
  | { kind: 'option'; optionIndex: number }
  | { kind: 'multi'; optionIndices: number[] }
  | { kind: 'custom'; value: string }

export interface AskUserDialogAction {
  method: 'select' | 'input'
  questionIndex: number
  question: string
  optionIndex?: number
  value?: string
}

export function questionnaireFromTool(tool: ToolRun): AskUserQuestionnaire | undefined {
  if (tool.name !== ASK_USER_QUESTION_TOOL || tool.status === 'complete') return undefined
  const args = record(tool.args)
  if (!Array.isArray(args.questions) || args.questions.length === 0) return undefined
  const questions: AskUserQuestion[] = []
  for (const value of args.questions) {
    const question = record(value)
    if (typeof question.question !== 'string' || typeof question.header !== 'string' || !Array.isArray(question.options)) return undefined
    const options: AskUserOption[] = []
    for (const candidate of question.options) {
      const option = record(candidate)
      if (typeof option.label !== 'string' || typeof option.description !== 'string') return undefined
      options.push({
        label: option.label,
        description: option.description,
        ...(typeof option.preview === 'string' && option.preview.length > 0 ? { preview: option.preview } : {}),
      })
    }
    if (options.length === 0) return undefined
    questions.push({
      question: question.question,
      header: question.header,
      multiSelect: question.multiSelect === true,
      options,
    })
  }
  return { toolCallId: tool.id, questions }
}

export function questionnaireMatchesDialog(questionnaire: AskUserQuestionnaire, dialog: ExtensionDialog | undefined): boolean {
  if (!dialog) return false
  const first = questionnaire.questions[0]
  if (!first || !dialog.title.includes(first.question)) return false
  return first.multiSelect ? dialog.method === 'input' : dialog.method === 'select'
}

export function buildAskUserDialogActions(
  questionnaire: AskUserQuestionnaire,
  answers: readonly AskUserSubmissionAnswer[],
): AskUserDialogAction[] {
  if (answers.length !== questionnaire.questions.length) throw new Error('Answer every question before submitting')
  const actions: AskUserDialogAction[] = []
  questionnaire.questions.forEach((question, questionIndex) => {
    const answer = answers[questionIndex]
    if (!answer) throw new Error(`Question ${questionIndex + 1} is unanswered`)
    if (question.multiSelect) {
      if (answer.kind === 'custom') {
        actions.push({ method: 'input', questionIndex, question: question.question, value: answer.value })
        return
      }
      if (answer.kind !== 'multi') throw new Error(`Question ${questionIndex + 1} allows multiple choices`)
      const unique = [...new Set(answer.optionIndices)].sort((left, right) => left - right)
      if (unique.some((index) => index < 0 || index >= question.options.length)) throw new Error(`Question ${questionIndex + 1} contains an invalid choice`)
      actions.push({
        method: 'input',
        questionIndex,
        question: question.question,
        value: unique.map((index) => String(index + 1)).join(','),
      })
      return
    }
    if (answer.kind === 'option') {
      if (answer.optionIndex < 0 || answer.optionIndex >= question.options.length) throw new Error(`Question ${questionIndex + 1} contains an invalid choice`)
      actions.push({ method: 'select', questionIndex, question: question.question, optionIndex: answer.optionIndex })
      return
    }
    if (answer.kind !== 'custom') throw new Error(`Question ${questionIndex + 1} requires one choice`)
    actions.push({ method: 'select', questionIndex, question: question.question, optionIndex: question.options.length })
    actions.push({ method: 'input', questionIndex, question: question.question, value: answer.value })
  })
  return actions
}

export function dialogMatchesAskUserAction(dialog: ExtensionDialog, action: AskUserDialogAction): boolean {
  return dialog.method === action.method && dialog.title.includes(action.question)
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
