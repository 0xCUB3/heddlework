import { describe, expect, it } from 'bun:test'
import {
  buildAskUserDialogActions,
  dialogMatchesAskUserAction,
  questionnaireFromTool,
  type AskUserQuestionnaire,
} from '../src/workbench/ask-user.ts'
import {
  activeQuestionSurface,
  customUiResultFromAnswer,
  encodeNativeQuestionAnswer,
  nativeQuestionFromTool,
} from '../src/workbench/native-question.ts'
import type { ExtensionDialog, ToolRun } from '../src/workbench/state.ts'
import { filterExtensionOptions, parseExtensionOption, parseExtensionTitle, plainExtensionText } from '../src/ui/extension-ui.ts'

const questionnaire: AskUserQuestionnaire = {
  toolCallId: 'ask-1',
  questions: [
    {
      question: 'Which runtime?',
      header: 'Runtime',
      multiSelect: false,
      options: [
        { label: 'Bun', description: 'Fast', preview: '# Bun' },
        { label: 'Node', description: 'Compatible' },
      ],
    },
    {
      question: 'Which checks?',
      header: 'Checks',
      multiSelect: true,
      options: [
        { label: 'Types', description: 'Typecheck' },
        { label: 'Tests', description: 'Test suite' },
      ],
    },
  ],
}

describe('ask-user host adapter', () => {
  it('parses an active tool without dropping previews', () => {
    const tool: ToolRun = {
      id: 'ask-1',
      name: 'ask_user_question',
      args: { questions: questionnaire.questions },
      status: 'running',
      isError: false,
    }
    expect(questionnaireFromTool(tool)).toEqual(questionnaire)
    expect(questionnaireFromTool({ ...tool, status: 'complete' })).toBeUndefined()
  })

  it('plans option, custom follow-up, multi-select, and empty multi responses', () => {
    expect(buildAskUserDialogActions(questionnaire, [
      { kind: 'custom', value: 'Deno' },
      { kind: 'multi', optionIndices: [1, 0, 1] },
    ])).toEqual([
      { method: 'select', questionIndex: 0, question: 'Which runtime?', optionIndex: 2 },
      { method: 'input', questionIndex: 0, question: 'Which runtime?', value: 'Deno' },
      { method: 'input', questionIndex: 1, question: 'Which checks?', value: '1,2' },
    ])

    expect(buildAskUserDialogActions(questionnaire, [
      { kind: 'option', optionIndex: 0 },
      { kind: 'multi', optionIndices: [] },
    ]).at(-1)?.value).toBe('')
  })

  it('rejects incomplete or incompatible answers', () => {
    expect(() => buildAskUserDialogActions(questionnaire, [])).toThrow('Answer every question')
    expect(() => buildAskUserDialogActions(questionnaire, [
      { kind: 'multi', optionIndices: [] },
      { kind: 'multi', optionIndices: [] },
    ])).toThrow('requires one choice')
  })

  it('correlates fallback requests by method and authored question', () => {
    const dialog: ExtensionDialog = { id: 'd', method: 'select', title: '[Runtime] Which runtime?', options: [], createdAt: 1 }
    expect(dialogMatchesAskUserAction(dialog, { method: 'select', questionIndex: 0, question: 'Which runtime?', optionIndex: 0 })).toBe(true)
    expect(dialogMatchesAskUserAction(dialog, { method: 'input', questionIndex: 0, question: 'Which runtime?', value: 'Deno' })).toBe(false)
  })
})

describe('extension UI text projection', () => {
  it('strips ANSI and control bytes', () => {
    expect(plainExtensionText('\u001b[31m$12.00\u001b[0m\u0007')).toBe('$12.00')
  })

  it('parses Fabric and numbered questionnaire rows while retaining wire values', () => {
    const fabric = parseExtensionOption('Executor · quickjs — Runtime and resource limits.')
    expect(fabric).toEqual({
      value: 'Executor · quickjs — Runtime and resource limits.',
      label: 'Executor',
      detail: 'quickjs · Runtime and resource limits.',
    })
    expect(parseExtensionOption('2. Node — Compatible')).toEqual({
      value: '2. Node — Compatible',
      label: 'Node',
      detail: 'Compatible',
      ordinal: '2',
    })
  })

  it('splits breadcrumb details and searches labels plus descriptions', () => {
    expect(parseExtensionTitle('Fabric settings › Agents\nOne-shot child agents.')).toEqual({ title: 'Fabric settings › Agents', detail: 'One-shot child agents.' })
    const options = ['Executor — Runtime limits', 'Agents — Child models'].map(parseExtensionOption)
    expect(filterExtensionOptions(options, 'child').map((option) => option.label)).toEqual(['Agents'])
  })
})

