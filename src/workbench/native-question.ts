import type { AskUserQuestionnaire, AskUserSubmissionAnswer } from './ask-user.ts'
import { questionnaireFromTool, questionnaireMatchesDialog } from './ask-user.ts'

interface ToolLike {
  id: string
  name: string
  args?: unknown
  details?: unknown
  status: string
}

interface DialogLike {
  id: string
  method: string
  title: string
  message?: string
  nativeQuestion?: NativeQuestion
}

export const NATIVE_QUESTION_CONTRACT = 'heddlework.question.v1'
export const NATIVE_QUESTION_ANSWER_CONTRACT = 'heddlework.question.v1.answer'
export const DONT_KNOW_LABEL = "I don't know"
export const DONT_KNOW_VALUE = '__dont_know__'

export type NativeQuestionKind = 'single-select' | 'multi-select' | 'text' | 'confirm' | 'editor' | 'unsupported'
export type NativeQuestionResponseShape = 'rpc-dialog' | 'custom-quiz' | 'custom-ask' | 'custom-generic'

export interface NativeQuestionOption {
  value: string
  label: string
  description?: string
  preview?: string
}

export interface NativeQuestion {
  contract: typeof NATIVE_QUESTION_CONTRACT
  requestId: string
  toolCallId?: string
  toolName?: string
  kind: NativeQuestionKind
  stem: string
  description?: string
  header?: string
  options: NativeQuestionOption[]
  allowCustom: boolean
  allowUnknown: boolean
  allowNote: boolean
  required: boolean
  multiSelect: boolean
  responseShape: NativeQuestionResponseShape
  unsupportedReason?: string
}

export interface NativeQuestionAnswer {
  contract: typeof NATIVE_QUESTION_ANSWER_CONTRACT
  requestId: string
  cancelled?: boolean
  selectedValues?: string[]
  selectedIndices?: number[]
  custom?: string
  unknown?: boolean
  note?: string
  text?: string
  confirmed?: boolean
}

export type NativeQuestionSurface =
  | { kind: 'tabbed'; questionnaire: AskUserQuestionnaire }
  | { kind: 'question'; question: NativeQuestion }
  | { kind: 'unsupported'; question: NativeQuestion }

export function nativeQuestionFromTool(tool: ToolLike): NativeQuestion | undefined {
  if (tool.status === 'complete') return undefined
  const args = record(tool.args)
  if (Array.isArray(args.questions)) return undefined
  const stem = typeof args.question === 'string' ? args.question.trim() : ''
  if (!stem) return undefined
  const graded = hasOwn(args, 'correctAnswer') || hasOwn(args, 'explanation')
  const description = typeof args.details === 'string' && args.details.trim() ? args.details.trim() : undefined
  const options = displayOptions(args, tool.details)
  const multiSelect = args.multiSelect === true
  const allowText = options.length === 0
  const kind: NativeQuestionKind = allowText ? 'text' : multiSelect ? 'multi-select' : 'single-select'
  return {
    contract: NATIVE_QUESTION_CONTRACT,
    requestId: tool.id,
    toolCallId: tool.id,
    toolName: tool.name,
    kind,
    stem,
    ...(description ? { description } : {}),
    options,
    allowCustom: !graded && !allowText,
    allowUnknown: graded,
    allowNote: graded,
    required: !allowText,
    multiSelect,
    responseShape: graded ? 'custom-quiz' : allowText ? 'rpc-dialog' : 'custom-ask',
  }
}

export function nativeQuestionFromDialog(dialog: DialogLike): NativeQuestion | undefined {
  if (dialog.nativeQuestion) return dialog.nativeQuestion
  if (dialog.method === 'unsupported') {
    return {
      contract: NATIVE_QUESTION_CONTRACT,
      requestId: dialog.id,
      kind: 'unsupported',
      stem: dialog.title,
      ...(dialog.message ? { description: dialog.message } : {}),
      options: [],
      allowCustom: false,
      allowUnknown: false,
      allowNote: false,
      required: false,
      multiSelect: false,
      responseShape: 'custom-generic',
      unsupportedReason: dialog.message ?? 'This extension is using a custom terminal UI that cannot be converted automatically.',
    }
  }
  return undefined
}

export function questionIdentityMatch(question: NativeQuestion, id: string | undefined): boolean {
  if (!id) return false
  return question.requestId === id || question.toolCallId === id
}

export function activeQuestionSurface(state: {
  liveTools: readonly ToolLike[]
  dialog: DialogLike | undefined
  questionnaireSubmitting?: string | undefined
  questionnaireCollapsed?: string | undefined
}): NativeQuestionSurface | undefined {
  const tabbed = state.liveTools.flatMap((tool) => {
    const parsed = questionnaireFromTool(tool)
    return parsed ? [parsed] : []
  }).find((candidate) => (
    candidate.toolCallId === state.questionnaireSubmitting
    || candidate.toolCallId === state.questionnaireCollapsed
    || questionnaireMatchesDialog(candidate, state.dialog)
  ))
  if (tabbed) return { kind: 'tabbed', questionnaire: tabbed }

  const running = state.liveTools.flatMap((tool) => {
    const parsed = nativeQuestionFromTool(tool)
    return parsed ? [parsed] : []
  })
  const focused = running.find((question) => (
    questionIdentityMatch(question, state.questionnaireSubmitting)
    || questionIdentityMatch(question, state.questionnaireCollapsed)
  ))
  if (focused) return { kind: 'question', question: focused }

  const fromDialog = state.dialog ? nativeQuestionFromDialog(state.dialog) : undefined
  if (fromDialog && fromDialog.kind !== 'unsupported') return { kind: 'question', question: fromDialog }

  if (state.dialog) {
    const matching = running.find((question) => dialogAgreesWithQuestion(state.dialog!, question))
    if (matching) return { kind: 'question', question: matching }
  }
  const only = running.length === 1 ? running[0] : undefined
  if (only) return { kind: 'question', question: only }
  if (fromDialog?.kind === 'unsupported') return { kind: 'unsupported', question: fromDialog }
  return undefined
}

export function dialogAgreesWithQuestion(dialog: DialogLike, question: NativeQuestion): boolean {
  if (dialog.nativeQuestion && questionIdentityMatch(dialog.nativeQuestion, question.requestId)) return true
  if (dialog.nativeQuestion && question.toolCallId && questionIdentityMatch(dialog.nativeQuestion, question.toolCallId)) return true
  if (dialog.id === question.requestId || (question.toolCallId !== undefined && dialog.id === question.toolCallId)) return true
  return dialog.title.includes(question.stem)
}

export function encodeNativeQuestionAnswer(
  question: NativeQuestion,
  answers: readonly AskUserSubmissionAnswer[],
  note?: string,
): NativeQuestionAnswer {
  const answer = answers[0]
  const trimmedNote = note?.trim() ? note.trim() : undefined
  if (!answer) {
    return { contract: NATIVE_QUESTION_ANSWER_CONTRACT, requestId: question.requestId, cancelled: true }
  }
  if (answer.kind === 'unknown') {
    return { contract: NATIVE_QUESTION_ANSWER_CONTRACT, requestId: question.requestId, unknown: true, ...(trimmedNote ? { note: trimmedNote } : {}) }
  }
  if (answer.kind === 'text' || (answer.kind === 'custom' && question.kind === 'text')) {
    const text = answer.kind === 'text' ? answer.value : answer.value
    return { contract: NATIVE_QUESTION_ANSWER_CONTRACT, requestId: question.requestId, text, ...(trimmedNote ? { note: trimmedNote } : {}) }
  }
  if (answer.kind === 'custom') {
    return {
      contract: NATIVE_QUESTION_ANSWER_CONTRACT,
      requestId: question.requestId,
      custom: answer.value,
      ...(trimmedNote ? { note: trimmedNote } : {}),
    }
  }
  if (answer.kind === 'multi') {
    const unique = [...new Set(answer.optionIndices)].sort((left, right) => left - right)
    return {
      contract: NATIVE_QUESTION_ANSWER_CONTRACT,
      requestId: question.requestId,
      selectedIndices: unique.map((index) => index + 1),
      selectedValues: unique.flatMap((index) => {
        const option = question.options[index]
        return option ? [option.value] : []
      }),
      ...(trimmedNote ? { note: trimmedNote } : {}),
    }
  }
  const option = question.options[answer.optionIndex]
  return {
    contract: NATIVE_QUESTION_ANSWER_CONTRACT,
    requestId: question.requestId,
    selectedIndices: [answer.optionIndex + 1],
    selectedValues: option ? [option.value] : [],
    ...(trimmedNote ? { note: trimmedNote } : {}),
  }
}

export function customUiResultFromAnswer(question: NativeQuestion, answer: NativeQuestionAnswer): unknown {
  if (answer.cancelled) return question.responseShape === 'custom-quiz' ? null : null
  const note = answer.note?.trim() ? answer.note.trim() : undefined
  if (question.responseShape === 'custom-quiz') {
    if (answer.unknown) return { dontKnow: true, ...(note ? { note } : {}), answers: [] }
    const answers = (answer.selectedIndices ?? []).flatMap((index, position) => {
      const option = question.options[index - 1]
      if (!option) return []
      return [{ label: option.label, value: answer.selectedValues?.[position] ?? option.value, index }]
    })
    return { dontKnow: false, ...(note ? { note } : {}), answers }
  }
  if (question.kind === 'text') {
    const text = (answer.text ?? answer.custom ?? '').trim()
    return { type: 'text', label: text, value: text }
  }
  if (answer.custom) {
    const custom = { type: 'other' as const, label: answer.custom, value: answer.custom }
    return question.multiSelect ? [custom] : custom
  }
  const selected = (answer.selectedIndices ?? []).flatMap((index, position) => {
    const option = question.options[index - 1]
    if (!option) return []
    return [{
      type: 'option' as const,
      label: option.label,
      value: answer.selectedValues?.[position] ?? option.value,
      index,
    }]
  })
  return question.multiSelect ? selected : selected[0] ?? null
}