describe('generic native question adapter', () => {
  it('parses a graded quiz by schema, not tool name, without leaking the answer', () => {
    const question = nativeQuestionFromTool({
      id: 'quiz-1',
      name: 'fabric_probe',
      status: 'running',
      args: {
        question: 'Let $A=U\\Sigma V^*$ be invertible, with $\\sigma_1>\\sigma_n$.',
        details: 'This jumps ahead deliberately to see whether you can construct the worst case.',
        options: [
          { label: '$b=u_n$, $\\delta b=\\varepsilon u_1$', value: 'un-u1' },
          { label: '$b=u_1$, $\\delta b=\\varepsilon u_1$', value: 'u1-u1' },
          { label: '$b=v_1$, $\\delta b=\\varepsilon v_n$', value: 'v1-vn' },
          { label: '$b=u_1$, $\\delta b=\\varepsilon u_n$', value: 'u1-un' },
        ],
        correctAnswer: 'un-u1',
        explanation: 'Hidden from the form.',
      },
      details: { options: [
        { index: 1, label: '$b=u_n$, $\\delta b=\\varepsilon u_1$' },
        { index: 2, label: '$b=u_1$, $\\delta b=\\varepsilon u_1$' },
        { index: 3, label: '$b=v_1$, $\\delta b=\\varepsilon v_n$' },
        { index: 4, label: '$b=u_1$, $\\delta b=\\varepsilon u_n$' },
      ] },
    })
    expect(question?.toolName).toBe('fabric_probe')
    expect(question?.allowUnknown).toBe(true)
    expect(question?.allowNote).toBe(true)
    expect(question?.allowCustom).toBe(false)
    expect(question?.options.map((option) => option.value)).toEqual(['un-u1', 'u1-u1', 'v1-vn', 'u1-un'])
    expect(JSON.stringify(question)).not.toContain('Hidden from the form.')
    expect(JSON.stringify(question)).not.toContain('correctAnswer')
  })

  it('encodes quiz answers with distinct wire values and optional notes', () => {
    const question = nativeQuestionFromTool({
      id: 'quiz-1',
      name: 'quiz',
      status: 'running',
      args: {
        question: 'Pick',
        options: [{ label: 'A shown', value: 'a' }, { label: 'B shown', value: 'b' }],
        explanation: 'why',
        correctAnswer: 'a',
      },
    })!
    expect(customUiResultFromAnswer(question, encodeNativeQuestionAnswer(question, [{ kind: 'option', optionIndex: 1 }], 'I was guessing'))).toEqual({
      dontKnow: false,
      note: 'I was guessing',
      answers: [{ label: 'B shown', value: 'b', index: 2 }],
    })
    expect(customUiResultFromAnswer(question, encodeNativeQuestionAnswer(question, [{ kind: 'unknown' }]))).toEqual({
      dontKnow: true,
      answers: [],
    })
  })

  it('parses free-text and multi-select ask shapes under any tool name', () => {
    expect(nativeQuestionFromTool({
      id: 'q1',
      name: 'clarify',
      status: 'running',
      args: { question: 'Any constraints?' },
    })?.kind).toBe('text')
    const multi = nativeQuestionFromTool({
      id: 'q2',
      name: 'ask_anything',
      status: 'running',
      args: {
        question: 'Which checks?',
        multiSelect: true,
        options: [{ label: 'Types', value: 'types' }, { label: 'Tests', value: 'tests' }],
      },
    })
    expect(multi?.kind).toBe('multi-select')
    expect(multi?.allowCustom).toBe(true)
    expect(multi?.allowUnknown).toBe(false)
    expect(questionnaireFromTool({
      id: 'q2',
      name: 'ask_anything',
      status: 'running',
      args: { question: 'Which checks?', options: [{ label: 'Types', description: 't' }] },
    })).toBeUndefined()
  })

  it('does not guess among concurrent question-shaped tools, and keeps unsupported from covering a live quiz', () => {
    const quizA = {
      id: 'quiz-a',
      name: 'probe',
      status: 'running',
      args: { question: 'A?', options: [{ label: 'One', value: '1' }], explanation: 'nope', correctAnswer: '1' },
    }
    const quizB = {
      id: 'quiz-b',
      name: 'other',
      status: 'running',
      args: { question: 'B?', options: [{ label: 'Two', value: '2' }], explanation: 'hidden', correctAnswer: '2' },
    }
    expect(activeQuestionSurface({ liveTools: [quizA, quizB], dialog: undefined })).toBeUndefined()
    const focusedB = nativeQuestionFromTool(quizB)
    if (!focusedB) throw new Error('expected quiz B')
    expect(activeQuestionSurface({
      liveTools: [quizA, quizB],
      dialog: undefined,
      questionnaireSubmitting: 'quiz-b',
    })).toEqual({ kind: 'question', question: focusedB })
    expect(activeQuestionSurface({
      liveTools: [quizA],
      dialog: {
        id: 'term-only',
        method: 'unsupported',
        title: 'Terminal-only extension UI',
        message: 'snake',
      },
    })?.kind).toBe('question')
    expect(activeQuestionSurface({
      liveTools: [],
      dialog: {
        id: 'term-only',
        method: 'unsupported',
        title: 'Terminal-only extension UI',
        message: 'snake',
      },
    })?.kind).toBe('unsupported')
  })
})