export function buildNativeQuestionDialogActions(
  question: NativeQuestion,
  answers: readonly AskUserSubmissionAnswer[],
  note?: string,
): Array<{ method: 'select' | 'input' | 'editor'; value?: string; optionIndex?: number }> {
  const answer = answers[0]
  if (!answer) throw new Error('Answer the question before submitting')
  if (question.kind === 'text') {
    const value = answer.kind === 'text' || answer.kind === 'custom' ? answer.value : ''
    return [{ method: 'editor', value }]
  }
  if (question.multiSelect) {
    if (answer.kind === 'unknown') {
      const actions: Array<{ method: 'select' | 'input' | 'editor'; value?: string }> = [{ method: 'input', value: '0' }]
      if (question.allowNote) actions.push({ method: 'input', value: note ?? '' })
      return actions
    }
    if (answer.kind === 'custom') {
      const actions: Array<{ method: 'select' | 'input' | 'editor'; value?: string }> = [{ method: 'input', value: answer.value }]
      if (question.allowNote) actions.push({ method: 'input', value: note ?? '' })
      return actions
    }
    if (answer.kind !== 'multi') throw new Error('This question allows multiple choices')
    const unique = [...new Set(answer.optionIndices)].sort((left, right) => left - right)
    if (unique.some((index) => index < 0 || index >= question.options.length)) throw new Error('This question contains an invalid choice')
    const actions: Array<{ method: 'select' | 'input' | 'editor'; value?: string }> = [{
      method: 'input',
      value: unique.map((index) => String(index + 1)).join(','),
    }]
    if (question.allowNote) actions.push({ method: 'input', value: note ?? '' })
    return actions
  }
  if (answer.kind === 'unknown') {
    const actions: Array<{ method: 'select' | 'input' | 'editor'; value?: string; optionIndex?: number }> = [{
      method: 'select',
      optionIndex: question.options.length,
    }]
    if (question.allowNote) actions.push({ method: 'input', value: note ?? '' })
    return actions
  }
  if (answer.kind === 'custom') {
    const actions: Array<{ method: 'select' | 'input' | 'editor'; value?: string; optionIndex?: number }> = [
      { method: 'select', optionIndex: question.options.length + (question.allowUnknown ? 1 : 0) },
      { method: 'input', value: answer.value },
    ]
    if (question.allowNote) actions.push({ method: 'input', value: note ?? '' })
    return actions
  }
  if (answer.kind !== 'option') throw new Error('This question requires one choice')
  if (answer.optionIndex < 0 || answer.optionIndex >= question.options.length) throw new Error('This question contains an invalid choice')
  const actions: Array<{ method: 'select' | 'input' | 'editor'; value?: string; optionIndex?: number }> = [{
    method: 'select',
    optionIndex: answer.optionIndex,
  }]
  if (question.allowNote) actions.push({ method: 'input', value: note ?? '' })
  return actions
}

function displayOptions(args: Record<string, unknown>, details: unknown): NativeQuestionOption[] {
  const authored = normalizeOptions(args.options)
  const displayed = displayedLabels(details)
  if (displayed.length === 0) return authored
  const remaining = [...authored]
  return displayed.map((label) => {
    const matchIndex = remaining.findIndex((option) => option.label === label)
    if (matchIndex < 0) return { value: label, label }
    const [match] = remaining.splice(matchIndex, 1)
    return match ?? { value: label, label }
  })
}

function displayedLabels(details: unknown): string[] {
  const recordDetails = record(details)
  const nested = record(recordDetails.details)
  const candidates = [recordDetails.options, nested.options]
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    const labels = candidate.flatMap((entry) => {
      if (typeof entry === 'string' && entry.trim()) return [entry.trim()]
      const option = record(entry)
      return typeof option.label === 'string' && option.label.trim() ? [option.label.trim()] : []
    })
    if (labels.length > 0) return labels
  }
  return []
}

function normalizeOptions(value: unknown): NativeQuestionOption[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const options: NativeQuestionOption[] = []
  for (const entry of value) {
    const option = record(entry)
    const label = typeof option.label === 'string' ? option.label.trim() : ''
    if (!label) continue
    const rawValue = typeof option.value === 'string' && option.value.trim() ? option.value.trim() : label
    if (seen.has(rawValue)) continue
    seen.add(rawValue)
    options.push({
      value: rawValue,
      label,
      ...(typeof option.description === 'string' && option.description.trim() ? { description: option.description.trim() } : {}),
      ...(typeof option.preview === 'string' && option.preview.trim() ? { preview: option.preview.trim() } : {}),
    })
  }
  return options
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
